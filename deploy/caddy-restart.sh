#!/usr/bin/env bash
# Безопасный перезапуск общего Caddy (dcau-hub-caddy-1).
# 1) Сохраняет действующую конфигурацию (JSON из admin API) — точную копию того, что сейчас обслуживает сайты.
# 2) Проверяет, что после перезапуска Caddy прочитает файл со всеми сайтами; если нет — не перезапускает.
# 3) Перезапускает и проверяет каждый сайт; если что-то перестало отвечать — возвращает сохранённую конфигурацию.
set -euo pipefail

EDGE="${EDGE:-$(docker ps --filter publish=443 --format '{{.Names}}' | head -1)}"
[ -n "$EDGE" ] || { echo "Нет контейнера на 443"; exit 1; }
echo "Контейнер: $EDGE"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

sites() { grep -E '^[^#[:space:]][^{]*\{[[:space:]]*$' | sed 's/[[:space:]]*{[[:space:]]*$//' | tr ', ' '\n\n' | grep -v '^$' | sort -u; }
probe() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$1/" || true; }

# Какой файл Caddy читает при старте.
cmd=$(docker inspect -f '{{join .Config.Entrypoint " "}} {{join .Config.Cmd " "}}' "$EDGE")
echo "Команда запуска: $cmd"
CONF=$(echo "$cmd" | grep -oE -- '--config[= ][^ ]+' | sed -E 's/--config[= ]//' | head -1)
CONF=${CONF:-/etc/caddy/Caddyfile}
echo "Файл конфигурации при старте: $CONF"

# Источник этого файла после перезапуска: bind-mount с хоста или слой контейнера.
SRC=""
while IFS='|' read -r src dst; do
  case "$CONF" in
    "$dst") SRC="$src" ;;
    "$dst"/*) [ -z "$SRC" ] && SRC="$src${CONF#"$dst"}" ;;
  esac
done < <(docker inspect -f '{{range .Mounts}}{{.Source}}|{{.Destination}}{{println}}{{end}}' "$EDGE")

if [ -n "$SRC" ]; then
  echo "После перезапуска будет прочитан файл хоста: $SRC"
  sudo cat "$SRC" > "$WORK/next"
else
  echo "Файл лежит в контейнере (не смонтирован)"
  docker exec "$EDGE" cat "$CONF" > "$WORK/next"
fi

# Действующие сайты — из admin API (то, что реально обслуживается сейчас).
docker exec "$EDGE" wget -qO- http://localhost:2019/config/ > "$WORK/live.json"
[ -s "$WORK/live.json" ] || { echo "Не удалось прочитать действующую конфигурацию — перезапуск отменён"; exit 1; }
docker cp "$WORK/live.json" "$EDGE:/tmp/caddy-live-backup.json"
grep -o '"host":\[[^]]*\]' "$WORK/live.json" | grep -o '"[^"]*"' | grep -v '"host"' | tr -d '"' | sort -u > "$WORK/live_sites"
sites < "$WORK/next" > "$WORK/next_sites"
echo "Сейчас обслуживаются: $(tr '\n' ' ' < "$WORK/live_sites")"
echo "В файле для старта:   $(tr '\n' ' ' < "$WORK/next_sites")"

missing=$(comm -23 "$WORK/live_sites" "$WORK/next_sites" || true)
if [ -n "$missing" ]; then
  echo "::error::В файле для старта нет сайтов: $(echo "$missing" | tr '\n' ' ') — перезапуск отменён, ничего не изменено"
  exit 1
fi
docker exec "$EDGE" caddy validate --config "$CONF" --adapter caddyfile >/dev/null 2>&1 \
  || { echo "::error::Файл для старта не проходит caddy validate — перезапуск отменён"; exit 1; }

while read -r s; do echo "$s $(probe "$s")"; done < "$WORK/live_sites" > "$WORK/before"
echo "== до перезапуска"; cat "$WORK/before"

docker restart "$EDGE" >/dev/null
echo "Перезапущен, жду готовности…"
for _ in $(seq 1 30); do
  docker exec "$EDGE" wget -qO- http://localhost:2019/config/ >/dev/null 2>&1 && break
  sleep 2
done
sleep 5

bad=0
echo "== после перезапуска"
while read -r s code; do
  now=$(probe "$s")
  echo "$s $now"
  # Сайт, который отвечал (не 000 и не 5xx), должен отвечать и сейчас.
  if [ "$code" != 000 ] && [ "${code:0:1}" != 5 ] && { [ "$now" = 000 ] || [ "${now:0:1}" = 5 ]; }; then bad=1; fi
done < "$WORK/before"

if [ "$bad" = 1 ]; then
  echo "::error::После перезапуска сайт перестал отвечать — возвращаю сохранённую конфигурацию"
  docker exec "$EDGE" caddy reload --config /tmp/caddy-live-backup.json
  sleep 5
  while read -r s _; do echo "$s $(probe "$s")"; done < "$WORK/before"
  exit 1
fi
echo "Готово: Caddy перезапущен, все сайты отвечают."
