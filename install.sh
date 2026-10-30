#!/usr/bin/env bash
# Installation du Hub.
#   sudo ./install.sh              installe ou met à jour
#   sudo ./install.sh --uninstall  arrête et retire les conteneurs (données conservées)
#   sudo ./install.sh --purge      arrête, retire les conteneurs ET supprime les données
# Variables : HUB_DIR (défaut /opt/hub), HUB_REPO (défaut https://github.com/CodexX64/hub), HUB_REF (défaut main)
set -euo pipefail

HUB_DIR="${HUB_DIR:-/opt/hub}"
HUB_REPO="${HUB_REPO:-https://github.com/CodexX64/hub}"
HUB_REF="${HUB_REF:-main}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say()  { printf '\033[1m→\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Lance ce script avec sudo."

compose() { docker compose -f "$HUB_DIR/compose.yml" --project-directory "$HUB_DIR" "$@"; }

case "${1:-}" in
  --uninstall)
    [ -f "$HUB_DIR/compose.yml" ] || die "Aucune installation trouvée dans $HUB_DIR"
    compose down
    ok "Hub arrêté. Données conservées (volume hub_hub-data). Les services installés par le Hub continuent de tourner."
    exit 0 ;;
  --purge)
    [ -f "$HUB_DIR/compose.yml" ] || die "Aucune installation trouvée dans $HUB_DIR"
    read -r -p "Supprimer définitivement les données du Hub ? Tape SUPPRIMER : " answer
    [ "$answer" = "SUPPRIMER" ] || die "Annulé."
    compose down -v
    ok "Hub et données supprimés. Les services installés par le Hub n'ont pas été touchés."
    exit 0 ;;
  "" ) ;;
  * ) die "Option inconnue : $1" ;;
esac

# 1. système
. /etc/os-release 2>/dev/null || die "Système non reconnu"
ARCH="$(uname -m)"
case "$ARCH" in x86_64|amd64) ARCH=amd64 ;; aarch64|arm64) ARCH=arm64 ;; *) die "Architecture non prise en charge : $ARCH" ;; esac
MEM_MB=$(( $(grep MemTotal /proc/meminfo | awk '{print $2}') / 1024 ))
say "Système : ${PRETTY_NAME:-$ID} · $ARCH · $(nproc) cœurs · ${MEM_MB} Mo"
[ "$MEM_MB" -ge 1500 ] || say "Moins de 2 Go de RAM : le Hub fonctionnera, mais peu de services pourront être installés ici."

# 2. Docker
# Aucun script téléchargé n'est exécuté à l'aveugle : Docker vient des paquets
# signés de la distribution.
if ! command -v docker >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    say "Docker absent : installation depuis les paquets de la distribution"
    apt-get update -qq
    apt-get install -y -qq docker.io
    apt-get install -y -qq docker-compose-v2 2>/dev/null || apt-get install -y -qq docker-compose-plugin 2>/dev/null || true
  else
    die "Docker est absent. Installe-le depuis les paquets de ta distribution (moteur + plugin compose v2), puis relance."
  fi
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker compose version >/dev/null 2>&1 || die "Le plugin docker compose v2 est requis."
ok "Docker $(docker version --format '{{.Server.Version}}') et $(docker compose version --short)"
if [ -n "${SUDO_USER:-}" ] && ! id -nG "$SUDO_USER" | grep -qw docker; then
  usermod -aG docker "$SUDO_USER" && ok "Utilisateur $SUDO_USER ajouté au groupe docker"
fi

# 3. sources
mkdir -p "$HUB_DIR"
if [ -f "$SRC_DIR/compose.yml" ] && [ -d "$SRC_DIR/server" ]; then
  if [ "$SRC_DIR" != "$HUB_DIR" ]; then
    say "Copie des sources depuis $SRC_DIR"
    tar -C "$SRC_DIR" --exclude=./data --exclude=./secrets --exclude=./.git -cf - . | tar -C "$HUB_DIR" -xf -
  fi
else
  say "Téléchargement de $HUB_REPO ($HUB_REF)"
  tmp="$(mktemp -d)"
  curl -fsSL "$HUB_REPO/archive/refs/heads/$HUB_REF.tar.gz" | tar -xz -C "$tmp" --strip-components=1
  tar -C "$tmp" -cf - . | tar -C "$HUB_DIR" -xf -
  rm -rf "$tmp"
fi
chmod 700 "$HUB_DIR"

# 4. configuration
if [ ! -f "$HUB_DIR/.env" ]; then
  cp "$HUB_DIR/.env.example" "$HUB_DIR/.env"
  chmod 600 "$HUB_DIR/.env"
  ok "Fichier $HUB_DIR/.env créé (à relire)"
fi

