#!/usr/bin/env bash
# Установка чата на Ubuntu: Node.js, systemd, nginx, HTTPS.
# Запуск из папки с чатом:  sudo bash install.sh chat.prometgs.ru
set -euo pipefail

DOMAIN="${1:-chat.prometgs.ru}"
DIR="$(cd "$(dirname "$0")" && pwd)"

if [ "$(id -u)" -ne 0 ]; then echo "Запустите через sudo"; exit 1; fi

echo "==> Устанавливаю Node.js, nginx, certbot"
apt-get update -q
apt-get install -y -q nodejs nginx certbot python3-certbot-nginx curl
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then echo "Нужен Node.js 18+, установлен $(node -v)"; exit 1; fi

if [ ! -f "$DIR/.env" ]; then
  echo "==> Настройки бота"
  read -rp "Токен бота от @BotFather: " BOT_TOKEN
  read -rp "ID группы (начинается с -100): " GROUP_ID
  cat > "$DIR/.env" <<ENV
BOT_TOKEN=$BOT_TOKEN
GROUP_ID=$GROUP_ID
PORT=3000
ALLOWED_ORIGIN=*
ENV
fi
chmod 600 "$DIR/.env"
chown -R www-data:www-data "$DIR"
git config --global --add safe.directory "$DIR" 2>/dev/null || true

echo "==> Автозапуск (systemd)"
cat > /etc/systemd/system/site-chat.service <<UNIT
[Unit]
Description=Site chat (Telegram)
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$DIR
ExecStart=$(command -v node) $DIR/server.js
Restart=always
RestartSec=5
User=www-data

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable site-chat
systemctl restart site-chat

echo "==> nginx для $DOMAIN"
sed "s/chat\.prometgs\.ru/$DOMAIN/" "$DIR/nginx-chat.conf" > /etc/nginx/sites-available/site-chat
ln -sf /etc/nginx/sites-available/site-chat /etc/nginx/sites-enabled/site-chat
nginx -t
systemctl reload nginx

echo "==> HTTPS-сертификат"
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect

sleep 2
echo
journalctl -u site-chat -n 5 --no-pager
echo
if curl -fsS "https://$DOMAIN/health" >/dev/null; then
  echo "Готово! Чат работает: https://$DOMAIN/health"
  echo "Код для сайта:"
  echo "<script src=\"https://$DOMAIN/widget.js\" async></script>"
else
  echo "Сервер не отвечает по https://$DOMAIN/health — посмотрите: journalctl -u site-chat -n 50"
fi
