// Routes de l'API REST.
import { sse } from './server.js';
import { aTraiter } from '../a-traiter.js';
import { NODE_DEFS, CATEGORIES, COMMON_SETTINGS, outputsOf } from '../workflows/nodes.js';
import { AI_KINDS, ROLES } from '../ai/gateway.js';
import { nextRun } from '../cron.js';
import { config } from '../config.js';
import { docker } from '../docker.js';
import { HttpError, log } from '../util/common.js';
import { poserFuseau, fuseau } from '../manifest/template.js';
import { PORTEES as PORTEES_JETONS } from '../auth/jetons.js';
import { champsIA, etatIA } from '../choix-ia.js';
import { CATALOGUE as SECRETS_CATALOGUE, CATEGORIES as SECRETS_CATEGORIES, decrire } from '../secrets.js';
import { EXPOSITIONS, EXPOSITION_LIBELLE, hoteValide } from '../services.js';
import { sortir } from '../sortie.js';
import { avecSchemas } from './schemas.js';
import { lienDe } from '../registry.js';
import { coupure, poserCoupure, FONCTIONS as COUPURES } from '../coupure.js';
import { GAMMES, LIBELLES_GAMME, CLE_HUB, gammePour, reglageTheme, gammesOffertes } from '../theme.js';
import { vueCourriel, poserCourriel } from '../courriel.js';

// Adresses des extraits d'écoute ElevenLabs, par identifiant de voix.
const APERCUS = new Map();

/* L'adresse par laquelle le navigateur joint le Hub : c'est elle que les IA
   des autres services donnent pour « continuer dans le Hub ». Une adresse de
   boucle locale (un tunnel) ne remplace pas une adresse du réseau déjà connue. */
let dbPourAdresse = null;
function retenirAdresse(ctx) {
  // L'origine attestée par le socle : le schéma ne vient d'un en-tête que
  // si un relais déclaré l'a posé.
  const url = ctx.socle.origine;
  if (!url || !/^https?:\/\/(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]{1,253})(:\d{1,5})?$/.test(url) || !dbPourAdresse) return;
  const avant = dbPourAdresse.setting('hub_ui', '');
  if (url === avant) return;
  const boucle = u => /^https?:\/\/(127\.|localhost|\[::1\])/.test(u);
  if (avant && boucle(url) && !boucle(avant)) return;
  dbPourAdresse.setSetting('hub_ui', url);
}

// Ce qui part vers un modèle, ou vers la voix, par compte ou par jeton. Le débit
// laisse passer un banc d'essai qui enchaîne les questions ; la dépense, elle,
// est bornée par le quota du jour et par le plafond global de l'IA (gateway.js).
const QUOTA_IA = { nom: 'assistant', minute: 120, jour: 1000 };
const QUOTA_VOIX = { nom: 'voix', minute: 60, jour: 500 };
// À qui appartient la conversation avec l'assistant : le compte, ou le jeton d'accès.
const qui = ctx => ({ compte: ctx.jeton ? `jeton:${ctx.jeton.id}` : ctx.compte.id, admin: ctx.compte?.role === 'admin' });

