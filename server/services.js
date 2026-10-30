// Instances de services : installation locale (compose), connexion distante, santé, suppression.
import { reglageCourriel, smtpPourService } from './courriel.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { generateSecret } from './vault.js';
import { docker } from './docker.js';
import { archiveGithub, cibleDeConstruction, depotGithub, reempaqueter, referencesPour } from './construction.js';
import { fuseau, render } from './manifest/template.js';
import { containerName } from './runtime.js';
import { HttpError, id, log, parseDuration, sleep } from './util/common.js';
import { gammePour, reglageTheme, pileSuitLaGamme, gammeRecue, composeLitToutes, composeLitApparence } from './theme.js';

const secretKeysOf = m => (m.config || []).filter(f => f.type === 'secret').map(f => f.key);
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;

// Capacités noyau jamais accordées : elles rendent l'isolation du conteneur illusoire.
const CAPS_INTERDITES = new Set(['ALL', 'SYS_ADMIN', 'SYS_MODULE', 'SYS_PTRACE', 'SYS_BOOT', 'SYS_RAWIO', 'DAC_READ_SEARCH', 'MKNOD']);

// Adresses auxquelles un humain peut ouvrir le service depuis son navigateur.
// L'URL interne (http://hub-<nom>:80) ne sert qu'au Hub : elle ne résout que
// sur le réseau Docker, et n'a rien à faire devant un humain.
//
// En mode « port », l'adresse dépend de la machine, que le conteneur du Hub
// ne peut pas deviner : il ne voit que son réseau Docker. Elle vient du
// réglage « adresse de la machine » ; à défaut, l'entrée porte `port` sans
// `url` et le navigateur la complète avec le nom d'hôte par lequel il joint
// le Hub — qui est, par construction, une adresse de cette machine.
export function openAddresses(inst, { exposition = 'loopback', machine = '', publiee = '' } = {}) {
  const m = inst.manifest;
  if (inst.mode === 'remote') return [{ label: 'Adresse du service', url: inst.url }];
  const out = [];
  (m.install.ports || []).forEach((p, i) => {
    if (!/http|ws/.test(p.protocol)) return;
    if (p.expose !== 'host' && p.expose !== 'proxy') return;
    const port = Number(inst.stack < 10 ? `81${inst.stack}${i}` : `8${inst.stack}${i}`);
    const scheme = /s$/.test(p.protocol) ? 'https' : 'http';
    if (adresseEcoute(exposition, p) === '0.0.0.0') {
      const e = { label: `Sur le réseau (${p.name})`, port, scheme, reseau: true };
      if (machine) e.url = `${scheme}://${hoteUrl(machine)}:${port}`;
      out.push(e);
    } else {
      out.push({ label: `Sur la machine du Hub (${p.name})`, url: `${scheme}://127.0.0.1:${port}`, port, scheme, host: true });
    }
  });
  // L'adresse publiée par Relay d'abord, puis l'adresse réseau : c'est celle qu'on veut ouvrir.
  if (publiee) out.unshift({ label: 'Adresse publiée', url: publiee, publiee: true });
  return out.sort((a, b) => (b.publiee ? 2 : b.reseau ? 1 : 0) - (a.publiee ? 2 : a.reseau ? 1 : 0));
}

// Nom d'hôte ou adresse IP que l'on peut mettre dans une URL.
const HOTE_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
export function hoteValide(h) {
  if (typeof h !== 'string' || h.length > 253) return false;
  if (h === '') return true;
  return HOTE_RE.test(h) || /^[0-9a-fA-F:]+$/.test(h) && h.includes(':');
}
const hoteUrl = h => h.includes(':') ? `[${h}]` : h;

