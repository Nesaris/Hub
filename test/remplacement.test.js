// Une extension renommée : proposée en mise à jour du service installé sous
// l'ancien nom, qui garde ses données, ses réglages et ses routes, et revient
// tel qu'avant si le nouveau ne démarre pas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createValidator } from '../server/manifest/validator.js';
import { openDb } from '../server/db/index.js';
import { Services } from '../server/services.js';
import { Registry } from '../server/registry.js';
import { Connexions } from '../server/connexions.js';
import { Vault } from '../server/vault.js';
import { docker } from '../server/docker.js';

const schema = JSON.parse(fs.readFileSync(new URL('../server/manifest/schema.json', import.meta.url), 'utf8'));

const manifeste = (id, name, version, extra = {}) => ({
  manifestVersion: 1, id, name, version, description: 'd',
  install: { type: 'compose', compose: 'c.yml', healthcheck: { type: 'http', path: '/healthz' }, ports: [{ name: 'http', container: 8112, protocol: 'http', expose: 'proxy' }], volumes: [{ name: 'data', path: '/app/data' }] },
  config: [{ key: 'SOCLE_CLE', label: 'Clé', type: 'secret' }, { key: 'SOCLE_JETON_INSTALLATION', label: 'Jeton', type: 'secret' }, { key: `${id.toUpperCase()}_DUELS_JOUR`, label: 'Duels', type: 'string' }],
  capabilities: { provides: [], requires: [] }, triggers: [], actions: [], probes: [], ...extra,
});
const ANCIEN = manifeste('oracle', 'Oracle AI', '2.1.0');
const NOUVEAU = manifeste('dialekt', 'DIALEKT', '2.2.1', { replaces: [{ id: 'oracle', config: { ORACLE_DUELS_JOUR: 'DIALEKT_DUELS_JOUR' } }] });

test('compte déplacé sur GitHub : le service installé suit son dépôt, seulement si GitHub le confirme', async () => {
  const { configurer } = await import('../server/sortie.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-demenage-'));
  const db = openDb(path.join(dir, 'h.db'));
  db.setSetting('registries', ['github-user:Nouveau']);
  const ligne = (m, source, repo) => db.run('INSERT INTO catalog(id,source,version,manifest,origin,fetched) VALUES(?,?,?,?,?,?)', m.id, source, m.version, JSON.stringify(m), JSON.stringify({ type: 'github', repo, ref: 'main' }), 1);
  ligne(ANCIEN, 'github-user:ancien', 'ancien/oracle');
  ligne(NOUVEAU, 'github-user:Nouveau', 'Nouveau/Dialekt');
  ligne(manifeste('perdu', 'Perdu', '1.0.0'), 'github-user:ancien', 'ancien/perdu');
  ligne({ ...NOUVEAU, id: 'pirate', replaces: [{ id: 'usurpe' }] }, 'github-user:Nouveau', 'Nouveau/Pirate');
  ligne(manifeste('usurpe', 'Usurpé', '1.0.0'), 'github-user:autre', 'autre/usurpe');
  const appels = [];
  const audits = [];
  configurer({ transport: async url => {
    const u = String(url); appels.push(u);
    // L'ancienne adresse de ce dépôt mène à la nouvelle (renommage + transfert).
    if (u === 'https://api.github.com/repos/ancien/oracle') return new Response('', { status: 301, headers: { location: 'https://api.github.com/repositories/42' } });
    if (u === 'https://api.github.com/repositories/42') return new Response(JSON.stringify({ id: 42, full_name: 'Nouveau/Dialekt' }), { status: 200 });
    // Un dépôt toujours chez son propriétaire : rien ne le relie au remplaçant.
    if (u === 'https://api.github.com/repos/autre/usurpe') return new Response(JSON.stringify({ full_name: 'autre/usurpe' }), { status: 200 });
    return new Response('{}', { status: 404 });
  } });
  const reg = new Registry({ db, audit: { write: (...a) => audits.push(a) }, bus: { emit() {} } });
  try {
    assert.equal(reg.remplacantDe('oracle'), null, 'avant : deux registres différents');
    assert.equal(await reg.suivreDemenagements('ana'), 1);
    assert.equal(db.get('SELECT source FROM catalog WHERE id=?', 'oracle').source, 'github-user:Nouveau');
    assert.equal(reg.remplacantDe('oracle').id, 'dialekt', 'proposé de nouveau comme mise à jour');
    assert.equal(db.get('SELECT source FROM catalog WHERE id=?', 'perdu').source, 'github-user:ancien', 'dépôt disparu : rien ne bouge');
    assert.equal(db.get('SELECT source FROM catalog WHERE id=?', 'usurpe').source, 'github-user:autre', 'pas de preuve de GitHub : rien ne bouge');
    assert.equal(reg.remplacantDe('usurpe'), null, 'un autre registre ne prend toujours pas un service qui n’est pas à lui');
    assert.ok(audits.some(a => a[1] === 'catalogue.dépôt_déplacé' && a[2] === 'oracle'), 'journalisé');
    assert.ok(appels.every(u => u.startsWith('https://api.github.com/')), 'aucune autre sortie');
    assert.equal(await reg.suivreDemenagements('ana'), 0, 'une seule fois');
  } finally { configurer({ transport: null }); db.close?.(); }
});

