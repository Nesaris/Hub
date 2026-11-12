// Point d'entrée du Hub.
import dns from 'node:dns';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, SPEC_HUB, REGLAGES_HUB, lireConfigHub } from './config.js';
import { openDb } from './db/index.js';
import { Vault, tournerCle } from './vault.js';
import { Audit } from './audit.js';
import { Registry } from './registry.js';
import { Adaptation } from './adaptation.js';
import { Services } from './services.js';
import { Runtime } from './runtime.js';
import { Capabilities } from './capabilities.js';
import { WorkflowStore } from './workflows/store.js';
import { Engine } from './workflows/engine.js';
import { Triggers } from './triggers.js';
import { Probes } from './probes.js';
import { AiGateway } from './ai/gateway.js';
import { Accounts } from './accounts.js';
import { Destinations } from './destinations.js';
import { Quotas } from './quotas.js';
import { purgerDonnees } from './retention.js';
import { Mesures } from './mesures.js';
import { Secrets } from './secrets.js';
import { poserFuseau } from './manifest/template.js';
import { Logos } from './logos.js';
import { Voix } from './voix.js';
import { Memoire } from './ai/memoire.js';
import { CerveauHub } from './ai/cerveau.js';
import { JournalHub } from './ai/journal.js';
import { Agent } from './ai/agent.js';
import { Router, createServer } from './http/server.js';
import { lireTls } from './http/tls.js';
import { Connexions } from './connexions.js';
import { demarrerSocle, etendreEnv, lireNouveautes, listeConfiance } from '../socle/src/index.js';
import { migrerComptes } from './migration-socle.js';
import { Jetons } from './auth/jetons.js';
import { registerRoutes } from './http/api.js';
import { Alertes } from './alertes.js';
import { IaServices } from './ia-services.js';
import { AccesHub } from './acces-hub.js';
import { LiensHub } from './liens-hub.js';
import { log } from './util/common.js';
import { CLE_HUB, gammePour, reglageTheme } from './theme.js';

/* IPv4 d'abord. Sur un réseau sans vraie sortie IPv6 (le cas de la plupart
   des box et des réseaux Docker), Node prenait l'adresse IPv6 que le DNS
   donne en premier : l'appel partait dans le vide et finissait en
   « fetch failed » au bout de dix secondes. Telegram, Discord, ntfy et
   toute API extérieure tombaient ainsi en silence. Une machine qui a
   l'IPv6 garde l'IPv4 : rien ne se perd. */
dns.setDefaultResultOrder('ipv4first');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Signalement d'une faille : l'exploitant de l'instance le pose dans
// SOCLE_CONTACT_SECURITE ; sans lui, /.well-known/security.txt n'est pas servi.
// Où signaler une faille (/.well-known/security.txt) ; SOCLE_CONTACT_SECURITE le remplace.
const SERVICE = { id: 'hub', nom: 'Hub', contactSecurite: 'https://github.com/CodexX64/hub/security/advisories/new' };
// Les lignes du journal de sécurité partent sur la sortie standard quel que
// soit HUB_LOG_LEVEL : les journaux du conteneur les gardent hors de portée du Hub.
const JOURNAL_SOCLE = {
  info: (...a) => (typeof a[0] === 'string' && a[0].startsWith('{"journal"') ? console.log(a[0]) : log.info(...a)),
  warn: (...a) => log.warn(...a), error: (...a) => log.error(...a),
};

/** Les clés d'accès créées sans domaine connu, quand seul localhost pouvait les recevoir. */
export function rattacherClesAnciennes(db, env) {
  if (String(env.SOCLE_PROXYS || '').trim()) return 0;
  return Number(db.prepare("UPDATE socle_cles SET rp = 'localhost' WHERE rp IS NULL").run().changes);
}

