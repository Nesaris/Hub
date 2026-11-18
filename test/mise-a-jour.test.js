// « Mettre à jour » relit d'abord le manifeste de l'extension à son dernier
// commit : une version publiée depuis la dernière actualisation est installée
// tout de suite, au lieu de rallumer le bouton juste après.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.HUB_LOG_LEVEL = 'error';
const { openDb } = await import('../server/db/index.js');
const { Registry } = await import('../server/registry.js');
const { configurer } = await import('../server/sortie.js');

const base = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../registry-local/manifests/ollama.hub.json'), 'utf8'));

test('une extension relue seule, au dernier commit, avant sa mise à jour', async () => {
  let version = '1.0.0', sha = 'a'.repeat(40);
  const lus = [];
  configurer({ transport: async url => {
    const u = String(url).split('?')[0];
    lus.push(u);
    if (u.startsWith('https://api.github.com/users/acme/repos')) return Response.json([{ full_name: 'acme/ollama', default_branch: 'main' }]);
    if (u.endsWith('/info/refs')) return new Response(`001e# service=git-upload-pack\n0000003f${sha} refs/heads/main\n`);
    if (u.endsWith('/hub.json')) return new Response(JSON.stringify({ ...base, version }));
    return new Response('', { status: 404 });
  } });
  try {
    const db = openDb(':memory:');
    const emis = [];
    const r = new Registry({ db, audit: { write() {} }, bus: { emit: (ev, d) => emis.push([ev, d]) } });
    r.setSources(['github-user:acme'], 'ana');
    await r.refresh('ana');
    assert.equal(r.get('ollama').manifest.version, '1.0.0');
    // Publiée entre deux actualisations.
    version = '1.1.0'; sha = 'b'.repeat(40);
    lus.length = 0;
    assert.equal(await r.rafraichirEntree('ollama'), true);
    assert.equal(r.get('ollama').manifest.version, '1.1.0');
    assert.ok(lus.some(u => u.includes(`/${'b'.repeat(40)}/hub.json`)), 'lu au nouveau commit, pas au cache de raw.githubusercontent');
    assert.ok(!lus.some(u => u.includes('api.github.com')), 'sans le listage du compte (quota de l’API)');
    assert.deepEqual(emis.at(-1), ['catalog', { id: 'ollama', version: '1.1.0' }]);
    // Une extension d'une autre source (registre local, import) n'est pas relue ainsi.
    db.run("UPDATE catalog SET source='local' WHERE id='ollama'");
    assert.equal(await r.rafraichirEntree('ollama'), false);
    assert.equal(await r.rafraichirEntree('inconnue'), false);
  } finally { configurer({ transport: null }); }
});

test('mise à jour : le manifeste est relu avant, et une relecture impossible ne bloque pas', async () => {
  const { Services } = await import('../server/services.js');
  const relus = [];
  const s = Object.create(Services.prototype);
  const inst = { id: 'i1', name: 'synapse', ext_id: 'synapse', mode: 'remote', version: '4.12.0' };
  Object.assign(s, { registry: { rafraichirEntree: async id => { relus.push(id); throw new Error('GitHub muet'); }, remplacantDe: () => null }, get: () => inst, syncManifest: id => ({ synchro: id }) });
  assert.deepEqual(await s.update('synapse', 'ana'), { synchro: 'i1' });
  assert.deepEqual(relus, ['synapse']);
});