// Images citées par un fichier Compose, dans l'ordre d'apparition, sans doublon.
export function imagesOf(compose) {
  const out = [];
  for (const m of compose.matchAll(/^\s*image:\s*["']?([^"'\s#]+)/gm)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

// Permissions sensibles qu'un manifeste peut demander. Refusées par défaut,
// accordées seulement si le manifeste les déclare ET que l'utilisateur les valide.
export function sensitivePermissions(m) {
  const p = m.permissions || {};
  const out = [];
  if (p.hostNetwork) out.push({ key: 'hostNetwork', label: 'Réseau de la machine', why: 'Le service partage la pile réseau de l’hôte : il voit tout le trafic des interfaces et ses ports ne sont plus isolés.' });
  for (const c of p.capAdd || []) out.push({ key: 'cap:' + c, label: 'Capacité ' + c, why: 'Le conteneur reçoit un privilège noyau supplémentaire.' });
  if (p.dockerSocket === 'proxy') out.push({ key: 'dockerSocket', label: 'Accès à Docker par le proxy', why: 'Le service peut lister et piloter des conteneurs à travers le proxy du Hub.' });
  return out;
}

// Vérifie le Compose rendu contre les permissions déclarées dans le manifeste.
/**
 * Les variables qu'un fichier Compose d'extension peut employer.
 *
 * Elles viennent toutes du manifeste ou de l'instance : un manifeste qui
 * emploie un nom qu'il n'a pas déclaré se trompe, et doit le savoir avant
 * que la pile démarre à moitié.
 */
/* ---------- exposition ----------
   Où un port publié est mis à l'écoute.

     loopback   127.0.0.1 : rien ne sort de la machine. C'est le défaut,
                parce qu'un service ouvert par accident sur le réseau est
                une faute qu'on ne remarque pas.
     port       0.0.0.0 : joignable en ip:port depuis le réseau. Aucune
                configuration DNS, aucun certificat, un port à retenir.
     proxy      un proxy devant, routé par nom d'hôte. Pas encore livré.
     ip         une adresse par service, en macvlan. Pas encore livré.

   Dans tous les cas, seuls les ports que le manifeste destine aux humains
   — `expose: proxy` — peuvent sortir. Une base de données déclarée
   `expose: host` reste sur la boucle locale quoi qu'on règle : personne
   n'a jamais voulu publier son Postgres sur le LAN. */
export const EXPOSITIONS = ['loopback', 'port', 'proxy', 'ip'];
export const EXPOSITION_LIBELLE = {
  loopback: 'Boucle locale — accès par tunnel uniquement',
  port: 'Adresse et port de la machine',
  proxy: 'Derrière un reverse proxy (pas encore disponible)',
  ip: 'Une adresse par service (pas encore disponible)',
};

/* Le jeton de cerveau d'un service auprès de sa mémoire (SYNAPSE) : dérivé du
   jeton que le Hub y a semé, valable pour ce seul nom. SYNAPSE le vérifie par
   le même calcul ; changer le jeton du Hub les révoque tous. */
export function jetonCerveau(secret, nom) {
  if (!secret || String(secret).length < 16 || !/^[a-z0-9][a-z0-9-]{1,30}$/.test(String(nom))) return '';
  return `cer_${nom}_${crypto.createHmac('sha256', String(secret)).update('cerveau:' + nom).digest('hex')}`;
}

/* Le port publié sur la machine pour le i-ème port d'un service installé ici. */
// Piles 1 à 9 : 8110 à 8199. Au-delà, 20100 à 20999 : « 8${stack} » donnait
// 8100 (le Hub lui-même) pour la pile 10 et 8110 (la pile 1) pour la 11.
export function portHote(stack, i) { return stack < 10 ? `81${stack}${i}` : String(20000 + stack * 10 + i); }

/* L'adresse d'un service vue depuis la machine elle-même — pour un service qui
   tourne en réseau hôte (un scanner) et ne résout pas les noms de conteneurs.
   Installé ici : son port publié sur la boucle locale. Distant : son adresse. */
export function adresseHote(inst) {
  if (inst.mode !== 'compose' || inst.stack == null) return inst.url;
  const ports = inst.manifest?.install?.ports || [];
  const i = Math.max(0, ports.findIndex(p => p.expose === 'proxy' || p.name === 'http'));
  return ports.length ? `http://127.0.0.1:${portHote(inst.stack, i)}` : inst.url;
}

/** L'adresse où le Hub joint un service installé ici : son conteneur, sur le
 *  premier port HTTP que déclare le manifeste. */
export const adresseInterne = (name, m) => `http://${containerName({ name })}:${(m.install?.ports || []).find(p => /http|ws/.test(p.protocol))?.container || 80}`;

export function adresseEcoute(mode, port) {
  if (mode === 'port' && port.expose === 'proxy') return '0.0.0.0';
  return '127.0.0.1';
}

// La clé de manifeste qui porte l'étiquette de l'image.
const CLE_IMAGE = 'IMAGE_TAG';
const FIXE = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
/** 2.0.3, v1.4.1-rc.1 : une version publiée, qui ne bouge plus. latest, main, 2 : mobiles. */
export function etiquetteFixe(t) { return typeof t === 'string' && FIXE.test(t); }
const versionDe = t => t.replace(/^v/, '').replace(/[-+].*$/, '');
/** L'étiquette d'une référence d'image : ghcr.io:443/a/b:2.0.3 → 2.0.3 ; sans étiquette → latest. */
export function etiquetteDe(ref) {
  const nom = ref.split('@')[0];
  const dernier = nom.slice(nom.lastIndexOf('/') + 1);
  return dernier.includes(':') ? dernier.slice(dernier.indexOf(':') + 1) : 'latest';
}
/** Une version d'image différente du défaut du manifeste a été choisie par quelqu'un. */
export function imageEpinglee(m, cfg) {
  const def = (m.config || []).find(f => f.key === CLE_IMAGE)?.default;
  const v = cfg[CLE_IMAGE];
  return v !== undefined && v !== '' && def !== undefined && v !== def;
}

export function composeVars(inst, m, cfg, fournisseur = () => null, exposition = 'loopback', ui = '', gamme = 'soma') {
  const ports = m.install.ports || [];

  /* ---------- les services dont celui-ci dépend ----------
     Déclarer `requires: llm.embed`, c'est déjà avoir dit lequel. Le Hub
     connaît son adresse — nom de conteneur s'il est installé ici, adresse
     s'il tourne ailleurs — et ses réglages. Les exposer au Compose évite
     un champ de formulaire par dépendance, et surtout évite qu'une valeur
     recopiée à la main se mette à diverger du service réel.

       {{provider.llm.embed.url}}
       {{provider.llm.embed.name}}
       {{provider.llm.embed.config.EMBED_MODEL}}

     Une dépendance non satisfaite ne produit aucune variable : le Compose
     échouera en nommant celle qui manque, ce qui est plus clair qu'un
     service qui démarre en pointant vers le vide. */
  const deps = {};
  const requis = m.capabilities?.requires || [], acceptes = m.capabilities?.accepts || [];
  for (const cap of [...requis, ...acceptes]) {
    const p = fournisseur(cap);
    if (!p) {
      // Une capacité seulement ACCEPTÉE peut manquer : ses variables valent
      // alors une chaîne vide, et le service sait s'en passer.
      if (!requis.includes(cap)) deps[`provider.${cap}.*`] = '';
      continue;
    }
    deps[`provider.${cap}.url`] = p.url;
    deps[`provider.${cap}.hostUrl`] = p.hostUrl || p.url;
    deps[`provider.${cap}.jetonCerveau`] = p.jetonCerveau?.(inst.name) || '';
    deps[`provider.${cap}.name`] = p.name;
    for (const [k, v] of Object.entries(p.config || {})) deps[`provider.${cap}.config.${k}`] = v;
  }

  /* Un réglage déclaré mais jamais rempli — une clé d'API facultative, un
     champ ajouté par une nouvelle version — vaut son défaut, ou rien. Sans
     cela, le Compose échouait sur « variable inconnue » pour un champ que
     le manifeste déclare pourtant. */
  const declares = Object.fromEntries((m.config || []).map(f => [f.key,
    f.default !== undefined && !(typeof f.default === 'string' && f.default.includes('{{')) ? f.default : '']));
  return {
    ...deps,
    ...Object.fromEntries(Object.entries({ ...declares, ...(cfg || {}) }).map(([k, v]) => ['config.' + k, v ?? ''])),
    // L'adresse qu'un humain ouvre : c'est elle qu'une IA donne pour « continuer là-bas ».
    'service.host': containerName(inst), 'service.url': inst.url, 'service.name': inst.name, 'service.ui': ui,
    'hub.network': config.dockerNetwork,
    // Le fuseau que le navigateur a donné au Hub : l'heure d'un service est celle de sa montre.
    'hub.tz': fuseau() || 'UTC',
    // La gamme de l'interface choisie dans le Hub (page Thème), rendue dans ce
    // que comprend le socle qui la lit (voir theme.js).
    'hub.theme': gammeRecue(gamme, 'premieres'),
    'hub.gamme': gammeRecue(gamme, 'exploitation'),
    'hub.apparence': gamme,
    ...Object.fromEntries(ports.map(p => ['port.' + p.name, p.container])),
    ...Object.fromEntries(ports.map((p, i) => ['hostport.' + p.name,
      `${adresseEcoute(exposition, p)}:${portHote(inst.stack, i)}`])),
    ...Object.fromEntries((m.install.volumes || []).map(v => ['volume.' + v.name, `hub-${inst.name}-${v.name}`])),
  };
}

/* Les listes de mots et les voix finissent dans un Compose : on n'y laisse
   passer que ce qui ne peut pas y ouvrir une clé YAML ou un commentaire. */
const MOT_OK = /^[\p{L}\p{N}][\p{L}\p{N} ._'’-]{0,39}$/u;
/**
 * Les réglages qu'un manifeste dit obligatoires, ou d'une forme donnée
 * (pattern), contrôlés avant de rien déployer : un champ requis laissé vide
 * finissait en Compose cassé, découvert au démarrage. `cles` : ne contrôler
 * que ces clés (une modification ne bloque pas sur un champ ancien qu'elle ne touche pas).
 */
export function verifierReglages(m, cfg, cles = null) {
  const visible = f => !f.showIf || Object.entries(f.showIf).every(([k, ok]) => ok.map(String).includes(String(cfg[k] ?? '')));
  for (const f of m.config || []) {
    if (cles && !cles.includes(f.key)) continue;
    if (!visible(f)) continue;
    const v = cfg[f.key];
    const vide = v === undefined || v === null || v === '';
    if (f.required && vide) throw new HttpError(400, `${f.label} : obligatoire.`);
    if (f.pattern && !vide && typeof v === 'string' && !new RegExp(f.pattern).test(v)) throw new HttpError(400, `${f.label} : format invalide${f.help ? ` — ${f.help}` : '.'}`);
  }
}

/* Une erreur de démarrage que Docker dit en anglais technique : celle qui
   revient, un port d'hôte déjà pris, dite en clair. */
// Deux formes selon la version de Docker : « failed to bind host port …: address
// already in use » (un programme de la machine) et « Bind for …:8100 failed:
// port is already allocated » (un autre conteneur).
const PORT_PRIS = /(?:failed to bind host port (?:for )?([0-9a-f.:[\]]*):(\d+)\/(?:tcp|udp)?:? ?address already in use|Bind for ([0-9a-f.:[\]]*):(\d+) failed: port is already allocated)/i;
/** Le port d'hôte que Docker n'a pas pu prendre, ou null. */
export const portPrisDe = message => { const m = PORT_PRIS.exec(String(message)); return m ? Number(m[2] || m[4]) : null; };
export function erreurDemarrage(message) {
  const r = PORT_PRIS.exec(String(message));
  if (!r) return null;
  const m = [r[0], r[1] ?? r[3], r[2] ?? r[4]];
  const ip = m[1] && m[1] !== '0.0.0.0' ? ` sur ${m[1]}` : '';
  return `Le port ${m[2]}${ip} de la machine est déjà pris par un autre programme${m[2] === '53' ? ' (souvent le résolveur DNS du système)' : ''} : libère-le, ou change l’adresse ou le port dans les réglages du service.`;
}

export function normaliserChamp(f, v) {
  if (!f || v === undefined || v === null) return v;
  if (f.type === 'tags') {
    const vus = new Set(), out = [];
    for (const brut of (Array.isArray(v) ? v : String(v).split(','))) {
      const mot = String(brut).trim().replace(/\s+/g, ' ');
      if (!MOT_OK.test(mot) || vus.has(mot.toLowerCase())) continue;
      vus.add(mot.toLowerCase()); out.push(mot);
      if (out.length >= 80) break;
    }
    return out.join(',');
  }
  if (f.type === 'voice') {
    const t = String(v).trim();
    if (t && !/^[\w-]{1,20}:[\w.-]{1,80}$|^[\w.-]{1,80}$/.test(t)) throw new HttpError(400, `${f.label} : voix invalide.`);
    return t;
  }
  return v;
}

export function renderCompose(tpl, vars) {
  // Un nom de variable commence par une lettre. Sans cette contrainte, le
  // « {{...}} » d'une ligne de commentaire — la façon la plus naturelle
  // d'écrire « ici, un marqueur » — était pris pour une variable et faisait
  // échouer l'installation sur un nom que personne n'avait écrit.
  return tpl.replace(/\{\{\s*([A-Za-z][\w.-]*)\s*\}\}/g, (all, k) => {
    if (!(k in vars)) {
      // Une capacité acceptée mais absente : toutes ses variables sont vides.
      const joker = Object.keys(vars).find(x => x.endsWith('.*') && k.startsWith(x.slice(0, -1)));
      if (joker) return '';
      // Dire d'où viennent ces variables, pas seulement que celle-ci manque :
      // neuf fois sur dix c'est une déclaration oubliée dans le manifeste, et
      // le nom seul ne le laisse pas deviner.
      const [famille] = k.split('.');
      const ou = { hostport: 'install.ports', port: 'install.ports', volume: 'install.volumes', config: 'config' }[famille];
      const connues = Object.keys(vars).filter(x => x.startsWith(famille + '.')).map(x => x.slice(famille.length + 1));
      throw new HttpError(400, `Variable inconnue dans le Compose : ${k}`
        + (ou ? ` — le manifeste doit la déclarer dans « ${ou} »${connues.length ? `. Déclaré pour l'instant : ${connues.join(', ')}` : ', qui est vide'}.` : ''));
    }
    const v = String(vars[k]);
    return /[\n\r]/.test(v) ? JSON.stringify(v) : v;
  });
}

export function checkCompose(rendered, m) {
  const p = m.permissions || {};
  if (/privileged:\s*true/.test(rendered)) throw new HttpError(400, 'Compose refusé : privileged n’est jamais accordé.');
  if (/\/var\/run\/docker\.sock/.test(rendered)) throw new HttpError(400, 'Compose refusé : le socket Docker ne doit pas être monté. Utilise permissions.dockerSocket = proxy.');
  if (/network_mode:\s*["']?host/.test(rendered) && !p.hostNetwork) {
    throw new HttpError(400, 'Compose refusé : network_mode host n’est pas déclaré dans permissions.hostNetwork du manifeste.');
  }
  const declarees = new Set((p.capAdd || []).map(c => c.toUpperCase()));
  for (const bloc of rendered.match(/cap_add:[\s\S]*?(?=\n\s{0,4}[a-z_]+:|$)/g) || []) {
    for (const cap of bloc.match(/-\s*([A-Z_]+)/g) || []) {
      const nom = cap.replace(/-\s*/, '').toUpperCase();
      if (CAPS_INTERDITES.has(nom)) throw new HttpError(400, `Compose refusé : la capacité ${nom} n’est jamais accordée.`);
      if (!declarees.has(nom)) throw new HttpError(400, `Compose refusé : la capacité ${nom} n’est pas déclarée dans permissions.capAdd du manifeste.`);
    }
  }
  return true;
}

export class Services {
  constructor({ db, vault, audit, bus, registry }) {
    Object.assign(this, { db, vault, audit, bus, registry });
    this.stacksDir = path.join(config.dataDir, 'stacks');
    this.cache = new Map();
    // Les services en cours de redéploiement (demandes en cours ou en
    // attente) : déjà installés, ils restent fournisseurs de leurs capacités
    // pendant qu'on relance leur pile. Les redéploiements d'un même service
    // passent l'un après l'autre : jamais deux « compose up » sur une pile.
    this.redeploiements = new Map();
    this.filesRedeploiement = new Map();
  }
  attach({ runtime, capabilities, connexions = null }) { this.runtime = runtime; this.capabilities = capabilities; this.connexions = connexions; }

  row(r) {
    if (!r) return null;
    return { ...r, manifest: JSON.parse(r.manifest), config: JSON.parse(r.config), providers: JSON.parse(r.providers) };
  }
  list() { return this.db.all('SELECT * FROM instances ORDER BY created').map(r => this.row(r)); }
  get(idOrName) {
    const r = this.row(this.db.get('SELECT * FROM instances WHERE id=? OR name=?', idOrName, idOrName));
    if (!r) throw new HttpError(404, `Service introuvable : ${idOrName}`);
    return r;
  }
  configOf(inst) { return this.vault.openFields(inst.config, secretKeysOf(inst.manifest)); }

  /**
   * Les réglages qu'un service n'a pas à demander, parce qu'un autre les
   * connaît déjà.
   *
   * Un service qui `requires` une capacité doit parler lui-même au
   * fournisseur : il lui faut son adresse, parfois ses modèles. Les faire
   * recopier à la main, c'est demander à l'utilisateur ce que le Hub sait
   * — et ouvrir la porte aux fautes de frappe qu'on ne voit qu'à
   * l'exécution.
   *
   * Un champ non résolu n'est pas une erreur : le fournisseur n'est
   * peut-être pas encore installé. Il reste alors à saisir, comme avant.
   */
  /**
   * Le mode d'exposition de ce service : le sien s'il en a un, sinon celui
   * du Hub. Un réglage global avec dérogation par service — parce qu'on
   * veut presque toujours la même chose partout, et presque jamais tout
   * à fait.
   */
  expositionDe(inst) {
    const par = this.db.setting('exposition_par_service', {});
    const m = par[inst?.id] || this.db.setting('exposition', 'loopback');
    return EXPOSITIONS.includes(m) ? m : 'loopback';
  }

  /** Le service en ligne qui fournit cette capacité, avec ses réglages ouverts.
      llm.chat : l'IA du Hub (toutes ses IA) dès qu'il en a une — pour le service `pour`. */
  fournisseurPour(capacite, pour = null) {
    if (capacite === 'llm.chat' && pour && this.iaServices) { const h = this.iaServices.fournisseur(pour); if (h) return h; }
    const tous = this.list().filter(i => (i.manifest.capabilities?.provides || []).includes(capacite));
    const p = tous.find(i => i.status === 'online') || tous[0];
    if (!p) return null;
    const config = this.configOf(p);
    const secret = config[p.manifest.api?.auth?.localToken];
    return { url: p.url, hostUrl: adresseHote(p), name: p.name, id: p.id, config, jetonCerveau: nom => jetonCerveau(secret, nom) };
  }

  resoudreConfig(manifest) {
    const out = {};
    for (const f of manifest.config || []) {
      const r = f.resolve;
      if (!r?.capability) continue;
      const p = this.fournisseurPour(r.capability);
      if (!p) continue;
      const ctx = { provider: p };
      let v;
      try { v = render(r.value ?? '{{provider.url}}', ctx); } catch { continue; }
      if (v === undefined || v === null || v === '') continue;
      out[f.key] = { valeur: v, service: p.name };
    }
    return out;
  }

  // Vue publique : secrets remplacés par un indicateur.
  publicView(inst) {
    const sk = new Set(secretKeysOf(inst.manifest));
    const cfg = Object.fromEntries(Object.entries(inst.config).map(([k, v]) => [k, sk.has(k) ? (v ? '••• défini' : '') : v]));
    const { manifest: m } = inst;
    return { id: inst.id, extId: inst.ext_id, name: inst.name, mode: inst.mode, url: inst.url, status: inst.status, statusDetail: inst.status_detail, version: inst.version, miseAJour: this.versionDisponible(inst) || (this.imagesNeuves?.has(inst.id) ? inst.version : null), remplacePar: this.remplacePar(inst), imageNeuve: !this.versionDisponible(inst) && !!this.imagesNeuves?.has(inst.id), created: inst.created, providers: inst.providers, config: cfg, open: openAddresses(inst, { exposition: this.expositionDe(inst), machine: this.db.setting('adresse_machine', ''), publiee: this.connexions?.publications()[inst.id] || '' }), exposition: inst.mode === 'remote' ? null : this.expositionDe(inst),
      ext: { name: m.name, icon: m.icon, description: m.description, capabilities: m.capabilities, counts: { triggers: m.triggers.length, actions: m.actions.length, probes: m.probes.length } } };
  }

  progress(instId, step, state = 'ok', extra = {}) {
    this.bus.emit('install', { instanceId: instId, step, state, ...extra, ts: Date.now() });
  }

  buildConfig(m, given = {}) {
    const out = {};
    for (const f of m.config || []) {
      let v = normaliserChamp(f, given[f.key]);
      if ((v === undefined || v === '') && f.type === 'secret' && f.generate) v = generateSecret(f.generate);
      if ((v === undefined || v === '') && f.default !== undefined && !(typeof f.default === 'string' && f.default.includes('{{'))) v = f.default;
      if (v !== undefined) out[f.key] = v;
    }
    return out;
  }

  checkName(name) {
    if (!NAME_RE.test(name || '')) throw new HttpError(400, 'Nom : 2 à 31 caractères, minuscules, chiffres et tirets.');
    if (this.db.get('SELECT 1 FROM instances WHERE name=?', name)) throw new HttpError(409, `Le nom ${name} est déjà utilisé.`);
  }

  // mode = 'compose' (installé ici) ou 'remote' (déjà en service ailleurs)
  async add(extId, { name, mode, url, config: given = {}, acceptPermissions = false }, actor) {
    const entry = this.registry.get(extId);
    const m = entry.manifest;
    name = (name || m.id).toLowerCase();
    this.checkName(name);
    const perms = sensitivePermissions(m);
    if (perms.length && mode !== 'remote' && m.install.type !== 'external' && !acceptPermissions) {
      throw new HttpError(409, `${m.name} demande des permissions à valider : ${perms.map(p => p.label).join(', ')}.`, { permissions: perms });
    }
    if (m.install.type === 'external') mode = 'remote';
    mode = mode === 'remote' ? 'remote' : 'compose';
    if (mode === 'remote') {
      if (!m.install.remote?.supported) throw new HttpError(400, `${m.name} ne peut pas être connecté à distance.`);
      try { const u = new URL(url); if (!/^https?:$/.test(u.protocol)) throw 0; } catch { throw new HttpError(400, 'Adresse invalide. Exemple : ' + (m.install.remote.placeholder || 'http://192.0.2.50:8080')); }
    }
    // Ce qu'un service déjà installé sait déjà : on le pose ici plutôt que
    // de compter sur le formulaire. Une installation lancée par l'API ou par
    // l'assistant n'a pas de formulaire, et devrait pourtant arriver
    // configurée de la même façon. La valeur fournie l'emporte, sauf si
    // c'est le simple défaut du manifeste — celui-là n'a été choisi par
    // personne.
    const resolus = this.resoudreConfig(m);
    for (const [cle, r] of Object.entries(resolus)) {
      const def = (m.config || []).find(f => f.key === cle)?.default;
      const v = given[cle];
      if (v === undefined || v === '' || (def !== undefined && v === def)) given[cle] = r.valeur;
    }

    // capacités requises
    const missing = (m.capabilities.requires || []).filter(c => !this.providersOf(c).length);
    if (missing.length) throw new HttpError(409, `Il manque ${missing.join(', ')}. Ajoute d’abord un service qui le fournit.`, { missing, candidates: this.registry.list().filter(e => e.manifest.capabilities.provides?.some(p => missing.includes(p))).map(e => e.id) });

    const cfg = this.buildConfig(m, given);
    if (mode === 'compose') verifierReglages(m, cfg);
    const instId = id('i_');
    const epinglee = imageEpinglee(m, cfg) ? 1 : 0;
    const stack = mode === 'compose' ? this.nextStack() : null;
    const finalUrl = mode === 'remote' ? url.replace(/\/$/, '') : adresseInterne(name, m);
    this.db.run('INSERT INTO instances(id,ext_id,name,mode,url,stack,config,manifest,version,status,created,image_epinglee) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      instId, m.id, name, mode, finalUrl, stack, JSON.stringify(this.vault.sealFields(cfg, secretKeysOf(m))), JSON.stringify(m), m.version, 'installing', Date.now(), epinglee);
    const inst = this.get(instId);
    this.audit.write(actor, mode === 'remote' ? 'service.connexion' : 'service.installation', name, { extension: m.id, url: mode === 'remote' ? finalUrl : undefined });
    try {
      if (mode === 'compose') await this.deployerNeuf(inst, entry);
      this.progress(instId, 'Test de santé', 'run');
      await this.waitHealthy(inst, mode === 'compose' ? 120000 : 10000);
      this.progress(instId, 'Service en ligne');
      if (mode === 'compose') for (const req of m.install.postInstall || []) {
        this.progress(instId, `Initialisation ${req.method} ${req.path}`, 'run');
        await this.runtime.request(inst, req, { timeout: 30000, retries: 2 });
      }
      this.setStatus(instId, 'online');
      await this.apresDeploiement(this.get(instId), actor);
      const links = this.capabilities.onAdded(this.get(instId), actor);
      for (const w of links) this.progress(instId, `Workflow créé : ${w.name}`, 'link');
      for (const n of this.relierDependants(this.get(instId), actor)) this.progress(instId, `${n} est redéployé pour l’utiliser`, 'link');
      this.progress(instId, 'Terminé', 'done');
      return this.get(instId);
    } catch (e) {
      this.progress(instId, e.message, 'error');
      this.audit.write(actor, 'service.échec', name, { erreur: e.message });
      if (mode === 'compose') { try { await this.undeploy(inst, false); } catch { /* rien */ } }
      this.db.run('DELETE FROM instances WHERE id=?', instId);
      throw e.status ? e : new HttpError(502, e.message);
    }
  }

  // Le manifeste est figé à l'installation : c'est lui qui décrit le contrat
  // en vigueur. Quand le catalogue en propose un nouveau, on le reprend sur
  // demande — et sans rien casser, puisque l'instance garde son mode, son
  // adresse et sa configuration.
  syncManifest(idOrName, actor) {
    const inst = this.get(idOrName);
    const entry = this.registry.get(inst.ext_id);
    const m = entry.manifest;
    const avant = { triggers: inst.manifest.triggers.length, actions: inst.manifest.actions.length, probes: inst.manifest.probes.length, comptes: !!inst.manifest.accounts };

    // Une version qui ajoute une clé — le jeton des comptes, par exemple — la
    // laisserait vide : le manifeste serait à jour et la fonctionnalité
    // toujours muette. Les clés nouvelles que le Hub sait fabriquer lui-même
    // sont donc semées ici. Celles qui existent déjà ne sont jamais touchées.
    const neuf = {};
    for (const f of m.config || []) {
      if (inst.config[f.key] !== undefined && inst.config[f.key] !== '') continue;
      if (f.type === 'secret' && f.generate) neuf[f.key] = generateSecret(f.generate);
      else if (f.default !== undefined && !(typeof f.default === 'string' && f.default.includes('{{'))) neuf[f.key] = f.default;
    }
    // La version de l'image suit celle du catalogue, sauf si quelqu'un l'a
    // choisie à la main : sans cela, l'instance garderait pour toujours
    // l'étiquette de son installation, et « mettre à jour » relancerait
    // l'ancienne image. Jamais vers le bas.
    let image = null;
    const champ = (m.config || []).find(f => f.key === CLE_IMAGE);
    const cible = champ?.default;
    const actuelle = inst.config[CLE_IMAGE];
    if (champ && !inst.image_epinglee && etiquetteFixe(cible) && actuelle !== cible && actuelle !== undefined && actuelle !== ''
      && (!etiquetteFixe(actuelle) || compareVersions(versionDe(actuelle), versionDe(cible)) < 0)) {
      neuf[CLE_IMAGE] = cible;
      image = { de: actuelle, vers: cible };
    }
    const nouvelles = Object.keys(neuf);
    if (nouvelles.length) {
      // Le coffre scelle les clés secrètes du NOUVEAU manifeste : c'est lui qui
      // dit lesquelles en sont, et les anciennes valeurs restent telles quelles.
      const cfg = { ...inst.config, ...this.vault.sealFields(neuf, secretKeysOf(m)) };
      this.db.run('UPDATE instances SET config=? WHERE id=?', JSON.stringify(cfg), inst.id);
    }

    this.db.run('UPDATE instances SET manifest=?, version=? WHERE id=?', JSON.stringify(m), m.version, inst.id);
    // Installé ici, l'adresse suit le port HTTP du manifeste : une version qui
    // en change ne doit pas laisser le Hub frapper à l'ancien.
    if (inst.mode === 'compose') this.db.run('UPDATE instances SET url=? WHERE id=?', adresseInterne(inst.name, m), inst.id);

    // Une version qui déclare une capacité de plus doit pouvoir être reliée :
    // on rejoue l'appariement, qui ne refait rien de ce qui existe déjà.
    const liens = this.capabilities.onAdded(this.get(inst.id), actor, { annonce: false });

    const après = { triggers: m.triggers.length, actions: m.actions.length, probes: m.probes.length, comptes: !!m.accounts, workflows: liens.length };
    this.audit.write(actor, 'service.manifeste_actualisé', inst.name, { de: inst.version, vers: m.version, avant, après, clés: nouvelles, image });
    this.bus.emit('instance', { id: inst.id, status: inst.status });
    return { ...this.publicView(this.get(inst.id)), avant, après, liens: liens.map(w => w.name), image };
  }

  // Reprendre le manifeste ne suffit pas quand la nouvelle version change le
  // fichier Compose ou ajoute une variable d'environnement : les conteneurs qui
  // tournent gardent ceux d'avant. On re-rend le Compose et on relance la pile.
  // Les volumes ne sont pas touchés — les données restent.
  async redeploy(idOrName, actor, options = {}) {
    const inst = this.get(idOrName);
    if (inst.mode !== 'compose') throw new HttpError(400, `${inst.name} n'est pas installé ici : il n'y a rien à redéployer.`);
    const id = inst.id;
    this.redeploiements.set(id, (this.redeploiements.get(id) || 0) + 1);
    const avant = this.filesRedeploiement.get(id) || Promise.resolve();
    const tour = avant.catch(() => {}).then(() => this.redeployerMaintenant(id, actor, options));
    this.filesRedeploiement.set(id, tour);
    try { return await tour; } finally {
      const n = (this.redeploiements.get(id) || 1) - 1;
      if (n > 0) this.redeploiements.set(id, n); else this.redeploiements.delete(id);
      if (this.filesRedeploiement.get(id) === tour) this.filesRedeploiement.delete(id);
    }
  }

  async redeployerMaintenant(id, actor, { tirer = false } = {}) {
    let inst = this.get(id);
    const repris = this.syncManifest(inst.id, actor);
    inst = this.get(inst.id);
    const entry = this.registry.get(inst.ext_id);
    this.setStatus(inst.id, 'installing');
    if (repris.image) this.progress(inst.id, `Version de l'image : ${repris.image.de} → ${repris.image.vers}`);
    this.audit.write(actor, tirer ? 'service.mise_à_jour' : 'service.redéploiement', inst.name, { version: inst.version });
    try {
      await this.deploy(inst, entry, { tirer });
      this.imagesNeuves?.delete(inst.id);
      this.progress(inst.id, 'Test de santé', 'run');
      await this.waitHealthy(inst, 120000);
      this.setStatus(inst.id, 'online');
      await this.apresDeploiement(this.get(inst.id), actor);
      this.progress(inst.id, 'Terminé', 'done');
      return this.publicView(this.get(inst.id));
    } catch (e) {
      this.progress(inst.id, e.message, 'error');
      this.setStatus(inst.id, 'error', e.message);
      this.audit.write(actor, 'service.échec', inst.name, { erreur: e.message });
      throw e.status ? e : new HttpError(502, e.message);
    }
  }

  /** Efface un secret des réglages (updateConfig garde un secret vide tel quel, pour les formulaires). */
  effacerSecret(idOrName, cle, actor) {
    const inst = this.get(idOrName);
    if (!secretKeysOf(inst.manifest).includes(cle)) throw new HttpError(400, `${cle} n’est pas un secret de ${inst.name}.`);
    const cur = this.configOf(inst);
    if (!(cle in cur)) return;
    delete cur[cle];
    this.db.run('UPDATE instances SET config=? WHERE id=?', JSON.stringify(this.vault.sealFields(cur, secretKeysOf(inst.manifest))), inst.id);
    this.audit.write(actor, 'service.secret_effacé', inst.name, { clé: cle });
  }

  /**
   * Mettre à jour vers la version du catalogue : installé ici, on reprend le
   * manifeste, on retélécharge les images et on relance la pile ; distant, seul
   * le manifeste change (le service se met à jour sur sa machine).
   */
  async update(idOrName, actor) {
    const inst = this.get(idOrName);
    const remplacant = this.registry?.remplacantDe?.(inst.ext_id);
    if (remplacant) return this.remplacer(inst, remplacant, actor);
    // Seule l'image locale est plus récente : on la démarre, sans retélécharger
    // l'étiquette depuis le registre (qui la remplacerait par l'ancienne).
    if (inst.mode === 'compose') return this.redeploy(inst.id, actor, { tirer: !(this.imagesNeuves?.has(inst.id) && !this.versionDisponible(inst)) });
    return this.syncManifest(inst.id, actor);
  }

  /**
   * Les services dont une image a été reconstruite sur la machine (dépôt
   * privé, « docker build » à la main) et n'a pas encore remplacé celle qui
   * tourne. Même numéro de version : le catalogue ne peut pas le voir, le
   * démon Docker si. Vérifié toutes les cinq minutes, et après chaque
   * changement de service.
   */
  async verifierImagesLocales() {
    const neuves = new Set();
    for (const inst of this.list().filter(i => i.mode === 'compose')) {
      try {
        for (const [ref, enCours] of await docker.imagesEnService(`hub-${inst.name}`)) {
          if (ref.includes('@')) continue;
          const locale = await docker.imageId(ref);
          if (locale && locale !== enCours) { neuves.add(inst.id); break; }
        }
      } catch { /* Docker muet : on garde ce qu'on savait */ }
    }
    this.imagesNeuves = neuves;
    return neuves;
  }

  /** La version proposée par le catalogue, si elle est plus récente que celle en place. */
  versionDisponible(inst) {
    const remplacant = this.registry?.remplacantDe?.(inst.ext_id);
    if (remplacant) return remplacant.manifest.version;
    let entry;
    try { entry = this.registry.get(inst.ext_id); } catch { return null; }
    const v = entry?.manifest?.version;
    return v && compareVersions(v, inst.version) > 0 ? v : null;
  }

  /** L'extension qui remplace celle de ce service (renommage) : { id, name, version }, ou null. */
  remplacePar(inst) {
    const r = this.registry?.remplacantDe?.(inst.ext_id);
    return r ? { id: r.id, name: r.manifest.name, version: r.manifest.version } : null;
  }

  /**
   * Passer un service à l'extension qui remplace la sienne (renommage) : même
   * service, mêmes réglages, mêmes données et mêmes noms publiés, sous le nom
   * de la nouvelle extension quand il portait celui de l'ancienne. Installé
   * ici sous un nouveau nom : la pile est arrêtée, chaque volume copié sous
   * son nouveau nom (l'ancien reste intact), les routes de Relay suivent, puis
   * la nouvelle pile démarre ; au moindre échec, tout revient comme avant.
   */
  async remplacer(inst, entry, actor) {
    const m = entry.manifest;
    const avant = inst.manifest;
    const enPlus = sensitivePermissions(m).map(p => p.label).filter(l => !sensitivePermissions(avant).some(p => p.label === l));
    if (enPlus.length) throw new HttpError(409, `${m.name} demande des permissions que ${avant.name} n’avait pas : ${enPlus.join(', ')}. Installe-le à part pour les valider.`);
    const ancienNom = inst.name;
    const nom = ancienNom === inst.ext_id && !this.db.get('SELECT 1 FROM instances WHERE name=? AND id<>?', m.id, inst.id) ? m.id : ancienNom;
    const renomme = nom !== ancienNom && inst.mode === 'compose';

    // Les réglages renommés par la nouvelle extension gardent leur valeur ;
    // le coffre scelle ce que le NOUVEAU manifeste dit secret.
    const cfg = this.configOf(inst);
    const cles = new Set((m.config || []).map(f => f.key));
    for (const [de, vers] of Object.entries(m.replaces.find(r => r.id === inst.ext_id)?.config || {})) {
      if (!(de in cfg) || !cles.has(vers) || (cfg[vers] !== undefined && cfg[vers] !== '')) continue;
      cfg[vers] = cfg[de];
      delete cfg[de];
    }
    const ligne = this.db.get('SELECT * FROM instances WHERE id=?', inst.id);
    const ecrire = () => this.db.run('UPDATE instances SET ext_id=?, name=?, manifest=?, config=?, url=? WHERE id=?', m.id, nom, JSON.stringify(m),
      JSON.stringify(this.vault.sealFields(cfg, secretKeysOf(m))), inst.mode === 'compose' ? adresseInterne(nom, m) : inst.url, inst.id);
    const trace = { de: `${inst.ext_id} ${inst.version}`, vers: `${m.id} ${m.version}`, ...(nom !== ancienNom ? { nom } : {}) };
    const annonce = `${avant.name} ${inst.version} → ${m.name} ${m.version}${nom !== ancienNom ? ` : ${ancienNom} devient ${nom}` : ''}`;

    // Distant, ou installé ici sous le même nom : une mise à jour ordinaire,
    // sous la nouvelle extension.
    if (!renomme) {
      ecrire();
      this.audit.write(actor, 'service.remplacé', ancienNom, trace);
      this.progress(inst.id, annonce);
      return inst.mode === 'compose' ? this.redeploy(inst.id, actor, { tirer: true }) : this.syncManifest(inst.id, actor);
    }

    // Tout ce qui peut empêcher le changement est vérifié avant de rien arrêter.
    const communs = (m.install.volumes || []).map(v => v.name).filter(v => (avant.install.volumes || []).some(x => x.name === v));
    const paires = communs.map(v => [`hub-${ancienNom}-${v}`, `hub-${nom}-${v}`]);
    for (const [, vers] of paires) {
      if (await docker.volumeExiste(vers)) throw new HttpError(409, `Le volume ${vers} existe déjà (une installation précédente ?) : retire-le (docker volume rm ${vers}) puis relance la mise à jour.`);
    }
    const routes = this.connexions ? await this.connexions.routesDe(ancienNom) : [];
    const image = await this.imageAuxiliaire(inst);
    const fichierAncien = this.stackFile(inst);

    this.audit.write(actor, 'service.remplacement', ancienNom, trace);
    this.setStatus(inst.id, 'installing');
    this.progress(inst.id, annonce);
    const copies = [];
    let deplacees = [];
    try {
      this.progress(inst.id, `Arrêt de ${ancienNom} (ses volumes restent)`, 'run');
      await docker.down(`hub-${ancienNom}`, fichierAncien);
      for (const [de, vers] of paires) {
        if (!(await docker.volumeExiste(de))) { this.progress(inst.id, `Pas de volume ${de} : rien à copier`); continue; }
        this.progress(inst.id, `Copie du volume ${de} → ${vers}`, 'run');
        copies.push(vers);
        await docker.copierVolume(de, vers, image);
      }
      ecrire();
      if (routes.length) {
        deplacees = await this.connexions.renommerRoutes(inst.id, ancienNom, nom, routes, actor);
        for (const r of deplacees) this.progress(inst.id, `Route ${r.de} → ${r.vers}`, 'link');
      }
      await this.redeploy(inst.id, actor, { tirer: true });
    } catch (e) {
      this.progress(inst.id, `${e.message} — retour à ${avant.name} ${inst.version}`, 'warn');
      await this.defaireRemplacement({ inst, ligne, ancienNom, nom, fichierAncien, copies, deplacees });
      this.audit.write(actor, 'service.remplacement_annulé', ancienNom, { ...trace, erreur: e.message });
      throw e.status ? e : new HttpError(502, e.message);
    }
    fs.rmSync(path.dirname(fichierAncien), { recursive: true, force: true });
    this.audit.write(actor, 'service.remplacé', nom, { ...trace, volumesGardés: paires.map(([de]) => de) });
    for (const [de] of paires) this.progress(inst.id, `Ancien volume gardé : ${de}. Quand ${m.name} te convient : docker volume rm ${de}`);
    return this.publicView(this.get(inst.id));
  }

  /* Un remplacement qui échoue : la nouvelle pile et ses copies partent, la
     ligne, les routes et l'ancienne pile reviennent. Chaque pas est tenté
     même si le précédent échoue ; ce qui n'a pas pu revenir est dit. */
  async defaireRemplacement({ inst, ligne, ancienNom, nom, fichierAncien, copies, deplacees }) {
    const rate = [];
    const essai = async (quoi, f) => { try { await f(); } catch (e) { rate.push(`${quoi} : ${e.message}`); } };
    const fichierNeuf = this.stackFile({ name: nom });
    if (fs.existsSync(fichierNeuf)) {
      await essai(`arrêt de ${nom}`, () => docker.down(`hub-${nom}`, fichierNeuf));
      fs.rmSync(path.dirname(fichierNeuf), { recursive: true, force: true });
    }
    for (const v of copies) await essai(`volume ${v}`, () => docker.supprimerVolume(v));
    this.db.run('UPDATE instances SET ext_id=?, name=?, manifest=?, config=?, url=?, version=?, stack=? WHERE id=?',
      ligne.ext_id, ligne.name, ligne.manifest, ligne.config, ligne.url, ligne.version, ligne.stack, inst.id);
    if (deplacees.length) await essai('routes', () => this.connexions.annulerRenommage(inst.id, ancienNom, nom, deplacees));
    await essai(`redémarrage de ${ancienNom}`, () => docker.up(`hub-${ancienNom}`, fichierAncien));
    try { await this.waitHealthy(this.get(inst.id), 120000); this.setStatus(inst.id, 'online'); }
    catch (e) { rate.push(e.message); this.setStatus(inst.id, 'error', e.message); }
    this.progress(inst.id, rate.length ? `Retour incomplet — ${rate.join(' ; ')}` : `${ancienNom} est revenu tel qu’avant`, rate.length ? 'error' : 'ok');
  }

  /** Une image déjà sur la machine pour copier un volume : celle du Hub, sinon une de la pile qui tourne. */
  async imageAuxiliaire(inst) {
    try { const id = await docker.imageDuConteneur(os.hostname()); if (id) return id; } catch { /* le Hub ne tourne pas dans un conteneur */ }
    const [ref] = (await docker.imagesEnService(`hub-${inst.name}`)).keys();
    if (ref) return ref;
    throw new HttpError(503, `Aucune image sur la machine pour copier les volumes de ${inst.name}.`);
  }

  /**
   * Un service vient d'arriver (ou de partir) : ceux qui ACCEPTENT ce qu'il
   * fournit sont redéployés, pour recevoir son adresse — MapMyLAN apprend
   * ainsi que VOX existe, sans qu'on le lui dise. En tâche de fond : l'échec
   * d'un voisin ne défait pas l'installation qui vient de réussir.
   */
  relierDependants(fournisseur, actor) {
    const caps = new Set(fournisseur.manifest.capabilities?.provides || []);
    const cibles = this.list().filter(i => i.id !== fournisseur.id && i.mode === 'compose' && i.status === 'online'
      && [...(i.manifest.capabilities?.accepts || []), ...(i.manifest.capabilities?.requires || [])].some(c => caps.has(c)));
    (async () => {
      for (const i of cibles) {
        try {
          this.audit.write(actor, 'service.relié', i.name, { à: fournisseur.name });
          await this.redeploy(i.id, actor);
        } catch (e) { log.warn('services', `${i.name} : redéploiement après ${fournisseur.name} impossible — ${e.message}`); }
      }
    })();
    return cibles.map(i => i.name);
  }

  /** Les services installés ici dont la pile lit la gamme (SOCLE_THEME). */
  suiventLaGamme() {
    return this.list().filter(i => {
      if (i.mode !== 'compose') return false;
      try { return pileSuitLaGamme(fs.readFileSync(this.stackFile(i), 'utf8')); } catch { return false; }
    });
  }

  /** Les services dont le Compose lit {{hub.gamme}}, relevés au déploiement. */
  lisentToutesLesGammes() { return new Set(this.db.setting('services_toutes_gammes', [])); }
  /** Les services dont le Compose lit {{hub.apparence}} (toutes les gammes), relevés au déploiement. */
  lisentLApparence() { return new Set(this.db.setting('services_apparence', [])); }
  /** Ce que comprend le socle d'un service : « toutes », « exploitation » ou « premieres ». */
  niveauGamme(id, apparence = this.lisentLApparence(), toutes = this.lisentToutesLesGammes()) {
    return apparence.has(id) ? 'toutes' : toutes.has(id) ? 'exploitation' : 'premieres';
  }

  /** La gamme que reçoit chaque service qui la lit, par identifiant. */
  gammesDesServices() {
    const reglage = reglageTheme(this.db), apparence = this.lisentLApparence(), toutes = this.lisentToutesLesGammes();
    return Object.fromEntries(this.suiventLaGamme().map(i => [i.id, gammeRecue(gammePour(reglage, i.id), this.niveauGamme(i.id, apparence, toutes))]));
  }

  /**
   * Le réglage du thème vient de changer : chaque service qui la lit et dont
   * la gamme a bougé (`avant`, rendu par gammesDesServices) est redéployé, en
   * tâche de fond, pour la recevoir. L'échec de l'un n'arrête pas les autres
   * et se lit dans son journal.
   */
  appliquerGamme(actor, avant = {}) {
    const apres = this.gammesDesServices();
    const cibles = this.suiventLaGamme().filter(i => avant[i.id] !== apres[i.id]);
    (async () => {
      for (const i of cibles) {
        try { await this.redeploy(i.id, actor); }
        catch (e) { log.warn('services', `${i.name} : nouvelle gamme non appliquée — ${e.message}`); }
      }
    })();
    return cibles.map(i => i.name);
  }

  /* Première installation : les ports d'hôte que le Hub choisit (81x0…) peuvent
     être déjà pris sur la machine par un programme qu'il ne voit pas. Il prend
     alors le numéro de pile libre suivant, jusqu'à cinq fois ; un port fixé
     par le manifeste (53 pour un DNS) n'est jamais déplacé. */
  async deployerNeuf(inst, entry) {
    const essayes = new Set();
    const ports = pile => (inst.manifest.install.ports || []).map((_, i) => Number(portHote(pile, i)));
    // Les ports que d'autres conteneurs publient déjà sont évités d'emblée.
    let publies = new Set();
    try { publies = await docker.portsPublies(); } catch { /* Docker le dira au démarrage */ }
    while (essayes.size < 20 && ports(inst.stack).some(p => publies.has(p))) {
      essayes.add(inst.stack);
      const pile = this.nextStack(essayes);
      this.db.run('UPDATE instances SET stack=? WHERE id=?', pile, inst.id);
      inst = this.get(inst.id);
    }
    if (essayes.size) this.progress(inst.id, `Ports ${[...essayes].map(p => portHote(p, 0)).join(', ')} déjà publiés par d’autres conteneurs : le service prend le port ${portHote(inst.stack, 0)}.`);
    essayes.clear();
    for (;;) {
      try { return await this.deploy(inst, entry); }
      catch (e) {
        const pris = e.details?.portPris;
        const notres = (inst.manifest.install.ports || []).map((_, i) => Number(portHote(inst.stack, i)));
        if (!pris || !notres.includes(pris) || essayes.size >= 4) throw e;
        essayes.add(inst.stack);
        try { await docker.down(`hub-${inst.name}`, this.stackFile(inst)); } catch { /* rien n'a démarré */ }
        const pile = this.nextStack(essayes);
        this.db.run('UPDATE instances SET stack=? WHERE id=?', pile, inst.id);
        inst = this.get(inst.id);
        this.progress(inst.id, `Port ${pris} déjà pris sur la machine : le service prend le port ${portHote(pile, 0)}.`, 'warn');
      }
    }
  }

  nextStack(exclus = new Set()) {
    const used = new Set([...this.db.all('SELECT stack FROM instances WHERE stack IS NOT NULL').map(r => r.stack), ...exclus]);
    for (let s = 1; s <= 9; s++) if (!used.has(s)) return s;
    for (let s = 10; s <= 99; s++) if (!used.has(s)) return s;
    throw new HttpError(409, 'Plus de numéro de stack libre');
  }

  stackFile(inst) { return path.join(this.stacksDir, inst.name, 'compose.yml'); }

  /**
   * Une image que ni la machine ni le registre n'ont : construite depuis le
   * dépôt GitHub de l'extension, au tag de sa version. false si l'image
   * n'appartient pas à ce dépôt (rien n'est tenté) ; une erreur si la
   * construction échoue.
   */
  async construireDepuisSources(inst, entry, ref, archives = new Map()) {
    const m = entry?.manifest || inst.manifest;
    const depot = depotGithub(m, entry?.origin);
    const cible = cibleDeConstruction(ref, depot);
    if (!cible) return false;
    const tag = etiquetteDe(ref);
    const refs = referencesPour(tag, depot, m?.version);
    if (!refs.length) return false;
    const ou = `github.com/${depot.owner}/${depot.repo}`;
    let contexte = null, utilisee = null;
    for (const r of refs) {
      const cle = `${ou}@${r}`;
      if (!archives.has(cle)) {
        this.progress(inst.id, `Image absente du registre : sources de ${ou} (${r.replace(/^refs\/(tags|heads)\//, '')})`, 'run');
        let tgz;
        try { tgz = await (this.archiveGithub || archiveGithub)(depot, r); } catch (e) { throw new HttpError(502, `${ref} : ${e.message}.`); }
        archives.set(cle, tgz ? reempaqueter(tgz) : null);
      }
      if (archives.get(cle)) { contexte = archives.get(cle); utilisee = r; break; }
    }
    if (!contexte) throw new HttpError(502, `${ref} : ni le tag v${tag.replace(/^v/, '')} ni la branche ${depot.branche} de ${ou} ne correspondent à cette version.`);
    this.progress(inst.id, `Construction de ${ref}${cible.cible ? ` (étape ${cible.cible})` : ''} — quelques minutes`, 'run');
    try { await docker.construire(ref, contexte, cible.cible); }
    catch (e) { throw new HttpError(502, `Construction de ${ref} impossible : ${String(e.message).replace(/^docker build[^:]*: /, '').slice(0, 300)}`); }
    this.progress(inst.id, `Image construite ici : ${ref}`);
    this.audit?.write('hub', 'image.construite', inst.name, { image: ref, depot: ou, ref: utilisee });
    return true;
  }

  async deploy(inst, entry, { tirer = false } = {}) {
    const m = inst.manifest;
    if (m.minHubVersion && compareVersions(config.version, m.minHubVersion) < 0) {
      throw new HttpError(409, `${m.name || inst.name} demande le Hub ${m.minHubVersion} ou plus récent (celui-ci : ${config.version}). Mets d'abord le Hub à jour.`);
    }
    if (!(await docker.available())) throw new HttpError(503, 'Docker est injoignable depuis le Hub. Vérifie le proxy de socket (DOCKER_HOST).');
    this.progress(inst.id, 'Téléchargement du fichier Compose', 'run');
    const tpl = await this.registry.composeFile(entry);
    const ctx = this.runtime.context(inst);
    const expo = this.expositionDe(inst);
    if (expo === 'proxy' || expo === 'ip') {
      throw new HttpError(501, `Exposition « ${EXPOSITION_LIBELLE[expo]} » : ce mode n'est pas encore implémenté. Choisis « Boucle locale » ou « Adresse et port » dans Réglages.`);
    }
    // Son nom chez Relay, s'il est là : posé avant le démarrage, pour que le
    // service connaisse son adresse publique et le relais qu'il peut croire.
    await this.connexions?.auDeploiement(inst, msg => this.progress(inst.id, msg));
    const publiee = this.connexions?.publications()[inst.id] || '';
    const ui = publiee || openAddresses(inst, { exposition: expo, machine: this.db.setting('adresse_machine', '') }).find(o => o.url && !o.host)?.url || '';
    const propres = this.reglagesDeLaMachine(m, ctx.config || {});
    const cfg = { ...(ctx.config || {}), ...propres, ...this.reglagesDuRelais(m, ctx.config || {}, publiee) };
    // Le relais d'envoi du Hub, pour un service qui n'a pas le sien (Réglages → Courriel).
    const smtp = smtpPourService(reglageCourriel(this.db, this.vault), cfg);
    const rendered = renderCompose(tpl, composeVars(inst, m, { ...cfg, ...smtp }, cap => this.fournisseurPour(cap, inst), expo, ui, gammePour(reglageTheme(this.db), inst.id)));
    checkCompose(rendered, m);
    for (const [cle, lit, ensemble] of [['services_toutes_gammes', composeLitToutes(tpl), this.lisentToutesLesGammes()], ['services_apparence', composeLitApparence(tpl), this.lisentLApparence()]]) {
      if (lit === ensemble.has(inst.id)) continue;
      if (lit) ensemble.add(inst.id); else ensemble.delete(inst.id);
      this.db.setSetting(cle, [...ensemble]);
    }
    const file = this.stackFile(inst);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, rendered, { mode: 0o600 });
    await docker.ensureNetwork(config.dockerNetwork);
    // Une image déjà présente sur la machine n'est pas retéléchargée : « docker
    // compose pull --policy missing » ne tient pas cette promesse, il tire quand
    // même. On interroge donc le démon image par image.
    let changees = 0, tirees = 0, refusees = 0;
    const archives = new Map();
    // Ce qui tourne avant la mise à jour : une image reconstruite sur la
    // machine (dépôt privé) compte comme un changement, même sans téléchargement.
    const enService = tirer ? await docker.imagesEnService(`hub-${inst.name}`) : new Map();
    for (const ref of imagesOf(rendered)) {
      // Une mise à jour retélécharge les images à étiquette mobile (latest…) :
      // sans cela, « mettre à jour » relancerait exactement la même chose.
      // Une étiquette fixe (2.0.3) désigne une image qui ne change pas : déjà
      // sur la machine, rien à demander au registre.
      if (tirer && !ref.includes('@') && !etiquetteFixe(etiquetteDe(ref))) {
        const avant = await docker.imageId(ref);
        this.progress(inst.id, `Téléchargement de ${ref}`, 'run');
        try { await docker.pullImage(ref); tirees++; }
        catch (e) {
          const brut = String(e.message || e).split('\n').map(l => l.trim()).filter(Boolean).pop() || 'erreur inconnue';
          const raison = /denied|unauthorized/i.test(brut) ? 'accès refusé par le registre : image privée, ou jamais publiée'
            : /not found|manifest unknown/i.test(brut) ? 'image absente du registre' : brut.slice(0, 160);
          if (!avant) {
            if (await this.construireDepuisSources(inst, entry, ref, archives)) { changees++; continue; }
            throw new HttpError(502, `Téléchargement de ${ref} impossible — ${raison}.`);
          }
          refusees++;
          if (enService.has(ref) && enService.get(ref) !== avant) changees++;
          this.progress(inst.id, `Image de cette machine : ${ref} (registre : ${raison})`);
          continue;
        }
        const apres = await docker.imageId(ref);
        if (apres !== avant || (enService.has(ref) && enService.get(ref) !== apres)) changees++;
        continue;
      }
      if (await docker.imageExists(ref)) {
        // Une étiquette qui ne tournait pas encore (2.0.0 → 2.0.3) est un changement.
        if (tirer && (!enService.has(ref) || enService.get(ref) !== await docker.imageId(ref))) changees++;
        this.progress(inst.id, `Image déjà présente : ${ref}`);
        continue;
      }
      this.progress(inst.id, `Téléchargement de ${ref}`, 'run');
      try { await docker.pullImage(ref); }
      catch (e) {
        if (/denied|not found|manifest unknown|unauthorized/i.test(e.message)) {
          // Le registre ne l'a pas : construite ici depuis le dépôt de l'extension.
          if (await this.construireDepuisSources(inst, entry, ref, archives)) { if (tirer) changees++; continue; }
          throw new HttpError(502, `Image ${ref} absente de cette machine et du registre, et pas de dépôt GitHub d'où la construire. Construis-la ici avec cette étiquette, ou choisis une version présente dans « Version de l’image ».`);
        }
        throw e;
      }
    }
    if (tirer && refusees && !changees) {
      this.progress(inst.id, 'Même image qu’avant : seuls le manifeste et les réglages ont été repris.');
    } else if (tirer && tirees && !changees) {
      this.progress(inst.id, 'Images identiques à celles en place : si une publication vient d’être poussée, sa construction n’est peut-être pas terminée (GitHub Actions). Réessaie dans quelques minutes.', 'warn');
    }
    this.progress(inst.id, `Démarrage (réseau ${config.dockerNetwork})`, 'run');
    try { await docker.up(`hub-${inst.name}`, file); }
    catch (e) { const clair = erreurDemarrage(e.message); throw clair ? new HttpError(409, clair, { portPris: portPrisDe(e.message) }) : e; }
    this.progress(inst.id, 'Conteneurs démarrés');
  }

  /**
   * L'adresse IPv4 de cette machine sur le réseau, sans la demander : celle
   * posée dans Réglages, celle du certificat du Hub, celle où il écoute, ou
   * celle par laquelle on vient de l'ouvrir. Jamais 0.0.0.0 ni la boucle locale.
   */
  ipMachine() {
    const ok = v => (net.isIPv4(String(v || '')) && !/^(0|127)\./.test(v) ? v : '');
    let ui = '';
    try { ui = new URL(this.db.setting('hub_ui', '')).hostname; } catch { ui = ''; }
    return ok(this.db.setting('adresse_machine', '')) || ok(config.tlsIp) || ok(config.bindIp) || ok(ui);
  }

  /**
   * Un réglage laissé vide dont le défaut est {{hub.ip}} reçoit l'adresse de
   * la machine à chaque déploiement : elle suit la machine, personne ne la tape.
   */
  reglagesDeLaMachine(m, cfg) {
    const out = {};
    for (const f of m.config || []) {
      if (typeof f.default !== 'string' || !f.default.includes('{{hub.ip}}')) continue;
      if (cfg[f.key] !== undefined && cfg[f.key] !== '') continue;
      const ip = this.ipMachine();
      if (!ip) throw new HttpError(409, `${m.name || 'Ce service'} a besoin de l’adresse IP de cette machine et le Hub ne la connaît pas : pose-la dans Réglages → Adresse de la machine.`);
      out[f.key] = f.default.replaceAll('{{hub.ip}}', ip);
    }
    if (Object.keys(out).length) verifierReglages(m, { ...cfg, ...out }, Object.keys(out));
    return out;
  }

  /**
   * Ce que Relay change aux réglages d'un service du socle : le relais qu'il
   * croit (Caddy de Relay, en plus des siens) et, s'il n'en a pas, son adresse
   * publique quand Relay le sert en HTTPS — les liens de ses courriels en partent.
   */
  reglagesDuRelais(m, cfg, publiee) {
    if (!this.connexions) return {};
    const cles = new Set((m.config || []).map(f => f.key));
    const out = {};
    if (cles.has('SOCLE_PROXYS')) out.SOCLE_PROXYS = this.connexions.proxysPour(cfg);
    if (cles.has('SOCLE_URL_PUBLIQUE') && !cfg.SOCLE_URL_PUBLIQUE && publiee.startsWith('https://')) out.SOCLE_URL_PUBLIQUE = publiee;
    return out;
  }

  /**
   * Après le déploiement de Relay : si l'adresse de son Caddy a changé (première
   * installation, recréation), chaque service installé ici est redéployé pour
   * la recevoir — et reçoit son nom au passage. En tâche de fond.
   */
  async apresDeploiement(inst, actor) {
    if (!this.connexions || !(inst.manifest.capabilities?.provides || []).includes('edge.routes')) return;
    if (!(await this.connexions.releverRelais())) return;
    this.redeployerPourRelais(actor);
  }
  /** Relay compris : il doit croire son propre Caddy. Son redéploiement ne relance rien, l'adresse étant déjà relevée. */
  redeployerPourRelais(actor) {
    const cibles = this.list().filter(i => i.mode === 'compose' && i.status === 'online');
    (async () => {
      for (const i of cibles) {
        try { await this.redeploy(i.id, actor); }
        catch (e) { log.warn('services', `${i.name} : redéploiement pour Relay impossible — ${e.message}`); }
      }
    })();
    return cibles.map(i => i.name);
  }

  async undeploy(inst, volumes) {
    const file = this.stackFile(inst);
    if (fs.existsSync(file)) {
      await docker.down(`hub-${inst.name}`, file, volumes);
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  }

  async waitHealthy(inst, maxMs) {
    const end = Date.now() + maxMs;
    let last;
    while (Date.now() < end) {
      try { await this.runtime.health(inst); return; } catch (e) { last = e; }
      await sleep(2000);
    }
    throw new HttpError(502, `${inst.name} ne répond pas au test de santé (${last?.cause?.code || last?.message}).${inst.mode === 'remote' && inst.manifest.install.remote?.setupHelp ? ' ' + inst.manifest.install.remote.setupHelp : ''}`);
  }

  setStatus(instId, status, detail = null) {
    const cur = this.db.get('SELECT status, status_detail FROM instances WHERE id=?', instId);
    if (!cur || (cur.status === status && cur.status_detail === detail)) return;
    this.db.run('UPDATE instances SET status=?, status_detail=? WHERE id=?', status, detail, instId);
    this.bus.emit('instance', { id: instId, status, detail });
    if (cur.status === 'online' && status === 'offline') this.bus.emit('hub.event', { event: 'service.unreachable', instanceId: instId, detail });
  }

  async checkAll() {
    for (const inst of this.list()) {
      if (inst.status === 'installing') continue;
      try { await this.runtime.health(inst); this.setStatus(inst.id, 'online'); }
      catch (e) { this.setStatus(inst.id, 'offline', e.cause?.code || e.message); }
    }
  }

  updateConfig(idOrName, patch, actor) {
    const inst = this.get(idOrName);
    const sk = secretKeysOf(inst.manifest);
    const known = new Set((inst.manifest.config || []).map(f => f.key));
    const cur = this.configOf(inst);
    for (const [k, v] of Object.entries(patch || {})) {
      if (!known.has(k)) throw new HttpError(400, `Réglage inconnu : ${k}`);
      if (sk.includes(k) && (v === '' || v == null || String(v).startsWith('•'))) continue;
      cur[k] = normaliserChamp(inst.manifest.config.find(f => f.key === k), v);
    }
    if (inst.mode === 'compose') verifierReglages(inst.manifest, cur, Object.keys(patch || {}));
    this.db.run('UPDATE instances SET config=? WHERE id=?', JSON.stringify(this.vault.sealFields(cur, sk)), inst.id);
    if (Object.hasOwn(patch || {}, CLE_IMAGE)) this.db.run('UPDATE instances SET image_epinglee=? WHERE id=?', imageEpinglee(inst.manifest, cur) ? 1 : 0, inst.id);
    this.audit.write(actor, 'service.réglages', inst.name, { clés: Object.keys(patch || {}) });
    // L'IA choisie dans ces réglages devient (ou reste) un lien visible ; le
    // modèle par défaut d'un Ollama change aussi le lien de ceux qui s'en servent.
    this.refletIA = this.capabilities?.refleterToutIA?.(actor);
    return this.get(inst.id);
  }

  updateUrl(idOrName, url, actor) {
    const inst = this.get(idOrName);
    if (inst.mode !== 'remote') throw new HttpError(400, 'Seuls les services distants ont une adresse modifiable.');
    new URL(url);
    this.db.run('UPDATE instances SET url=? WHERE id=?', url.replace(/\/$/, ''), inst.id);
    this.audit.write(actor, 'service.adresse', inst.name, { url });
  }

  async remove(idOrName, { deleteVolumes = false } = {}, actor) {
    const inst = this.get(idOrName);
    const users = this.capabilities.workflowsUsing(inst.id);
    const etaitRelais = (inst.manifest.capabilities?.provides || []).includes('edge.routes');
    if (!etaitRelais) await this.connexions?.auRetrait(inst);
    if (inst.mode === 'compose') await this.undeploy(inst, deleteVolumes);
    this.iaServices?.oublier(inst.id);
    this.db.tx(() => {
      for (const w of users) if (w.origin === 'Auto') this.db.run('DELETE FROM workflows WHERE id=?', w.id);
      this.db.run('DELETE FROM instances WHERE id=?', inst.id);
      this.db.run('DELETE FROM probe_samples WHERE instance_id=?', inst.id);
    });
    this.audit.write(actor, 'service.suppression', inst.name, { volumes: deleteVolumes, workflows: users.map(w => w.name) });
    this.relierDependants(inst, actor);
    await this.capabilities.refleterToutIA?.(actor);
    // Relay parti : plus aucun service ne doit croire son ancienne adresse,
    // ni annoncer un nom qui ne mène plus nulle part.
    if (etaitRelais && this.connexions) {
      this.db.setSetting('publications', {});
      if (await this.connexions.releverRelais()) this.redeployerPourRelais(actor);
    } else this.connexions?.retenir(inst.id, null);
    this.bus.emit('instance', { id: inst.id, removed: true });
    return { removedWorkflows: users.filter(w => w.origin === 'Auto').map(w => w.name), brokenWorkflows: users.filter(w => w.origin !== 'Auto').map(w => w.name) };
  }

  async logs(idOrName, tail) {
    const inst = this.get(idOrName);
    if (inst.mode !== 'compose') throw new HttpError(400, 'Les journaux ne sont disponibles que pour les services installés ici.');
    return docker.logs(`hub-${inst.name}`, this.stackFile(inst), tail);
  }

  providersOf(cap) {
    return this.list().filter(i => (i.status !== 'installing' || this.redeploiements.has(i.id)) && (i.manifest.capabilities.provides || []).includes(cap));
  }
}

/* 1.10.0 > 1.9.2 ; 1.0.0 > 1.0.0-beta ; un suffixe se compare en texte. */
export function compareVersions(a, b) {
  const pa = String(a || '0').split('-'), pb = String(b || '0').split('-');
  const na = pa[0].split('.').map(n => parseInt(n, 10) || 0), nb = pb[0].split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) { const d = (na[i] || 0) - (nb[i] || 0); if (d) return Math.sign(d); }
  if (pa[1] && !pb[1]) return -1;
  if (!pa[1] && pb[1]) return 1;
  return pa[1] && pb[1] ? Math.sign(pa[1].localeCompare(pb[1])) : 0;
}

export { secretKeysOf, parseDuration, log };
