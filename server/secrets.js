// Secrets nommés, rangés par service.
//
// Le Hub gardait déjà des variables scellées dans le coffre. Il leur manquait
// deux choses : un endroit où les saisir sans connaître la convention de
// nommage, et le fait que l'assistant sache qu'elles existent.
//
// Le principe, et c'est tout l'intérêt : l'assistant reçoit les NOMS, jamais
// les valeurs. Il écrit `{{ $vars.TELEGRAM_BOT_TOKEN }}` dans un workflow ; le
// moteur remplace au dernier moment, à l'exécution, après que l'IA a fini de
// parler. Le modèle peut donc câbler un service dont il ne pourra jamais
// répéter le jeton — ni dans une réponse, ni dans un plan, ni par erreur.

import { HttpError } from './util/common.js';
import { domaineValide } from './logos.js';

/** Ce qu'on peut dire d'une valeur refusée sans la montrer : sa longueur et ses deux premiers caractères. */
export const decrire = v => `(Valeur reçue : ${v.length} caractères, commence par « ${v.slice(0, 2)}… ».)`;
const S = (key, label, help, plus = {}) => ({ key, label, help, secret: true, ...plus });
const C = (key, label, help) => ({ key, label, help, secret: false });

/**
 * Les services connus. Un champ `secret` est scellé et ne redescend jamais ;
 * un champ clair (une adresse, un identifiant de discussion) reste lisible, ce
 * qui évite de rendre illisible ce qui n'a rien d'un secret.
 */
export const CATEGORIES = ['IA', 'Voix', 'Notifications', 'Réseau & DNS', 'Code', 'Infrastructure'];

