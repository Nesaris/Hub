// Source github-user : dépôts d'un compte, hub.json à la racine, dépôts sans manifeste ignorés.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.HUB_LOG_LEVEL = 'error';
const { Registry, parseSource } = await import('../server/registry.js');
const { configurer: configurerSortie } = await import('../server/sortie.js');

const manifest = fs.readFileSync(path.join(import.meta.dirname, '../registry-local/manifests/ollama.hub.json'));

function stubDb() {
  const rows = new Map(), settings = new Map();
  return {
    rows,
    setting: (k, d) => settings.has(k) ? settings.get(k) : d,
    setSetting: (k, v) => settings.set(k, v),
    run: (sql, id, source, version, m, origin) => (/^DELETE/.test(sql) ? (rows.get(id)?.source === source && rows.delete(id)) : rows.set(id, { id, source, version, manifest: m, origin })),
    all: (sql, source) => [...rows.values()].filter(r => !/WHERE source=\?/.test(sql) || r.source === source),
    get: (sql, id) => rows.get(id),
  };
}

test('parseSource reconnaît github-user', () => {
  assert.deepEqual(parseSource('github-user:Compte-1'), { type: 'github-user', owner: 'Compte-1', label: 'github-user:Compte-1' });
  assert.throws(() => parseSource('github-user:a/b'), /Registre invalide/);
});

test('github-user charge les dépôts qui ont un hub.json', async () => {
  const calls = [];
  configurerSortie({ transport: async url => {
    calls.push(String(url));
    const u = String(url).split('?')[0];
    if (u.startsWith('https://api.github.com/users/acme/repos')) return Response.json([
      { full_name: 'acme/ollama-ext', default_branch: 'dev' },
      { full_name: 'acme/sans-manifeste', default_branch: 'main' },
      { full_name: 'acme/fourche', default_branch: 'main', fork: true },
      { full_name: 'acme/archive', default_branch: 'main', archived: true },
    ]);
    if (u === 'https://raw.githubusercontent.com/acme/ollama-ext/dev/hub.json') return new Response(manifest);
    return new Response('introuvable', { status: 404 });
  } });
  try {
    const db = stubDb();
    const reg = new Registry({ db, audit: { write() {} }, bus: { emit() {} } });
    db.setSetting('registries', ['github-user:acme']);
    const r = await reg.refresh();
    assert.equal(r.count, 1);
    assert.deepEqual(r.errors, []);
    const e = reg.get('ollama');
    assert.equal(e.origin.repo, 'acme/ollama-ext');
    assert.equal(e.origin.ref, 'dev');
    assert.ok(!calls.some(c => c.includes('fourche') || c.includes('archive')));
    assert.match(calls.find(c => c.includes('/dev/hub.json')), /\/dev\/hub\.json\?t=\d+$/, 'une adresse neuve à chaque lecture : le CDN ne rend pas un manifeste périmé');
  } finally { configurerSortie({ transport: null }); }
});