export function registerRoutes(routeur, h) {
  const r = avecSchemas(routeur);
  dbPourAdresse = h.db;
  const { db, jetons, audit, bus, registry, adaptation, destinations, services, runtime, store, engine, triggers, probes, mesures, ai, agent, accounts, secrets, logos, voix } = h;

  // État
  // Vivant ou non, pour les sondes (CREUSET, le conteneur) : ni version, ni
  // configuration sans session (SEC-BE-010). Connexion et comptes : /api/compte/* du socle.
  r.get('/api/status', ctx => {
    const s = ctx.socle.session;
    if (s?.niveau !== 'complet') return { ok: true };
    retenirAdresse(ctx);
    return { ok: true, version: config.version };
  }, { public: true });

  // Les lignes du journal ne partent qu'aux administrateurs, comme /api/audit.
  // Les échanges avec l'assistant ne partent qu'au compte qui les a.
  r.get('/api/events', ctx => sse(ctx, bus, ['install', 'instance', 'workflow', 'execution', 'execution.node', 'probe', 'approval', 'catalog', 'agent.token', 'agent.ecoute', ...(ctx.compte?.role === 'admin' ? ['audit'] : [])], { vivante: ctx.vivante, pour: d => d?.compte === undefined || d.compte === ctx.compte?.id }), { stream: true });

  // Vue d'ensemble
  r.get('/api/overview', async ctx => {
    const inst = services.list();
    const wfs = store.list();
    const day = Date.now() - 86400e3;
    const ex = db.get(`SELECT COUNT(*) n, SUM(status='error') err FROM executions WHERE started > ?`, day);
    const perHour = db.all(`SELECT (started/3600000) h, COUNT(*) n FROM executions WHERE started > ? GROUP BY h ORDER BY h`, day);
    const alerts = probes.overview().flatMap(p => p.series.filter(s => s.level !== 'ok').map(s => ({ instance: p.instance, probe: p.name, labels: s.labels, value: s.value, unit: p.unit, level: s.level })));
    return {
      services: { total: inst.length, online: inst.filter(i => i.status === 'online').length, list: inst.map(i => services.publicView(i)) },
      workflows: { total: wfs.length, enabled: wfs.filter(w => w.enabled).length, auto: wfs.filter(w => w.origin === 'Auto').length },
      executions: { day: ex.n || 0, errors: ex.err || 0, perHour },
      // L'activité récente vient du journal : administrateurs seulement, comme le journal lui-même.
      alerts, approvals: engine.pendingApprovals(), recent: ctx.compte?.role === 'admin' ? audit.list(8) : [], docker: await docker.available(),
      aTraiter: aTraiter({ services, probes, engine, db }),
      mesures: mesures?.vue('24h', { admin: ctx.compte?.role === 'admin' }) || null,
    };
  });
  // Les mesures seules, pour changer de période sans tout relire.
  r.get('/api/mesures', ctx => mesures.vue(ctx.query.periode || '24h', { admin: ctx.compte?.role === 'admin' }));

  // Comptes des services
  // Tout passe par le manifeste du service et par un jeton d'administration
  // distinct du jeton de service ; chaque service demande un second facteur.
  r.get('/api/accounts', () => ({ services: accounts.services_() }), { role: 'admin' });
  r.post('/api/accounts/:id/stepup', ctx => accounts.stepUp(ctx.session, ctx.params.id, ctx.user), { role: 'admin' });
  r.post('/api/accounts/:id/lock', ctx => { accounts.release(ctx.session, ctx.params.id); return { ok: true }; }, { role: 'admin' });
  r.get('/api/accounts/:id', async ctx => {
    const until = accounts.requireStep(ctx.session, ctx.params.id);
    return { ...(await accounts.list(ctx.params.id)), until };
  }, { role: 'admin' });
  r.post('/api/accounts/:id', async ctx => {
    accounts.requireStep(ctx.session, ctx.params.id);
    return accounts.create(ctx.params.id, ctx.body, ctx.user);
  }, { role: 'admin' });
  r.patch('/api/accounts/:id/:uid', async ctx => {
    accounts.requireStep(ctx.session, ctx.params.id);
    return accounts.update(ctx.params.id, ctx.params.uid, ctx.body, ctx.user);
  }, { role: 'admin' });
  r.post('/api/accounts/:id/:uid/password', async ctx => {
    accounts.requireStep(ctx.session, ctx.params.id);
    return accounts.password(ctx.params.id, ctx.params.uid, ctx.body, ctx.user);
  }, { role: 'admin' });
  r.post('/api/accounts/:id/:uid/reset', async ctx => {
    accounts.requireStep(ctx.session, ctx.params.id);
    return accounts.reset(ctx.params.id, ctx.params.uid, ctx.body, ctx.user);
  }, { role: 'admin' });
  r.post('/api/accounts/:id/:uid/mfa', async ctx => {
    accounts.requireStep(ctx.session, ctx.params.id);
    return accounts.requireMfa(ctx.params.id, ctx.params.uid, ctx.user);
  }, { role: 'admin' });
  r.del('/api/accounts/:id/:uid', async ctx => {
    accounts.requireStep(ctx.session, ctx.params.id);
    return accounts.remove(ctx.params.id, ctx.params.uid, ctx.user);
  }, { role: 'admin' });

  // Catalogue et services
  // Une extension adaptée par l'IA porte de quoi la relire avant de l'installer : dépôt, commit, licence, Compose.
  const vueAdaptee = o => (o?.type === 'adapte' ? { repo: o.repo, sha: o.sha, licence: o.licence, licenceNom: o.licenceNom, obligations: o.obligations || [], modele: o.modele, le: o.le, compose: o.compose } : null);
  r.get('/api/catalog', () => ({ sources: registry.sources(), refreshed: db.setting('registry_refreshed'), errors: registry.errors, items: registry.list().map(e => ({ id: e.id, source: e.source, version: e.version, manifest: e.manifest, ...(e.origin?.type === 'adapte' ? { adapte: vueAdaptee(e.origin) } : {}) })) }));
  // Les registres tels qu'on les lit : leur lien, ce qu'ils apportent, et les dépôts sans manifeste que l'IA peut adapter.
  r.get('/api/catalog/registres', () => {
    const lignes = registry.list();
    return {
      refreshed: db.setting('registry_refreshed'), errors: registry.errors,
      ia: db.get('SELECT COUNT(*) AS n FROM ai_connections').n > 0,
      registres: registry.sources().map(s => ({
        source: s, lien: lienDe(s), auto: adaptation.auto(s),
        extensions: lignes.filter(e => e.source === s && e.origin?.type !== 'adapte').length,
        adaptees: lignes.filter(e => e.source === s && e.origin?.type === 'adapte').length,
        depots: adaptation.liste(s).map(d => ({ repo: d.repo, description: d.description, etoiles: d.etoiles, licence: d.licence, licenceNom: d.licenceNom, licenceOk: d.licenceOk, etat: d.etat, raison: d.raison, extId: d.ext_id, aJour: d.aJour, maj: d.maj, modele: d.detail?.modele || null })),
      })),
    };
  });
  r.put('/api/catalog/registres/auto', ctx => {
    if (!registry.sources().includes(ctx.body.source)) throw new HttpError(404, 'Registre inconnu.');
    adaptation.poserAuto(ctx.body.source, ctx.body.auto, ctx.user);
    return { auto: adaptation.auto(ctx.body.source), lances: ctx.body.auto ? adaptation.planifier(ctx.body.source, ctx.user) : [] };
  }, { role: 'admin' });
  r.post('/api/catalog/depots/adapter', ctx => {
    adaptation.lancer(ctx.body.repo, ctx.user);
    return { repo: ctx.body.repo, etat: 'en-cours' };
  }, { role: 'admin', quota: { nom: 'adaptation', minute: 10, jour: 200 } });
  r.post('/api/catalog/refresh', ctx => (ctx.body?.auto ? registry.refreshAuto() : registry.refresh(ctx.user)), { role: 'admin', quota: { nom: 'catalogue', minute: 60, jour: 2000 } });
  r.put('/api/catalog/sources', ctx => { registry.setSources(ctx.body.sources || [], ctx.user); return registry.refresh(ctx.user); }, { role: 'admin' });
  r.post('/api/catalog/import', ctx => registry.importManifest(ctx.body.manifest, ctx.user), { role: 'admin', bodyLimit: 2 * 1024 * 1024 });

  // Les valeurs d'un champ AVANT l'installation. Le service n'existe pas
  // encore : seules les listes hébergées par un autre service — désignées
  // par capacité — sont répondables ici.
  // Ce que le Hub peut remplir tout seul pour cette extension, en
  // interrogeant les services déjà installés.
  r.get('/api/catalog/:extId/resolve', ctx => services.resoudreConfig(registry.get(ctx.params.extId).manifest));

  r.post('/api/catalog/:extId/options', async ctx => {
    const m = registry.get(ctx.params.extId).manifest;
    const field = (m.config || []).find(f => f.key === ctx.body.key);
    if (!field) throw new HttpError(404, 'Champ introuvable');
    if (!field.optionsFrom?.from?.capability) return field.options || [];
    return runtime.options(null, field);
  });

  // Exposition
  r.get('/api/exposition', () => ({
    modes: EXPOSITIONS.map(m => ({ id: m, label: EXPOSITION_LIBELLE[m], disponible: m === 'loopback' || m === 'port' })),
    global: db.setting('exposition', 'loopback'),
    parService: db.setting('exposition_par_service', {}),
    machine: db.setting('adresse_machine', ''),
  }));
  r.put('/api/exposition', ctx => {
    const avant = JSON.stringify([db.setting('exposition', 'loopback'), db.setting('exposition_par_service', {})]);
    const g = ctx.body.global;
    if (g !== undefined) {
      if (!EXPOSITIONS.includes(g)) throw new HttpError(400, 'Mode inconnu');
      db.setSetting('exposition', g);
    }
    const machine = ctx.body.machine;
    if (machine !== undefined) {
      const h = typeof machine === 'string' ? machine.trim() : machine;
      if (!hoteValide(h)) throw new HttpError(400, 'Adresse de la machine : une IP ou un nom d’hôte, sans http:// ni port');
      db.setSetting('adresse_machine', h);
    }
    if (ctx.body.parService && typeof ctx.body.parService === 'object') {
      const net = {};
      for (const [id, m] of Object.entries(ctx.body.parService)) if (EXPOSITIONS.includes(m)) net[id] = m;
      db.setSetting('exposition_par_service', net);
    }
    audit.write(ctx.user, 'exposition.modifiée', null, { global: db.setting('exposition', 'loopback'), machine: db.setting('adresse_machine', '') });
    // Le réglage ne bouge rien tant que les piles n'ont pas été re-rendues :
    // le dire, plutôt que de laisser croire que c'est appliqué.
    // L'adresse de la machine, elle, ne change que ce qu'on affiche.
    const pileTouchee = avant !== JSON.stringify([db.setting('exposition', 'loopback'), db.setting('exposition_par_service', {})]);
    return { ok: true, aRedeployer: pileTouchee ? services.list().filter(i => i.mode === 'compose').map(i => i.name) : [] };
  }, { role: 'admin' });

  // Thème : une gamme pour le Hub et tous les services qui la lisent, ou une
  // par service. Un service qui ne la lit pas garde la sienne ; chacun dit
  // les gammes que son socle connaît (les autres lui arrivent en SOMA).
  const vueTheme = () => {
    const reglage = reglageTheme(db);
    const suivent = new Set(services.suiventLaGamme().map(i => i.id)), toutes = services.lisentToutesLesGammes(), apparence = services.lisentLApparence();
    return {
      mode: reglage.mode,
      commun: reglage.commun,
      hub: gammePour(reglage, CLE_HUB),
      parService: reglage.parService,
      gammes: GAMMES.map(g => ({ id: g, label: LIBELLES_GAMME[g] })),
      services: services.list().filter(i => i.mode === 'compose').map(i => ({
        id: i.id, name: i.name, nom: i.manifest?.name || i.name, suit: suivent.has(i.id), toutes: toutes.has(i.id) || apparence.has(i.id), gamme: gammePour(reglage, i.id),
        gammes: gammesOffertes(services.niveauGamme(i.id, apparence, toutes)),
      })),
    };
  };
  // Courriel des comptes : adresse par défaut et relais d'envoi repris par les services.
  // Connexions : les routes de Relay (capacité edge.routes). Voir, pour tout
  // compte ; changer ce qui est exposé, pour un administrateur qui vient de
  // confirmer son identité.
  const { connexions } = h;
  r.get('/api/connexions', () => connexions.etat());
  r.put('/api/connexions/domaines', async ctx => {
    const out = await connexions.poserDomaines(ctx.body.domaines, ctx.user);
    // Les services déplacés apprennent leur nouvelle adresse (liens des courriels) : redéployés en tâche de fond.
    const deplaces = out.deplaces.services.map(n => services.list().find(i => i.name === n)).filter(i => i?.mode === 'compose' && i.status === 'online');
    (async () => { for (const i of deplaces) { try { await services.redeploy(i.id, ctx.user); } catch (e) { log.warn('connexions', `${i.name} : redéploiement après changement de domaine impossible — ${e.message}`); } } })();
    return out;
  }, { role: 'admin', renfort: true });
  r.put('/api/connexions/cloudflare', ctx => connexions.connecterCloudflare(ctx.body.jeton, ctx.user), { role: 'admin', renfort: true });
  r.del('/api/connexions/cloudflare', ctx => connexions.deconnecterCloudflare(ctx.user), { role: 'admin', renfort: true });
  r.get('/api/connexions/tunnel', () => connexions.tunnel(), { role: 'admin' });
  r.put('/api/connexions/tunnel', ctx => connexions.activerTunnel(ctx.body, ctx.user), { role: 'admin', renfort: true });
  r.del('/api/connexions/tunnel', ctx => connexions.couperTunnel(ctx.user), { role: 'admin', renfort: true });
  r.post('/api/connexions/tunnel/tout', ctx => connexions.toutParLeTunnel(ctx.user), { role: 'admin', renfort: true });
  r.post('/api/connexions/routes', async ctx => {
    const out = await connexions.appel('POST', '/api/routes', ctx.body);
    audit.write(ctx.user, 'connexion.creee', out.route.hote, { cible: out.route.cible, mode: out.route.mode, cf: out.route.cf });
    return out;
  }, { role: 'admin', renfort: true });
  r.patch('/api/connexions/routes/:id', async ctx => {
    const out = await connexions.appel('PATCH', `/api/routes/${encodeURIComponent(ctx.params.id)}`, ctx.body);
    audit.write(ctx.user, 'connexion.modifiee', out.route.hote, ctx.body);
    return out;
  }, { role: 'admin', renfort: true });
  r.del('/api/connexions/routes/:id', async ctx => {
    const out = await connexions.appel('DELETE', `/api/routes/${encodeURIComponent(ctx.params.id)}`);
    audit.write(ctx.user, 'connexion.supprimee', ctx.params.id);
    return out;
  }, { role: 'admin', renfort: true });
  r.put('/api/connexions/services/:id', ctx => connexions.publier(ctx.params.id, ctx.body, ctx.user), { role: 'admin', renfort: true });
  r.del('/api/connexions/services/:id', ctx => connexions.depublier(ctx.params.id, ctx.user), { role: 'admin', renfort: true });
  r.put('/api/connexions/hub', ctx => connexions.publierHub(ctx.body, ctx.user), { role: 'admin', renfort: true });
  r.del('/api/connexions/hub', ctx => connexions.depublierHub(ctx.user), { role: 'admin', renfort: true });
  r.post('/api/connexions/appliquer', async ctx => { const out = await connexions.appel('POST', '/api/appliquer', {}); audit.write(ctx.user, 'connexion.appliquee', 'relay'); return out; }, { role: 'admin' });
  // Le certificat racine de Relay (mode local), à installer sur les postes.
  r.get('/api/connexions/autorite', async ctx => {
    const pem = String(await connexions.appel('GET', '/api/autorite'));
    if (!pem.includes('BEGIN CERTIFICATE')) throw new HttpError(502, 'Relay n’a pas rendu de certificat.');
    ctx.res.writeHead(200, { 'Content-Type': 'application/x-pem-file', 'Content-Disposition': 'attachment; filename="relay-autorite.crt"', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    ctx.res.end(pem);
  }, { stream: true });

  // Alertes du Hub sur Telegram : un compte de Clés & API, les types voulus, un essai.
  r.get('/api/alertes', () => h.alertes.vue(), { role: 'admin' });
  r.put('/api/alertes', ctx => h.alertes.poser(ctx.body, ctx.user), { role: 'admin', renfort: true });
  r.post('/api/alertes/essai', ctx => h.alertes.essai(ctx.user), { role: 'admin' });
  r.get('/api/courriel', () => vueCourriel(db, h.vault), { role: 'admin' });
  r.put('/api/courriel', ctx => poserCourriel(db, h.vault, audit, ctx.body, ctx.user), { role: 'admin', renfort: true });
  r.get('/api/theme', vueTheme);
  r.put('/api/theme', ctx => {
    const { mode, commun, parService } = ctx.body;
    const connus = new Set([CLE_HUB, ...services.list().filter(i => i.mode === 'compose').map(i => i.id)]);
    const choix = {};
    for (const [cle, g] of Object.entries(parService && typeof parService === 'object' && !Array.isArray(parService) ? parService : {})) {
      if (!connus.has(cle)) throw new HttpError(400, 'Service inconnu');
      if (!GAMMES.includes(g)) throw new HttpError(400, 'Gamme inconnue');
      choix[cle] = g;
    }
    const avant = reglageTheme(db);
    const gammesAvant = services.gammesDesServices();
    db.setSetting('theme_mode', mode);
    db.setSetting('theme_services', commun);
    if (parService !== undefined) db.setSetting('theme_par_service', choix);
    const apres = reglageTheme(db);
    audit.write(ctx.user, 'apparence.modifiée', null, { avant, après: apres });
    return { ...vueTheme(), appliqueA: services.appliquerGamme(ctx.user, gammesAvant) };
  }, { role: 'admin' });

  r.get('/api/instances', () => services.list().map(i => services.publicView(i)));
  r.post('/api/instances', async ctx => {
    const inst = await services.add(ctx.body.extId, ctx.body, ctx.user);
    probes.sync();
    return services.publicView(inst);
  }, { role: 'admin' });
  r.get('/api/instances/:id', ctx => {
    const i = services.get(ctx.params.id);
    return { ...services.publicView(i), manifest: i.manifest, workflows: h.capabilities.workflowsUsing(i.id) };
  });
  r.patch('/api/instances/:id', ctx => {
    if (ctx.body.url) services.updateUrl(ctx.params.id, ctx.body.url, ctx.user);
    if (ctx.body.config) services.updateConfig(ctx.params.id, ctx.body.config, ctx.user);
    return services.publicView(services.get(ctx.params.id));
  }, { role: 'admin' });
  // L'IA d'un service : ses champs d'IA seuls (mode, modèle local, nuage), lisibles
  // depuis le lien « service → IA » de Workflows, et modifiables là.
  r.get('/api/instances/:id/ia', ctx => {
    const i = services.get(ctx.params.id);
    const ch = champsIA(i.manifest);
    if (!ch) throw new HttpError(404, `${i.name} ne choisit pas d’IA.`);
    const champs = [ch.mode, ch.modele, ch.nuage, ch.modeleNuage].filter(Boolean).filter((f, k, l) => l.indexOf(f) === k);
    const cfg = services.configOf(i);
    return { instance: { id: i.id, name: i.name, mode: i.mode }, champs, config: Object.fromEntries(champs.map(f => [f.key, cfg[f.key] ?? f.default ?? ''])), etat: etatIA(i, h.capabilities.fournisseurIA(i)) };
  });
  r.put('/api/instances/:id/ia', async ctx => {
    const i = services.get(ctx.params.id);
    const ch = champsIA(i.manifest);
    if (!ch) throw new HttpError(404, `${i.name} ne choisit pas d’IA.`);
    const permis = new Set([ch.mode, ch.modele, ch.nuage, ch.modeleNuage].filter(Boolean).map(f => f.key));
    const patch = Object.fromEntries(Object.entries(ctx.body?.config || {}).filter(([k]) => permis.has(k)));
    services.updateConfig(i.id, patch, ctx.user);
    await services.refletIA?.catch?.(() => {});
    // Un service installé ici lit ses réglages au démarrage.
    let relance = false;
    if (i.mode === 'compose' && Object.keys(patch).length) { await services.redeploy(i.id, ctx.user); relance = true; }
    return { ok: true, relance, config: patch };
  }, { role: 'admin' });
  r.post('/api/instances/:id/manifest', ctx => { const out = services.syncManifest(ctx.params.id, ctx.user); probes.sync(); return out; }, { role: 'admin' });
  r.post('/api/instances/:id/autos', ctx => h.capabilities.recreer(ctx.params.id, ctx.user), { role: 'admin' });
  r.post('/api/instances/:id/update', async ctx => { const out = await services.update(ctx.params.id, ctx.user); probes.sync(); return out; }, { role: 'admin' });
  r.post('/api/instances/:id/redeploy', async ctx => { const out = await services.redeploy(ctx.params.id, ctx.user); probes.sync(); return out; }, { role: 'admin' });
  r.del('/api/instances/:id', async ctx => { const out = await services.remove(ctx.params.id, { deleteVolumes: ctx.query.volumes === '1' }, ctx.user); probes.sync(); return out; }, { role: 'admin' });
  r.post('/api/instances/:id/check', async ctx => {
    const i = services.get(ctx.params.id);
    try { await runtime.health(i); services.setStatus(i.id, 'online'); return { ok: true }; }
    catch (e) { services.setStatus(i.id, 'offline', e.cause?.code || e.message); return { ok: false, error: e.cause?.code || e.message }; }
  });
  // Les journaux d'un conteneur peuvent porter des secrets du service : administrateurs seulement.
  r.get('/api/instances/:id/logs', ctx => services.logs(ctx.params.id, Math.min(Math.max(Number(ctx.query.tail) || 200, 1), 2000)).then(text => ({ text })), { role: 'admin' });
  r.post('/api/instances/:id/options', async ctx => {
    const i = services.get(ctx.params.id);
    const { kind, ref, key } = ctx.body;
    const list = kind === 'trigger' ? i.manifest.triggers : kind === 'config' ? [{ params: i.manifest.config }] : i.manifest.actions;
    const def = kind === 'config' ? list[0] : list.find(x => x.id === ref);
    const field = def?.params?.find(f => f.key === key);
    if (!field) throw new HttpError(404, 'Champ introuvable');
    return runtime.options(i, field);
  });
  r.post('/api/instances/:id/actions/:action', async ctx => {
    const i = services.get(ctx.params.id);
    const a = i.manifest.actions.find(x => x.id === ctx.params.action);
    if (!a) throw new HttpError(404, 'Action inconnue');
    // Supprimer, effacer : une décision d'administrateur, confirmée.
    if (a.risk === 'destructive' && ctx.compte?.role !== 'admin') throw new HttpError(403, 'Action destructive : réservée aux administrateurs.');
    if (a.risk === 'destructive' && ctx.body.confirm !== true) throw new HttpError(428, 'Action destructive : confirmation requise');
    const out = await runtime.action(i, a.id, ctx.body.params || {});
    audit.write(ctx.user, 'action.lancée', i.name, { action: a.id, risk: a.risk });
    return { output: out };
  });
  // test d'une adresse distante avant ajout
  r.post('/api/catalog/:id/test-remote', async ctx => {
    const e = registry.get(ctx.params.id);
    const fake = { id: 'test', name: 'test', mode: 'remote', url: String(ctx.body.url || '').replace(/\/$/, ''), manifest: e.manifest, config: {} };
    try { new URL(fake.url); } catch { throw new HttpError(400, 'Adresse invalide'); }
    try { await runtime.health(fake, { confiance: 'admin' }); return { ok: true }; }
    catch (err) { return { ok: false, error: err.cause?.code || err.message, help: e.manifest.install.remote?.setupHelp }; }
  }, { role: 'admin' });

  // Sondes
  r.get('/api/probes', () => probes.overview());
  r.get('/api/probes/:instance/:probe', ctx => probes.history(ctx.params.instance, ctx.params.probe, { hours: Math.min(Math.max(Number(ctx.query.hours) || 24, 1), 24 * 90), labels: ctx.query.labels || '' }));
  r.post('/api/probes/:instance/:probe/read', async ctx => {
    const i = services.get(ctx.params.instance);
    const p = i.manifest.probes.find(x => x.id === ctx.params.probe);
    if (!p) throw new HttpError(404, 'Sonde inconnue');
    await probes.read(i, p);
    return { ok: true };
  });

  // Palette et workflows
  r.get('/api/palette', () => ({
    categories: CATEGORIES,
    core: Object.entries(NODE_DEFS).filter(([, d]) => d.cat !== 'hidden' && !d.service).map(([type, d]) => ({ type, cat: d.cat, name: d.name, icon: d.icon, sub: d.sub, trigger: !!d.trigger, params: d.params, outputs: d.outputs ? d.outputs(Object.fromEntries(d.params.map(p => [p.key, p.default]))) : ['main'], dynamicOutputs: !!d.outputs })),
    services: services.list().map(i => ({ id: i.id, name: i.name, extId: i.ext_id, icon: i.manifest.icon, status: i.status,
      triggers: i.manifest.triggers.map(t => ({ id: t.id, name: t.name, description: t.description, icon: t.icon, group: t.group, params: t.params || [], sample: t.sample, delivery: t.delivery.type })),
      actions: i.manifest.actions.map(a => ({ id: a.id, name: a.name, description: a.description, icon: a.icon, group: a.group, params: a.params || [], risk: a.risk, sample: a.sample })),
      probes: i.manifest.probes.map(p => ({ id: p.id, name: p.name, unit: p.unit, kind: p.kind })) })),
    catalog: registry.list().filter(e => !services.list().some(i => i.ext_id === e.id)).map(e => ({ id: e.id, name: e.manifest.name, triggers: e.manifest.triggers.length, actions: e.manifest.actions.length })),
    settings: COMMON_SETTINGS,
    ai: ai.list().map(c => ({ id: c.id, name: c.name })),
    workflows: store.list().map(w => ({ id: w.id, name: w.name })),
  }));

  r.get('/api/workflows', () => store.list());
  // Dossiers : déclarés avant « /api/workflows/:id » pour ne pas être pris pour un identifiant.
  r.get('/api/workflows/dossiers', () => ({ dossiers: store.dossiers() }));
  r.post('/api/workflows/dossiers', ctx => store.creerDossier(ctx.body?.chemin, ctx.user));
  r.patch('/api/workflows/dossiers', ctx => store.renommerDossier(ctx.body?.de, ctx.body?.vers, ctx.user));
  r.post('/api/workflows/dossiers/supprimer', ctx => store.supprimerDossier(ctx.body?.chemin, ctx.user));
  r.post('/api/workflows/ranger', ctx => store.ranger(Array.isArray(ctx.body?.affectations) ? ctx.body.affectations.slice(0, 300) : [], ctx.user));
  r.post('/api/workflows', ctx => {
    if (ctx.body.import) {
      const imp = ctx.body.import;
      if (imp.format !== 'hub-workflow/1') throw new HttpError(400, 'Fichier de workflow non reconnu');
      return store.create({ name: imp.name, graph: imp.graph }, ctx.user);
    }
    return store.create({ name: ctx.body.name, graph: ctx.body.graph || { nodes: [{ id: 'n1', type: 'trigger.manual', name: 'Lancement manuel', params: {}, x: 360, y: 220 }], edges: [] } }, ctx.user);
  });
  r.get('/api/workflows/:id', ctx => {
    const w = store.get(ctx.params.id);
    const hooks = w.graph.nodes.filter(n => n.type === 'trigger.webhook').map(n => ({ nodeId: n.id, ...triggers.webhookInfo(w.id, n.id) }));
    const crons = w.graph.nodes.filter(n => n.type === 'trigger.cron').map(n => { try { return { nodeId: n.id, next: nextRun(n.params.expr)?.toISOString() }; } catch (e) { return { nodeId: n.id, error: e.message }; } });
    return { ...w, problems: store.validate(structuredClone(w.graph), { forEnable: true }), webhooks: hooks, crons, subscriptions: triggers.status(w.id),
      outputs: Object.fromEntries(w.graph.nodes.map(n => [n.id, outputsOf(n, store.defOf(n))])) };
  });
  r.put('/api/workflows/:id', ctx => store.update(ctx.params.id, ctx.body, ctx.user));
  r.del('/api/workflows/:id', ctx => store.remove(ctx.params.id, ctx.user));
  r.post('/api/workflows/:id/enable', ctx => store.setEnabled(ctx.params.id, ctx.body.enabled !== false, ctx.user));
  r.post('/api/workflows/:id/reparer/noms', ctx => store.reparerNoms(ctx.params.id, ctx.user));
  // Le secret d'un webhook n'est montré qu'ici, à sa création : il remplace l'ancien.
  r.post('/api/workflows/:id/webhooks/:node/secret', ctx => triggers.nouveauSecret(ctx.params.id, ctx.params.node, ctx.user), { renfort: true });
  r.get('/api/workflows/:id/versions', ctx => store.versions(ctx.params.id));
  r.post('/api/workflows/:id/restore', ctx => store.restore(ctx.params.id, Number(ctx.body.version), ctx.user));
  r.get('/api/workflows/:id/export', ctx => store.exportJson(ctx.params.id));
  r.post('/api/workflows/:id/run', async ctx => {
    const w = store.get(ctx.params.id, { reveal: true });
    const node = w.graph.nodes.find(n => n.id === ctx.body.nodeId) || w.graph.nodes.find(n => n.type === 'trigger.manual') || w.graph.nodes.find(n => NODE_DEFS[n.type]?.trigger);
    if (!node) throw new HttpError(400, 'Ajoute un déclencheur pour tester ce workflow');
    let data = ctx.body.data;
    if (data === undefined) {
      if (node.type === 'trigger.manual') data = node.params?.sample || {};
      else if (node.type === 'trigger.service') { const d = store.defOf(node); data = d?.manifestDef?.sample || {}; }
      else data = { test: true, at: new Date().toISOString() };
    }
    audit.write(ctx.user, 'workflow.test', w.name, { id: w.id });
    return engine.start(w.id, node.id, data, { mode: ctx.body.live ? 'live' : 'test', wait: false });
  }, { quota: { nom: 'lancement', minute: 30, jour: 1000 } });
  r.get('/api/workflows/:id/executions', ctx => engine.list(ctx.params.id));
  r.get('/api/executions/:id', ctx => engine.get(ctx.params.id));
  r.post('/api/executions/:id/replay', ctx => engine.replayFrom(ctx.params.id, ctx.body.nodeId, ctx.user));
  r.get('/api/approvals', () => engine.pendingApprovals());
  r.post('/api/approvals/:id', ctx => engine.decide(ctx.params.id, !!ctx.body.approved, ctx.user));

  // webhooks entrants (publics, vérifiés par signature)
  r.post('/hooks/:id', ctx => triggers.receive(ctx.params.id, ctx), { public: true, raw: true, bodyLimit: 512 * 1024 });

  // IA
  r.get('/api/ai', () => ({ connections: ai.list(), kinds: AI_KINDS, roles: ROLES, usage: ai.usage(), autonomy: agent.autonomy() }));
  // Une connexion IA ajoutée : les workflows automatiques qui l'attendaient
  // sont créés, ceux qui appelaient un service de conversation passent par elle.
  const apresIA = async () => { h.capabilities.rejouerIA(); await h.capabilities.versIADuHub('hub'); };
  r.post('/api/ai', async ctx => { const id = ai.save(ctx.body, ctx.user); await apresIA().catch(e => log.warn('ia', e.message)); return { id }; }, { role: 'admin' });
  r.put('/api/ai/:id', async ctx => { const id = ai.save({ ...ctx.body, id: ctx.params.id }, ctx.user); await apresIA().catch(e => log.warn('ia', e.message)); return { id }; }, { role: 'admin' });
  r.del('/api/ai/:id', ctx => ai.remove(ctx.params.id, ctx.user), { role: 'admin' });
  r.post('/api/ai/order', ctx => ai.reorder(ctx.body.ids || [], ctx.user), { role: 'admin' });
  // Le conteneur des outils d'abonnement (Claude Code, Codex) : présents, connectés, et comment les connecter.
  r.get('/api/ai/outils', () => ai.outils(), { role: 'admin' });
  // Connexion d'un compte (Claude Code, Codex) depuis la page IA : lien à ouvrir, code à coller, suivi.
  r.get('/api/ai/outils/:outil/connexion', ctx => ai.connexionOutil(ctx.params.outil, 'etat', null, ctx.user), { role: 'admin' });
  r.post('/api/ai/outils/:outil/connexion', ctx => ai.connexionOutil(ctx.params.outil, 'demarrer', null, ctx.user), { role: 'admin' });
  r.post('/api/ai/outils/:outil/connexion/code', ctx => ai.connexionOutil(ctx.params.outil, 'code', ctx.body, ctx.user), { role: 'admin' });
  r.post('/api/ai/:id/test', ctx => ai.test(ctx.params.id), { quota: { nom: 'essai-ia', minute: 10, jour: 100 } });
  r.get('/api/ai/:id/models', ctx => ai.models(ctx.params.id));
  r.post('/api/ai/modeles', ctx => ai.apercuModeles(ctx.body || {}), { role: 'admin' });
  // Le fuseau du navigateur, donné une fois : les heures des workflows sont les siennes.
  // Destinations internes que les requêtes du Hub ont le droit de joindre.
  r.get('/api/destinations', () => ({ destinations: destinations.liste(), automatiques: destinations.automatiques() }), { role: 'admin' });
  r.put('/api/destinations', ctx => destinations.poser(ctx.body?.destinations, ctx.user), { role: 'admin', renfort: true });
  // Coupure d'urgence : l'IA ou les workflows hors ligne, tout de suite.
  r.get('/api/coupure', () => ({ etat: coupure(db), fonctions: COUPURES }));
  r.put('/api/coupure', ctx => ({ etat: poserCoupure(db, audit, ctx.body, ctx.user) }), { role: 'admin', renfort: true });

  r.get('/api/fuseau', () => ({ fuseau: fuseau() || null }));
  r.put('/api/fuseau', ctx => {
    const tz = poserFuseau(String(ctx.body?.fuseau || ''));
    if (tz !== ctx.body?.fuseau) throw new HttpError(400, 'Fuseau inconnu');
    db.setSetting('fuseau', tz); return { fuseau: tz };
  }, { role: 'admin' });
  r.put('/api/ai-autonomy', ctx => {
    if (!['conseil', 'validation', 'autonome'].includes(ctx.body.value)) throw new HttpError(400, 'Valeur inconnue');
    db.setSetting('agent_autonomy', ctx.body.value); audit.write(ctx.user, 'ia.autonomie', ctx.body.value); return { ok: true };
  }, { role: 'admin' });

  // Les quatre routes qu'un jeton « assistant » ouvre. Posée par un jeton, une
  // question ne déclenche jamais d'exécution, même en mode Autonome.
  r.get('/api/agent', ctx => agent.history(30, qui(ctx)), { jeton: 'assistant' });
  r.post('/api/agent/nouvelle', ctx => agent.nouvelle(ctx.user, qui(ctx).compte), { jeton: 'assistant' });
  // Un message ne part sans clic que pour un administrateur, comme l'essai d'un canal (/api/secrets/test).
  r.post('/api/agent/ask', ctx => agent.ask(ctx.body.text, ctx.user, { voix: ctx.body.voix === true, sansExecution: !!ctx.jeton, ecrire: ctx.compte?.role === 'admin', compte: qui(ctx).compte }), { jeton: 'assistant', quota: QUOTA_IA });

  // Voix : entendre et parler, par le service vocal (VOX)
  r.get('/api/voix', () => voix.etat());
  r.post('/api/voix/transcrire', async ctx => {
    const out = await voix.transcrire(ctx.rawBody);
    audit.write(ctx.user, 'voix.question', null, { caractères: out.texte.length });
    return out;
  }, { raw: true, bodyLimit: 12 * 1024 * 1024, quota: QUOTA_VOIX });
  r.post('/api/voix/dire', async ctx => {
    const { son, type } = await voix.dire(ctx.body.text);
    ctx.res.writeHead(200, { 'Content-Type': type, 'Content-Length': son.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    ctx.res.end(son);
  }, { stream: true, quota: QUOTA_VOIX });
  r.post('/api/agent/stop', ctx => agent.stop(ctx.user, qui(ctx).compte));
  r.post('/api/agent/ecoute/stop', () => agent.arreterEcoute(), { role: 'admin' });
  r.get('/api/agent/cerveau', ctx => agent.cerveau(qui(ctx).compte));
  r.get('/api/agent/relances', ctx => ({ relances: agent.relances(qui(ctx).compte) }));
  r.get('/api/agent/etat', ctx => agent.etat(qui(ctx).compte));
  r.post('/api/agent/cerveau/plus-tard', ctx => agent.cerveauPlusTard(ctx.body.jamais === true, ctx.user));
  r.post('/api/agent/:id/execute', ctx => {
    // Un plan qui passe par une route sous renfort le demande ici, au clic : l'humain confirme, l'assistant exécute.
    const renfort = agent.exigeRenfort(ctx.params.id, ctx.body.only);
    if (renfort) h.socle.portail.exiger(ctx.socle, { role: 'admin', renfort: true });
    return agent.execute(ctx.params.id, ctx.user, { only: ctx.body.only, renfort });
  }, { role: 'admin' });
  r.post('/api/agent/:id/reject', ctx => agent.reject(ctx.params.id, ctx.user, qui(ctx)), { jeton: 'assistant' });

  // Jetons d'accès (administrateur, par session seulement)
  r.get('/api/jetons', () => ({ jetons: jetons.lister(), portees: PORTEES_JETONS }), { role: 'admin' });
  r.post('/api/jetons', ctx => jetons.creer(ctx.body.nom, ctx.body.portee || 'assistant', ctx.user), { role: 'admin' });
  r.del('/api/jetons/:id', ctx => jetons.revoquer(ctx.params.id, ctx.user), { role: 'admin' });
  r.post('/api/agent/:id/corriger', ctx => agent.corriger(ctx.params.id, ctx.body.correction, ctx.user, qui(ctx)));

  // Secrets par service
  // Les valeurs entrent, elles ne ressortent jamais : la liste ne dit que le
  // nom des clés et si elles sont remplies. L'assistant lit cette même liste.
  r.get('/api/secrets', () => ({ catalogue: SECRETS_CATALOGUE, categories: SECRETS_CATEGORIES, services: secrets.list() }), { role: 'admin' });
  // Le logo d'un service, servi depuis l'origine du Hub (la CSP n'autorise
  // aucune image extérieure). 404 si introuvable : l'interface affiche alors
  // un monogramme.
  r.get('/api/secrets/logo/:id', async ctx => {
    const l = await logos?.obtenir(ctx.params.id, secrets.domaineDe(ctx.params.id)).catch(() => null);
    if (!l) throw new HttpError(404, 'Pas de logo');
    ctx.res.writeHead(200, { 'Content-Type': l.type, 'Content-Length': l.buf.length, 'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'", 'Content-Disposition': 'attachment; filename="logo.png"' });
    ctx.res.end(l.buf);
  }, { role: 'admin', stream: true });
  // Telegram : l'identifiant de discussion est la marche où l'on bloque. On
  // le lit dans les derniers messages reçus par le bot (getUpdates) : il
  // suffit d'avoir écrit au bot une fois, ou de l'avoir ajouté au groupe.
  // Le même envoi qu'un workflow, à la main : « est-ce que mon bot marche ? »
  r.post('/api/secrets/test', async ctx => {
    const c = agent.canaux().find(x => x.service === ctx.body?.service);
    if (!c) throw new HttpError(400, 'Ce service n’envoie pas de messages (Telegram, Discord, Slack, ntfy).');
    if (!c.pret) throw new HttpError(400, `${c.canal} : ${c.manque}`);
    const message = String(ctx.body?.message || `✅ Test du Hub — ${c.canal}. Si tu lis ceci, les workflows pourront t'écrire ici.`).slice(0, 1000);
    await engine.essaiNoeud({ ...c.noeud, params: { ...c.noeud.params, message } }, ctx.user);
    return { ok: true, canal: c.canal };
  }, { role: 'admin', quota: { nom: 'essai-message', minute: 5, jour: 50 } });
  r.post('/api/secrets/telegram/chats', async ctx => {
    const svc = String(ctx.body?.service || 'telegram');
    let token = String(ctx.body?.token || '').trim();
    if (!token) {
      const ligne = secrets.list().find(x => x.service === svc)?.champs.find(c => c.key.endsWith('_BOT_TOKEN') && c.rempli);
      if (ligne) token = secrets.valeur(ligne.key) || '';
    }
    if (!/^\d+:[\w-]{20,}$/.test(token)) throw new HttpError(400, 'Jeton du bot absent ou mal formé (123456:ABC…).');
    const res = await sortir(`${config.telegramApi}/bot${token}/getUpdates?limit=100`, { signal: AbortSignal.timeout(10000) }).catch(e => { throw new HttpError(502, 'Telegram injoignable : ' + e.message); });
    const j = await res.json().catch(() => ({}));
    if (!j.ok) throw new HttpError(400, `Telegram refuse : ${j.description || res.status}`);
    const vus = new Map();
    for (const u of j.result || []) {
      const c = (u.message || u.channel_post || u.my_chat_member || u.edited_message || {}).chat;
      if (c && !vus.has(c.id)) vus.set(c.id, { id: String(c.id), nom: c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || String(c.id), type: c.type });
    }
    return { chats: [...vus.values()] };
  }, { role: 'admin' });
  const ELEVEN_PAS_UNE_CLE = 'Ce n’est pas la clé d’API ElevenLabs mais son identifiant : une clé commence par « sk_ ». Crée une nouvelle clé (Developers → API Keys → Create), copie-la au moment où elle s’affiche, et remplace celle enregistrée.';
  // ElevenLabs : les voix du compte, pour remplir l'identifiant sans aller le
  // copier sur leur site. Vérifie la clé du même coup.
  r.post('/api/secrets/elevenlabs/voix', async ctx => {
    const svc = String(ctx.body?.service || 'elevenlabs');
    const tape = String(ctx.body?.token || '').trim();
    let cle = tape ? (/sk_[\w-]{16,}/.exec(tape.replace(/[\s\u200B-\u200D\u2060\uFEFF]/g, '')) || [tape])[0] : '';
    if (!cle) {
      // Le compte demandé d'abord, puis le compte sans nom, puis les comptes nommés (« Voix VoxAI »).
      const rang = e => (e.service === svc ? 0 : e.compte ? 2 : 1);
      for (const e of secrets.list().filter(x => x.base === 'elevenlabs').sort((a, b) => rang(a) - rang(b))) {
        const ligne = e.champs.find(c => c.key.endsWith('_API_KEY') && c.rempli);
        if (ligne && (cle = String(secrets.valeur(ligne.key) || '').trim())) break;
      }
    }
    if (!cle) throw new HttpError(400, 'Aucune clé ElevenLabs : colle-la dans « Clé d’API » d’abord.');
    if (!/^sk_[\w-]{16,128}$/.test(cle)) throw new HttpError(400, `${ELEVEN_PAS_UNE_CLE} ${decrire(cle)}${tape ? '' : ' C’est la valeur déjà enregistrée : colle la nouvelle clé dans « Clé d’API » avant de cliquer.'}`);
    const res = await sortir(`${config.elevenApi}/v1/voices`, { headers: { 'xi-api-key': cle }, signal: AbortSignal.timeout(10000) })
      .catch(e => { throw new HttpError(502, 'ElevenLabs injoignable : ' + e.message); });
    const j = await res.json().catch(() => ({}));
    if (res.status === 401) throw new HttpError(400, 'ElevenLabs refuse la clé (401) : vérifie qu’elle est complète et qu’elle a le droit « Voices : lecture ».');
    if (/key id used as api key/i.test(j.detail?.message || '')) throw new HttpError(400, ELEVEN_PAS_UNE_CLE);
    if (!res.ok) throw new HttpError(502, `ElevenLabs : ${j.detail?.message || 'HTTP ' + res.status}`);
    const GENRE = { female: 'Femme', male: 'Homme', neutral: 'Neutre' };
    const voix = (j.voices || []).slice(0, 60).map(v => ({
      id: String(v.voice_id || ''), nom: String(v.name || v.voice_id || '').split(' - ')[0].slice(0, 40),
      genre: GENRE[v.labels?.gender] || '',
      detail: [v.labels?.accent, v.labels?.language, v.labels?.description || v.labels?.descriptive, v.category === 'cloned' ? 'clonée' : ''].filter(Boolean).join(' · '),
      apercu: typeof v.preview_url === 'string' && v.preview_url.startsWith('https://'),
      _apercu: v.preview_url,
    })).filter(v => /^[\w-]{8,64}$/.test(v.id));
    // Les extraits d'écoute : le Hub garde leurs adresses (données par
    // ElevenLabs, jamais par le navigateur) et les relaie à la demande.
    for (const v of voix) { if (v.apercu) APERCUS.set(v.id, v._apercu); delete v._apercu; }
    while (APERCUS.size > 200) APERCUS.delete(APERCUS.keys().next().value);
    return { voix };
  }, { role: 'admin' });
  r.get('/api/secrets/elevenlabs/apercu/:id', async ctx => {
    const lien = APERCUS.get(ctx.params.id);
    if (!lien) throw new HttpError(404, 'Extrait inconnu : recharge la liste des voix.');
    const u = new URL(lien);
    if (u.protocol !== 'https:' || !/(^|\.)(googleapis\.com|elevenlabs\.io)$/.test(u.hostname)) throw new HttpError(400, 'Extrait refusé.');
    const res = await sortir(u.href, { signal: AbortSignal.timeout(10000), redirect: 'error' }, { confiance: 'publique', taille: 3e6 }).catch(e => { throw new HttpError(502, 'Extrait injoignable : ' + e.message); });
    const son = Buffer.from(await res.arrayBuffer());
    if (!res.ok || son.length > 3e6) throw new HttpError(502, 'Extrait indisponible.');
    ctx.res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': son.length, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
    ctx.res.end(son);
  }, { role: 'admin', stream: true });
  r.post('/api/secrets', ctx => {
    const out = secrets.poser(ctx.body, ctx.user);
    // Site changé : l'ancien logo ne correspond plus, on le retélécharge.
    if (ctx.body?.site !== undefined && !SECRETS_CATALOGUE.some(c => c.id === out.service)) logos?.oublier(out.service);
    // Une clé de voix posée : le lien vers VOX apparaît, et la clé part chez lui.
    if (String(out.service).startsWith('elevenlabs')) voix.synchroniserLien().catch(e => log.warn('voix', e.message));
    return out;
  }, { role: 'admin' });
  // La valeur en clair d'une clé : pour la personne connectée, après une
  // vérification faite exprès (socle : devoiler), jamais par jeton ni par
  // l'assistant (aucune action du Hub ne mène ici). Chaque lecture est au journal.
  r.get('/api/secrets/valeur/:key', ctx => {
    const k = ctx.params.key;
    if (!/^[A-Z][A-Z0-9_]{0,60}$/.test(k)) throw new HttpError(400, 'Clé inconnue.');
    const v = secrets.valeur(k);
    if (v == null) throw new HttpError(404, 'Clé inconnue.');
    audit.write(ctx.user, 'secret.dévoilé', k, { ip: ctx.ip });
    return { key: k, valeur: v };
  }, { role: 'admin', devoiler: true });
  r.del('/api/secrets/:service', ctx => {
    const out = secrets.oublier(ctx.params.service, ctx.user);
    logos?.oublier(ctx.params.service);
    if (String(ctx.params.service).startsWith('elevenlabs')) voix.synchroniserLien().catch(e => log.warn('voix', e.message));
    return out;
  }, { role: 'admin' });

  // Variables, journal
  r.get('/api/variables', () => db.all('SELECT key, secret, CASE secret WHEN 1 THEN \'\' ELSE value END value FROM variables ORDER BY key'));
  r.put('/api/variables/:key', ctx => {
    const k = ctx.params.key;
    if (!/^[A-Z][A-Z0-9_]{0,40}$/.test(k)) throw new HttpError(400, 'Nom : majuscules, chiffres et _');
    const v = ctx.body.secret ? h.vault.seal(String(ctx.body.value ?? '')) : String(ctx.body.value ?? '');
    db.run('INSERT INTO variables(key,value,secret) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, secret=excluded.secret', k, v, ctx.body.secret ? 1 : 0);
    audit.write(ctx.user, 'variable.définie', k, { secret: !!ctx.body.secret });
  }, { role: 'admin' });
  r.del('/api/variables/:key', ctx => { db.run('DELETE FROM variables WHERE key=?', ctx.params.key); audit.write(ctx.user, 'variable.supprimée', ctx.params.key); }, { role: 'admin' });

  // Le journal porte des identifiants et des adresses : administrateurs seulement.
  r.get('/api/audit', ctx => audit.list(Math.min(Math.max(Number(ctx.query.limit) || 200, 1), 1000), ctx.query.before ? Number(ctx.query.before) : null), { role: 'admin' });
  r.get('/api/audit/verify', () => audit.verify(), { role: 'admin' });
  r.verifier();
}