# 5. clés maîtresses : secrets Docker dans $HUB_DIR/secrets, hors du volume de
# données. Une installation existante garde ses clés : elles sont lues dans
# le volume, puis le Hub retire la copie du volume au démarrage.
mkdir -p "$HUB_DIR/secrets" && chmod 700 "$HUB_DIR/secrets"
lire_volume() {
  docker volume inspect hub_hub-data >/dev/null 2>&1 && docker image inspect hub:local >/dev/null 2>&1 \
    && docker run --rm --network none -v hub_hub-data:/data:ro --entrypoint cat hub:local "$1" 2>/dev/null
}
if [ ! -s "$HUB_DIR/secrets/hub_cle" ]; then
  { lire_volume /data/keys/master.key || head -c 32 /dev/urandom; } | base64 -w0 > "$HUB_DIR/secrets/hub_cle"
fi
if [ ! -s "$HUB_DIR/secrets/socle_cle" ]; then
  lire_volume /data/cles/socle.key > "$HUB_DIR/secrets/socle_cle" || head -c 32 /dev/urandom | base64 -w0 > "$HUB_DIR/secrets/socle_cle"
fi
for f in hub_cle socle_cle; do
  [ "$(base64 -d < "$HUB_DIR/secrets/$f" 2>/dev/null | wc -c)" = 32 ] || die "Clé $HUB_DIR/secrets/$f illisible : elle doit faire 32 octets en base64."
done
# Clés remplacées, pendant une rotation seulement (README, « Tourner une clé ») : vides sinon.
for f in hub_cle_ancienne socle_cle_ancienne; do [ -e "$HUB_DIR/secrets/$f" ] || : > "$HUB_DIR/secrets/$f"; done
chown 1001:1001 "$HUB_DIR/secrets/hub_cle" "$HUB_DIR/secrets/socle_cle" "$HUB_DIR/secrets/hub_cle_ancienne" "$HUB_DIR/secrets/socle_cle_ancienne"
chmod 400 "$HUB_DIR/secrets/hub_cle" "$HUB_DIR/secrets/socle_cle" "$HUB_DIR/secrets/hub_cle_ancienne" "$HUB_DIR/secrets/socle_cle_ancienne"
# Jeton partagé entre le Hub et le pont des outils d'abonnement : un fichier par conteneur.
if [ ! -s "$HUB_DIR/secrets/pont_jeton" ] || [ ! -s "$HUB_DIR/secrets/pont_jeton_outil" ]; then
  j=$(head -c 32 /dev/urandom | base64 -w0 | tr '+/' '-_' | tr -d '=')
  printf '%s' "$j" > "$HUB_DIR/secrets/pont_jeton"; printf '%s' "$j" > "$HUB_DIR/secrets/pont_jeton_outil"; unset j
fi
chown 1001:1001 "$HUB_DIR/secrets/pont_jeton"; chown 1002:1002 "$HUB_DIR/secrets/pont_jeton_outil"
chmod 400 "$HUB_DIR/secrets/pont_jeton" "$HUB_DIR/secrets/pont_jeton_outil"
# Clé publique des sauvegardes : vide jusqu'à ce que tu y colles la tienne (README, « Sauvegardes »).
[ -e "$HUB_DIR/secrets/sauvegarde.pub" ] || : > "$HUB_DIR/secrets/sauvegarde.pub"
chmod 444 "$HUB_DIR/secrets/sauvegarde.pub"
ok "Clés maîtresses dans $HUB_DIR/secrets (à sauvegarder à part du volume)"

# 6. lancement
say "Construction et démarrage"
compose up -d --build
for i in $(seq 1 30); do
  if docker inspect -f '{{.State.Health.Status}}' hub 2>/dev/null | grep -q healthy; then break; fi
  sleep 2
done
docker inspect -f '{{.State.Health.Status}}' hub 2>/dev/null | grep -q healthy || die "Le Hub ne répond pas. Voir : docker compose -f $HUB_DIR/compose.yml logs hub"

PORT="$(grep -E '^HUB_BIND_PORT=' "$HUB_DIR/.env" | cut -d= -f2)"; PORT="${PORT:-8100}"
JETON="$(docker logs hub 2>&1 | grep -o "Jeton d'installation : [A-Za-z0-9_-]*" | tail -1 | awk '{print $NF}' || true)"
echo
ok "Hub prêt sur http://127.0.0.1:${PORT} (écoute locale uniquement)"
echo "   Accès depuis ton réseau : HTTPS servi par le Hub (sh outils/tls-local.sh NOM IP, puis HUB_BIND_IP, HUB_TLS_NOM et HUB_TLS_IP dans .env),"
echo "   ou un relais HTTPS (Caddy, Traefik, Relay) déclaré dans SOCLE_PROXYS."
[ -n "$JETON" ] && echo "   Jeton d'installation, demandé à la création du premier compte : $JETON"
echo "   Première connexion : ssh -L ${PORT}:127.0.0.1:${PORT} <serveur>, puis http://localhost:${PORT}"
echo "   (une clé d'accès exige HTTPS ou localhost, jamais une adresse IP)."
echo "   Journaux : docker compose -f $HUB_DIR/compose.yml logs -f hub"
