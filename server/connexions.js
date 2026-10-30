// Connexions : les noms sous lesquels on joint les services, tenus par Relay
// (l'extension qui fournit la capacité edge.routes). Le Hub lui parle avec son
// propre jeton : routes et publication des services, jamais les comptes de
// Relay, ses jetons de services ni ses réglages (Cloudflare, Telegram).
//
// Quand Relay est là, chaque service installé ici reçoit son nom
// (<service>.<domaine de base>) au déploiement, avant que ses conteneurs ne
// démarrent : il connaît ainsi son adresse publique (liens des courriels) et
// le relais qu'il peut croire (SOCLE_PROXYS).
import { HttpError, log } from './util/common.js';
import { containerName } from './runtime.js';
import { docker } from './docker.js';
import { config } from './config.js';

export const CAPACITE = 'edge.routes';
// Le Hub lui-même, pour Relay : un « service » à part, que nul nom d'instance ne peut prendre.
export const SERVICE_HUB = 'le-hub';
const NOM = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DOMAINE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

// Le port qu'on publie d'un service : le premier en HTTP qu'il propose au relais.
export function portPublie(m) {
  return (m.install?.ports || []).find(p => p.expose === 'proxy' && /^https?$/.test(p.protocol)) || null;
}

/*
 * Exposer sur Internet un service dont le premier compte se crée sans
 * preuve (« Premier lancement : crée ton compte administrateur »), c'est
 * donner l'administration au premier robot qui passe : les noms publiés se
 * lisent dans les journaux de certificats en quelques minutes. Seul un
 * service dont le premier compte demande le jeton d'installation (socle) ou
 * que le Hub administre (comptes) sort du réseau local.
 */
export function premierCompteProtege(m) {
  return !!m?.accounts || (m?.config || []).some(f => f.key === 'SOCLE_JETON_INSTALLATION');
}
const SUR_INTERNET = new Set(['public', 'cloudflare']);

export class Connexions {
  // hubEnTls : le Hub sert HTTPS lui-même (Caddy le joint alors en https://hub:8100).
  // surRelais(ip) : appelé quand l'adresse de Caddy change, pour que le Hub la croie.
  constructor({ services, runtime, audit, db, hubEnTls = false, surRelais = () => {} }) { Object.assign(this, { services, runtime, audit, db, hubEnTls, surRelais }); }

  relay() { return this.services.providersOf(CAPACITE)[0] || null; }
  exiger() {
    const r = this.relay();
    if (!r) throw new HttpError(409, 'Relay n’est pas installé : ajoute-le depuis Extensions pour gérer les connexions.');
    return r;
  }

  async appel(methode, chemin, corps) {
    const r = this.exiger();
    try {
      return await this.runtime.request(r, { method: methode, path: chemin, ...(corps !== undefined ? { body: corps } : {}) }, { brut: true, timeout: 20000 });
    } catch (e) {
      // Un refus de Relay (nom pris, saisie invalide) garde son statut et son message.
      if (e.upstreamStatus && e.upstreamStatus < 500) throw new HttpError(e.upstreamStatus, String(e.message).replace(/^.*? a répondu \d+ : /, ''));
      throw e;
    }
  }

  /** Les routes de Relay, et pour chaque service installé ici, son nom s'il en a un. */
  async etat() {
    const r = this.relay();
    if (!r) return { relay: null };
    let e = null, erreur = null;
    try { e = await this.appel('GET', '/api/etat'); } catch (x) { erreur = r.status === 'installing' ? `${r.name} redémarre : recharge la page dans un instant.` : x.message; }
    const routes = e?.routes || [];
    const services = this.services.list().filter(i => i.mode === 'compose').map(i => {
      const p = portPublie(i.manifest);
      return {
        id: i.id, nom: i.name, extension: i.manifest.name, icone: i.manifest.icon, statut: i.status,
        cible: p ? `${containerName(i)}:${p.container}` : null,
        routes: routes.filter(x => x.proprietaire === `hub:${i.name}`).map(x => x.hote),
        // Sur Internet seulement si le premier compte demande le lien d'installation.
        internet: premierCompteProtege(i.manifest),
      };
    });
    return {
      relay: { nom: r.name, statut: r.status, extension: r.manifest.name },
      erreur, routes, services,
      hub: { routes: routes.filter(x => x.proprietaire === `hub:${SERVICE_HUB}`).map(x => x.hote) },
      domaines: e?.domaines || [], caddy: e?.caddy || null, cloudflare: !!e?.cloudflare,
      // L'adresse où mènent les noms : le résolveur de Relay y écoute.
      ip: e?.ip || null,
      // Les zones du compte Cloudflare connecté : leurs noms sont publiés et certifiés sans rien sur les appareils.
      zonesCloudflare: e?.zonesCloudflare || [],
    };
  }

