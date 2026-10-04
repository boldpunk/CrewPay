#!/usr/bin/env bash
# Разовая подготовка сервера Oracle Cloud (Ubuntu или Oracle Linux, x86 или ARM/Ampere) под CrewPay.
# Запуск на сервере:  curl -fsSL https://raw.githubusercontent.com/boldpunk/CrewPay/main/deploy/setup-oracle.sh | bash -s -- you@mail.com
# Аргумент — email для Let's Encrypt (уведомления о сроке сертификата).
# Скрипт можно запускать повторно: уже сделанные шаги пропускаются.
set -euo pipefail

DOMAIN="${DOMAIN:-crewpay.uz}"
EMAIL="${1:-}"
APP_DIR=/opt/crewpay
APP_PORT=3020

say() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" -eq 0 ] && SUDO="" || SUDO="sudo"
[ -n "$EMAIL" ] || die "Укажите email для сертификата: bash setup-oracle.sh you@mail.com"

if command -v apt-get >/dev/null; then PM=apt; elif command -v dnf >/dev/null; then PM=dnf; else die "Нужен Ubuntu/Debian или Oracle Linux"; fi
say "Система: $(. /etc/os-release && echo "$PRETTY_NAME"), $(uname -m)"

# --- занятые порты ---
busy=$($SUDO ss -ltnp 2>/dev/null | awk '$4 ~ /:(80|443)$/ {print $0}' | grep -v nginx || true)
if [ -n "$busy" ]; then
  warn "Порты 80/443 уже заняты не nginx:"
  echo "$busy"
  die "Освободите порты или пришлите этот вывод — подстроим конфигурацию."
fi

if $SUDO ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$APP_PORT\$"; then
  if ! $SUDO docker ps --format '{{.Ports}}' 2>/dev/null | grep -q "127.0.0.1:$APP_PORT->3000"; then
    die "Порт $APP_PORT уже занят другим приложением — пришлите вывод 'sudo ss -ltnp | grep $APP_PORT'."
  fi
fi

# --- Docker ---
if ! command -v docker >/dev/null; then
  say "Устанавливаю Docker"
  if [ "$PM" = apt ]; then
    curl -fsSL https://get.docker.com | $SUDO sh
  else
    $SUDO dnf install -y dnf-plugins-core
    $SUDO dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
    $SUDO dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  fi
  $SUDO systemctl enable --now docker
else
  say "Docker уже установлен: $(docker --version)"
fi
$SUDO usermod -aG docker "$(id -un)" || true
docker compose version >/dev/null 2>&1 || $SUDO docker compose version >/dev/null 2>&1 || die "Нет docker compose plugin"

# --- nginx + certbot ---
say "Устанавливаю nginx и certbot"
if [ "$PM" = apt ]; then
  $SUDO apt-get update -y
  $SUDO apt-get install -y nginx certbot python3-certbot-nginx
else
  $SUDO dnf install -y oracle-epel-release-el"$(rpm -E %rhel)" || true
  $SUDO dnf install -y nginx certbot python3-certbot-nginx
  # SELinux: разрешить nginx проксировать на локальный порт приложения.
  command -v setsebool >/dev/null && $SUDO setsebool -P httpd_can_network_connect 1 || true
fi
$SUDO systemctl enable --now nginx

# --- файрвол на самом сервере (в образах Oracle он закрывает всё, кроме SSH) ---
say "Открываю 80 и 443 в файрволе сервера"
if command -v firewall-cmd >/dev/null && $SUDO firewall-cmd --state >/dev/null 2>&1; then
  $SUDO firewall-cmd --permanent --add-service=http --add-service=https
  $SUDO firewall-cmd --reload
else
  for port in 80 443; do
    if ! $SUDO iptables -C INPUT -p tcp -m state --state NEW --dport "$port" -j ACCEPT 2>/dev/null; then
      # Правило должно стоять до REJECT, которым образы Oracle закрывают остальное.
      pos=$($SUDO iptables -L INPUT --line-numbers -n | awk '$2=="REJECT" {print $1; exit}')
      $SUDO iptables -I INPUT "${pos:-1}" -p tcp -m state --state NEW --dport "$port" -j ACCEPT
    fi
  done
  if command -v netfilter-persistent >/dev/null; then
    $SUDO netfilter-persistent save
  else
    [ "$PM" = apt ] && $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent && $SUDO netfilter-persistent save || true
  fi