export const CATALOGUE = [
  // Les clés des IA vivent ici comme les autres : la page IA les
  // choisit dans cette liste au lieu de les redemander. `ia` = le type de
  // connexion du Hub qu'elles alimentent.
  { id: 'kimi', ia: 'kimi', domaine: 'moonshot.ai', couleur: '#1F1F1F', categorie: 'IA', ou: 'platform.moonshot.ai → API Keys → Create.', nom: 'Kimi', champs: [S('API_KEY', 'Clé d’API')] },
  { id: 'openai', ia: 'openai', domaine: 'openai.com', couleur: '#10A37F', categorie: 'IA', ou: 'platform.openai.com → API keys.', nom: 'OpenAI', champs: [S('API_KEY', 'Clé d’API')] },
  { id: 'anthropic', ia: 'anthropic', domaine: 'anthropic.com', couleur: '#D97757', categorie: 'IA', ou: 'console.anthropic.com → API Keys.', nom: 'Claude', champs: [S('API_KEY', 'Clé d’API')] },
  { id: 'gemini', ia: 'gemini', domaine: 'gemini.google.com', couleur: '#4285F4', categorie: 'IA', ou: 'aistudio.google.com → Get API key.', nom: 'Gemini', champs: [S('API_KEY', 'Clé d’API')] },
  { id: 'mistral', ia: 'openai-compatible', iaUrl: 'https://api.mistral.ai/v1', domaine: 'mistral.ai', couleur: '#FA520F', categorie: 'IA', ou: 'console.mistral.ai → API Keys.', nom: 'Mistral', champs: [S('API_KEY', 'Clé d’API')] },
  // Claude Code par abonnement : le jeton que « claude setup-token » affiche, à
  // coller ici ; le Hub le passe au conteneur des outils à chaque appel.
  { id: 'claude-code', ia: 'claude-code', domaine: 'claude.ai', couleur: '#D97757', categorie: 'IA', ou: 'Sur la machine du Hub : docker exec -it hub-outils-ia claude setup-token — la commande ouvre la page de connexion de ton abonnement Claude et affiche un jeton : colle-le ici.', nom: 'Claude Code', champs: [S('API_KEY', 'Jeton Claude Code', 'Celui que « claude setup-token » affiche (sk-ant-oat…).')] },
  { id: 'openrouter', ia: 'openai-compatible', iaUrl: 'https://openrouter.ai/api/v1', domaine: 'openrouter.ai', couleur: '#6467F2', categorie: 'IA', ou: 'openrouter.ai → Keys.', nom: 'OpenRouter', champs: [S('API_KEY', 'Clé d’API')] },
  // La voix : le mode vocal de l'assistant (via VOX) et le nœud « Voix
  // ElevenLabs » des workflows la prennent ici, sans la redemander.
  { id: 'elevenlabs', domaine: 'elevenlabs.io', couleur: '#1A1A1A', categorie: 'Voix', ou: 'elevenlabs.io → Developers → API Keys → Create. L’identifiant de voix : Voices → la voix → Copy voice ID.', nom: 'ElevenLabs', champs: [
    S('API_KEY', 'Clé d’API', 'Commence par sk_ — ElevenLabs ne l’affiche qu’une fois, à sa création. Donne-lui au moins « Text to Speech » et « Voices : lecture ».', {
      // L'identifiant de clé (la colonne de la liste des clés) se colle
      // souvent à sa place : ElevenLabs le refuse, autant le dire ici.
      forme: /^sk_[A-Za-z0-9_-]{16,}$/,
      // Un copier-coller ramène parfois des espaces, un saut de ligne ou un
      // bout de code (« apiKey: "sk_…" ») : on garde la clé, rien d'autre.
      nettoie: v => (/sk_[A-Za-z0-9_-]{16,}/.exec(v.replace(/[\s\u200B-\u200D\u2060\uFEFF]/g, '')) || [v])[0],
      formeAide: 'Ce n’est pas la clé d’API ElevenLabs : une clé commence par « sk_ ». La valeur affichée dans la liste des clés est son identifiant, pas la clé. Crée une nouvelle clé (Developers → API Keys → Create) et copie-la au moment où elle s’affiche.',
    }),
    C('VOICE_ID', 'Identifiant de voix', 'Vide = la voix choisie dans VOX.'),
    C('MODEL', 'Modèle', 'eleven_flash_v2_5 (rapide, conseillé) ou eleven_multilingual_v2 (plus riche).'),
  ] },
  { id: 'telegram', domaine: 'telegram.org', couleur: '#26A5E4', categorie: 'Notifications', ou: 'Parle à @BotFather dans Telegram : /newbot donne le jeton.', nom: 'Telegram', champs: [
    S('BOT_TOKEN', 'Jeton du bot', 'Obtenu auprès de @BotFather.'),
    C('CHAT_ID', 'Identifiant de discussion', 'Commence souvent par -100.'),
  ] },
  { id: 'discord', domaine: 'discord.com', couleur: '#5865F2', categorie: 'Notifications', ou: 'Paramètres du salon → Intégrations → Webhooks.', nom: 'Discord', champs: [S('WEBHOOK_URL', 'URL du webhook')] },
  { id: 'slack', domaine: 'slack.com', couleur: '#611F69', categorie: 'Notifications', ou: 'api.slack.com/apps → Incoming Webhooks.', nom: 'Slack', champs: [S('WEBHOOK_URL', 'URL du webhook')] },
  { id: 'ntfy', domaine: 'ntfy.sh', couleur: '#338574', categorie: 'Notifications', ou: 'Choisis un sujet difficile à deviner : il sert de mot de passe.', nom: 'ntfy', champs: [
    C('URL', 'Adresse du serveur', 'https://ntfy.sh ou ton instance.'),
    C('TOPIC', 'Sujet'), S('TOKEN', 'Jeton (facultatif)'),
  ] },
  { id: 'gotify', domaine: 'gotify.net', couleur: '#1E88E5', categorie: 'Notifications', ou: 'Interface Gotify → Apps → créer une application.', nom: 'Gotify', champs: [C('URL', 'Adresse'), S('TOKEN', 'Jeton d’application')] },
  { id: 'pushover', domaine: 'pushover.net', couleur: '#249DF1', categorie: 'Notifications', ou: 'pushover.net → Your Applications → Create.', nom: 'Pushover', champs: [S('USER_KEY', 'Clé utilisateur'), S('APP_TOKEN', 'Jeton d’application')] },
  { id: 'cloudflare', domaine: 'cloudflare.com', couleur: '#F38020', categorie: 'Réseau & DNS', ou: 'Mon profil → Jetons d’API → Créer un jeton (modèle « Modifier la zone DNS »).', nom: 'Cloudflare', champs: [
    S('API_TOKEN', 'Jeton d’API', 'Un jeton restreint, pas la clé globale.'),
    C('ACCOUNT_ID', 'Identifiant de compte'), C('ZONE_ID', 'Identifiant de zone'),
  ] },
  { id: 'github', domaine: 'github.com', couleur: '#8B949E', categorie: 'Code', ou: 'Settings → Developer settings → Fine-grained tokens.', nom: 'GitHub', champs: [S('TOKEN', 'Jeton d’accès personnel')] },
  { id: 'gitlab', domaine: 'gitlab.com', couleur: '#FC6D26', categorie: 'Code', ou: 'Préférences → Jetons d’accès.', nom: 'GitLab', champs: [C('URL', 'Adresse'), S('TOKEN', 'Jeton d’accès')] },
  { id: 'proxmox', domaine: 'proxmox.com', couleur: '#E57000', categorie: 'Infrastructure', ou: 'Datacenter → Permissions → API Tokens.', nom: 'Proxmox', champs: [
    C('URL', 'Adresse'), C('TOKEN_ID', 'Identifiant du jeton', 'utilisateur@pam!nom'),
    S('TOKEN_SECRET', 'Secret du jeton'),
  ] },
  { id: 'unifi', domaine: 'ui.com', couleur: '#006FFF', categorie: 'Réseau & DNS', ou: 'Crée un compte local dédié sur la console UniFi.', nom: 'UniFi', champs: [
    C('URL', 'Adresse du contrôleur'), C('USER', 'Identifiant local'),
    S('PASSWORD', 'Mot de passe'), C('SITE', 'Site'),
  ] },
  { id: 'homeassistant', domaine: 'home-assistant.io', couleur: '#18BCF2', categorie: 'Infrastructure', ou: 'Profil → Sécurité → Jetons d’accès longue durée.', nom: 'Home Assistant', champs: [C('URL', 'Adresse'), S('TOKEN', 'Jeton longue durée')] },
  { id: 'grafana', domaine: 'grafana.com', couleur: '#F46800', categorie: 'Infrastructure', ou: 'Administration → Comptes de service → Ajouter un jeton.', nom: 'Grafana', champs: [C('URL', 'Adresse'), S('TOKEN', 'Jeton de service')] },
  { id: 'nextcloud', domaine: 'nextcloud.com', couleur: '#0082C9', categorie: 'Infrastructure', ou: 'Paramètres → Sécurité → Créer un mot de passe d’application.', nom: 'Nextcloud', champs: [
    C('URL', 'Adresse'), C('USER', 'Identifiant'), S('APP_PASSWORD', 'Mot de passe d’application'),
  ] },
  { id: 'twilio', domaine: 'twilio.com', couleur: '#F22F46', categorie: 'Notifications', ou: 'Console Twilio → Account Info.', nom: 'Twilio', champs: [
    C('ACCOUNT_SID', 'Identifiant de compte'), S('AUTH_TOKEN', 'Jeton'),
    C('FROM', 'Numéro d’envoi'), C('TO', 'Numéro destinataire'),
  ] },
  { id: 'ovh', domaine: 'ovh.com', couleur: '#123F6D', categorie: 'Réseau & DNS', ou: 'api.ovh.com/createToken, avec les seuls droits utiles.', nom: 'OVH', champs: [
    S('APP_KEY', 'Clé d’application'), S('APP_SECRET', 'Secret d’application'), S('CONSUMER_KEY', 'Clé de consommateur'),
  ] },
  { id: 'smtp', domaine: '', couleur: '#7A8699', categorie: 'Notifications', ou: 'Les réglages SMTP de ta messagerie.', nom: 'Serveur SMTP', champs: [
    C('HOST', 'Serveur'), C('PORT', 'Port'), C('USER', 'Identifiant'),
    S('PASSWORD', 'Mot de passe'), C('FROM', 'Adresse d’envoi'),
  ] },
];