  /**
   * Publier un service installé ici : <nom>.<domaine> vers son conteneur.
   * Idempotent ; le nom pris par une autre route est refusé par Relay.
   */
  async publier(idOuNom, { sousDomaine, hote, mode = 'local' } = {}, acteur = 'hub') {
    const inst = this.services.get(idOuNom);
    if (inst.mode !== 'compose') throw new HttpError(400, `${inst.name} tourne ailleurs : ajoute sa route à la main avec son adresse.`);
    const p = portPublie(inst.manifest);
    if (!p) throw new HttpError(400, `${inst.manifest.name} ne propose aucune interface web à publier.`);
    if (sousDomaine && !NOM.test(sousDomaine)) throw new HttpError(400, 'Sous-domaine : lettres minuscules, chiffres et tirets.');
    if (SUR_INTERNET.has(mode) && !premierCompteProtege(inst.manifest)) {
      throw new HttpError(409, `${inst.manifest.name} ${inst.version} crée son premier compte administrateur sans lien ni jeton : sur Internet, le premier venu le prendrait. Il reste en local — mets-le à jour vers une version qui demande le lien d’installation.`);
    }
    const out = await this.appel('PUT', '/api/hub/publication', {
      service: inst.name, cible: `${containerName(inst)}:${p.container}`, mode,
      ...(hote ? { hote } : { sousDomaine: sousDomaine || inst.name }), nom: inst.manifest.name,
    });
    this.retenir(inst.id, out.url);
    this.audit.write(acteur, 'connexion.publiee', inst.name, { url: out.url, mode });
    return out;
  }

  /**
   * Le Hub lui-même derrière Relay : son nom (local, public ou par le tunnel)
   * vers son conteneur. Exposé sur Internet, il ne tient plus qu'à ses comptes :
   * la page le dit avant de publier.
   */
  async publierHub({ sousDomaine = 'hub', hote, mode = 'local' } = {}, acteur = 'hub') {
    if (sousDomaine && !NOM.test(sousDomaine)) throw new HttpError(400, 'Sous-domaine : lettres minuscules, chiffres et tirets.');
    const out = await this.appel('PUT', '/api/hub/publication', {
      service: SERVICE_HUB, cible: this.hubEnTls ? `https://hub:${config.port}` : `hub:${config.port}`, mode,
      ...(hote ? { hote } : { sousDomaine }), nom: 'Hub',
    });
    this.retenir(SERVICE_HUB, out.url);
    this.audit.write(acteur, 'connexion.hub_publie', 'hub', { url: out.url, mode });
    return out;
  }
  async depublierHub(acteur = 'hub') {
    const out = await this.appel('DELETE', `/api/hub/publication?service=${SERVICE_HUB}`);
    this.retenir(SERVICE_HUB, null);
    this.audit.write(acteur, 'connexion.hub_retire', 'hub', { routes: out.retirees });
    return out;
  }

