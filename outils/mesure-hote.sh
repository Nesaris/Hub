#!/bin/sh
# Compteurs de la machine pour la Vue d'ensemble du Hub (server/mesures.js).
# Lancé par le conteneur hub-mesure (compose.yml) : réseau de l'hôte pour voir
# ses cartes, aucun droit, aucun port, système de fichiers en lecture seule.
# Toutes les quinze secondes, un fichier remplacé d'un bloc dans le volume
# partagé : la date, la première ligne de /proc/stat, la mémoire, et les
# octets reçus et émis de chaque carte physique (celles qui ont un
# périphérique : ni boucle, ni pont, ni veth de Docker).
set -u
d=${MESURE_DIR:-/run/mesure}
while :; do
  {
    echo "t $(date +%s)"
    head -n 1 /proc/stat
    grep -E '^(MemTotal|MemAvailable):' /proc/meminfo
    for c in /sys/class/net/*; do
      [ -e "$c/device" ] || continue
      echo "if ${c##*/} $(cat "$c/statistics/rx_bytes") $(cat "$c/statistics/tx_bytes")"
    done
  } > "$d/hote.tmp" && mv "$d/hote.tmp" "$d/hote"
  sleep 15
done