const NOM_OK = /^[A-Za-z][A-Za-z0-9 _.-]{0,30}$/;

/** `Telegram` + `BOT_TOKEN` → `TELEGRAM_BOT_TOKEN`. Une seule règle, partout. */
export function cle(service, champ) {
  const net = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `${net(service)}_${net(champ)}`.slice(0, 41);
}

/* Plusieurs comptes d'un même service : « telegram » pour le premier,
   « telegram:alertes » pour un bot nommé Alertes. Les clés suivent :
   TELEGRAM_BOT_TOKEN, TELEGRAM_ALERTES_BOT_TOKEN. */
const slug = n => String(n || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
export const baseDe = svc => String(svc || '').split(':')[0];
const COMPTE_OK = /^[\p{L}0-9][\p{L}0-9 _.'-]{0,23}$/u;

export class Secrets {
  constructor({ db, vault, audit }) { Object.assign(this, { db, vault, audit }); }

  /** Ce qui est posé, par service. Jamais une valeur — seulement « rempli ». */
  list() {
    const lignes = this.db.all('SELECT key, service, label, secret, value FROM variables ORDER BY service, key');
    const sites = this.db.setting?.('secrets_sites', {}) || {};
    // Où chaque clé sert : un secret qu'aucun workflow ne cite est un
    // candidat à l'oubli ; un secret cité partout ne s'efface pas à la légère.
    const graphes = this.db.all('SELECT name, graph FROM workflows').map(w => ({ name: w.name, g: String(w.graph || '') }));
    const par = new Map();
    const comptes = this.db.setting?.('secrets_comptes', {}) || {};
    for (const l of lignes) {
      const sid = l.service || 'autres';
      const base = baseDe(sid);
      const connu = CATALOGUE.find(c => c.id === base);
      if (!par.has(sid)) par.set(sid, {
        service: sid, base, compte: sid.includes(':') ? (comptes[sid] || sid.split(':')[1]) : '',
        nom: l.service ? (connu?.nom || sid) : 'Variables libres', connu: !!connu, libre: !l.service,
        domaine: connu ? connu.domaine : (sites[sid] || ''), couleur: connu?.couleur || null, categorie: connu?.categorie || 'Personnalisé',
        ia: connu?.ia || null, champs: [], utilisePar: [],
      });
      const e = par.get(sid);
      e.champs.push({ key: l.key, label: l.label || l.key, secret: !!l.secret, rempli: l.value !== '' });
      // Cité par « $vars.CLÉ » dans un nœud, ou nommé dans un lien automatique
      // (« vox utilise la voix ElevenLabs » cite la clé qu'il transmet).
      const cite = new RegExp(`(^|[^A-Z0-9_])${l.key}(?![A-Z0-9_])`);
      for (const w of graphes) if (cite.test(w.g) && !e.utilisePar.includes(w.name)) e.utilisePar.push(w.name);
    }
    return [...par.values()];
  }

  /** Le domaine d'où tirer le logo d'un service, connu ou personnalisé. */
  domaineDe(id) {
    const connu = CATALOGUE.find(c => c.id === baseDe(id));
    if (connu) return connu.domaine;
    return (this.db.setting?.('secrets_sites', {}) || {})[id] || '';
  }

  /** Les noms seuls, pour l'assistant. C'est tout ce qu'il verra jamais. */
  noms() {
    return this.list().map(s => ({ service: s.compte ? `${s.nom} (${s.compte})` : s.nom, cles: s.champs.filter(c => c.rempli).map(c => c.key) }))
      .filter(s => s.cles.length);
  }

  /**
   * Pose ou remplace les champs d'un service.
   *
   * Un champ laissé vide n'efface pas ce qui existe : on ne perd pas un jeton
   * parce qu'on a rouvert la fiche pour corriger l'adresse à côté.
   */
  poser({ service, nom, champs, site, compte }, actor) {
    // « telegram:alertes » en modification, ou « telegram » + compte « Alertes » en création.
    if (String(service || '').includes(':')) { compte = compte || (this.db.setting?.('secrets_comptes', {}) || {})[service] || service.split(':')[1]; service = baseDe(service); }
    const connu = CATALOGUE.find(c => c.id === service);
    compte = connu ? String(compte || '').trim() : '';
    if (compte && !COMPTE_OK.test(compte)) throw new HttpError(400, 'Nom du compte : 24 caractères au plus, lettres, chiffres, espace, point, tiret.');
    const sid = connu ? (compte ? `${connu.id}:${slug(compte)}` : connu.id) : null;
    const etiquette = connu ? connu.nom : String(nom || service || '').trim();
    if (!connu && !NOM_OK.test(etiquette)) throw new HttpError(400, 'Nom du service : lettres, chiffres, espace, point ou tiret.');
    const attendus = connu ? connu.champs : null;
    const entrees = Object.entries(champs || {});
    if (!entrees.length && (connu || site === undefined)) throw new HttpError(400, 'Aucun champ à enregistrer.');

    // La forme se vérifie avant d'écrire quoi que ce soit : pas d'enregistrement à moitié.
    for (const [nomChamp, valeur] of entrees) {
      const def = attendus?.find(f => f.key === nomChamp);
      const v = String(valeur ?? '').trim();
      if (def?.forme && v && !def.forme.test(def.nettoie ? def.nettoie(v) : v)) throw new HttpError(400, `${def.formeAide || `${def.label} : forme inattendue.`} ${decrire(v)}`);
    }

    const posees = [];
    for (const [nomChamp, valeur] of entrees) {
      const def = attendus?.find(f => f.key === nomChamp);
      if (attendus && !def) throw new HttpError(400, `Champ inconnu pour ${etiquette} : ${nomChamp}`);
      if (!attendus && !NOM_OK.test(nomChamp)) throw new HttpError(400, `Nom de champ invalide : ${nomChamp}`);
      let v = String(valeur ?? '');
      if (def?.nettoie && v.trim()) v = def.nettoie(v.trim());
      if (!v) continue;                              // vide = on garde l'existant
      const k = cle(connu ? (compte ? `${connu.id}_${slug(compte)}` : connu.id) : etiquette, nomChamp);
      // Sans définition — mode personnalisé — on scelle : mieux vaut cacher
      // une adresse que laisser filer un jeton.
      const estSecret = def ? def.secret : true;
      this.db.run(
        'INSERT INTO variables(key,value,secret,service,label) VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, secret=excluded.secret, service=excluded.service, label=excluded.label',
        k, estSecret ? this.vault.seal(v) : v, estSecret ? 1 : 0, sid || etiquette, def ? def.label : nomChamp,
      );
      posees.push(k);
    }
    // Un service personnalisé peut donner son site : c'est de là que vient son logo.
    if (!connu && site !== undefined && this.db.setting) {
      const d = domaineValide(site);
      if (site && !d) throw new HttpError(400, 'Site : un nom de domaine public, par exemple exemple.com.');
      const sites = this.db.setting('secrets_sites', {});
      if (d) sites[etiquette] = d; else delete sites[etiquette];
      this.db.setSetting('secrets_sites', sites);
    }
    if (!posees.length && !(site !== undefined && !connu)) throw new HttpError(400, 'Tous les champs étaient vides.');
    // Le journal garde les noms, jamais les valeurs.
    if (compte && posees.length && this.db.setting) {
      const c = this.db.setting('secrets_comptes', {}); c[sid] = compte; this.db.setSetting('secrets_comptes', c);
    }
    this.audit.write(actor, 'secret.posé', compte ? `${etiquette} (${compte})` : etiquette, { clés: posees });
    return { service: sid || etiquette, clés: posees };
  }

  /** La valeur d'une clé, pour le Hub lui-même (connexions IA). Jamais pour l'IA. */
  valeur(key) {
    const r = this.db.all('SELECT value, secret FROM variables WHERE key=?', key)[0];
    if (!r) return null;
    return r.secret ? this.vault.open(r.value) : r.value;
  }

  oublier(service, actor) {
    const n = this.db.all('SELECT key FROM variables WHERE service=?', service).length;
    if (!n) throw new HttpError(404, 'Service inconnu dans les secrets.');
    this.db.run('DELETE FROM variables WHERE service=?', service);
    if (this.db.setting) {
      for (const cleReg of ['secrets_sites', 'secrets_comptes']) {
        const r = this.db.setting(cleReg, {}); if (r[service]) { delete r[service]; this.db.setSetting(cleReg, r); }
      }
    }
    this.audit.write(actor, 'secret.oublié', service, { champs: n });
    return { oubliés: n };
  }
}
