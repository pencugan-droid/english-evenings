#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build.py — парсит english-168-evenings.txt и english-anki-deck.csv,
генерирует data.js для Mini App.

Падает с понятной ошибкой, если данные не сходятся с ожиданиями:
ровно 168 дней, ровно 1008 карточек, непустой промпт у каждого дня,
разобранное расписание «Голос» у каждого дня.

Запуск:  python3 build.py
"""

import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PLAN_FILE = ROOT / "english-168-evenings.txt"
DECK_FILE = ROOT / "english-anki-deck.csv"
OUT_FILE = ROOT / "data.js"
INDEX_FILE = ROOT / "index.html"

EXPECTED_DAYS = 168
EXPECTED_CARDS = 1008
KNOWN_TYPES = {"NEW", "DEEP", "REVIEW", "FREE", "LIGHT", "CHECK"}

SEP = "---"

HEADER_RE = re.compile(
    r"^ДЕНЬ (\d+) · НЕДЕЛЯ (\d+) · ([^·]+?) · ([A-Z]+) \((.+)\)$"
)
# «22:14 Words», «22:38 «Next» Talk», «22:58 «Finish»»
STAGE_RE = re.compile(r"^(\d{1,2}:\d{2})\s+(.+)$")
# «22:14–23:00 слушаешь, ... . Заснул — отлично. Не спишь в 22:58 — «Finish».»
LIGHT_RE = re.compile(
    r"^(\d{1,2}:\d{2})\s*[–—-]\s*(\d{1,2}:\d{2})\s+(.+?)\.\s+(.+?)\.\s+"
    r"Не спишь в (\d{1,2}:\d{2}) — «Finish»\.$"
)


class BuildError(Exception):
    """Ошибка разбора данных — сообщение адресовано человеку."""


def fail(msg):
    raise BuildError(msg)


# ---------------------------------------------------------------- расписание

def parse_voice(raw, day_no):
    """Строку «Голос: ...» -> (список этапов, заметка).

    Этап = {"time": "22:14", "label": "Words"}.
    Поддерживаются две формы: со стрелками (144 дня) и прозой у LIGHT (24 дня).
    Любая третья форма — ошибка сборки, а не догадка.
    """
    line = raw.strip()

    if "→" in line:
        stages = []
        for chunk in line.split("→"):
            part = chunk.strip()
            m = STAGE_RE.match(part)
            if not m:
                fail(
                    f"День {day_no}: не разобран этап «{part}» в строке «Голос».\n"
                    f"  Ожидался вид «22:38 «Next» Talk».\n  Строка целиком: {line}"
                )
            time, label = m.group(1), m.group(2).strip()
            label = re.sub(r"^«Next»\s*", "", label).strip()
            label = label.strip("«»").strip()
            if not label:
                fail(f"День {day_no}: пустое название этапа в «{part}».")
            stages.append({"time": time, "label": label})
        if len(stages) < 2:
            fail(f"День {day_no}: в расписании «Голос» меньше двух этапов.")
        return stages, ""

    m = LIGHT_RE.match(line)
    if m:
        start, end, activity, note, finish_at = m.groups()
        activity = activity.strip()
        activity = activity[0].upper() + activity[1:]
        return (
            [
                {"time": f"{start}–{end}", "label": activity},
                {"time": finish_at, "label": "Finish, если не спишь"},
            ],
            note.strip() + ".",
        )

    fail(
        f"День {day_no}: строка «Голос» неизвестного вида, разбор невозможен.\n"
        f"  Строка: {line}\n"
        f"  Известны два вида: со стрелками «→» и «22:14–23:00 слушаешь ... «Finish».»"
    )


# --------------------------------------------------------------------- план

def parse_plan(text):
    lines = text.split("\n")
    starts = [i for i, ln in enumerate(lines) if ln.startswith("ДЕНЬ ")]
    if not starts:
        fail("В плане не найдено ни одной строки «ДЕНЬ N · ...». Файл тот?")

    bounds = starts + [len(lines)]
    days = []

    for k, start in enumerate(starts):
        block = lines[start:bounds[k + 1]]
        head = block[0]

        m = HEADER_RE.match(head)
        if not m:
            fail(f"Строка {start + 1}: заголовок дня не разобран.\n  {head}")
        num, week, weekday, type_code, type_label = m.groups()
        num, week = int(num), int(week)

        if type_code not in KNOWN_TYPES:
            fail(f"День {num}: неизвестный тип «{type_code}». Известны: {sorted(KNOWN_TYPES)}")

        topic = grammar = None
        for ln in block[1:6]:
            if ln.startswith("Тема: "):
                topic = ln[len("Тема: "):].strip()
            elif ln.startswith("Грамматика недели: "):
                grammar = ln[len("Грамматика недели: "):].strip()
        if not topic:
            fail(f"День {num}: не найдена или пуста строка «Тема:».")
        if not grammar:
            fail(f"День {num}: не найдена или пуста строка «Грамматика недели:».")

        seps = [i for i, ln in enumerate(block) if ln.strip() == SEP]
        if len(seps) != 2:
            fail(
                f"День {num}: ожидались ровно две строки «---» вокруг промпта, "
                f"найдено {len(seps)}."
            )
        prompt = "\n".join(block[seps[0] + 1:seps[1]]).strip("\n")
        if not prompt.strip():
            fail(f"День {num}: промпт между «---» пустой.")

        voice_lines = [i for i, ln in enumerate(block) if ln.startswith("Голос:")]
        if len(voice_lines) != 1:
            fail(f"День {num}: ожидалась ровно одна строка «Голос:», найдено {len(voice_lines)}.")
        vi = voice_lines[0]
        if vi < seps[1]:
            fail(f"День {num}: строка «Голос:» оказалась внутри промпта.")
        stages, note = parse_voice(block[vi][len("Голос:"):], num)

        days.append({
            "n": num,
            "week": week,
            "weekday": weekday.strip(),
            "type": type_code,
            "typeLabel": type_label.strip(),
            "topic": topic,
            "grammar": grammar,
            "prompt": prompt,
            "voice": stages,
            "voiceNote": note,
        })

    nums = [d["n"] for d in days]
    if nums != list(range(1, len(days) + 1)):
        missing = sorted(set(range(1, max(nums) + 1)) - set(nums))
        dupes = sorted({n for n in nums if nums.count(n) > 1})
        fail(
            "Номера дней идут не подряд от 1.\n"
            f"  найдено {len(nums)} шт., пропущены: {missing or '—'}, дубли: {dupes or '—'}"
        )
    for d in days:
        if d["week"] != (d["n"] + 6) // 7:
            fail(f"День {d['n']}: неделя {d['week']}, а по номеру дня должна быть {(d['n'] + 6) // 7}.")

    return days


# ------------------------------------------------------------------ колода

def parse_deck(text):
    cards = []
    for lineno, raw in enumerate(text.split("\n"), start=1):
        line = raw.rstrip("\r")
        if not line.strip() or line.startswith("#"):
            continue
        parts = line.split(";")
        if len(parts) != 3:
            fail(
                f"Колода, строка {lineno}: ожидались 3 поля через «;», найдено {len(parts)}.\n"
                f"  {line}"
            )
        en, ru, tag = (p.strip() for p in parts)
        if not en:
            fail(f"Колода, строка {lineno}: пустая английская сторона.")
        if not ru:
            fail(f"Колода, строка {lineno}: пустой перевод у «{en}».")
        if not re.fullmatch(r"w\d{2}_d\d{3}", tag):
            fail(f"Колода, строка {lineno}: тег «{tag}» не вида w01_d001.")
        cards.append({
            "id": len(cards),
            "n": len(cards) + 1,
            "en": en,
            "ru": ru,
            "tag": tag,
            "day": int(tag.split("_d")[1]),
        })

    seen_day, order = {}, []
    for c in cards:
        if c["tag"] not in seen_day:
            seen_day[c["tag"]] = True
            order.append(c["day"])
    if order != sorted(order) or len(order) != len(set(order)):
        fail(
            "Теги в колоде идут не по возрастанию дней или чередуются. "
            "Порядок строк должен совпадать с порядком изучения."
        )
    for c in cards:
        if not 1 <= c["day"] <= EXPECTED_DAYS:
            fail(f"Карточка «{c['en']}»: тег указывает на день {c['day']}, вне 1..{EXPECTED_DAYS}.")

    dupes = {}
    for c in cards:
        dupes.setdefault(c["en"], []).append(c["n"])
    repeated = {k: v for k, v in dupes.items() if len(v) > 1}
    if repeated:
        preview = "; ".join(f"«{k}» в строках {v}" for k, v in list(repeated.items())[:5])
        print(f"  предупреждение: повторяющиеся английские фразы ({len(repeated)}): {preview}")

    return cards


# ------------------------------------------------------------------- вывод

def js_array(items):
    return ",\n".join(json.dumps(x, ensure_ascii=False, sort_keys=True) for x in items)


def stamp_index():
    """Проставляет в index.html метку версии по содержимому style.css, app.js и data.js.

    Telegram и GitHub Pages кэшируют файлы надолго: без метки обновлённое
    приложение на телефоне ещё сутками открывается старым.
    """
    if not INDEX_FILE.exists():
        print("  предупреждение: index.html не найден, метка версии не проставлена")
        return None
    h = hashlib.sha1()
    for name in ("style.css", "app.js", "data.js"):
        f = ROOT / name
        if f.exists():
            h.update(f.read_bytes())
    tag = h.hexdigest()[:8]
    html = INDEX_FILE.read_text(encoding="utf-8")
    new = re.sub(r'(href|src)="(style\.css|app\.js|data\.js)\?v=[^"]*"',
                 lambda m: '%s="%s?v=%s"' % (m.group(1), m.group(2), tag), html)
    if new != html:
        INDEX_FILE.write_text(new, encoding="utf-8")
    return tag


def main():
    for f in (PLAN_FILE, DECK_FILE):
        if not f.exists():
            fail(f"Не найден файл {f.name} рядом с build.py ({f.parent}).")

    days = parse_plan(PLAN_FILE.read_text(encoding="utf-8"))
    cards = parse_deck(DECK_FILE.read_text(encoding="utf-8"))

    if len(days) != EXPECTED_DAYS:
        fail(f"Дней должно быть {EXPECTED_DAYS}, разобрано {len(days)}.")
    if len(cards) != EXPECTED_CARDS:
        fail(f"Карточек должно быть {EXPECTED_CARDS}, разобрано {len(cards)}.")

    payload = (
        "/* Сгенерировано build.py. Не редактировать вручную. */\n"
        f"window.DAYS = [\n{js_array(days)}\n];\n"
        f"window.CARDS = [\n{js_array(cards)}\n];\n"
    )
    OUT_FILE.write_text(payload, encoding="utf-8")

    by_type = {}
    for d in days:
        by_type[d["type"]] = by_type.get(d["type"], 0) + 1
    print(f"OK  дней: {len(days)}  ({', '.join(f'{k} {v}' for k, v in sorted(by_type.items()))})")
    print(f"OK  карточек: {len(cards)}  (новых по 6 в день -> хватает на {len(cards) // 6} дней)")
    print(f"OK  этапов «Голос» разобрано: {sum(len(d['voice']) for d in days)}")
    print(f"OK  data.js записан: {OUT_FILE.stat().st_size // 1024} КБ")
    tag = stamp_index()
    if tag:
        print(f"OK  версия ресурсов в index.html: ?v={tag}")


if __name__ == "__main__":
    try:
        main()
    except BuildError as e:
        print(f"\nОШИБКА СБОРКИ\n{e}\n", file=sys.stderr)
        sys.exit(1)
