#!/bin/sh
# Renouvellement du certificat HTTPS, sans cron : le conteneur hub-certificat
# (compose.yml) relance tls-local.sh une fois par jour. Il ne fait rien tant
# que HUB_TLS_NOM et HUB_TLS_IP ne sont pas posés dans .env.
set -u
while :; do
  if [ -n "${HUB_TLS_NOM:-}" ] && [ -n "${HUB_TLS_IP:-}" ]; then
    sh "$(dirname "$0")/tls-local.sh" "$HUB_TLS_NOM" "$HUB_TLS_IP" || echo "renouvellement du certificat en échec" >&2
  fi
  sleep 86400
done
