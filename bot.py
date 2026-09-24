#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
bot.py — вечерний будильник для Mini App. Один пользователь.

Делает ровно это:
  22:00  «День N — тема» с кнопкой, открывающей Mini App
  22:58  «Finish. Свет.»
  09:00  «Как спалось?» с кнопкой в Mini App
  /today, /day N, /stats, /start
  кнопка меню бота открывает Mini App
  принимает web_app_data и кладёт состояние в SQLite (резерв + /stats)

Настройки в .env рядом с файлом:
  BOT_TOKEN=...
  CHAT_ID=...
  MINIAPP_URL=https://<логин>.github.io/<репозиторий>/
"""

import asyncio
import json
import logging
import os
import re
import sqlite3
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from aiogram import Bot, Dispatcher, F
from aiogram.filters import Command, CommandStart
from aiogram.types import (
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    KeyboardButton,
    MenuButtonWebApp,
    Message,
    ReplyKeyboardMarkup,
    WebAppInfo,
)
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger


ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "state.db"
TZ = ZoneInfo("Europe/Moscow")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("evenings")


# ------------------------------------------------------------------ .env

def load_env():
    path = ROOT / ".env"
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


load_env()

BOT_TOKEN = os.environ.get("BOT_TOKEN", "").strip()
MINIAPP_URL = os.environ.get("MINIAPP_URL", "").strip()
try:
    CHAT_ID = int(os.environ.get("CHAT_ID", "").strip())
except ValueError:
    CHAT_ID = 0

if not BOT_TOKEN or not CHAT_ID or not MINIAPP_URL:
    sys.exit(
        "Не хватает настроек. Создай .env рядом с bot.py:\n"
        "  BOT_TOKEN=токен от @BotFather\n"
        "  CHAT_ID=твой numeric id (узнать: @userinfobot)\n"
        "  MINIAPP_URL=https://логин.github.io/репозиторий/\n"
    )

HEADER_RE = re.compile(r"^ДЕНЬ (\d+) · НЕДЕЛЯ (\d+) · ([^·]+?) · ([A-Z]+) \((.+)\)$")


def _load_days():
    """Читаем из плана только шапки дней.

    Боту нужны номер, неделя, тип, тема и грамматика — промпты живут в Mini App.
    Полный разбор держал бы в памяти 168 промптов со всеми этапами, а машина
    тесная: рядом работают VPN и четыре чужих бота.
    """
    out, pending = [], None
    with (ROOT / "english-168-evenings.txt").open(encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            m = HEADER_RE.match(line)
            if m:
                pending = {"n": int(m.group(1)), "week": int(m.group(2)),
                           "type": m.group(4), "typeLabel": m.group(5),
                           "topic": "", "grammar": ""}
                out.append(pending)
            elif pending is not None:
                if line.startswith("Тема: "):
                    pending["topic"] = line[len("Тема: "):].strip()
                elif line.startswith("Грамматика недели: "):
                    pending["grammar"] = line[len("Грамматика недели: "):].strip()
                    pending = None
    if len(out) != 168:
        sys.exit("В плане найдено %d дней вместо 168 — проверь english-168-evenings.txt" % len(out))
    bad = [d["n"] for d in out if not d["topic"] or not d["grammar"]]
    if bad:
        sys.exit("У дней %s не разобраны тема или грамматика" % bad[:5])
    return out


DAYS = _load_days()
BY_NUM = {d["n"]: d for d in DAYS}
TOTAL_DAYS = len(DAYS)


# ----------------------------------------------------------------- база

def db():
    con = sqlite3.connect(DB_PATH)
    con.execute("PRAGMA journal_mode=WAL")
    return con


def db_init():
    with db() as con:
        con.execute("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)")
        con.execute(
            "CREATE TABLE IF NOT EXISTS backups ("
            " id INTEGER PRIMARY KEY AUTOINCREMENT,"
            " ts TEXT NOT NULL,"
            " payload TEXT NOT NULL)"
        )
        con.execute(
            "CREATE TABLE IF NOT EXISTS sent (job TEXT NOT NULL, on_date TEXT NOT NULL,"
            " PRIMARY KEY (job, on_date))"
        )


def kv_get(key, default=None):
    with db() as con:
        row = con.execute("SELECT v FROM kv WHERE k=?", (key,)).fetchone()
    return row[0] if row else default


def kv_set(key, value):
    with db() as con:
        con.execute(
            "INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
            (key, str(value)),
        )


def claim_send(job, on_date):
    """True — отправлять можно. Второй раз за ту же дату вернёт False.
    Защищает от дублей при перезапуске бота."""
    try:
        with db() as con:
            con.execute("INSERT INTO sent (job, on_date) VALUES (?, ?)", (job, on_date))
        return True
    except sqlite3.IntegrityError:
        return False


def release_send(job, on_date):
    """Снять отметку об отправке — чтобы следующий запуск попробовал снова."""
    with db() as con:
        con.execute("DELETE FROM sent WHERE job=? AND on_date=?", (job, on_date))


def current_day():
    try:
        n = int(kv_get("day", "1"))
    except (TypeError, ValueError):
        n = 1
    return min(max(n, 1), TOTAL_DAYS)


# -------------------------------------------------------------- клавиатуры

def miniapp_url():
    """Текущий адрес Mini App.

    Во временном режиме (см. README, раздел 4b) туннель переподключается и адрес
    меняется, поэтому читаем .env заново, а не запоминаем при старте.
    """
    try:
        for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("MINIAPP_URL="):
                v = line.split("=", 1)[1].strip()
                if v:
                    return v
    except OSError:
        pass
    return MINIAPP_URL


def open_button(text="Открыть приложение", day=None):
    url = miniapp_url()
    if day:
        url += ("&" if "?" in url else "?") + "day=%d" % day
    return InlineKeyboardMarkup(
        inline_keyboard=[[InlineKeyboardButton(text=text, web_app=WebAppInfo(url=url))]]
    )


def reply_keyboard():
    """Кнопка клавиатуры — единственный способ, которым Telegram разрешает
    Mini App отправить состояние обратно в чат (sendData)."""
    return ReplyKeyboardMarkup(
        keyboard=[[KeyboardButton(text="Открыть приложение", web_app=WebAppInfo(url=miniapp_url()))]],
        resize_keyboard=True,
        is_persistent=True,
    )


def day_text(n):
    d = BY_NUM.get(n)
    if not d:
        return "План пройден. 168 вечеров позади."
    return (
        "День %d — %s\n"
        "Неделя %d · %s (%s)\n"
        "Грамматика: %s"
        % (d["n"], d["topic"], d["week"], d["type"], d["typeLabel"], d["grammar"])
    )


# ------------------------------------------------------------------ бот

bot = Bot(token=BOT_TOKEN)
dp = Dispatcher()
mine = F.chat.id == CHAT_ID


@dp.message(CommandStart())
async def cmd_start(m: Message):
    if m.chat.id != CHAT_ID:
        return
    await m.answer(
        "Вечерний английский.\n"
        "22:00 — день и кнопка, 22:58 — Finish, 09:00 — вопрос про сон.\n"
        "Команды: /today, /day N, /stats",
        reply_markup=reply_keyboard(),
    )


@dp.message(Command("today"), mine)
async def cmd_today(m: Message):
    n = current_day()
    await m.answer(day_text(n), reply_markup=open_button("Открыть вечер"))


@dp.message(Command("day"), mine)
async def cmd_day(m: Message):
    parts = (m.text or "").split()
    if len(parts) < 2 or not parts[1].lstrip("-").isdigit():
        await m.answer("Нужно: /day N, где N от 1 до %d. Сейчас день %d." % (TOTAL_DAYS, current_day()))
        return
    n = int(parts[1])
    if not 1 <= n <= TOTAL_DAYS:
        await m.answer("День должен быть от 1 до %d." % TOTAL_DAYS)
        return
    kv_set("day", n)
    await m.answer(
        "Текущий день — %d.\nОткрой приложение этой кнопкой, чтобы оно тоже переключилось.\n\n%s"
        % (n, day_text(n)),
        reply_markup=open_button("Открыть день %d" % n, day=n),
    )


@dp.message(Command("stats"), mine)
async def cmd_stats(m: Message):
    raw = kv_get("summary")
    if not raw:
        await m.answer(
            "Статистики пока нет.\n"
            "Открой приложение кнопкой на клавиатуре → Настройки → Экспортировать, "
            "и она появится здесь."
        )
        return
    try:
        s = json.loads(raw)
    except ValueError:
        await m.answer("Сохранённая статистика повреждена. Сделай экспорт ещё раз.")
        return
    when = kv_get("summary_ts", "—")
    await m.answer(
        "День %s\n"
        "Вечеров: %s из 7 · %s из 30\n"
        "Подряд: %s\n"
        "Карточек выучено: %s · в работе: %s\n"
        "Засыпание за 7 дней: %s\n"
        "Средний отбой: %s\n"
        "Данные от %s"
        % (
            s.get("day", "—"), s.get("done7", "—"), s.get("done30", "—"),
            s.get("streak", "—"), s.get("learned", "—"), s.get("inWork", "—"),
            s.get("speed7", "—"), s.get("bed7", "—"), when,
        )
    )


@dp.message(F.web_app_data, mine)
async def on_web_app_data(m: Message):
    raw = m.web_app_data.data or ""
    ts = datetime.now(TZ).strftime("%Y-%m-%d %H:%M")
    with db() as con:
        con.execute("INSERT INTO backups (ts, payload) VALUES (?, ?)", (ts, raw))
        con.execute(
            "DELETE FROM backups WHERE id NOT IN "
            "(SELECT id FROM backups ORDER BY id DESC LIMIT 30)"
        )
    try:
        obj = json.loads(raw)
    except ValueError:
        await m.answer("Пришло что-то нечитаемое, но я это сохранил.")
        return

    summary = obj.get("summary") or {}
    if summary:
        kv_set("summary", json.dumps(summary, ensure_ascii=False))
        kv_set("summary_ts", ts)
        if isinstance(summary.get("day"), int):
            kv_set("day", summary["day"])

    # приложение шлёт сводку само после «Finish» — отвечать в этот момент нельзя,
    # это ровно то время, когда телефон уже должен молчать
    if obj.get("auto"):
        log.info("автосводка принята, день %s", summary.get("day", "—"))
        return

    full = "payload" in obj
    await m.answer(
        ("Копия сохранена%s. День %s. /stats — статистика."
         % ("" if full else " (только сводка, без полного состояния)",
            summary.get("day", "—")))
    )


# ------------------------------------------------------------- расписание

SEND_RETRIES = 3
SEND_PAUSE = 60          # секунд между попытками


async def send_job(job, text, markup=None):
    """Отправить сообщение задания ровно один раз за сутки.

    Отметку в sent ставим ДО отправки — иначе две копии бота (или перезапуск
    ровно в момент срабатывания) пришлют дубль. Если отправить так и не вышло,
    отметку снимаем: пусть следующий запуск попробует снова, чем вечер молча
    пропадёт.
    """
    today = datetime.now(TZ).date().isoformat()
    if not claim_send(job, today):
        log.info("%s уже отправлено сегодня — пропуск", job)
        return False

    for attempt in range(1, SEND_RETRIES + 1):
        try:
            await bot.send_message(CHAT_ID, text, reply_markup=markup)
            log.info("%s отправлено (попытка %d)", job, attempt)
            return True
        except Exception as e:  # noqa: BLE001 — молчать нельзя, вечер важнее исключения
            log.warning("%s: попытка %d из %d не удалась: %s", job, attempt, SEND_RETRIES, e)
            if attempt < SEND_RETRIES:
                await asyncio.sleep(SEND_PAUSE)

    release_send(job, today)
    log.error("%s: не отправлено после %d попыток, отметка снята", job, SEND_RETRIES)
    return False


async def job_evening():
    # именно клавиатурная кнопка, а не inline: sendData разрешён Telegram только
    # для Mini App, открытого с клавиатуры, иначе автосводка после Finish не дойдёт
    try:
        await send_job("evening", "22:00. Вечер. Кнопка внизу.", reply_keyboard())
    except Exception:  # noqa: BLE001 — задание не должно ронять планировщик
        log.exception("job_evening упало")


async def job_finish():
    try:
        await send_job("finish", "Finish. Свет.")
    except Exception:  # noqa: BLE001
        log.exception("job_finish упало")


async def job_morning():
    try:
        await send_job("morning", "Как спалось?", open_button("Ответить"))
    except Exception:  # noqa: BLE001
        log.exception("job_morning упало")


async def main():
    db_init()
    try:
        await bot.set_chat_menu_button(
            chat_id=CHAT_ID,
            menu_button=MenuButtonWebApp(text="Вечер", web_app=WebAppInfo(url=miniapp_url())),
        )
    except Exception as e:  # noqa: BLE001 — кнопка меню не критична для работы
        log.warning("не удалось поставить кнопку меню: %s", e)

    sched = AsyncIOScheduler(timezone=TZ)
    common = dict(misfire_grace_time=3600, coalesce=True, max_instances=1)
    sched.add_job(job_evening, CronTrigger(hour=22, minute=0, timezone=TZ), id="evening", **common)
    sched.add_job(job_finish, CronTrigger(hour=22, minute=58, timezone=TZ), id="finish", **common)
    sched.add_job(job_morning, CronTrigger(hour=9, minute=0, timezone=TZ), id="morning", **common)
    sched.start()

    log.info("бот запущен, день %d, %d дней в плане", current_day(), TOTAL_DAYS)

    # стартовали посреди вечернего окна (22:00–22:57) и сегодня ещё не слали — шлём сразу
    now = datetime.now(TZ)
    if now.hour == 22 and now.minute < 58:
        log.info("старт внутри вечернего окна (%s) — досылаю вечер", now.strftime("%H:%M"))
        asyncio.create_task(job_evening())

    await dp.start_polling(bot)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except (KeyboardInterrupt, SystemExit):
        log.info("остановлен")