export async function buildHub({ dbFile = path.join(config.dataDir, 'hub.db'), dataDir = config.dataDir, env = process.env, tls = null } = {}) {
  const bus = new EventEmitter();
  bus.setMaxListeners(200);
  const db = openDb(dbFile);
  const vault = new Vault(dataDir, { cle: config.cle, ancienne: config.cleAncienne });
  const audit = new Audit(db, bus);
  const tour = tournerCle({ db, vault, audit });
  if (tour && vault.precedente) {
    log.info('coffre', `clé tournée : ${tour.rescelles} secret(s) rescellé(s)${tour.illisibles ? `, ${tour.illisibles} illisible(s) avec les deux clés (${Object.keys(tour.tables).join(', ')})` : ''}. Vide le fichier hub_cle_ancienne.`);
  } else if (vault.precedente) log.warn('coffre', 'la base est déjà sous HUB_CLE : vide le fichier hub_cle_ancienne.');
  else if (tour?.illisibles) log.warn('coffre', `${tour.illisibles} secret(s) illisible(s) avec HUB_CLE (${Object.keys(tour.tables).join(', ')})`);
  const origines = config.uiOrigin ? [config.uiOrigin] : [];
  const socle = await demarrerSocle({
    service: SERVICE, db, dossier: dataDir, log: JOURNAL_SOCLE,
    env: origines.length ? etendreEnv(env, { SOCLE_ORIGINES: [env.SOCLE_ORIGINES, ...origines].filter(Boolean).join(',') }) : env,
    assistant: { reglages: REGLAGES_HUB, spec: SPEC_HUB, version: config.version, controler: lireConfigHub },
    version: config.version, nouveautes: lireNouveautes(path.join(ROOT, 'nouveautes.json')),
    migrer: ({ comptes, coffre }) => migrerComptes({ db, comptes, coffre, log }),
  });
  // Avant 0.7.3, sans relais HTTPS déclaré, le seul contexte sûr où créer une
  // clé d'accès était localhost (le tunnel SSH) : les clés d'alors y sont
  // liées. Le dire au socle évite qu'il les exige sur la nouvelle adresse,
  // où le navigateur ne les présentera jamais.
  const rattachees = rattacherClesAnciennes(db, env);
  if (rattachees) log.info('comptes', `${rattachees} clé(s) d’accès d’avant HTTPS rattachée(s) à localhost`);
  const jetons = new Jetons(db, audit);
  const quotas = new Quotas(db);
  // Les questions d'un compte supprimé partent avec lui, ses quotas aussi ;
  // l'export de ses données les lui rend.
  socle.comptes.apresSuppression.push(id => {
    db.run('DELETE FROM agent_plans WHERE compte = ?', id);
    db.run("DELETE FROM quotas WHERE substr(cle, instr(cle, ':') + 1) = ?", `compte:${id}`);
  });
  socle.portail.exporteur = async id => ({
    questions: db.all('SELECT created, request, status FROM agent_plans WHERE compte = ? ORDER BY created', id),
  });
  const registry = new Registry({ db, audit, bus });
  const services = new Services({ db, vault, audit, bus, registry });
  const destinations = new Destinations({ db, audit, services, registry });
  const runtime = new Runtime({ services });
  const store = new WorkflowStore({ db, vault, audit, bus, services });
  const capabilities = new Capabilities({ db, bus, audit, services, store });
  // Le Hub croit Caddy de Relay comme les services : l'adresse du client et
  // le HTTPS qu'il annonce, quand le Hub est publié derrière lui.
  const croireRelais = ip => {
    const l = [...socle.cfg.proxys, ...(ip ? [`${ip}/32`] : [])];
    socle.portail.proxys = l.length ? listeConfiance(l) : null;
  };
  const connexions = new Connexions({ services, runtime, audit, db, hubEnTls: !!tls, surRelais: croireRelais });
  croireRelais(db.setting('relais_ip', ''));
  services.attach({ runtime, capabilities, connexions });
  const ai = new AiGateway({ db, vault, audit, services });
  capabilities.attach({ ai });
  // Les dépôts sans manifeste, rendus compatibles par l'IA quand leur licence le permet.
  const adaptation = new Adaptation({ db, audit, bus, registry, ai });
  registry.adaptation = adaptation;
  // L'IA du Hub pour les services : toutes les IA de la page IA, derrière une API Ollama / OpenAI.
  const iaServices = new IaServices({ db, ai, services, audit, quotas });
  services.iaServices = iaServices;
  runtime.iaServices = iaServices;
  // Les connexions du Hub (IA, noms publiés, tunnel, alertes, courriel), en liens visibles.
  const liens = new LiensHub({ db, store, services, ai, audit, connexions });
  const engine = new Engine({ db, audit, bus, store, services, runtime, ai, vault });
  const triggers = new Triggers({ db, bus, audit, store, engine, services, runtime, vault });
  store.attach({ triggers });
  try { const n = destinations.reprendre(); if (n.length) log.info('destinations', `${n.length} destination(s) interne(s) reprise(s) des workflows`); } catch (e) { log.warn('destinations', e.message); }
  try { const n = store.remettreEnPlace(); if (n) log.info('workflows', `${n} workflow(s) mal disposé(s) remis en place`); } catch (e) { log.warn('workflows', 'mise en place', e.message); }
  const probes = new Probes({ db, bus, services, runtime });
  const mesures = new Mesures({ db, services, dossier: config.mesureDir });
  const accounts = new Accounts({ services, runtime, audit, comptes: socle.comptes, db, vault });
  const secrets = new Secrets({ db, vault, audit });
  poserFuseau(db.setting('fuseau', '') || config.fuseau);
  ai.attach({ secrets });
  // Les images de l'ancienne page Paiements, si elle a servi : elles partent avec elle.
  try { fs.rmSync(path.join(dataDir, 'cartes'), { recursive: true, force: true }); } catch { /* rien à retirer */ }
  const logos = new Logos({ dir: path.join(dataDir, 'logos') });
  const memoire = new Memoire({ services, runtime, audit, db });
  const cerveau = new CerveauHub({ services, runtime, store, db, ai });
  const journal = new JournalHub({ bus, services, runtime });
  const agent = new Agent({ db, audit, bus, ai, registry, services, store, engine, probes, secrets, runtime, memoire, capabilities, connexions });
  const voix = new Voix({ services, runtime, registry, secrets, store });
  agent.voix = voix;   // « connecte VOX à ElevenLabs » : l'assistant le fait lui-même
  // Les alertes du Hub sur Telegram ; un bouton reçu pendant une écoute de l'assistant leur revient.
  const alertes = new Alertes({ db, bus, audit, services, ai, agent });
  agent.surRappel = cq => alertes.rappel(cq);
  const hub = { db, bus, vault, audit, socle, jetons, registry, adaptation, destinations, services, runtime, store, capabilities, ai, engine, triggers, probes, mesures, agent, accounts, connexions, secrets, memoire, logos, voix, cerveau, journal, alertes, liens };
  const router = new Router();
  registerRoutes(router, hub);
  hub.router = router;
  // L'assistant agit par les routes de l'interface, avec leurs règles (acces-hub.js).
  const accesHub = new AccesHub({ router, services, audit });
  accesHub.apresEcriture = () => liens.planifier();
  agent.accesHub = accesHub;
  hub.accesHub = accesHub;
  hub.server = createServer({ router, socle, jetons, quotas, webDir: path.join(ROOT, 'web'), socleWebDir: path.join(ROOT, 'socle', 'web'), gamme: () => gammePour(reglageTheme(db), CLE_HUB), tls, apresEcriture: () => liens.planifier(), version: config.version });

  const timers = [];
  hub.startBackground = async () => {
    engine.resume();
    await triggers.activateAll();
    // Workflows automatiques : passer par l'IA du Hub quand il en a une.
    try {
      const faits = [...capabilities.rejouerIA().map(w => w.name), ...await capabilities.versIADuHub()];
      if (faits.length) log.info('IA du Hub :', faits.join(', '));
    } catch (e) { log.warn('IA du Hub', e.message); }
    // L'IA que chaque service a choisie, en lien visible dans Workflows.
    await capabilities.refleterToutIA();
    await liens.reconcilier();
    // Ce qui est sur Internet sans premier compte protégé repasse en local, sans attendre.
    connexions.rappelerNonProteges().then(l => { if (l.length) log.warn('connexions', `remis en local (premier compte sans lien d’installation) : ${l.join(', ')}`); }).catch(() => {});
    probes.sync();
    const every = (ms, fn) => { const t = setInterval(() => Promise.resolve().then(fn).catch(e => log.warn(e.message)), ms); t.unref(); timers.push(t); };
    every(30000, () => services.checkAll());
    every(60000, () => probes.sync());
    every(15000, () => engine.tick());
    every(3600e3, () => probes.purge());
    timers.push(mesures.demarrer());
    every(6 * 3600e3, () => purgerDonnees(db, audit));
    every(6 * 3600e3, () => registry.refresh().then(() => bus.emit('hub.event', { event: 'catalog.refreshed' })));
    // La fiche et l'état du Hub dans SYNAPSE : au démarrage, toutes les cinq
    // minutes, et peu après chaque changement de service.
    every(300e3, () => cerveau.publier());
    // Pannes, retours, mises à jour et workflows en échec : racontés à SYNAPSE.
    timers.push(journal.demarrer());
    alertes.demarrer();
    const signaler = domaine => e => log.warn(domaine, e.message);
    setTimeout(() => cerveau.publier().catch(signaler('cerveau')), 20000).unref();
    setTimeout(() => voix.synchroniserLien().catch(e => log.warn('voix', e.message)), 25000).unref();
    // Une image reconstruite sur la machine, même version : « Mettre à jour » s'allume aussi.
    setTimeout(() => services.verifierImagesLocales().catch(signaler('images')), 30000).unref();
    setInterval(() => services.verifierImagesLocales().catch(signaler('images')), 300000).unref();
    let relance = null;
    bus.on('instance', () => { clearTimeout(relance); relance = setTimeout(() => { cerveau.publier().catch(signaler('cerveau')); voix.synchroniserLien().catch(signaler('voix')); services.verifierImagesLocales().catch(signaler('images')); }, 10000); relance.unref(); });
    registry.refresh().catch(e => log.warn('catalogue', e.message));
    services.checkAll().catch(signaler('santé'));
  };
  hub.iaServices = iaServices;
  hub.stop = async () => {
    iaServices.fermer();
    timers.forEach(clearInterval); socle.arreter(); agent.arreterEcoute(); alertes.arreter(); await triggers.stopAll(); probes.stop(); hub.server.close();
    await Promise.race([Promise.allSettled([...engine.running.values()]), new Promise(r => setTimeout(r, 3000))]);
    db.close();
  };
  return hub;
}

