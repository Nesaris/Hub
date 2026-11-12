import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { createValidator } from '../server/manifest/validator.js';
import { render, jsonPath } from '../server/manifest/template.js';
import { parseCron, cronMatches, nextRun } from '../server/cron.js';
import { compare } from '../server/workflows/nodes.js';

const docs = path.join(import.meta.dirname, '../docs');
const schema = JSON.parse(fs.readFileSync(path.join(docs, 'hub-extension.schema.json'), 'utf8'));
const validate = createValidator(schema);

test('les exemples de manifestes sont valides', () => {
  for (const f of ['exemple-docker-control.hub.json', 'exemple-ollama.hub.json']) {
    const r = validate(JSON.parse(fs.readFileSync(path.join(docs, f), 'utf8')));
    assert.equal(r.valid, true, f + ' ' + JSON.stringify(r.errors));
  }
  const r = validate(JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures/synapse.hub.json'), 'utf8')));
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

test('le validateur rejette les manifestes incorrects', () => {
  const m = JSON.parse(fs.readFileSync(path.join(docs, 'exemple-ollama.hub.json'), 'utf8'));
  assert.equal(validate({ ...m, id: 'Pas Bon' }).valid, false);
  assert.equal(validate({ ...m, inconnu: 1 }).valid, false);
  assert.equal(validate({ ...m, install: { type: 'compose', healthcheck: { type: 'http' } } }).valid, false, 'compose exige un fichier');
  const t = structuredClone(m); t.triggers[0].delivery = { type: 'poll' };
  assert.equal(validate(t).valid, false, 'poll exige request et interval');
  const a = structuredClone(m); a.actions[0].risk = 'peut-être';
  assert.equal(validate(a).valid, false);
});

test('champ conditionnel (showIf) : accepté dans les deux schémas, forme vérifiée', async () => {
  const { validateManifest } = await import('../server/registry.js');
  const m = JSON.parse(fs.readFileSync(path.join(docs, 'exemple-ollama.hub.json'), 'utf8'));
  const avec = regle => ({ ...m, config: [
    { key: 'MODE', label: 'Mode', type: 'select', options: ['a', 'b'] },
    { key: 'CLE', label: 'Clé', type: 'secret', showIf: regle }] });
  for (const v of [validate, validateManifest]) {
    assert.equal(v(avec({ MODE: ['a'] })).valid, true, JSON.stringify(v(avec({ MODE: ['a'] })).errors));
    assert.equal(v(avec({ MODE: 'a' })).valid, false, 'une valeur seule, pas une liste');
    assert.equal(v(avec({ MODE: [] })).valid, false, 'liste vide');
  }
});

test('options dynamiques : exclude écarte par mots, jamais par expression régulière', async () => {
  const { Runtime } = await import('../server/runtime.js').catch(() => ({}));
  const { validateManifest } = await import('../server/registry.js');
  const m = JSON.parse(fs.readFileSync(path.join(docs, 'exemple-ollama.hub.json'), 'utf8'));
  const champ = exclude => ({ ...m, config: [{ key: 'MODELE', label: 'Modèle', type: 'select',
    optionsFrom: { from: { capability: 'llm.chat' }, method: 'GET', path: '/api/tags', select: '$.models', map: { value: '$.name' }, exclude } }] });
  assert.equal(validateManifest(champ(['embed'])).valid, true);
  assert.equal(validateManifest(champ('embed')).valid, false, 'une liste de mots, pas une chaîne');
  assert.equal(validate(champ(['embed'])).valid, true, 'schéma public aligné');
  if (Runtime) {
    const rt = Object.create(Runtime.prototype);
    rt.fournisseurDe = () => ({ id: 'o' });
    rt.request = async () => [{ name: 'qwen3:14b' }, { name: 'nomic-embed-text:latest' }, { name: 'mxbai-EMBED-large' }];
    const l = await rt.options(null, champ(['embed']).config[0]);
    assert.deepEqual(l.map(o => o.value), ['qwen3:14b']);
  }
});

test('gabarits et JSONPath', () => {
  const ctx = { $json: { a: [1, 2], s: 'x' }, $node: { 'Mon nœud': { json: { v: 3 } } }, params: { list: ['a'] } };
  assert.deepEqual(render('{{ $json.a }}', ctx), [1, 2]);
  assert.equal(render('n={{ $json.a.length }}/{{ $node["Mon nœud"].json.v }}', ctx), 'n=2/3');
  assert.equal(render('{{ $json.absent | default("vide") | upper }}', ctx), 'VIDE');
  assert.deepEqual(render({ l: '{{ params.list }}' }, ctx), { l: ['a'] });
  assert.equal(render('{{ constructor }}', ctx), undefined);
  assert.throws(() => render('{{ $json.s | eval("1") }}', ctx), /Filtre inconnu/);
  assert.deepEqual(jsonPath({ m: [{ n: 'a' }, { n: 'b' }] }, '$.m[*].n'), ['a', 'b']);
  assert.equal(jsonPath({ m: [1, 2, 3] }, '$.m.length'), 3);
});

test('cron', () => {
  const f = parseCron('*/15 8-18 * * 1-5');
  assert.equal(cronMatches(f, new Date(2026, 8, 17, 8, 30)), true);
  assert.equal(cronMatches(f, new Date(2026, 8, 19, 8, 30)), false);
  assert.throws(() => parseCron('* * *'));
  assert.equal(nextRun('0 3 * * *', new Date(2026, 8, 17, 12, 0)).getHours(), 3);
});

test('comparaisons', () => {
  assert.equal(compare('3', '>=', 3), true);
  assert.equal(compare('abc', 'contient', 'B'), true);
  assert.equal(compare('', 'vide'), true);
  assert.equal(compare('10', '>', '9'), true);
});

// ---- permissions d'installation ----
const { checkCompose, sensitivePermissions } = await import('../server/services.js');

test('permissions : privileged et socket Docker toujours refusés', () => {
  const m = { permissions: { hostNetwork: true, capAdd: ['NET_RAW'] } };
  assert.throws(() => checkCompose('services:\n  a:\n    privileged: true\n', m), /privileged/);
  assert.throws(() => checkCompose('services:\n  a:\n    volumes:\n      - /var/run/docker.sock:/x\n', m), /socket Docker/);
});

test('permissions : réseau hôte refusé si non déclaré, accepté si déclaré', () => {
  const compose = 'services:\n  a:\n    network_mode: host\n';
  assert.throws(() => checkCompose(compose, { permissions: {} }), /hostNetwork/);
  assert.equal(checkCompose(compose, { permissions: { hostNetwork: true } }), true);
});

test('permissions : capacités limitées à celles déclarées', () => {
  const compose = 'services:\n  a:\n    cap_add:\n      - NET_RAW\n      - NET_ADMIN\n';
  assert.throws(() => checkCompose(compose, { permissions: { capAdd: ['NET_RAW'] } }), /NET_ADMIN/);
  assert.equal(checkCompose(compose, { permissions: { capAdd: ['NET_RAW', 'NET_ADMIN'] } }), true);
  assert.throws(() => checkCompose('services:\n  a:\n    cap_add:\n      - SYS_ADMIN\n', { permissions: { capAdd: ['SYS_ADMIN'] } }), /jamais accordée/);
});

test('permissions : liste présentée à l’utilisateur', () => {
  const l = sensitivePermissions({ permissions: { hostNetwork: true, capAdd: ['NET_RAW'] } });
  assert.deepEqual(l.map(p => p.key), ['hostNetwork', 'cap:NET_RAW']);
  assert.deepEqual(sensitivePermissions({}), []);
});

test('erreur de tirage d’image : message explicite', async () => {
  const { Services } = await import('../server/services.js');
  const msg = 'docker compose -p a échoué : Image ghcr.io/x/y:latest Interrupted Error response from daemon: error from registry: denied denied';
  const img = /Image (\S+)/.exec(msg)?.[1];
  assert.equal(img, 'ghcr.io/x/y:latest');
  assert.match(msg, /denied/i);
  assert.ok(typeof Services === 'function');
});

test('images citées par un Compose', async () => {
  const { imagesOf } = await import('../server/services.js');
  const c = `services:
  db:
    image: postgres:16-alpine
  api:
    image: "ghcr.io/x/api:1.2"
  web:
    image: ghcr.io/x/web:latest   # commentaire
  copie:
    image: postgres:16-alpine
`;
  assert.deepEqual(imagesOf(c), ['postgres:16-alpine', 'ghcr.io/x/api:1.2', 'ghcr.io/x/web:latest']);
});

test('adresses d’ouverture d’un service', async () => {
  const { openAddresses } = await import('../server/services.js');
  const manifest = { install: { ports: [
    { name: 'web', container: 80, protocol: 'http', expose: 'proxy' },
    { name: 'db', container: 5432, protocol: 'tcp', expose: 'host' },
  ] } };
  const a = openAddresses({ mode: 'compose', name: 'x', stack: 1, manifest });
  assert.deepEqual(a.filter(o => o.host).map(o => o.url), ['http://127.0.0.1:8110']);
  assert.deepEqual(openAddresses({ mode: 'remote', url: 'http://192.0.2.9:8120', manifest }), [{ label: 'Adresse du service', url: 'http://192.0.2.9:8120' }]);
});

test('adresses d’ouverture en mode « port » : IP de la machine, jamais le nom interne', async () => {
  const { openAddresses, hoteValide } = await import('../server/services.js');
  const manifest = { install: { ports: [
    { name: 'http', container: 8140, protocol: 'http', expose: 'proxy' },
    { name: 'db', container: 5432, protocol: 'http', expose: 'host' },
  ] } };
  const inst = { mode: 'compose', name: 'synapse', stack: 2, url: 'http://hub-synapse:8140', manifest };
  const a = openAddresses(inst, { exposition: 'port', machine: '192.0.2.11' });
  assert.equal(a[0].url, 'http://192.0.2.11:8120');
  assert.ok(a[0].reseau);
  // Le port réservé à la machine reste sur la boucle locale, même en mode port.
  assert.equal(a.find(o => o.label.includes('db')).url, 'http://127.0.0.1:8121');
  assert.ok(a.every(o => !String(o.url).includes('hub-synapse')));
  // Sans adresse connue : le port seul, le navigateur complète.
  const b = openAddresses(inst, { exposition: 'port', machine: '' });
  assert.equal(b[0].url, undefined);
  assert.equal(b[0].port, 8120);
  // IPv6 entre crochets.
  assert.equal(openAddresses(inst, { exposition: 'port', machine: '2001:db8::1' })[0].url, 'http://[2001:db8::1]:8120');
  // Boucle locale : 127.0.0.1.
  assert.equal(openAddresses(inst)[0].url, 'http://127.0.0.1:8120');
  for (const ok of ['', '192.0.2.11', 'nas.example', '2001:db8::1']) assert.ok(hoteValide(ok), ok);
  for (const ko of ['http://192.0.2.11', '192.0.2.11:8120', 'a b', '<x>', 'x/y', 42]) assert.ok(!hoteValide(ko), String(ko));
});

// ---- comptes des services ----
const { Accounts } = await import('../server/accounts.js');

function fauxAccounts({ users = [], remove = true } = {}) {
  const manifest = { name: 'S', accounts: {
    tokenKey: 'ADMIN_TOKEN', roles: ['admin', 'viewer'], adminRole: 'admin',
    fields: { id: '$.id', name: '$.username', role: '$.role', created: '$.createdAt' },
    list: { method: 'GET', path: '/u' }, create: { method: 'POST', path: '/u' },
    ...(remove ? { remove: { method: 'DELETE', path: '/u/{{params.id}}' } } : {}),
  } };
  const inst = { id: 'i1', name: 's1', manifest, status: 'online' };
  const appels = [];
  const comptes = { renforcee: false, exigerRenfort(sess) { if (!this.renforcee) throw Object.assign(new Error('Confirme ton identité pour continuer.'), { status: 403, details: { renfort: true } }); } };
  return { appels, comptes, acc: new Accounts({
    comptes,
    services: { get: () => inst, list: () => [inst], configOf: () => ({ ADMIN_TOKEN: 'jeton' }) },
    runtime: { request: async (i, req, o) => { appels.push({ path: req.path, params: o.params, tokenKey: o.tokenKey }); return users; } },
    audit: { write() {} },
  }) };
}

test('comptes des services : chaque service listé, géré ici ou à mettre à jour pour l’être', async () => {
  const m = (nom, x = {}) => ({ id: nom, name: nom, status: 'online', manifest: { id: nom, name: nom, config: [], ...x } });
  const liste = [
    m('synapse', { accounts: { tokenKey: 'ADMIN_TOKEN', create: {} } }),
    m('mapmylan', { accounts: { tokenKey: 'HUB_ADMIN_TOKEN', invitation: true, create: {}, reset: {} } }),
    m('sentinel'),
    m('ollama'),
    m('vox'),
  ];
  const acc = new Accounts({ comptes: {}, runtime: {}, audit: { write() {} }, services: { list: () => liste, configOf: () => ({ ADMIN_TOKEN: 'x' }) } });
  assert.deepEqual(acc.services_().map(s => [s.name, s.gestion, s.version ?? null]), [
    ['synapse', 'hub', null], ['mapmylan', 'hub', null], ['sentinel', 'mise-a-jour', '2.0.0'], ['ollama', 'aucun', null], ['vox', 'mise-a-jour', '6.5.1'],
  ]);
  const mml = acc.services_().find(s => s.name === 'mapmylan');
  assert.deepEqual([mml.ready, mml.can.invitation, mml.can.reset], [false, true, true], 'jeton d’administration absent : pas prêt');
});

test('comptes : sur invitation, aucun mot de passe ne part ; l’opérateur et l’adresse du service sont transmis', async () => {
  const inst = { id: 'i1', name: 'mapmylan', status: 'online', manifest: { name: 'MapMyLAN', accounts: {
    tokenKey: 'HUB_ADMIN_TOKEN', roles: ['admin', 'membre', 'lecture'], invitation: true, fields: { id: '$.id', name: '$.identifiant' },
    list: { method: 'GET', path: '/l' }, create: { method: 'POST', path: '/c', body: { identifiant: '{{params.username}}', role: '{{params.role}}' } },
    reset: { method: 'POST', path: '/r/{{params.id}}' },
  } } };
  const appels = [];
  const acc = new Accounts({
    comptes: {}, audit: { write() {} },
    services: { get: () => inst, list: () => [inst], configOf: () => ({}) },
    runtime: { request: async (i, req, o) => { appels.push({ req, o }); return { lien: 'https://s/#x' }; } },
  });
  await acc.create('i1', { username: 'bruno', password: 'ne-doit-pas-partir', role: 'membre', adresse: 'http://192.0.2.11:8110/chemin' }, 'ana');
  assert.equal(appels[0].o.params.password, undefined);
  assert.equal(appels[0].req.headers['X-Hub-Operateur'], 'ana');
  assert.equal(appels[0].req.headers['X-Hub-Adresse'], 'http://192.0.2.11:8110');
  assert.equal(appels[0].o.tokenKey, 'HUB_ADMIN_TOKEN');
  const r = await acc.reset('i1', 'c_1', { adresse: 'javascript:alert(1)' }, 'ana');
  assert.equal(r.lien, 'https://s/#x');
  assert.equal(appels[1].req.headers['X-Hub-Adresse'], undefined, 'une adresse invalide n’est pas transmise');
  assert.equal(r.autres, undefined, 'aucune autre adresse connue : rien de plus');
  // Le nom public peut ne pas répondre encore : le même lien par l'adresse directe.
  acc.services.publicView = () => ({ open: [{ url: 'https://s' }, { url: 'http://192.0.2.10:8120' }, { label: 'sans adresse' }] });
  const r2 = await acc.reset('i1', 'c_1', {}, 'ana');
  assert.deepEqual(r2.autres, ['http://192.0.2.10:8120/#x'], 'même jeton, autre adresse ; pas de doublon du nom public');
});

test('comptes d’un service du socle : adresse par défaut du Hub, envoi par e-mail, clé exigée, activation', async () => {
  const inst = { id: 'i2', name: 'nexarc', status: 'online', manifest: { name: 'NEXARC', accounts: {
    tokenKey: 'HUB_ADMIN_TOKEN', roles: ['admin', 'membre', 'lecture'], adminRole: 'admin', invitation: true,
    fields: { id: '$.id', name: '$.identifiant', role: '$.role', mfa: '$.a2f' },
    list: { method: 'GET', path: '/api/compte/hub/comptes' }, create: { method: 'POST', path: '/api/compte/hub/comptes', body: { identifiant: '{{params.username}}', role: '{{params.role}}' } },
    update: { method: 'PATCH', path: '/api/compte/hub/comptes/{{params.id}}', body: { role: '{{params.role}}' } },
    reset: { method: 'POST', path: '/api/compte/hub/comptes/{{params.id}}/reinit', body: {} },
  } } };
  const reglages = new Map([['courriel_comptes', { defaut: 'parc@exemple.org', relais: { hote: 'smtp.exemple.org', port: 587, securite: 'starttls', utilisateur: 'u', motdepasse: '', de: 'hub@exemple.org' } }]]);
  const db = { setting: (k, d) => reglages.has(k) ? reglages.get(k) : d };
  const appels = [];
  let cfg = {};
  const acc = new Accounts({
    comptes: {}, audit: { write() {} }, db, vault: { open: x => x },
    services: { get: () => inst, list: () => [inst], configOf: () => cfg },
    runtime: { request: async (i, req, o) => { appels.push({ req, o }); return req.method === 'GET' ? [{ id: 'c_1', identifiant: 'ana', role: 'membre', a2f: true, courriel: 'ana@exemple.org', cle: 'facultative', actif: true, facteurs: { motdepasse: true, totp: 'oui', cles: 2, secours: -1 }, manquants: ['cle', '<img>', 3] }, { id: 'c_2', identifiant: 'ancien', role: 'membre', a2f: false }] : { ok: true }; } },
  });
  assert.equal(acc.services_()[0].can.socle, true);
  const liste = await acc.list('i2');
  assert.deepEqual([liste.rows[0].email, liste.rows[0].cle, liste.rows[0].actif, liste.emailDefaut, liste.envoi], ['ana@exemple.org', 'facultative', true, 'parc@exemple.org', false], 'sans adresse publique en HTTPS, pas d’envoi par le relais du Hub');
  // Facteurs détenus et réclamés, tels que le socle les donne : types vérifiés, rien d'inconnu ne passe.
  assert.deepEqual([liste.rows[0].facteurs, liste.rows[0].manquants], [{ motdepasse: true, totp: false, cles: 2, secours: 0 }, ['cle']]);
  assert.equal(liste.rows[1].facteurs, undefined, 'un socle plus ancien ne dit rien des facteurs : la carte s’en passe');
  cfg = { SOCLE_URL_PUBLIQUE: 'https://nexarc.exemple.org' };
  assert.equal((await acc.list('i2')).envoi, true);
  await acc.create('i2', { username: 'bruno', role: 'membre', email: '', envoyer: true }, 'ana');
  assert.deepEqual(appels.at(-1).req.body, { identifiant: 'bruno', role: 'membre', courriel: 'parc@exemple.org', envoyer: true }, 'adresse par défaut du Hub');
  assert.equal(appels.at(-1).o.brut, true);
  await acc.create('i2', { username: 'chloe', role: 'lecture', email: 'chloe@exemple.org' }, 'ana');
  assert.equal(appels.at(-1).req.body.courriel, 'chloe@exemple.org');
  await assert.rejects(acc.create('i2', { username: 'dan', email: 'pas une adresse' }, 'ana'), /invalide/);
  await acc.update('i2', 'c_1', { email: 'ana@autre.org', cleExigee: true, actif: false }, 'ana');
  assert.deepEqual([appels.at(-1).req.method, appels.at(-1).req.path, appels.at(-1).req.body], ['PATCH', '/api/compte/hub/comptes/c_1', { courriel: 'ana@autre.org', cleExigee: true, actif: false }]);
  await acc.reset('i2', 'c_1', { envoyer: true }, 'ana');
  assert.deepEqual([appels.at(-1).req.path, appels.at(-1).req.body], ['/api/compte/hub/comptes/c_1/reinit', { envoyer: true }]);
});

test('courriel du Hub : le relais ne part vers un service qu’avec une adresse publique en HTTPS et sans relais propre', async () => {
  const { smtpPourService } = await import('../server/courriel.js');
  const reglage = { relais: { hote: 'smtp.exemple.org', port: 465, securite: 'tls', utilisateur: 'u', motdepasse: 'p', de: 'hub@exemple.org' } };
  assert.deepEqual(smtpPourService(reglage, {}), {});
  assert.deepEqual(smtpPourService(reglage, { SOCLE_URL_PUBLIQUE: 'http://192.0.2.1:8150' }), {});
  assert.deepEqual(smtpPourService(reglage, { SOCLE_URL_PUBLIQUE: 'https://s.exemple.org', SOCLE_SMTP_HOTE: 'propre.exemple.org' }), {});
  assert.equal(smtpPourService(reglage, { SOCLE_URL_PUBLIQUE: 'https://s.exemple.org' }).SOCLE_SMTP_HOTE, 'smtp.exemple.org');
});

test('comptes : le compte d’origine est repéré et protégé', async () => {
  const { acc } = fauxAccounts({ users: [
    { id: 'b', username: 'tard', role: 'admin', createdAt: '2026-05-02' },
    { id: 'a', username: 'premier', role: 'admin', createdAt: '2026-01-01' },
    { id: 'c', username: 'lecture', role: 'viewer', createdAt: '2025-01-01' },
  ] });
  const { rows } = await acc.list('i1');
  assert.deepEqual(rows.filter(r => r.protected).map(r => r.name), ['premier']);
  await assert.rejects(acc.remove('i1', 'a', 'moi'), /ne se supprime pas depuis le Hub/);
});

test('comptes : suppression d’un autre compte autorisée, avec le jeton d’administration', async () => {
  const f = fauxAccounts({ users: [
    { id: 'a', username: 'premier', role: 'admin', createdAt: '2026-01-01' },
    { id: 'b', username: 'autre', role: 'viewer', createdAt: '2026-02-01' },
  ] });
  await f.acc.remove('i1', 'b', 'moi');
  const dernier = f.appels.at(-1);
  assert.equal(dernier.tokenKey, 'ADMIN_TOKEN');
  assert.equal(dernier.params.id, 'b');
});

test('comptes : renfort exigé, puis un service à la fois, et expirant', async () => {
  const { acc, comptes } = fauxAccounts();
  const session = { id: 'sess1', renfort: Date.now() };
  assert.throws(() => acc.requireStep(session, 'i1'), /Second facteur/);
  assert.throws(() => acc.stepUp(session, 'i1', 'moi'), /Confirme ton identité/, 'sans renfort du socle, rien ne s’ouvre');
  comptes.renforcee = true;
  const { until } = acc.stepUp(session, 'i1', 'moi');
  assert.equal(until, session.renfort + 5 * 60e3, 'jusqu’à la fin du renfort, pas au-delà');
  assert.ok(acc.requireStep(session, 'i1') > Date.now());
  assert.throws(() => acc.requireStep(session, 'i2'), /Second facteur/); // un service à la fois
  acc.steps.set('sess1:i1', Date.now() - 1);
  assert.throws(() => acc.requireStep(session, 'i1'), /Second facteur/);
});

test('comptes : le service peut désigner lui-même le compte d’origine', async () => {
  const f = fauxAccounts({ users: [
    { id: 'a', username: 'tard', role: 'admin', createdAt: '2026-05-01' },
    { id: 'z', username: 'fondateur', role: 'admin', createdAt: '2026-09-01', fondateur: true },
  ] });
  f.acc.services.get().manifest.accounts.fields.protected = '$.fondateur';
  const { rows } = await f.acc.list('i1');
  assert.deepEqual(rows.filter(r => r.protected).map(r => r.name), ['fondateur']);
});

// ---- reprise du manifeste ----

test('manifeste repris : les clés que le Hub sait fabriquer sont semées', async () => {
  const { Services } = await import('../server/services.js');

  const avant = { id: 'x', name: 'X', version: '1', icon: '', description: '',
    triggers: [], actions: [], probes: [], capabilities: {},
    config: [{ key: 'HUB_TOKEN', type: 'secret', generate: 'hub-token' }],
    install: { type: 'compose' } };
  const après = { ...avant, version: '2', config: [
    ...avant.config,
    { key: 'ADMIN_TOKEN', type: 'secret', generate: 'hub-token' },
    { key: 'IMAGE_TAG', type: 'string', default: 'latest' },
  ] };

  const ligne = { id: 'i1', ext_id: 'x', name: 's1', mode: 'compose', url: '', stack: 1,
    config: JSON.stringify({ HUB_TOKEN: 'v1:déjà-là' }), manifest: JSON.stringify(avant),
    version: '1', status: 'online', created: 0, providers: '[]' };

  const écrits = [];
  const s = new Services({
    db: {
      get: () => ligne,
      setting: (k, d) => d,
      all: () => [],
      run: (sql, ...a) => {
        écrits.push({ sql, a });
        if (/SET config=/.test(sql)) ligne.config = a[0];
        if (/SET manifest=/.test(sql)) { ligne.manifest = a[0]; ligne.version = a[1]; }
      },
    },
    vault: {
      sealFields: (o, cles) => {
        const out = { ...o };
        for (const k of cles) if (out[k] && !String(out[k]).startsWith('v1:')) out[k] = 'v1:' + out[k];
        return out;
      },
      openFields: o => o,
    },
    audit: { write() {} },
    bus: { emit() {} },
    registry: { get: () => ({ manifest: après }) },
  });
  s.attach({ runtime: {}, capabilities: { onAdded: () => [] } });

  const out = s.syncManifest('i1', 'moi');
  const cfg = JSON.parse(ligne.config);
  // La valeur déjà posée n'est pas retouchée.
  assert.equal(cfg.HUB_TOKEN, 'v1:déjà-là');
  // Le secret manquant est fabriqué puis scellé, le défaut est repris tel quel.
  assert.match(cfg.ADMIN_TOKEN, /^v1:hub_/);
  assert.equal(cfg.IMAGE_TAG, 'latest');
  assert.equal(out.version, '2');
});

test('manifeste repris : sans clé nouvelle, la configuration n’est pas réécrite', async () => {
  const { Services } = await import('../server/services.js');
  const m = { id: 'x', name: 'X', version: '1', icon: '', description: '',
    triggers: [], actions: [], probes: [], capabilities: {},
    config: [{ key: 'A', type: 'string', default: '1' }], install: { type: 'compose' } };
  const ligne = { id: 'i1', ext_id: 'x', name: 's1', mode: 'compose', url: '', stack: 1,
    config: JSON.stringify({ A: '1' }), manifest: JSON.stringify(m),
    version: '1', status: 'online', created: 0, providers: '[]' };
  const écrits = [];
  const s = new Services({
    db: { get: () => ligne, setting: (k, d) => d, all: () => [], run: sql => écrits.push(sql) },
    vault: { sealFields: o => o, openFields: o => o },
    audit: { write() {} }, bus: { emit() {} }, registry: { get: () => ({ manifest: m }) },
  });
  s.attach({ runtime: {}, capabilities: { onAdded: () => [] } });
  s.syncManifest('i1', 'moi');
  assert.equal(écrits.filter(q => /SET config=/.test(q)).length, 0);
});

test('manifeste repris : les liens de capacité sont rejoués', async () => {
  const { Services } = await import('../server/services.js');
  const m = { id: 'x', name: 'X', version: '2', icon: '', description: '',
    triggers: [], actions: [], probes: [], capabilities: { accepts: ['llm.chat'] },
    config: [], install: { type: 'compose' } };
  const ligne = { id: 'i1', ext_id: 'x', name: 's1', mode: 'compose', url: '', stack: 1,
    config: '{}', manifest: JSON.stringify({ ...m, version: '1', capabilities: {} }),
    version: '1', status: 'online', created: 0, providers: '[]' };
  const s = new Services({
    db: { get: () => ligne, setting: (k, d) => d, all: () => [], run: (sql, ...a) => { if (/SET manifest=/.test(sql)) { ligne.manifest = a[0]; ligne.version = a[1]; } } },
    vault: { sealFields: o => o, openFields: o => o },
    audit: { write() {} }, bus: { emit() {} }, registry: { get: () => ({ manifest: m }) },
  });
  let vu = null;
  s.attach({ runtime: {}, capabilities: { onAdded: (i, a, o) => { vu = { id: i.id, o }; return [{ name: 'Triage des alertes' }]; } } });
  const out = s.syncManifest('i1', 'moi');
  assert.equal(vu.id, 'i1');
  // L'événement « service ajouté » n'a pas lieu d'être sur une reprise.
  assert.equal(vu.o.annonce, false);
  assert.deepEqual(out.liens, ['Triage des alertes']);
});

test('manifeste repris : installé ici, l’adresse suit le port HTTP de la nouvelle version ; distant, elle ne bouge pas', async () => {
  const { Services } = await import('../server/services.js');
  const m = v => ({ id: 'x', name: 'X', version: v, icon: '', description: '', triggers: [], actions: [], probes: [], capabilities: {}, config: [],
    install: { type: 'compose', ports: v === '1' ? [{ name: 'web', container: 80, protocol: 'tcp' }] : [{ name: 'http', container: 8090, protocol: 'http' }] } });
  const essai = mode => {
    const ligne = { id: 'i1', ext_id: 'x', name: 'mapmylan', mode, url: mode === 'compose' ? 'http://hub-mapmylan:80' : 'http://192.0.2.20:8090', stack: 1,
      config: '{}', manifest: JSON.stringify(m('1')), version: '1', status: 'online', created: 0, providers: '[]' };
    const s = new Services({
      db: { get: () => ligne, setting: (k, d) => d, all: () => [], run: (sql, ...a) => { if (/SET manifest=/.test(sql)) { ligne.manifest = a[0]; ligne.version = a[1]; } if (/SET url=/.test(sql)) ligne.url = a[0]; } },
      vault: { sealFields: o => o, openFields: o => o }, audit: { write() {} }, bus: { emit() {} }, registry: { get: () => ({ manifest: m('2') }) },
    });
    s.attach({ runtime: {}, capabilities: { onAdded: () => [] } });
    s.syncManifest('i1', 'moi');
    return ligne.url;
  };
  assert.equal(essai('compose'), 'http://hub-mapmylan:8090');
  assert.equal(essai('remote'), 'http://192.0.2.20:8090');
});

test('réponse en cours : on n’affiche que ce qui est arrivé', async () => {
  const { replyPartiel } = await import('../server/ai/agent.js');
  assert.equal(replyPartiel('{"reply": "Je vais conne'), 'Je vais conne');
  assert.equal(replyPartiel('{"reply":"fini","steps":[]}'), 'fini');
  assert.equal(replyPartiel('{"reply":"un \\"mot\\" cite'), 'un "mot" cite');
  assert.equal(replyPartiel('{"reply":"ligne\\nsuite'), 'ligne\nsuite');
  // Rien à montrer tant que la clé n'est pas arrivée.
  assert.equal(replyPartiel('{"ste'), '');
  assert.equal(replyPartiel(''), '');
  // Un échappement coupé en deux ne doit rien inventer.
  assert.equal(replyPartiel('{"reply":"a\\'), 'a');
});

// ---- secrets par service ----
const { Secrets, cle: cleSecret, CATALOGUE: CAT_SECRETS } = await import('../server/secrets.js');

function fauxSecrets({ workflows = [] } = {}) {
  const lignes = new Map();
  const reglages = {};
  const db = {
    setting: (k, d) => structuredClone(reglages[k] ?? d),
    setSetting: (k, v) => { reglages[k] = structuredClone(v); },
    all: (sql, ...p) => {
      if (/FROM workflows/.test(sql)) return workflows;
      if (/WHERE service=\?/.test(sql)) return [...lignes.values()].filter(l => l.service === p[0]);
      return [...lignes.values()];
    },
    run: (sql, ...p) => {
      if (/^INSERT INTO variables/.test(sql)) lignes.set(p[0], { key: p[0], value: p[1], secret: p[2], service: p[3], label: p[4] });
      if (/^DELETE FROM variables/.test(sql)) for (const [k, l] of lignes) if (l.service === p[0]) lignes.delete(k);
    },
  };
  const journal = [];
  return { lignes, journal, reglages, s: new Secrets({ db, vault: { seal: v => 'v1:' + v }, audit: { write: (...a) => journal.push(a) } }) };
}

test('secrets : la clé se déduit du service et du champ', () => {
  assert.equal(cleSecret('telegram', 'BOT_TOKEN'), 'TELEGRAM_BOT_TOKEN');
  assert.equal(cleSecret('Mon Service', 'chat id'), 'MON_SERVICE_CHAT_ID');
  // Les accents ne produisent pas une clé illisible.
  assert.equal(cleSecret('Réséau', 'clé'), 'RESEAU_CLE');
});

test('secrets : un champ secret est scellé, un champ clair ne l’est pas', () => {
  const { lignes, s } = fauxSecrets();
  s.poser({ service: 'telegram', champs: { BOT_TOKEN: '123:abc', CHAT_ID: '-100777' } }, 'moi');
  assert.equal(lignes.get('TELEGRAM_BOT_TOKEN').value, 'v1:123:abc');
  assert.equal(lignes.get('TELEGRAM_BOT_TOKEN').secret, 1);
  // L'identifiant de discussion n'est pas un secret : le cacher n'aiderait personne.
  assert.equal(lignes.get('TELEGRAM_CHAT_ID').value, '-100777');
  assert.equal(lignes.get('TELEGRAM_CHAT_ID').secret, 0);
});

test('secrets : ni la liste ni l’assistant ne voient une valeur', () => {
  const { s } = fauxSecrets();
  s.poser({ service: 'telegram', champs: { BOT_TOKEN: 'tres-secret', CHAT_ID: '-100777' } }, 'moi');
  const vu = JSON.stringify({ liste: s.list(), noms: s.noms() });
  assert.ok(!vu.includes('tres-secret'), 'aucune valeur ne sort');
  assert.deepEqual(s.noms(), [{ service: 'Telegram', cles: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'] }]);
});

test('secrets : le journal garde les noms, jamais les valeurs', () => {
  const { journal, s } = fauxSecrets();
  s.poser({ service: 'github', champs: { TOKEN: 'ghp_tres_secret' } }, 'moi');
  assert.ok(!JSON.stringify(journal).includes('ghp_tres_secret'));
  assert.deepEqual(journal[0][3].clés, ['GITHUB_TOKEN']);
});

test('secrets : un champ laissé vide ne perd pas ce qui était là', () => {
  const { lignes, s } = fauxSecrets();
  s.poser({ service: 'gotify', champs: { URL: 'https://g.exemple', TOKEN: 'abc' } }, 'moi');
  s.poser({ service: 'gotify', champs: { URL: 'https://g2.exemple', TOKEN: '' } }, 'moi');
  assert.equal(lignes.get('GOTIFY_URL').value, 'https://g2.exemple');
  assert.equal(lignes.get('GOTIFY_TOKEN').value, 'v1:abc');
});

test('secrets : un champ inconnu d’un service connu est refusé', () => {
  const { s } = fauxSecrets();
  assert.throws(() => s.poser({ service: 'telegram', champs: { AUTRE: 'x' } }, 'moi'), /Champ inconnu/);
});

test('secrets : en mode personnalisé, tout est scellé par défaut', () => {
  const { lignes, s } = fauxSecrets();
  s.poser({ nom: 'Mon Service', champs: { 'chat id': '42' } }, 'moi');
  const l = lignes.get('MON_SERVICE_CHAT_ID');
  assert.equal(l.secret, 1, 'sans définition, on cache plutôt que de laisser filer');
  assert.equal(l.value, 'v1:42');
});

test('secrets : le catalogue couvre les services usuels', () => {
  const ids = CAT_SECRETS.map(c => c.id);
  for (const attendu of ['telegram', 'cloudflare', 'discord', 'github', 'proxmox', 'smtp']) {
    assert.ok(ids.includes(attendu), attendu);
  }
  // Chaque champ a une clé en majuscules et une étiquette lisible.
  for (const c of CAT_SECRETS) for (const f of c.champs) {
    assert.match(f.key, /^[A-Z][A-Z0-9_]*$/, `${c.id}.${f.key}`);
    assert.ok(f.label && f.label !== f.key, `${c.id}.${f.key} sans étiquette`);
  }
});

test('assistant : chaque compte a sa conversation ; une nouvelle coupe la sienne sans rien effacer', async () => {
  const { Agent } = await import('../server/ai/agent.js');
  const { openDb } = await import('../server/db/index.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversations-'));
  const db = openDb(path.join(dir, 'h.db'));
  const plan = (id, compte, created, status = 'answered') => db.run('INSERT INTO agent_plans(id,request,plan,status,created,compte) VALUES(?,?,?,?,?,?)', id, `question ${id}`, '{"reply":"r","steps":[]}', status, created, compte);
  plan('a1', 'ana', 100); plan('a2', 'ana', 300); plan('b1', 'bruno', 200); plan('b2', 'bruno', 250, 'proposed');
  const a = new Agent({ db, audit: { write() {} } });
  assert.deepEqual(a.history(30, { compte: 'ana' }).map(h => h.id), ['a1', 'a2'], 'rien de bruno');
  assert.deepEqual(a.history(30, { compte: 'bruno' }).map(h => h.id), ['b1', 'b2']);
  // Un administrateur voit en plus ce qui attend sa validation, marqué comme venant d'un autre compte.
  const vuAdmin = a.history(30, { compte: 'ana', admin: true });
  assert.deepEqual(vuAdmin.map(h => h.id), ['a1', 'b2', 'a2']);
  assert.equal(vuAdmin.find(h => h.id === 'b2').autreCompte, true);
  assert.throws(() => a.planDe('b1', { compte: 'ana' }), /introuvable/, 'refuser ou corriger le plan d’un autre : non');
  assert.equal(a.planDe('b1', { compte: 'ana', admin: true }).id, 'b1');
  const { debut } = a.nouvelle('ana', 'ana');
  assert.ok(debut > 300);
  assert.deepEqual(a.history(30, { compte: 'ana' }), [], 'la conversation d’ana repart à vide');
  assert.equal(a.history(30, { compte: 'bruno' }).length, 2, 'celle de bruno n’a pas bougé');
  assert.equal(db.get('SELECT count(*) n FROM agent_plans').n, 4, 'rien n’est effacé');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('noms de nœuds : les homonymes sont renommés, jamais le premier', async () => {
  const { nomsUniques } = await import('../server/workflows/store.js');
  const g = { nodes: [
    { id: 'n1', name: 'Action de service' },
    { id: 'n2', name: 'Action de service' },
    { id: 'n3', name: 'Action de service' },
    { id: 'n4', name: 'Action de service 2' },
    { id: 'n5', name: 'Notification' },
  ] };
  const renommes = nomsUniques(g);
  // Le premier garde son nom : une expression $node["Action de service"]
  // déjà écrite continue de désigner le même nœud.
  assert.equal(g.nodes[0].name, 'Action de service');
  assert.equal(g.nodes[4].name, 'Notification');
  // « Action de service 2 » appartenait déjà à n4 : on ne le lui prend pas.
  assert.equal(g.nodes[3].name, 'Action de service 2');
  const noms = g.nodes.map(n => n.name);
  assert.equal(new Set(noms).size, noms.length, 'tous distincts');
  assert.equal(renommes.length, 2);
});

test('noms de nœuds : un nom vide devient « Nœud » et reste unique', async () => {
  const { nomsUniques } = await import('../server/workflows/store.js');
  const g = { nodes: [{ id: 'a', name: '' }, { id: 'b', name: null }, { id: 'c', name: 'Nœud' }] };
  nomsUniques(g);
  assert.deepEqual(g.nodes.map(n => n.name), ['Nœud', 'Nœud 2', 'Nœud 3']);
});

test('nom de workflow : le Hub suffixe au lieu de créer un homonyme', async () => {
  const { WorkflowStore } = await import('../server/workflows/store.js');
  const pris = ['Triage des alertes critiques', 'Triage des alertes critiques 2'];
  const s = new WorkflowStore({ db: { all: () => pris.map(name => ({ name })) } });
  assert.equal(s.nomLibre('Scan et analyse réseau'), 'Scan et analyse réseau');
  assert.equal(s.nomLibre('Triage des alertes critiques'), 'Triage des alertes critiques 3');
  assert.equal(s.nomLibre(''), 'Nouveau workflow');
});

test('flux : le compteur d’étapes suit la rédaction du plan', async () => {
  const { etapesPartielles } = await import('../server/ai/agent.js');
  // Tant que "steps" n'est pas apparu, il n'y a rien à annoncer.
  assert.equal(etapesPartielles('{"reply":"Je regar'), -1);
  assert.equal(etapesPartielles('{"reply":"Voilà","steps":['), 0);
  assert.equal(etapesPartielles('{"reply":"Voilà","steps":[{"tool":"create_workflow","args":{'), 1);
  assert.equal(etapesPartielles('{"reply":"x","steps":[{"tool":"a","args":{}},{"tool":"b"'), 2);
  // Un "tool" cité dans la phrase ne doit pas être compté.
  assert.equal(etapesPartielles('{"reply":"le champ \\"tool\\": sert à","steps":[{"tool":"a"'), 1);
});

test('mémoire : le Hub n’invente pas de nom d’espace, il dit qui parle', async () => {
  const { Memoire, ESPACE_COMMUN } = await import('../server/ai/memoire.js');
  // « shared » est le seul nom qu'un service de mémoire comprend sans
  // convention préalable. Des espaces fabriqués par le Hub — `hub`,
  // `hub.ia.<modèle>` — étaient refusés par le fournisseur, en silence.
  assert.equal(ESPACE_COMMUN, 'shared');

  const vu = [];
  const inst = { name: 's', manifest: { capabilities: { provides: ['memory.search'] }, actions: [{ id: 'q', capability: 'memory.search' }] } };
  const m = new Memoire({
    services: { list: () => [inst] },
    runtime: { action: (i, a, p) => { vu.push(p); return Promise.resolve({ hits: [{ snippet: 'un fait' }] }); } },
  });
  const out = await m.rappeler('question', { connexion: 'Kimi (maison)' });
  assert.equal(vu.length, 1, 'une seule recherche, pas une par espace inventé');
  assert.equal(vu[0].space, 'shared');
  assert.equal(vu[0].agent, 'Kimi (maison)', 'la séparation par modèle est déléguée au fournisseur');
  assert.equal(out[0].texte, 'un fait');
});

test('mémoire : une écriture qui échoue ne remonte jamais à l’appelant', async () => {
  const { Memoire } = await import('../server/ai/memoire.js');
  const inst = { name: 'faux', manifest: { capabilities: { provides: ['memory.ingest'] }, actions: [{ id: 'fact.ingest', capability: 'memory.ingest' }] } };
  let vu = null;
  const m = new Memoire({
    services: { list: () => [inst] },
    runtime: { action: (i, a, p) => { vu = { a, p }; return Promise.reject(new Error('injoignable')); } },
  });
  assert.equal(m.active(), true);
  // Aucun await, aucune exception : l'assistant continue comme si de rien.
  m.retenir('un fait', { tags: ['t'] });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(vu.a, 'fact.ingest');
  assert.equal(vu.p.space, 'shared');
  // Sans fournisseur, retenir() ne fait rien du tout.
  const vide = new Memoire({ services: { list: () => [] }, runtime: {} });
  assert.equal(vide.active(), false);
  vide.retenir('perdu');
});

test('suggestions : seules les extensions réelles et non installées passent', async () => {
  const { Agent } = await import('../server/ai/agent.js');
  const a = new Agent({ services: { list: () => [{ ext_id: 'ollama' }] } });
  const ctx = { catalog: [
    { id: 'sentinel', name: 'Sentinel', description: 'Supervision à distance.' },
    { id: 'ollama', name: 'Ollama', description: 'Modèles locaux.' },
  ] };
  const out = a.suggestions([
    { extId: 'sentinel', pourquoi: 'pour piloter tes machines' },
    { extId: 'ollama' },                    // déjà installé
    { extId: 'inventee' },                  // n'existe pas
    { extId: 'sentinel', pourquoi: 'bis' }, // doublon
  ], ctx);
  assert.deepEqual(out, [{ extId: 'sentinel', name: 'Sentinel', pourquoi: 'pour piloter tes machines' }]);
  assert.deepEqual(a.suggestions(undefined, ctx), []);
});

test('cerveau : proposé seulement après quelques échanges, et jamais si refusé', async () => {
  const { Agent } = await import('../server/ai/agent.js');
  const reglages = {};
  let plans = [{ id: 'p1' }, { id: 'p2' }];
  const base = {
    db: { setting: (k, d) => reglages[k] ?? d, setSetting: (k, v) => { reglages[k] = v; }, all: () => plans },
    audit: { write() {} },
    registry: { list: () => [{ manifest: { id: 'synapse', name: 'SYNAPSE', capabilities: { provides: ['memory.ingest', 'memory.search'] } } }] },
    memoire: { active: () => false },
  };
  const a = new Agent(base);
  assert.equal(a.cerveau().proposer, false, 'deux échanges : trop tôt');
  plans = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }];
  const c = a.cerveau();
  assert.equal(c.proposer, true);
  assert.equal(c.extId, 'synapse');
  assert.ok(c.corps.some(l => /apprentissage/i.test(l)), 'la carte parle d’apprentissage, pas que de stockage');

  a.cerveauPlusTard(false, 'moi');
  assert.equal(a.cerveau().proposer, false, 'repoussé');
  reglages.agent_cerveau_plus_tard = 0;
  a.cerveauPlusTard(true, 'moi');
  assert.equal(a.cerveau().proposer, false, 'refusé définitivement');

  // Mémoire déjà branchée : plus rien à vendre.
  const b = new Agent({ ...base, memoire: { active: () => true } });
  assert.deepEqual(b.cerveau(), { proposer: false, actif: true });
});

test('interruption : stop() n’a d’effet que sur une demande en vol', async () => {
  const { Agent } = await import('../server/ai/agent.js');
  const a = new Agent({ audit: { write() {} } });
  assert.deepEqual(a.stop('moi', 'ana'), { arrêté: false });
  const ac = new AbortController();
  a.encours = ac;
  a.courant = { compte: 'ana' };
  assert.deepEqual(a.stop('bruno', 'bruno'), { arrêté: false }, 'on n’arrête pas la demande d’un autre compte');
  assert.deepEqual(a.stop('moi', 'ana'), { arrêté: true });
  assert.equal(ac.signal.aborted, true);
  assert.equal(a.encours, null);
  assert.deepEqual(a.stop('moi', 'ana'), { arrêté: false }, 'deux clics ne cassent rien');
});

test('mémoire : le briefing est préféré à la recherche, et retombe dessus sinon', async () => {
  const { Memoire } = await import('../server/ai/memoire.js');
  const avecBrief = {
    name: 'synapse',
    manifest: { capabilities: { provides: ['memory.brief', 'memory.search'] }, actions: [
      { id: 'brief', capability: 'memory.brief' }, { id: 'memory.search', capability: 'memory.search' }] },
  };
  const appels = [];
  const m = new Memoire({
    services: { list: () => [avecBrief] },
    runtime: { action: (i, a) => { appels.push(a); return Promise.resolve({
      profil: [{ portee: 'commun', valeur: 'Commandes en un bloc.' }],
      corrections: [{ question: 'quel modèle', correction: 'lire la liste' }],
      memoire: [{ titre: 'T', extrait: 'E' }], tronque: false }); } },
  });
  const b = await m.briefer('une question', { connexion: 'kimi' });
  assert.deepEqual(appels, ['brief'], 'un seul appel, pas trois recherches');
  assert.equal(b.profil.length, 1);
  assert.equal(b.corrections.length, 1);
  assert.equal(b.souvenirs[0].texte, 'E');

  // Sans memory.brief, on retombe sur la recherche par espaces.
  const sansBrief = { name: 'vieux', manifest: { capabilities: { provides: ['memory.search'] }, actions: [{ id: 's', capability: 'memory.search' }] } };
  const appels2 = [];
  const m2 = new Memoire({
    services: { list: () => [sansBrief] },
    runtime: { action: (i, a, p) => { appels2.push(p); return Promise.resolve([{ text: 'un fait' }]); } },
  });
  const b2 = await m2.briefer('q', { connexion: 'kimi' });
  assert.deepEqual(b2.profil, []);
  assert.deepEqual(appels2.map(p => p.space), ['shared']);
  assert.equal(b2.souvenirs.length, 1);
});

test('mémoire : une correction va chez le modèle fautif, pas chez les autres', async () => {
  const { Memoire } = await import('../server/ai/memoire.js');
  const vu = [];
  const avecCorrect = {
    name: 'synapse',
    manifest: { capabilities: { provides: ['memory.correct'] }, actions: [{ id: 'apprendre', capability: 'memory.correct' }] },
  };
  const m = new Memoire({
    services: { list: () => [avecCorrect] },
    runtime: { action: (i, a, p) => { vu.push({ a, p }); return Promise.resolve({}); } },
  });
  m.corriger({ connexion: 'Qwen 14b', question: 'quel modèle', correction: 'lire la liste', faux: 'llama3' });
  assert.equal(vu[0].a, 'apprendre');
  assert.equal(vu[0].p.agent, 'Qwen 14b');
  assert.equal(vu[0].p.faux, 'llama3');

  // Sans service de correction, ça devient un fait dans l'espace du modèle.
  const vu2 = [];
  const simple = { name: 's', manifest: { capabilities: { provides: ['memory.ingest'] }, actions: [{ id: 'i', capability: 'memory.ingest' }] } };
  const m2 = new Memoire({
    services: { list: () => [simple] },
    runtime: { action: (i, a, p) => { vu2.push(p); return Promise.resolve({}); } },
  });
  m2.corriger({ connexion: 'kimi', question: 'q', correction: 'c' });
  assert.equal(vu2[0].space, 'shared');
  assert.ok(vu2[0].tags.includes('modele:kimi'), 'le modèle fautif est nommé dans l’étiquette');
});

test('mémoire : un service qui sait consigner un échange est préféré à l’écriture brute', async () => {
  const { Memoire } = await import('../server/ai/memoire.js');
  const vu = [];
  const savant = {
    name: 'synapse',
    manifest: { capabilities: { provides: ['memory.learn', 'memory.ingest'] }, actions: [
      { id: 'echange', capability: 'memory.learn' }, { id: 'ing', capability: 'memory.ingest' }] },
  };
  const m = new Memoire({
    services: { list: () => [savant] },
    runtime: { action: (i, a, p) => { vu.push({ a, p }); return Promise.resolve({}); } },
  });
  m.apprendre({ demande: 'installe ollama', reponse: 'voici le plan', etapes: ['Installer ollama'], connexion: 'kimi' });
  assert.deepEqual(vu.map(v => v.a), ['echange'], 'pas d’écriture brute en double');
  assert.equal(vu[0].p.agent, 'kimi');
  assert.match(vu[0].p.reponse, /Plan : Installer ollama/);
});

test('options : une liste peut venir d’un autre service, désigné par capacité', async () => {
  const { Runtime } = await import('../server/runtime.js');
  const ollama = { id: 'i1', name: 'ollama', status: 'online', manifest: { capabilities: { provides: ['llm.chat', 'llm.embed'] } } };
  const eteint = { id: 'i0', name: 'vieil-ollama', status: 'offline', manifest: { capabilities: { provides: ['llm.chat'] } } };
  const synapse = { id: 'i2', name: 'synapse', manifest: { capabilities: { provides: ['memory.search'] } } };

  let interroge = null;
  const rt = new Runtime({ services: { list: () => [eteint, ollama, synapse] } });
  rt.request = async (inst) => { interroge = inst.name; return [{ name: 'qwen3:14b' }, { name: 'nomic-embed-text' }]; };

  const champ = {
    key: 'EMBED_MODEL', type: 'select',
    optionsFrom: { from: { capability: 'llm.embed' }, method: 'GET', path: '/api/tags', select: '$.models', map: { value: '$.name', label: '$.name' } },
  };
  const opts = await rt.options(synapse, champ);
  assert.equal(interroge, 'ollama', 'c’est le fournisseur qui répond, pas le service configuré');
  assert.deepEqual(opts.map(o => o.value), ['qwen3:14b', 'nomic-embed-text']);

  // Un service en ligne est préféré à un service éteint qui annonce la même chose.
  interroge = null;
  await rt.options(synapse, { ...champ, optionsFrom: { ...champ.optionsFrom, from: { capability: 'llm.chat' } } });
  assert.equal(interroge, 'ollama');

  // Personne ne fournit la capacité : liste vide, pas d’erreur — le champ
  // reste une saisie libre plutôt que de bloquer l’installation.
  assert.deepEqual(await rt.options(synapse, { ...champ, optionsFrom: { ...champ.optionsFrom, from: { capability: 'inexistante' } } }), []);

  // Sans `from`, on interroge toujours le service qu’on configure.
  interroge = null;
  await rt.options(synapse, { key: 'x', optionsFrom: { method: 'GET', path: '/x' } });
  assert.equal(interroge, 'synapse');
});

test('config : ce qu’un service installé sait déjà n’est pas redemandé', async () => {
  const { Services } = await import('../server/services.js');
  const ollama = {
    id: 'i1', name: 'ollama', url: 'http://10.0.0.9:11434', status: 'online',
    manifest: { capabilities: { provides: ['llm.chat', 'llm.embed'] } },
    config: { DEFAULT_MODEL: 'qwen3:14b', EMBED_MODEL: 'nomic-embed-text' },
  };
  const s = Object.create(Services.prototype);
  s.list = () => [ollama];
  s.configOf = i => i.config;

  const manifest = { config: [
    { key: 'OLLAMA_URL', resolve: { capability: 'llm.embed', value: '{{provider.url}}' } },
    { key: 'EMBED_MODEL', resolve: { capability: 'llm.embed', value: '{{provider.config.EMBED_MODEL}}' } },
    { key: 'ANSWER_MODEL', resolve: { capability: 'llm.chat', value: '{{provider.config.DEFAULT_MODEL}}' } },
    { key: 'AUTRE', resolve: { capability: 'inexistante' } },
    { key: 'LIBRE' },
  ] };

  const out = s.resoudreConfig(manifest);
  assert.equal(out.OLLAMA_URL.valeur, 'http://10.0.0.9:11434');
  assert.equal(out.OLLAMA_URL.service, 'ollama', 'l’utilisateur voit d’où ça vient');
  assert.equal(out.EMBED_MODEL.valeur, 'nomic-embed-text');
  assert.equal(out.ANSWER_MODEL.valeur, 'qwen3:14b');
  // Pas de fournisseur : le champ reste à saisir, ce n’est pas une erreur.
  assert.equal(out.AUTRE, undefined);
  assert.equal(out.LIBRE, undefined);

  // Une valeur vide chez le fournisseur ne remplace pas le défaut du champ.
  ollama.config.EMBED_MODEL = '';
  assert.equal(s.resoudreConfig(manifest).EMBED_MODEL, undefined);

  // Sans aucun service installé, rien n’est résolu et rien ne casse.
  s.list = () => [];
  assert.deepEqual(s.resoudreConfig(manifest), {});
});

test('catalogue : une limite GitHub n’empêche que la découverte, pas la mise à jour', async () => {
  const { Registry } = await import('../server/registry.js');
  const connus = [{ origin: JSON.stringify({ type: 'github', repo: 'CodexX64/synapse', ref: 'main' }) },
    { origin: JSON.stringify({ type: 'github', repo: 'CodexX64/MapMyLAN', ref: 'main' }) },
    { origin: JSON.stringify({ type: 'local', root: '/x' }) }];
  const r = new Registry({ db: { all: () => connus }, audit: { write() {} }, bus: { emit() {} } });

  const depots = r.deposConnus({ label: 'github-user:CodexX64' });
  assert.deepEqual(depots.map(d => d.full_name), ['CodexX64/synapse', 'CodexX64/MapMyLAN']);
  assert.equal(depots[0].default_branch, 'main');

  // Le listage échoue : on relit quand même les manifestes connus, par
  // raw.githubusercontent, qui ne consomme pas le quota de l'API.
  const lus = [];
  r.errors = [];
  r.readFile = async (root) => { lus.push(root.repo); return Buffer.from(JSON.stringify({ id: root.repo.split('/')[1].toLowerCase() })); };
  r.load = async () => {};
  const { configurer } = await import('../server/sortie.js');
  configurer({ transport: async () => new Response('', { status: 429 }) });
  const n = await r.refreshUser({ owner: 'CodexX64', label: 'github-user:CodexX64' }).finally(() => configurer({ transport: null }));
  assert.deepEqual(n, { count: 2, complet: false }, 'les deux extensions connues sont rechargées, liste incomplète');
  assert.deepEqual(lus, ['CodexX64/synapse', 'CodexX64/MapMyLAN']);
  assert.match(r.errors[0].error, /limite de l’API GitHub/);
  assert.match(r.errors[0].error, /nouveau dépôt/, 'et on dit ce qu’on perd');

  // Aucun dépôt connu : là il n'y a rien à sauver, l'erreur remonte.
  const vide = new Registry({ db: { all: () => [] }, audit: { write() {} }, bus: { emit() {} } });
  vide.errors = [];
  configurer({ transport: async () => new Response('', { status: 429 }) });
  await assert.rejects(vide.refreshUser({ owner: 'x', label: 'github-user:x' }).finally(() => configurer({ transport: null })), /limite de l’API GitHub/);
});

test('catalogue : une extension disparue de son compte GitHub le quitte, jamais sur une liste incomplète ni si elle est installée', async () => {
  const { Registry } = await import('../server/registry.js');
  const { openDb } = await import('../server/db/index.js');
  const { configurer } = await import('../server/sortie.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cat-'));
  const db = openDb(path.join(dir, 'h.db'));
  db.setSetting('registries', ['github-user:Acme']);
  const ligne = (id, source = 'github-user:Acme') => db.run('INSERT INTO catalog(id,source,version,manifest,origin,fetched) VALUES(?,?,?,?,?,?)', id, source, '1.0.0', JSON.stringify({ id, name: id }), JSON.stringify({ type: 'github', repo: `Acme/${id}`, ref: 'main' }), 1);
  ligne('sentinel'); ligne('vieux-installe'); ligne('perso', 'import'); ligne('ailleurs', 'github-user:Autre');
  db.run('INSERT INTO instances(id,ext_id,name,mode,url,stack,config,manifest,version,status,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)', 'i1', 'vieux-installe', 'vieux', 'compose', 'http://x', 10, '{}', '{}', '1.0.0', 'online', 1);
  const audits = [];
  const r = new Registry({ db, audit: { write: (...a) => audits.push(a) }, bus: { emit() {} } });
  r.check = () => true;
  r.readFile = async root => { if (root.repo === 'Acme/nexarc') return Buffer.from(JSON.stringify({ id: 'nexarc', version: '2.0.0' })); throw new Error('pas de hub.json'); };
  let statut = 429;
  configurer({ transport: async () => (statut === 200 ? new Response(JSON.stringify([{ full_name: 'Acme/nexarc', default_branch: 'main' }, { full_name: 'Acme/site', default_branch: 'main' }]), { status: 200 }) : new Response('', { status: statut })) });
  try {
    await r.refreshMaintenant('ana');
    assert.ok(db.get('SELECT id FROM catalog WHERE id=?', 'sentinel'), 'GitHub muet : rien n’est retiré');
    statut = 200;
    const o = await r.refreshMaintenant('ana');
    assert.deepEqual(o.errors, []);
    const ids = db.all('SELECT id FROM catalog ORDER BY id').map(x => x.id);
    assert.deepEqual(ids, ['nexarc', 'perso', 'vieux-installe'], 'Sentinel (renommé) et la source retirée partent ; l’import et l’installée restent');
    assert.ok(audits.some(a => a[1] === 'catalogue.actualisé' && a[3].retires?.includes('sentinel')), 'le retrait est journalisé');
  } finally { configurer({ transport: null }); db.close?.(); }
});

test('assistant : il ne cite que les vraies pages du Hub et ne fait jamais coller un mot de passe', async () => {
  const { Agent } = await import('../server/ai/agent.js');
  const prompt = new Agent({ db: { setting: () => null, all: () => [] }, audit: { write() {} } }).systemPrompt({ nodes: [], secrets: [] });
  const nav = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8').match(/const NAV = \[[\s\S]*?\n\];/)[0];
  const pages = [...nav.matchAll(/\['\w+', '([^']+)', '\w+'\]/g)].map(m => m[1]);
  assert.ok(pages.length >= 10);
  const ligne = prompt.split('\n').find(l => l.includes('Les pages du Hub sont exactement'));
  for (const p of pages) assert.ok(ligne.includes(p), `page du menu absente de la consigne : ${p}`);
  assert.match(prompt, /Ne demande JAMAIS de coller un mot de passe/);
  assert.match(prompt, /Comptes services → le service → le compte → « Lien de réinitialisation »/);
});

test('alertes Telegram : mise à jour annoncée une fois avec ses boutons ; un bouton ne vaut qu’une fois, dans la discussion configurée', async () => {
  const { Alertes } = await import('../server/alertes.js');
  const { configurer } = await import('../server/sortie.js');
  const reglages = {}, audits = [], envois = [];
  const db = { setting: (k, d) => reglages[k] ?? d, setSetting: (k, v) => { reglages[k] = v; } };
  let inst = { id: 'i1', name: 'nexarc', version: '1.0.0', status: 'online' };
  const majs = [];
  const services = { list: () => [inst], get: () => inst, versionDisponible: i => (i.version === '1.0.0' ? '1.1.0' : null),
    update: async (id, qui) => { majs.push([id, qui]); inst = { ...inst, version: '1.1.0' }; } };
  const agent = { canaux: () => [{ canal: 'Alertes (bot)', pret: true, noeud: { type: 'out.telegram' } }], identifiantsTelegram: () => ({ canal: 'Alertes (bot)', token: 'T0K3N', chat: '4242' }) };
  const a = new Alertes({ db, bus: { on() {} }, audit: { write: (...x) => audits.push(x) }, services, ai: { list: () => [] }, agent });
  configurer({ transport: async (url, o) => { envois.push({ methode: url.pathname.split('/').pop(), corps: o.corps ? JSON.parse(o.corps.toString()) : null }); return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200 }); } });
  try {
    await a.verifierMisesAJour();
    assert.equal(envois.length, 0, 'aucun canal choisi : rien');
    a.poser({ canal: 'Alertes (bot)' }, 'ana'); a.ecoute?.abort();
    assert.throws(() => a.poser({ canal: 'inconnu' }, 'ana'), /pas un compte Telegram prêt/);
    await a.verifierMisesAJour();
    await a.verifierMisesAJour();
    const annonces = envois.filter(e => e.methode === 'sendMessage');
    assert.equal(annonces.length, 1, 'une fois par version');
    assert.match(annonces[0].corps.text, /nexarc : v1\.0\.0 → v1\.1\.0/);
    const [oui, non] = annonces[0].corps.reply_markup.inline_keyboard[0];
    assert.deepEqual([oui.text, non.text], ['Mettre à jour', 'Plus tard']);
    assert.ok(!JSON.stringify(annonces[0].corps).includes('T0K3N'), 'le jeton ne part jamais dans un message');

    const cq = (data, chat = 4242, de = 4242) => ({ id: 'q', data, from: { id: de, username: 'ana_t' }, message: { message_id: 7, text: annonces[0].corps.text, chat: { id: chat } } });
    await a.rappel(cq(oui.callback_data, 999, 999));
    assert.equal(majs.length, 0, 'une autre discussion ne lance rien');
    await a.rappel(cq(oui.callback_data, 4242, 13));
    assert.equal(majs.length, 0, 'un autre expéditeur non plus');
    await a.rappel(cq(oui.callback_data));
    assert.deepEqual(majs, [['i1', 'telegram:ana_t']], 'lancée, au nom de l’auteur Telegram');
    assert.ok(audits.some(x => x[1] === 'alertes.mise_a_jour_lancée' && x[0] === 'telegram:ana_t'));
    assert.match(envois.filter(e => e.methode === 'sendMessage').at(-1).corps.text, /✅ nexarc mis à jour \(v1\.1\.0\)/);
    await a.rappel(cq(oui.callback_data));
    await a.rappel(cq(non.callback_data));
    assert.equal(majs.length, 1, 'usage unique : ni le même bouton, ni son voisin');
    assert.match(envois.filter(e => e.methode === 'answerCallbackQuery').at(-1).corps.text, /expiré/);

    // Un bouton expiré ne lance rien.
    inst = { ...inst, version: '1.0.0' };
    reglages.alertes_maj_vues = {};
    await a.verifierMisesAJour();
    const b = envois.filter(e => e.methode === 'sendMessage').at(-1).corps.reply_markup.inline_keyboard[0][0].callback_data;
    for (const v of Object.values(a.boutons())) v.expire = Date.now() - 1;
    await a.rappel(cq(b));
    assert.equal(majs.length, 1);
  } finally { configurer({ transport: null }); }
});

test('alertes Telegram : un workflow en échec, une IA ou un service injoignable — une alerte, puis une au retour', async () => {
  const { Alertes } = await import('../server/alertes.js');
  const textes = [];
  const reglages = { alertes: { canal: 'Alertes', types: { ia: true, workflow: true, service: true, maj: false } } };
  let iaOk = false;
  let insts = [{ id: 's1', name: 'mapmylan', status: 'online', version: '1.0.0' }];
  const a = new Alertes({ db: { setting: (k, d) => reglages[k] ?? d, setSetting: (k, v) => { reglages[k] = v; } }, bus: { on() {} }, audit: { write() {} },
    services: { list: () => insts }, ai: { list: () => [{ id: 'c1', name: 'Ollama (local)' }], models: async () => { if (!iaOk) throw new Error('connect ECONNREFUSED'); return ['m']; } },
    agent: { identifiantsTelegram: () => ({ token: 't', chat: '1' }) } });
  a.signaler = async (type, texte) => { if (a.reglage().types[type] !== false) textes.push(texte); };
  a.execution({ workflowId: 'w1', workflowName: 'Scan', status: 'error', error: 'boom', mode: 'live' });
  a.execution({ workflowId: 'w1', workflowName: 'Scan', status: 'error', error: 'boom', mode: 'live' });
  a.execution({ workflowId: 'w2', workflowName: 'Essai', status: 'error', error: 'x', mode: 'test' });
  a.execution({ workflowId: 'w1', workflowName: 'Scan', status: 'success', mode: 'live' });
  await a.verifierIA(); await a.verifierIA(); iaOk = true; await a.verifierIA();
  a.connus = a.photo();
  insts = [{ ...insts[0], status: 'offline', status_detail: 'délai dépassé' }]; a.comparerServices();
  insts = [{ ...insts[0], status: 'online', status_detail: null }]; a.comparerServices();
  assert.deepEqual(textes, [
    '🔴 Workflow « Scan » en échec : boom',
    '🟢 Workflow « Scan » de nouveau réussi.',
    '🔴 IA « Ollama (local) » injoignable : connect ECONNREFUSED',
    '🟢 IA « Ollama (local) » de nouveau joignable.',
    '🔴 Service mapmylan hors ligne : délai dépassé',
    '🟢 Service mapmylan de nouveau en ligne',
  ]);
});

test('compose : une variable non déclarée dit où la déclarer', async () => {
  const { composeVars, renderCompose } = await import('../server/services.js');
  const inst = { name: 'synapse', stack: 3, url: 'http://synapse:8140' };
  const m = { install: { ports: [{ name: 'http', container: 8140 }], volumes: [{ name: 'data', path: '/data' }] } };
  const vars = composeVars(inst, m, { IMAGE_TAG: 'latest' });

  assert.equal(renderCompose('image: x:{{config.IMAGE_TAG}}', vars), 'image: x:latest');
  assert.match(renderCompose('- "{{hostport.http}}:8140"', vars), /127\.0\.0\.1:\d+:8140/);
  assert.equal(renderCompose('{{volume.data}}', vars), 'hub-synapse-data');

  // Le nom seul ne dit pas quoi faire : le message doit nommer l'endroit
  // du manifeste et ce qui y est déjà déclaré.
  assert.throws(() => renderCompose('{{hostport.web}}', vars), /install\.ports.*http/s);
  assert.throws(() => renderCompose('{{volume.pgdata}}', vars), /install\.volumes.*data/s);
  assert.throws(() => renderCompose('{{config.ABSENT}}', vars), /« config ».*IMAGE_TAG/s);

  // Un manifeste sans aucun port déclaré le dit aussi.
  const nus = composeVars(inst, { install: {} }, {});
  assert.throws(() => renderCompose('{{hostport.http}}', nus), /qui est vide/);

  // Un marqueur de commentaire n'est pas une variable.
  assert.equal(renderCompose('# ici : {{...}}', vars), '# ici : {{...}}');

  // Un réglage déclaré mais jamais rempli (clé d'API facultative) vaut son
  // défaut, ou rien — pas « variable inconnue ».
  const avecCfg = { ...m, config: [{ key: 'LLM_FOURNISSEUR', type: 'select', default: 'ollama' }, { key: 'LLM_CLE', type: 'secret' }] };
  const v2 = composeVars(inst, avecCfg, { IMAGE_TAG: 'latest' });
  assert.equal(renderCompose('{{config.LLM_FOURNISSEUR}}|{{config.LLM_CLE}}|', v2), 'ollama||');
  assert.equal(renderCompose('{{config.LLM_FOURNISSEUR}}', composeVars(inst, avecCfg, { LLM_FOURNISSEUR: 'kimi' })), 'kimi');
});

test('compose : {{hub.tz}} porte le fuseau donné par le navigateur, UTC à défaut — aucun fuseau écrit en dur', async () => {
  const { composeVars, renderCompose } = await import('../server/services.js');
  const { fuseau } = await import('../server/manifest/template.js');
  assert.equal(fuseau(), '', 'aucun fuseau posé dans ce processus');
  assert.equal(renderCompose('TZ: "{{hub.tz}}"', composeVars({ name: 'vox', stack: 4 }, { install: {} }, {})), 'TZ: "UTC"');
  // Le fuseau est global au processus : on le pose dans un processus à part.
  const { spawnSync } = await import('node:child_process');
  const code = `const { poserFuseau } = await import('./server/manifest/template.js');
    const { composeVars, renderCompose } = await import('./server/services.js');
    poserFuseau('America/Montreal');
    process.stdout.write(renderCompose('{{hub.tz}}', composeVars({ name: 'vox', stack: 4 }, { install: {} }, {})));`;
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code], { cwd: path.join(import.meta.dirname, '..'), encoding: 'utf8' });
  assert.equal(r.stdout, 'America/Montreal', r.stderr);
  const vox = fs.readFileSync(path.join(import.meta.dirname, '../registry-local/vox/deploy/compose.hub.yml'), 'utf8');
  assert.match(vox, /TZ: "\{\{hub\.tz\}\}"/);
});

test('installation : la valeur résolue s’applique même sans passer par le formulaire', async () => {
  const { Services } = await import('../server/services.js');
  const ollama = {
    id: 'i1', name: 'ollama', url: 'http://192.0.2.40:11434', status: 'online',
    manifest: { capabilities: { provides: ['llm.embed'] } }, config: { EMBED_MODEL: 'nomic-embed-text' },
  };
  const s = Object.create(Services.prototype);
  s.list = () => [ollama];
  s.configOf = i => i.config;

  const m = { config: [
    { key: 'OLLAMA_URL', default: 'http://ollama:11434', resolve: { capability: 'llm.embed', value: '{{provider.url}}' } },
    { key: 'EMBED_MODEL', default: 'nomic-embed-text', resolve: { capability: 'llm.embed', value: '{{provider.config.EMBED_MODEL}}' } },
  ] };

  // La règle : absent, vide, ou égal au défaut du manifeste → on résout.
  // Un défaut n'a été choisi par personne ; le Hub connaît mieux.
  const applique = (given) => {
    const out = { ...given };
    for (const [cle, r] of Object.entries(s.resoudreConfig(m))) {
      const def = m.config.find(f => f.key === cle)?.default;
      const v = out[cle];
      if (v === undefined || v === '' || (def !== undefined && v === def)) out[cle] = r.valeur;
    }
    return out;
  };

  assert.equal(applique({}).OLLAMA_URL, 'http://192.0.2.40:11434', 'rien fourni');
  assert.equal(applique({ OLLAMA_URL: '' }).OLLAMA_URL, 'http://192.0.2.40:11434', 'champ vide');
  assert.equal(applique({ OLLAMA_URL: 'http://ollama:11434' }).OLLAMA_URL, 'http://192.0.2.40:11434',
    'le défaut du manifeste ne doit pas gagner contre le service réel');
  assert.equal(applique({ OLLAMA_URL: 'http://autre:11434' }).OLLAMA_URL, 'http://autre:11434',
    'un choix explicite est respecté');
});

test('compose : les services requis sont exposés sans aucun champ à remplir', async () => {
  const { composeVars, renderCompose } = await import('../server/services.js');
  const inst = { name: 'synapse', stack: 3, url: 'http://hub-synapse:8140' };
  const m = {
    capabilities: { requires: ['llm.embed'], accepts: ['llm.chat'] },
    install: { ports: [{ name: 'http', container: 8140 }], volumes: [{ name: 'data', path: '/data' }] },
  };
  const ollama = { url: 'http://192.0.2.40:11434', name: 'ollama', config: { EMBED_MODEL: 'nomic-embed-text', DEFAULT_MODEL: 'qwen3:14b' } };

  const vars = composeVars(inst, m, {}, cap => (cap === 'llm.embed' ? ollama : null));
  assert.equal(renderCompose('{{provider.llm.embed.url}}', vars), 'http://192.0.2.40:11434');
  assert.equal(renderCompose('{{provider.llm.embed.config.EMBED_MODEL}}', vars), 'nomic-embed-text');
  assert.equal(renderCompose('{{provider.llm.embed.name}}', vars), 'ollama');

  // `accepts` absent : ses variables existent mais valent vide — le service
  // sait s'en passer (MapMyLAN sans VOX, SYNAPSE sans modèle de synthèse).
  assert.equal(renderCompose('[{{provider.llm.chat.url}}]', vars), '[]');

  // Dépendance absente : la variable n'existe pas et le Compose échoue en
  // la nommant, plutôt que de démarrer un service qui pointe vers le vide.
  const sans = composeVars(inst, m, {}, () => null);
  assert.throws(() => renderCompose('{{provider.llm.embed.url}}', sans), /Variable inconnue/);
});

test('exposition : seul un port destiné aux humains peut sortir de la machine', async () => {
  const { adresseEcoute, composeVars, renderCompose, EXPOSITIONS } = await import('../server/services.js');
  const web = { name: 'http', container: 8140, expose: 'proxy' };
  const base = { name: 'db', container: 5432, expose: 'host' };

  // Boucle locale : rien ne sort, c'est le défaut.
  assert.equal(adresseEcoute('loopback', web), '127.0.0.1');
  assert.equal(adresseEcoute('loopback', base), '127.0.0.1');

  // ip:port : l'interface publique s'ouvre, la base jamais. Personne n'a
  // jamais voulu publier son Postgres sur le LAN.
  assert.equal(adresseEcoute('port', web), '0.0.0.0');
  assert.equal(adresseEcoute('port', base), '127.0.0.1');

  const inst = { name: 'synapse', stack: 3, url: 'http://hub-synapse:8140' };
  const m = { install: { ports: [web, base], volumes: [] }, capabilities: {} };
  const ouvert = composeVars(inst, m, {}, () => null, 'port');
  assert.match(renderCompose('{{hostport.http}}', ouvert), /^0\.0\.0\.0:\d+$/);
  assert.match(renderCompose('{{hostport.db}}', ouvert), /^127\.0\.0\.1:\d+$/);

  const ferme = composeVars(inst, m, {}, () => null, 'loopback');
  assert.match(renderCompose('{{hostport.http}}', ferme), /^127\.0\.0\.1:\d+$/);

  assert.deepEqual(EXPOSITIONS, ['loopback', 'port', 'proxy', 'ip']);
});

test('exposition : le réglage par service l’emporte sur le global', async () => {
  const { Services } = await import('../server/services.js');
  const reglages = { exposition: 'loopback', exposition_par_service: { i2: 'port' } };
  const s = Object.create(Services.prototype);
  s.db = { setting: (k, d) => reglages[k] ?? d };

  assert.equal(s.expositionDe({ id: 'i1' }), 'loopback');
  assert.equal(s.expositionDe({ id: 'i2' }), 'port', 'la dérogation gagne');
  // Une valeur abîmée en base ne doit pas ouvrir un service par accident.
  reglages.exposition = 'nimporte-quoi';
  assert.equal(s.expositionDe({ id: 'i1' }), 'loopback');
});


test('secrets : chaque service sait quels workflows s’en servent', () => {
  const { s } = fauxSecrets({ workflows: [
    { name: 'Alerte', graph: JSON.stringify({ nodes: [{ params: { token: '{{ $vars.TELEGRAM_BOT_TOKEN }}' } }] }) },
    { name: 'Autre', graph: '{}' },
  ] });
  s.poser({ service: 'telegram', champs: { BOT_TOKEN: 'x', CHAT_ID: '1' } }, 'moi');
  s.poser({ service: 'github', champs: { TOKEN: 'y' } }, 'moi');
  const par = Object.fromEntries(s.list().map(x => [x.service, x]));
  assert.deepEqual(par.telegram.utilisePar, ['Alerte']);
  assert.deepEqual(par.github.utilisePar, []);
  assert.equal(par.telegram.domaine, 'telegram.org');
  assert.equal(par.telegram.categorie, 'Notifications');
});

test('secrets : un service personnalisé garde son site, et l’oublie avec lui', () => {
  const { s, reglages } = fauxSecrets();
  s.poser({ nom: 'Mon Service', champs: { KEY: 'k' }, site: 'https://exemple.com/app' }, 'moi');
  assert.equal(s.domaineDe('Mon Service'), 'exemple.com');
  assert.equal(s.list()[0].domaine, 'exemple.com');
  // Changer le site seul, sans retaper la clé.
  s.poser({ nom: 'Mon Service', champs: { KEY: '' }, site: 'autre.org' }, 'moi');
  assert.equal(s.domaineDe('Mon Service'), 'autre.org');
  // Pas de logo tiré du réseau interne.
  for (const mauvais of ['192.168.1.10', 'nas.local', 'localhost', 'box.lan'])
    assert.throws(() => s.poser({ nom: 'Mon Service', champs: {}, site: mauvais }, 'moi'), /domaine public/);
  s.oublier('Mon Service', 'moi');
  assert.deepEqual(reglages.secrets_sites, {});
});

// ---- logos ----
const { Logos, typeImage, iconesDeclarees, domaineValide } = await import('../server/logos.js');
const { classer } = await import('../server/sortie.js');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)]);
const { encoderPng, decoderPng, reencoder } = await import('../server/image.js');
const VRAI_PNG = encoderPng({ largeur: 2, hauteur: 2, rgba: Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 9, 9, 9, 0]) });