test('manifeste : « replaces » se valide, et reste borné', () => {
  const valider = createValidator(schema);
  assert.deepEqual(valider(NOUVEAU).errors, []);
  assert.ok(!valider({ ...NOUVEAU, replaces: [] }).valid, 'une liste vide ne dit rien');
  assert.ok(!valider({ ...NOUVEAU, replaces: Array.from({ length: 6 }, (_, i) => ({ id: `x${i}` })) }).valid, 'au plus cinq');
  assert.ok(!valider({ ...NOUVEAU, replaces: [{ id: 'oracle', autre: 1 }] }).valid);
  assert.ok(!valider({ ...NOUVEAU, replaces: [{ id: 'oracle', config: { A: 'pas une clé' } }] }).valid);
});

test('catalogue : le remplaçant vient du même registre, jamais d’un import ni de lui-même', () => {
  const lignes = [];
  const db = { all: () => lignes, get: (_, id) => lignes.find(l => l.id === id) };
  const reg = new Registry({ db, audit: { write() {} }, bus: { emit() {} } });
  const ligne = (m, source) => ({ id: m.id, source, version: m.version, manifest: JSON.stringify(m), origin: '{}', fetched: 1 });
  lignes.push(ligne(ANCIEN, 'github-user:a'));
  assert.equal(reg.remplacantDe('oracle'), null);
  lignes.push(ligne({ ...NOUVEAU, id: 'pirate' }, 'github-user:b'));
  lignes.push(ligne({ ...NOUVEAU, id: 'importe' }, 'import'));
  assert.equal(reg.remplacantDe('oracle'), null, 'un autre registre ne prend pas les données d’un service qui n’est pas à lui');
  lignes.push(ligne(NOUVEAU, 'github-user:a'));
  assert.equal(reg.remplacantDe('oracle').id, 'dialekt');
  assert.equal(reg.remplacantDe('dialekt'), null);
  assert.equal(reg.remplacantDe('inconnu'), null);
});

