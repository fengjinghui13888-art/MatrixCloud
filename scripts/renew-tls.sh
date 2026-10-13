#!/bin/sh
set -eu
: "${MATRIX_ACME_BIN:?请设置 MATRIX_ACME_BIN}"
: "${MATRIX_ACME_STATE:?请设置 MATRIX_ACME_STATE}"
: "${MATRIX_TLS_DATA:?请设置 MATRIX_TLS_DATA}"
ACME="$MATRIX_ACME_BIN"
ACME_STATE="$MATRIX_ACME_STATE"
DATA="$MATRIX_TLS_DATA"
LOG="${MATRIX_TLS_RENEW_LOG:-$DATA/renew.log}"
umask 077
"$ACME" --home "$ACME_STATE" --cron > "$LOG" 2>&1
openssl x509 -checkend 86400 -noout -in "$DATA/fullchain.pem"
if systemctl is-active --quiet nginx; then
  nginx -t
  systemctl reload nginx
else
  # Compatibility for installations that have not adopted the independent ingress.
  docker kill --signal HUP matrix-cloud >/dev/null
fi
