#!/bin/bash
# Локальный запуск: статика + публичный туннель + бот.
# Живёт, пока Mac включён и не спит. Постоянный вариант — GitHub Pages + VPS, см. README.
set -u
cd "$(dirname "$0")"
PORT=8137
PY=.venv/bin/python3
[ -x "$PY" ] || PY=python3

say(){ printf "\033[1m%s\033[0m\n" "$*"; }

# --- прибрать прошлый запуск ---
pkill -f "http.server $PORT" 2>/dev/null
pkill -f "R 80:localhost:$PORT" 2>/dev/null
pkill -f "$PWD/bot.py" 2>/dev/null
sleep 1

# --- свежая статика в чистую папку (без .env, bot.py и базы!) ---
say "1/4  Собираю данные и статику"
python3 build.py >/dev/null || { echo "build.py упал"; exit 1; }
mkdir -p public && rm -f public/* && cp index.html app.js style.css data.js public/

# --- локальный сервер ---
say "2/4  Локальный сервер на :$PORT"
( cd public && exec python3 -m http.server $PORT ) >/tmp/evenings-http.log 2>&1 &
sleep 1

# --- публичный HTTPS-туннель без аккаунта ---
say "3/4  Публичный адрес"
: > /tmp/evenings-tunnel.log
ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes \
    -R 80:localhost:$PORT nokey@localhost.run >/tmp/evenings-tunnel.log 2>&1 &
URL=""
for i in $(seq 1 30); do
  URL=$(grep -oE 'https://[a-z0-9]+\.lhr\.life' /tmp/evenings-tunnel.log | head -1)
  [ -n "$URL" ] && break
  sleep 1
done
[ -n "$URL" ] || { echo "Туннель не поднялся. Смотри /tmp/evenings-tunnel.log"; exit 1; }
URL="$URL/"
/usr/bin/sed -i '' "s|^MINIAPP_URL=.*|MINIAPP_URL=$URL|" .env
echo "     $URL"

# --- узнать CHAT_ID, если ещё не знаем ---
TOKEN=$(grep '^BOT_TOKEN=' .env | cut -d= -f2-)
CHAT=$(grep '^CHAT_ID=' .env | cut -d= -f2-)
if [ -z "$CHAT" ]; then
  echo "     CHAT_ID неизвестен — напиши боту /start, жду 120 секунд..."
  for i in $(seq 1 60); do
    CHAT=$(curl -s -m 8 "https://api.telegram.org/bot$TOKEN/getUpdates" \
      | $PY -c "import json,sys
try:
    r=json.load(sys.stdin).get('result',[])
except Exception:
    r=[]
for u in r:
    m=u.get('message') or u.get('my_chat_member') or {}
    c=m.get('chat',{})
    if c.get('type')=='private':
        print(c['id']); break" 2>/dev/null)
    [ -n "$CHAT" ] && break
    sleep 2
  done
  [ -n "$CHAT" ] || { echo "Так и не дождался сообщения боту."; exit 1; }
  /usr/bin/sed -i '' "s|^CHAT_ID=.*|CHAT_ID=$CHAT|" .env
  echo "     CHAT_ID=$CHAT"
fi

# --- бот (сам выставит кнопку меню на новый адрес) ---
say "4/4  Бот"
exec $PY bot.py
