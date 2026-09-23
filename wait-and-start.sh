#!/bin/bash
# Ждёт первое сообщение боту, записывает CHAT_ID, здоровается с клавиатурой и поднимает бота.
set -u
cd "$(dirname "$0")"
PY=.venv/bin/python3
TOKEN=$(grep '^BOT_TOKEN=' .env | cut -d= -f2-)
URL=$(grep '^MINIAPP_URL=' .env | cut -d= -f2-)
CHAT=$(grep '^CHAT_ID=' .env | cut -d= -f2-)

if [ -z "$CHAT" ]; then
  echo "жду /start от пользователя..."
  for i in $(seq 1 700); do
    CHAT=$(curl -s -m 8 "https://api.telegram.org/bot$TOKEN/getUpdates" | $PY -c "
import json,sys
try: r=json.load(sys.stdin).get('result',[])
except Exception: r=[]
for u in r:
    m=u.get('message') or u.get('my_chat_member') or {}
    c=m.get('chat',{})
    if c.get('type')=='private':
        print(c['id']); break" 2>/dev/null)
    [ -n "$CHAT" ] && break
    sleep 4
  done
  [ -n "$CHAT" ] || { echo "не дождался"; exit 1; }
  /usr/bin/sed -i '' "s|^CHAT_ID=.*|CHAT_ID=$CHAT|" .env
  echo "CHAT_ID=$CHAT записан"
fi

# поздороваться и выдать клавиатуру (она нужна, чтобы работал экспорт через sendData)
$PY - "$TOKEN" "$CHAT" "$URL" <<'PY'
import json, sys, urllib.request, urllib.parse
token, chat, url = sys.argv[1], sys.argv[2], sys.argv[3]
kb = {"keyboard": [[{"text": "Открыть приложение", "web_app": {"url": url}}]],
      "resize_keyboard": True, "is_persistent": True}
data = urllib.parse.urlencode({
    "chat_id": chat,
    "text": ("Всё поднято. 22:00 — день и кнопка, 22:58 — Finish, 09:00 — вопрос про сон.\n"
             "Команды: /today, /day N, /stats.\n\n"
             "Для экспорта состояния открывай приложение кнопкой на клавиатуре — "
             "иначе Telegram не даёт отправить копию в чат."),
    "reply_markup": json.dumps(kb, ensure_ascii=False)}).encode()
with urllib.request.urlopen("https://api.telegram.org/bot%s/sendMessage" % token, data, timeout=15) as r:
    print("приветствие:", json.load(r).get("ok"))
PY

echo "запускаю бота"
exec $PY bot.py
