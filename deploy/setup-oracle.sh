#!/usr/bin/env bash
# Разовая подготовка сервера под CrewPay (Oracle Cloud, Ubuntu / Oracle Linux, x86 или ARM).
#
# Два режима — выбирается сам:
#  • shared-caddy: порты 80/443 уже держит Caddy в Docker другого проекта (сервер dcau-hub: dcau-hub-caddy-1,
#    сайты boldpunk.uz, fyndue.uz). CrewPay подключается к сети этого Caddy, в его конфиг добавляется блок
#    crewpay.uz; HTTPS Caddy выпускает сам. Другие сайты и файрвол не меняются.
#  • nginx: на сервере ничего не слушает 80/443 — ставятся nginx и certbot, открываются порты.
#
# Запуск: из GitHub (Actions → Server → setup) или на сервере: bash setup-oracle.sh you@mail.com
# Повторный запуск безопасен: сделанные шаги пропускаются.
set -euo pipefail

DOMAIN="${DOMAIN:-crewpay.uz}"
EMAIL="${1:-}"
APP_DIR=/opt/crewpay
APP_PORT=3020
APP_ALIAS=crewpay-web

say() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" -eq 0 ] && SUDO="" || SUDO="sudo"
if command -v apt-get >/dev/null; then PM=apt; elif command -v dnf >/dev/null; then PM=dnf; else die "Нужен Ubuntu/Debian или Oracle Linux"; fi
say "Система: $(. /etc/os-release && echo "$PRETTY_NAME"), $(uname -m)"

$SUDO mkdir -p "$APP_DIR"
$SUDO chown "$(id -un)":"$(id -gn)" "$APP_DIR"

# Порт приложения на localhost не должен быть занят чужим процессом.
if $SUDO ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$APP_PORT\$"; then
  if ! $SUDO docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep -q "crewpay.*127.0.0.1:$APP_PORT->3000"; then
    die "Порт $APP_PORT занят другим приложением — пришлите вывод 'sudo ss -ltnp | grep $APP_PORT'."
  fi
fi

