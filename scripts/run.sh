#!/bin/sh
# Entrypoint: run the app under Litestream when backup storage is configured,
# otherwise run it directly. This makes the image safe to deploy BEFORE the
# Tigris bucket exists (no bucket secrets -> app just starts normally).
set -e

DB="${DB_PATH:-/data/app.db}"
CONF=/etc/litestream.yml
export DB_PATH="$DB"

if [ -n "$BUCKET_NAME" ] && [ -n "$AWS_ACCESS_KEY_ID" ]; then
  echo "[run] Litestream enabled — replicating $DB to bucket '$BUCKET_NAME'"
  if [ ! -f "$DB" ]; then
    echo "[run] no local database found — attempting restore from replica…"
    litestream restore -if-replica-exists -config "$CONF" "$DB" \
      || echo "[run] nothing to restore (fresh database)"
  fi
  exec litestream replicate -config "$CONF" -exec "node server/index.js"
else
  echo "[run] Litestream disabled (no bucket secrets) — starting app directly"
  exec node server/index.js
fi
