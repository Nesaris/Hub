# syntax=docker/dockerfile:1
# Hub — image de production. Node 24 (Argon2id natif), aucune dépendance npm.
# L'image de base est épinglée par empreinte (index multi-architecture) : une
# étiquette peut être déplacée, une empreinte non.
ARG NODE_IMAGE=node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53

# Renouvellement du certificat HTTPS local (conteneur hub-certificat) : openssl
# seul, hors de l'image du Hub, qui n'en a pas besoin.
FROM ${NODE_IMAGE} AS certificat
RUN apk add --no-cache openssl

# Compteurs de la machine (conteneur hub-mesure) : sh et /proc, rien d'autre.
FROM ${NODE_IMAGE} AS mesure
# Paquets du système à jour, et pas de npm, npx, corepack ni yarn : le service
# n'a aucune dépendance npm, ils n'ont rien à faire dans l'image.
RUN apk upgrade --no-cache && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
RUN addgroup -S -g 1001 hub && adduser -S -G hub -u 1001 hub \
 && mkdir -p /run/mesure && chown hub:hub /run/mesure
COPY outils/mesure-hote.sh /opt/mesure-hote.sh
USER hub
ENTRYPOINT ["sh", "/opt/mesure-hote.sh"]

# Outils d'abonnement (conteneur hub-outils-ia) : Claude Code et Codex,
# lancés par le pont (outils-ia/pont.mjs) avec le compte connecté une fois
# dans le conteneur. Les versions suivent npm : ces outils changent souvent.
FROM ${NODE_IMAGE} AS outils-ia
RUN apk add --no-cache git ripgrep util-linux-misc \
 && npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code @openai/codex \
 && claude --version && codex --version \
 && npm cache clean --force \
 && addgroup -S -g 1002 outil && adduser -S -G outil -u 1002 -h /home/outil outil \
 && mkdir -p /home/outil && chown outil:outil /home/outil
COPY --chown=outil:outil outils-ia/pont.mjs /opt/pont.mjs
ENV HOME=/home/outil PONT_PORT=7110
USER outil
WORKDIR /home/outil
VOLUME ["/home/outil"]
EXPOSE 7110
CMD ["node", "/opt/pont.mjs"]

FROM ${NODE_IMAGE} AS hub
# Paquets du système à jour, et pas de npm, npx, corepack ni yarn : le service
# n'a aucune dépendance npm, ils n'ont rien à faire dans l'image.
RUN apk upgrade --no-cache && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg

# CLI docker + plugin compose : le Hub pilote Docker par le proxy de socket
# (DOCKER_HOST), jamais par le socket lui-même. Même utilisateur qu'avant
# (1001) : le volume de données existant reste lisible.
RUN apk add --no-cache docker-cli docker-cli-compose tini \
 && addgroup -S -g 1001 hub && adduser -S -G hub -u 1001 hub \
 && mkdir -p /data /run/mesure && chown hub:hub /data /run/mesure && chmod 700 /data

WORKDIR /app
COPY --chown=hub:hub package.json nouveautes.json ./
COPY --chown=hub:hub socle ./socle
COPY --chown=hub:hub server ./server
COPY --chown=hub:hub web ./web
COPY --chown=hub:hub docs ./docs
COPY --chown=hub:hub registry-local ./registry-local

ENV NODE_ENV=production \
    HUB_HOST=0.0.0.0 \
    HUB_PORT=8100 \
    HUB_DATA=/data \
    HUB_REGISTRY_LOCAL=/app/registry-local \
    HOME=/data

USER hub
VOLUME ["/data"]
EXPOSE 8100
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8100/api/status').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/entree.js"]