PUBLIC_IP=$(curl -fsS --max-time 5 https://ifconfig.me || true)
resolves_here() { [ -n "$PUBLIC_IP" ] && [ "$(getent hosts "$1" | awk '{print $1}' | head -1)" = "$PUBLIC_IP" ]; }
resolves_here "$DOMAIN" || warn "$DOMAIN пока не указывает на этот сервер — HTTPS выпустится, когда DNS обновится."
WWW=0
if resolves_here "www.$DOMAIN"; then WWW=1; fi

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
  $SUDO usermod -aG docker "$(id -un)" || true
fi
if docker ps >/dev/null 2>&1; then DOCKER=docker; else DOCKER="$SUDO docker"; fi

# --- кто держит 443 ---
EDGE=$($DOCKER ps --filter publish=443 --format '{{.Names}}' | head -1 || true)
if [ -n "$EDGE" ] && $DOCKER inspect -f '{{.Config.Image}}' "$EDGE" | grep -qi caddy; then
  # ================= shared-caddy =================
  say "Порты 80/443 у Caddy в контейнере $EDGE — подключаю $DOMAIN к нему"
  NET=$($DOCKER inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{println $k}}{{end}}' "$EDGE" | grep -v '^$' | head -1)
  HOST_FILE=$($DOCKER inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}' "$EDGE")
  [ -n "$NET" ] || die "Не нашёл сеть Docker у $EDGE"

  # Compose CrewPay подключится к этой сети (deploy/docker-compose.shared-caddy.yml).
  cat > "$APP_DIR/edge.env" <<ENV
COMPOSE_FILE=docker-compose.yml:deploy/docker-compose.shared-caddy.yml
EDGE_NETWORK=$NET
ENV
  echo "Сеть: $NET"

  # Какой конфиг сейчас настоящий, неочевидно: файл в контейнере мог отстать от файла на хосте (inode),
  # а другой проект мог перезагрузить Caddy из копии в /tmp. Собираем всех кандидатов и берём тот,
  # в котором есть все сайты остальных (свой домен не считаем). Если такого нет — ничего не трогаем.
  WORK=$(mktemp -d)
  STAMP=$(date +%Y%m%d-%H%M%S)
  n=0
  add_candidate() { n=$((n + 1)); cp "$1" "$WORK/cand$n"; echo "$2" > "$WORK/cand$n.src"; }
  sites_of() { grep -E '^[^#[:space:]][^{]*\{[[:space:]]*$' "$1" | sed 's/{.*$//' | tr ', \t' '\n\n\n' | grep -v '^$' | grep -vE "^(www\.)?$DOMAIN$" | sort -u; }
  $DOCKER exec "$EDGE" cat /etc/caddy/Caddyfile > "$WORK/x" && add_candidate "$WORK/x" "container:/etc/caddy/Caddyfile"
  for f in $($DOCKER exec "$EDGE" sh -c 'ls /tmp/Caddyfile* 2>/dev/null' || true); do
    $DOCKER exec "$EDGE" cat "$f" > "$WORK/x" && add_candidate "$WORK/x" "container:$f"
  done
  if [ -n "$HOST_FILE" ]; then $SUDO cat "$HOST_FILE" > "$WORK/x" && add_candidate "$WORK/x" "host:$HOST_FILE"; fi
  for i in $(seq 1 $n); do
    cp "$WORK/cand$i" "$APP_DIR/Caddyfile.cand$i.$STAMP.bak"
    sites_of "$WORK/cand$i" > "$WORK/cand$i.sites"
  done
  sort -u "$WORK"/cand*.sites > "$WORK/all.sites"
  BASE=""
  for i in $(seq 1 $n); do
    if [ -z "$(comm -23 "$WORK/all.sites" "$WORK/cand$i.sites")" ]; then BASE="$WORK/cand$i"; echo "Основа: $(cat "$WORK/cand$i.src")"; break; fi
  done
  [ -n "$BASE" ] || die "Конфиги Caddy расходятся, ни один не содержит всех сайтов — ничего не изменено. Копии в $APP_DIR."
  echo "Сайты: $(tr '\n' ' ' < "$WORK/all.sites")"

  NEW="$WORK/new"
  cp "$BASE" "$NEW"
  if grep -qE "^[[:space:]]*$DOMAIN[[:space:]]*\{" "$BASE"; then
    say "Блок $DOMAIN уже есть в конфиге Caddy"
  else
    {
      echo
      echo "# CrewPay — добавлено deploy/setup-oracle.sh ($STAMP)"
      if [ "$WWW" = 1 ]; then
        echo "www.$DOMAIN {"
        echo "	redir https://$DOMAIN{uri} permanent"
        echo "}"
        echo
      fi
      echo "$DOMAIN {"
      echo "	encode zstd gzip"
      echo "	# Расчётные листки — до 5 МБ."
      echo "	request_body {"
      echo "		max_size 6MB"
      echo "	}"
      echo "	reverse_proxy $APP_ALIAS:3000"
      echo "}"
    } >> "$NEW"
  fi

  # Какие соседние сайты отвечают сейчас — после перезагрузки они обязаны отвечать так же.
  probe() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$1/" || true; }
  : > "$WORK/before"
  while read -r site; do
    [ -n "$site" ] && echo "$site $(probe "$site")" >> "$WORK/before"
  done < "$WORK/all.sites"

  # Проверка и перезагрузка из копии внутри контейнера — ошибка в конфиге не уронит другие сайты.
  $DOCKER cp "$NEW" "$EDGE:/tmp/Caddyfile.crewpay"
  if ! $DOCKER exec "$EDGE" caddy validate --config /tmp/Caddyfile.crewpay --adapter caddyfile >/dev/null 2>&1; then
    die "Новый конфиг Caddy не прошёл проверку — ничего не изменено. Копии в $APP_DIR."
  fi
  $DOCKER exec "$EDGE" caddy reload --config /tmp/Caddyfile.crewpay --adapter caddyfile
  echo "Caddy перезагружен"
  sleep 5

  # Сайты, которые работали до изменения, должны работать и после — иначе откат.
  broken=""
  while read -r site code; do
    [ "$code" = "000" ] && continue
    now=$(probe "$site")
    echo "  $site: $code → $now"
    [ "$now" = "000" ] && broken="$broken $site"
  done < "$WORK/before"
  if [ -n "$broken" ]; then
    $DOCKER cp "$BASE" "$EDGE:/tmp/Caddyfile.crewpay-rollback"
    $DOCKER exec "$EDGE" caddy reload --config /tmp/Caddyfile.crewpay-rollback --adapter caddyfile
    die "После изменения перестали отвечать:$broken — конфиг Caddy возвращён как был."
  fi

  # Записываем в тот же файл на хосте (tee сохраняет inode), чтобы рестарт Caddy не потерял сайты.
  if [ -n "$HOST_FILE" ]; then
    $SUDO tee "$HOST_FILE" < "$NEW" >/dev/null
    echo "Файл $HOST_FILE обновлён (все сайты: $(sites_of "$NEW" | tr '\n' ' ')+ $DOMAIN)"
  else
    warn "Caddyfile не смонтирован из файла — блок действует до рестарта $EDGE; добавьте его в конфиг проекта."
  fi
  rm -rf "$WORK"
  MODE=shared-caddy
else
  # ================= nginx =================
  [ -n "$EMAIL" ] || die "Укажите email для сертификата: bash setup-oracle.sh you@mail.com"
  busy=$($SUDO ss -ltnp 2>/dev/null | awk '$4 ~ /:(80|443)$/ {print $0}' | grep -v nginx || true)
  if [ -n "$busy" ]; then
    warn "Порты 80/443 заняты не nginx и не Caddy:"
    echo "$busy"
    die "Пришлите этот вывод — подстроим конфигурацию."
  fi

  say "Устанавливаю nginx и certbot"
  if [ "$PM" = apt ]; then
    $SUDO apt-get update -y
    $SUDO apt-get install -y nginx certbot python3-certbot-nginx
  else
    $SUDO dnf install -y oracle-epel-release-el"$(rpm -E %rhel)" || true
    $SUDO dnf install -y nginx certbot python3-certbot-nginx
    if command -v setsebool >/dev/null; then $SUDO setsebool -P httpd_can_network_connect 1 || true; fi
  fi
  $SUDO systemctl enable --now nginx

  say "Открываю 80 и 443 в файрволе сервера"
  if command -v firewall-cmd >/dev/null && $SUDO firewall-cmd --state >/dev/null 2>&1; then
    $SUDO firewall-cmd --permanent --add-service=http --add-service=https
    $SUDO firewall-cmd --reload
  else
    for port in 80 443; do
      if ! $SUDO iptables -C INPUT -p tcp -m state --state NEW --dport "$port" -j ACCEPT 2>/dev/null; then
        # До REJECT, которым образы Oracle закрывают остальное.
        pos=$($SUDO iptables -L INPUT --line-numbers -n | awk '$2=="REJECT" {print $1; exit}')
        $SUDO iptables -I INPUT "${pos:-1}" -p tcp -m state --state NEW --dport "$port" -j ACCEPT
      fi
    done
    if command -v netfilter-persistent >/dev/null; then
      $SUDO netfilter-persistent save
    elif [ "$PM" = apt ]; then
      $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent && $SUDO netfilter-persistent save || true
    fi
  fi

  NAMES="$DOMAIN"
  if [ "$WWW" = 1 ]; then NAMES="$DOMAIN www.$DOMAIN"; fi
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
  if [ -d /etc/nginx/sites-enabled ]; then $SUDO ln -sf "$CONF" "/etc/nginx/sites-enabled/$DOMAIN"; fi
  $SUDO nginx -t
  $SUDO systemctl reload nginx

  say "Получаю сертификат Let's Encrypt"
  CERT_ARGS=()
  for n in $NAMES; do CERT_ARGS+=(-d "$n"); done
  if ! $SUDO certbot --nginx "${CERT_ARGS[@]}" --non-interactive --agree-tos -m "$EMAIL" --redirect; then
    warn "Сертификат не выдан. Проверьте в Oracle Console: Networking → VCN → Security Lists → Ingress: TCP 80 и 443 с 0.0.0.0/0."
    exit 1
  fi
  : > "$APP_DIR/edge.env"
  MODE=nginx
fi

# Из GitHub Actions: ключи и секреты не печатаем — логи публичного репозитория видны всем.
if [ "${CREWPAY_CI:-}" = 1 ]; then
  say "Готово ($MODE). Дальше — деплой: Actions → CI & Deploy."
  exit 0
fi

KEY=~/.ssh/crewpay_deploy
if [ ! -f "$KEY" ]; then
  say "Создаю отдельный SSH-ключ для деплоя из GitHub"
  ssh-keygen -t ed25519 -N "" -C "crewpay-deploy" -f "$KEY" >/dev/null
  cat "$KEY.pub" >> ~/.ssh/authorized_keys
  chmod 600 ~/.ssh/authorized_keys
fi
say "Готово ($MODE). Секреты для GitHub → boldpunk/CrewPay → Settings → Secrets and variables → Actions:"
cat <<INFO

  SSH_HOST         ${PUBLIC_IP:-<публичный IP сервера>}
  SSH_USER         $(id -un)
  SSH_PRIVATE_KEY  содержимое файла $KEY (целиком, вместе со строками BEGIN/END)
  DATABASE_URL     строка подключения Neon (postgresql://…?sslmode=require)
  SITE_URL         https://$DOMAIN
INFO