test('images : décodées puis réécrites par le Hub — métadonnées et charge cachée retirées, bombes et géantes refusées', async () => {
  const zlib = await import('node:zlib');
  const { crc32 } = await import('node:zlib');
  const bloc = (type, d) => { const t = Buffer.alloc(8); t.writeUInt32BE(d.length); t.write(type, 4, 'latin1'); const f = Buffer.alloc(4); f.writeUInt32BE(crc32(Buffer.concat([t.subarray(4), d]))); return Buffer.concat([t, d, f]); };
  // Un PNG avec des métadonnées (tEXt) et du HTML collé après la fin.
  const blocsDe = b => { const out = []; for (let i = 8; i < b.length;) { const n = b.readUInt32BE(i); out.push(b.subarray(i, i + 12 + n)); i += 12 + n; } return out; };
  const [ihdr, idat, iend] = blocsDe(VRAI_PNG);
  const piege = Buffer.concat([VRAI_PNG.subarray(0, 8), ihdr, bloc('tEXt', Buffer.from('Author\0quelqu’un, 48.85N 2.35E')), idat, iend, Buffer.from('<script>alert(1)</script>')]);
  const propre = reencoder(piege);
  assert.ok(!propre.includes(Buffer.from('Author')) && !propre.includes(Buffer.from('<script')), 'rien d’autre que les pixels');
  assert.deepEqual(decoderPng(propre).rgba, decoderPng(VRAI_PNG).rgba, 'mêmes pixels');
  // Palette + transparence, et chaque filtre de ligne relu à l'identique.
  const ihdrP = Buffer.alloc(13); ihdrP.writeUInt32BE(3); ihdrP.writeUInt32BE(2, 4); ihdrP[8] = 8; ihdrP[9] = 3;
  const lignes = Buffer.from([1, 0, 1, 0, 2, 0, 0, 0]); // ligne 1 filtrée « Sub », ligne 2 « Up »
  const pal = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), bloc('IHDR', ihdrP), bloc('PLTE', Buffer.from([10, 20, 30, 40, 50, 60])), bloc('tRNS', Buffer.from([128])), bloc('IDAT', zlib.deflateSync(lignes)), bloc('IEND', Buffer.alloc(0))]);
  assert.deepEqual([...decoderPng(pal).rgba.subarray(0, 12)], [10, 20, 30, 128, 40, 50, 60, 255, 40, 50, 60, 255]);
  // Trop grande, bombe de décompression, somme de contrôle fausse, JPEG, SVG : refusés.
  const geant = Buffer.alloc(13); geant.writeUInt32BE(100000); geant.writeUInt32BE(100000, 4); geant[8] = 8; geant[9] = 6;
  assert.throws(() => reencoder(Buffer.concat([VRAI_PNG.subarray(0, 8), bloc('IHDR', geant), bloc('IEND', Buffer.alloc(0))])), /dimensions/);
  const petit = Buffer.alloc(13); petit.writeUInt32BE(4); petit.writeUInt32BE(4, 4); petit[8] = 8; petit[9] = 6;
  const bombe = Buffer.concat([VRAI_PNG.subarray(0, 8), bloc('IHDR', petit), bloc('IDAT', zlib.deflateSync(Buffer.alloc(50_000_000))), bloc('IEND', Buffer.alloc(0))]);
  assert.throws(() => reencoder(bombe), /trop grandes|invalides/);
  const abime = Buffer.from(VRAI_PNG); abime[20] ^= 1;
  assert.throws(() => reencoder(abime), /somme de contrôle/);
  assert.throws(() => reencoder(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])), /refusée/);
  assert.throws(() => reencoder(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), /refusée/);
});

