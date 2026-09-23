#!/bin/bash
# Надзиратель за туннелем.
# Бесплатный туннель умирает двумя способами: рвётся соединение и — тихо —
# перестаёт проксировать, оставаясь живым процессом (отдаёт 503). Поэтому
# следим не за процессом, а за самим адресом, и при новом адресе сразу
# перевешиваем кнопку меню бота.
set -u
cd "$(dirname "$0")"
PORT=8137
LOG=/tmp/evenings-tunnel.log
TOKEN=$(grep '^BOT_TOKEN=' .env | cut -d= -f2-)
CHAT=$(grep '^CHAT_ID=' .env | cut -d= -f2-)
PREV=""

stamp(){ date '+%H:%M:%S'; }

while true; do
  : > "$LOG"
  ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=20 -o ServerAliveCountMax=3 \
      -o ExitOnForwardFailure=yes -R 80:localhost:$PORT nokey@localhost.run >>"$LOG" 2>&1 &
  SSH_PID=$!

  URL=""
  for i in $(seq 1 40); do
    URL=$(grep -oE 'https://[a-z0-9]+\.lhr\.life' "$LOG" | head -1)
    [ -n "$URL" ] && break
    kill -0 $SSH_PID 2>/dev/null || break
    sleep 1
  done

  if [ -z "$URL" ]; then
    echo "$(stamp)  адрес не выдан, повтор через 10 с"
    kill $SSH_PID 2>/dev/null; wait $SSH_PID 2>/dev/null
    sleep 10
    continue
  fi

  URL="$URL/"
  if [ "$URL" != "$PREV" ]; then
    /usr/bin/sed -i '' "s|^MINIAPP_URL=.*|MINIAPP_URL=$URL|" .env
    curl -s -m 15 -X POST "https://api.telegram.org/bot$TOKEN/setChatMenuButton" \
      -H 'Content-Type: application/json' \
      -d "{\"chat_id\":$CHAT,\"menu_button\":{\"type\":\"web_app\",\"text\":\"Вечер\",\"web_app\":{\"url\":\"$URL\"}}}" \
      >/dev/null
    echo "$(stamp)  новый адрес: $URL (кнопка меню обновлена)"
    PREV="$URL"
  fi

  # --- следим за здоровьем адреса, а не за процессом ---
  FAILS=0
  while kill -0 $SSH_PID 2>/dev/null; do
    sleep 45
    CODE=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$URL" || echo 000)
    if [ "$CODE" = "200" ]; then
      FAILS=0
    else
      FAILS=$((FAILS + 1))
      echo "$(stamp)  адрес отвечает $CODE (подряд неудач: $FAILS)"
      if [ $FAILS -ge 2 ]; then
        echo "$(stamp)  туннель протух — переподключаюсь"
        break
      fi
    fi
  done

  kill $SSH_PID 2>/dev/null
  wait $SSH_PID 2>/dev/null
  sleep 5
done
