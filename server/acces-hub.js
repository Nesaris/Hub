/*
 * Ce que l'assistant peut faire dans le Hub : tout ce qu'un administrateur
 * fait par l'interface, par les MÊMES routes — mêmes schémas, mêmes rôles,
 * même renfort, même journal — sauf ce qui touche aux identifiants et ce qui
 * doit rester un geste humain.
 *
 * Rien n'est ouvert par une liste à tenir à jour : toute route déclarée est
 * proposée, puis retirée si elle tombe sous une règle ci-dessous. Une route
 * ajoutée demain est donc utilisable demain, et une route qui parle de mot
 * de passe, de jeton ou de compte ne l'est jamais.
 */
import { valider } from '../socle/src/index.js';
import { HttpError } from './util/common.js';

const SURES = new Set(['GET', 'HEAD']);

/* Jamais par l'assistant, même validé par un clic : la raison est dite telle quelle. */
const INTERDITS = [
  [/^\w+ \/api\/accounts\b/, 'Les comptes des services (identifiants, mots de passe, liens de réinitialisation, double facteur) restent entre tes mains : Comptes services.'],
  [/^(POST|PUT|PATCH|DELETE) \/api\/secrets(\/(?!test$)[^/]+)?$/, 'Une clé ou un jeton se colle à la main dans Clés & API : je n’en vois ni n’en écris jamais la valeur.'],
  [/^\w+ \/api\/ai\/outils\/\w+\/connexion/, 'Connecter un compte Claude Code ou Codex est un geste de l’utilisateur, page IA : il ouvre le lien et colle le code lui-même.'],
  [/^GET \/api\/secrets\/valeur\//, 'La valeur d’une clé ne se dévoile qu’à une personne, dans Clés & API, après sa vérification : je ne la vois jamais.'],
  [/^GET \/api\/secrets\/(logo|elevenlabs\/apercu)\b/, 'Rien à lire pour moi ici.'],
  [/^(PUT|DELETE) \/api\/variables\//, 'Une variable peut porter un secret : elle se règle à la main dans Réglages → Variables.'],
  [/^\w+ \/api\/jetons\b/, 'Les jetons d’accès sont des identifiants : Réglages → Jetons d’accès.'],
  [/^\w+ \/api\/agent\b/, 'Je ne valide ni ne refuse mes propres plans.'],
  [/^POST \/api\/approvals\//, 'Une validation demandée par un workflow reste un geste humain.'],
  [/^PUT \/api\/coupure\b/, 'La coupure d’urgence est ton frein, pas le mien : Réglages → Coupure d’urgence.'],
  [/^PUT \/api\/ai-autonomy\b/, 'Je ne change pas mon propre niveau d’autonomie.'],
  [/\/webhooks\/[^/]+\/secret$/, 'Un secret de webhook ne passe pas par moi.'],
  [/^GET \/api\/workflows\/[^/]+\/export$/, 'L’export d’un workflow se télécharge depuis sa page.'],
  [/^GET \/api\/instances\/[^/]+\/logs$/, 'Les journaux d’un conteneur peuvent porter des secrets : ouvre-les toi-même (Extensions → le service → Journaux).'],
  [/^(PUT|POST) \/api\/catalog\/(sources|import)$/, 'Ajouter une source au catalogue est une décision de confiance : Extensions → Registres.'],
  [/^PUT \/api\/connexions\/cloudflare$/, 'Le jeton d’API Cloudflare se colle à la main : Connexions → Cloudflare.'],
];

/* Un champ qui porte un identifiant ou un secret : jamais écrit par l'assistant, jamais montré au modèle. */
const CHAMP_SENSIBLE = /^(password|passe|motdepasse|mot_de_passe|mdp|apikey|api_key|secret|token|jeton|utilisateur|username|identifiant|login|privatekey|cle|clé)$/i;

/* Ce que fait chaque route qui écrit, en mots : l'étiquette du plan et le catalogue du modèle. */
export const LIBELLES = {
  'POST /api/catalog/refresh': 'Actualiser le catalogue des extensions',
  'POST /api/catalog/:id/test-remote': 'Tester l’adresse d’un service distant',
  'PUT /api/exposition': 'Exposition des services (boucle locale, adresse et port…)',
  'POST /api/instances': 'Installer ou connecter une extension',
  'PATCH /api/instances/:id': 'Régler un service (réglages, adresse)',
  'PUT /api/instances/:id/ia': 'Choisir l’IA d’un service {config: {CHAMP_MODE, CHAMP_MODELE…}} — ses champs d’IA seuls, puis relance s’il est installé ici',
  'POST /api/instances/:id/manifest': 'Reprendre le manifeste d’un service',
  'POST /api/instances/:id/autos': 'Recréer les workflows automatiques d’un service',
  'POST /api/instances/:id/update': 'Mettre un service à jour',
  'POST /api/instances/:id/redeploy': 'Redéployer (relancer) un service',
  'DELETE /api/instances/:id': 'Retirer un service (?volumes=1 : ses données aussi, définitivement)',
  'POST /api/instances/:id/check': 'Vérifier qu’un service répond',
  'POST /api/instances/:id/actions/:action': 'Lancer une action d’un service',
  'PUT /api/connexions/domaines': 'Domaines des noms (Connexions)',
  'DELETE /api/connexions/cloudflare': 'Déconnecter Cloudflare',
  'PUT /api/connexions/tunnel': 'Choisir ou créer le tunnel Cloudflare {tunnel: id | nom}',
  'DELETE /api/connexions/tunnel': 'Couper le tunnel Cloudflare',
  'POST /api/connexions/tunnel/tout': 'Tout faire passer par le tunnel',
  'POST /api/connexions/routes': 'Créer une route de Relay',
  'PATCH /api/connexions/routes/:id': 'Modifier une route de Relay',
  'DELETE /api/connexions/routes/:id': 'Supprimer une route de Relay',
  'PUT /api/connexions/services/:id': 'Publier un service sous un nom {sousDomaine, mode: local|public|cloudflare}',
  'DELETE /api/connexions/services/:id': 'Retirer le nom d’un service',
  'PUT /api/connexions/hub': 'Publier le Hub sous un nom',
  'DELETE /api/connexions/hub': 'Retirer le nom du Hub',
  'POST /api/connexions/appliquer': 'Réappliquer la configuration de Relay',
  'PUT /api/alertes': 'Alertes du Hub sur Telegram {canal, types}',
  'POST /api/alertes/essai': 'Envoyer une alerte d’essai',
  'PUT /api/courriel': 'Courriel des comptes {defaut, relais: {hote, port, securite, de}}',
  'PUT /api/theme': 'Thème de l’interface',
  'POST /api/instances/:id/options': 'Lister les valeurs possibles d’un champ',
  'POST /api/probes/:instance/:probe/read': 'Relever une sonde maintenant',
  'POST /api/workflows/dossiers': 'Créer un dossier de workflows',
  'PATCH /api/workflows/dossiers': 'Renommer un dossier de workflows',
  'POST /api/workflows/dossiers/supprimer': 'Supprimer un dossier de workflows',
  'POST /api/workflows/ranger': 'Ranger des workflows',
  'POST /api/workflows': 'Créer un workflow',
  'PUT /api/workflows/:id': 'Modifier un workflow',
  'DELETE /api/workflows/:id': 'Supprimer un workflow',
  'POST /api/workflows/:id/enable': 'Activer ou couper un workflow {enabled}',
  'POST /api/workflows/:id/reparer/noms': 'Réparer les noms de nœuds d’un workflow',
  'POST /api/workflows/:id/restore': 'Revenir à une version d’un workflow',
  'POST /api/workflows/:id/run': 'Lancer un workflow',
  'POST /api/executions/:id/replay': 'Rejouer une exécution',
  'POST /api/ai': 'Ajouter une connexion IA du Hub {kind, name, instanceId|url, cleRef, model, roles}',
  'PUT /api/ai/:id': 'Modifier une connexion IA du Hub',
  'DELETE /api/ai/:id': 'Retirer une connexion IA du Hub',
  'POST /api/ai/order': 'Ordre des connexions IA',
  'POST /api/ai/:id/test': 'Tester une connexion IA',
  'POST /api/ai/modeles': 'Lister les modèles d’un fournisseur d’IA',
  'PUT /api/destinations': 'Destinations internes autorisées',
  'PUT /api/fuseau': 'Fuseau horaire',
  'POST /api/secrets/test': 'Tester un compte de Clés & API (sans en voir la valeur)',
  'POST /api/secrets/telegram/chats': 'Trouver les discussions d’un bot Telegram',
  'POST /api/secrets/elevenlabs/voix': 'Lister les voix ElevenLabs',
};

export class AccesHub {
  constructor({ router, services = null, audit = null }) { this.router = router; this.services = services; this.audit = audit; }

  /** La règle d'une demande : la route, ses paramètres, et pourquoi elle est refusée s'il y a lieu. */
  regle(action) {
    const m = /^\s*(GET|POST|PUT|PATCH|DELETE)\s+(\/api\/[^\s?#]*)(?:\?(\S*))?\s*$/i.exec(String(action || ''));
    if (!m) return { refus: `« ${String(action || '').slice(0, 80)} » : il faut une méthode et un chemin, par exemple « PUT /api/exposition ».` };
    const methode = m[1].toUpperCase(), chemin = m[2].replace(/\/+$/, '') || '/';
    const requete = Object.fromEntries(new URLSearchParams(m[3] || ''));
    const trouve = this.router.trouver(methode, chemin);
    if (!trouve?.route) return { refus: `${methode} ${chemin} n’existe pas dans le Hub.` };
    const r = trouve.route, o = r.options || {};
    const motif = o.motif || chemin;
    const base = { route: r, methode, chemin, motif, params: trouve.params, requete, options: o, renfort: !!o.renfort, ecrit: !SURES.has(methode) };
    const cle = `${methode} ${chemin}`;
    const interdit = INTERDITS.find(([re]) => re.test(cle));
    if (interdit) return { ...base, refus: interdit[1] };
    if (o.public || o.raw || o.stream) return { ...base, refus: `${methode} ${motif} ne se pilote pas par l’assistant.` };
    if (o.devoiler) return { ...base, refus: `${methode} ${motif} ne se fait que par une personne, après sa vérification.` };
    // Une route qui lit la requête HTTP elle-même (cookies, flux, en-têtes) ne s'appelle pas sans navigateur.
    if (/\bctx\.(req|res|socle|cookies|session)\b/.test(String(r.gestionnaire))) return { ...base, refus: `${methode} ${motif} ne se fait que depuis l’interface.` };
    return base;
  }

  /** Les champs d'identifiant ou de secret d'un corps, où qu'ils soient. */
  champsSensibles(corps, regle) {
    const vus = [];
    const parcourir = (v, ou) => {
      if (!v || typeof v !== 'object') return;
      for (const [k, x] of Object.entries(v)) {
        if (CHAMP_SENSIBLE.test(k) && x !== undefined && x !== '') vus.push(ou ? `${ou}.${k}` : k);
        else parcourir(x, ou ? `${ou}.${k}` : k);
      }
    };
    parcourir(corps, '');
    // Les réglages secrets d'un service (clé d'API, jeton…), déclarés par son manifeste.
    const id = regle?.params?.id;
    if (corps?.config && typeof corps.config === 'object' && this.services) {
      let m = null;
      try { m = id ? this.services.get(id).manifest : null; } catch { m = null; }
      const secrets = new Set((m?.config || []).filter(f => f.type === 'secret').map(f => f.key));
      for (const k of Object.keys(corps.config)) if (secrets.has(k) || CHAMP_SENSIBLE.test(k)) vus.push(`config.${k}`);
    }
    return vus;
  }

  /** Ce qui bloque une demande, avant de la proposer : route, champs, schéma. */
  verifier({ action, corps, requete }) {
    const g = this.regle(action);
    if (g.refus) return { regle: g, problemes: [g.refus] };
    const problemes = [];
    const sensibles = this.champsSensibles(corps, g);
    // Les permissions d'une extension (socket Docker, réseau de l'hôte…) s'acceptent à la main.
    if (corps && typeof corps === 'object' && 'acceptPermissions' in corps) problemes.push('Les permissions d’une extension s’acceptent à la main, à l’installation : je ne les accepte pas pour toi.');
    if (sensibles.length) problemes.push(`${sensibles.join(', ')} : un identifiant ou un secret, que je n’écris jamais. Laisse-le de côté : tu le remplis toi-même.`);
    try { valider({ ...g.requete, ...(requete || {}) }, g.options.requete || {}); } catch (e) { problemes.push(`Adresse : ${e.message}`); }
    if (g.ecrit) { try { valider(corps || {}, g.options.corps || {}); } catch (e) { problemes.push(`Corps : ${e.message}`); } }
    return { regle: g, problemes };
  }

  /**
   * Exécute une route du Hub comme l'administrateur qui a validé le plan.
   * Le rôle exigé et le renfort sont ceux de la route : le renfort a été
   * demandé à l'humain au moment du clic (route d'exécution des plans).
   */
  async appeler({ action, corps, requete }, { acteur, role = 'admin', renfort = false }) {
    const { regle: g, problemes } = this.verifier({ action, corps, requete });
    if (problemes.length) throw new HttpError(403, problemes.join(' '));
    const exige = g.options.role === 'admin' ? 'admin' : g.ecrit ? 'membre' : 'lecture';
    const rang = { lecture: 0, membre: 1, admin: 2 };
    if ((rang[role] ?? -1) < rang[exige]) throw new HttpError(403, `${g.methode} ${g.motif} demande un compte ${exige}.`);
    if (g.renfort && !renfort) throw new HttpError(403, `${g.methode} ${g.motif} demande de confirmer ton identité au moment de valider.`);
    const ctx = {
      params: g.params,
      query: valider({ ...g.requete, ...(requete || {}) }, g.options.requete || {}),
      body: g.ecrit ? valider(corps || {}, g.options.corps || {}) : undefined,
      user: `${acteur} (assistant)`, compte: { role }, ip: 'assistant',
      vivante: () => true, json() {},
    };
    const out = await g.route.gestionnaire(ctx);
    // Chaque écriture de l'assistant au journal, au nom de qui l'a validée, même quand la route ne journalise pas.
    if (g.ecrit) { this.audit?.write(ctx.user, 'ia.hub', `${g.methode} ${g.motif}`, { params: g.params }); this.apresEcriture?.(g); }
    return masquer(out);
  }

  /** Le catalogue pour le modèle : ce qu'il peut faire, en une ligne par route. */
  catalogue() {
    const lignes = [];
    for (const r of this.router.routes) {
      const o = r.options || {};
      if (!o.motif || SURES.has(r.methode)) continue;
      const exemple = o.motif.replace(/:([a-zA-Z_]+)/g, 'x');
      const g = this.regle(`${r.methode} ${exemple}`);
      if (g.refus) continue;
      const noms = Object.keys(o.corps || {}).filter(k => !CHAMP_SENSIBLE.test(k) && k !== 'acceptPermissions');
      const champs = noms.length ? ` {${noms.join(', ')}}` : '';
      lignes.push(`${r.methode} ${o.motif}${champs}${LIBELLES[`${r.methode} ${o.motif}`] ? ` — ${LIBELLES[`${r.methode} ${o.motif}`].replace(/ \{.*\}$/, '')}` : ''}`);
    }
    return lignes;
  }
  lectures() {
    return this.router.routes.filter(r => r.methode === 'GET' && r.options?.motif && !this.regle(`GET ${r.options.motif.replace(/:([a-zA-Z_]+)/g, 'x')}`).refus).map(r => r.options.motif);
  }
}

/** Ce qui part chez le modèle : sans identifiant ni secret, et pas un roman. */
export function masquer(v, profondeur = 0) {
  if (profondeur > 12 || v == null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.slice(0, 200).map(x => masquer(x, profondeur + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = CHAMP_SENSIBLE.test(k) && x !== '' && x != null && typeof x !== 'boolean' ? '•••' : masquer(x, profondeur + 1);
  return out;
}