test('logos : le type vient des octets, jamais de l’annonce ; pas de SVG', () => {
  assert.equal(typeImage(PNG), 'image/png');
  assert.equal(typeImage(Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 0, 0])), 'image/x-icon');
  assert.equal(typeImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg');
  assert.equal(typeImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>')), null);
  assert.equal(typeImage(Buffer.from('<html>pas une image</html>')), null);
});

test('logos : icônes déclarées, la meilleure d’abord, sans SVG ni HTTP clair', () => {
  const html = `<link rel="icon" href="/favicon-16.png" sizes="16x16">
    <link rel="icon" type="image/svg+xml" href="/logo.svg">
    <link rel="apple-touch-icon" href="/apple.png" sizes="180x180">
    <link rel="icon" href="http://cdn.exemple.com/i.png">
    <link rel="stylesheet" href="/s.css">`;
  assert.deepEqual(iconesDeclarees(html, 'https://exemple.com/'),
    ['https://exemple.com/apple.png', 'https://exemple.com/favicon-16.png']);
});

test('logos : ni IP, ni nom local, ni adresse privée', () => {
  assert.equal(domaineValide('https://GitHub.com/login'), 'github.com');
  for (const d of ['10.0.0.1', 'localhost', 'nas.local', 'pve.lan', 'x.internal', 'box.home.arpa', '', 'pas un domaine'])
    assert.equal(domaineValide(d), null, d);
  for (const ip of ['10.1.2.3', '127.0.0.1', '192.168.0.9', '172.20.0.1', '169.254.1.1', '100.64.0.1', '::1', 'fd00::1', '::ffff:10.0.0.1'])
    assert.notEqual(classer(ip), 'publique', ip);
  for (const ip of ['1.1.1.1', '140.82.112.3', '2606:4700::1111']) assert.equal(classer(ip), 'publique', ip);
});