fi

# --- nginx: сайт crewpay.uz → контейнер на 127.0.0.1:3020 ---
say "Настраиваю nginx для $DOMAIN"
PUBLIC_IP=$(curl -fsS --max-time 5 https://ifconfig.me || true)
NAMES="$DOMAIN"
WWW_IP=$(getent hosts "www.$DOMAIN" | awk '{print $1}' | head -1 || true)
if [ -n "$WWW_IP" ] && [ "$WWW_IP" = "$PUBLIC_IP" ]; then NAMES="$DOMAIN www.$DOMAIN"; else warn "www.$DOMAIN не указывает на этот сервер — сертификат только для $DOMAIN"; fi
ROOT_IP=$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)
[ "$ROOT_IP" = "$PUBLIC_IP" ] || warn "$DOMAIN указывает на ${ROOT_IP:-?}, а IP сервера ${PUBLIC_IP:-?} — проверьте DNS."

if [ -d /etc/nginx/sites-available ]; then CONF=/etc/nginx/sites-available/$DOMAIN; else CONF=/etc/nginx/conf.d/$DOMAIN.conf; fi
$SUDO tee "$CONF" >/dev/null <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name $NAMES;
    client_max_body_size 6m;
    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
    }
}
NGINX
if [ -d /etc/nginx/sites-enabled ]; then
  $SUDO ln -sf "$CONF" "/etc/nginx/sites-enabled/$DOMAIN"
  [ -e /etc/nginx/sites-enabled/default ] && $SUDO rm -f /etc/nginx/sites-enabled/default
fi
$SUDO nginx -t
$SUDO systemctl reload nginx

# --- HTTPS ---
say "Получаю сертификат Let's Encrypt"
CERT_ARGS=()
for n in $NAMES; do CERT_ARGS+=(-d "$n"); done
if ! $SUDO certbot --nginx "${CERT_ARGS[@]}" --non-interactive --agree-tos -m "$EMAIL" --redirect; then
  warn "Сертификат не выдан. Чаще всего закрыт порт 80 в Oracle Cloud:"
  warn "Networking → Virtual Cloud Networks → ваша VCN → Security Lists → Default → Add Ingress Rules:"
  warn "  Source 0.0.0.0/0, TCP, порт 80; и ещё одно правило — порт 443. Затем запустите скрипт ещё раз."
  exit 1
fi

# --- каталог приложения и ключ для деплоя из GitHub ---
$SUDO mkdir -p "$APP_DIR"
$SUDO chown "$(id -un)":"$(id -gn)" "$APP_DIR"
KEY=~/.ssh/crewpay_deploy
if [ ! -f "$KEY" ]; then
  say "Создаю отдельный SSH-ключ для деплоя из GitHub"
  ssh-keygen -t ed25519 -N "" -C "crewpay-deploy" -f "$KEY" >/dev/null
  cat "$KEY.pub" >> ~/.ssh/authorized_keys
  chmod 600 ~/.ssh/authorized_keys
fi

say "Готово. Добавьте секреты в GitHub → boldpunk/CrewPay → Settings → Secrets and variables → Actions:"
cat <<INFO

  SSH_HOST         ${PUBLIC_IP:-<публичный IP сервера>}
  SSH_USER         $(id -un)
  SSH_PRIVATE_KEY  содержимое файла ниже (целиком, вместе со строками BEGIN/END)
  DATABASE_URL     строка подключения Neon (postgresql://…?sslmode=require)
  SITE_URL         https://$DOMAIN

Приватный ключ для SSH_PRIVATE_KEY:
INFO
cat "$KEY"
cat <<INFO

Затем: GitHub → Actions → CI & Deploy → Run workflow. Проверка: https://$DOMAIN/api/health → {"ok":true}
INFO