  /**
   * Les domaines enregistrés, n'importe lesquels (home.arpa, le sien, lab.le-sien…).
   * Le premier est celui des noms posés d'office. Un domaine retiré emporte
   * les noms que le Hub y avait posés vers le nouveau premier ; ceux posés à
   * la main restent tels quels.
   */
  async poserDomaines(liste = [], acteur = 'hub') {
    const domaines = [];
    for (const brut of liste) {
      const d = String(brut || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
      if (!DOMAINE.test(d)) throw new HttpError(400, `${String(brut).slice(0, 80) || 'Domaine vide'} : un nom comme home.arpa ou exemple.fr, sans http:// ni chemin.`);
      if (!domaines.includes(d)) domaines.push(d);
    }
    if (domaines.length > 20) throw new HttpError(400, 'Vingt domaines au plus.');
    const e = await this.appel('GET', '/api/etat');
    const anciens = e.domaines || [];
    await this.appel('PUT', '/api/reglages/general', { domaines });
    this.audit.write(acteur, 'connexion.domaines', 'relay', { domaines });
    const deplaces = { faits: [], erreurs: [], services: [] };
    if (domaines.length) {
      for (const ancien of anciens.filter(d => !domaines.includes(d))) {
        const r = await this.rebaser(e.routes || [], ancien, acteur);
        for (const k of Object.keys(deplaces)) deplaces[k].push(...r[k]);
      }
    }
    return { domaines, deplaces, publies: domaines.length ? await this.publierTous(acteur) : { faits: [], erreurs: [] } };
  }

  /** Le jeton Cloudflare, transmis à Relay qui le scelle : le Hub ne le garde pas. */
  async connecterCloudflare(jeton, acteur = 'hub') {
    const out = await this.appel('PUT', '/api/hub/cloudflare', { jeton });
    this.audit.write(acteur, 'connexion.cloudflare', 'relay', { zones: out.zones });
    return out;
  }
  async deconnecterCloudflare(acteur = 'hub') {
    // Sans jeton d'API, plus rien ne règlerait le tunnel : son connecteur s'arrête avec.
    this.arreterConnecteur(this.exiger(), acteur);
    const out = await this.appel('DELETE', '/api/hub/cloudflare');
    this.audit.write(acteur, 'connexion.cloudflare_retire', 'relay');
    return out;
  }

  // ---- le tunnel Cloudflare : choisi ou créé par Relay, son connecteur
  // (cloudflared) lancé dans la pile de Relay avec le jeton que Relay rend ----
  /** Relay installé ici, dans une version qui porte le connecteur (jeton scellé, interrupteur). */
  avecConnecteur(r) {
    const champs = r.manifest.config || [];
    return r.mode === 'compose' && champs.some(f => f.key === 'TUNNEL_TOKEN' && f.type === 'secret') && champs.some(f => f.key === 'TUNNEL_ACTIF');
  }
  connecteurEnMarche(r) {
    try { return this.avecConnecteur(r) && String(this.services.configOf(r).TUNNEL_ACTIF) === '1'; } catch { return false; }
  }
  async tunnel() {
    const r = this.relay();
    if (!r) return { relay: null };
    if (r.mode !== 'compose') return { distant: true };
    if (!this.avecConnecteur(r)) return { ancien: true };
    const enMarche = this.connecteurEnMarche(r);
    let t;
    try { t = await this.appel('GET', '/api/hub/cloudflare/tunnel'); } catch (e) { return { connecteur: enMarche, erreur: e.message }; }
    // Seuls ces champs vont au navigateur.
    return {
      connecteur: enMarche, connecte: !!t.connecte, actif: !!t.actif, erreur: t.erreur || null,
      compte: t.compte ? { id: String(t.compte.id), nom: String(t.compte.nom || '') } : null,
      tunnel: t.tunnel ? { id: String(t.tunnel.id), nom: String(t.tunnel.nom || '') } : null,
      tunnels: (t.tunnels || []).map(x => ({ id: String(x.id), nom: String(x.nom), etat: String(x.etat || ''), choisissable: x.choisissable !== false })),
    };
  }
  async activerTunnel({ tunnel, nom } = {}, acteur = 'hub') {
    const r = this.exiger();
    if (r.mode !== 'compose') throw new HttpError(409, `${r.name} tourne sur une autre machine : règle son tunnel depuis son interface, où tourne son connecteur.`);
    if (!this.avecConnecteur(r)) throw new HttpError(409, `Mets d’abord ${r.name} à jour (2.2.0 ou plus) : son connecteur de tunnel y est arrivé.`);
    if (!tunnel === !nom) throw new HttpError(400, 'Choisis un tunnel existant, ou donne le nom d’un nouveau.');
    const out = await this.appel('PUT', '/api/hub/cloudflare/tunnel', tunnel ? { tunnel } : { nom });
    if (typeof out?.jeton !== 'string' || !/^[A-Za-z0-9+/=_-]{32,4096}$/.test(out.jeton) || !out.tunnel?.id || !out.tunnel?.nom) {
      throw new HttpError(502, `${r.name} n’a pas rendu de jeton de connecteur valable.`);
    }
    this.services.updateConfig(r.id, { TUNNEL_TOKEN: out.jeton, TUNNEL_ACTIF: '1' }, acteur);
    this.audit.write(acteur, 'connexion.tunnel', 'relay', { tunnel: String(out.tunnel.nom) });
    this.relancer(r, acteur);
    return { tunnel: { id: String(out.tunnel.id), nom: String(out.tunnel.nom) }, republiees: out.republiees?.faits?.length || 0 };
  }
  /**
   * Couper : d'abord le connecteur, ici (sans Cloudflare ni Relay, rien ne
   * l'arrêterait sinon), son jeton effacé ; puis Relay retire les noms du
   * tunnel. Un Relay muet n'empêche pas la coupure : il est dit, pas bloquant.
   */
  async couperTunnel(acteur = 'hub') {
    const r = this.exiger();
    this.arreterConnecteur(r, acteur);
    let retirees = 0, avertissement = null;
    try { const out = await this.appel('DELETE', '/api/hub/cloudflare/tunnel'); retirees = out?.retirees?.faits?.length || 0; } catch (e) { avertissement = `Connecteur arrêté, mais ${r.name} n’a pas retiré les noms du tunnel : ${e.message}`; }
    this.audit.write(acteur, 'connexion.tunnel_coupe', 'relay', { retirees });
    return { actif: false, retirees, ...(avertissement ? { avertissement } : {}) };
  }
  arreterConnecteur(r, acteur) {
    if (!this.avecConnecteur(r)) return;
    const enMarche = this.connecteurEnMarche(r);
    this.services.updateConfig(r.id, { TUNNEL_ACTIF: '0' }, acteur);
    this.services.effacerSecret(r.id, 'TUNNEL_TOKEN', acteur);
    if (enMarche) this.relancer(r, acteur);
  }
  // Relay redéployé en tâche de fond : sa pile lance (ou arrête) le connecteur.
  relancer(r, acteur) {
    setImmediate(() => this.services.redeploy(r.id, acteur)
      .catch(e => log.warn('connexions', `${r.name} : redéploiement pour le tunnel impossible — ${e.message}`)));
  }
  /**
   * Chaque nom posé par le Hub pour un service passe par le tunnel : joignable
   * de partout, sans port ouvert. Jamais celui du Hub : l'exposer sur
   * Internet se décide à part, avec son avertissement (Publier le Hub).
   */
  aPasserAuTunnel(routes) {
    return (routes || []).filter(x => x.proprietaire?.startsWith('hub:') && x.proprietaire !== `hub:${SERVICE_HUB}` && !x.cf);
  }
  async toutParLeTunnel(acteur = 'hub') {
    const e = await this.appel('GET', '/api/etat');
    const faits = [], erreurs = [];
    for (const r of this.aPasserAuTunnel(e.routes)) {
      const service = r.proprietaire.slice(4);
      const inst = this.services.list().find(i => i.name === service);
      if (inst && !premierCompteProtege(inst.manifest)) { erreurs.push({ hote: r.hote, erreur: `${inst.manifest.name} reste en local : son premier compte se crée sans lien d’installation` }); continue; }
      try {
        const out = await this.publier(service, { hote: r.hote, mode: 'cloudflare' }, acteur);
        faits.push(r.hote);
        if (out.avertissement) erreurs.push({ hote: r.hote, erreur: out.avertissement });
      } catch (x) { erreurs.push({ hote: r.hote, erreur: x.message }); }
    }
    for (const hote of await this.rappelerNonProteges(acteur)) erreurs.push({ hote, erreur: 'remis en local : premier compte sans lien d’installation' });
    return { faits, erreurs };
  }

  /**
   * Ce qui est déjà sur Internet sans premier compte protégé repasse en
   * local : au démarrage et après « tout par le tunnel ». Le nom reste, il
   * ne mène plus qu'au réseau de la maison.
   */
  async rappelerNonProteges(acteur = 'hub') {
    if (!this.relay()) return [];
    let e; try { e = await this.appel('GET', '/api/etat'); } catch { return []; }
    const rappeles = [];
    for (const r of e.routes || []) {
      if (!r.proprietaire?.startsWith('hub:') || r.proprietaire === `hub:${SERVICE_HUB}` || !(r.cf || r.mode === 'public')) continue;
      const inst = this.services.list().find(i => i.name === r.proprietaire.slice(4));
      if (!inst || premierCompteProtege(inst.manifest)) continue;
      try {
        await this.publier(inst.id, { hote: r.hote, mode: 'local' }, acteur);
        rappeles.push(r.hote);
        this.audit.write(acteur, 'connexion.exposition_retiree', r.hote, { service: inst.name, raison: 'premier compte sans lien d’installation' });
      } catch (x) { log.warn('connexions', `${r.hote} : retour en local impossible — ${x.message}`); }
    }
    return rappeles;
  }

  /** Les noms posés par le Hub sous un domaine retiré, reposés sous le premier (le nouveau d'abord, puis l'ancien retiré). */
  async rebaser(routes, ancien, acteur = 'hub') {
    const faits = [], erreurs = [], services = [];
    for (const r of routes.filter(x => x.proprietaire?.startsWith('hub:') && x.hote.endsWith(`.${ancien}`))) {
      const service = r.proprietaire.slice(4), sousDomaine = r.hote.slice(0, -(ancien.length + 1));
      if (!NOM.test(sousDomaine)) continue;
      const mode = r.cf ? 'cloudflare' : r.mode;
      try {
        const out = service === SERVICE_HUB ? await this.publierHub({ sousDomaine, mode }, acteur) : await this.publier(service, { sousDomaine, mode }, acteur);
        await this.appel('DELETE', `/api/hub/publication?service=${encodeURIComponent(service)}&hote=${encodeURIComponent(r.hote)}`);
        faits.push(out.url);
        if (service !== SERVICE_HUB) services.push(service);
      } catch (x) { erreurs.push({ service, erreur: x.message }); }
    }
    return { faits, erreurs, services };
  }

  /** Chaque service installé ici qui n'a pas encore de nom en reçoit un (après le choix du domaine). */
  async publierTous(acteur = 'hub') {
    const e = await this.etat();
    const faits = [], erreurs = [];
    for (const s of (e.services || []).filter(x => x.cible && !x.routes.length)) {
      try { faits.push((await this.publier(s.id, {}, acteur)).url); } catch (x) { erreurs.push({ service: s.nom, erreur: x.message }); }
    }
    return { faits, erreurs };
  }

  /**
   * Les routes que Relay tient pour ce service : [{ hote, mode }]. Rien sans
   * Relay ; Relay installé mais muet est une erreur : les routes ne
   * pourraient pas suivre un changement de nom.
   */
  async routesDe(nom) {
    const r = this.relay();
    if (!r) return [];
    let e;
    try { e = await this.appel('GET', '/api/etat'); }
    catch (x) { throw new HttpError(409, `Relay ne répond pas (${x.message}) : les routes de ${nom} ne pourraient pas suivre son nouveau nom. Réessaie quand il est en ligne.`); }
    return (e.routes || []).filter(x => x.proprietaire === `hub:${nom}`).map(x => ({ hote: x.hote, mode: x.cf ? 'cloudflare' : x.mode }));
  }

  /**
   * Un service change de nom : chacune de ses routes passe au nouveau, avec
   * son mode (local, public, tunnel). <ancien>.<domaine> devient
   * <nouveau>.<domaine> ; un nom choisi à la main reste le même. Rend ce qui
   * a été fait, pour pouvoir le défaire.
   */
  async renommerRoutes(instId, ancien, nouveau, routes, acteur = 'hub') {
    const faites = [];
    for (const r of routes) {
      const vers = r.hote.startsWith(`${ancien}.`) ? `${nouveau}.${r.hote.slice(ancien.length + 1)}` : r.hote;
      await this.deplacerRoute(instId, { service: ancien, hote: r.hote }, { service: nouveau, hote: vers }, r.mode, acteur);
      faites.push({ de: r.hote, vers, mode: r.mode });
    }
    return faites;
  }
  async annulerRenommage(instId, ancien, nouveau, faites, acteur = 'hub') {
    for (const r of [...faites].reverse()) await this.deplacerRoute(instId, { service: nouveau, hote: r.vers }, { service: ancien, hote: r.de }, r.mode, acteur);
  }
  /* Un même nom ne peut appartenir qu'à une route : il est libéré avant
     d'être repris. Un nom qui change est posé d'abord, l'ancien retiré ensuite. */
  async deplacerRoute(instId, de, vers, mode, acteur) {
    const retirer = () => this.appel('DELETE', `/api/hub/publication?service=${encodeURIComponent(de.service)}&hote=${encodeURIComponent(de.hote)}`);
    if (de.hote === vers.hote) { await retirer(); await this.publier(instId, { hote: vers.hote, mode }, acteur); }
    else { await this.publier(instId, { hote: vers.hote, mode }, acteur); await retirer(); }
  }

  async depublier(idOuNom, acteur = 'hub') {
    const inst = this.services.get(idOuNom);
    const out = await this.appel('DELETE', `/api/hub/publication?service=${encodeURIComponent(inst.name)}`);
    this.retenir(inst.id, null);
    this.audit.write(acteur, 'connexion.retiree', inst.name, { routes: out.retirees });
    return out;
  }

  // L'adresse publiée de chaque service, gardée pour le Compose (SOCLE_URL_PUBLIQUE)
  // et les liens « Ouvrir ».
  publications() { return this.db.setting('publications', {}) || {}; }
  retenir(instId, url) {
    const p = { ...this.publications() };
    if (url) p[instId] = url; else delete p[instId];
    this.db.setSetting('publications', p);
  }

  /**
   * Au déploiement d'un service : son nom, s'il n'en a pas encore, quand Relay
   * est en ligne et qu'un domaine de base est posé. Jamais bloquant : un
   * service se déploie aussi quand Relay est absent ou muet.
   */
  async auDeploiement(inst, progres = () => {}) {
    const r = this.relay();
    // Relay lui-même aussi : son interface passe par son propre Caddy, une fois en ligne.
    if (!r || r.status !== 'online' || inst.mode !== 'compose' || !portPublie(inst.manifest)) return null;
    try {
      const e = await this.appel('GET', '/api/etat');
      const sienne = e.routes.find(x => x.proprietaire === `hub:${inst.name}`);
      if (sienne) { this.retenir(inst.id, `${sienne.mode === 'clair' && !sienne.cf ? 'http' : 'https'}://${sienne.hote}`); return null; }
      if (!e.domaines?.length) { progres(`Pas de domaine de base dans Relay : ${inst.name} n’a pas de nom (Connexions pour en poser un).`); return null; }
      const out = await this.publier(inst.id, {}, 'hub');
      progres(`Publié sur ${out.url}`);
      return out.url;
    } catch (e) { progres(`Nom non posé dans Relay : ${e.message}`); return null; }
  }

  /** Au retrait d'un service : ses routes partent avec lui. */
  async auRetrait(inst) {
    const r = this.relay();
    if (!r || r.id === inst.id) return;
    try { await this.depublier(inst.id); } catch (e) { log.warn('connexions', `${inst.name} : routes non retirées de Relay — ${e.message}`); }
  }

  /**
   * L'adresse de Caddy sur le réseau du Hub : les services la croient quand
   * elle leur dit qu'une requête est arrivée en HTTPS (SOCLE_PROXYS). Relevée
   * après chaque déploiement de Relay ; rend vrai si elle a changé.
   */
  async releverRelais() {
    const r = this.relay();
    let ip = '';
    if (r?.mode === 'compose') { try { ip = await docker.ipSurReseau(`${containerName(r)}-caddy`, config.dockerNetwork); } catch { ip = ''; } }
    const avant = this.db.setting('relais_ip', '');
    if (ip === avant) return false;
    this.db.setSetting('relais_ip', ip);
    this.surRelais(ip);
    return true;
  }
  /** Les relais qu'un service doit croire : les siens, plus Caddy de Relay. */
  proxysPour(cfg) {
    const ip = this.db.setting('relais_ip', '');
    const siens = String(cfg.SOCLE_PROXYS || '').split(',').map(s => s.trim()).filter(Boolean);
    return [...new Set([...siens, ...(ip ? [`${ip}/32`] : [])])].join(',');
  }
}