// Démarrage du conteneur (server/entree.js, après l'assistant de configuration), ou direct.
export async function lancer() {
  // Tout fichier que le Hub écrit (base, logos, piles Compose, clés) n'est lisible que par lui.
  process.umask(0o077);
  // Publié hors de la boucle locale, le Hub ne parle qu'en HTTPS (REQ-WEB-001) :
  // sans certificat, il ne démarre pas plutôt que de servir en clair.
  let tls = null;
  try {
    if (config.tlsDir && lireTls(config.tlsDir)) tls = { dossier: config.tlsDir, journal: { info: m => log.info('https', m), warn: m => log.warn('https', m) } };
  } catch (e) { log.error(`Certificat HTTPS : ${e.message}`); process.exit(1); }
  if (!tls && !['127.0.0.1', '::1'].includes(config.bindIp)) {
    log.error(`HUB_BIND_IP=${config.bindIp} publie le Hub sur le réseau : il ne s'y sert qu'en HTTPS. Pose son certificat (outils/tls-local.sh) ou remets HUB_BIND_IP=127.0.0.1.`);
    process.exit(1);
  }
  const hub = await buildHub({ tls }).catch(e => { log.error(e.message); process.exit(1); });
  for (const s of hub.server.interieurs || [hub.server]) {
    s.headersTimeout = 20_000;
    s.requestTimeout = 330_000;
    s.keepAliveTimeout = 5_000;
  }
  // La passerelle IA des services : sur le réseau interne de la pile seulement (aucun port publié).
  hub.iaServices.ecouter().then(p => log.info(`IA du Hub pour les services sur :${p} (réseau interne)`)).catch(e => log.warn('ia-services', e.message));
  hub.server.listen(config.port, config.host, async () => {
    log.info(`Hub ${config.version} à l’écoute sur ${config.host}:${config.port}${tls ? ` en HTTPS${config.tlsNom ? ` (https://${config.tlsNom}:…)` : ''}` : ''}`);
    log.info(`Webhooks : ${config.publicUrl}/hooks/…`);
    await hub.startBackground();
  });
  const shutdown = async sig => { log.info(`${sig} reçu, arrêt propre`); await hub.stop(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('unhandledRejection', e => log.error('promesse rejetée', e?.stack || e));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await lancer();