test('github-user lit chaque manifeste au commit de sa branche : le cache de raw.githubusercontent ne rend jamais une version passée', async () => {
  const commit = 'a'.repeat(40), etiquette = 'b'.repeat(40), autre = 'c'.repeat(40);
  // L'annonce du protocole git, telle que GitHub la sert (lignes paquet, capacités après un octet nul).
  const annonce = `001e# service=git-upload-pack\n0000015a${commit} HEAD\0multi_ack symref=HEAD:refs/heads/dev\n003d${commit} refs/heads/dev\n003e${autre} refs/heads/main\n0040${etiquette} refs/tags/v1.0.0\n0043${commit} refs/tags/v1.0.0^{}\n0000`;
  const calls = [];
  configurerSortie({ transport: async url => {
    calls.push(String(url));
    const u = String(url);
    if (u.startsWith('https://api.github.com/users/acme/repos')) return Response.json([{ full_name: 'acme/ollama-ext', default_branch: 'dev' }]);
    if (u === 'https://github.com/acme/ollama-ext.git/info/refs?service=git-upload-pack') return new Response(annonce);
    if (u === `https://raw.githubusercontent.com/acme/ollama-ext/${commit}/hub.json`) return new Response(manifest);
    return new Response('introuvable', { status: 404 });
  } });
  try {
    const db = stubDb();
    const reg = new Registry({ db, audit: { write() {} }, bus: { emit() {} } });
    db.setSetting('registries', ['github-user:acme']);
    const r = await reg.refresh();
    assert.equal(r.count, 1);
    const e = reg.get('ollama');
    assert.equal(e.origin.sha, commit, 'le commit lu est gardé : le Compose de la mise à jour vient du même commit que son manifeste');
    assert.equal(e.origin.ref, 'dev');
    assert.ok(!calls.some(c => c.includes('/dev/hub.json')), 'jamais par la branche quand le commit est connu');
  } finally { configurerSortie({ transport: null }); }
  const { commitDe } = await import('../server/registry.js');
  assert.equal(commitDe(annonce, 'dev'), commit);
  assert.equal(commitDe(annonce, 'main'), autre);
  assert.equal(commitDe(annonce, 'v1.0.0'), commit, 'une étiquette annotée : le commit qu’elle désigne');
  assert.equal(commitDe(annonce, 'absente'), null);
  assert.equal(commitDe('', 'f'.repeat(40)), 'f'.repeat(40));
});

test('github:dépôt sans index.json retombe sur hub.json', async () => {
  configurerSortie({ transport: async url => String(url).split('?')[0].endsWith('/main/hub.json') ? new Response(manifest) : new Response('', { status: 404 }) });
  try {
    const db = stubDb();
    const reg = new Registry({ db, audit: { write() {} }, bus: { emit() {} } });
    db.setSetting('registries', ['github:acme/ollama-ext@main']);
    const r = await reg.refresh();
    assert.equal(r.count, 1);
    assert.equal(reg.get('ollama').origin.repo, 'acme/ollama-ext');
  } finally { configurerSortie({ transport: null }); }
});

test('registre local : un chemin qui sort du dossier est refusé, même vers un voisin au nom proche', async () => {
  const racine = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-'));
  fs.mkdirSync(racine + '-voisin');
  fs.writeFileSync(path.join(racine + '-voisin', 'secret.json'), '{}');
  fs.writeFileSync(path.join(racine, 'hub.json'), '{}');
  const reg = new Registry({ db: stubDb(), audit: { write() {} }, bus: { emit() {} } });
  assert.equal((await reg.readFile({ type: 'local', root: racine, dir: '' }, 'hub.json')).toString(), '{}');
  for (const p of ['../etc/passwd', '/etc/passwd', `../${path.basename(racine)}-voisin/secret.json`]) await assert.rejects(reg.readFile({ type: 'local', root: racine, dir: '' }, p), /hors du d(ossier|épôt)/, p);
  fs.rmSync(racine, { recursive: true, force: true });
  fs.rmSync(racine + '-voisin', { recursive: true, force: true });
});

test('la même extension dans deux sources : la plus récente reste, quel que soit l’ordre de lecture', async () => {
  const ancien = JSON.parse(manifest); ancien.version = '1.0.0';
  const recent = JSON.parse(manifest); recent.version = '9.9.9';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-local-'));
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ extensions: [{ id: recent.id, manifest: 'hub.json' }] }));
  fs.writeFileSync(path.join(dir, 'hub.json'), JSON.stringify(ancien));
  configurerSortie({ transport: async url => String(url).split('?')[0].endsWith('/main/hub.json') ? new Response(JSON.stringify(recent)) : new Response('', { status: 404 }) });
  try {
    for (const ordre of [['github:acme/ollama-ext@main', `dir:${dir}`], [`dir:${dir}`, 'github:acme/ollama-ext@main']]) {
      const db = stubDb();
      const reg = new Registry({ db, audit: { write() {} }, bus: { emit() {} } });
      db.setSetting('registries', ordre);
      await reg.refresh();
      assert.equal(reg.get(recent.id).manifest.version, '9.9.9', ordre.join(' puis '));
    }
  } finally { configurerSortie({ transport: null }); fs.rmSync(dir, { recursive: true, force: true }); }
});