test('logos : téléchargé une fois, gardé, un échec ne se retente pas aussitôt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logos-'));
  const appels = [];
  const l = new Logos({ dir, fetcher: async url => {
    appels.push(url);
    if (url === 'https://exemple.com/') return { buf: Buffer.from('<link rel="apple-touch-icon" href="/a.png">'), url };
    if (url === 'https://exemple.com/a.png') return { buf: VRAI_PNG, url };
    throw new Error('HTTP 404');
  } });
  const [a, b] = await Promise.all([l.obtenir('ex', 'exemple.com'), l.obtenir('ex', 'exemple.com')]);
  assert.equal(a.type, 'image/png');
  assert.equal(b, a, 'deux demandes simultanées, un seul téléchargement');
  assert.deepEqual(appels, ['https://exemple.com/', 'https://exemple.com/a.png']);
  await l.obtenir('ex', 'exemple.com');
  assert.equal(appels.length, 2, 'servi depuis le disque ensuite');

  assert.equal(await l.obtenir('rien', 'absent.org'), null);
  const n = appels.length;
  assert.equal(await l.obtenir('rien', 'absent.org'), null);
  assert.equal(appels.length, n, 'échec mémorisé : pas de nouvel essai immédiat');
  assert.equal(await l.obtenir('ip', '10.0.0.1'), null);
  assert.equal(appels.length, n, 'une IP ne déclenche aucun appel');

  l.oublier('ex');
  assert.equal(l.enCache('ex'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('gabarit : deux expressions séparées par une barre ne font pas une seule expression', () => {
  assert.equal(render('{{ a }}|{{ b }}', { a: '12:30', b: '24/09' }), '12:30|24/09');
  assert.deepEqual(render('{{ o }}', { o: { x: 1 } }), { x: 1 }, 'une expression seule garde son type');
});

test('cerveaux : jeton dérivé pour SYNAPSE, adresse humaine, fiche et état du Hub', async () => {
  const crypto = await import('node:crypto');
  const { jetonCerveau, composeVars, renderCompose } = await import('../server/services.js');
  const secret = 'jeton-du-hub-seme-dans-synapse';
  const attendu = 'cer_mapmylan_' + crypto.createHmac('sha256', secret).update('cerveau:mapmylan').digest('hex');
  assert.equal(jetonCerveau(secret, 'mapmylan'), attendu, 'même calcul que SYNAPSE');
  assert.equal(jetonCerveau('', 'mapmylan'), '', 'sans jeton du Hub, pas de jeton de cerveau');
  assert.equal(jetonCerveau(secret, 'Nom Invalide'), '');

  const m = { install: { ports: [], volumes: [] }, capabilities: { accepts: ['memory.brief'], requires: [] }, config: [] };
  const syn = { url: 'http://synapse:8140', hostUrl: 'http://127.0.0.1:8120', name: 'synapse', config: {}, jetonCerveau: n => jetonCerveau(secret, n) };
  const vars = composeVars({ name: 'mapmylan', url: 'http://mapmylan:80', stack: 1 }, m, {}, () => syn, 'port', 'http://192.0.2.10:8110');
  assert.equal(renderCompose('{{provider.memory.brief.jetonCerveau}}', vars), attendu);
  assert.equal(renderCompose('{{service.ui}}', vars), 'http://192.0.2.10:8110');
  assert.equal(renderCompose('[{{provider.memory.brief.jetonCerveau}}]', composeVars({ name: 'x', url: 'u', stack: 1 }, m, {}, () => null)), '[]');

  const { CerveauHub, FICHE_HUB } = await import('../server/ai/cerveau.js');
  const appels = [];
  const inst = { id: 's1', name: 'synapse', version: '1.8.0', status: 'online', manifest: { capabilities: { provides: ['memory.brief'] } } };
  const c = new CerveauHub({
    services: { list: () => [inst, { id: 'm', name: 'mapmylan', status: 'online', version: '1.2.0', manifest: { capabilities: { provides: [] } } }] },
    runtime: { request: async (i, req) => { appels.push([i.name, req.method, req.path, req.body]); return { ok: true }; } },
    store: { list: () => [{ name: 'Scan', enabled: true, lastStatus: 'error' }, { name: 'Veille', enabled: false }] },
    db: { setting: k => (k === 'hub_ui' ? 'http://192.0.2.10:8100' : '') },
    ai: { list: () => [{ name: 'ia-locale', model: 'qwen3:14b', roles: ['config'] }] },
  });
  assert.equal(await c.publier(), 1);
  assert.deepEqual(appels.map(a => a.slice(0, 3)), [['synapse', 'PUT', '/v1/cerveaux/moi'], ['synapse', 'PUT', '/v1/cerveaux/moi/etat']]);
  assert.equal(appels[0][3].ui, 'http://192.0.2.10:8100');
  assert.equal(appels[0][3].titre, FICHE_HUB.titre);
  assert.match(appels[1][3].etat, /Services \(2\) : synapse en ligne v1\.8\.0, mapmylan en ligne v1\.2\.0\. Workflows : 2 au total, 1 actifs, en échec : Scan\. IA du Hub : ia-locale \(qwen3:14b\)\./);

  // Un SYNAPSE sans l'annuaire (404) n'est plus sollicité avant sa mise à jour.
  const vieux = new CerveauHub({ ...c, runtime: { request: async () => { const e = new Error('404'); e.upstreamStatus = 404; throw e; } } });
  Object.assign(vieux, { services: c.services, store: c.store, db: c.db, ai: c.ai });
  assert.equal(await vieux.publier(), 0);
  assert.equal(vieux.ancien.size, 1);
});

test('rangement : un dossier par service, puis par rôle ; un lien va chez celui qui consomme', async () => {
  const { proposerRangement, roleDe, resumeRangement } = await import('../server/workflows/rangement.js');
  const inst = [{ id: 'm', name: 'mapmylan', manifest: { name: 'MapMyLAN' } }, { id: 'v', name: 'vox', manifest: { name: 'VOX' } }, { id: 's', name: 'synapse', manifest: { name: 'SYNAPSE' } }];
  const wf = [
    { id: 1, name: 'Triage des alertes critiques', instances: ['m', 's'], graph: { nodes: [{ type: 'trigger.service' }] } },
    { id: 2, name: 'Quarantaine appareils à risque', instances: ['m'], graph: { nodes: [{ type: 'x' }] } },
    { id: 3, name: 'Scan réseau et analyse des appareils', instances: ['m'], graph: { nodes: [{ type: 'x' }] } },
    { id: 4, name: 'mapmylan utilise voice.tts de vox', instances: ['v', 'm'], graph: { nodes: [{ type: 'core.link' }, { type: 'core.link' }] } },
    { id: 5, name: 'Heure du jour', instances: [], graph: { nodes: [{ type: 'x' }] } },
    { id: 6, name: 'Déjà rangé', dossier: 'Perso', instances: ['m'], graph: { nodes: [{ type: 'x' }] } },
  ];
  const r = proposerRangement(wf, inst);
  assert.deepEqual(r.map(x => [x.id, x.dossier]), [[1, 'MapMyLAN / Alertes'], [2, 'MapMyLAN / Défense'], [3, 'MapMyLAN / Surveillance'], [4, 'MapMyLAN / Liens'], [5, 'Hub / Automatisation']]);
  assert.equal(proposerRangement(wf, inst, { tous: true }).length, 6);
  assert.equal(roleDe(wf[3]), 'Liens');
  assert.match(resumeRangement(r), /- \*\*MapMyLAN \/ Alertes\*\* : 1 — Triage des alertes critiques/);
});


test('image reconstruite sur la machine : « Mettre à jour » s’allume à version égale, et démarre l’image locale sans retélécharger', async () => {
  const { Services } = await import('../server/services.js');
  const { docker } = await import('../server/docker.js');
  const avant = { imagesEnService: docker.imagesEnService, imageId: docker.imageId };
  const enService = { 'hub-synapse': new Map([['ghcr.io/x/synapse:latest', 'sha256:ancienne']]), 'hub-vox': new Map([['ghcr.io/x/vox:latest', 'sha256:meme']]), 'hub-epingle': new Map([['ghcr.io/x/e@sha256:abc', 'sha256:zzz']]) };
  const locales = { 'ghcr.io/x/synapse:latest': 'sha256:nouvelle', 'ghcr.io/x/vox:latest': 'sha256:meme' };
  docker.imagesEnService = async p => enService[p] || new Map();
  docker.imageId = async ref => locales[ref] || null;
  try {
    const s = Object.create(Services.prototype);
    const insts = [{ id: 'a', name: 'synapse', mode: 'compose', version: '1.8.0' }, { id: 'b', name: 'vox', mode: 'compose', version: '6.4.0' }, { id: 'c', name: 'epingle', mode: 'compose' }, { id: 'd', name: 'loin', mode: 'remote' }];
    s.list = () => insts;
    const neuves = await s.verifierImagesLocales();
    assert.deepEqual([...neuves], ['a'], 'seule l’image qui a changé compte ; une image épinglée par empreinte ne bouge pas');
    let appel = null;
    s.get = id => insts.find(i => i.id === id);
    s.versionDisponible = () => null;
    s.redeploy = async (id, _a, o) => { appel = { id, ...o }; };
    await s.update('a', 'test');
    assert.deepEqual(appel, { id: 'a', tirer: false }, 'l’image locale démarre : retélécharger l’étiquette la remplacerait par l’ancienne');
    s.versionDisponible = () => '1.9.0';
    await s.update('a', 'test');
    assert.equal(appel.tirer, true, 'une vraie nouvelle version au catalogue se retélécharge');
  } finally { Object.assign(docker, avant); }
});

test('« connecte voxai sur mapmylan » : les manifestes disent ce qui est branché, sans modèle', async () => {
  const { Agent } = await import('../server/ai/agent.js');
  const vox = { id: 'v', name: 'vox', manifest: { id: 'vox', name: 'VOX', capabilities: { provides: ['voice.tts', 'voice.stt'], accepts: ['llm.chat'] } }, providers: { 'llm.chat': 'o' } };
  const mml = { id: 'm', name: 'mapmylan', manifest: { id: 'mapmylan', name: 'MapMyLAN', capabilities: { provides: ['network.inventory', 'alerts.source'], accepts: ['llm.chat', 'voice.tts', 'voice.stt'] } }, providers: { 'voice.tts': 'v', 'voice.stt': 'v' } };
  const oll = { id: 'o', name: 'ollama', manifest: { id: 'ollama', name: 'Ollama', capabilities: { provides: ['llm.chat', 'llm.embed'] } }, providers: {} };
  const syn = { id: 's', name: 'synapse', manifest: { id: 'synapse', name: 'SYNAPSE', capabilities: { provides: ['memory.brief'], requires: ['llm.embed'] } }, providers: {} };
  const a = Object.create(Agent.prototype);
  a.services = { list: () => [vox, mml, oll, syn] };
  a.store = { list: () => [{ origin: 'Auto', autoKey: 'm:voice.tts:v', dossier: 'MapMyLAN / Liens' }] };
  const d = a.demandeDirecte('connecte voxai sur mapmylan');
  assert.match(d.reponse, /C’est déjà fait : \*\*vox\*\* et \*\*mapmylan\*\* sont reliés/);
  assert.match(d.reponse, /\*\*mapmylan\*\* ← la voix \(il parle\) de \*\*vox\*\* : branché/);
  assert.match(d.reponse, /dossier \*\*MapMyLAN \/ Liens\*\*/);
  // Compatibles mais pas encore branchés : le Hub propose de le faire, il ne renvoie pas vers un bouton.
  syn.providers = {};
  const rel = a.demandeDirecte('relie synapse et ollama');
  assert.match(rel.reply, /pas encore branché[\s\S]*Je relie ce qui manque/);
  assert.deepEqual(rel.steps, [{ tool: 'relier_services', args: { instance: 'synapse', fournisseur: 'ollama', quoi: 'les embeddings', relance: false } }]);
  // Rien en commun : on le dit, avec ce que chacun fournit.
  assert.match(a.demandeDirecte('branche vox avec synapse').reponse, /n’ont rien à s’échanger/);
  // Un seul service nommé : ce n'est pas une liaison, on laisse passer.
  assert.equal(a.demandeDirecte('connecte vox')?.reponse, undefined);
});

test('ligne de commande : « jeton creuset » écrit le seul jeton, et relancer fait une rotation', async () => {
  const { execFileSync } = await import('node:child_process');
  const os = await import('node:os'); const fs = await import('node:fs'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cli-'));
  const lancer = () => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/cli.js', 'jeton', 'creuset'], { env: { ...process.env, HUB_DATA: dir }, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  const a = lancer(), b = lancer();
  assert.match(a, /^hubj_[\w-]{43}\n$/, 'rien d’autre sur la sortie standard');
  assert.notEqual(a, b);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'hub.db'));
  assert.deepEqual(db.prepare('SELECT count(*) n FROM jetons WHERE nom=? AND revoque IS NULL').get('creuset').n, 1, 'l’ancien est révoqué');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('« qui es-tu » : le Hub se présente sans modèle, avec l’état réel', async () => {
  const { Agent } = await import('../server/ai/agent.js');
  const a = Object.create(Agent.prototype);
  a.services = { list: () => [{ name: 'mapmylan', manifest: {} }, { name: 'vox', manifest: {} }] };
  a.store = { list: () => [{}, {}, {}] };
  a.autonomy = () => 'validation';
  assert.deepEqual(a.demandeDirecte('Qui es-tu ?'), { identite: true });
  assert.equal(a.demandeDirecte('qui es-tu et que sais-tu de mapmylan ?'), null, 'une vraie question part au modèle');
  const r = a.identite();
  assert.match(r, /assistant du \*\*Hub\*\*/);
  assert.match(r, /2 services \(mapmylan, vox\) et 3 workflows\. Mode \*\*Validation\*\*/);
  assert.match(r, /\*\*SYNAPSE\*\*, le cerveau commun de tes services/);
});

test('journal du Hub : pannes, retours, mises à jour et échecs racontés à SYNAPSE, sans gabarit rendu', async () => {
  const { EventEmitter } = await import('node:events');
  const { JournalHub, depuisService } = await import('../server/ai/journal.js');
  const syn = { id: 's', name: 'synapse', status: 'online', version: '1.9.0', manifest: { capabilities: { provides: ['memory.ingest'] } } };
  let liste = [syn, { id: 'm', name: 'mapmylan', status: 'online', version: '1.3.4', manifest: {} }];
  const envoyes = [];
  const bus = new EventEmitter();
  const j = new JournalHub({ bus, services: { list: () => liste }, runtime: { request: async (inst, req, o) => { envoyes.push({ inst: inst.name, req, o }); return { ok: true }; } } });
  j.connus = j.photo();
  liste = [syn, { id: 'm', name: 'mapmylan', status: 'offline', version: '1.3.4', status_detail: 'ECONNREFUSED', manifest: {} }];
  j.comparer();
  liste = [syn, { id: 'm', name: 'mapmylan', status: 'online', version: '1.4.0', manifest: {} }];
  j.comparer();
  j.execution({ workflowId: 'w1', workflowName: 'Sauvegarde', status: 'error', error: 'HTTP 500 {{service.token}}' });
  j.execution({ workflowId: 'w1', workflowName: 'Sauvegarde', status: 'error', error: 'encore' });
  j.execution({ workflowId: 'w2', workflowName: 'Météo', status: 'success' });
  const b = j.bilan();
  assert.match(b.title, /1 exécutions réussies, 2 échouées/);
  assert.equal(j.bilan(), null, 'pas d’exécution, pas de bilan');
  await j.vider();
  assert.equal(envoyes.length, 1);
  assert.equal(envoyes[0].o.brut, true, 'le corps part tel quel, jamais rendu comme un gabarit');
  const kinds = envoyes[0].req.body.events.map(e => e.kind);
  assert.deepEqual(kinds, ['incident.service', 'service.updated', 'incident.workflow', 'hub.workflows'], 'un seul incident pour deux échecs rapprochés');
  assert.ok(envoyes[0].req.body.events.every(e => e.tags.includes('hub') && !e.tags.includes('simulation')));
  assert.match(envoyes[0].req.body.events[2].title, /\{\{service\.token\}\}/, 'le texte reste littéral');
  assert.equal(depuisService({ name: 'x', status: 'installing' }, { name: 'x', status: 'error' }), null, 'une installation qui échoue n’est pas une panne');
  assert.equal(depuisService({ name: 'x', status: 'error' }, { name: 'x', status: 'online' }).kind, 'service.recovered');
  // Sans mémoire, rien n'est mis en file.
  liste = liste.filter(i => i.id !== 's');
  j.raconter({ kind: 'x', title: 'y' });
  assert.equal(j.file.length, 0);
});

test('runtime : un corps « brut » n’est pas rendu comme un gabarit', async () => {
  const { Runtime } = await import('../server/runtime.js');
  const { configurer } = await import('../server/sortie.js');
  let recu = null, auth = null;
  configurer({ transport: async (url, o) => { recu = JSON.parse(o.corps); auth = o.entetes.authorization; return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }); } });
  const inst = { id: 's', name: 'synapse', mode: 'compose', url: 'http://synapse.test:8200', manifest: { install: { ports: [] }, api: { baseUrl: '{{service.url}}', auth: { type: 'bearer', token: '{{service.token}}', localToken: 'T' } } } };
  const rt = new Runtime({ services: { configOf: () => ({ T: 'secret-du-service-1234' }), list: () => [inst] } });
  try { await rt.request(inst, { method: 'POST', path: '/v1/ingest/batch', body: { events: [{ title: 'fuite {{service.token}}' }] } }, { brut: true }); }
  finally { configurer({ transport: null }); }
  assert.equal(recu.events[0].title, 'fuite {{service.token}}');
  assert.equal(auth, 'Bearer secret-du-service-1234', 'le jeton ne va que dans l’en-tête');
});

test('réseau : le Hub résout en IPv4 d’abord (sans sortie IPv6, Telegram tombait en « fetch failed »)', async () => {
  await import('../server/main.js');
  const dns = await import('node:dns');
  assert.equal(dns.getDefaultResultOrder(), 'ipv4first');
});


test('docker : la CLI ne voit pas l’environnement du Hub (un « ${…} » de Compose ne lit aucun secret)', async () => {
  const { run } = await import('../server/docker.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faux-docker-'));
  fs.writeFileSync(path.join(dir, 'docker'), '#!/bin/sh\nenv\n', { mode: 0o755 });
  const avant = { PATH: process.env.PATH, s: process.env.SOCLE_SMTP_MDP, h: process.env.DOCKER_HOST };
  process.env.PATH = `${dir}:${avant.PATH}`;
  process.env.SOCLE_SMTP_MDP = 'mot-de-passe-du-relais';
  process.env.DOCKER_HOST = 'tcp://docker-proxy:2375';
  try {
    const vu = await run(['version']);
    assert.doesNotMatch(vu, /mot-de-passe-du-relais|SOCLE_/);
    assert.match(vu, /^DOCKER_HOST=tcp:\/\/docker-proxy:2375$/m);
    assert.match(vu, /^PATH=/m);
  } finally {
    process.env.PATH = avant.PATH;
    for (const [k, v] of [['SOCLE_SMTP_MDP', avant.s], ['DOCKER_HOST', avant.h]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('workflows : le nœud Script JS n’existe plus, et un ancien workflow qui l’utilise dit par quoi le remplacer', async () => {
  const { NODE_DEFS } = await import('../server/workflows/nodes.js');
  assert.equal(NODE_DEFS['data.script'], undefined);
  const { WorkflowStore } = await import('../server/workflows/store.js');
  const store = Object.create(WorkflowStore.prototype);
  store.services = { list: () => [] };
  assert.match(store.introuvable({ id: 's', name: 'Calcul', type: 'data.script' }), /n’existe plus.*Champs/);
  const src = fs.readdirSync(path.join(import.meta.dirname, '../server'), { recursive: true }).filter(f => f.endsWith('.js'))
    .map(f => fs.readFileSync(path.join(import.meta.dirname, '../server', f), 'utf8')).join('\n');
  assert.doesNotMatch(src, /node:vm|new Function\(|\beval\(/, 'aucune évaluation de code dans le serveur');
});

test('webhook de service : sans signature déclarée par le manifeste, rien n’entre', async () => {
  const { Triggers } = await import('../server/triggers.js');
  const graph = { nodes: [{ id: 'n', type: 'trigger.service', instanceId: 'i', ref: 'evt' }] };
  const db = { get: sql => (sql.includes('FROM subscriptions') ? { id: 's', kind: 'service', workflow_id: 'w', node_id: 'n', secret: 'secret' } : { enabled: 1, graph: JSON.stringify(graph) }), run() {}, setting: (k, d) => d };
  const services = { get: () => ({ manifest: { triggers: [{ id: 'evt', delivery: { type: 'webhook', subscribe: {} } }] } }) };
  let demarre = false;
  const t = Object.assign(Object.create(Triggers.prototype), { db, services, vault: { open: v => v }, webhookHits: new Map(), engine: { start: () => { demarre = true; } } });
  const ctx = { rawBody: Buffer.from('{"x":1}'), body: { x: 1 }, req: { headers: {} } };
  await assert.rejects(t.receive('s', ctx), /non signé/);
  assert.equal(demarre, false);
});

test('quotas : débit par minute, quota du jour gardé en base, par compte', async () => {
  const { openDb } = await import('../server/db/index.js');
  const { Quotas } = await import('../server/quotas.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quotas-'));
  const db = openDb(path.join(dir, 'q.db'));
  let t = Date.parse('2026-09-29T10:00:00Z');
  const q = new Quotas(db, { maintenant: () => t });
  for (let i = 0; i < 3; i++) q.prendre('assistant', 'compte:a', { minute: 3, jour: 5 });
  assert.throws(() => q.prendre('assistant', 'compte:a', { minute: 3, jour: 5 }), e => e.status === 429 && /minute/.test(e.message));
  q.prendre('assistant', 'compte:b', { minute: 3, jour: 5 });
  // Un redémarrage garde le compte du jour.
  const q2 = new Quotas(db, { maintenant: () => t });
  q2.prendre('assistant', 'compte:a', { minute: 3, jour: 5 });
  q2.prendre('assistant', 'compte:a', { minute: 3, jour: 5 });
  assert.throws(() => q2.prendre('assistant', 'compte:a', { minute: 3, jour: 5 }), e => e.status === 429 && /Quota du jour/.test(e.message));
  // Le lendemain, le quota repart de zéro.
  t += 86400e3;
  new Quotas(db, { maintenant: () => t }).prendre('assistant', 'compte:a', { minute: 3, jour: 5 });
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('IA : plafond global sur 24 heures et jetons plafonnés par appel', async () => {
  const { AiGateway } = await import('../server/ai/gateway.js');
  const { config } = await import('../server/config.js');
  const ecrits = [];
  let usage = { n: config.iaAppelsJour, t: 10 };
  const reglages = {};
  const db = { get: () => usage, setting: (k, d) => reglages[k] ?? d, setSetting: (k, v) => { reglages[k] = v; } };
  const g = new AiGateway({ db, audit: { write: (...a) => ecrits.push(a) } });
  await assert.rejects(g.chat({ messages: [] }), e => e.status === 429 && /Plafond quotidien/.test(e.message));
  await assert.rejects(g.chat({ messages: [] }), e => e.status === 429);
  assert.equal(ecrits.filter(e => e[1] === 'ia.plafond').length, 1, 'tracé une fois par jour');
  usage = { n: 0, t: config.iaJetonsJour };
  await assert.rejects(g.embed({ input: 'x' }), e => e.status === 429);
  // Le nombre de jetons demandé par un workflow ne dépasse jamais le plafond par appel.
  const corps = [];
  const { configurer } = await import('../server/sortie.js');
  configurer({ transport: async (url, o) => { corps.push(JSON.parse(o.corps)); return Response.json({ message: { content: 'ok' }, prompt_eval_count: 1, eval_count: 1 }); } });
  try { await g.call({ kind: 'ollama', url: 'http://ollama:11434', model: 'm' }, { messages: [], maxTokens: 10_000_000 }); }
  finally { configurer({ transport: null }); }
  assert.equal(corps[0].options.num_predict, config.iaJetonsMax);
});

test('coffre du Hub : la clé posée hors du volume retire la copie du volume, une clé différente arrête tout', async () => {
  const { Vault } = await import('../server/vault.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coffre-hub-'));
  const premier = new Vault(dir);
  const scelle = premier.seal('secret-du-service');
  const fichier = path.join(dir, 'keys', 'master.key');
  const cle = fs.readFileSync(fichier).toString('base64');
  assert.throws(() => new Vault(dir, { cle: crypto.randomBytes(32).toString('base64') }), /diffère de la clé du volume/);
  assert.ok(fs.existsSync(fichier));
  assert.equal(new Vault(dir, { cle }).open(scelle), 'secret-du-service');
  assert.ok(!fs.existsSync(fichier), 'la copie du volume est retirée');
  assert.equal(new Vault(dir, { cle }).open(scelle), 'secret-du-service');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('coffre du Hub : rotation de HUB_CLE, chaque scellé de chaque table rescellé, journal intact, clé inconnue refusée', async () => {
  const { Vault, tournerCle } = await import('../server/vault.js');
  const { openDb } = await import('../server/db/index.js');
  const { Audit } = await import('../server/audit.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-hub-'));
  const K1 = crypto.randomBytes(32).toString('base64'), K2 = crypto.randomBytes(32).toString('base64'), K3 = crypto.randomBytes(32).toString('base64');
  const db = openDb(path.join(dir, 'hub.db'));
  const audit = new Audit(db, null, { sortie: () => {} });
  const v1 = new Vault(dir, { cle: K1 });
  assert.deepEqual(tournerCle({ db, vault: v1, audit }), { lus: 0, rescelles: 0, illisibles: 0, tables: {} });
  assert.equal(tournerCle({ db, vault: v1, audit }), null, 'déjà sous cette clé');
  db.run('INSERT INTO variables(key,value,secret) VALUES(?,?,1)', 'JETON', v1.seal('valeur-de-variable'));
  db.run('INSERT INTO variables(key,value,secret) VALUES(?,?,0)', 'CLAIR', 'v1:pas un scellé');
  db.exec('CREATE TABLE essai_json (id INTEGER PRIMARY KEY, graphe TEXT)');
  const orphelin = 'v1:' + crypto.randomBytes(45).toString('base64');
  db.run('INSERT INTO essai_json(graphe) VALUES(?)', JSON.stringify({ nodes: [{ params: { token: v1.seal('param-secret'), autre: v1.seal('deuxième'), orphelin } }] }));
  audit.write('essai', 'essai.scellé', null, { x: v1.seal('dans le journal') });
  const journalAvant = db.all('SELECT detail, hash FROM audit');
  // Sans l'ancienne clé, une clé neuve est refusée : rien ne serait plus lisible.
  assert.throws(() => tournerCle({ db, vault: new Vault(dir, { cle: K2 }), audit }), /n’est pas la clé qui a écrit cette base/);
  const v2 = new Vault(dir, { cle: K2, ancienne: K1 });
  const bilan = tournerCle({ db, vault: v2, audit });
  assert.equal(bilan.rescelles, 3);
  assert.equal(v2.open(db.get("SELECT value FROM variables WHERE key='JETON'").value), 'valeur-de-variable');
  assert.equal(db.get("SELECT value FROM variables WHERE key='CLAIR'").value, 'v1:pas un scellé');
  const g = JSON.parse(db.get('SELECT graphe FROM essai_json').graphe);
  assert.deepEqual([v2.open(g.nodes[0].params.token), v2.open(g.nodes[0].params.autre)], ['param-secret', 'deuxième']);
  assert.equal(g.nodes[0].params.orphelin, orphelin, 'illisible avec les deux clés : laissé tel quel');
  assert.deepEqual(bilan.tables, { 'essai_json.graphe': 1 });
  assert.throws(() => v1.open(g.nodes[0].params.token), 'l’ancienne clé ne lit plus rien');
  assert.deepEqual(db.all('SELECT detail, hash FROM audit').slice(0, journalAvant.length), journalAvant, 'journal jamais réécrit');
  assert.equal(audit.verify().ok, true);
  assert.deepEqual(JSON.parse(db.get("SELECT detail FROM audit WHERE action='coffre.tourné'").detail), { rescellés: 3, illisibles: 1 });
  assert.equal(tournerCle({ db, vault: v2, audit }), null, 'ancienne clé encore posée : rien à refaire');
  assert.throws(() => tournerCle({ db, vault: v1, audit }), /n’est pas la clé qui a écrit cette base/, 'revenir en arrière est refusé');
  assert.throws(() => tournerCle({ db, vault: new Vault(dir, { cle: K3, ancienne: K1 }), audit }), /HUB_CLE_ANCIENNE non plus/);
  assert.throws(() => new Vault(dir, { cle: K2, ancienne: K2 }), /clé actuelle/);
  assert.throws(() => new Vault(dir, { ancienne: K1 }), /sans HUB_CLE/);
  db.close();
  // Première rotation depuis la clé du volume : le fichier est accepté comme ancienne clé, puis retiré.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-hub-'));
  const duVolume = new Vault(dir2);
  const ancienne = fs.readFileSync(path.join(dir2, 'keys', 'master.key')).toString('base64');
  const db2 = openDb(path.join(dir2, 'hub.db'));
  db2.run('INSERT INTO variables(key,value,secret) VALUES(?,?,1)', 'A', duVolume.seal('a'));
  const neuve = new Vault(dir2, { cle: K2, ancienne });
  assert.ok(!fs.existsSync(path.join(dir2, 'keys', 'master.key')));
  assert.equal(tournerCle({ db: db2, vault: neuve, audit: new Audit(db2, null, { sortie: () => {} }) }).rescelles, 1);
  assert.equal(neuve.open(db2.get("SELECT value FROM variables WHERE key='A'").value), 'a');
  db2.close();
  // Une base existante ouverte avec une clé qui n'y ouvre rien, avant toute empreinte.
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-hub-'));
  const db3 = openDb(path.join(dir3, 'hub.db'));
  db3.run('INSERT INTO variables(key,value,secret) VALUES(?,?,1)', 'A', new Vault(dir3, { cle: K1 }).seal('a'));
  assert.throws(() => tournerCle({ db: db3, vault: new Vault(dir3, { cle: K3 }), audit: new Audit(db3, null, { sortie: () => {} }) }), /n’ouvre aucun des secrets/);
  db3.close();
  for (const d of [dir, dir2, dir3]) fs.rmSync(d, { recursive: true, force: true });
});

test('reprise des comptes 0.5 : mot de passe scrypt relu puis passé en Argon2id, TOTP scellé, tables et code d’appairage retirés', async () => {
  const { openDb } = await import('../server/db/index.js');
  const { migrerComptes } = await import('../server/migration-socle.js');
  const { demarrerSocle } = await import('../socle/src/index.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reprise-05-'));
  const db = openDb(path.join(dir, 'hub.db'));
  // Une ligne telle que la 0.5 l'écrivait : scrypt N=2^15, TOTP en clair et activé.
  const sel = crypto.randomBytes(16), mdp = 'phrase de passe de la version 0.5';
  const dk = crypto.scryptSync(mdp, sel, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  db.run('INSERT INTO users(id,username,pass_hash,role,totp_secret,totp_enabled,created) VALUES(?,?,?,?,?,1,?)', 'u_ancien', 'Ana', `scrypt$32768$${sel.toString('base64')}$${dk.toString('base64')}`, 'admin', secret, 1700000000000);
  db.setSetting('pairing_code', 'ABCD-1234');
  const socle = await demarrerSocle({
    service: { id: 'hub', nom: 'Hub' }, db, dossier: dir, env: { SOCLE_CLE: crypto.randomBytes(32).toString('base64') },
    log: { info() {}, warn() {}, error() {} }, migrer: ({ comptes, coffre }) => migrerComptes({ db, comptes, coffre, log: { info() {} } }),
  });
  try {
    const c = socle.comptes.parIdentifiant('ana');
    assert.equal(c.role, 'admin');
    assert.ok(c.totp.startsWith('v1.') && !c.totp.includes(secret), 'TOTP scellé');
    assert.equal(db.get("SELECT 1 x FROM sqlite_master WHERE name='users'"), undefined);
    assert.equal(db.setting('pairing_code'), null);
    const s = await socle.comptes.connexionMotDePasse({ identifiant: 'ana', motDePasse: mdp, ip: '127.0.0.1', appareil: 'essai' });
    assert.equal(s.etape, 'second');
    assert.ok(socle.comptes.parIdentifiant('ana').mdp.startsWith('$argon2id$'), 'empreinte réécrite en Argon2id');
    assert.equal(socle.coffre.ouvre('totp', socle.comptes.parIdentifiant('ana').totp, c.id), secret, 'le TOTP de la 0.5 reste le même');
    await assert.rejects(socle.comptes.connexionMotDePasse({ identifiant: 'ana', motDePasse: 'mauvaise phrase de passe', ip: '127.0.0.1', appareil: 'essai' }), e => e.status === 401);
  } finally { socle.arreter(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('conservation : questions et exécutions de plus de 90 jours, journal de plus d’un an ; la chaîne reste vérifiable', async () => {
  const { openDb } = await import('../server/db/index.js');
  const { Audit } = await import('../server/audit.js');
  const { purgerDonnees } = await import('../server/retention.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conservation-'));
  const db = openDb(path.join(dir, 'h.db'));
  const lignes = [];
  const audit = new Audit(db, null, { sortie: l => lignes.push(JSON.parse(l)) });
  const maintenant = Date.now(), jour = 86400e3;
  // Une ligne écrite il y a 400 jours : l'horloge est reculée le temps de l'écrire.
  const vraie = Date.now;
  Date.now = () => maintenant - 400 * jour;
  try { audit.write('ana', 'ancien'); } finally { Date.now = vraie; }
  audit.write('ana', 'récent', null, { mot_de_passe: 'x' });
  db.run("INSERT INTO agent_plans(id,request,plan,status,created) VALUES('p1','vieille question','{}','answered',?), ('p2','question du jour','{}','answered',?)", maintenant - 100 * jour, maintenant);
  const r = purgerDonnees(db, audit, maintenant);
  assert.equal(r.questions, 1);
  assert.equal(r.journal, 1);
  assert.deepEqual(db.all('SELECT id FROM agent_plans').map(x => x.id), ['p2']);
  assert.deepEqual(db.all('SELECT action FROM audit ORDER BY seq').map(x => x.action), ['récent', 'journal.purgé']);
  assert.deepEqual(audit.verify(), { ok: true, entries: 2 });
  assert.ok(lignes.some(l => l.journal === 'hub-audit' && l.action === 'journal.purgé'), 'la purge part aussi sur la sortie');
  assert.ok(!JSON.stringify(lignes).includes('"x"'), 'rien de sensible sur la sortie');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('configuration : une valeur fausse arrête le démarrage, avec la liste des erreurs', async () => {
  const { lireConfigHub } = await import('../server/config.js');
  assert.throws(() => lireConfigHub({ HUB_PORT: 'huit-mille', HUB_REGISTRY: 'ftp://ailleurs', HUB_CLE: 'trop-courte' }), e => ['HUB_PORT', 'HUB_REGISTRY', 'HUB_CLE'].every(n => e.message.includes(n)));
  assert.throws(() => lireConfigHub({ HUB_SECURE_COOKIES: '1' }), /SOCLE_PROXYS/);
  const { spawnSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-'));
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/main.js'], { cwd: path.join(import.meta.dirname, '..'), env: { PATH: process.env.PATH, HUB_DATA: dir, HUB_PORT: 'huit-mille' }, encoding: 'utf8', timeout: 20000 });
  assert.notEqual(r.status, 0, 'le processus ne démarre pas');
  assert.match(r.stderr + r.stdout, /HUB_PORT/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sauvegarde : chiffrée pour une clé publique, relue seulement avec la clé privée, restaurée dans une base qui démarre', async () => {
  const { execFileSync } = await import('node:child_process');
  const { DatabaseSync } = await import('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-sauv-'));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
  fs.writeFileSync(path.join(dir, 'publique.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
  fs.writeFileSync(path.join(dir, 'privee.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const env = { PATH: process.env.PATH, HUB_DATA: path.join(dir, 'donnees') };
  const cli = (args, o = {}) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/cli.js', ...args], { env, stdio: ['pipe', 'pipe', 'pipe'], ...o });
  cli(['jeton', 'essai']);
  assert.equal(cli(['coupure']).toString(), 'ia : en service\nworkflows : en service\n');
  assert.equal(cli(['coupure', 'ia', 'oui']).toString(), 'ia : COUPÉ\nworkflows : en service\n');
  assert.match(cli(['coupure', 'ia', 'non']).toString(), /^ia : en service/);
  assert.throws(() => cli(['coupure', 'tout', 'oui']), /Usage/);
  assert.throws(() => cli(['sauvegarde']), /HUB_SAUVEGARDE_CLE/);
  const sauv = cli(['sauvegarde'], { env: { ...env, HUB_SAUVEGARDE_CLE_FILE: path.join(dir, 'publique.pem') } });
  assert.match(sauv.subarray(0, 10).toString(), /^HUB-SAUV1\n/);
  assert.ok(!sauv.includes(Buffer.from('SQLite format 3')) && !sauv.includes(Buffer.from('essai')), 'rien en clair');
  const cible = path.join(dir, 'restauree.db');
  cli(['restaurer', path.join(dir, 'privee.pem'), cible], { input: sauv });
  const db = new DatabaseSync(cible);
  assert.equal(db.prepare('SELECT count(*) n FROM jetons WHERE nom = ?').get('essai').n, 1);
  assert.ok(db.prepare("SELECT 1 FROM audit WHERE action = 'sauvegarde.faite'").get() === undefined, 'l’instantané précède sa propre trace');
  db.close();
  // Une sauvegarde altérée, ou une autre clé privée : refusée.
  const abimee = Buffer.from(sauv); abimee[abimee.length - 40] ^= 1;
  assert.throws(() => cli(['restaurer', path.join(dir, 'privee.pem'), path.join(dir, 'x.db')], { input: abimee }));
  const autre = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  fs.writeFileSync(path.join(dir, 'autre.pem'), autre);
  assert.throws(() => cli(['restaurer', path.join(dir, 'autre.pem'), path.join(dir, 'y.db')], { input: sauv }));
  const { spawnSync } = await import('node:child_process');
  const deja = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/cli.js', 'restaurer', path.join(dir, 'privee.pem'), cible], { env, input: '', encoding: 'utf8' });
  assert.notEqual(deja.status, 0);
  assert.match(deja.stderr, /existe déjà/, 'une base existante n’est jamais écrasée');
  // Une clé trop faible est refusée.
  const faible = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' });
  fs.writeFileSync(path.join(dir, 'faible.pem'), faible);
  assert.throws(() => cli(['sauvegarde'], { env: { ...env, HUB_SAUVEGARDE_CLE_FILE: path.join(dir, 'faible.pem') } }), /3072 bits/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('dossiers : renommer « a_b » ne touche pas « axb » (le _ n’est pas un joker)', async () => {
  const { openDb } = await import('../server/db/index.js');
  const { WorkflowStore } = await import('../server/workflows/store.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dossiers-'));
  const db = openDb(path.join(dir, 'h.db'));
  const store = Object.assign(Object.create(WorkflowStore.prototype), { db, audit: { write() {} }, bus: { emit() {} } });
  for (const c of ['a_b', 'a_b / c', 'axb', 'axb / c']) db.run('INSERT INTO workflow_dossiers(chemin, created) VALUES(?, ?)', c, 0);
  store.renommerDossier('a_b', 'z', 'moi');
  assert.deepEqual(db.all('SELECT chemin FROM workflow_dossiers ORDER BY chemin').map(r => r.chemin), ['axb', 'axb / c', 'z', 'z / c']);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('base : dossier en 0700 et fichier en 0600, lisibles par le Hub seul', async () => {
  const { openDb } = await import('../server/db/index.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'droits-'));
  fs.mkdirSync(path.join(dir, 'donnees'), { mode: 0o755 });
  const db = openDb(path.join(dir, 'donnees', 'hub.db'));
  db.close();
  assert.equal(fs.statSync(path.join(dir, 'donnees')).mode & 0o777, 0o700, 'un dossier existant est resserré');
  assert.equal(fs.statSync(path.join(dir, 'donnees', 'hub.db')).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mémoire commune : lue et nourrie par les conversations des administrateurs et de leurs jetons seulement', async () => {
  const { Agent } = await import('../server/ai/agent.js');
  const roles = { ana: 'admin', bruno: 'membre', chloe: 'lecture' };
  const memoire = { apprendre() {} };
  const a = new Agent({ db: { get: (sql, id) => (roles[id] ? { role: roles[id] } : undefined) }, memoire });
  assert.equal(a.memoireDe('ana'), memoire);
  assert.equal(a.memoireDe('jeton:j1'), memoire);
  assert.equal(a.memoireDe(null), memoire, 'le Hub lui-même');
  assert.equal(a.memoireDe('bruno'), null);
  assert.equal(a.memoireDe('chloe'), null);
  assert.equal(a.memoireDe('inconnu'), null);
});

test('menu : {{hub.disposition}} porte la position du service, à gauche par défaut ; seule une pile qui pose SOCLE_DISPOSITION la suit', async () => {
  const { composeVars, renderCompose } = await import('../server/services.js');
  const { DISPOSITIONS, dispositionPour, reglageDisposition, pileSuitLaDisposition } = await import('../server/theme.js');
  assert.deepEqual(DISPOSITIONS, ['gauche', 'haut', 'bas', 'droite']);
  assert.equal(renderCompose('SOCLE_DISPOSITION: "{{hub.disposition}}"', composeVars({ name: 'vigie', stack: 2 }, { install: {} }, {})), 'SOCLE_DISPOSITION: "gauche"');
  assert.equal(renderCompose('SOCLE_DISPOSITION: "{{hub.disposition}}"', composeVars({ name: 'vigie', stack: 2 }, { install: {} }, {}, () => null, 'loopback', '', 'soma', 'bas')), 'SOCLE_DISPOSITION: "bas"');
  assert.deepEqual(['    SOCLE_DISPOSITION: "haut"', 'SOCLE_THEME: "soma"', '# SOCLE_DISPOSITION: x'].map(pileSuitLaDisposition), [true, false, false]);
  const reglages = {};
  const db = { setting: (k, d) => (k in reglages ? reglages[k] : d) };
  assert.deepEqual(reglageDisposition(db), { mode: 'commun', commun: 'gauche', parService: {} });
  Object.assign(reglages, { disposition: 'haut', disposition_par_service: { vigie: 'droite', bad: 'milieu' }, theme_mode: 'service' });
  const r = reglageDisposition(db);
  assert.deepEqual(r.parService, { vigie: 'droite' }, 'une valeur inconnue enregistrée est ignorée');
  assert.deepEqual([dispositionPour(r, 'vigie'), dispositionPour(r, 'hub')], ['droite', 'haut']);
  reglages.theme_mode = 'commun';
  assert.equal(dispositionPour(reglageDisposition(db), 'vigie'), 'haut', 'thème pour tout : la position commune');
  reglages.disposition = 'milieu';
  assert.equal(reglageDisposition(db).commun, 'gauche');
});

test('thème : {{hub.theme}} porte la gamme du service, SOMA à défaut ; seule une pile qui pose SOCLE_THEME la suit', async () => {
  const { composeVars, renderCompose } = await import('../server/services.js');
  const { gammeDu, gammePour, reglageTheme, pileSuitLaGamme, GAMMES } = await import('../server/theme.js');
  assert.deepEqual(GAMMES, ['soma', 'console', 'exploitation', 'lavande']);
  // Lavande n'arrive qu'à un Compose qui lit {{hub.apparence}} : les autres socles la refuseraient, ils reçoivent SOMA.
  const lavande = composeVars({ name: 'proxlab', stack: 2 }, { install: {} }, {}, () => null, 'loopback', '', 'lavande');
  assert.deepEqual(['{{hub.theme}}', '{{hub.gamme}}', '{{hub.apparence}}'].map(v => renderCompose(`SOCLE_THEME: "${v}"`, lavande)), ['SOCLE_THEME: "soma"', 'SOCLE_THEME: "soma"', 'SOCLE_THEME: "lavande"']);
  const { composeLitApparence, gammesOffertes, gammeRecue } = await import('../server/theme.js');
  assert.deepEqual(['SOCLE_THEME: "{{hub.apparence}}"', 'SOCLE_THEME: "{{ hub.apparence }}"', 'SOCLE_THEME: "{{hub.gamme}}"'].map(composeLitApparence), [true, true, false]);
  assert.deepEqual(['premieres', 'exploitation', 'toutes'].map(gammesOffertes), [['soma', 'console'], ['soma', 'console', 'exploitation'], GAMMES]);
  assert.deepEqual(['premieres', 'exploitation', 'toutes'].map(n => gammeRecue('lavande', n)), ['soma', 'soma', 'lavande']);
  assert.equal(renderCompose('SOCLE_THEME: "{{hub.theme}}"', composeVars({ name: 'mapmylan', stack: 2 }, { install: {} }, {})), 'SOCLE_THEME: "soma"');
  // Un socle publié avant Exploitation refuse au démarrage une gamme inconnue :
  // {{hub.theme}} ne rend que SOMA ou Console ; {{hub.gamme}} rend toutes les gammes.
  const exploitation = composeVars({ name: 'proxlab', stack: 2 }, { install: {} }, {}, () => null, 'loopback', '', 'exploitation');
  assert.equal(renderCompose('SOCLE_THEME: "{{hub.theme}}"', exploitation), 'SOCLE_THEME: "soma"');
  assert.equal(renderCompose('SOCLE_THEME: "{{hub.gamme}}"', exploitation), 'SOCLE_THEME: "exploitation"');
  const { composeLitToutes } = await import('../server/theme.js');
  assert.deepEqual(['SOCLE_THEME: "{{hub.gamme}}"', 'SOCLE_THEME: "{{ hub.gamme }}"', 'SOCLE_THEME: "{{hub.theme}}"'].map(composeLitToutes), [true, true, false]);
  assert.equal(renderCompose('SOCLE_THEME: "{{hub.theme}}"', composeVars({ name: 'mapmylan', stack: 2 }, { install: {} }, {}, () => null, 'loopback', '', 'console')), 'SOCLE_THEME: "console"');
  const reglages = (v = {}) => ({ setting: (k, d) => (k in v ? v[k] : d) });
  assert.equal(gammeDu(reglages()), 'soma');
  assert.equal(gammeDu(reglages({ theme_services: 'console' })), 'console');
  assert.equal(gammeDu(reglages({ theme_services: 'inconnue' })), 'soma');
  assert.deepEqual(reglageTheme(reglages()), { mode: 'commun', commun: 'soma', parService: {} });
  const r = reglageTheme(reglages({ theme_mode: 'service', theme_services: 'console', theme_par_service: { hub: 'soma', a: 'inconnue', b: 'console' } }));
  assert.deepEqual(r.parService, { hub: 'soma', b: 'console' }, 'une valeur inconnue est écartée');
  assert.deepEqual(['hub', 'a', 'b', 'c'].map(k => gammePour(r, k)), ['soma', 'console', 'console', 'console']);
  assert.equal(gammePour({ ...r, mode: 'commun' }, 'hub'), 'console', 'en mode commun, les choix par service sont ignorés');
  assert.equal(reglageTheme(reglages({ theme_mode: 'autre', theme_par_service: ['x'] })).mode, 'commun');
  assert.deepEqual(reglageTheme(reglages({ theme_par_service: ['console'] })).parService, {});
  assert.equal(pileSuitLaGamme('services:\n  api:\n    environment:\n      SOCLE_THEME: "console"\n'), true);
  assert.equal(pileSuitLaGamme('services:\n  oracle:\n    environment:\n      SOCLE_CLE: "x"\n'), false);
  assert.equal(pileSuitLaGamme('# SOCLE_THEME: absent'), false);
});

test('menu : seuls les services qui lisent la position et dont la position a changé sont redéployés, une fois', async () => {
  const { Services } = await import('../server/services.js');
  const reglage = { theme_mode: 'commun', theme_services: 'soma', disposition: 'gauche' };
  const s = new Services({ db: { setting: (k, d) => (k in reglage ? reglage[k] : d), all: () => [], get: () => null, run() {} }, vault: { openFields: o => o, sealFields: o => o }, audit: { write() {} }, bus: { emit() {} }, registry: { get: () => null } });
  s.suiventLaGamme = () => [{ id: 'a', name: 'vigie' }, { id: 'b', name: 'relay' }];
  s.suiventLaDisposition = () => [{ id: 'a', name: 'vigie' }, { id: 'c', name: 'proxlab' }];
  const faits = [];
  s.redeploy = async id => { faits.push(id); };
  const g = s.gammesDesServices(), d = s.dispositionsDesServices();
  assert.deepEqual(d, { a: 'gauche', c: 'gauche' });
  reglage.disposition = 'haut';
  assert.deepEqual(s.appliquerGamme('admin', g, d), ['vigie', 'proxlab']);
  // Gamme et position changées ensemble : un seul redémarrage par service.
  const g2 = s.gammesDesServices(), d2 = s.dispositionsDesServices();
  Object.assign(reglage, { theme_services: 'console', disposition: 'bas' });
  assert.deepEqual(s.appliquerGamme('admin', g2, d2), ['vigie', 'relay', 'proxlab']);
  await new Promise(r => setImmediate(r));
  assert.deepEqual(faits.sort(), ['a', 'a', 'b', 'c', 'c'], 'deux réglages appliqués : chacun une fois par réglage');
});

test('thème : seuls les services qui lisent la gamme et dont la gamme a changé sont redéployés', async () => {
  const { Services } = await import('../server/services.js');
  const reglage = { theme_mode: 'commun', theme_services: 'soma', theme_par_service: {} };
  const s = new Services({ db: { setting: (k, d) => (k in reglage ? reglage[k] : d), all: () => [], get: () => null, run() {} }, vault: { openFields: o => o, sealFields: o => o }, audit: { write() {} }, bus: { emit() {} }, registry: { get: () => null } });
  const suivent = [{ id: 'a', name: 'mapmylan' }, { id: 'b', name: 'sentinel' }];
  s.suiventLaGamme = () => suivent;
  const faits = [];
  s.redeploy = async id => { faits.push(id); };
  const avant = s.gammesDesServices();
  assert.deepEqual(avant, { a: 'soma', b: 'soma' });
  Object.assign(reglage, { theme_mode: 'service', theme_par_service: { a: 'console', hub: 'console' } });
  assert.deepEqual(s.appliquerGamme('admin', avant), ['mapmylan']);
  await new Promise(r => setImmediate(r));
  assert.deepEqual(faits, ['a']);
  assert.deepEqual(s.appliquerGamme('admin', s.gammesDesServices()), [], 'rien n’a bougé : rien ne redémarre');
  // Exploitation : seul un service qui la connaît change ; l'autre la reçoit en SOMA et ne redémarre pas.
  reglage.services_toutes_gammes = ['b'];
  Object.assign(reglage, { theme_mode: 'commun', theme_services: 'soma' });
  const avantExploitation = s.gammesDesServices();
  reglage.theme_services = 'exploitation';
  faits.length = 0;
  assert.deepEqual(s.gammesDesServices(), { a: 'soma', b: 'exploitation' });
  assert.deepEqual(s.appliquerGamme('admin', avantExploitation), ['sentinel']);
  await new Promise(r => setImmediate(r));
  assert.deepEqual(faits, ['b']);
  // Lavande : seul un service qui lit {{hub.apparence}} la reçoit ; pour les autres, rien ne change (SOMA).
  reglage.services_apparence = ['a'];
  reglage.theme_services = 'soma';
  const avantLavande = s.gammesDesServices();
  reglage.theme_services = 'lavande';
  faits.length = 0;
  assert.deepEqual(s.gammesDesServices(), { a: 'lavande', b: 'soma' });
  assert.deepEqual(s.appliquerGamme('admin', avantLavande), ['mapmylan']);
  await new Promise(r => setImmediate(r));
  assert.deepEqual(faits, ['a']);
});

test('minHubVersion : un service qui demande un Hub plus récent est refusé avant tout appel à Docker', async () => {
  const { Services } = await import('../server/services.js');
  const { config } = await import('../server/config.js');
  const s = new Services({ db: { setting: (k, d) => d, all: () => [], get: () => null, run() {} }, vault: { openFields: o => o, sealFields: o => o }, audit: { write() {} }, bus: { emit() {} }, registry: { get: () => null } });
  const [a, b, c] = config.version.split('.').map(Number);
  await assert.rejects(s.deploy({ name: 'mapmylan', manifest: { name: 'MapMyLAN', minHubVersion: `${a}.${b}.${c + 1}`, install: {} } }, {}),
    e => e.status === 409 && e.message.includes(`${a}.${b}.${c + 1}`) && e.message.includes(config.version));
});

test('courriel du Hub : mot de passe du relais scellé, jamais relu par l’interface, valeurs contrôlées', async () => {
  const { poserCourriel, vueCourriel, reglageCourriel } = await import('../server/courriel.js');
  const m = new Map();
  const db = { setting: (k, d) => m.has(k) ? m.get(k) : d, setSetting: (k, v) => m.set(k, v) };
  const vault = { seal: x => 'v1:' + Buffer.from(x).toString('base64'), open: x => Buffer.from(x.slice(3), 'base64').toString() };
  const audit = { lignes: [], write(...a) { this.lignes.push(a); } };
  const v = poserCourriel(db, vault, audit, { defaut: 'parc@exemple.org', relais: { hote: 'smtp.exemple.org', port: 587, securite: 'starttls', utilisateur: 'u', motdepasse: 'secret-du-relais', de: 'hub@exemple.org' } }, 'ana');
  assert.equal(v.relais.motdepasse, '••••');
  assert.ok(!JSON.stringify(m.get('courriel_comptes')).includes('secret-du-relais'), 'scellé au repos');
  assert.equal(reglageCourriel(db, vault).relais.motdepasse, 'secret-du-relais');
  poserCourriel(db, vault, audit, { relais: { port: 465, securite: 'tls' } }, 'ana');
  assert.equal(reglageCourriel(db, vault).relais.motdepasse, 'secret-du-relais', 'mot de passe absent : inchangé');
  assert.ok(!JSON.stringify(audit.lignes).includes('secret-du-relais'), 'jamais au journal');
  for (const mauvais of [{ defaut: 'x' }, { relais: { hote: 'a b' } }, { relais: { port: 0 } }, { relais: { securite: 'aucune' } }, { relais: { motdepasse: 'a\r\nb' } }]) {
    assert.throws(() => poserCourriel(db, vault, audit, mauvais, 'ana'), /invalide|chiffrement/, JSON.stringify(mauvais));
  }
  assert.equal(vueCourriel(db, vault).actif, true);
});

test('comptes du socle : une adresse vidée se retire', async () => {
  const inst = { id: 'i3', name: 's', status: 'online', manifest: { name: 'S', accounts: { tokenKey: 'T', fields: { id: '$.id', name: '$.identifiant' }, list: { method: 'GET', path: '/api/compte/hub/comptes' }, update: { method: 'PATCH', path: '/x' } } } };
  const appels = [];
  const acc = new Accounts({ comptes: {}, audit: { write() {} }, services: { get: () => inst, list: () => [inst], configOf: () => ({}) }, runtime: { request: async (i, req) => { appels.push(req); return {}; } } });
  await acc.update('i3', 'c_1', { email: '' }, 'ana');
  assert.deepEqual(appels.at(-1).body, { retirerCourriel: true });
});

test('version de l’image : elle suit le catalogue, jamais vers le bas, sauf choisie à la main', async () => {
  const { Services, etiquetteFixe, etiquetteDe, imageEpinglee } = await import('../server/services.js');
  assert.equal(etiquetteFixe('2.0.3'), true);
  assert.equal(etiquetteFixe('v1.4.1-rc.1'), true);
  for (const t of ['latest', 'main', '2', '2.0', '', undefined]) assert.equal(etiquetteFixe(t), false, String(t));
  assert.equal(etiquetteDe('ghcr.io/codexx64/mapmylan:2.0.3'), '2.0.3');
  assert.equal(etiquetteDe('registre.local:5000/a/b'), 'latest');
  assert.equal(etiquetteDe('registre.local:5000/a/b:1.2.3@sha256:abc'), '1.2.3');

  const m = def => ({ id: 'x', name: 'X', version: def, icon: '', description: '', triggers: [], actions: [], probes: [], capabilities: {},
    config: [{ key: 'IMAGE_TAG', type: 'string', default: def }], install: { type: 'compose' } });
  assert.equal(imageEpinglee(m('2.0.3'), { IMAGE_TAG: '2.0.3' }), false);
  assert.equal(imageEpinglee(m('2.0.3'), { IMAGE_TAG: '2.0.1' }), true);

  const essai = (actuelle, cible, epinglee = 0) => {
    const ligne = { id: 'i1', ext_id: 'x', name: 's1', mode: 'compose', url: '', stack: 1, image_epinglee: epinglee,
      config: JSON.stringify({ IMAGE_TAG: actuelle }), manifest: JSON.stringify(m('2.0.0')), version: '2.0.0', status: 'online', created: 0, providers: '[]' };
    const s = new Services({
      db: { get: () => ligne, setting: (k, d) => d, all: () => [], run: (sql, ...a) => { if (/SET config=/.test(sql)) ligne.config = a[0]; if (/SET manifest=/.test(sql)) { ligne.manifest = a[0]; ligne.version = a[1]; } } },
      vault: { sealFields: o => o, openFields: o => o }, audit: { write() {} }, bus: { emit() {} }, registry: { get: () => ({ manifest: m(cible) }) },
    });
    s.attach({ runtime: {}, capabilities: { onAdded: () => [] } });
    const out = s.syncManifest('i1', 'moi');
    return { tag: JSON.parse(ligne.config).IMAGE_TAG, image: out.image };
  };
  assert.deepEqual(essai('2.0.0', '2.0.3'), { tag: '2.0.3', image: { de: '2.0.0', vers: '2.0.3' } });
  assert.equal(essai('latest', '2.0.3').tag, '2.0.3', 'l’ancien défaut mobile laisse place à la version publiée');
  assert.equal(essai('2.0.0', '2.0.3', 1).tag, '2.0.0', 'choisie à la main : gardée');
  assert.equal(essai('2.1.0', '2.0.3').tag, '2.1.0', 'jamais vers le bas');
  assert.equal(essai('2.0.0', 'latest').tag, '2.0.0', 'un défaut mobile ne remplace pas une version fixe');
  assert.equal(essai('2.0.3', '2.0.3').image, null);
});

test('version de l’image choisie dans les réglages : épinglée, et désépinglée en revenant au défaut', async () => {
  const { Services } = await import('../server/services.js');
  const m = { id: 'x', name: 'X', version: '2.0.3', icon: '', description: '', triggers: [], actions: [], probes: [], capabilities: {},
    config: [{ key: 'IMAGE_TAG', type: 'string', default: '2.0.3' }, { key: 'A', type: 'string', default: '1' }], install: { type: 'compose' } };
  const ligne = { id: 'i1', ext_id: 'x', name: 's1', mode: 'compose', url: '', stack: 1, image_epinglee: 0,
    config: JSON.stringify({ IMAGE_TAG: '2.0.3', A: '1' }), manifest: JSON.stringify(m), version: '2.0.3', status: 'online', created: 0, providers: '[]' };
  const s = new Services({
    db: { get: () => ligne, setting: (k, d) => d, all: () => [], run: (sql, ...a) => { if (/SET config=/.test(sql)) ligne.config = a[0]; if (/SET image_epinglee=/.test(sql)) ligne.image_epinglee = a[0]; } },
    vault: { sealFields: o => o, openFields: o => o }, audit: { write() {} }, bus: { emit() {} }, registry: { get: () => ({ manifest: m }) },
  });
  s.attach({ runtime: {}, capabilities: { onAdded: () => [] } });
  s.updateConfig('i1', { IMAGE_TAG: '2.0.1' }, 'moi');
  assert.equal(ligne.image_epinglee, 1);
  s.updateConfig('i1', { A: '2' }, 'moi');
  assert.equal(ligne.image_epinglee, 1, 'un autre réglage ne touche pas l’épingle');
  s.updateConfig('i1', { IMAGE_TAG: '2.0.3' }, 'moi');
  assert.equal(ligne.image_epinglee, 0);
});

test('mise à jour : une version fixe déjà sur la machine ne passe pas par le registre ; une étiquette mobile refusée garde l’image locale sans alerte', async () => {
  const { Services } = await import('../server/services.js');
  const { docker } = await import('../server/docker.js');
  const garde = { ...docker };
  const tires = [], etapes = [];
  const locales = { 'ghcr.io/x/a:2.0.3': 'sha256:neuve', 'ghcr.io/x/b:latest': 'sha256:b' };
  Object.assign(docker, {
    available: async () => true, ensureNetwork: async () => {}, up: async () => {},
    imagesEnService: async p => new Map(p === 'hub-a' ? [['ghcr.io/x/a:2.0.0', 'sha256:vieille']] : [['ghcr.io/x/b:latest', 'sha256:b']]),
    imageId: async r => locales[r] || null, imageExists: async r => !!locales[r],
    pullImage: async r => { tires.push(r); throw new Error('Error response from daemon: denied'); },
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-tirer-'));
  try {
    const s = Object.create(Services.prototype);
    Object.assign(s, {
      db: { setting: (k, d) => d }, vault: { open: v => v },
      registry: { composeFile: async e => e.tpl }, runtime: { context: i => ({ config: i.config }) },
      expositionDe: () => 'loopback', fournisseurPour: () => null, stackFile: i => path.join(dir, i.name, 'compose.yml'),
      progress: (_i, t, e = 'ok') => etapes.push({ t, e }), addRoute: async () => {},
    });
    const inst = (name, tag) => ({ id: name, name, mode: 'compose', config: { IMAGE_TAG: tag }, manifest: { id: name, config: [{ key: 'IMAGE_TAG', type: 'string' }], install: { type: 'compose', ports: [] } } });
    await s.deploy(inst('a', '2.0.3'), { tpl: 'services:\n  a:\n    image: ghcr.io/x/a:{{config.IMAGE_TAG}}\n' }, { tirer: true });
    assert.deepEqual(tires, [], 'une version publiée ne change pas : pas de téléchargement');
    assert.ok(etapes.some(x => x.t === 'Image déjà présente : ghcr.io/x/a:2.0.3'));
    assert.ok(!etapes.some(x => /Même image/.test(x.t)), 'la nouvelle étiquette est un changement');
    etapes.length = 0;
    await s.deploy(inst('b', 'latest'), { tpl: 'services:\n  b:\n    image: ghcr.io/x/b:{{config.IMAGE_TAG}}\n' }, { tirer: true });
    assert.deepEqual(tires, ['ghcr.io/x/b:latest']);
    assert.deepEqual(etapes.filter(x => x.e === 'warn'), [], 'aucune alerte : l’image locale fait l’affaire');
    assert.ok(etapes.some(x => x.t === 'Image de cette machine : ghcr.io/x/b:latest (registre : accès refusé par le registre : image privée, ou jamais publiée)'));
  } finally { Object.assign(docker, garde); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('HTTPS du Hub : servi sur son port, par son nom comme par son IP, le clair redirigé, le test de santé et les voisins Docker servis', async t => {
  const { execFileSync } = await import('node:child_process');
  try { execFileSync('openssl', ['version']); } catch { t.skip('openssl absent'); return; }
  const https = (await import('node:https')).default;
  const http = (await import('node:http')).default;
  const { serveurDouble, cibleHttps, hoteDe, nomInterne } = await import('../server/http/tls.js');

  assert.deepEqual(hoteDe('[::1]:8100'), { nom: '::1', port: '8100' });
  assert.equal(nomInterne('hub'), true);
  assert.equal(nomInterne('localhost'), false);
  assert.equal(nomInterne('hub.home.arpa'), false);
  assert.equal(cibleHttps('192.0.2.10:8100', '/x?y=1'), 'https://192.0.2.10:8100/x?y=1', 'une IP reste une IP');
  assert.equal(cibleHttps('localhost:8100', '/'), 'https://localhost:8100/', 'le tunnel garde localhost');
  assert.equal(cibleHttps('[2001:db8::1]:8100', '/'), 'https://[2001:db8::1]:8100/');
  assert.equal(cibleHttps('192.0.2.10:8100', '//evil.example/'), 'https://192.0.2.10:8100//evil.example/', 'le chemin reste un chemin');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', path.join(dir, 'hub.key'), '-out', path.join(dir, 'hub.crt'),
    '-days', '2', '-subj', '/CN=hub.home.arpa', '-addext', 'subjectAltName=DNS:hub.home.arpa,DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  const ca = fs.readFileSync(path.join(dir, 'hub.crt'));
  const alertes = [];
  let local = false;
  const s = serveurDouble((req, res) => { res.end(`ok ${req.socket.encrypted ? 'tls' : 'clair'} ${req.url}`); },
    { dossier: dir, journal: { info() {}, warn: m => alertes.push(m) }, estLocal: () => local });
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  const appel = (mod, host, chemin = '/api/status') => new Promise((resolve, reject) => {
    const r = mod.request({ host: '127.0.0.1', port, path: chemin, headers: { host }, ca, servername: 'hub.home.arpa' }, res => {
      let corps = ''; res.on('data', d => { corps += d; }); res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, corps }));
    });
    r.on('error', reject); r.end();
  });
  try {
    assert.deepEqual(await appel(https, `hub.home.arpa:${port}`), { status: 200, location: undefined, corps: 'ok tls /api/status' });
    assert.deepEqual(await appel(https, `192.0.2.10:${port}`), { status: 200, location: undefined, corps: 'ok tls /api/status' }, 'IP en HTTPS : servie');
    let r = await appel(http, `192.0.2.10:${port}`, '/comptes');
    assert.equal(r.status, 308);
    assert.equal(r.location, `https://192.0.2.10:${port}/comptes`, 'IP en clair : la même adresse en HTTPS');
    r = await appel(http, `localhost:${port}`);
    assert.equal(r.location, `https://localhost:${port}/api/status`);
    assert.equal((await appel(http, `hub:${port}`)).corps, 'ok clair /api/status', 'webhook d’un service voisin');
    local = true;
    assert.equal((await appel(http, `192.0.2.10:${port}`)).corps, 'ok clair /api/status', 'test de santé du conteneur');
    assert.equal(alertes.length, 1, 'expire dans deux jours : signalé');
    assert.match(alertes[0], /expire dans 2 jour/);
  } finally { await new Promise(r => s.close(r)); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('HTTPS du Hub : publié hors de la boucle locale sans certificat, il ne démarre pas', async () => {
  const { spawnSync } = await import('node:child_process');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-sans-tls-'));
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/main.js'], {
    cwd: path.join(import.meta.dirname, '..'), encoding: 'utf8', timeout: 20000,
    env: { ...process.env, HUB_DATA: data, HUB_PORT: '0', HUB_BIND_IP: '0.0.0.0', HUB_TLS_DIR: path.join(data, 'tls') },
  });
  fs.rmSync(data, { recursive: true, force: true });
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /HUB_BIND_IP=0\.0\.0\.0 publie le Hub sur le réseau/);
});

test('Connexions : sans Relay rien ; avec lui, publication idempotente des services installés ici, refus clairs', async () => {
  const { Connexions, portPublie } = await import('../server/connexions.js');
  const man = (ports, provides = []) => ({ name: 'X', icon: 'map', capabilities: { provides }, install: { ports } });
  const relay = { id: 'r', name: 'relay', mode: 'compose', status: 'online', manifest: { ...man([], ['edge.routes']), name: 'Relay' } };
  const carte = { id: 'c', name: 'mapmylan', mode: 'compose', status: 'online', manifest: { ...man([{ name: 'http', container: 8090, protocol: 'http', expose: 'proxy' }]), name: 'MapMyLAN' } };
  const loin = { id: 'l', name: 'loin', mode: 'remote', status: 'online', manifest: man([{ name: 'http', container: 80, protocol: 'http', expose: 'proxy' }]) };
  const muet = { id: 'm', name: 'ollama', mode: 'compose', status: 'online', manifest: man([{ name: 'api', container: 11434, protocol: 'http', expose: 'none' }]) };
  assert.equal(portPublie(muet.manifest), null);
  let installes = [carte, loin, muet];
  const reglages = {};
  const appels = [];
  let reponse = () => ({});
  const c = new Connexions({
    services: { providersOf: cap => installes.filter(i => i.manifest.capabilities.provides?.includes(cap)), list: () => installes, get: id => installes.find(i => i.id === id || i.name === id) },
    runtime: { request: async (inst, req) => { appels.push({ inst: inst.name, ...req }); return reponse(req); } },
    audit: { write() {} },
    db: { setting: (k, d) => reglages[k] ?? d, setSetting: (k, v) => { reglages[k] = v; } },
  });
  assert.deepEqual(await c.etat(), { relay: null });
  await assert.rejects(c.publier('mapmylan'), /Relay n’est pas installé/);

  installes = [relay, carte, loin, muet];
  reponse = req => (req.path === '/api/etat' ? { routes: [{ hote: 'carte.home.arpa', proprietaire: 'hub:mapmylan', mode: 'local' }, { hote: 'stock.home.arpa', proprietaire: null }], domaines: ['home.arpa'], caddy: { ok: true }, cloudflare: false } : { url: 'https://carte.home.arpa', route: {} });
  const e = await c.etat();
  assert.equal(e.relay.nom, 'relay');
  assert.deepEqual(e.services.map(s => [s.nom, s.cible, s.routes]), [['relay', null, []], ['mapmylan', 'hub-mapmylan:8090', ['carte.home.arpa']], ['ollama', null, []]], 'les services installés ici');

  appels.length = 0;
  const out = await c.publier('mapmylan', { mode: 'local' }, 'ana');
  assert.deepEqual(appels[0], { inst: 'relay', method: 'PUT', path: '/api/hub/publication', body: { service: 'mapmylan', cible: 'hub-mapmylan:8090', mode: 'local', sousDomaine: 'mapmylan', nom: 'MapMyLAN' } });
  assert.equal(out.url, 'https://carte.home.arpa');
  assert.equal(c.publications().c, 'https://carte.home.arpa', 'retenue pour le Compose et le lien « Ouvrir »');
  await assert.rejects(c.publier('loin'), /tourne ailleurs/);
  await assert.rejects(c.publier('ollama'), /aucune interface web/);
  await assert.rejects(c.publier('relay'), /aucune interface web/, 'le Relay de cet essai n’en déclare pas');
  await assert.rejects(c.publier('mapmylan', { sousDomaine: 'Pas Bon' }), /Sous-domaine/);
  // Le domaine posé : ceux qui n'ont pas de nom en reçoivent un, les autres ne bougent pas.
  appels.length = 0;
  installes.push({ id: 'n', name: 'nexarc', mode: 'compose', status: 'online', manifest: { ...man([{ name: 'http', container: 8090, protocol: 'http', expose: 'proxy' }]), name: 'NEXARC' } });
  const tous = await c.publierTous('ana');
  assert.deepEqual(tous.erreurs, []);
  assert.deepEqual(appels.filter(a => a.method === 'PUT').map(a => a.body.service), ['nexarc'], 'mapmylan a déjà son nom, ollama n’a pas d’interface');

  // Le Hub lui-même : sous un nom à part, vers son conteneur en HTTPS quand il le sert.
  appels.length = 0;
  c.hubEnTls = true;
  await c.publierHub({ mode: 'public', hote: 'hub.exemple.fr' }, 'ana');
  assert.deepEqual(appels[0].body, { service: 'le-hub', cible: 'https://hub:8100', mode: 'public', hote: 'hub.exemple.fr', nom: 'Hub' });
  await assert.rejects(c.publierHub({ sousDomaine: 'Hub!' }), /Sous-domaine/);

  // Un refus de Relay garde son statut et son message, sans le préfixe du runtime.
  const { HttpError } = await import('../server/util/common.js');
  reponse = () => { throw Object.assign(new HttpError(502, 'relay a répondu 409 : carte.home.arpa est déjà servi par une autre route.'), { upstreamStatus: 409 }); };
  await assert.rejects(c.publier('mapmylan'), e2 => e2.status === 409 && e2.message === 'carte.home.arpa est déjà servi par une autre route.');
});

test('Connexions : domaines enregistrés en un seul endroit, n’importe lesquels ; un domaine retiré emporte les noms du Hub vers le premier', async () => {
  const { Connexions } = await import('../server/connexions.js');
  const http = { name: 'X', icon: 'map', capabilities: { provides: [] }, install: { ports: [{ name: 'http', container: 8090, protocol: 'http', expose: 'proxy' }] } };
  const relay = { id: 'r', name: 'relay', mode: 'compose', status: 'online', manifest: { ...http, name: 'Relay', capabilities: { provides: ['edge.routes'] }, install: { ports: [] } } };
  const carte = { id: 'c', name: 'mapmylan', mode: 'compose', status: 'online', manifest: { ...http, name: 'MapMyLAN' } };
  const installes = [relay, carte];
  const reglages = {}, appels = [];
  let etat = { routes: [{ hote: 'mapmylan.home.arpa', proprietaire: 'hub:mapmylan', mode: 'local' }, { hote: 'hub.home.arpa', proprietaire: 'hub:le-hub', mode: 'local' }, { hote: 'nas.home.arpa', proprietaire: null, mode: 'local' }], domaines: ['home.arpa'], ip: '192.0.2.10' };
  const c = new Connexions({
    services: { providersOf: cap => installes.filter(i => i.manifest.capabilities.provides?.includes(cap)), list: () => installes, get: id => installes.find(i => i.id === id || i.name === id) },
    runtime: { request: async (inst, req) => {
      appels.push(req);
      if (req.path === '/api/etat') return etat;
      if (req.path === '/api/hub/publication' && req.method === 'PUT') return { url: `https://${req.body.sousDomaine}.${etat.domaines[0]}`, route: {} };
      if (req.path === '/api/reglages/general') { etat = { ...etat, domaines: req.body.domaines }; return req.body; }
      if (req.path === '/api/hub/cloudflare') { etat = { ...etat, zonesCloudflare: req.method === 'PUT' ? ['exemple.fr'] : [] }; return req.method === 'PUT' ? { zones: ['exemple.fr'], enregistrements: { faits: [], erreurs: [] } } : { ok: true }; }
      return { retirees: [] };
    } },
    audit: { write() {} },
    db: { setting: (k, d) => reglages[k] ?? d, setSetting: (k, v) => { reglages[k] = v; } },
  });
  await assert.rejects(c.poserDomaines(['https://exemple.fr/x']), /un nom comme home\.arpa/);
  await assert.rejects(c.poserDomaines(['ok.fr', 'pas bon']), /pas bon : un nom comme/);
  assert.equal(appels.length, 0, 'une saisie refusée ne touche pas Relay');

  // Ajouter un domaine ne déplace rien : les noms déjà posés restent valides.
  let o = await c.poserDomaines(['home.arpa', 'Lab.Exemple.fr.', 'home.arpa'], 'ana');
  assert.deepEqual(o.domaines, ['home.arpa', 'lab.exemple.fr'], 'normalisés, sans doublon');
  assert.deepEqual(o.deplaces.faits, []);

  // Retirer home.arpa : le premier devient lab.exemple.fr, les noms du Hub suivent.
  appels.length = 0;
  o = await c.poserDomaines(['lab.exemple.fr'], 'ana');
  assert.deepEqual(etat.domaines, ['lab.exemple.fr']);
  assert.deepEqual(o.deplaces.faits, ['https://mapmylan.lab.exemple.fr', 'https://hub.lab.exemple.fr'], 'les noms du Hub suivent');
  assert.deepEqual(o.deplaces.services, ['mapmylan'], 'à redéployer : le service, pas le Hub');
  const retraits = appels.filter(a => a.method === 'DELETE').map(a => a.path);
  assert.deepEqual(retraits, ['/api/hub/publication?service=mapmylan&hote=mapmylan.home.arpa', '/api/hub/publication?service=le-hub&hote=hub.home.arpa'], 'l’ancien nom retiré, une route posée à la main jamais touchée');
  const ordre = appels.filter(a => a.path.startsWith('/api/hub/publication')).map(a => a.method);
  assert.deepEqual(ordre.slice(0, 2), ['PUT', 'DELETE'], 'le nouveau nom d’abord, l’ancien ensuite');

  appels.length = 0;
  etat = { ...etat, routes: [] };
  const vide = await c.poserDomaines([], 'ana');
  assert.deepEqual(vide.deplaces.faits, [], 'plus aucun domaine : rien à déplacer, rien à publier');
  assert.equal((await c.etat()).ip, '192.0.2.10', 'l’adresse du résolveur, pour le bloc des appareils');
  // Cloudflare : le jeton part à Relay, le Hub ne le garde nulle part.
  const audits = [];
  c.audit = { write: (...a) => audits.push(a) };
  assert.deepEqual((await c.connecterCloudflare('jeton-cloudflare-0123456789abcdef', 'ana')).zones, ['exemple.fr']);
  assert.deepEqual((await c.etat()).zonesCloudflare, ['exemple.fr']);
  assert.ok(!JSON.stringify([reglages, audits]).includes('jeton-cloudflare'), 'ni dans les réglages, ni dans le journal');
  await c.deconnecterCloudflare('ana');
  assert.deepEqual((await c.etat()).zonesCloudflare, []);
});

test('Connexions au déploiement : jamais bloquant, nom posé une fois, domaine de base exigé', async () => {
  const { Connexions } = await import('../server/connexions.js');
  const relay = { id: 'r', name: 'relay', mode: 'compose', status: 'online', manifest: { name: 'Relay', capabilities: { provides: ['edge.routes'] }, install: { ports: [] } } };
  const carte = { id: 'c', name: 'mapmylan', mode: 'compose', status: 'installing', manifest: { name: 'MapMyLAN', capabilities: {}, install: { ports: [{ name: 'http', container: 8090, protocol: 'http', expose: 'proxy' }] } } };
  const reglages = {};
  let etat = { routes: [], domaines: [] };
  let publiees = 0;
  const c = new Connexions({
    services: { providersOf: () => [relay], list: () => [relay, carte], get: id => [relay, carte].find(i => i.id === id || i.name === id) },
    runtime: { request: async (_i, req) => { if (req.path === '/api/etat') return etat; publiees++; return { url: 'https://mapmylan.home.arpa' }; } },
    audit: { write() {} },
    db: { setting: (k, d) => reglages[k] ?? d, setSetting: (k, v) => { reglages[k] = v; } },
  });
  const notes = [];
  assert.equal(await c.auDeploiement(carte, n => notes.push(n)), null);
  assert.match(notes[0], /Pas de domaine de base/);
  etat = { routes: [], domaines: ['home.arpa'] };
  assert.equal(await c.auDeploiement(carte, n => notes.push(n)), 'https://mapmylan.home.arpa');
  assert.equal(publiees, 1);
  etat = { routes: [{ hote: 'mapmylan.home.arpa', proprietaire: 'hub:mapmylan', mode: 'local' }], domaines: ['home.arpa'] };
  assert.equal(await c.auDeploiement(carte), null, 'déjà publié : rien de plus');
  assert.equal(publiees, 1);
  assert.equal(await c.auDeploiement(relay), null, 'sans interface déclarée, rien à publier');
  relay.status = 'offline';
  assert.equal(await c.auDeploiement(carte), null, 'Relay muet : le service se déploie quand même');
  relay.status = 'online';
  const cRuntimeEnPanne = new Connexions({ services: c.services, runtime: { request: async () => { throw new Error('injoignable'); } }, audit: { write() {} }, db: c.db });
  const n2 = [];
  assert.equal(await cRuntimeEnPanne.auDeploiement(carte, n => n2.push(n)), null);
  assert.match(n2[0], /Nom non posé dans Relay : injoignable/);

  reglages.relais_ip = '172.18.0.9';
  assert.equal(c.proxysPour({ SOCLE_PROXYS: '10.0.0.0/8, 172.18.0.9/32' }), '10.0.0.0/8,172.18.0.9/32');
  assert.equal(c.proxysPour({}), '172.18.0.9/32');
});

test('services derrière Relay : relais cru et adresse publique posés au Compose, jamais par-dessus un réglage', async () => {
  const { Services, openAddresses } = await import('../server/services.js');
  const s = Object.create(Services.prototype);
  s.connexions = { proxysPour: cfg => [cfg.SOCLE_PROXYS, '172.18.0.9/32'].filter(Boolean).join(',') };
  const m = { config: [{ key: 'SOCLE_PROXYS' }, { key: 'SOCLE_URL_PUBLIQUE' }] };
  assert.deepEqual(s.reglagesDuRelais(m, {}, 'https://carte.home.arpa'), { SOCLE_PROXYS: '172.18.0.9/32', SOCLE_URL_PUBLIQUE: 'https://carte.home.arpa' });
  assert.deepEqual(s.reglagesDuRelais(m, { SOCLE_URL_PUBLIQUE: 'https://autre.exemple' }, 'https://carte.home.arpa'), { SOCLE_PROXYS: '172.18.0.9/32' });
  assert.deepEqual(s.reglagesDuRelais(m, {}, 'http://carte.home.arpa'), { SOCLE_PROXYS: '172.18.0.9/32' }, 'une adresse en clair ne devient pas l’adresse des courriels');
  assert.deepEqual(s.reglagesDuRelais({ config: [] }, {}, 'https://x'), {}, 'un service hors socle ne reçoit rien');
  s.connexions = null;
  assert.deepEqual(s.reglagesDuRelais(m, {}, 'https://x'), {});
  const inst = { name: 'mapmylan', mode: 'compose', stack: 1, manifest: { install: { ports: [{ name: 'http', container: 8090, protocol: 'http', expose: 'proxy' }] } } };
  const o = openAddresses(inst, { exposition: 'port', machine: '192.0.2.10', publiee: 'https://carte.home.arpa' });
  assert.equal(o[0].url, 'https://carte.home.arpa', 'l’adresse publiée d’abord');
});

test('Relay au registre local : manifeste valide, Compose rendu sans socket Docker ni privilège, réglages du socle tous déclarés', async () => {
  const { validateManifest } = await import('../server/registry.js');
  const { composeVars, renderCompose, checkCompose } = await import('../server/services.js');
  const dir = path.join(import.meta.dirname, '../registry-local');
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.ok(index.extensions.some(e => e.id === 'relay' && e.manifest === 'relay/hub.json'));
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'relay/hub.json'), 'utf8'));
  const v = validateManifest(m);
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.deepEqual(m.capabilities.provides, ['edge.routes']);
  const tpl = fs.readFileSync(path.join(dir, 'relay', m.install.compose), 'utf8');
  const cfg = Object.fromEntries(m.config.map(f => [f.key, f.type === 'secret' ? 'secret-de-l-essai-0123456789abcdef' : (f.default ?? '')]));
  cfg.RELAY_IP = '192.0.2.10';
  const rendu = renderCompose(tpl, composeVars({ name: 'relay', stack: 3, url: 'http://hub-relay:8095' }, m, cfg));
  assert.equal(checkCompose(rendu, m), true);
  assert.match(rendu, /"192\.0\.2\.10:53:53\/udp"/);
  assert.match(rendu, /--address=\/home\.arpa\/192\.0\.2\.10/);
  assert.match(rendu, /container_name: hub-relay-caddy/, 'le nom que le Hub inspecte pour connaître l’adresse de Caddy');
  assert.doesNotMatch(rendu, /privileged:\s*true|docker\.sock|cap_add/);
});

test('réglages d’un service : obligatoires et forme contrôlés avant tout déploiement ; un port pris dit en clair', async () => {
  const { verifierReglages, erreurDemarrage } = await import('../server/services.js');
  const m = { config: [
    { key: 'RELAY_IP', label: 'Adresse IP de cette machine', type: 'string', required: true, pattern: '^(?!0\\.0\\.0\\.0$)(\\d{1,3}\\.){3}\\d{1,3}$', help: 'ex. 192.0.2.10' },
    { key: 'MODE', label: 'Mode', type: 'string' },
    { key: 'JETON', label: 'Jeton', type: 'string', required: true, showIf: { MODE: ['distant'] } },
  ] };
  assert.throws(() => verifierReglages(m, {}), /Adresse IP de cette machine : obligatoire/);
  assert.throws(() => verifierReglages(m, { RELAY_IP: '0.0.0.0' }), /format invalide — ex\. 192\.0\.2\.10/);
  assert.throws(() => verifierReglages(m, { RELAY_IP: 'ma-machine' }), /format invalide/);
  verifierReglages(m, { RELAY_IP: '192.0.2.10' });
  assert.throws(() => verifierReglages(m, { RELAY_IP: '192.0.2.10', MODE: 'distant' }), /Jeton : obligatoire/, 'un champ conditionnel visible est contrôlé');
  verifierReglages(m, { MODE: 'local' }, ['MODE']);
  assert.match(erreurDemarrage('Error response from daemon: failed to set up container networking: driver failed programming external connectivity on endpoint hub-relay-dns (4bb6): failed to bind host port 0.0.0.0:53/tcp: address already in use'), /^Le port 53 de la machine est déjà pris .*résolveur DNS/);
  assert.match(erreurDemarrage('failed to bind host port 192.0.2.10:443/tcp: address already in use'), /port 443 sur 192\.0\.2\.10/);
  assert.equal(erreurDemarrage('image introuvable'), null);
});

test('l’adresse IP de la machine se remplit seule : Réglages, puis l’adresse par laquelle on ouvre le Hub', async () => {
  const { Services } = await import('../server/services.js');
  const reglages = {};
  const soi = { db: { setting: (k, d) => reglages[k] ?? d } };
  soi.ipMachine = Services.prototype.ipMachine.bind(soi);
  assert.equal(soi.ipMachine(), '', 'rien de connu : rien d’inventé');
  reglages.hub_ui = 'https://127.0.0.1:8100';
  assert.equal(soi.ipMachine(), '', 'jamais la boucle locale');
  reglages.hub_ui = 'https://192.0.2.10:8100';
  assert.equal(soi.ipMachine(), '192.0.2.10');
  reglages.adresse_machine = '192.0.2.20';
  assert.equal(soi.ipMachine(), '192.0.2.20', 'Réglages l’emporte');
  reglages.adresse_machine = 'nas.local';
  assert.equal(soi.ipMachine(), '192.0.2.10', 'un nom n’est pas une IP');

  const m = { name: 'Relay', config: [
    { key: 'RELAY_IP', label: 'Adresse IP', type: 'string', default: '{{hub.ip}}', pattern: '^(?!0\\.0\\.0\\.0$)(\\d{1,3}\\.){3}\\d{1,3}$' },
    { key: 'AUTRE', label: 'Autre', type: 'string', default: 'x' },
  ] };
  const remplir = Services.prototype.reglagesDeLaMachine.bind(soi);
  assert.deepEqual(remplir(m, {}), { RELAY_IP: '192.0.2.10' });
  assert.deepEqual(remplir(m, { RELAY_IP: '192.0.2.99' }), {}, 'une valeur posée à la main reste');
  delete reglages.hub_ui; reglages.adresse_machine = '';
  assert.throws(() => remplir(m, {}), /Relay a besoin de l’adresse IP de cette machine .*Réglages → Adresse de la machine/);
});

test('construction depuis les sources : archive GitHub réempaquetée, images de son seul dépôt, tag de la version', async () => {
  const zlib = (await import('node:zlib')).default;
  const C = await import('../server/construction.js');
  const long = 'src/' + 'tres-long-nom-de-dossier/'.repeat(6) + 'fichier-é.js';
  const tete = 'codexX64-vigie-1a2b3c/';
  const tgz = zlib.gzipSync(C.ecrireTar([
    { nom: tete, type: 'dossier' },
    { nom: tete + 'Dockerfile', type: 'fichier', donnees: Buffer.from('FROM scratch\n'), mode: 0o644 },
    { nom: tete + 'outils/lancer.sh', type: 'fichier', donnees: Buffer.from('#!/bin/sh\n'), mode: 0o755 },
    { nom: tete + long, type: 'fichier', donnees: Buffer.from('x'.repeat(1300)) },
    { nom: tete + 'lien', type: 'lien', lien: 'outils/lancer.sh' },
    { nom: tete + 'fuite', type: 'lien', lien: '../../etc/passwd' },
  ]));
  const entrees = [...C.lireTar(C.reempaqueter(tgz))];
  assert.deepEqual(entrees.map(e => e.nom), ['Dockerfile', 'outils/lancer.sh', long, 'lien'], 'tête retirée, lien qui sort écarté');
  assert.equal(entrees[1].mode, 0o755, 'droits gardés');
  assert.equal(entrees[2].donnees.length, 1300);
  assert.equal(entrees[3].lien, 'outils/lancer.sh');
  assert.throws(() => C.reempaqueter(zlib.gzipSync(C.ecrireTar([{ nom: tete + 'a/../../x', type: 'fichier', donnees: Buffer.from('') }]))), /chemin refusé/);
  assert.throws(() => C.reempaqueter(zlib.gzipSync(C.ecrireTar([{ nom: tete + 'README.md', type: 'fichier', donnees: Buffer.from('') }]))), /Dockerfile/);

  const depot = C.depotGithub({}, { type: 'github', repo: 'codexX64/relay', ref: 'main' });
  assert.deepEqual(C.cibleDeConstruction('ghcr.io/codexx64/relay:2.1.2', depot), { cible: null });
  assert.deepEqual(C.cibleDeConstruction('ghcr.io/codexx64/relay-caddy:2.1.2', depot), { cible: 'caddy' });
  assert.equal(C.cibleDeConstruction('ghcr.io/autre/relay:2.1.2', depot), null, 'l’image d’un autre compte');
  assert.equal(C.cibleDeConstruction('postgres:16', depot), null);
  assert.equal(C.cibleDeConstruction('ghcr.io/codexx64/relayeur:1.0.0', depot), null);
  assert.deepEqual(C.depotGithub({ repository: 'https://github.com/CodexX64/vigie' }, { type: 'local' }), { owner: 'CodexX64', repo: 'vigie', branche: 'main' });
  assert.equal(C.depotGithub({ repository: 'https://gitlab.com/a/b' }, null), null);
  assert.deepEqual(C.referencesPour('1.0.0', depot, '1.0.0'), ['refs/tags/v1.0.0', 'refs/heads/main']);
  assert.deepEqual(C.referencesPour('1.0.0', depot, '1.1.0'), ['refs/tags/v1.0.0'], 'la branche porte une autre version');
  assert.deepEqual(C.referencesPour('latest', depot, '1.0.0'), []);
});

test('déploiement : une image que le registre refuse est construite depuis le dépôt de l’extension', async () => {
  const zlib = (await import('node:zlib')).default;
  const { Services } = await import('../server/services.js');
  const { docker } = await import('../server/docker.js');
  const C = await import('../server/construction.js');
  const garde = { ...docker };
  const construites = [], demandes = [], etapes = [];
  const locales = {};
  Object.assign(docker, {
    available: async () => true, ensureNetwork: async () => {}, up: async () => {}, imagesEnService: async () => new Map(),
    imageId: async r => locales[r] || null, imageExists: async r => !!locales[r],
    pullImage: async () => { throw new Error('Error response from daemon: error from registry: denied'); },
    construire: async (ref, ctx, cible) => { construites.push({ ref, cible, fichiers: [...C.lireTar(ctx)].map(e => e.nom) }); locales[ref] = 'sha256:' + ref; },
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-construire-'));
  try {
    const s = Object.create(Services.prototype);
    Object.assign(s, {
      db: { setting: (k, d) => d }, vault: { open: v => v }, audit: { write() {} },
      registry: { composeFile: async e => e.tpl }, runtime: { context: i => ({ config: i.config }) },
      expositionDe: () => 'loopback', fournisseurPour: () => null, stackFile: i => path.join(dir, i.name, 'compose.yml'),
      progress: (_i, t, e = 'ok') => etapes.push({ t, e }), addRoute: async () => {},
      archiveGithub: async (d, r) => { demandes.push(`${d.owner}/${d.repo}@${r}`); return r === 'refs/tags/v2.1.2' ? zlib.gzipSync(C.ecrireTar([{ nom: 'r-x/Dockerfile', type: 'fichier', donnees: Buffer.from('FROM scratch\n') }])) : null; },
    });
    const m = { id: 'relay', version: '2.1.2', repository: 'https://github.com/CodexX64/relay', config: [{ key: 'IMAGE_TAG', type: 'string' }], install: { type: 'compose', ports: [] } };
    const inst = { id: 'r', name: 'relay', mode: 'compose', config: { IMAGE_TAG: '2.1.2' }, manifest: m };
    const tpl = 'services:\n  a:\n    image: ghcr.io/codexx64/relay:{{config.IMAGE_TAG}}\n  b:\n    image: ghcr.io/codexx64/relay-caddy:{{config.IMAGE_TAG}}\n  c:\n    image: postgres:16\n';
    await assert.rejects(() => s.deploy(inst, { tpl, manifest: m, origin: { type: 'local' } }), /postgres:16.*pas de dépôt GitHub/);
    assert.deepEqual(construites.map(x => [x.ref, x.cible]), [['ghcr.io/codexx64/relay:2.1.2', null], ['ghcr.io/codexx64/relay-caddy:2.1.2', 'caddy']]);
    assert.deepEqual(construites[0].fichiers, ['Dockerfile']);
    assert.deepEqual(demandes, ['CodexX64/relay@refs/tags/v2.1.2'], 'une archive pour toutes les images du dépôt');
    assert.ok(etapes.some(x => x.t === 'Image construite ici : ghcr.io/codexx64/relay-caddy:2.1.2'));
  } finally { Object.assign(docker, garde); fs.rmSync(dir, { recursive: true, force: true }); }
});

/* ---------- l'IA d'un service, lue à la forme de ses réglages ---------- */
const VIGIE_IA = {
  id: 'vigie', name: 'VIGIE', version: '1.0.2',
  capabilities: { provides: ['security.audit'], accepts: ['llm.chat'] },
  config: [
    { key: 'VIGIE_IA_MODE', type: 'select', default: 'aucune', options: [
      { value: 'aucune', label: 'Aucune — le moteur de règles seul' }, { value: 'locale', label: 'Locale — l’Ollama du Hub' },
      { value: 'cloud', label: 'En nuage — Claude, GPT ou Kimi' }, { value: 'les-deux', label: 'Les deux — la locale relit, le nuage tranche' },
      { value: 'secours', label: 'Secours — la locale, le nuage si elle échoue' }] },
    { key: 'VIGIE_IA_MODELE_LOCAL', type: 'select', default: '', showIf: { VIGIE_IA_MODE: ['locale', 'les-deux', 'secours'] },
      optionsFrom: { from: { capability: 'llm.chat' }, method: 'GET', path: '/api/tags', select: '$.models', map: { value: '$.name' }, exclude: ['embed'] } },
    { key: 'VIGIE_IA_FOURNISSEUR', type: 'select', default: 'anthropic', options: [{ value: 'anthropic', label: 'Anthropic (Claude)' }, { value: 'kimi', label: 'Moonshot (Kimi)' }], showIf: { VIGIE_IA_MODE: ['cloud', 'les-deux', 'secours'] } },
    { key: 'VIGIE_IA_MODELE', type: 'string', default: '', showIf: { VIGIE_IA_MODE: ['cloud', 'les-deux', 'secours'] } },
  ],
  triggers: [], actions: [], probes: [],
};

test('IA d’un service : mode, modèle local et nuage reconnus à leur forme, jamais à leur nom', async () => {
  const { champsIA, etatIA, modeleCite } = await import('../server/choix-ia.js');
  const ch = champsIA(VIGIE_IA);
  assert.equal(ch.mode.key, 'VIGIE_IA_MODE');
  assert.equal(ch.modele.key, 'VIGIE_IA_MODELE_LOCAL');
  assert.equal(ch.nuage.key, 'VIGIE_IA_FOURNISSEUR');
  assert.equal(ch.modeleNuage.key, 'VIGIE_IA_MODELE');
  // L'ancienne VIGIE : pas de modèle local à choisir, et le modèle en nuage n'est jamais pris pour lui.
  const ancienne = { ...VIGIE_IA, config: VIGIE_IA.config.filter(f => f.key !== 'VIGIE_IA_MODELE_LOCAL') };
  assert.equal(champsIA(ancienne).modele, null);
  // SYNAPSE : le fournisseur sert de mode, son modèle libre vaut pour les deux.
  const syn = { config: [{ key: 'LLM_FOURNISSEUR', type: 'select', options: ['ollama', 'kimi', 'openai'] }, { key: 'LLM_MODELE', type: 'string' }] };
  assert.equal(champsIA(syn).modele.key, 'LLM_MODELE');
  // MapMyLAN : un modèle tiré d'Ollama, sans mode.
  assert.equal(champsIA({ config: [{ key: 'IA_MODELE', type: 'select', optionsFrom: { from: { capability: 'llm.chat' } } }] }).mode, null);
  assert.equal(champsIA({ config: [{ key: 'PORT', type: 'integer' }] }), null);

  const ollama = { id: 'o', name: 'ollama-gpu-pc', config: { DEFAULT_MODEL: 'qwen3:14b' } };
  const v = (config) => ({ id: 'v', name: 'vigie', manifest: VIGIE_IA, config });
  assert.equal(etatIA(v({ VIGIE_IA_MODE: 'aucune' }), ollama).local, false);
  let e = etatIA(v({ VIGIE_IA_MODE: 'locale', VIGIE_IA_MODELE_LOCAL: 'qwen3.8:9b' }), ollama);
  assert.deepEqual([e.local, e.modele, e.nuage, e.modeLibelle], [true, 'qwen3.8:9b', false, 'Locale']);
  e = etatIA(v({ VIGIE_IA_MODE: 'les-deux', VIGIE_IA_FOURNISSEUR: 'kimi', VIGIE_IA_MODELE: 'kimi-k2' }), ollama);
  assert.deepEqual([e.local, e.modele, e.modeleParDefaut, e.nuage, e.nuageNom, e.modeleNuage], [true, null, 'qwen3:14b', true, 'Moonshot (Kimi)', 'kimi-k2']);
  assert.equal(etatIA(v({ VIGIE_IA_MODE: 'locale' }), null).localSansFournisseur, true);

  const modeles = ['qwen3.8:9b', 'qwen3:14b', 'llama3.2:latest'];
  assert.deepEqual(modeleCite('je veux connecter à mon ia local qwen 3.8:9b', modeles), { trouve: 'qwen3.8:9b' });
  assert.deepEqual(modeleCite('passe-le sur Qwen3:14B', modeles), { trouve: 'qwen3:14b' });
  assert.deepEqual(modeleCite('mets llama3.2', modeles), { trouve: 'llama3.2:latest' });
  assert.deepEqual(modeleCite('mets mistral:7b', modeles), { cite: 'mistral:7b' });
  assert.deepEqual(modeleCite('connecte vigie à l’IA locale', modeles), {});
});

/* Un faux Hub pour l'assistant : services, Ollama qui répond, workflows. */
function hubIA({ config = { VIGIE_IA_MODE: 'aucune' }, manifest = VIGIE_IA, modeles = ['qwen3.8:9b', 'qwen3:14b', 'nomic-embed-text:latest'] } = {}) {
  const ollama = { id: 'o', name: 'ollama-gpu-pc', ext_id: 'ollama', mode: 'remote', status: 'online', config: { DEFAULT_MODEL: 'qwen3:14b' }, providers: {}, manifest: { id: 'ollama', name: 'Ollama', capabilities: { provides: ['llm.chat', 'llm.embed'] } } };
  const vigie = { id: 'v', name: 'vigie', ext_id: 'vigie', version: manifest.version, mode: 'compose', status: 'online', config: { ...config }, providers: { 'llm.chat': 'o' }, manifest };
  const journal = { config: [], redeploy: [], providers: [] };
  const services = {
    list: () => [ollama, vigie],
    get: n => { const i = [ollama, vigie].find(x => x.id === n || x.name === n); if (!i) throw new Error('introuvable'); return i; },
    updateConfig: (n, patch) => { journal.config.push(patch); Object.assign(vigie.config, patch); },
    redeploy: async n => { journal.redeploy.push(n); },
    update: async () => { vigie.manifest = VIGIE_IA; vigie.version = VIGIE_IA.version; },
  };
  const runtime = { options: async (inst, f, fourn) => { assert.equal(fourn?.id, 'o'); return modeles.filter(m => !(f.optionsFrom.exclude || []).some(x => m.includes(x))).map(value => ({ value, label: value })); } };
  return { ollama, vigie, journal, services, runtime };
}

test('assistant : « connecte vigie à mon ia local qwen 3.8:9b » vérifie le modèle chez Ollama et propose de brancher, sans modèle de langage', async () => {
  const { Agent } = await import('../server/ai/agent.js');
  const h = hubIA();
  const a = Object.create(Agent.prototype);
  Object.assign(a, { services: h.services, runtime: h.runtime, store: { list: () => [] }, registry: { get: () => ({ manifest: VIGIE_IA }) }, db: { run: (sql, prov) => h.journal.providers.push(prov) }, audit: { write() {} } });
  const texte = 'Connecte vigie a l’ia local. Je veux connecter à mon ia local qwen 3.8:9b, vérifie qu’il y a un modèle qui se nomme comme ça et si oui connecte';
  const d = a.demandeDirecte(texte);
  assert.deepEqual(d, { ia: { instance: 'vigie' } });
  const r = await a.reponseIA('vigie', texte);
  assert.match(r.reply, /\*\*qwen3\.8:9b\*\* est bien installé sur \*\*ollama-gpu-pc\*\*/);
  assert.deepEqual(r.steps[0], { tool: 'connecter_ia', args: { instance: 'vigie', fournisseur: 'ollama-gpu-pc', modele: 'qwen3.8:9b', mode: 'locale', modeLibelle: 'Locale', relance: true } });
  // Un modèle qui n'existe pas : la liste, et rien d'autre.
  const faux = await a.reponseIA('vigie', 'branche vigie sur mistral:7b');
  assert.match(faux.reponse, /pas de modèle « mistral:7b » sur \*\*ollama-gpu-pc\*\*[\s\S]*- qwen3\.8:9b/);
  assert.doesNotMatch(faux.reponse, /nomic-embed/, 'un modèle d’embeddings ne répond pas aux questions');
  // Exécution : réglages posés, service relancé.
  const s = await a.review(r.steps[0], {});
  assert.deepEqual(s.problems, []);
  a.capabilities = null;
  const out = await a.run(s, 'admin', new Map());
  assert.deepEqual(h.journal.config, [{ VIGIE_IA_MODE: 'locale', VIGIE_IA_MODELE_LOCAL: 'qwen3.8:9b' }]);
  assert.deepEqual(h.journal.redeploy, ['v']);
  assert.match(out.note, /vigie se sert de qwen3\.8:9b sur ollama-gpu-pc, relancé/);
  // Déjà fait : on le dit, sans étape.
  assert.match((await a.reponseIA('vigie', texte)).reponse, /C’est déjà fait : \*\*vigie\*\* se sert de \*\*qwen3\.8:9b\*\*/);
  // « Les deux » fait déjà travailler la locale : le mode est gardé, seul le modèle change.
  h.vigie.config.VIGIE_IA_MODE = 'les-deux';
  assert.equal((await a.reponseIA('vigie', 'passe vigie sur qwen3:14b')).steps[0].args.mode, 'les-deux');
  // Le nuage n'est pas une demande directe : il demande une clé et fait sortir des données.
  assert.equal(a.demandeDirecte('connecte vigie à claude en cloud'), null);
  // Deux services nommés sans IA à choisir : ce n'est pas pour l'IA.
  assert.equal(a.intentionIA('connecte vigie'), null);
});

test('assistant : une VIGIE trop ancienne pour choisir son modèle est mise à jour d’abord ; sans Ollama, on dit quoi installer', async () => {
  const { Agent } = await import('../server/ai/agent.js');
  const ancienne = { ...VIGIE_IA, version: '1.0.1', config: VIGIE_IA.config.filter(f => f.key !== 'VIGIE_IA_MODELE_LOCAL') };
  const h = hubIA({ manifest: ancienne });
  const a = Object.create(Agent.prototype);
  Object.assign(a, { services: h.services, runtime: h.runtime, store: { list: () => [] }, registry: { get: () => ({ manifest: VIGIE_IA }) }, db: { run() {} }, audit: { write() {} } });
  const r = await a.reponseIA('vigie', 'connecte vigie à l’ia locale qwen3.8:9b');
  assert.equal(r.steps[0].args.majDabord, '1.0.2');
  assert.match(r.reply, /je le mets d’abord à jour en 1\.0\.2/);
  const s = await a.review(r.steps[0], {});
  await a.run(s, 'admin', new Map());
  assert.equal(h.vigie.version, '1.0.2');
  assert.deepEqual(h.journal.config.at(-1), { VIGIE_IA_MODE: 'locale', VIGIE_IA_MODELE_LOCAL: 'qwen3.8:9b' });

  const seul = hubIA();
  const b = Object.create(Agent.prototype);
  Object.assign(b, { services: { ...seul.services, list: () => [seul.vigie] }, runtime: seul.runtime, store: { list: () => [] }, registry: null });
  assert.match((await b.reponseIA('vigie', 'connecte vigie à l’ia locale')).reponse, /il faut un \*\*Ollama\*\*/);
});

test('assistant : une question sur l’IA d’un service n’est pas un ordre de la brancher', async () => {
  const { Agent } = await import('../server/ai/agent.js');
  const h = hubIA();
  const a = Object.create(Agent.prototype);
  Object.assign(a, { services: h.services, registry: null });
  assert.equal(a.intentionIA('quel modèle utilise vigie en ce moment'), null);
  assert.equal(a.intentionIA('vigie utilise quelle IA ?'), null);
  assert.deepEqual(a.intentionIA('tu peux connecter vigie à l’ia locale ?'), { ia: { instance: 'vigie' } });
  assert.deepEqual(a.intentionIA('branche vigie sur qwen3:14b'), { ia: { instance: 'vigie' } });
});

test('assistant : ce qui part chez le modèle n’a ni identifiant ni secret', async () => {
  const { masquer } = await import('../server/acces-hub.js');
  assert.deepEqual(masquer({ relais: { hote: 'smtp.example.org', utilisateur: 'moi', motdepasse: 'x', port: 587 }, apiKey: 'sk-1', jeton: '', liste: [{ token: 't', nom: 'a' }], cle: true }),
    { relais: { hote: 'smtp.example.org', utilisateur: '•••', motdepasse: '•••', port: 587 }, apiKey: '•••', jeton: '', liste: [{ token: '•••', nom: 'a' }], cle: true });
});

test('assistant : « mets tout en ligne » — tunnel Cloudflare, noms et Hub, en une étape validée sous renfort ; le jeton Cloudflare reste à l’humain', async () => {
  const { Agent } = await import('../server/ai/agent.js');
  const relay = { id: 'r', name: 'relay', mode: 'compose', version: '2.2.0', config: { TUNNEL_ACTIF: '0' }, manifest: { capabilities: { provides: ['edge.routes'] } } };
  const appels = [];
  let cloudflare = false;
  const connexions = {
    relay: () => relay, exiger: () => relay, avecConnecteur: () => true,
    etat: async () => ({ cloudflare, domaines: ['example.org'], hub: { routes: ['hub.example.org'] }, services: [{ nom: 'vigie', routes: ['vigie.example.org'] }], routes: [] }),
    tunnel: async () => ({ tunnels: [] }),
    activerTunnel: async b => { appels.push(['tunnel', b]); relay.config.TUNNEL_ACTIF = '1'; return { tunnel: { id: 't1', nom: b.nom } }; },
    toutParLeTunnel: async () => { appels.push(['tout']); return { faits: ['vigie.example.org'], erreurs: [] }; },
    publierHub: async b => { appels.push(['hub', b]); return { url: 'https://hub.example.org' }; },
  };
  const a = Object.create(Agent.prototype);
  Object.assign(a, { connexions, services: { list: () => [relay], get: () => relay, versionDisponible: () => null, filesRedeploiement: new Map() }, audit: { write() {} } });
  assert.deepEqual(a.demandeDirecte('je veux que tout soit exposé partout sur internet'), { exposer: true });
  assert.deepEqual(a.demandeDirecte('mets le hub en ligne'), { exposer: true });
  assert.equal(a.demandeDirecte('c’est exposé sur internet ?')?.exposer, undefined, 'une question n’est pas un ordre');
  // Sans Cloudflare connecté : le jeton est un secret, l'humain le colle.
  assert.match((await a.reponseExposer('mets tout en ligne')).reponse, /Connexions → Cloudflare/);
  cloudflare = true;
  const r = await a.reponseExposer('mets tout en ligne');
  assert.deepEqual(r.steps, [{ tool: 'exposer', args: { relay: 'relay', nomTunnel: 'hub-example-org', majRelay: null, hub: true, hoteHub: 'hub.example.org' } }]);
  assert.equal((await a.reponseExposer('mets tout en ligne sauf le hub')).steps[0].args.hub, false);
  // Exécution : jamais sans renfort ; avec, tunnel créé, noms passés, Hub publié par le tunnel.
  const s = await a.review(r.steps[0], {});
  assert.equal(s.renfort, true);
  await assert.rejects(a.run(s, 'admin', new Map()), /confirmer ton identité/);
  const out = await a.run(s, 'admin', new Map(), { renfort: true });
  assert.deepEqual(appels, [['tunnel', { nom: 'hub-example-org' }], ['tout'], ['hub', { hote: 'hub.example.org', mode: 'cloudflare' }]]);
  assert.match(out.note, /tunnel « hub-example-org » créé.*1 nom passé par le tunnel.*Hub en ligne : https:\/\/hub\.example\.org/);
});

test('options : un fournisseur injoignable le dit, au lieu d’une liste vide qui laisse passer le défaut pour vérifié', async () => {
  const { Runtime } = await import('../server/runtime.js');
  const eteint = { id: 'i0', name: 'ollama-gpu-pc', status: 'offline', manifest: { capabilities: { provides: ['llm.chat'] } } };
  const rt = new Runtime({ services: { list: () => [eteint] } });
  rt.request = async () => { throw new Error('ne doit pas être appelé'); };
  await assert.rejects(rt.options(null, { key: 'M', type: 'select', optionsFrom: { from: { capability: 'llm.chat' }, method: 'GET', path: '/api/tags', select: '$.models' } }), /ollama-gpu-pc est injoignable/);
});

test('Connexions : un service dont le premier compte se crée sans lien d’installation ne sort jamais sur Internet', async () => {
  const { Connexions, premierCompteProtege } = await import('../server/connexions.js');
  const port = [{ name: 'http', container: 8112, protocol: 'http', expose: 'proxy' }];
  const relay = { id: 'r', name: 'relay', mode: 'compose', status: 'online', manifest: { name: 'Relay', capabilities: { provides: ['edge.routes'] }, install: { ports: [] } } };
  const ouvert = { id: 'o', name: 'oracle', version: '1.2.0', mode: 'compose', status: 'online', manifest: { name: 'Oracle AI', capabilities: {}, install: { ports: port }, config: [] } };
  const socle = { id: 'v', name: 'vigie', version: '1.0.2', mode: 'compose', status: 'online', manifest: { name: 'VIGIE', capabilities: {}, install: { ports: port }, config: [{ key: 'SOCLE_JETON_INSTALLATION', type: 'secret' }] } };
  assert.equal(premierCompteProtege(ouvert.manifest), false);
  assert.equal(premierCompteProtege(socle.manifest), true);
  assert.equal(premierCompteProtege({ accounts: { tokenKey: 'X' } }), true);
  const installes = [relay, ouvert, socle];
  const appels = [];
  const routes = [{ hote: 'oracle.example.org', proprietaire: 'hub:oracle', mode: 'local', cf: true }, { hote: 'vigie.example.org', proprietaire: 'hub:vigie', mode: 'local' }];
  const c = new Connexions({
    services: { list: () => installes, get: id => installes.find(i => i.id === id || i.name === id), providersOf: cap => installes.filter(i => i.manifest.capabilities.provides?.includes(cap)) },
    runtime: { request: async (inst, req) => { appels.push(req); return req.path === '/api/etat' ? { routes } : { url: `https://${req.body?.hote}` }; } },
    audit: { write() {} }, db: { setting: (k, d) => d, setSetting() {} },
  });
  await assert.rejects(c.publier('oracle', { mode: 'cloudflare' }), /premier compte administrateur sans lien ni jeton/);
  await assert.rejects(c.publier('oracle', { mode: 'public' }), /premier venu/);
  await c.publier('oracle', { mode: 'local' });       // en local, rien ne change
  // Déjà sur Internet : remis en local, au démarrage comme après « tout par le tunnel ».
  appels.length = 0;
  assert.deepEqual(await c.rappelerNonProteges('hub'), ['oracle.example.org']);
  assert.deepEqual(appels.filter(a => a.method === 'PUT').map(a => [a.body.service, a.body.mode, a.body.hote]), [['oracle', 'local', 'oracle.example.org']]);
  routes[0].cf = false;
  appels.length = 0;
  const tout = await c.toutParLeTunnel('hub');
  assert.deepEqual(tout.faits, ['vigie.example.org']);
  assert.match(tout.erreurs[0].erreur, /Oracle AI reste en local/);
  assert.equal((await c.etat()).services.find(s => s.nom === 'oracle').internet, false);
});

test('mesures : débits par écart entre deux relevés, regroupés par extension ; un compteur remis à zéro ne compte pas', async () => {
  const { openDb } = await import('../server/db/index.js');
  const { Mesures, lireHote, HUB, AUTRES, TRANCHE } = await import('../server/mesures.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesures-'));
  const db = openDb(path.join(dir, 'h.db'));
  // Fichier de hub-mesure : deux cartes physiques, processeur et mémoire.
  const hote = (t, rx, tx, occupe, repos) => fs.writeFileSync(path.join(dir, 'hote'), `t ${t / 1000}\ncpu  ${occupe} 0 0 ${repos} 0 0 0 0 0 0\nMemTotal:       8000000 kB\nMemAvailable:   2000000 kB\nif eth0 ${rx} ${tx}\nif eth1 0 0\n`);
  assert.deepEqual(lireHote('t 10\ncpu  1 2 3 4 5 6 7 8\nMemTotal: 4 kB\nMemAvailable: 1 kB\nif eth0 100 50\nif eth1 1 2\n'), { t: 10000, cpu: { total: 36, repos: 9 }, memTotal: 4096, memDispo: 1024, rx: 101, tx: 52, cartes: 2 });
  let t = Math.floor(Date.now() / TRANCHE) * TRANCHE + 10e3;
  const compteurs = { a: { rx: 1000, tx: 500, cpu: 0 }, h: { rx: 0, tx: 0, cpu: 0 }, x: { rx: 0, tx: 0, cpu: 0 } };
  const docker = async chemin => {
    if (chemin === '/info') return { NCPU: 4 };
    if (chemin === '/containers/json') return [
      { Id: 'a', Labels: { 'com.docker.compose.project': 'hub-vigie' } },
      { Id: 'h', Labels: { 'com.docker.compose.project': 'hub' } },
      { Id: 'x', Labels: { 'com.docker.compose.project': 'perso' } },
      { Id: 'parti', Labels: {} },
    ];
    const id = /\/containers\/(\w+)\/stats/.exec(chemin)[1];
    if (id === 'parti') throw new Error('404');
    const c = compteurs[id];
    return { cpu_stats: { cpu_usage: { total_usage: c.cpu } }, memory_stats: { usage: 300e6, stats: { inactive_file: 100e6 } }, networks: { eth0: { rx_bytes: c.rx, tx_bytes: c.tx } } };
  };
  const services = { list: () => [{ name: 'vigie', status: 'online' }, { name: 'synapse', status: 'error' }, { name: 'neuf', status: 'installing' }] };
  const m = new Mesures({ db, services, dossier: dir, docker, maintenant: () => t });
  hote(t, 1e6, 2e6, 100, 900);
  const r1 = await m.releve();
  assert.equal(r1.groupes.size, 0, 'premier relevé : rien à comparer');
  assert.deepEqual([r1.svcTotal, r1.svcOk], [2, 1], 'un service en cours d’installation ne compte pas');
  // Une minute plus tard : vigie a reçu 6 Mo et émis 3 Mo, utilisé 30 s de processeur.
  t += 60e3;
  Object.assign(compteurs.a, { rx: 1000 + 6e6, tx: 500 + 3e6, cpu: 30e9 });
  Object.assign(compteurs.x, { rx: 60e3 });
  compteurs.h.rx = 0;
  hote(t, 1e6 + 60e6, 2e6 + 6e6, 100 + 250, 900 + 750);
  const r2 = await m.releve();
  assert.deepEqual(r2.groupes.get('vigie'), { rx: 100e3, tx: 50e3, cpu: 12.5, mem: 200e6 }, 'octets par seconde ; processeur rapporté aux quatre cœurs ; mémoire sans le cache');
  assert.equal(r2.groupes.get(AUTRES).rx, 1000, 'un conteneur étranger au Hub tombe dans « Autres conteneurs »');
  assert.ok(r2.groupes.has(HUB));
  assert.deepEqual(r2.hote, { rx: 1e6, tx: 100e3, cpu: 25 });
  assert.equal(r2.hoteMem.pct, 75);
  // Le conteneur de vigie redémarre : ses compteurs repartent de zéro, pas de débit négatif.
  t += 60e3;
  Object.assign(compteurs.a, { rx: 10, tx: 10, cpu: 1e9 });
  hote(t, 1e6 + 60e6, 2e6 + 6e6, 350, 1650);
  const r3 = await m.releve();
  assert.deepEqual([r3.groupes.get('vigie').rx, r3.groupes.get('vigie').tx, r3.groupes.get('vigie').cpu], [0, 0, 0]);
  // Un fichier de la machine figé depuis plus de deux minutes n'est plus lu.
  t += 180e3;
  const r4 = await m.releve();
  assert.equal(r4.hote, undefined);
  assert.equal(m.sources.hote, false);
  // La tranche suivante écrit la précédente : moyennes de ses relevés.
  t += TRANCHE;
  await m.releve();
  const lignes = db.all('SELECT * FROM mesures ORDER BY t');
  assert.equal(lignes.length, 2);
  assert.equal(lignes[0].ext_rx, (100e3 + 0) / 2, 'deux relevés avec débit dans la première tranche');
  assert.equal(lignes[0].hote_rx, (1e6 + 0) / 2);
  assert.equal(lignes[0].svc_total, 2);
  const vue = m.vue('24h', { admin: true });
  assert.equal(vue.periode, '24h');
  assert.ok(vue.trafic.hote && vue.trafic.extensions && vue.trafic.conteneurs);
  assert.deepEqual(vue.top.map(g => g.nom).slice(0, 1), ['vigie'], 'le plus gros volume en tête');
  assert.ok(vue.top.some(g => g.hub));
  assert.ok(!m.vue('24h', { admin: false }).top.some(g => g.hub), 'le détail du Hub lui-même : administrateurs seulement');
  assert.equal(m.vue('1an').periode, '24h', 'une période inconnue retombe sur 24 h');
  assert.equal(vue.disponibilite.heures.length, 168);
  assert.equal(vue.disponibilite.pct, 50, 'un service sur deux en ligne');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mesures : sans Docker ni hub-mesure, la vue est vide et le dit', async () => {
  const { openDb } = await import('../server/db/index.js');
  const { Mesures } = await import('../server/mesures.js');
  const db = openDb(':memory:');
  const m = new Mesures({ db, services: { list: () => [] }, dossier: '', docker: async () => { throw new Error('ECONNREFUSED'); } });
  await m.releve(); await m.releve();
  const v = m.vue('7j');
  assert.deepEqual(v.sources, { docker: false, hote: false, ncpu: null, memoire: null });
  assert.deepEqual(v.trafic, { hote: null, extensions: null, conteneurs: null });
  assert.equal(v.disponibilite.pct, null);
  db.close();
});

test('mesures : purgées après trente et un jours', async () => {
  const { openDb } = await import('../server/db/index.js');
  const { Audit } = await import('../server/audit.js');
  const { purgerDonnees } = await import('../server/retention.js');
  const db = openDb(':memory:');
  const maintenant = Date.now();
  db.run('INSERT INTO mesures (t, svc_total, svc_ok) VALUES (?, 1, 1), (?, 1, 1)', maintenant - 32 * 864e5, maintenant - 864e5);
  db.run("INSERT INTO mesures_groupes (t, groupe, rx, tx, cpu, mem) VALUES (?, 'a', 0, 0, 0, 0), (?, 'a', 0, 0, 0, 0)", maintenant - 32 * 864e5, maintenant - 864e5);
  assert.equal(purgerDonnees(db, new Audit(db, null, { sortie: () => {} }), maintenant).mesures, 2);
  assert.equal(db.get('SELECT COUNT(*) n FROM mesures').n + db.get('SELECT COUNT(*) n FROM mesures_groupes').n, 2);
});

test('à traiter : services injoignables, sondes en alerte, validations, échecs du jour, mises à jour — le critique d’abord', async () => {
  const { openDb } = await import('../server/db/index.js');
  const { aTraiter } = await import('../server/a-traiter.js');
  const db = openDb(':memory:');
  const t = Date.now();
  db.run("INSERT INTO workflows (id, name, graph, enabled, version, created, updated) VALUES ('w1', 'Sauvegarde nocturne', '{}', 1, 1, ?, ?)", t, t);
  db.run("INSERT INTO executions (id, workflow_id, version, status, started) VALUES ('e1','w1',1,'error',?), ('e2','w1',1,'error',?), ('e3','w1',1,'error',?), ('e4','w1',1,'success',?)", t - 3600e3, t - 60e3, t - 2 * 864e5, t);
  const inst = [{ name: 'vigie', status: 'online' }, { name: 'proxlab', status: 'error', status_detail: 'délai dépassé' }, { name: 'vox', status: 'online' }];
  const services = { list: () => inst, publicView: i => ({ name: i.name, version: '1.0.0', miseAJour: i.name === 'vox' ? '1.1.0' : null, imageNeuve: false }) };
  const probes = { overview: () => [{ instance: 'proxlab', name: 'Alertes à traiter', unit: 'alertes', series: [{ labels: {}, value: 2, level: 'warn', ts: t - 120e3 }, { labels: { noeud: 'a' }, value: 0, level: 'ok', ts: t }] }] };
  const engine = { pendingApprovals: () => [{ workflow: 'Purge', message: 'Supprimer 3 conteneurs ?', created: t - 30e3 }] };
  const l = aTraiter({ services, probes, engine, db, maintenant: t });
  assert.deepEqual(l.map(x => [x.niveau, x.element, x.aller]), [
    ['crit', 'proxlab', 'ext'],
    ['warn', 'Purge', 'dash'],
    ['warn', 'Sauvegarde nocturne', 'wf'],
    ['warn', 'proxlab', 'probes'],
    ['info', 'vox', 'ext'],
  ]);
  assert.equal(l[0].observation, 'délai dépassé');
  assert.equal(l[2].observation, '2 exécutions en échec sur 24 h', 'l’échec d’avant-hier ne compte plus');
  assert.equal(l[3].observation, 'Alertes à traiter : 2 alertes');
  assert.match(l[4].observation, /1\.1\.0 disponible \(installé : 1\.0\.0\)/);
});

test('première installation : un port d’hôte choisi par le Hub et déjà pris fait passer au numéro de pile suivant ; un port fixé par le manifeste, jamais', async () => {
  const { openDb } = await import('../server/db/index.js');
  const { Services, portPrisDe } = await import('../server/services.js');
  const { HttpError } = await import('../server/util/common.js');
  const { docker } = await import('../server/docker.js');
  assert.equal(portPrisDe('failed to bind host port 0.0.0.0:8190/tcp: address already in use'), 8190);
  assert.equal(portPrisDe('image introuvable'), null);
  assert.equal(portPrisDe('Error response from daemon: failed to set up container networking: driver failed programming external connectivity on endpoint hub-proxlab (abb0): Bind for 0.0.0.0:8100 failed: port is already allocated'), 8100, 'la forme « port is already allocated » (un autre conteneur)');
  const { portHote, erreurDemarrage } = await import('../server/services.js');
  assert.match(erreurDemarrage('Bind for 0.0.0.0:8130 failed: port is already allocated'), /^Le port 8130 de la machine est déjà pris/);
  assert.deepEqual([portHote(1, 0), portHote(9, 1), portHote(10, 0), portHote(11, 0), portHote(99, 9)], ['8110', '8191', '20100', '20110', '20999'], 'jamais 8100 (le Hub) ni un port d’une autre pile');
  const db = openDb(':memory:');
  const m = { install: { ports: [{ name: 'http', container: 8140 }] } };
  const ajouter = (id, nom, pile) => db.run("INSERT INTO instances(id,ext_id,name,mode,url,stack,manifest,version,created) VALUES(?,?,?,'compose','x',?,?,'1',1)", id, nom, nom, pile, JSON.stringify(m));
  ajouter('a', 'autre', 1); ajouter('p', 'proxlab', 9);
  const s = Object.create(Services.prototype);
  const etapes = [], piles = [];
  Object.assign(s, {
    db, progress: (_, msg) => etapes.push(msg), stackFile: () => '/nulle-part/compose.yml',
    get: id => { const r = db.get('SELECT * FROM instances WHERE id=?', id); return { ...r, manifest: JSON.parse(r.manifest) }; },
    deploy: async inst => { piles.push(inst.stack); if (inst.stack === 9 || inst.stack === 2) throw new HttpError(409, 'pris', { portPris: inst.stack === 9 ? 8190 : 8120 }); },
  });
  const garde = { down: docker.down, portsPublies: docker.portsPublies };
  docker.down = async () => {};
  docker.portsPublies = async () => new Set();
  try {
    await s.deployerNeuf(s.get('p'), {});
    assert.deepEqual(piles, [9, 2, 3], '8190 pris, puis 8120 : le service prend 8130');
    assert.equal(db.get("SELECT stack FROM instances WHERE id='p'").stack, 3);
    assert.match(etapes.join('\n'), /Port 8190 déjà pris sur la machine : le service prend le port 8120/);
    // Un port que le manifeste fixe lui-même (53) : l'erreur remonte telle quelle.
    s.deploy = async () => { throw new HttpError(409, 'Le port 53…', { portPris: 53 }); };
    await assert.rejects(s.deployerNeuf(s.get('p'), {}), /Le port 53/);
    assert.equal(db.get("SELECT stack FROM instances WHERE id='p'").stack, 3);
    // Les ports déjà publiés par d'autres conteneurs sont évités avant même d'essayer.
    docker.portsPublies = async () => new Set([8130, 8140]);
    piles.length = 0; etapes.length = 0;
    s.deploy = async inst => { piles.push(inst.stack); };
    await s.deployerNeuf(s.get('p'), {});
    assert.deepEqual(piles, [2], '8130 (sa pile) publié par un autre conteneur : la pile 2 (8120), libre');
    assert.match(etapes.join('\n'), /Ports 8130 déjà publiés par d’autres conteneurs : le service prend le port 8120/);
  } finally { Object.assign(docker, garde); db.close(); }
});
