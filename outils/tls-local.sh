#!/bin/sh
# Certificat HTTPS du Hub sur un réseau local, signé par une autorité propre à
# cette installation. Usage, dans le dossier du Hub et en root :
#   sh outils/tls-local.sh NOM IP      (ex. hub.home.arpa 192.0.2.10)
#
# - secrets/ca/  : l'autorité (sa clé ne quitte jamais ce dossier, jamais
#   montée dans le conteneur). Elle ne peut signer QUE ce nom, cette IP et
#   localhost (nameConstraints) : faire confiance à son certificat sur un poste
#   ne lui donne aucun pouvoir sur un autre site.
# - secrets/tls/ : hub.crt, hub.key (lus par le Hub), ca.crt (à installer sur
#   les postes qui ouvrent le Hub).
#
# Relancé chaque jour (cron) : ne fait rien tant que le certificat a plus de
# 30 jours devant lui et porte les mêmes noms ; le Hub recharge le nouveau
# certificat seul, sans redémarrer.
set -eu
NOM="${1:?nom du Hub (ex. hub.home.arpa)}"
IP="${2:?adresse IP de la machine}"
echo "$NOM" | grep -Eq '^[a-z0-9-]+(\.[a-z0-9-]+)+$' || { echo "Nom invalide : $NOM" >&2; exit 2; }
echo "$IP" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$' || { echo "IPv4 invalide : $IP" >&2; exit 2; }
command -v openssl >/dev/null || { echo "openssl manquant" >&2; exit 2; }

cd "$(dirname "$0")/.."
CA=secrets/ca; TLS=secrets/tls
PORTEE="$NOM $IP"
umask 077
mkdir -p "$CA" "$TLS"

if [ ! -s "$CA/ca.key" ] || [ "$(cat "$CA/portee" 2>/dev/null)" != "$PORTEE" ]; then
  openssl req -x509 -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
    -keyout "$CA/ca.key" -out "$CA/ca.crt" -days 3650 -subj "/CN=Hub - autorite locale" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -addext "subjectKeyIdentifier=hash" \
    -addext "nameConstraints=critical,permitted;DNS:$NOM,permitted;DNS:localhost,permitted;IP:$IP/255.255.255.255,permitted;IP:127.0.0.1/255.255.255.255" 2>/dev/null
  echo "$PORTEE" > "$CA/portee"
  rm -f "$TLS/hub.crt"
  echo "autorité créée : installe secrets/tls/ca.crt sur tes postes"
fi

if [ -s "$TLS/hub.crt" ] && [ -s "$TLS/hub.key" ] && openssl x509 -in "$TLS/hub.crt" -noout -checkend 2592000 >/dev/null \
  && openssl verify -CAfile "$CA/ca.crt" "$TLS/hub.crt" >/dev/null 2>&1; then
  echo "certificat valable jusqu'au $(openssl x509 -in "$TLS/hub.crt" -noout -enddate | cut -d= -f2) : rien à faire"
  exit 0
fi

EXT="$(mktemp)"; CSR="$(mktemp)"
trap 'rm -f "$EXT" "$CSR"' EXIT
cat > "$EXT" <<FIN
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
subjectAltName=DNS:$NOM,DNS:localhost,IP:$IP,IP:127.0.0.1
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid
FIN
openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout "$TLS/hub.key.neuf" -out "$CSR" -subj "/CN=$NOM" 2>/dev/null
# 397 jours : la plus longue durée que les navigateurs acceptent.
openssl x509 -req -in "$CSR" -CA "$CA/ca.crt" -CAkey "$CA/ca.key" -set_serial "0x$(openssl rand -hex 16)" \
  -days 397 -sha256 -extfile "$EXT" -out "$TLS/hub.crt.neuf" 2>/dev/null
openssl verify -CAfile "$CA/ca.crt" "$TLS/hub.crt.neuf" >/dev/null

# Le Hub tourne sous l'utilisateur 1001 : il lit sa clé, rien d'autre.
cp "$CA/ca.crt" "$TLS/ca.crt"
chown 1001:1001 "$TLS/hub.key.neuf"; chmod 400 "$TLS/hub.key.neuf"
chmod 644 "$TLS/hub.crt.neuf" "$TLS/ca.crt"
mv -f "$TLS/hub.key.neuf" "$TLS/hub.key"
mv -f "$TLS/hub.crt.neuf" "$TLS/hub.crt"
chown root:1001 "$TLS"; chmod 750 "$TLS"
echo "certificat émis pour $NOM, $IP et localhost, valable jusqu'au $(openssl x509 -in "$TLS/hub.crt" -noout -enddate | cut -d= -f2)"
