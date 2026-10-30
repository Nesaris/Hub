// Configuration du Hub, lue et validée une fois au démarrage : une valeur
// fausse arrête le processus avec la liste des erreurs (REQ-CFG-004). Les
// variables SOCLE_* (comptes, relais, clé maîtresse) sont lues par le socle.
import fs from 'node:fs';
import path from 'node:path';
import { lireConfig } from '../socle/src/index.js';

// La version vient de package.json : une seule source.
const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export const SPEC_HUB = {
  host: { env: 'HUB_HOST', type: 'chaine', motif: /^[\w.:-]{1,253}$/, defaut: '127.0.0.1' },
  port: { env: 'HUB_PORT', type: 'entier', min: 0, max: 65535, defaut: 8100 },
  dataDir: { env: 'HUB_DATA', type: 'chaine', defaut: './data' },
  // Clé maîtresse du coffre du Hub, hors du volume (HUB_CLE_FILE : secret Docker).
  cle: { env: 'HUB_CLE', type: 'chaine', motif: /^(?:[A-Za-z0-9+/]{43}=|[A-Za-z0-9_-]{43})$/, defaut: '' },
  // Pendant une rotation seulement (HUB_CLE_ANCIENNE_FILE) : la clé remplacée.
  cleAncienne: { env: 'HUB_CLE_ANCIENNE', type: 'chaine', motif: /^(?:[A-Za-z0-9+/]{43}=|[A-Za-z0-9_-]{43})$/, defaut: '' },
  // Clé publique RSA (PEM) pour laquelle les sauvegardes sont chiffrées ; la clé privée reste ailleurs.
  sauvegardeCle: { env: 'HUB_SAUVEGARDE_CLE', type: 'chaine', motif: /^-----BEGIN PUBLIC KEY-----[A-Za-z0-9+/=\s]+-----END PUBLIC KEY-----$/, defaut: '' },
  // Adresse par laquelle les services joignent le Hub (webhooks).
  publicUrl: { env: 'HUB_PUBLIC_URL', type: 'url', defaut: 'http://hub:8100' },
  // API tierces, remplaçables pour les essais ou derrière un relais.
  telegramApi: { env: 'HUB_TELEGRAM_API', type: 'url', defaut: 'https://api.telegram.org' },
  elevenApi: { env: 'HUB_ELEVEN_API', type: 'url', defaut: 'https://api.elevenlabs.io' },
  // Origine de l'interface quand elle diffère de celle du Hub : ajoutée aux
  // origines admises pour les écritures (comme SOCLE_ORIGINES).
  uiOrigin: { env: 'HUB_UI_ORIGIN', type: 'url' },
  registryDefault: { env: 'HUB_REGISTRY', type: 'chaine', motif: /^(local|github-user:[\w.-]{1,39}|github:[\w.-]{1,39}\/[\w.-]{1,100}(@[\w./-]{1,100})?|dir:\S+|https:\/\/\S+)$/, defaut: 'github-user:CodexX64' },
  registryLocalDir: { env: 'HUB_REGISTRY_LOCAL', type: 'chaine', defaut: './registry-local' },
  dockerNetwork: { env: 'HUB_DOCKER_NETWORK', type: 'chaine', motif: /^[\w.-]{1,64}$/, defaut: 'hub_net' },
  // Remplacé par la détection du socle : HTTPS direct, ou relais déclaré dans SOCLE_PROXYS.
  secureCookies: { env: 'HUB_SECURE_COOKIES', type: 'booleen', defaut: false },
  // Dossier où le conteneur hub-mesure dépose les compteurs de la machine
  // (outils/mesure-hote.sh) ; vide : la Vue d'ensemble s'en passe.
  mesureDir: { env: 'HUB_MESURE_DIR', type: 'chaine', defaut: '' },
  probeRetentionDays: { env: 'HUB_PROBE_RETENTION_DAYS', type: 'entier', min: 1, max: 3650, defaut: 7 },
  logLevel: { env: 'HUB_LOG_LEVEL', type: 'choix', parmi: ['debug', 'info', 'warn', 'error'], defaut: 'info' },
  fuseau: { env: 'HUB_TZ', type: 'chaine', motif: /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/, defaut: '' },
  ollamaCtx: { env: 'HUB_OLLAMA_CTX', type: 'entier', min: 2048, max: 262144, defaut: 16384 },
  // Plafonds de l'IA, toutes connexions confondues, sur 24 heures glissantes, et par appel.
  iaAppelsJour: { env: 'HUB_IA_APPELS_JOUR', type: 'entier', min: 1, max: 1000000, defaut: 3000 },
  iaJetonsJour: { env: 'HUB_IA_JETONS_JOUR', type: 'entier', min: 1000, max: 10000000000, defaut: 2000000 },
  // Par service, sur la passerelle interne : un service ne peut pas épuiser seul le plafond de tous.
  iaServiceAppelsJour: { env: 'HUB_IA_SERVICE_APPELS_JOUR', type: 'entier', min: 1, max: 1000000, defaut: 1000 },
  // Les outils par abonnement (Claude Code, Codex) gardent le compte de l'utilisateur à portée du modèle :
  // fermés aux services, sauf à ceux nommés ici (« synapse,essaim »).
  iaServicesOutils: { env: 'HUB_IA_SERVICES_OUTILS', type: 'chaine', motif: /^$|^[a-z0-9][a-z0-9-]{1,30}(,[a-z0-9][a-z0-9-]{1,30})*$/, defaut: '' },
  iaServiceAppelsMinute: { env: 'HUB_IA_SERVICE_APPELS_MINUTE', type: 'entier', min: 1, max: 10000, defaut: 60 },
  iaJetonsMax: { env: 'HUB_IA_JETONS_MAX', type: 'entier', min: 256, max: 131072, defaut: 8192 },
  memoireDelai: { env: 'HUB_MEMOIRE_DELAI', type: 'entier', min: 200, max: 60000, defaut: 3000 },
  catalogueAutoMs: { env: 'HUB_CATALOGUE_AUTO_MS', type: 'entier', min: 0, max: 86400000, defaut: 120000 },
  // Adresse de l'hôte où Docker publie le port du Hub (compose.yml la passe
  // aussi au conteneur) : hors boucle locale, HTTPS est exigé.
  bindIp: { env: 'HUB_BIND_IP', type: 'chaine', motif: /^[0-9a-f.:]{2,45}$/i, defaut: '127.0.0.1' },
  // Certificat servi par le Hub lui-même (hub.crt, hub.key), et le nom qu'il porte.
  tlsDir: { env: 'HUB_TLS_DIR', type: 'chaine', defaut: '' },
  tlsNom: { env: 'HUB_TLS_NOM', type: 'chaine', motif: /^(?=.{1,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/i, defaut: '' },
  // L'adresse IPv4 de la machine sur le réseau (celle du certificat) : un
  // service qui en a besoin (Relay, son résolveur) la reçoit sans la demander.
  tlsIp: { env: 'HUB_TLS_IP', type: 'chaine', motif: /^(\d{1,3}\.){3}\d{1,3}$/, defaut: '' },
};

// Ce que l'assistant de configuration demande (première installation, puis
// seulement les réglages nouveaux d'une mise à jour). depuis : la version qui
// a ajouté le réglage. Le reste se règle dans les pages du Hub.
export const REGLAGES_HUB = [
  { env: 'HUB_REGISTRY', groupe: 'Catalogue', libelle: 'Catalogue des extensions', exemple: 'github-user:mon-compte', depuis: '0.15.0',
    aide: 'Où le Hub cherche les services à installer : github-user:<compte> (ses dépôts qui ont un hub.json), github:<compte>/<dépôt>, une adresse https:// ou local.' },
  { env: 'HUB_PUBLIC_URL', groupe: 'Catalogue', libelle: 'Adresse du Hub vue des services', depuis: '0.15.0', avance: true,
    aide: 'Par où les services installés joignent le Hub (webhooks). Le défaut convient à une installation par compose.yml.' },
  { env: 'HUB_IA_APPELS_JOUR', groupe: 'Intelligence artificielle', libelle: 'Appels à l’IA par jour au plus', depuis: '0.15.0', avance: true,
    aide: 'Toutes connexions confondues, sur 24 heures glissantes.' },
  { env: 'HUB_IA_JETONS_JOUR', groupe: 'Intelligence artificielle', libelle: 'Jetons d’IA par jour au plus', depuis: '0.15.0', avance: true },
  { env: 'HUB_IA_SERVICE_APPELS_JOUR', groupe: 'Intelligence artificielle', libelle: 'Appels par jour pour un service', depuis: '0.15.0', avance: true },
];

export function lireConfigHub(env = process.env) {
  const c = lireConfig(SPEC_HUB, env);
  const erreurs = [];
  if (c.secureCookies && !String(env.SOCLE_PROXYS || '').trim()) {
    erreurs.push('HUB_SECURE_COOKIES est remplacé : le Hub sait seul qu’il est servi en HTTPS, directement ou par un relais déclaré dans SOCLE_PROXYS. Déclare ton relais dans SOCLE_PROXYS et retire HUB_SECURE_COOKIES.');
  }
  if (erreurs.length) throw Object.assign(new Error('Configuration invalide :\n  - ' + erreurs.join('\n  - ')), { erreurs });
  return Object.freeze({ ...c, dataDir: path.resolve(c.dataDir), registryLocalDir: path.resolve(c.registryLocalDir), version: VERSION });
}

export const config = lireConfigHub();