test('connexions : les routes suivent le nouveau nom avec leur mode, et reviennent', async () => {
  const appels = [];
  const c = new Connexions({ services: { get: () => ({ id: 'i1', name: 'dialekt', mode: 'compose', version: '2.2.1', manifest: NOUVEAU }), providersOf: () => [{ id: 'r' }] }, runtime: {}, audit: { write() {} }, db: { setting: () => ({}), setSetting() {} } });
  c.appel = async (methode, chemin, corps) => {
    appels.push([methode, chemin, corps?.hote, corps?.mode, corps?.service]);
    if (methode === 'GET') return { routes: [{ proprietaire: 'hub:oracle', hote: 'oracle.ex.org', mode: 'clair', cf: true }, { proprietaire: 'hub:oracle', hote: 'duel.ex.org', mode: 'local' }, { proprietaire: 'hub:vigie', hote: 'vigie.ex.org', mode: 'local' }] };
    return { url: `https://${corps?.hote}` };
  };
  const routes = await c.routesDe('oracle');
  assert.deepEqual(routes, [{ hote: 'oracle.ex.org', mode: 'cloudflare' }, { hote: 'duel.ex.org', mode: 'local' }]);
  appels.length = 0;
  const faites = await c.renommerRoutes('i1', 'oracle', 'dialekt', routes);
  assert.deepEqual(faites, [{ de: 'oracle.ex.org', vers: 'dialekt.ex.org', mode: 'cloudflare' }, { de: 'duel.ex.org', vers: 'duel.ex.org', mode: 'local' }]);
  assert.deepEqual(appels.map(a => a.slice(0, 4)), [
    ['PUT', '/api/hub/publication', 'dialekt.ex.org', 'cloudflare'],
    ['DELETE', '/api/hub/publication?service=oracle&hote=oracle.ex.org', undefined, undefined],
    ['DELETE', '/api/hub/publication?service=oracle&hote=duel.ex.org', undefined, undefined],
    ['PUT', '/api/hub/publication', 'duel.ex.org', 'local'],
  ], 'un nom gardé est libéré avant d’être repris ; un nom qui change est posé avant que l’ancien parte');
  appels.length = 0;
  await c.annulerRenommage('i1', 'oracle', 'dialekt', faites);
  assert.deepEqual(appels.map(a => a.slice(0, 2)), [['DELETE', '/api/hub/publication?service=dialekt&hote=duel.ex.org'], ['PUT', '/api/hub/publication'], ['PUT', '/api/hub/publication'], ['DELETE', '/api/hub/publication?service=dialekt&hote=dialekt.ex.org']]);
  // Relay installé mais muet : rien ne commence.
  c.appel = async () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(c.routesDe('oracle'), e => e.status === 409 && /Relay ne répond pas/.test(e.message));
});

function banc({ echoue = false, volumeDeja = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remplacement-'));
  const db = openDb(':memory:');
  const vault = Vault.depuisCle(Buffer.alloc(32, 7).toString('base64'));
  const cfg = vault.sealFields({ SOCLE_CLE: 'cle-maitresse', ORACLE_DUELS_JOUR: '40' }, ['SOCLE_CLE']);
  db.run("INSERT INTO instances(id,ext_id,name,mode,url,stack,config,manifest,version,status,created) VALUES('i1','oracle','oracle','compose','http://hub-oracle:8112',4,?,?,'2.1.0','online',1)", JSON.stringify(cfg), JSON.stringify(ANCIEN));
  fs.mkdirSync(path.join(dir, 'oracle'));
  fs.writeFileSync(path.join(dir, 'oracle', 'compose.yml'), 'ancien');
  const journal = [], etapes = [], audit = [];
  const s = new Services({ db, vault, audit: { write: (...a) => audit.push(a) }, bus: { emit() {} }, registry: { remplacantDe: id => (id === 'oracle' ? { id: 'dialekt', manifest: NOUVEAU } : null) } });
  Object.assign(s, { stacksDir: dir, progress: (_, m) => etapes.push(m), waitHealthy: async () => {} });
  s.connexions = {
    routesDe: async nom => { journal.push(['routes', nom]); return [{ hote: 'oracle.ex.org', mode: 'cloudflare' }]; },
    renommerRoutes: async (id, a, n) => { journal.push(['renommer', a, n]); return [{ de: 'oracle.ex.org', vers: 'dialekt.ex.org', mode: 'cloudflare' }]; },
    annulerRenommage: async (id, a, n) => { journal.push(['annuler', a, n]); },
    publications: () => ({}),
  };
  s.redeploy = async (id, _, o) => {
    const i = s.get(id);
    journal.push(['redeploy', i.name, i.ext_id, o.tirer]);
    fs.mkdirSync(path.join(dir, i.name), { recursive: true });
    fs.writeFileSync(path.join(dir, i.name, 'compose.yml'), 'neuf');
    if (echoue) throw new Error('dialekt ne répond pas au test de santé');
    return s.publicView(i);
  };
  const garde = { ...docker };
  Object.assign(docker, {
    volumeExiste: async v => (v === 'hub-dialekt-data' ? volumeDeja : true),
    imageDuConteneur: async () => 'sha256:hub',
    down: async p => { journal.push(['down', p]); },
    up: async p => { journal.push(['up', p]); },
    copierVolume: async (de, vers, image) => { journal.push(['copie', de, vers, image]); },
    supprimerVolume: async v => { journal.push(['rm', v]); },
  });
  return { s, db, dir, journal, etapes, audit, fin: () => { Object.assign(docker, garde); db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('remplacement : le service garde ses données, ses réglages et ses routes sous le nouveau nom', async () => {
  const b = banc();
  try {
    const vue = b.s.publicView(b.s.get('i1'));
    assert.deepEqual([vue.miseAJour, vue.remplacePar], ['2.2.1', { id: 'dialekt', name: 'DIALEKT', version: '2.2.1' }], 'proposé comme une mise à jour');
    await b.s.update('i1', 'admin');
    assert.deepEqual(b.journal, [
      ['routes', 'oracle'],
      ['down', 'hub-oracle'],
      ['copie', 'hub-oracle-data', 'hub-dialekt-data', 'sha256:hub'],
      ['renommer', 'oracle', 'dialekt'],
      ['redeploy', 'dialekt', 'dialekt', true],
    ]);
    const i = b.s.get('i1');
    assert.deepEqual([i.id, i.name, i.ext_id, i.url, i.stack], ['i1', 'dialekt', 'dialekt', 'http://hub-dialekt:8112', 4], 'même instance : workflows et comptes la retrouvent');
    const cfg = b.s.configOf(i);
    assert.deepEqual([cfg.SOCLE_CLE, cfg.DIALEKT_DUELS_JOUR, 'ORACLE_DUELS_JOUR' in cfg], ['cle-maitresse', '40', false], 'la clé maîtresse suit : les données restent lisibles');
    assert.ok(!fs.existsSync(path.join(b.dir, 'oracle')), 'l’ancienne pile est retirée');
    assert.match(b.etapes.join('\n'), /Oracle AI 2\.1\.0 → DIALEKT 2\.2\.1 : oracle devient dialekt/);
    assert.match(b.etapes.join('\n'), /Ancien volume gardé : hub-oracle-data/);
    assert.equal(b.s.publicView(b.s.get('i1')).remplacePar, null);
    assert.deepEqual(b.audit.map(a => a[1]), ['service.remplacement', 'service.remplacé']);
  } finally { b.fin(); }
});

test('remplacement : un échec ramène le service tel qu’avant', async () => {
  const b = banc({ echoue: true });
  const avant = b.db.get("SELECT * FROM instances WHERE id='i1'");
  try {
    await assert.rejects(b.s.update('i1', 'admin'), /test de santé/);
    assert.deepEqual(b.journal.slice(5), [['down', 'hub-dialekt'], ['rm', 'hub-dialekt-data'], ['annuler', 'oracle', 'dialekt'], ['up', 'hub-oracle']]);
    const apres = b.db.get("SELECT * FROM instances WHERE id='i1'");
    for (const k of ['ext_id', 'name', 'manifest', 'config', 'url', 'version', 'stack']) assert.equal(apres[k], avant[k], k);
    assert.equal(apres.status, 'online');
    assert.equal(fs.readFileSync(path.join(b.dir, 'oracle', 'compose.yml'), 'utf8'), 'ancien');
    assert.ok(!fs.existsSync(path.join(b.dir, 'dialekt')));
    assert.match(b.etapes.at(-1), /oracle est revenu tel qu’avant/);
  } finally { b.fin(); }
});

test('remplacement : rien ne s’arrête quand il ne peut pas aboutir', async () => {
  const b = banc({ volumeDeja: true });
  try {
    await assert.rejects(b.s.update('i1', 'admin'), e => e.status === 409 && /hub-dialekt-data existe déjà/.test(e.message));
    assert.deepEqual(b.journal, []);
    b.s.registry.remplacantDe = () => ({ id: 'dialekt', manifest: { ...NOUVEAU, permissions: { dockerSocket: 'proxy' } } });
    await assert.rejects(b.s.update('i1', 'admin'), e => e.status === 409 && /permissions/.test(e.message));
    assert.deepEqual(b.journal, []);
    assert.equal(b.s.get('i1').name, 'oracle');
  } finally { b.fin(); }
});
