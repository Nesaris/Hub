// Test d'intégration : parcours complet contre de faux services.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { startFake } from './fake-services.js';
import { Client } from '../socle/essai/client.js';
import { MDP_ESSAI, codeTotp, terminerAssistant } from '../socle/essai/inscription.js';
import { Authentificateur } from '../socle/essai/authentificateur.js';

const JETON_INSTALLATION = 'jeton-installation-du-hub-pour-les-essais';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-test-'));
const reg = path.join(tmp, 'registry');
fs.mkdirSync(path.join(reg, 'm'), { recursive: true });
const FIX = path.join(import.meta.dirname, 'fixtures');
{
  // Un workflow automatique qui veut une IA de conversation : sans connexion
  // IA il appelle Ollama, avec une il passe par l'IA du Hub.
  const dcm = JSON.parse(fs.readFileSync(path.join(FIX, 'docker-control.hub.json'), 'utf8'));
  dcm.capabilities.accepts = [...(dcm.capabilities.accepts || []), 'llm.chat'];
  dcm.autoWorkflows.push({ id: 'triage-ia', name: 'Triage IA des conteneurs', when: 'llm.chat', steps: [{ use: 'core:set-fields', params: { texte: 'essai' } }, { use: 'capability:llm.chat', params: { system: 'Tu tries', prompt: '{{ $json | json }}' } }] });
  fs.writeFileSync(path.join(reg, 'm/docker-control.json'), JSON.stringify(dcm));
}
{
  // Un mode « aucune » en plus : le lien IA d'un service sans IA doit exister quand même.
  const sm = JSON.parse(fs.readFileSync(path.join(FIX, 'synapse.hub.json'), 'utf8'));
  sm.config.find(f => f.key === 'LLM_FOURNISSEUR').options.push({ value: 'aucune', label: 'Aucune — sans IA' });
  fs.writeFileSync(path.join(reg, 'm/synapse.json'), JSON.stringify(sm));
}
fs.copyFileSync(path.join(FIX, 'vox.hub.json'), path.join(reg, 'm/vox.json'));
fs.copyFileSync(path.join(import.meta.dirname, '../registry-local/manifests/ollama.hub.json'), path.join(reg, 'm/ollama.json'));
fs.writeFileSync(path.join(reg, 'index.json'), JSON.stringify({ extensions: [
  { id: 'docker-control', manifest: 'm/docker-control.json' },
  { id: 'synapse', manifest: 'm/synapse.json' },
  { id: 'ollama', manifest: 'm/ollama.json' },
  { id: 'vox', manifest: 'm/vox.json' },
] }));

let hub, fake, base, main, admin, cleAdmin;

// Les appels de l'administrateur, par le client d'essai du socle (cookies,
// origine, jeton anti-CSRF) : une erreur HTTP devient une exception.
async function api(method, p, body, client = admin) {
  const r = await client.req(method, p, body === undefined && !['GET', 'DELETE', 'HEAD'].includes(method) ? {} : body);
  if (r.status >= 400) { const e = new Error(`${method} ${p} → ${r.status} ${r.json?.error} ${JSON.stringify(r.json?.details || '')}`); e.status = r.status; e.data = r.json; throw e; }
  return r.json;
}
// Un plan de messages seuls part sans clic : il est déjà exécuté au retour de ask.
// Les « 💭 / ⚙️ » d'attente sont retirés une fois la réponse partie : on ne compte que les vrais messages.
const vrais = l => l.filter(m => !/^(💭|⚙️)/.test(m.text));
const executer = async p => (['done', 'failed'].includes(p.status) ? p : api('POST', `/api/agent/${p.id}/execute`));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('délai dépassé'); await new Promise(r => setTimeout(r, 100)); } };

// De faux « claude » et « codex » sur le PATH, et le pont (outils-ia/pont.mjs) devant eux.
async function fauxOutils() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'outils-'));
  const bin = path.join(d, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nif [ "$1" = "setup-token" ]; then printf "Use the url below:\\nhttps://claude.ai/oauth/authorize?x=1\\nPaste code here > "; read -r code; [ "$code" = "bon" ] || exit 1; echo "token: sk-ant-oat01-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef"; exit 0; fi\nprompt=$(cat); model=claude\nwhile [ $# -gt 0 ]; do case "$1" in --model) model=$2; shift;; --system-prompt) shift;; esac; shift; done\n[ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] || { echo "not logged in" >&2; exit 1; }\nprintf \'{"type":"result","result":"ok (%s)","model":"%s","usage":{"input_tokens":3,"output_tokens":2}}\' "$model" "$model"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nout=\nwhile [ $# -gt 0 ]; do case "$1" in --output-last-message) out=$2; shift;; esac; shift; done\nprintf ok > "$out"\n', { mode: 0o755 });
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const { serveur } = await import('../outils-ia/pont.mjs');
  // Le jeton partagé : le Hub le présente, le pont n'écoute que lui.
  process.env.HUB_OUTILS_IA_JETON = 'jeton-du-pont-pour-les-essais-du-hub-0123';
  const srv = serveur({ jeton: process.env.HUB_OUTILS_IA_JETON });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  srv.unref();
  return `http://127.0.0.1:${srv.address().port}`;
}

before(async () => {
  fake = await startFake();
  const port = 18000 + Math.floor(Math.random() * 1000);
  process.env.HUB_DATA = tmp;
  process.env.HUB_PUBLIC_URL = `http://127.0.0.1:${port}`;
  process.env.HUB_REGISTRY = `dir:${reg}`;
  process.env.HUB_LOG_LEVEL = 'error';
  process.env.HUB_TELEGRAM_API = fake.base + '/tg';
  process.env.HUB_ELEVEN_API = fake.base + '/el';
  process.env.SOCLE_JETON_INSTALLATION = JETON_INSTALLATION;
  // Le conteneur des outils d'abonnement, remplacé par le pont lancé ici avec de faux outils.
  process.env.HUB_OUTILS_IA_URL = await fauxOutils();
  main = await import('../server/main.js');
  hub = await main.buildHub();
  await new Promise(r => hub.server.listen(port, '127.0.0.1', r));
  base = `http://127.0.0.1:${port}`;
  admin = new Client(port);
  await hub.triggers.activateAll();
});
after(async () => { await new Promise(r => setTimeout(r, 300)); await hub?.stop(); fake?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('installation par le socle : jeton exigé, facteurs inscrits avant tout accès, CSRF', async () => {
  const anonyme = await admin.get('/api/status');
  assert.deepEqual(anonyme.json, { ok: true }, 'ni version ni configuration sans session');
  assert.equal((await admin.get('/api/compte/etat')).json.installe, false);
  assert.equal((await admin.post('/api/compte/installation', { jeton: 'faux-jeton-installation-du-hub', identifiant: 'ana', motDePasse: MDP_ESSAI })).status, 403);
  assert.equal((await admin.get('/api/instances')).status, 401);
  assert.equal((await admin.post('/api/compte/installation', { jeton: JETON_INSTALLATION, identifiant: 'ana', motDePasse: MDP_ESSAI })).status, 200);
  assert.equal((await admin.get('/api/instances')).status, 403, 'mot de passe seul : inscription des facteurs d’abord');
  const cle = cleAdmin = new Authentificateur();
  const o = await admin.post('/api/compte/cles/options');
  assert.equal((await admin.post('/api/compte/cles', { reponse: cle.creer(o.json, admin.origine), nom: 'Essai' })).status, 200);
  const t = await admin.post('/api/compte/totp');
  assert.equal((await admin.post('/api/compte/totp/confirmer', { code: codeTotp(t.json.secret) })).status, 200);
  assert.equal((await admin.post('/api/compte/secours')).status, 200);
  // Première configuration : le Hub reste fermé jusqu'à la fin de l'assistant.
  assert.equal((await admin.get('/api/instances')).status, 428);
  await terminerAssistant(admin);
  assert.equal((await admin.get('/api/instances')).status, 200);
  const me = await api('GET', '/api/status');
  assert.equal(me.version, JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../package.json'), 'utf8')).version);
  assert.equal((await admin.req('POST', '/api/catalog/refresh', {}, { sansCsrf: true })).status, 403, 'CSRF obligatoire');
  assert.equal((await admin.req('POST', '/api/catalog/refresh', {}, { origine: 'https://ailleurs.example' })).status, 403, 'origine étrangère refusée');
});

test('schémas : champ inconnu, paramètre non déclaré, liste géante et corps énorme refusés', async () => {
  await assert.rejects(api('POST', '/api/workflows', { name: 'x', role: 'admin' }), e => e.status === 400 && /Champ inattendu/.test(e.message));
  await assert.rejects(api('PUT', '/api/ai-autonomy', { value: 'root' }), e => e.status === 400);
  await assert.rejects(api('GET', '/api/audit?limit=100000'), e => e.status === 400);
  await assert.rejects(api('GET', '/api/workflows?admin=1'), e => e.status === 400 && /inattendu/.test(e.message));
  await assert.rejects(api('POST', '/api/workflows/dossiers', { chemin: 42 }), e => e.status === 400 && /texte attendu/.test(e.message));
  await assert.rejects(api('POST', '/api/workflows', { graph: JSON.parse('{"__proto__":{"x":1}}') }), e => e.status === 400 && /clé interdite/.test(e.message));
  const enorme = await admin.req('POST', '/api/workflows', undefined, { brut: JSON.stringify({ name: 'x'.repeat(2 * 1024 * 1024) }), entetes: { 'content-type': 'application/json' } });
  assert.equal(enorme.status, 413);
  assert.equal((await admin.get('/api/instances/%3Cscript%3E')).status, 400, 'un paramètre d’adresse est un identifiant');
});

test('fichiers cachés : /.env et /.git répondent 404, pas l’interface', async () => {
  for (const chemin of ['/.env', '/.git/config', '/web/.env', '/.htaccess']) assert.equal((await admin.get(chemin)).status, 404, chemin);
  assert.equal((await admin.get('/workflows')).status, 200, 'une page de l’interface reste servie');
});

test('security.txt : où signaler une faille', async () => {
  const r = await admin.get('/.well-known/security.txt');
  assert.equal(r.status, 200);
  assert.match(r.texte, /^Contact: https:\/\/github\.com\/Nesaris\/Hub\/security\/advisories\/new$/m);
  assert.match(r.texte, /^Expires: \d{4}-/m);
});

test('confidentialité : ce qui est gardé, combien de temps, et ce qui part ailleurs', async () => {
  const r = await admin.get('/confidentialite.txt');
  assert.equal(r.status, 200);
  assert.match(r.entetes['content-type'], /text\/plain/);
  for (const attendu of ['CE QUI EST CONSERVÉ', 'CE QUI PART AILLEURS', 'COOKIES', 'DROITS', '72 heures']) assert.ok(r.texte.includes(attendu), attendu);
});

test('catalogue local chargé et validé', async () => {
  const r = await api('POST', '/api/catalog/refresh');
  assert.ok(r.count >= 3, JSON.stringify(r.errors));
  const cat = await api('GET', '/api/catalog');
  assert.deepEqual(cat.items.map(i => i.id).sort(), ['docker-control', 'ollama', 'relay', 'synapse', 'vox']);
  await assert.rejects(api('POST', '/api/catalog/import', { manifest: { id: 'x' } }), /invalide/);
});

test('services distants, capacités requises et liens automatiques visibles', async () => {
  await assert.rejects(api('POST', '/api/instances', { extId: 'synapse', mode: 'remote', url: fake.base }), /llm.embed/);
  const t = await api('POST', '/api/catalog/ollama/test-remote', { url: 'http://127.0.0.1:1' });
  assert.equal(t.ok, false);
  assert.ok(t.help.includes('OLLAMA_HOST'));
  const oll = await api('POST', '/api/instances', { extId: 'ollama', name: 'ollama-gpu-pc', url: fake.base });
  assert.equal(oll.status, 'online');
  assert.equal(oll.mode, 'remote');
  const syn = await api('POST', '/api/instances', { extId: 'synapse', mode: 'remote', url: fake.base, config: { REMOTE_TOKEN: 'jeton-synapse-123' } }); // valeur d’essai — gitleaks:allow
  assert.equal(syn.config.REMOTE_TOKEN, '••• défini');
  const dc = await api('POST', '/api/instances', { extId: 'docker-control', mode: 'remote', url: fake.base, config: { REMOTE_TOKEN: 'jeton-dc-456' } });
  assert.equal(dc.status, 'online');
  const wfs = await api('GET', '/api/workflows');
  const auto = wfs.filter(w => w.origin === 'Auto');
  assert.ok(auto.some(w => w.name.includes('utilise llm.embed')), 'lien de dépendance visible');
  const ev = auto.find(w => w.name === 'Événements conteneurs vers la mémoire');
  assert.ok(ev, 'autoWorkflow créé');
  await waitFor(async () => (await api('GET', '/api/workflows')).find(w => w.id === ev.id).enabled);
  assert.equal(fake.state.hooks.size, 1, 'le Hub s’est abonné au webhook');
  const hook = [...fake.state.hooks.values()][0];
  assert.deepEqual(hook.events, ['restart', 'die', 'oom', 'health_unhealthy']);
});

test('l’IA choisie par un service est un lien visible, qui suit ses réglages', async () => {
  const syn = (await api('GET', '/api/instances')).find(i => i.extId === 'synapse');
  const lienIA = async () => (await api('GET', '/api/workflows')).find(w => w.autoKey === `ia:${syn.id}`);
  // SYNAPSE sur Ollama (son défaut) : « synapse → IA locale qwen3:8b », et plus de lien générique « utilise llm.chat ».
  const l1 = await waitFor(lienIA);
  assert.match(l1.name, /^synapse → IA locale /);
  assert.ok(!(await api('GET', '/api/workflows')).some(w => w.name === `${syn.name} utilise llm.chat de ollama-gpu-pc`));
  // Changé dans sa fiche (ce que fait le bouton Enregistrer) : le lien suit.
  await api('PATCH', `/api/instances/${syn.id}`, { config: { LLM_FOURNISSEUR: 'kimi', LLM_MODELE: 'kimi-k2' } });
  const l2 = await waitFor(async () => { const w = await lienIA(); return w && /Kimi/.test(w.name) ? w : null; });
  assert.equal(l2.id, l1.id, 'le même lien, renommé — pas un doublon');
  const g = (await api('GET', `/api/workflows/${l2.id}`)).graph;
  assert.ok(g.nodes.some(n => /kimi-k2/.test(n.name)), 'le modèle en nuage est dit');
  const ollId = (await api('GET', '/api/instances')).find(i => i.extId === 'ollama').id;
  assert.ok(!g.nodes.some(n => n.instanceId === ollId), 'Ollama ne sert plus');
  await api('PATCH', `/api/instances/${syn.id}`, { config: { LLM_FOURNISSEUR: 'ollama', LLM_MODELE: '' } });
  await waitFor(async () => /IA locale/.test((await lienIA())?.name || ''));
  // Le nœud « s'en sert » porte le service : l'éditeur y propose ses champs d'IA.
  const g3 = (await api('GET', `/api/workflows/${l1.id}`)).graph;
  assert.equal(g3.nodes.find(n => n.id === 'c').params.ia.instanceId, syn.id);
  // Ses champs d'IA seuls, lisibles et modifiables depuis le lien.
  const ia = await api('GET', `/api/instances/${syn.id}/ia`);
  assert.deepEqual(ia.champs.map(f => f.key).sort(), ['LLM_FOURNISSEUR', 'LLM_MODELE']);
  assert.equal(ia.config.LLM_FOURNISSEUR, 'ollama');
  await assert.rejects(api('PUT', `/api/instances/${syn.id}/ia`, { config: { LLM_FOURNISSEUR: 'kimi', REMOTE_TOKEN: 'x' } }).then(() => api('GET', `/api/instances/${syn.id}`)).then(i => { if (i.config.REMOTE_TOKEN !== '••• défini') throw new Error('jeton touché'); throw new Error('ok'); }), /ok/, 'seuls les champs d’IA passent');
  await waitFor(async () => /Kimi/.test((await lienIA())?.name || ''));
  // Aucune IA : le lien reste, nommé ainsi, avec le nœud à éditer.
  await api('PUT', `/api/instances/${syn.id}/ia`, { config: { LLM_FOURNISSEUR: 'aucune' } });
  const l4 = await waitFor(async () => { const w = await lienIA(); return w && /aucune/.test(w.name) ? w : null; });
  assert.equal(l4.id, l1.id);
  assert.equal(l4.name, 'synapse → IA : aucune');
  const g4 = (await api('GET', `/api/workflows/${l4.id}`)).graph;
  assert.equal(g4.nodes.length, 1); assert.equal(g4.nodes[0].params.ia.instanceId, syn.id);
  await api('PUT', `/api/instances/${syn.id}/ia`, { config: { LLM_FOURNISSEUR: 'ollama' } });
  await waitFor(async () => /IA locale/.test((await lienIA())?.name || ''));
});

test('événement signé → workflow automatique → fait ingéré dans SYNAPSE', async () => {
  const [r] = await fake.emit({ event: 'restart', container: 'helpdesk-web', node: 'node-1', exitCode: 137 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await waitFor(() => fake.state.facts.length === 1);
  const f = fake.state.facts[0];
  assert.equal(f.text, 'helpdesk-web : restart sur node-1 (code 137)');
  assert.deepEqual(f.tags, ['incident', 'docker']);
  assert.equal(f.auth, 'Bearer jeton-synapse-123');
  // signature fausse refusée
  const h = [...fake.state.hooks.values()][0];
  const bad = await fetch(h.url, { method: 'POST', headers: { 'X-DC-Signature': 'sha256=00' }, body: '{}' });
  assert.equal(bad.status, 401);
});

test('workflow manuel : action de service, IA distante, condition, journal', async () => {
  const dc = (await api('GET', '/api/instances')).find(i => i.extId === 'docker-control');
  const graph = {
    nodes: [
      { id: 't', type: 'trigger.manual', name: 'Départ', params: { sample: { container: 'helpdesk-web' } } },
      { id: 'logs', type: 'service.action', instanceId: dc.id, ref: 'container.logs', name: 'Logs', params: { container: '{{ $trigger.container }}', lines: 50 } },
      { id: 'sum', type: 'ai.summarize', name: 'Résumé', params: { text: '{{ $json.lines | join("\\n") }}' } },
      { id: 'if', type: 'logic.if', name: 'Mémoire ?', params: { value: '{{ $json.summary }}', op: 'contient', compare: 'mémoire' } },
      { id: 'yes', type: 'out.log', name: 'Oui', params: { message: 'Alerte : {{ $node["Résumé"].json.summary }}' } },
      { id: 'no', type: 'out.log', name: 'Non', params: { message: 'rien' } },
      { id: 'end', type: 'logic.merge', name: 'Fin', params: {} },
    ],
    edges: [
      { from: 't', to: 'logs' }, { from: 'logs', to: 'sum' }, { from: 'sum', to: 'if' },
      { from: 'if', port: 'true', to: 'yes' }, { from: 'if', port: 'false', to: 'no' },
      { from: 'yes', to: 'end' }, { from: 'no', to: 'end' },
    ],
  };
  await api('POST', '/api/ai', { kind: 'ollama', name: 'gpu-pc', instanceId: (await api('GET', '/api/instances')).find(i => i.extId === 'ollama').id, model: 'qwen3:8b', roles: ['config', 'workflows', 'embeddings'] });
  const { workflow, problems } = await api('POST', '/api/workflows', { name: 'Diagnostic', graph });
  assert.deepEqual(problems, []);
  const run = await api('POST', `/api/workflows/${workflow.id}/run`, {});
  const ex = await waitFor(async () => { const e = await api('GET', `/api/executions/${run.id}`); return e.status !== 'running' && e; });
  assert.equal(ex.status, 'success', ex.error);
  const n = ex.state.nodes;
  assert.deepEqual(n.logs.output.lines[1], 'tail=50');
  assert.match(n.sum.output.summary, /mémoire/);
  assert.equal(n.yes.status, 'done');
  assert.equal(n.no.status, 'skipped');
  assert.equal(n.end.status, 'done', 'la fusion s’exécute quand une branche est ignorée');
  const journal = await api('GET', '/api/audit');
  assert.ok(journal.some(j => j.action === 'journal.info' && j.detail.message.startsWith('Alerte : helpdesk-web')));
});

test('IA du Hub : un workflow auto qui appelait Ollama passe par la connexion IA, et se recrée après suppression', async () => {
  const dc = (await api('GET', '/api/instances')).find(i => i.extId === 'docker-control');
  const trouve = async () => (await api('GET', '/api/workflows')).find(w => w.origin === 'Auto' && w.name.startsWith('Triage IA'));
  const w = await trouve();
  assert.ok(w, 'créé à l’arrivée du service');
  const n = w.graph.nodes[1];
  assert.equal(n.type, 'ai.chat', 'converti dès qu’une connexion IA existe');
  assert.equal(n.name, 'Conversation', 'le nom reste : des expressions peuvent y renvoyer');
  assert.equal(n.params.system, 'Tu tries');
  assert.equal(n.instanceId, undefined);
  await api('DELETE', `/api/workflows/${w.id}`);
  assert.equal(await trouve(), undefined);
  const r = await api('POST', `/api/instances/${dc.id}/autos`, {});
  assert.deepEqual(r.recrees, ['Triage IA des conteneurs']);
  const w2 = await trouve();
  assert.equal(w2.graph.nodes[1].type, 'ai.chat', 'recréé directement sur l’IA du Hub');
  assert.deepEqual((await api('POST', `/api/instances/${dc.id}/autos`, {})).recrees, [], 'rien en double');
});

test('action destructive : validation humaine imposée puis exécutée après accord', async () => {
  const dc = (await api('GET', '/api/instances')).find(i => i.extId === 'docker-control');
  const unsafe = { nodes: [
    { id: 't', type: 'trigger.manual', name: 'Départ', params: {} },
    { id: 'rm', type: 'service.action', instanceId: dc.id, ref: 'container.remove', name: 'Supprimer', params: { container: 'synapse' } },
  ], edges: [{ from: 't', to: 'rm' }] };
  const { workflow } = await api('POST', '/api/workflows', { name: 'Nettoyage', graph: unsafe });
  await assert.rejects(api('POST', `/api/workflows/${workflow.id}/enable`, {}), /Validation humaine/);
  const safe = { nodes: [...unsafe.nodes, { id: 'ok', type: 'logic.approval', name: 'Accord', params: { message: 'Supprimer synapse ?' } }],
    edges: [{ from: 't', to: 'ok' }, { from: 'ok', port: 'approved', to: 'rm' }] };
  await api('PUT', `/api/workflows/${workflow.id}`, { graph: safe });
  await api('POST', `/api/workflows/${workflow.id}/enable`, {});
  const run = await api('POST', `/api/workflows/${workflow.id}/run`, { live: true });
  const waiting = await waitFor(async () => { const e = await api('GET', `/api/executions/${run.id}`); return e.status === 'waiting' && e; });
  assert.equal(waiting.state.nodes.rm, undefined);
  const [ap] = await api('GET', '/api/approvals');
  assert.equal(ap.message, 'Supprimer synapse ?');
  await api('POST', `/api/approvals/${ap.id}`, { approved: true });
  const done = await waitFor(async () => { const e = await api('GET', `/api/executions/${run.id}`); return e.status === 'success' && e; });
  assert.equal(done.state.nodes.rm.status, 'done');
  assert.ok(!fake.state.containers.some(c => c.name === 'synapse'));
  // en mode test, l'action destructive est simulée
  fake.state.containers.push({ name: 'synapse', state: 'running', node: 'node-1' });
});

test('sondes lues, niveaux calculés et déclencheur sur seuil', async () => {
  const syn = (await api('GET', '/api/instances')).find(i => i.extId === 'synapse');
  const { workflow } = await api('POST', '/api/workflows', { name: 'Alerte faits', graph: {
    nodes: [{ id: 'p', type: 'trigger.probe', name: 'Seuil', params: { instance: syn.id, probe: 'facts', op: '>=', threshold: '1' } }, { id: 'l', type: 'out.log', name: 'Log', params: { message: 'faits={{ $json.value }}' } }],
    edges: [{ from: 'p', to: 'l' }] } });
  await api('POST', `/api/workflows/${workflow.id}/enable`, {});
  await api('POST', `/api/probes/${syn.id}/facts/read`, {});
  const list = await api('GET', '/api/probes');
  const facts = list.find(p => p.id === 'facts');
  assert.equal(facts.series[0].value, 1);
  assert.equal(facts.series[0].level, 'ok');
  const dcp = list.find(p => p.id === 'container.memory');
  assert.ok(dcp);
  await waitFor(async () => (await api('GET', `/api/workflows/${workflow.id}/executions`)).some(e => e.status === 'success'));
});

test('webhook libre signé', async () => {
  const { workflow } = await api('POST', '/api/workflows', { name: 'Entrée', graph: {
    nodes: [{ id: 'h', type: 'trigger.webhook', name: 'Webhook', params: { auth: 'hmac' } }, { id: 's', type: 'data.set', name: 'Champs', params: { fields: { msg: '{{ $json.message | upper }}' } } }],
    edges: [{ from: 'h', to: 's' }] } });
  await api('POST', `/api/workflows/${workflow.id}/enable`, {});
  const w = await api('GET', `/api/workflows/${workflow.id}`);
  assert.deepEqual(Object.keys(w.webhooks[0]).sort(), ['nodeId', 'url'], 'le secret n’est jamais relu');
  const scelle = hub.db.get('SELECT secret FROM subscriptions WHERE workflow_id=?', workflow.id).secret;
  assert.match(scelle, /^v1:/, 'scellé au repos');
  const { url, secret } = await api('POST', `/api/workflows/${workflow.id}/webhooks/h/secret`, {});
  assert.equal(url, w.webhooks[0].url);
  assert.ok(secret.length >= 32 && !hub.db.get('SELECT secret FROM subscriptions WHERE workflow_id=?', workflow.id).secret.includes(secret));
  const raw = JSON.stringify({ message: 'bonjour' });
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature': 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex') }, body: raw });
  assert.equal(r.status, 200);
  const { execution } = await r.json();
  const ex = await waitFor(async () => { const e = await api('GET', `/api/executions/${execution}`); return e.status === 'success' && e; });
  assert.equal(ex.state.nodes.s.output.msg, 'BONJOUR');
  const nosig = await fetch(url, { method: 'POST', body: raw });
  assert.equal(nosig.status, 401);
  // Un ancien nœud réglé sur « aucune vérification » exige désormais la signature.
  const g = w.graph;
  g.nodes[0].params.auth = 'none';
  hub.db.run('UPDATE workflows SET graph=? WHERE id=?', JSON.stringify(g), workflow.id);
  assert.equal((await fetch(url, { method: 'POST', body: raw })).status, 401, 'plus de webhook sans preuve');
  const signe = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature': 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex') }, body: raw });
  assert.equal(signe.status, 200);
  assert.ok(!(await api('GET', '/api/palette')).core.find(n => n.type === 'trigger.webhook').params[0].options.some(o => o.value === 'none'));
  // Même identifiant de livraison : un seul effet, même rejoué.
  const envoi = () => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Delivery': 'livraison-42', 'X-Hub-Signature': 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex') }, body: raw }).then(r => r.json());
  const premier = await envoi(), second = await envoi();
  assert.ok(premier.execution && !premier.doublon);
  assert.deepEqual(second, { ok: true, doublon: true });
  // Nouveau secret : l'ancien ne signe plus rien, le nouveau oui ; journalisé.
  const neuf = await api('POST', `/api/workflows/${workflow.id}/webhooks/h/secret`, {});
  const signer = cle => ({ method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature': 'sha256=' + crypto.createHmac('sha256', cle).update(raw).digest('hex') }, body: raw });
  assert.equal((await fetch(url, signer(secret))).status, 401);
  assert.equal((await fetch(url, signer(neuf.secret))).status, 200);
  assert.ok(hub.db.get("SELECT 1 FROM audit WHERE action='webhook.secret_renouvelé'"));
  await assert.rejects(api('POST', `/api/workflows/${workflow.id}/webhooks/s/secret`, {}), /introuvable/);
});

test('coupure d’urgence : workflows et IA hors ligne tout de suite, puis remis en service', async () => {
  const { workflow } = await api('POST', '/api/workflows', { name: 'Coupable', graph: {
    nodes: [{ id: 'h', type: 'trigger.webhook', name: 'Webhook', params: { auth: 'hmac' } }, { id: 's', type: 'data.set', name: 'Champs', params: { fields: { ok: '1' } } }],
    edges: [{ from: 'h', to: 's' }] } });
  await api('POST', `/api/workflows/${workflow.id}/enable`, {});
  const { url, secret } = await api('POST', `/api/workflows/${workflow.id}/webhooks/h/secret`, {});
  const raw = '{}';
  const envoi = () => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature': 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex') }, body: raw });
  assert.deepEqual((await api('GET', '/api/coupure')).etat, { ia: false, workflows: false });
  try {
    assert.deepEqual((await api('PUT', '/api/coupure', { workflows: true })).etat, { ia: false, workflows: true });
    assert.equal((await envoi()).status, 503, 'webhook refusé');
    await assert.rejects(api('POST', `/api/workflows/${workflow.id}/run`, {}), e => e.status === 503);
    await assert.rejects(api('PUT', '/api/coupure', { workflows: 'oui' }), e => e.status === 400);
    await api('PUT', '/api/coupure', { workflows: false, ia: true });
    assert.equal((await envoi()).status, 200, 'remis en service');
    await assert.rejects(api('POST', '/api/agent/ask', { text: 'Fais-moi un résumé quotidien des redémarrages' }), e => e.status === 503 && /coupure d’urgence/.test(e.message));
  } finally { await api('PUT', '/api/coupure', { ia: false, workflows: false }); }
  assert.deepEqual(hub.db.all("SELECT detail FROM audit WHERE action='coupure.modifiée' ORDER BY seq").map(r => JSON.parse(r.detail)),
    [{ ia: false, workflows: true }, { ia: true, workflows: false }, { ia: false, workflows: false }]);
  await api('DELETE', `/api/workflows/${workflow.id}`);
});

test('agent IA : plan proposé, vérifié, puis exécuté après validation', async () => {
  const dc = (await api('GET', '/api/instances')).find(i => i.extId === 'docker-control');
  fake.state.planResponse = { reply: 'Je propose ce workflow.', steps: [
    { tool: 'create_workflow', args: { name: 'Redémarrages en boucle', graph: {
      nodes: [
        { id: 'n1', type: 'trigger.service', instanceId: dc.id, ref: 'container.event', name: 'Redémarrage', params: { events: ['restart'] } },
        { id: 'n2', type: 'logic.count', name: 'Compteur', params: { key: '{{ $trigger.container }}', window: '10m' } },
        { id: 'n3', type: 'logic.if', name: '3 fois ?', params: { value: '{{ $json.count }}', op: '>=', compare: '3' } },
        { id: 'n4', type: 'ai.summarize', name: 'Résumé', params: {} },
        { id: 'n5', type: 'out.log', name: 'Prévenir', params: { message: '{{ $json.summary }}' } },
      ],
      edges: [{ from: 'n1', to: 'n2' }, { from: 'n2', to: 'n3' }, { from: 'n3', port: 'true', to: 'n4' }, { from: 'n4', to: 'n5' }],
    } } },
    { tool: 'enable_workflow', args: { workflow: 'Redémarrages en boucle' } },
    { tool: 'outil_inconnu', args: {} },
  ] };
  const plan = await api('POST', '/api/agent/ask', { text: 'Si un conteneur redémarre 3 fois en 10 min, préviens-moi avec un résumé' });
  assert.equal(plan.status, 'proposed');
  assert.equal(plan.steps.length, 2, 'les outils inconnus sont écartés');
  assert.deepEqual(plan.steps[0].problems, []);
  const chat = fake.state.chats.at(-1);
  assert.ok(chat.messages.at(-1).content.includes('<donnees>'));
  // L'assistant suit la réponse au fil de l'eau : l'appel part en flux.
  assert.equal(chat.stream, true);
  assert.ok(!JSON.stringify(chat).includes('jeton-dc-456'), 'aucun secret envoyé à l’IA');
  const done = await api('POST', `/api/agent/${plan.id}/execute`, {});
  assert.equal(done.status, 'done', JSON.stringify(done.results));
  const wf = (await api('GET', '/api/workflows')).find(w => w.name === 'Redémarrages en boucle');
  assert.equal(wf.origin, 'IA');
  assert.equal(wf.enabled, true);
  assert.equal(fake.state.hooks.size, 2);
});

test('versions, export et journal infalsifiable', async () => {
  const wf = (await api('GET', '/api/workflows')).find(w => w.name === 'Nettoyage');
  const v = await api('GET', `/api/workflows/${wf.id}/versions`);
  assert.equal(v.length, 2);
  const exp = await api('GET', `/api/workflows/${wf.id}/export`);
  assert.equal(exp.format, 'hub-workflow/1');
  const ok = await api('GET', '/api/audit/verify');
  assert.equal(ok.ok, true);
  hub.db.run('UPDATE audit SET action=? WHERE seq=2', 'falsifié');
  const ko = await api('GET', '/api/audit/verify');
  assert.equal(ko.ok, false);
});

test('suppression d’un service : désabonnement et nettoyage des liens Auto', async () => {
  const dc = (await api('GET', '/api/instances')).find(i => i.extId === 'docker-control');
  const r = await api('DELETE', `/api/instances/${dc.id}`);
  assert.ok(r.removedWorkflows.includes('Événements conteneurs vers la mémoire'));
  assert.ok(r.brokenWorkflows.includes('Redémarrages en boucle'));
});

test('noms en double : réparés d’un appel, puis le workflow s’active', async () => {
  // `create` dédoublonne déjà : on force le doublon par un PUT, comme le
  // ferait un utilisateur qui renomme un nœud à la main.
  const graph = { nodes: [
    { id: 't', type: 'trigger.manual', name: 'Départ', params: {} },
    { id: 'a', type: 'out.log', name: 'Journal', params: { message: 'un' } },
    { id: 'b', type: 'out.log', name: 'Journal bis', params: { message: 'deux' } },
  ], edges: [{ from: 't', to: 'a' }, { from: 'a', to: 'b' }] };
  const { workflow } = await api('POST', '/api/workflows', { name: 'Doublons', graph });
  graph.nodes[2].name = 'Journal';
  await api('PUT', `/api/workflows/${workflow.id}`, { graph });
  await assert.rejects(api('POST', `/api/workflows/${workflow.id}/enable`, {}), /Impossible d’activer/);

  const r = await api('POST', `/api/workflows/${workflow.id}/reparer/noms`, {});
  assert.deepEqual(r.renommes, [{ de: 'Journal', vers: 'Journal 2' }]);
  // Enregistré, pas seulement proposé : l'activation passe sans autre appel.
  await api('POST', `/api/workflows/${workflow.id}/enable`, {});
  const w = await api('GET', `/api/workflows/${workflow.id}`);
  assert.equal(w.enabled, true);
  assert.deepEqual(w.graph.nodes.map(n => n.name), ['Départ', 'Journal', 'Journal 2']);
  // Le renommage est une version comme une autre : il se défait.
  assert.ok((await api('GET', `/api/workflows/${workflow.id}/versions`)).length >= 3);
  assert.equal((await api('POST', `/api/workflows/${workflow.id}/reparer/noms`, {})).renommes.length, 0, 'idempotent');
});


test('agent IA : un modèle inventé est repéré dans le plan, pas à l’exécution', async () => {
  const ol = (await api('GET', '/api/instances')).find(i => i.extId === 'ollama');
  fake.state.planResponse = { reply: 'Voilà.', steps: [
    { tool: 'create_workflow', args: { name: 'Résumé quotidien', graph: {
      nodes: [
        { id: 't', type: 'trigger.manual', name: 'Départ', params: {} },
        { id: 'c', type: 'service.action', instanceId: ol.id, ref: 'chat', name: 'Parler', params: { model: 'llama3', prompt: 'salut' } },
      ],
      edges: [{ from: 't', to: 'c' }],
    } } },
  ] };
  const plan = await api('POST', '/api/agent/ask', { text: 'Fais-moi un résumé quotidien' });
  const [pb] = plan.steps[0].problems;
  assert.match(pb, /« llama3 »/);
  // Le message donne les vraies valeurs : l'utilisateur corrige sans chercher.
  assert.match(pb, /qwen3:8b/);

  // Un modèle qui existe ne déclenche rien.
  fake.state.planResponse.steps[0].args.graph.nodes[1].params.model = 'qwen3:8b';
  fake.state.planResponse.steps[0].args.name = 'Résumé quotidien bis';
  const ok = await api('POST', '/api/agent/ask', { text: 'Et avec le bon modèle' });
  assert.deepEqual(ok.steps[0].problems, []);
});

test('adresse de la machine : enregistrée, validée, sans redéploiement', async () => {
  const r = await api('PUT', '/api/exposition', { machine: ' 192.0.2.11 ' });
  assert.deepEqual(r.aRedeployer, []);
  assert.equal((await api('GET', '/api/exposition')).machine, '192.0.2.11');
  await assert.rejects(api('PUT', '/api/exposition', { machine: 'http://192.0.2.11:8100' }), e => e.status === 400);
  assert.equal((await api('GET', '/api/exposition')).machine, '192.0.2.11');
  await api('PUT', '/api/exposition', { machine: '' });
});

test('thème : une gamme pour tout ou une par service, validée, rendue dans la page du Hub, inscrite au journal', async () => {
  const avant = await api('GET', '/api/theme');
  assert.deepEqual([avant.mode, avant.commun, avant.hub], ['commun', 'soma', 'soma']);
  assert.deepEqual(avant.gammes.map(g => g.id), ['soma', 'console', 'exploitation', 'lavande']);
  assert.deepEqual(avant.services, [], 'aucun service installé ici par Compose');
  await assert.rejects(api('PUT', '/api/theme', { mode: 'commun', commun: 'clair' }), e => e.status === 400);
  await assert.rejects(api('PUT', '/api/theme', { mode: 'chacun', commun: 'soma' }), e => e.status === 400);
  await assert.rejects(api('PUT', '/api/theme', { mode: 'service', commun: 'soma', parService: { inconnu: 'console' } }), e => e.status === 400 && /Service inconnu/.test(e.message));
  await assert.rejects(api('PUT', '/api/theme', { mode: 'service', commun: 'soma', parService: { hub: 'clair' } }), e => e.status === 400);
  assert.equal((await api('GET', '/api/theme')).hub, 'soma', 'un refus n’enregistre rien');

  const r = await api('PUT', '/api/theme', { mode: 'commun', commun: 'console' });
  assert.deepEqual([r.mode, r.commun, r.hub, r.appliqueA], ['commun', 'console', 'console', []]);
  assert.match(await (await fetch(base + '/')).text(), /<html lang="fr" data-gamme="console">/);
  const ligne = (await api('GET', '/api/audit?limit=5')).find(l => l.action === 'apparence.modifiée');
  assert.deepEqual([ligne.detail.avant.commun, ligne.detail.après.commun], ['soma', 'console']);

  // Par service : le Hub prend son choix propre, le reste la gamme commune.
  const p = await api('PUT', '/api/theme', { mode: 'service', commun: 'console', parService: { hub: 'soma' } });
  assert.deepEqual([p.mode, p.hub, p.parService], ['service', 'soma', { hub: 'soma' }]);
  assert.match(await (await fetch(base + '/')).text(), /data-gamme="soma"/);
  // Revenir à un thème pour tout garde les choix par service pour plus tard.
  const c = await api('PUT', '/api/theme', { mode: 'commun', commun: 'console' });
  assert.deepEqual([c.hub, c.parService], ['console', { hub: 'soma' }]);
  // Lavande : le Hub la connaît (son socle), elle est rendue dans sa page.
  const l = await api('PUT', '/api/theme', { mode: 'commun', commun: 'lavande', parService: {} });
  assert.equal(l.hub, 'lavande');
  assert.match(await (await fetch(base + '/')).text(), /data-gamme="lavande"/);
  await api('PUT', '/api/theme', { mode: 'commun', commun: 'soma', parService: {} });
  assert.match(await (await fetch(base + '/')).text(), /data-gamme="soma"/);
});

test('agent IA : noms au lieu d’ids corrigés, plan cassé renvoyé une fois au modèle', async () => {
  const ol = (await api('GET', '/api/instances')).find(i => i.extId === 'ollama');
  const graphe = (instanceId, ref, declencheur = true) => ({
    nodes: [
      ...(declencheur ? [{ id: 't', type: 'trigger.manual', name: 'Départ', params: {} }] : []),
      { id: 'c', type: 'service.action', instanceId, ref, name: 'Parler', params: { prompt: 'salut' } },
    ],
    edges: declencheur ? [{ from: 't', to: 'c' }] : [],
  });
  // Le modèle écrit le NOM du service et le nom de l'action : le Hub remet les ids.
  fake.state.planQueue = [{ reply: 'ok', steps: [{ tool: 'create_workflow', args: { name: 'Par les noms', graph: graphe(ol.name, 'Conversation') } }], relances: ['Active « Par les noms »', '  ', 'x'.repeat(300)] }];
  const avant = fake.state.chats.length;
  const p1 = await api('POST', '/api/agent/ask', { text: 'Parle à ollama' });
  assert.deepEqual(p1.steps[0].problems, []);
  assert.equal(p1.steps[0].args.graph.nodes[1].instanceId, ol.id);
  assert.equal(p1.steps[0].args.graph.nodes[1].ref, 'chat');
  assert.equal(fake.state.chats.length - avant, 1, 'plan valide : aucune passe de réparation');
  assert.deepEqual(p1.relances, ['Active « Par les noms »'], 'relances nettoyées');

  // Un type inventé pour une action de service (« action.service », « ollama.chat ») est remis.
  for (const [type, extra] of [['action.service', { instanceId: ol.name, ref: 'chat' }], ['ollama.chat', {}], ['service', { service: ol.name, action: 'chat' }]]) {
    fake.state.planQueue = [{ reply: 'ok', steps: [{ tool: 'create_workflow', args: { name: 'Type ' + type, graph: {
      nodes: [{ id: 't', type: 'trigger.manual', name: 'Départ', params: {} }, { id: 'c', type, name: 'Parler', params: { prompt: 'salut' }, ...extra }],
      edges: [{ from: 't', to: 'c' }] } } }] }];
    const p = await api('POST', '/api/agent/ask', { text: 'type ' + type });
    const n = p.steps[0].args.graph.nodes[1];
    assert.deepEqual(p.steps[0].problems, [], type);
    assert.equal(n.type, 'service.action', type);
    assert.equal(n.instanceId, ol.id, type);
    assert.equal(n.ref, 'chat', type);
  }

  // Un plan cassé repart une fois, avec les problèmes ; la version réparée gagne.
  fake.state.planQueue = [
    { reply: 'v1', steps: [{ tool: 'create_workflow', args: { name: 'Cassé puis réparé', graph: graphe('service-inexistant', 'rien', false) } }] },
    { reply: 'v2', steps: [{ tool: 'create_workflow', args: { name: 'Cassé puis réparé', graph: graphe(ol.id, 'chat') } }], relances: ['Active « Cassé puis réparé »'] },
  ];
  const n0 = fake.state.chats.length;
  const p2 = await api('POST', '/api/agent/ask', { text: 'Fais un workflow' });
  assert.equal(fake.state.chats.length - n0, 2);
  assert.match(fake.state.chats.at(-1).messages.at(-1).content, /ne tiennent pas/);
  assert.equal(p2.reply, 'v2');
  assert.deepEqual(p2.steps[0].problems, []);

  // Toujours cassé après réparation : rien n'est créé, et l'étape suivante est quand même tentée.
  const casse = { reply: 'v3', steps: [
    { tool: 'create_workflow', args: { name: 'Toujours cassé', graph: graphe('service-inexistant', 'rien', false) } },
    { tool: 'create_workflow', args: { name: 'Celui-là marche', graph: graphe(ol.id, 'chat') } },
  ] };
  fake.state.planQueue = [casse, casse];
  const p3 = await api('POST', '/api/agent/ask', { text: 'Deux workflows' });
  assert.ok(p3.steps[0].problems.length);
  const r3 = await api('POST', `/api/agent/${p3.id}/execute`, {});
  assert.equal(r3.status, 'failed');
  assert.match(r3.results[0].error, /^Non créé/);
  assert.ok(r3.results[1].ok, 'un workflow raté n’empêche pas le suivant');
  const noms = (await api('GET', '/api/workflows')).map(w => w.name);
  assert.ok(!noms.includes('Toujours cassé'));
  assert.ok(noms.includes('Celui-là marche'));

  // Relances : après un échec, l'état passe devant ; les workflows prêts sont proposés.
  const { relances } = await api('GET', '/api/agent/relances');
  assert.ok(relances.length >= 1 && relances.length <= 3);
  assert.ok(relances.some(x => /Active/.test(x)), JSON.stringify(relances));
});

test('agent IA : activer un lien ou un workflow invalide est signalé dans le plan', async () => {
  const lien = (await api('GET', '/api/workflows')).find(w => w.origin === 'Auto' || /utilise/.test(w.name));
  assert.ok(lien, 'un lien auto existe dans ce scénario');
  fake.state.planQueue = [{ reply: 'ok', steps: [{ tool: 'enable_workflow', args: { workflow: lien.name } }] }, { reply: 'ok', steps: [{ tool: 'enable_workflow', args: { workflow: lien.name } }] }];
  const p = await api('POST', '/api/agent/ask', { text: 'Active tout' });
  assert.ok(p.steps[0].problems.length, JSON.stringify(p.steps[0]));
});

test('agent IA : un workflow cassé se répare en place, sans copie', async () => {
  const ol = (await api('GET', '/api/instances')).find(i => i.extId === 'ollama');
  const { workflow } = await api('POST', '/api/workflows', { name: 'À réparer', graph: {
    nodes: [{ id: 'c', type: 'service.action', instanceId: ol.id, ref: 'chat', name: 'Parler', params: { prompt: 'x' } }], edges: [] } });
  // Le contexte envoyé au modèle montre le problème et le graphe.
  fake.state.planQueue = [{ reply: 'Je corrige.', steps: [{ tool: 'update_workflow', args: { workflow: 'À réparer', graph: {
    nodes: [{ id: 't', type: 'trigger.manual', name: 'Départ', params: {} }, { id: 'c', type: 'service.action', instanceId: ol.name, ref: 'chat', name: 'Parler', params: { prompt: 'x' } }],
    edges: [{ from: 't', to: 'c' }] } } }, { tool: 'enable_workflow', args: { workflow: 'À réparer' } }] }];
  const p = await api('POST', '/api/agent/ask', { text: 'Répare le workflow « À réparer »' });
  const envoye = fake.state.chats.at(-1).messages.find(m => m.role === 'system').content;
  assert.match(envoye, /"name":"À réparer"[^}]*"problemes"/, 'les workflows sont dans la partie stable du prompt');
  assert.deepEqual(p.steps[0].problems, []);
  const r = await api('POST', `/api/agent/${p.id}/execute`, {});
  assert.ok(r.results[0].ok, JSON.stringify(r.results));
  const tous = (await api('GET', '/api/workflows')).filter(w => w.name.startsWith('À réparer'));
  assert.equal(tous.length, 1, 'corrigé en place, pas de « À réparer 2 »');
  assert.equal(tous[0].id, workflow.id);
});

test('agent IA : appel Ollama rapide, et une réparation qui retire tout ne gagne pas', async () => {
  const ol = (await api('GET', '/api/instances')).find(i => i.extId === 'ollama');
  const bon = { tool: 'create_workflow', args: { name: 'Bon à garder', graph: { nodes: [{ id: 't', type: 'trigger.manual', name: 'Départ', params: {} }, { id: 'c', type: 'service.action', instanceId: ol.id, ref: 'chat', name: 'Parler', params: { prompt: 'x' } }], edges: [{ from: 't', to: 'c' }] } } };
  const casse = { tool: 'create_workflow', args: { name: 'Cassé', graph: { nodes: [{ id: 'c', type: 'service.action', instanceId: 'nulle-part', ref: 'x', name: 'X', params: {} }], edges: [] } } };
  fake.state.planQueue = [{ reply: 'deux', steps: [bon, casse] }, { reply: 'rien', steps: [] }];
  const p = await api('POST', '/api/agent/ask', { text: 'Deux choses' });
  assert.equal(p.reply, 'deux', 'un plan vidé ne remplace pas un plan à moitié bon');
  assert.equal(p.steps.length, 2);
  const appel = fake.state.chats.at(-1);
  assert.equal(appel.think, false, 'pas de réflexion cachée');
  assert.equal(appel.keep_alive, '30m');
  assert.ok(appel.options.num_ctx >= 8192, 'contexte assez grand pour ne pas tronquer les consignes');
  assert.deepEqual(await api('GET', '/api/agent/etat'), { encours: false, ecoute: null });
});

test('agent IA : erreurs qui disent quoi corriger, références approximatives rattrapées', async () => {
  const ol = (await api('GET', '/api/instances')).find(i => i.extId === 'ollama');
  fake.state.planQueue = [{ reply: 'ok', steps: [
    { tool: 'create_workflow', args: { name: 'Approximatif', graph: {
      nodes: [{ id: 't', type: 'trigger.service', instanceId: 'hub-' + ol.name, ref: 'model_loaded', name: 'Chargé', params: {} },
              { id: 'a', type: 'service.action', instanceId: 'ollama', ref: 'Conversation', name: 'Parler', params: { prompt: 'x' } }],
      edges: [{ from: 't', to: 'a' }] } } },
    { tool: 'create_workflow', args: { name: 'Faux', graph: {
      nodes: [{ id: 'a', type: 'service.action', instanceId: ol.id, ref: 'resumer', name: 'Résumer', params: {} },
              { id: 'b', type: 'service.action', instanceId: 'nulle-part', ref: 'x', name: 'Ailleurs', params: {} }],
      edges: [] } } },
  ] }];
  fake.state.planResponse = fake.state.planQueue[0];
  const p = await api('POST', '/api/agent/ask', { text: 'Deux workflows approximatifs' });
  assert.deepEqual(p.steps[0].problems, [], JSON.stringify(p.steps[0].problems));
  assert.equal(p.steps[0].args.graph.nodes[0].ref, 'model.loaded');
  assert.equal(p.steps[0].args.graph.nodes[0].instanceId, ol.id);
  const pb = p.steps[1].problems.join('\n');
  assert.match(pb, /« Résumer » : ollama-gpu-pc n'a pas d’action « resumer »\. Actions de ollama-gpu-pc : chat, embed/);
  assert.match(pb, /« Ailleurs » : aucun service « nulle-part »\. instanceId doit être l'id d'un service installé : .*ollama-gpu-pc = /);
  assert.match(pb, /Ajoute au moins un déclencheur : trigger\.manual.*ollama-gpu-pc › model\.loaded/);
  fake.state.planResponse = null;
});

test('paramètre requis manquant : le message propose les données du déclencheur', async () => {
  const ol = (await api('GET', '/api/instances')).find(i => i.extId === 'ollama');
  fake.state.planQueue = [
    { reply: 'ok', steps: [{ tool: 'create_workflow', args: { name: 'Sans prompt', graph: {
      nodes: [{ id: 't', type: 'trigger.service', instanceId: ol.id, ref: 'model.loaded', name: 'Chargé', params: {} },
              { id: 'a', type: 'service.action', instanceId: ol.id, ref: 'chat', name: 'Parler', params: {} }],
      edges: [{ from: 't', to: 'a' }] } } }] },
  ];
  fake.state.planResponse = fake.state.planQueue[0];
  const p = await api('POST', '/api/agent/ask', { text: 'Parle quand un modèle se charge' });
  assert.match(p.steps[0].problems.join('\n'), /Parler : « .+ » \(prompt\) est requis — donne une valeur fixe ou une expression, par exemple : \{\{ \$trigger\.name \}\}/);
  fake.state.planResponse = null;
});

test('clés & API : catalogue rangé, site personnalisé, logo absent = 404 sans appel réseau', async () => {
  const d = await api('GET', '/api/secrets');
  assert.ok(d.categories.length >= 3);
  assert.ok(d.catalogue.every(c => d.categories.includes(c.categorie)), 'chaque service a sa catégorie');
  await api('POST', '/api/secrets', { nom: 'Outil Maison', champs: { API_KEY: 'zzz-secret' }, site: '' });
  const s = (await api('GET', '/api/secrets')).services.find(x => x.service === 'Outil Maison');
  assert.equal(s.domaine, '');
  assert.deepEqual(s.utilisePar, []);
  assert.ok(!JSON.stringify(s).includes('zzz-secret'));
  const r = await admin.get(`/api/secrets/logo/${encodeURIComponent('Outil Maison')}`);
  assert.equal(r.status, 404);
  await assert.rejects(api('POST', '/api/secrets', { nom: 'Outil Maison', champs: {}, site: '10.0.0.5' }), /domaine public/);
  await api('DELETE', `/api/secrets/${encodeURIComponent('Outil Maison')}`);
  const anon = await fetch(`${base}/api/secrets/logo/github`);
  assert.equal(anon.status, 401, 'logo réservé aux administrateurs connectés');
});

test('IA par abonnement : Claude Code et Codex sont des connexions comme les autres, lancées par le pont', async () => {
  const o = await api('GET', '/api/ai/outils');
  assert.equal(o.joignable, true);
  assert.equal(o.claude.installe, true); assert.equal(o.claude.connecte, false);
  assert.match(o.claude.connexion, /claude setup-token/);
  // Le jeton de « claude setup-token » part dans Clés & API, et la connexion le référence.
  const { id } = await api('POST', '/api/ai', { kind: 'claude-code', name: 'Claude perso', apiKey: 'sk-ant-oat-essai', model: 'sonnet', roles: ['workflows'] });
  const c = (await api('GET', '/api/ai')).connections.find(x => x.id === id);
  assert.equal(c.cleRef, 'CLAUDE_CODE_API_KEY');
  assert.ok((await api('GET', '/api/secrets')).services.some(s => s.service === 'claude-code'));
  const t = await api('POST', `/api/ai/${id}/test`);
  assert.equal(t.reply, 'ok (sonnet)');
  assert.deepEqual(await api('GET', `/api/ai/${id}/models`), ['sonnet', 'opus', 'haiku', 'claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5']);
  const cx = await api('POST', '/api/ai', { kind: 'codex', name: 'Codex perso', model: 'gpt-5-codex', roles: ['workflows'] });
  assert.equal((await api('POST', `/api/ai/${cx.id}/test`)).reply, 'ok');
  await api('DELETE', `/api/ai/${id}`); await api('DELETE', `/api/ai/${cx.id}`);
  await api('DELETE', '/api/secrets/claude-code');
  // La connexion du compte, pilotée depuis la page IA : lien, code collé, jeton rangé, connexion créée.
  let e = await api('POST', '/api/ai/outils/claude/connexion', {});
  e = await waitFor(async () => { const x = await api('GET', '/api/ai/outils/claude/connexion'); return x.lien ? x : null; });
  assert.equal(e.lien, 'https://claude.ai/oauth/authorize?x=1'); assert.equal(e.etape, 'attente-code');
  await api('POST', '/api/ai/outils/claude/connexion/code', { code: 'bon' });
  e = await waitFor(async () => { const x = await api('GET', '/api/ai/outils/claude/connexion'); return x.etape === 'ok' ? x : null; });
  const cc = (await api('GET', '/api/ai')).connections.find(x => x.kind === 'claude-code');
  assert.ok(cc, 'connexion créée'); assert.equal(cc.cleRef, 'CLAUDE_CODE_API_KEY');
  assert.ok(!JSON.stringify(await api('GET', '/api/secrets')).includes('sk-ant-oat01'), 'le jeton ne redescend jamais');
  assert.equal((await api('POST', `/api/ai/${cc.id}/test`)).reply, 'ok (sonnet)');
  assert.match(hub.accesHub.verifier({ action: 'POST /api/ai/outils/claude/connexion' }).problemes.join(' '), /geste de l’utilisateur/);
  await api('DELETE', `/api/ai/${cc.id}`); await api('DELETE', '/api/secrets/claude-code');
});

test('IA du Hub pour les services : toutes les IA derrière une API Ollama et OpenAI, jeton par service', async () => {
  const port = await hub.iaServices.ecouter(0, '127.0.0.1');
  const syn = (await api('GET', '/api/instances')).find(i => i.extId === 'synapse');
  const jeton = hub.iaServices.jeton(syn.name);
  const ia = `http://127.0.0.1:${port}/ia/${jeton}`;
  const avaitOllama = (await api('GET', '/api/ai')).connections.some(c => c.kind === 'ollama');
  const oll = avaitOllama ? null : (await api('POST', '/api/ai', { kind: 'ollama', name: 'Ollama passerelle', url: fake.base, model: 'qwen3:8b', roles: ['embeddings'] })).id;
  const { id: cc } = await api('POST', '/api/ai', { kind: 'claude-code', name: 'Claude Code', apiKey: 'sk-ant-oat-passerelle', model: 'sonnet', roles: ['workflows'] });
  try {
    // La liste : les modèles d'Ollama, nus et préfixés, et ceux des autres connexions, préfixés.
    hub.iaServices.outilsPermis.add(syn.name);
    const tags = await (await fetch(`${ia}/api/tags`)).json();
    hub.iaServices.outilsPermis.delete(syn.name);
    const noms = tags.models.map(m => m.name);
    assert.ok(noms.includes('qwen3:8b'), JSON.stringify(noms));
    assert.ok(noms.includes('claude-code/sonnet'));
    assert.equal(tags.models.find(m => m.name === 'claude-code/sonnet').details.family, 'abonnement');
    // Les outils par abonnement sont fermés aux services, sauf à ceux qu'on nomme.
    let r = await fetch(`${ia}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-code/sonnet', messages: [{ role: 'user', content: 'Bonjour' }] }) });
    assert.equal(r.status, 403);
    assert.ok(!(await (await fetch(`${ia}/api/tags`)).json()).models.some(m => m.name === 'claude-code/sonnet'), 'absent de sa liste');
    hub.iaServices.outilsPermis.add(syn.name);
    // Un client OpenAI : Claude Code par abonnement, sans rien savoir de lui.
    r = await fetch(`${ia}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-code/sonnet', messages: [{ role: 'system', content: 'Sois bref.' }, { role: 'user', content: 'Bonjour' }] }) });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).choices[0].message.content, 'ok (sonnet)');
    // Un client Ollama, en flux : un nom nu va à l'Ollama qui l'a.
    r = await fetch(`${ia}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen3:8b', messages: [{ role: 'user', content: 'Que se passe-t-il ?' }] }) });
    assert.equal(r.status, 200);
    const lignes = (await r.text()).trim().split('\n').map(l => JSON.parse(l));
    assert.equal(lignes.at(-1).done, true);
    assert.match(lignes.filter(l => !l.done).map(l => l.message.content).join(''), /mémoire/);
    // L'usage est noté au nom du service.
    assert.ok(hub.db.get("SELECT COUNT(*) n FROM ai_usage WHERE role = ?", `service:${syn.name}`).n >= 2);
    // Du reste de l'API Ollama, les lectures passent à l'Ollama du Hub ; tirer, pousser, créer, copier, supprimer : non.
    assert.equal((await (await fetch(`${ia}/api/ps`)).json()).models[0].name, 'qwen3:8b');
    for (const [m, c] of [['POST', '/api/pull'], ['POST', '/api/push'], ['POST', '/api/create'], ['POST', '/api/copy'], ['DELETE', '/api/delete'], ['HEAD', '/api/blobs/sha256:00']]) {
      assert.equal((await fetch(`${ia}${c}`, { method: m, headers: { 'content-type': 'application/json' }, body: m === 'HEAD' ? undefined : '{"model":"qwen3:8b","name":"qwen3:8b"}' })).status, 403, `${m} ${c}`);
    }
    // Débit par service : au-delà, 429 ; les autres services n'en souffrent pas.
    const limites = hub.iaServices.limites;
    hub.iaServices.limites = { minute: 2, jour: 1000 };
    try {
      const appel = () => fetch(`${ia}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen3:8b', stream: false, messages: [{ role: 'user', content: 'x' }] }) });
      const codes = []; for (let i = 0; i < 3; i++) codes.push((await appel()).status);
      assert.deepEqual(codes, [200, 200, 429]);
    } finally { hub.iaServices.limites = limites; }
    // Un jeton faux, ou celui d'un service inconnu : refusé.
    assert.equal((await fetch(`http://127.0.0.1:${port}/ia/${jeton.slice(0, -1)}${jeton.endsWith('0') ? '1' : '0'}/api/tags`)).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/ia/${hub.iaServices.jeton('inconnu')}/api/tags`)).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/tags`)).status, 404);
    // Fournisseur llm.chat de ce service : la passerelle, et son lien IA le dit.
    const p = hub.services.fournisseurPour('llm.chat', hub.services.get(syn.id));
    assert.match(p.url, /^http:\/\/hub:8101\/ia\/ias_synapse_/);
    assert.ok(hub.iaServices.utilise(hub.services.get(syn.id)));
    await hub.capabilities.refleterIA(hub.services.get(syn.id));
    const lien = (await api('GET', '/api/workflows')).find(w => w.autoKey === `ia:${syn.id}`);
    assert.match(lien.name, /→ IA du Hub/);
    // Les listes de modèles d'un service (champ « modèle ») viennent de la passerelle.
    const opts = await hub.runtime.options(null, { key: 'MODELE', optionsFrom: { from: { capability: 'llm.chat' }, method: 'GET', path: '/api/tags', select: '$.models', map: { value: '$.name', label: '$.name' } } });
    assert.ok(opts.some(o => o.value === 'claude-code/sonnet') && opts.some(o => o.value === 'qwen3:8b'), JSON.stringify(opts));
  } finally {
    hub.iaServices.outilsPermis.delete(syn.name);
    hub.iaServices.oublier(syn.id);
    await hub.capabilities.refleterIA(hub.services.get(syn.id));
    hub.iaServices.fermer();
    await api('DELETE', `/api/ai/${cc}`);
    if (oll) await api('DELETE', `/api/ai/${oll}`);
    await api('DELETE', '/api/secrets/claude-code').catch(() => {});
  }
});

test('clés & API : dévoiler une valeur demande une vérification faite exprès, jamais par jeton ni par l’assistant', async () => {
  await api('POST', '/api/secrets', { nom: 'Outil Cache', champs: { API_KEY: 'sk_valeur_tres_secrete' }, site: '' });
  const s = (await api('GET', '/api/secrets')).services.find(x => x.service === 'Outil Cache');
  const cle = s.champs[0].key;
  let r = await admin.get(`/api/secrets/valeur/${cle}`);
  assert.equal(r.status, 403, 'la session seule ne suffit pas');
  assert.equal(r.json.details.devoiler, true);
  assert.deepEqual(r.json.details.methodes, ['cle'], 'une clé d’accès enregistrée : c’est elle qui dévoile');
  const o = await admin.post('/api/compte/devoiler/options');
  assert.equal((await admin.post('/api/compte/devoiler', { methode: 'cle', reponse: cleAdmin.signer(o.json, admin.origine) })).status, 200);
  r = await admin.get(`/api/secrets/valeur/${cle}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.valeur, 'sk_valeur_tres_secrete');
  assert.ok((await api('GET', '/api/audit?limit=20')).some(e => e.action === 'secret.dévoilé'), 'au journal');
  // Un jeton d'accès, même administrateur, n'y a pas droit ; l'assistant non plus.
  const j = await api('POST', '/api/jetons', { nom: 'lecteur', portee: 'assistant' });
  if (j?.jeton) {
    const rj = await fetch(`${base}/api/secrets/valeur/${cle}`, { headers: { authorization: `Bearer ${j.jeton}` } });
    assert.equal(rj.status, 403);
  }
  const v = hub.accesHub.verifier({ action: `GET /api/secrets/valeur/${cle}` });
  assert.match(v.problemes.join(' '), /personne/);
  await api('DELETE', `/api/secrets/${encodeURIComponent('Outil Cache')}`);
});

test('agent IA : l’erreur du dernier passage est lue, renommer ne touche pas au graphe, test_workflow relance et rapporte', async () => {
  const graphe = status => ({ nodes: [{ id: 't', type: 'trigger.manual', name: 'Départ', params: {} }, { id: 's', type: 'logic.stop', name: 'Fin', params: { status, message: 'la cible ne répond pas' } }], edges: [{ from: 't', to: 's' }] });
  const w = (await api('POST', '/api/workflows', { name: 'Essai échec', graph: graphe('error') })).workflow || (await api('GET', '/api/workflows')).find(x => x.name === 'Essai échec');
  await api('POST', `/api/workflows/${w.id}/run`, {});
  await waitFor(async () => (await api('GET', '/api/workflows')).find(x => x.id === w.id).lastStatus === 'error');

  // Le modèle reçoit l'erreur et le graphe du workflow en échec.
  const avant = fake.state.chats.length;
  fake.state.planQueue = [{ reply: 'Je corrige, je renomme et je relance.', steps: [
    { tool: 'update_workflow', args: { workflow: 'Essai échec', graph: graphe('success') } },
    { tool: 'update_workflow', args: { workflow: 'Essai échec', name: 'Essai qui passe' } },
    { tool: 'test_workflow', args: { workflow: 'Essai qui passe' } },
  ] }];
  const p = await api('POST', '/api/agent/ask', { text: 'réessaie le workflow en échec' });
  const envoye = JSON.stringify(fake.state.chats.slice(avant));
  assert.match(envoye, /derniereErreur/);
  assert.match(envoye, /la cible ne répond pas/);
  assert.deepEqual(p.steps.map(s => s.problems), [[], [], []]);
  assert.equal(p.steps[1].label, 'Renommer « Essai échec » en « Essai qui passe »');

  const r = await api('POST', `/api/agent/${p.id}/execute`);
  assert.equal(r.status, 'done', JSON.stringify(r.results));
  assert.equal(r.results[2].result.note, 'réussi');
  const apres = (await api('GET', '/api/workflows')).find(x => x.id === w.id);
  assert.equal(apres.name, 'Essai qui passe');
  assert.equal(apres.lastStatus, 'success', 'le dernier passage n’est plus en échec');
  assert.equal(apres.graph.nodes[1].params.status, 'success', 'le renommage n’a pas écrasé la correction');

  // Un échec se rapporte comme un échec, avec son message.
  fake.state.planQueue = [{ reply: 'ok', steps: [
    { tool: 'update_workflow', args: { workflow: 'Essai qui passe', graph: graphe('error') } },
    { tool: 'test_workflow', args: { workflow: 'Essai qui passe' } },
  ] }];
  const p2 = await api('POST', '/api/agent/ask', { text: 'casse-le' });
  const r2 = await api('POST', `/api/agent/${p2.id}/execute`);
  assert.match(r2.results[1].error, /la cible ne répond pas/);
  // Le modèle voit ce que fait chaque workflow ; un « v2 » ou un nom inchangé ne passent pas.
  fake.state.planQueue = [{ reply: 'ok', steps: [
    { tool: 'update_workflow', args: { workflow: 'Essai qui passe', name: 'Essai qui passe (v2)' } },
    { tool: 'update_workflow', args: { workflow: 'Essai qui passe', name: 'Essai qui passe' } },
  ] }, { reply: 'rien', steps: [] }];
  const av = fake.state.chats.length;
  const p3 = await api('POST', '/api/agent/ask', { text: 'renomme' });
  assert.match(JSON.stringify(fake.state.chats[av]), /trigger\.manual → logic\.stop/, 'le résumé « fait » est envoyé');
  if (p3.steps.length === 2) {
    assert.match(p3.steps[0].problems.join(' '), /v2/);
    assert.equal(p3.steps[1].deja, 'déjà ce nom');
  }
  await api('DELETE', `/api/workflows/${w.id}`);
});

test('agent IA : réglages d’un service — choix vérifié, clé laissée à l’utilisateur', async () => {
  const syn = (await api('GET', '/api/instances')).find(i => i.extId === 'synapse');
  fake.state.planQueue = [{ reply: 'Je passe SYNAPSE sur Kimi.', steps: [{ tool: 'set_service_config', args: { instance: syn.id, config: { LLM_FOURNISSEUR: 'kimi', LLM_CLE: 'sk-invente' } } }] }];
  const av = fake.state.chats.length;
  const p = await api('POST', '/api/agent/ask', { text: 'passe synapse sur kimi' });
  assert.match(JSON.stringify(fake.state.chats[av]), /LLM_FOURNISSEUR/, 'le modèle voit les réglages du service');
  assert.deepEqual(p.steps[0].problems, []);
  assert.deepEqual(p.steps[0].args.config, { LLM_FOURNISSEUR: 'kimi' }, 'jamais une clé écrite par le modèle');
  assert.match(p.steps[0].label, /à remplir par toi.*Clé d'API/);
  fake.state.planQueue = [{ reply: 'x', steps: [{ tool: 'set_service_config', args: { instance: syn.name, config: { LLM_FOURNISSEUR: 'mistral' } } }] }, { reply: 'rien', steps: [] }];
  const p2 = await api('POST', '/api/agent/ask', { text: 'mistral' });
  if (p2.steps.length) assert.match(p2.steps[0].problems.join(' '), /pas un choix possible/);
});

test('agent IA : « passe synapse sur mon IA locale qwen3:8b » — vérifié chez Ollama, fait par le Hub, lien renommé', async () => {
  const syn = (await api('GET', '/api/instances')).find(i => i.extId === 'synapse');
  const av = fake.state.chats.length;
  const p = await api('POST', '/api/agent/ask', { text: 'passe synapse sur mon ia locale qwen3:8b' });
  assert.equal(fake.state.chats.length, av, 'aucun appel au modèle de langage');
  assert.match(p.reply, /\*\*qwen3:8b\*\* est bien installé sur \*\*ollama-gpu-pc\*\*/);
  assert.equal(p.steps[0].tool, 'connecter_ia');
  assert.deepEqual(p.steps[0].problems, []);
  const fait = await executer(p);
  assert.equal(fait.status, 'done', JSON.stringify(fait.results));
  assert.equal((await api('GET', `/api/instances/${syn.id}`)).config.LLM_MODELE, 'qwen3:8b');
  await waitFor(async () => (await api('GET', '/api/workflows')).find(w => w.autoKey === `ia:${syn.id}` && w.name === 'synapse → IA locale qwen3:8b'));
  // Un modèle absent : la liste, rien d'autre.
  const p2 = await api('POST', '/api/agent/ask', { text: 'passe synapse sur mon ia locale llama3:70b' });
  assert.equal(p2.steps.length, 0);
  assert.match(p2.reply, /pas de modèle « llama3:70b »[\s\S]*- qwen3:8b/);
  // « Tu veux que je lise… ? » sans rien lire : le Hub lit à sa place et le modèle répond avec.
  fake.state.planQueue = [{ reply: 'Plan proposé : LIRE le service synapse. Tu veux que je lise synapse ?', steps: [] }, { reply: 'SYNAPSE répond avec qwen3:8b.', steps: [] }];
  const av2 = fake.state.chats.length;
  const p3 = await api('POST', '/api/agent/ask', { text: 'quel modèle utilise synapse en ce moment' });
  assert.equal(fake.state.chats.length, av2 + 2);
  assert.match(JSON.stringify(fake.state.chats[av2 + 1]), /lectures/);
  assert.equal(p3.reply, 'SYNAPSE répond avec qwen3:8b.');
});

test('assistant : tout ce que fait l’interface, par les mêmes routes — sauf identifiants, secrets et gestes humains', async () => {
  const renforcer = async () => {
    const o = await admin.post('/api/compte/renfort/options');
    await admin.post('/api/compte/renfort', { methode: 'cle', reponse: cleAdmin.signer(o.json, admin.origine) });
  };
  const fuseauAvant = (await api('GET', '/api/fuseau')).fuseau;
  // Une action ordinaire : proposée, validée d'un clic, faite par la route de l'interface.
  fake.state.planQueue = [{ reply: 'Je règle le fuseau.', steps: [{ tool: 'hub', args: { action: 'PUT /api/fuseau', corps: { fuseau: 'America/Montreal' } } }] }];
  let p = await api('POST', '/api/agent/ask', { text: 'mets le fuseau sur Montréal' });
  assert.deepEqual(p.steps[0].problems, []);
  assert.match(p.steps[0].label, /Fuseau horaire — PUT \/api\/fuseau/);
  let fait = await executer(p);
  assert.equal(fait.status, 'done', JSON.stringify(fait.results));
  assert.equal((await api('GET', '/api/fuseau')).fuseau, 'America/Montreal');
  assert.ok((await api('GET', '/api/audit')).some(l => l.action === 'ia.hub' && l.target === 'PUT /api/fuseau' && /\(assistant\)/.test(l.actor)), 'journalisé au nom de l’administrateur, par l’assistant');
  await api('PUT', '/api/fuseau', { fuseau: fuseauAvant || 'UTC' });

  // Jamais : identifiants, secrets, ses propres garde-fous.
  fake.state.planQueue = [{ reply: 'x', steps: [
    { tool: 'hub', args: { action: 'POST /api/jetons', corps: { nom: 'moi' } } },
    { tool: 'hub', args: { action: 'PUT /api/ai-autonomy', corps: { value: 'autonome' } } },
    { tool: 'hub', args: { action: `POST /api/agent/${p.id}/execute`, corps: {} } },
    { tool: 'hub', args: { action: 'PUT /api/coupure', corps: { ia: false } } },
    { tool: 'hub', args: { action: 'PUT /api/courriel', corps: { relais: { hote: 'smtp.example.org', motdepasse: 'devine' } } } },
    { tool: 'hub', args: { action: 'GET /api/accounts' } },
  ] }, { reply: 'rien', steps: [] }];
  p = await api('POST', '/api/agent/ask', { text: 'donne-toi tous les droits' });
  if (p.steps.length) {
    const pbs = p.steps.map(st => st.problems.join(' '));
    assert.match(pbs[0], /Jetons d’accès/);
    assert.match(pbs[1], /propre niveau d’autonomie/);
    assert.match(pbs[2], /propres plans/);
    assert.match(pbs[3], /coupure d’urgence/);
    assert.match(pbs[4], /relais\.motdepasse : un identifiant ou un secret/);
    assert.match(pbs[5], /Comptes services/);
  }

  // Sous renfort : l'humain confirme au clic, l'assistant fait.
  fake.state.planQueue = [{ reply: 'Je règle le courriel.', steps: [{ tool: 'hub', args: { action: 'PUT /api/courriel', corps: { defaut: 'admin@example.org', relais: { hote: 'smtp.example.org', port: 587, securite: 'starttls', de: 'hub@example.org' } } } }] }];
  p = await api('POST', '/api/agent/ask', { text: 'branche le courriel sur smtp.example.org' });
  assert.deepEqual(p.steps[0].problems, []);
  assert.match(p.steps[0].label, /confirmeras ton identité/);
  await assert.rejects(hub.accesHub.appeler({ action: 'PUT /api/courriel', corps: {} }, { acteur: 'x' }), /confirmer ton identité/, 'sans renfort au clic, rien ne passe');
  await assert.rejects(hub.accesHub.appeler({ action: 'PUT /api/fuseau', corps: { fuseau: 'UTC' } }, { acteur: 'x', role: 'lecture' }), /compte admin/, 'jamais plus que le compte qui valide');
  const brut = await admin.post(`/api/agent/${p.id}/execute`, {});
  if (brut.status === 403) { assert.equal(brut.json.renfort, true, 'le renfort est demandé à l’humain'); await renforcer(); fait = await api('POST', `/api/agent/${p.id}/execute`); }
  else fait = brut.json;
  assert.equal(fait.status, 'done', JSON.stringify(fait.results));
  assert.equal((await api('GET', '/api/courriel')).relais.hote, 'smtp.example.org');

  // Toute connexion devient un lien visible, avec la route qui la change.
  const lien = await waitFor(async () => (await api('GET', '/api/workflows')).find(w => w.autoKey === 'courriel:hub'));
  assert.equal(lien.name, 'Courriel des comptes → smtp.example.org');
  const iaHub = (await api('GET', '/api/workflows')).find(w => String(w.autoKey).startsWith('hubia:'));
  assert.match(iaHub.name, /^IA du Hub « gpu-pc » → qwen3:8b$/);
  await api('PUT', '/api/courriel', { relais: { hote: '' } }).catch(() => renforcer().then(() => api('PUT', '/api/courriel', { relais: { hote: '' } })));
  await waitFor(async () => !(await api('GET', '/api/workflows')).some(w => w.autoKey === 'courriel:hub'));

  // Lire n'importe quelle page du Hub, sans identifiant.
  fake.state.planQueue = [{ reply: '', steps: [], lire: [{ quoi: 'hub', action: 'GET /api/courriel' }] }, { reply: 'Lu.', steps: [] }];
  const av = fake.state.chats.length;
  await api('POST', '/api/agent/ask', { text: 'où en est le courriel ?' });
  const lu = JSON.stringify(fake.state.chats[av + 1]);
  assert.match(lu, /lectures[\s\S]*GET \/api\/courriel/);
});

test('installation : la liste des modèles vient d’Ollama avant même que le service existe', async () => {
  // Un manifeste dont le modèle se choisit dans la liste d'Ollama, comme Oracle ou MapMyLAN.
  const m = JSON.parse(fs.readFileSync(path.join(FIX, 'synapse.hub.json'), 'utf8'));
  m.id = 'essai-modeles'; m.name = 'Essai modèles';
  m.config = [...m.config, { key: 'MODELE_LOCAL', label: 'Modèle local', type: 'select', optionsFrom: { from: { capability: 'llm.chat' }, method: 'GET', path: '/api/tags', select: '$.models', map: { value: '$.name', label: '$.name' }, exclude: ['embed'] } }];
  await api('POST', '/api/catalog/import', { manifest: m });
  // Le corps exact de la page (0.9.11 et avant) : kind et ref inclus — c'est lui qui était refusé.
  for (const corps of [{ key: 'MODELE_LOCAL' }, { kind: 'config', ref: null, key: 'MODELE_LOCAL' }]) {
    const l = await api('POST', '/api/catalog/essai-modeles/options', corps);
    assert.deepEqual(l.map(o => o.value), ['qwen3:8b'], JSON.stringify(corps));
  }
});

test('Clés & API : plusieurs comptes nommés par service, et les IA prennent leur clé ici', async () => {
  await api('POST', '/api/secrets', { service: 'telegram', champs: { BOT_TOKEN: '1:a', CHAT_ID: '-1' } });
  const r2 = await api('POST', '/api/secrets', { service: 'telegram', compte: 'Alertes', champs: { BOT_TOKEN: '2:b', CHAT_ID: '-2' } });
  assert.deepEqual(r2.clés.sort(), ['TELEGRAM_ALERTES_BOT_TOKEN', 'TELEGRAM_ALERTES_CHAT_ID']);
  let d = await api('GET', '/api/secrets');
  const tg = d.services.filter(x => x.base === 'telegram');
  assert.deepEqual(tg.map(x => x.compte).sort(), ['', 'Alertes']);
  assert.ok(d.categories.includes('IA') && d.catalogue.some(c => c.id === 'kimi' && c.ia === 'kimi'));
  // Modifier le compte nommé garde son nom et ses clés.
  await api('POST', '/api/secrets', { service: 'telegram:alertes', champs: { CHAT_ID: '-3' } });
  d = await api('GET', '/api/secrets');
  assert.equal(d.services.find(x => x.service === 'telegram:alertes').champs.length, 2);
  await api('DELETE', '/api/secrets/telegram%3Aalertes');
  d = await api('GET', '/api/secrets');
  assert.deepEqual(d.services.filter(x => x.base === 'telegram').map(x => x.service), ['telegram'], 'seul le compte visé est oublié');

  // Une IA prend sa clé dans Clés & API ; les modèles se listent avant d'enregistrer.
  await api('POST', '/api/secrets', { service: 'kimi', champs: { API_KEY: 'sk-kimi-test' } });
  const url = fake.base + '/compat';
  assert.deepEqual(await api('POST', '/api/ai/modeles', { kind: 'kimi', url, cleRef: 'KIMI_API_KEY' }), ['kimi-k2', 'moonshot-v1-8k']);
  await assert.rejects(api('POST', '/api/ai/modeles', { kind: 'kimi', url, apiKey: 'mauvaise' }), /Invalid Authentication/);
  await assert.rejects(api('POST', '/api/ai/modeles', { kind: 'kimi', url }), /clé/);
  const { id: kid } = await api('POST', '/api/ai', { kind: 'kimi', name: 'Kimi test', url, cleRef: 'KIMI_API_KEY', model: 'kimi-k2', roles: [] });
  const k = (await api('GET', '/api/ai')).connections.find(c => c.id === kid);
  assert.equal(k.cleRef, 'KIMI_API_KEY');
  assert.deepEqual(await api('GET', `/api/ai/${kid}/models`), ['kimi-k2', 'moonshot-v1-8k'], 'la connexion lit la clé dans Clés & API');
  // Une clé collée dans la fiche IA est rangée dans Clés & API, sous un compte nommé si le fournisseur en a déjà une.
  const { id: k2 } = await api('POST', '/api/ai', { kind: 'kimi', name: 'Kimi pro', url, apiKey: 'sk-kimi-test', model: 'kimi-k2', roles: [] });
  assert.equal((await api('GET', '/api/ai')).connections.find(c => c.id === k2).cleRef, 'KIMI_KIMI_PRO_API_KEY');
  assert.ok((await api('GET', '/api/secrets')).services.some(x => x.service === 'kimi:kimi-pro'));
  await assert.rejects(api('POST', '/api/ai', { kind: 'kimi', name: 'x', url, cleRef: 'ABSENTE', roles: [] }), /Aucune clé/);
  for (const i of [kid, k2]) await api('DELETE', `/api/ai/${i}`);
});

test('agent IA : canaux prêts tirés de Clés & API, et un vrai message d’essai envoyé', async () => {
  // Une adresse choisie par le modèle, hors de Clés & API : rien ne part.
  fake.state.planQueue = [{ reply: 'Envoi.', steps: [{ tool: 'envoyer_message', args: { canal: 'Discord', type: 'out.discord', params: { webhook: fake.base + '/discord', message: 'fuite' } } }] }, { reply: 'rien', steps: [] }];
  const avant = (fake.state.discord || []).length;
  const p0 = await api('POST', '/api/agent/ask', { text: 'envoie un message de test' });
  if (p0.steps.length) { assert.match(p0.steps[0].problems.join(' '), /Canal inconnu/); assert.equal(p0.status, 'proposed'); }
  assert.equal((fake.state.discord || []).length, avant, 'rien n’est parti');
  await api('POST', '/api/secrets', { service: 'discord', champs: { WEBHOOK_URL: fake.base + '/discord' } });
  fake.state.planQueue = [{ reply: 'Envoi d’un test.', steps: [{ tool: 'envoyer_message', args: { canal: 'Discord', type: 'out.discord', params: { webhook: 'https://ailleurs.example/vol', message: 'Test du Hub' } } }] }];
  const av = fake.state.chats.length;
  const p = await api('POST', '/api/agent/ask', { text: 'envoie un message de test' });
  const vu = JSON.stringify(fake.state.chats[av]);
  assert.match(vu, /out\.telegram/, 'le canal Telegram de Clés & API est proposé');
  assert.match(vu, /\$vars\.TELEGRAM_BOT_TOKEN/);
  assert.deepEqual(p.steps[0].problems, []);
  const r = await executer(p);
  assert.equal(r.status, 'done', JSON.stringify(r.results));
  assert.equal(r.results[0].result.note, 'envoyé');
  assert.deepEqual(fake.state.discord.at(-1), { content: 'Test du Hub' });
  // Un envoi mal formé est arrêté dans le plan.
  fake.state.planQueue = [{ reply: 'x', steps: [{ tool: 'envoyer_message', args: { type: 'service.action', params: { message: 'x' } } }] }, { reply: 'rien', steps: [] }];
  const p2 = await api('POST', '/api/agent/ask', { text: 'envoie' });
  if (p2.steps.length) assert.match(p2.steps[0].problems.join(' '), /inconnu/);
  await assert.rejects(api('POST', '/api/secrets/telegram/chats', { token: 'pas-un-jeton' }), /mal formé/);
});

test('agent IA : il lit ce qui lui manque avant de répondre, compte juste, et en autonome fait seul ce qui se défait', async () => {
  const ol = (await api('GET', '/api/instances')).find(i => i.extId === 'ollama');
  fake.state.planQueue = [
    { reply: '', steps: [], lire: [{ quoi: 'cles' }, { quoi: 'service', nom: ol.name }, { quoi: 'action', instance: ol.name, action: 'chat', params: {} }, { quoi: 'journal', n: 3 }] },
    { reply: 'Deux comptes.', steps: [] },
  ];
  const av = fake.state.chats.length;
  const p = await api('POST', '/api/agent/ask', { text: 'combien de clés ?' });
  assert.equal(p.reply, 'Deux comptes.');
  const premier = JSON.stringify(fake.state.chats[av]);
  assert.match(premier, /services_en_ligne/, 'les comptes faits par le Hub sont envoyés');
  assert.match(premier, /Telegram/);
  const second = JSON.stringify(fake.state.chats[av + 1]);
  assert.match(second, /lectures/);
  assert.match(second, /TELEGRAM_BOT_TOKEN/, 'les clés lues');
  assert.match(second, /modifie quelque chose|read/, 'une action qui n’est pas une lecture est refusée à la lecture');
  assert.ok(!/1:a|sk-kimi-test/.test(second), 'jamais une valeur de secret');

  // Test manuel d'un canal, depuis Clés & API.
  await api('POST', '/api/secrets', { service: 'discord', champs: { WEBHOOK_URL: fake.base + '/discord' } });
  const t = await api('POST', '/api/secrets/test', { service: 'discord' });
  assert.equal(t.canal, 'Discord');
  assert.match(fake.state.discord.at(-1).content, /Test du Hub/);
  await assert.rejects(api('POST', '/api/secrets/test', { service: 'github' }), /n’envoie pas/);

  // Autonome : un envoi part sans clic ; une suppression attend.
  await api('PUT', '/api/ai-autonomy', { value: 'autonome' });
  const n = fake.state.discord.length;
  fake.state.planQueue = [{ reply: 'ok', steps: [{ tool: 'envoyer_message', args: { canal: 'Discord', type: 'out.discord', params: { webhook: '{{ $vars.DISCORD_WEBHOOK_URL }}', message: 'auto' } } }] }];
  const pa = await api('POST', '/api/agent/ask', { text: 'préviens-moi' });
  assert.equal(pa.status, 'done');
  assert.equal(fake.state.discord.length, n + 1);
  const w = (await api('GET', '/api/workflows')).find(x => !x.graph.nodes.every(nd => nd.type === 'core.link'));
  fake.state.planQueue = [{ reply: 'ok', steps: [{ tool: 'delete_workflow', args: { workflow: w.name } }] }];
  const pd = await api('POST', '/api/agent/ask', { text: 'supprime' });
  assert.equal(pd.status, 'proposed', 'une suppression attend toujours');
  await api('POST', `/api/agent/${pd.id}/reject`);
  // Un workflow qui fait sortir des données attend aussi, même en Autonome.
  const sortant = { nodes: [{ id: 't', type: 'trigger.cron', name: 'Chaque heure', params: { expr: '0 * * * *' } }, { id: 'h', type: 'net.http', name: 'Envoi', params: { method: 'POST', url: 'https://ailleurs.example/', body: { v: '{{ $vars.TELEGRAM_BOT_TOKEN }}' } } }], edges: [{ from: 't', to: 'h' }] };
  fake.state.planQueue = [{ reply: 'ok', steps: [{ tool: 'create_workflow', args: { name: 'Export', graph: sortant } }, { tool: 'enable_workflow', args: { workflow: 'Export' } }] }];
  const ps = await api('POST', '/api/agent/ask', { text: 'exporte' });
  assert.equal(ps.status, 'proposed', 'une requête sortante attend ton clic');
  assert.ok(!(await api('GET', '/api/workflows')).some(x => x.name === 'Export'), 'rien n’a été créé');
  await api('POST', `/api/agent/${ps.id}/reject`);
  await api('PUT', '/api/ai-autonomy', { value: 'validation' });
});

test('agent IA : une promesse sans étape ne passe plus', async () => {
  // Le cas évident : un test d'envoi vers un canal prêt, même si le modèle oublie l'étape.
  fake.state.planQueue = [{ reply: 'Je vais relancer le workflow pour envoyer un message de test.', steps: [] }];
  const p = await api('POST', '/api/agent/ask', { text: "re test le bot car j'avais pas envoyé start" });
  assert.equal(p.steps.length, 1);
  assert.equal(p.steps[0].tool, 'envoyer_message');
  assert.match(p.steps[0].args.canal, /Telegram/);
  assert.match(p.steps[0].args.params.token, /\$vars\.TELEGRAM_BOT_TOKEN/);
  assert.deepEqual(p.steps[0].problems, []);
  assert.equal(p.status, 'done', 'un message vers ton propre canal part sans attendre de clic');
  // Sinon : repris une fois, puis signalé.
  fake.state.planQueue = [{ reply: 'Je vais configurer SYNAPSE.', steps: [] }, { reply: 'Je vais configurer SYNAPSE.', steps: [] }];
  const p2 = await api('POST', '/api/agent/ask', { text: 'configure synapse' });
  assert.equal(p2.steps.length, 0);
  assert.match(p2.reply, /^Aucune action proposée : rien n'a été fait/);
  // Une vraie réponse sans action reste telle quelle.
  fake.state.planQueue = [{ reply: 'Il y a 1 compte Telegram.', steps: [] }];
  assert.equal((await api('POST', '/api/agent/ask', { text: 'combien de clés ?' })).reply, 'Il y a 1 compte Telegram.');
});

test('heure lisible dans le fuseau de l’utilisateur, et nom de canal lisible', async () => {
  await assert.rejects(api('PUT', '/api/fuseau', { fuseau: 'Pas/UnFuseau' }), /Fuseau inconnu/);
  assert.equal((await api('PUT', '/api/fuseau', { fuseau: 'Asia/Tokyo' })).fuseau, 'Asia/Tokyo');
  fake.state.planQueue = [{ reply: 'ok', steps: [{ tool: 'envoyer_message', args: { canal: 'discord', type: 'out.discord', params: { webhook: '{{ $vars.DISCORD_WEBHOOK_URL }}', message: 'Il est {{ $maintenant }}' } } }] }];
  const p = await api('POST', '/api/agent/ask', { text: "donne l'heure sur discord" });
  assert.match(p.steps[0].label, /^Envoyer via Discord :/, 'pas l’identifiant brut du compte');
  await executer(p);
  const recu = fake.state.discord.at(-1).content;
  const tokyo = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', hourCycle: 'h23' }).format(new Date());
  assert.match(recu, /^Il est \d\d\/\d\d\/\d{4} \d\d:\d\d$/);
  assert.equal(recu.split(' ').pop().split(':')[0], tokyo, 'l’heure est celle du fuseau choisi, pas celle du serveur');
  fake.state.planQueue = [{ reply: 'ok', steps: [{ tool: 'envoyer_message', args: { canal: 'Discord', type: 'out.discord', params: { webhook: '{{ $vars.DISCORD_WEBHOOK_URL }}', message: '{{ $heure }}|{{ $date }}' } } }] }];
  const p2 = await api('POST', '/api/agent/ask', { text: "l'heure sur discord" });
  await executer(p2);
  assert.match(fake.state.discord.at(-1).content, /^\d\d:\d\d\|\d\d\/\d\d\/\d{4}$/, 'l’heure seule, la date seule');
});

test('Telegram : envoyer une question, écouter la réponse, et l’assistant la reçoit', async () => {
  await api('POST', '/api/secrets', { service: 'telegram', compte: 'Test Hub', champs: { BOT_TOKEN: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ', CHAT_ID: '4242' } });
  fake.state.tg = { updates: [{ update_id: 100, message: { chat: { id: 4242 }, text: 'ancien message' } }], sent: [], id: 100, repondre: 'Ça va très bien' };
  // Le modèle envoie mais oublie d'écouter : le Hub ajoute l'écoute, puisqu'on la lui a demandée.
  fake.state.planQueue = [
    { reply: 'Je te demande comment tu vas.', steps: [{ tool: 'envoyer_message', args: { canal: 'Telegram (Test Hub)', type: 'out.telegram', params: { token: '{{ $vars.TELEGRAM_TEST_HUB_BOT_TOKEN }}', chat: '{{ $vars.TELEGRAM_TEST_HUB_CHAT_ID }}', message: 'Comment vas-tu ?' } } }] },
    { reply: 'Content que tu ailles bien !', steps: [] },
  ];
  const p = await api('POST', '/api/agent/ask', { text: 'envoie un message sur test hub pour me demander comment je vais et écoute ma réponse' });
  assert.deepEqual(p.steps.map(s => s.tool), ['envoyer_message', 'attendre_reponse']);
  assert.match(p.steps[1].label, /Écouter ta réponse sur Telegram \(Test Hub\)/);
  const r = await executer(p);
  assert.equal(r.status, 'done', JSON.stringify(r.results));
  assert.match(r.results[1].result.note, /en écoute/);
  assert.equal(fake.state.tg.sent.at(-1).text, 'Comment vas-tu ?');
  assert.ok((await api('GET', '/api/agent/etat')).ecoute, 'l’écoute se voit, même après un changement de page');
  // La réponse arrive : l'assistant la reçoit comme une demande et y répond.
  const hist = await waitFor(async () => { const h = await api('GET', '/api/agent'); return h.find(x => /^📩 Réponse reçue sur Telegram \(Test Hub\) : « Ça va très bien »/.test(x.request)) && h; }, 8000);
  assert.equal(hist.at(-1).reply, 'Content que tu ailles bien !');
  assert.ok(!/ancien message/.test(JSON.stringify(hist)), 'un message d’avant l’écoute ne compte pas');
  assert.equal((await api('GET', '/api/agent/etat')).ecoute, null);
  // Un bouton des alertes pressé pendant une écoute n'est pas perdu : il passe aux alertes.
  const rappels = [];
  const avantRappel = hub.agent.surRappel;
  hub.agent.surRappel = cq => rappels.push(cq.data);
  hub.agent.ecouter('Telegram (Test Hub)', 30, 'ana');
  await new Promise(r => setTimeout(r, 300));
  const id = Math.max(...fake.state.tg.updates.map(u => u.update_id)) + 1;
  fake.state.tg.updates.push({ update_id: id, callback_query: { id: 'q1', data: 'maj:abcdefghijkl', from: { id: 4242 }, message: { message_id: 1, chat: { id: 4242 } } } });
  await waitFor(async () => rappels.length > 0, 5000);
  assert.deepEqual(rappels, ['maj:abcdefghijkl']);
  assert.ok(hub.agent.ecoute, 'un bouton ne met pas fin à l’écoute');
  hub.agent.arreterEcoute();
  hub.agent.surRappel = avantRappel;
  // « Écoute ma réponse » seul : le canal du dernier envoi.
  fake.state.planQueue = [{ reply: 'Je vais écouter.', steps: [] }, { reply: 'Je vais écouter.', steps: [] }];
  const p2 = await api('POST', '/api/agent/ask', { text: 'écoute ma réponse sur telegram' });
  assert.equal(p2.steps[0]?.tool, 'attendre_reponse');
  assert.equal(p2.status, 'done', 'écouter part tout de suite');
  assert.ok((await api('GET', '/api/agent/etat')).ecoute);
  assert.deepEqual(await api('POST', '/api/agent/ecoute/stop', {}), { arrete: true });
});

test('Telegram : une conversation de plusieurs échanges, tenue par le Hub', async () => {
  fake.state.tg = { updates: [], sent: [], id: 500, repondre: ['Salut !', 'Tu fais quoi ?', 'stop', 'trop tard'] };
  // Le modèle envoie un message et « lance une boucle »… sans écouter : le Hub ouvre la vraie conversation.
  fake.state.planQueue = [{ reply: 'Je lance une boucle de 5 échanges.', steps: [{ tool: 'envoyer_message', args: { canal: 'Telegram (Test Hub)', type: 'out.telegram', params: { message: '👋 Prêt à discuter.' } } }] }];
  const p = await api('POST', '/api/agent/ask', { text: "Connecte ce chat au bot Test Hub pour qu'on puisse discuter sur 5 message d'affilé via telegram" });
  assert.deepEqual(p.steps.map(s => s.tool), ['converser']);
  assert.equal(p.steps[0].args.tours, 5);
  assert.equal(p.status, 'done', 'part tout de suite, comme un message');
  assert.match(p.results[0].result.note, /conversation ouverte : 5 échanges/);
  assert.equal(fake.state.tg.sent[0].text, '👋 Prêt à discuter.');
  assert.deepEqual((await api('GET', '/api/agent/etat')).ecoute.conversation, { tour: 0, total: 5 });
  // Deux réponses, deux réponses du Hub, puis « stop » ferme la conversation.
  const fini = await waitFor(async () => fake.state.tg.sent.some(m => /Fin de la conversation/.test(m.text)) && fake.state.tg.sent, 15000);
  assert.deepEqual(vrais(fini).map(m => m.text), ['👋 Prêt à discuter.', 'Reçu : Salut !', 'Reçu : Tu fais quoi ?', '👋 Fin de la conversation.']);
  const hist = await api('GET', '/api/agent');
  const tours = hist.filter(x => x.conversation);
  assert.equal(tours.length, 3);
  assert.match(tours[0].results[0].result.note, /échange 1\/5, j'écoute la suite/);
  assert.equal(tours[1].reply, 'Reçu : Tu fais quoi ?');
  await new Promise(r => setTimeout(r, 400));
  assert.equal((await api('GET', '/api/agent/etat')).ecoute, null, 'après « stop », plus rien n’écoute');
  // Il répond avec l'état du Hub sous les yeux, et ce qu'il annonce, le Hub le fait.
  const avant = fake.state.chats.length, deja = fake.state.tg.sent.length;
  fake.state.tg.repondre = ['Combien de workflows ?', 'Vas-y relance le test', 'stop'];
  fake.state.tg.coupures = 1;           // le premier envoi échoue : il est retenté
  fake.state.tg.coupuresEcoute = 2;     // et l'écoute perd deux fois le réseau : elle reprend, la conversation continue
  fake.state.convQueue = [
    { reply: 'Il y en a 3.', hub: '' },
    { reply: 'Je m’en occupe.', hub: 'Envoie « essai » sur Telegram (Test Hub)' },
  ];
  fake.state.planQueue = [{ reply: 'ok', steps: [] }, { reply: 'Envoyé.', steps: [{ tool: 'envoyer_message', args: { canal: 'Telegram (Test Hub)', params: { message: 'essai' } } }] }];
  const p3 = await api('POST', '/api/agent/ask', { text: 'discutons sur test hub, 3 messages' });
  assert.equal(p3.steps[0].tool, 'converser');
  const envoyes = await waitFor(async () => fake.state.tg.sent.slice(deja).some(m => m.text === '👋 Fin de la conversation.') && fake.state.tg.sent.slice(deja), 20000);
  const bulles = envoyes.filter(m => /^(💭|⚙️)/.test(m.text)).map(m => m.message_id);
  assert.ok(bulles.length >= 2, 'un « 💭 » pendant qu’il réfléchit, un « ⚙️ » pendant qu’il agit');
  await waitFor(async () => bulles.every(id => (fake.state.tg.supprimes || []).includes(id)), 5000);
  assert.deepEqual(vrais(envoyes).map(m => m.text.split('\n')[0]), ['👋 Je t\'écoute ici pour 3 échanges. Écris « stop » pour arrêter.', 'Il y en a 3.', 'Je m’en occupe.', 'essai', '✅ Fait :', '👋 Fin de la conversation.']);
  const sys = fake.state.chats.slice(avant).find(c => c.messages[0].content.includes('tu discutes avec lui sur Telegram')).messages[0].content;
  assert.match(sys, /"workflows":\{"total":\d+,"actifs":\d+/, 'les comptes de la page Workflows sont dans le prompt');
  assert.match(sys, /"nom":"À réparer"/, 'la liste des workflows aussi : rien à « lancer » pour la connaître');
  assert.match(sys, /"en_clair":"\d+ workflows? : \d+ actifs?, \d+ désactivés?, \d+ liens?/, 'les nombres en une phrase à recopier');
  assert.match(sys, /"ia_possibles":\{"fournisseurs":\["Ollama[^\]]*Kimi[^\]]*OpenAI[^\]]*Claude/, 'les IA qu’on peut brancher');
  // Arrêter depuis le Hub ferme aussi la conversation.
  await new Promise(r => setTimeout(r, 400));
  fake.state.tg.repondre = null;
  fake.state.planQueue = [{ reply: 'ok', steps: [{ tool: 'converser', args: { canal: 'telegram', tours: 2 } }] }];
  const p2 = await api('POST', '/api/agent/ask', { text: 'discutons un peu sur test hub, 2 messages' });
  assert.equal(p2.status, 'done');
  assert.match(fake.state.tg.sent.at(-1).text, /2 échanges/);
  assert.deepEqual(await api('POST', '/api/agent/ecoute/stop', {}), { arrete: true });
  assert.equal((await api('GET', '/api/agent/etat')).ecoute, null);
  await waitFor(async () => !(await api('GET', '/api/agent/etat')).encours, 8000);   // rien ne traîne pour le test suivant
});

test('petits modèles : un envoi mal formé est remis d’aplomb par le canal, et le début du prompt reste en cache', async () => {
  fake.state.planQueue = [{ reply: 'ok', steps: [{ tool: 'envoyer_message', args: { canal: 'Telegram (Test Hub)', type: 'text', params: { token: 'inventé', message: 'Il est {{ $heure }}' } } }] }];
  const av = fake.state.chats.length;
  const p = await api('POST', '/api/agent/ask', { text: "envoie-moi l'heure sur Telegram test hub" });
  const st = p.steps[0];
  assert.deepEqual(st.problems, []);
  assert.equal(st.args.type, 'out.telegram');
  assert.match(st.args.params.token, /\$vars\.TELEGRAM_TEST_HUB_BOT_TOKEN/, 'le jeton vient du canal, pas du modèle');
  assert.equal(st.args.params.message, 'Il est {{ $heure }}');
  // Le début du prompt ne dépend pas de la question : Ollama le relit en cache.
  const sys1 = fake.state.chats[av].messages[0];
  fake.state.planQueue = [{ reply: 'ok', steps: [] }];
  const av2 = fake.state.chats.length;
  await api('POST', '/api/agent/ask', { text: 'répare les workflows en échec et installe une extension' });
  const sys2 = fake.state.chats[av2].messages[0];
  assert.equal(sys1.role, 'system');
  assert.match(sys1.content, /<donnees>/, 'les données du Hub sont dans le message système');
  assert.equal(sys1.content, sys2.content, 'identique d’une question à l’autre');
  assert.ok(JSON.stringify(fake.state.chats[av2].messages.at(-1)).length < 3000, 'la question arrive seule, avec sa mémoire');
});

test('deux bots Telegram : il demande lequel au lieu de prendre le premier, et ne limite pas la conversation sans raison', async () => {
  await api('POST', '/api/secrets', { service: 'telegram', compte: 'Chat Hub', champs: { BOT_TOKEN: '654321:ZYXWVUTSRQPONMLKJIHGFEDCBA', CHAT_ID: '4243' } });
  fake.state.tg = { updates: [], sent: [], id: 900 };
  // Le modèle reprend d'office le bot de la fois d'avant : le Hub ne le laisse pas faire.
  fake.state.planQueue = [{ reply: 'ok', steps: [{ tool: 'converser', args: { canal: 'Telegram (Test Hub)', tours: 5 } }] }];
  const q = await api('POST', '/api/agent/ask', { text: 'connecte ce chat au bot Telegram et on parlera via telegram' });
  assert.equal(q.status, 'answered', 'rien ne part tant que le bot n’est pas choisi');
  assert.deepEqual(q.steps, []);
  assert.match(q.reply, /comptes Telegram prêts : .*Lequel/);
  assert.ok(q.reply.includes('Telegram (Chat Hub)') && q.reply.includes('Telegram (Test Hub)'), q.reply);
  assert.equal(fake.state.tg.sent.length, 0);
  // Il conseille, avec des raisons vérifiables : « ce chat » → « Chat Hub », « Test Hub » sent l'essai.
  assert.match(q.reply, /Je te conseille Telegram \(Chat Hub\) : son nom rejoint ta demande \(« chat »\), « Test Hub » ressemble à un compte d'essai/);
  assert.equal(q.choix[0].canal, 'Telegram (Chat Hub)');
  assert.equal(q.choix[0].recommande, true);
  assert.equal(q.relances[0], 'Sur le compte « Telegram (Chat Hub) »', JSON.stringify(q.relances));
  // Une question sur le choix : le modèle a les vraies données, et les boutons restent.
  const av = fake.state.chats.length;
  fake.state.planQueue = [{ reply: 'Chat Hub, pour son nom.', steps: [] }];
  const q2 = await api('POST', '/api/agent/ask', { text: 'tu penses lequel le plus pertinent ?' });
  assert.equal(q2.choix?.length, q.choix.length, 'les boutons de choix restent');
  const envoye = fake.state.chats[av].messages.at(-1).content;
  assert.match(envoye, /choix_de_compte_en_attente/);
  assert.match(fake.state.chats[av].messages[0].content, /"compte":"Chat Hub","pret":true,"workflows":\[\]/, 'aucun workflow ne s’en sert : il le sait');
  // « vas-y » : le conseillé, la demande d'origine repart — et le choix s'impose même si le modèle insiste sur l'autre.
  fake.state.planQueue = [{ reply: 'ok', steps: [{ tool: 'converser', args: { canal: 'Telegram (Test Hub)', tours: 5 } }] }];
  const p = await api('POST', '/api/agent/ask', { text: 'vas-y' });
  assert.equal((await api('GET', '/api/agent')).at(-1).request, 'vas-y', 'on affiche ce qu’il a tapé');
  assert.equal(p.steps[0].tool, 'converser');
  assert.equal(p.steps[0].args.canal, 'Telegram (Chat Hub)');
  assert.equal(p.steps[0].args.tours, null, 'aucun nombre demandé : pas de limite inventée');
  assert.match(p.steps[0].label, /Brancher cette conversation sur Telegram \(Chat Hub\) — jusqu'à « stop »/);
  assert.equal(p.status, 'done');
  assert.equal(fake.state.tg.sent[0].chat_id, '4243', 'le message part sur le bot choisi');
  assert.match(fake.state.tg.sent[0].text, /C'est branché/);
  assert.deepEqual((await api('GET', '/api/agent/etat')).ecoute.conversation, { tour: 0, total: null });
  await api('POST', '/api/agent/ecoute/stop', {});
  // « Retiens » : ce compte devient celui des conversations, sans plus demander…
  fake.state.planQueue = [{ reply: 'Noté.', steps: [] }];
  const r = await api('POST', '/api/agent/ask', { text: 'retiens : pour les conversations Telegram c’est Chat Hub, sauf si je dis un autre' });
  assert.match(r.reply, /Retenu : Telegram \(Chat Hub\) par défaut pour les conversations/);
  fake.state.planQueue = [{ reply: 'ok', steps: [{ tool: 'converser', args: { canal: 'Telegram (Test Hub)' } }] }];
  const c1 = await api('POST', '/api/agent/ask', { text: 'connecte ce chat au bot telegram' });
  assert.equal(c1.steps[0]?.args.canal, 'Telegram (Chat Hub)', 'le défaut, sans question — même si le modèle prend l’autre');
  await api('POST', '/api/agent/ecoute/stop', {});
  // …sauf s'il en nomme un autre.
  fake.state.planQueue = [{ reply: 'ok', steps: [{ tool: 'converser', args: { canal: 'Telegram (Chat Hub)' } }] }];
  const c2 = await api('POST', '/api/agent/ask', { text: 'discute avec moi sur test hub' });
  assert.equal(c2.steps[0]?.args.canal, 'Telegram (Test Hub)');
  await api('POST', '/api/agent/ecoute/stop', {});
  // Un envoi simple n'est pas une conversation : là, il redemande.
  fake.state.planQueue = [{ reply: 'ok', steps: [{ tool: 'envoyer_message', args: { canal: 'Telegram (Test Hub)', params: { message: 'x' } } }] }];
  assert.equal((await api('POST', '/api/agent/ask', { text: 'envoie x sur telegram' })).status, 'answered');
  fake.state.planQueue = [{ reply: 'ok', steps: [] }];
  assert.match((await api('POST', '/api/agent/ask', { text: 'oublie le canal par défaut' })).reply, /C’est oublié/);
  // Nommé d'emblée : pas de question.
  fake.state.planQueue = [{ reply: 'ok', steps: [{ tool: 'envoyer_message', args: { canal: 'Telegram (Test Hub)', params: { message: 'coucou' } } }] }];
  const d = await api('POST', '/api/agent/ask', { text: 'envoie coucou sur chat hub' });
  assert.equal(d.status, 'done');
  assert.equal(fake.state.tg.sent.at(-1).chat_id, '4243');
  await api('DELETE', '/api/secrets/telegram:chat-hub');
});

test('brancher les workflows d’alerte sur un canal : le Hub ajoute l’envoi lui-même, sans ouvrir de conversation', async () => {
  const { workflow } = await api('POST', '/api/workflows', { name: 'Alerte conteneur tombé', graph: {
    nodes: [{ id: 't', type: 'trigger.manual', name: 'Départ', params: {}, x: 100, y: 200 }, { id: 'l', type: 'out.log', name: 'Journal', params: { message: 'x' }, x: 380, y: 200 }],
    edges: [{ from: 't', to: 'l' }] } });
  fake.state.tg = { updates: [], sent: [], id: 1200 };
  // Plusieurs bots, aucun nommé : il demande.
  fake.state.planQueue = [{ reply: 'Je connecte tout.', steps: [{ tool: 'converser', args: { canal: 'Telegram (Test Hub)', tours: 7 } }] }];
  const q = await api('POST', '/api/agent/ask', { text: 'connecte tous les workflows d’alerte pour que ça envoie au bot telegram' });
  assert.equal(q.status, 'answered');
  assert.match(q.reply, /comptes Telegram prêts/);
  assert.equal((await api('GET', '/api/agent/etat')).ecoute, null, 'aucune conversation ouverte');
  // Nommé : le modèle ouvre une conversation à tort, le Hub branche les workflows.
  fake.state.planQueue = [{ reply: 'Je lance une boucle de 7 échanges.', steps: [{ tool: 'converser', args: { canal: 'Telegram (Test Hub)', tours: 7 } }] }];
  const p = await api('POST', '/api/agent/ask', { text: 'Connecte tout les workflow d’alerte pour que sa envoie au bot Telegram test hub' });
  assert.deepEqual(p.steps.map(st => st.tool), ['ajouter_envoi']);
  assert.equal(p.steps[0].args.canal, 'Telegram (Test Hub)');
  assert.ok(p.steps[0].args.cibles.includes('Alerte conteneur tombé'), JSON.stringify(p.steps[0].args.cibles));
  assert.ok(!/boucle|échanges/.test(p.reply), p.reply);
  const r = await executer(p);
  assert.equal(r.status, 'done', JSON.stringify(r.results));
  const g = (await api('GET', `/api/workflows/${workflow.id}`)).graph;
  const envoi = g.nodes.find(n => n.type === 'out.telegram');
  assert.ok(envoi, 'le nœud Telegram est ajouté');
  assert.match(envoi.params.chat, /\$vars\.TELEGRAM_TEST_HUB_CHAT_ID/, 'les clés du compte choisi');
  assert.match(envoi.params.message, /^🔔 Alerte conteneur tombé/);
  assert.ok(g.edges.some(e => e.from === 't' && e.to === envoi.id), 'relié au déclencheur');
  assert.ok(g.nodes.some(n => n.id === 'l'), 'rien d’autre n’est touché');
  // Une deuxième fois : déjà branché, rien n'est doublé.
  fake.state.planQueue = [{ reply: 'ok', steps: [{ tool: 'ajouter_envoi', args: { workflows: ['Alerte conteneur tombé'], canal: 'Telegram (Test Hub)' } }] }];
  const p2 = await api('POST', '/api/agent/ask', { text: 'branche Alerte conteneur tombé sur test hub' });
  assert.equal(p2.steps[0].deja, true);
  assert.match(p2.steps[0].label, /déjà branchés : Alerte conteneur tombé/);
});

test('un workflow mal disposé (sans positions, empilé) est rangé de gauche à droite', async () => {
  const { workflow } = await api('POST', '/api/workflows', { name: 'Sans positions', graph: {
    nodes: [{ id: 'a', type: 'trigger.manual', name: 'Départ', params: {} }, { id: 'b', type: 'out.log', name: 'Un', params: { message: 'x' }, x: 'NaN', y: null },
      { id: 'c', type: 'out.log', name: 'Deux', params: { message: 'y' }, x: 10, y: 10 }],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }] } });
  const g = (await api('GET', `/api/workflows/${workflow.id}`)).graph;
  const pos = Object.fromEntries(g.nodes.map(n => [n.id, [n.x, n.y]]));
  assert.ok(g.nodes.every(n => Number.isFinite(n.x) && Number.isFinite(n.y)), JSON.stringify(pos));
  assert.ok(pos.a[0] < pos.b[0] && pos.b[0] < pos.c[0], 'de gauche à droite, dans l’ordre des liens');
  assert.ok(pos.a[0] >= 340, 'à droite de la palette');
  // Un graphe bien placé n'est pas touché.
  const { workflow: w2 } = await api('POST', '/api/workflows', { name: 'Bien placé', graph: {
    nodes: [{ id: 'a', type: 'trigger.manual', name: 'Départ', params: {}, x: 400, y: 300 }, { id: 'b', type: 'out.log', name: 'Un', params: { message: 'x' }, x: 700, y: 300 }],
    edges: [{ from: 'a', to: 'b' }] } });
  assert.deepEqual((await api('GET', `/api/workflows/${w2.id}`)).graph.nodes.map(n => [n.x, n.y]), [[400, 300], [700, 300]]);
});

test('demande composée : les comptes répondus, les alertes branchées puis la conversation — et un choix de bot ne fait rien perdre', async () => {
  fake.state.tg = { updates: [], sent: [], id: 1500 };
  await api('POST', '/api/secrets', { service: 'telegram', compte: 'Chat Hub', champs: { BOT_TOKEN: '654321:ZYXWVUTSRQPONMLKJIHGFEDCBA', CHAT_ID: '4243' } });
  // Partir sans compte retenu ni dernière conversation (les tests d'avant en ont posé).
  hub.db.setSetting('agent_canaux_defaut', '{}'); hub.db.setSetting('agent_derniere_conv', '{}');
  const demande = "Combien j'ai de workflows et lesquels sont en échec ? Branche tous les workflows d'alerte sur Telegram, puis connecte ce chat au bot pour qu'on en parle là-bas.";
  fake.state.planQueue = [{ reply: 'Je lance la boucle.', steps: [] }];
  const q = await api('POST', '/api/agent/ask', { text: demande });
  assert.match(q.reply, /^\d+ workflows? : \d+ actifs?/, 'le compte d’abord : ' + q.reply);
  assert.match(q.reply, /Lequel j’utilise/);
  assert.ok(!/boucle/.test(q.reply), 'pas de promesse');
  assert.ok(q.relances.includes('Sur le compte « Telegram (Chat Hub) »'), JSON.stringify(q.relances));
  // Le bouton court : la demande entière repart, rien n'est tronqué.
  fake.state.planQueue = ['pas du json du tout', { reply: 'ok', steps: [] }];     // illisible une fois : redemandé
  const p = await api('POST', '/api/agent/ask', { text: 'Sur le compte « Telegram (Chat Hub) »' });
  assert.deepEqual(p.steps.map(st => st.tool), ['ajouter_envoi', 'converser'], JSON.stringify(p.steps.map(s => [s.tool, s.problems])));
  assert.equal(p.steps[0].args.canal, 'Telegram (Chat Hub)');
  assert.equal(p.steps[1].args.canal, 'Telegram (Chat Hub)');
  assert.match(p.reply, /Plan : brancher l'envoi sur Telegram \(Chat Hub\)[\s\S]*Puis c'est branché sur Telegram \(Chat Hub\)/);
  assert.equal(p.status, 'proposed', 'modifier des workflows attend ta validation');
  await api('POST', `/api/agent/${p.id}/reject`, {});
  // « Relance la connexion au bot » : la conversation, sur le même bot — pas une action de service au hasard.
  const ol = (await api('GET', '/api/instances')).find(i => i.ext_id === 'ollama');
  fake.state.planQueue = [{ reply: 'Je relance.', steps: [{ tool: 'run_action', args: { instance: ol?.name || 'ollama', action: 'chat', params: {} } }] }];
  const rl = await api('POST', '/api/agent/ask', { text: 'relance la connexion au bot telegram' });
  assert.deepEqual(rl.steps.map(st => st.tool), ['converser']);
  assert.equal(rl.steps[0].args.canal, 'Telegram (Chat Hub)', 'le bot de la dernière conversation, sans question');
  assert.equal(rl.status, 'done');
  await api('POST', '/api/agent/ecoute/stop', {});
  // Illisible deux fois : une réponse quand même, pas une erreur rouge.
  fake.state.planQueue = ['{"reply": "Voici ce que je sais', 'toujours rien'];
  const z = await api('POST', '/api/agent/ask', { text: 'dis bonjour' });
  assert.equal(z.status, 'answered');
  assert.equal(z.reply, 'Voici ce que je sais');
  await api('DELETE', '/api/secrets/telegram:chat-hub');
});

test('le choix du bot est retenu, la conversation se relance sur le même, sans passer par le modèle', async () => {
  fake.state.tg = { updates: [], sent: [], id: 1800 };
  await api('POST', '/api/secrets', { service: 'telegram', compte: 'Chat Hub', champs: { BOT_TOKEN: '654321:ZYXWVUTSRQPONMLKJIHGFEDCBA', CHAT_ID: '4243' } });
  hub.db.setSetting('agent_canaux_defaut', '{}'); hub.db.setSetting('agent_derniere_conv', '{}');
  const avant = fake.state.chats.length;
  const q = await api('POST', '/api/agent/ask', { text: 'connecte ce chat au bot telegram' });
  assert.equal(q.status, 'answered');
  assert.ok(!/parle-moi/i.test(q.reply), 'rien n’est branché tant qu’il n’a pas choisi : ' + q.reply);
  const p = await api('POST', '/api/agent/ask', { text: 'Sur le compte « Telegram (Chat Hub) »' });
  assert.equal(p.steps[0].args.canal, 'Telegram (Chat Hub)');
  assert.match(p.reply, /Retenu|branché/);
  await api('POST', '/api/agent/ecoute/stop', {});
  // « elance » (faute de frappe comprise) : le même bot, sans question.
  const r = await api('POST', '/api/agent/ask', { text: 'elance la conversation sur telegram' });
  assert.equal(r.status, 'done', r.reply);
  assert.equal(r.steps[0].args.canal, 'Telegram (Chat Hub)');
  // « coupe la conversation » : coupée, tout de suite.
  const c = await api('POST', '/api/agent/ask', { text: 'coupe la conversation' });
  assert.match(c.reply, /Conversation coupée/);
  assert.equal((await api('GET', '/api/agent/etat')).ecoute, null);
  assert.equal(fake.state.chats.slice(avant).filter(x => x.messages[0]?.content?.includes('assistant de configuration')).length, 0, 'aucun appel au modèle pour ça');
  await api('DELETE', '/api/secrets/telegram:chat-hub');
});

test('une réponse qui boucle est dédoublonnée, et la mémoire arrive sans doublons', async () => {
  const ligne = 'Tu veux que je te demande comment tu vas et que j’écoute ta réponse.';
  fake.state.planQueue = [{ reply: `Voici ce que j'ai retenu : - ${Array(30).fill(ligne).join(' - ')} - Tu branches tes alertes sur Chat Hub.`, steps: [] }];
  const r = await api('POST', '/api/agent/ask', { text: 'Qu’as-tu retenu de mes demandes ?' });
  assert.equal(r.reply.split(ligne).length - 1, 1, r.reply);
  assert.match(r.reply, /Chat Hub/);
  const { sansDoublons } = await import('../server/ai/memoire.js');
  assert.deepEqual(sansDoublons([{ texte: 'A b' }, { texte: 'a  B' }, { texte: 'c' }]).map(x => x.texte), ['A b', 'c']);
});

test('widgets : le Hub met les vrais chiffres, le modèle ne choisit que le type', async () => {
  fake.state.planQueue = [{ reply: 'Voilà ton activité.', steps: [], widgets: [{ type: 'activite', jours: 7 }, { type: 'inventé' }, { type: 'stats' }] }];
  const r = await api('POST', '/api/agent/ask', { text: 'montre-moi l’activité de mes workflows et explique pourquoi certains échouent' });
  assert.deepEqual(r.widgets.map(w => w.type), ['activite', 'stats'], 'un type inconnu est ignoré');
  const act = r.widgets[0];
  assert.equal(act.barres.length, 7);
  const vrai = hub.db.get(`SELECT COUNT(*) n FROM executions WHERE started >= ?`, Date.now() - 7 * 86400e3).n;
  assert.equal(act.total, vrai, 'le total vient de la base');
  assert.equal(r.widgets[1].tuiles[0].label, 'Workflows actifs');
  // Sans widget demandé par le modèle, la question les appelle quand même.
  fake.state.planQueue = [{ reply: 'Voici.', steps: [] }];
  const s = await api('POST', '/api/agent/ask', { text: 'état des services et usage de l’IA' });
  assert.deepEqual(s.widgets.map(w => w.type), ['services', 'ia']);
  const { enTexte } = await import('../server/ai/widgets.js');
  assert.match(enTexte(act), /^📊 Exécutions — 7 derniers jours\n✅ \d+ réussies · ❌ \d+ échecs/);
});

test('widgets : pas pour « salut ça va », pas deux fois de suite, sauf si on les redemande', async () => {
  fake.state.planQueue = [{ reply: 'Ça va bien, et toi ?', steps: [], widgets: [{ type: 'stats' }, { type: 'services' }] }];
  const a = await api('POST', '/api/agent/ask', { text: 'salut ça va ?' });
  assert.equal(a.widgets, undefined, 'une salutation n’a pas de widget');
  fake.state.planQueue = [{ reply: 'Voici.', steps: [] }];
  const b = await api('POST', '/api/agent/ask', { text: 'état des services' });
  assert.deepEqual(b.widgets.map(w => w.type), ['services']);
  fake.state.planQueue = [{ reply: 'Toujours pareil.', steps: [], widgets: [{ type: 'services' }] }];
  const c = await api('POST', '/api/agent/ask', { text: 'et l’état des services ?' });
  assert.equal(c.widgets, undefined, 'le même juste après : du texte');
  fake.state.planQueue = [{ reply: 'Mis à jour.', steps: [] }];
  const d = await api('POST', '/api/agent/ask', { text: 'remontre l’état des services' });
  assert.deepEqual(d.widgets.map(w => w.type), ['services'], 'redemandé : il revient');
  fake.state.planQueue = [{ reply: 'Je crée le workflow.', steps: [], widgets: [{ type: 'activite' }] }];
  const e = await api('POST', '/api/agent/ask', { text: 'crée un workflow qui redémarre ollama chaque nuit' });
  assert.equal(e.widgets, undefined, 'une action n’appelle pas de graphique');
});

test('réponses instantanées : l’état des services et un bonjour ne passent pas par le modèle', async () => {
  const avant = fake.state.chats.length;
  const e = await api('POST', '/api/agent/ask', { text: 'Etat des service' });
  assert.deepEqual(e.widgets?.map(w => w.type), ['services'], 'le widget, même écrit sans accent ni s');
  assert.match(e.reply, /services/);
  assert.ok(e.duree < 1500, `répondu en ${e.duree} ms`);
  const s = await api('POST', '/api/agent/ask', { text: 'salut sa va ?' });
  assert.match(s.reply, /^Salut ! Ça va/);
  assert.equal(s.widgets, undefined);
  assert.equal(fake.state.chats.slice(avant).filter(x => x.messages[0]?.content?.includes('assistant de configuration')).length, 0, 'aucun appel au modèle');
});

test('Ollama : tous les appels demandent le même contexte, pour ne jamais recharger le modèle', async () => {
  const { ollamaAligne, CTX_OLLAMA } = await import('../server/runtime.js');
  const c = ollamaAligne('/api/chat', { model: 'qwen3:14b', messages: [], options: { temperature: 0.2 } });
  assert.equal(c.options.num_ctx, CTX_OLLAMA);
  assert.equal(c.options.temperature, 0.2);
  assert.equal(c.keep_alive, '30m');
  assert.equal(ollamaAligne('/api/chat', { model: 'x', options: { num_ctx: 4096 } }).options.num_ctx, 4096, 'un contexte choisi est respecté');
  assert.deepEqual(ollamaAligne('/api/embed', { model: 'nomic', input: 'a' }), { model: 'nomic', input: 'a' }, 'les vecteurs ne sont pas touchés');
});

test('mode vocal : VOX entend et parle, le cerveau reste celui du Hub', async () => {
  const sans = await api('GET', '/api/voix');
  assert.equal(sans.disponible, false, 'sans service vocal, pas de mode vocal');
  assert.deepEqual(sans.installer, { extId: 'vox', nom: 'VOX', mode: 'compose' }, 'VOX est au catalogue local : le panneau propose de l’installer');
  assert.match(sans.raison, /pas encore installé/);
  const vox = await api('POST', '/api/instances', { extId: 'vox', mode: 'remote', url: fake.base, config: { HUB_TOKEN: 'jeton-vox-123' } });
  assert.ok(vox.id);
  const etat = await api('GET', '/api/voix');
  assert.equal(etat.disponible, true, JSON.stringify(etat));
  const brut = async (p, corps, type) => { const r = await admin.req('POST', p, undefined, { brut: corps, entetes: { 'content-type': type } }); return { json: async () => r.json, headers: { get: k => r.entetes[k.toLowerCase()] }, arrayBuffer: async () => Buffer.from(r.texte) }; };
  // Entendre : l'audio part chez VOX avec le jeton du Hub, le texte revient.
  const r = await (await brut('/api/voix/transcrire', Buffer.from('RIFF....WAVEfmt état des services'), 'audio/wav')).json();
  assert.deepEqual({ texte: r.texte, arret: r.arret }, { texte: 'état des services', arret: false });
  assert.equal(fake.state.vox.at(-1).auth, 'Bearer jeton-vox-123');
  const s = await (await brut('/api/voix/transcrire', Buffer.from('RIFF STOP'), 'audio/wav')).json();
  assert.equal(s.arret, true, '« stop » ferme le mode vocal');
  // Parler : la voix revient en binaire.
  const d = await brut('/api/voix/dire', JSON.stringify({ text: 'Tes services sont en ligne.' }), 'application/json');
  assert.equal(d.headers.get('content-type'), 'audio/wav');
  assert.equal(Buffer.from(await d.arrayBuffer()).toString(), 'RIFF:Tes services sont en ligne.');
  // Une question vocale : la réponse porte ce qui se DIT, sans markdown.
  const q = await api('POST', '/api/agent/ask', { text: 'état des services', voix: true });
  assert.equal(q.voix, true);
  assert.ok(q.parole && !/\*\*/.test(q.parole), q.parole);
  assert.deepEqual(q.widgets?.map(w => w.type), ['services']);
  const h = (await api('GET', '/api/agent')).at(-1);
  assert.equal(h.voix, true); assert.equal(h.parole, q.parole);
  // Clés & API → ElevenLabs : la clé part chez VOX avant de parler, une seule fois.
  await api('POST', '/api/secrets', { service: 'elevenlabs', champs: { API_KEY: 'sk_eleven_test_0123456789abcdef', VOICE_ID: 'voixDeTest1234' } }); // valeur d’essai — gitleaks:allow
  assert.equal((await api('GET', '/api/voix')).voixCloud, 'ElevenLabs');
  // Le lien VOX ← ElevenLabs apparaît dans Workflows, comme les autres liens entre services.
  const lien = await waitFor(async () => (await api('GET', '/api/workflows')).find(w => /utilise la voix ElevenLabs/.test(w.name)));
  assert.equal(lien.origin, 'Auto');
  assert.ok(lien.graph.nodes.every(n => n.type === 'core.link'));
  await brut('/api/voix/dire', JSON.stringify({ text: 'Un.' }), 'application/json');
  await brut('/api/voix/dire', JSON.stringify({ text: 'Deux.' }), 'application/json');
  assert.equal(fake.state.voxCle.length, 1, 'poussée une fois par valeur');
  assert.deepEqual({ ...fake.state.voxCle[0] }, { auth: 'Bearer jeton-vox-123', eleven: 'sk_eleven_test_0123456789abcdef', voice: 'eleven:voixDeTest1234' });
  // L'identifiant de la clé collé à sa place : refusé à l'enregistrement, en clair.
  await assert.rejects(api('POST', '/api/secrets', { service: 'elevenlabs', champs: { API_KEY: 'PK4x2m9QeR7tYb1nZc8vLw3s' } }), /identifiant, pas la clé/); // valeur d’essai — gitleaks:allow
  // Un copier-coller bavard (code d'exemple, espaces, caractère invisible) : la clé est retrouvée dedans.
  const lv2 = await api('POST', '/api/secrets/elevenlabs/voix', { token: ' apiKey: "sk_eleven_test_\u200b0123456789abcdef",\n' });
  assert.equal(lv2.voix.length, 1);
  await assert.rejects(api('POST', '/api/secrets/elevenlabs/voix', { token: 'PK4x2m9QeR7tYb1nZc8vLw3s' }), /24 caractères, commence par « PK… »/); // valeur d’essai — gitleaks:allow
  // « Connecte VOX à ElevenLabs » : ce n'est pas une extension, le Hub dit où en est le lien, sans modèle.
  const chats = fake.state.chats.length;
  const c = await api('POST', '/api/agent/ask', { text: 'connecte voxai a eleven labs merci bien' });
  assert.equal(fake.state.chats.length, chats, 'sans modèle');
  assert.match(c.reply, /parle avec ElevenLabs.*Le lien « .* utilise la voix ElevenLabs » est dans Workflows.*a déjà la clé et la voix/s, c.reply);
  // Un compte nommé (« Voix VoxAI ») vaut le compte sans nom.
  await api('DELETE', '/api/secrets/elevenlabs');
  await waitFor(async () => !(await api('GET', '/api/workflows')).some(w => /utilise la voix ElevenLabs/.test(w.name)));
  const sansCle = await api('POST', '/api/agent/ask', { text: 'connecte vox à elevenlabs' });
  assert.match(sansCle.reply, /pas une extension : c’est une clé/);
  await api('POST', '/api/secrets', { service: 'elevenlabs', compte: 'Voix VoxAI', champs: { API_KEY: 'sk_compte_nomme_0123456789ab' } }); // valeur d’essai — gitleaks:allow
  assert.equal((await api('GET', '/api/voix')).voixCloud, 'ElevenLabs');
  const nomme = await api('POST', '/api/agent/ask', { text: 'connecte vox à elevenlabs' });
  assert.match(nomme.reply, /compte « Voix VoxAI »/);
  assert.ok((await api('GET', '/api/workflows')).some(w => /utilise la voix ElevenLabs/.test(w.name)));
  assert.equal(fake.state.voxCle.at(-1).eleven, 'sk_compte_nomme_0123456789ab');
  for (const e of (await api('GET', '/api/secrets')).services?.filter(x => x.base === 'elevenlabs') || []) await api('DELETE', `/api/secrets/${encodeURIComponent(e.service)}`);
  const { aDire } = await import('../server/voix.js');
  assert.equal(aDire('Voici :\n- **ollama** en ligne\n- mapmylan en ligne ✅'), 'Voici : ollama en ligne. mapmylan en ligne.');
  await api('DELETE', `/api/instances/${vox.id}`);
});

test('champs riches : les mots et la voix entrent dans le Compose sans pouvoir le casser', async () => {
  const { normaliserChamp } = await import('../server/services.js');
  assert.equal(normaliserChamp({ type: 'tags' }, ' Proxmox, ollama,Ollama,, Home  Assistant, a: b, #x, \'q, Lab-2 '), 'Proxmox,ollama,Home Assistant,Lab-2');
  assert.equal(normaliserChamp({ type: 'tags' }, ['VOX', 'SYNAPSE']), 'VOX,SYNAPSE');
  assert.equal(normaliserChamp({ type: 'voice', label: 'Voix' }, 'eleven:voixDeTest1234'), 'eleven:voixDeTest1234');
  assert.throws(() => normaliserChamp({ type: 'voice', label: 'Voix' }, 'x\n  privileged: true'), /voix invalide/);
  const vox = (await api('GET', '/api/catalog')).items.find(i => i.id === 'vox').manifest;
  const f = k => vox.config.find(c => c.key === k);
  assert.equal(f('STT_MOTS_CLES').type, 'tags');
  assert.equal(f('TTS_VOICE').type, 'voice');
  assert.ok(f('TTS_VOICE').options.every(o => o.group && o.detail), 'chaque voix a sa rubrique et sa description');
});

test('ElevenLabs : au catalogue de Clés & API, un nœud Voix qui s’envoie en vocal sur Telegram', async () => {
  const d = await api('GET', '/api/secrets');
  const el = d.catalogue.find(c => c.id === 'elevenlabs');
  assert.equal(el?.categorie, 'Voix');
  assert.deepEqual(el.champs.map(c => [c.key, c.secret]), [['API_KEY', true], ['VOICE_ID', false], ['MODEL', false]]);
  await api('POST', '/api/secrets', { service: 'elevenlabs', champs: { API_KEY: 'sk_eleven_test_0123456789abcdef', VOICE_ID: 'voixDeTest1234' } }); // valeur d’essai — gitleaks:allow
  const lv = await api('POST', '/api/secrets/elevenlabs/voix', {});
  assert.deepEqual(lv.voix, [{ id: 'voixDeTest1234', nom: 'Léa', genre: 'Femme', detail: 'fr', apercu: true }], 'les voix du compte, identifiants douteux écartés, adresse d’extrait gardée côté Hub');
  assert.ok(!JSON.stringify(lv).includes('googleapis'), 'l’adresse de l’extrait ne descend pas au navigateur');
  await assert.rejects(api('GET', '/api/secrets/elevenlabs/apercu/inconnue123'), /Extrait inconnu/);
  await assert.rejects(api('POST', '/api/secrets/elevenlabs/voix', { token: 'sk_fausse_cle_00000000000' }), /refuse la clé/);
  const pal = await api('GET', '/api/palette');
  assert.ok(JSON.stringify(pal).includes('ai.elevenlabs'), 'le nœud est dans la palette');
  const graph = {
    nodes: [
      { id: 't', type: 'trigger.manual', name: 'Départ', params: { sample: { text: 'Deux alertes cette nuit.' } } },
      { id: 'v', type: 'ai.elevenlabs', name: 'Voix', params: {} },
      { id: 'tg', type: 'out.telegram', name: 'Vocal', params: { token: 'abc', chat: '42', audio: '{{ $json.audio }}' } },
    ],
    edges: [{ from: 't', to: 'v' }, { from: 'v', to: 'tg' }],
  };
  const { workflow, problems } = await api('POST', '/api/workflows', { name: 'Alerte vocale', graph });
  assert.deepEqual(problems, []);
  const run = await api('POST', `/api/workflows/${workflow.id}/run`, {});
  const ex = await waitFor(async () => { const e = await api('GET', `/api/executions/${run.id}`); return e.status !== 'running' && e; });
  assert.equal(ex.status, 'success', ex.error || JSON.stringify(ex.state?.nodes));
  const appel = fake.state.eleven.at(-1);
  assert.deepEqual([appel.voix, appel.text, appel.model_id], ['voixDeTest1234', 'Deux alertes cette nuit.', 'eleven_flash_v2_5'], 'clé et voix prises dans Clés & API');
  const sortie = ex.state.nodes.v.output;
  assert.match(sortie.audio, /^son:/, 'une référence, pas du base64 dans l’historique');
  assert.ok(!JSON.stringify(ex.state).includes('sk_eleven_test'), 'la clé ne finit pas dans l’historique');
  const envoi = fake.state.tg.audio.at(-1);
  assert.match(envoi.brut, /ID3:Deux alertes cette nuit\./);
  assert.match(envoi.brut, /name="caption"\r\n\r\nDeux alertes cette nuit\./, 'la phrase dite sert de légende');
  // Une mauvaise clé : une erreur lisible, pas un HTTP brut.
  await api('POST', '/api/secrets', { service: 'elevenlabs', champs: { API_KEY: 'sk_mauvaise_cle_000000000' } });
  const r2 = await api('POST', `/api/workflows/${workflow.id}/run`, {});
  const ex2 = await waitFor(async () => { const e = await api('GET', `/api/executions/${r2.id}`); return e.status !== 'running' && e; });
  assert.equal(ex2.status, 'error');
  assert.match(JSON.stringify(ex2), /ElevenLabs : clé refusée \(401\)/);
  await api('DELETE', `/api/workflows/${workflow.id}`);
  await api('DELETE', '/api/secrets/elevenlabs');
});

test('mises à jour : une version plus récente au catalogue se voit, se reprend, et l’actualisation automatique ne martèle pas', async () => {
  const { compareVersions, renderCompose, composeVars } = await import('../server/services.js');
  assert.equal(compareVersions('1.10.0', '1.9.2'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0-beta'), 1);
  assert.equal(compareVersions('1.1', '1.1.0'), 0);
  assert.equal(compareVersions('0.9.9', '1.0.0'), -1);

  const syn = await api('POST', '/api/instances', { extId: 'docker-control', mode: 'remote', url: fake.base, name: 'dc-maj', config: { REMOTE_TOKEN: 'jeton-dc-456' } });
  assert.equal((await api('GET', '/api/instances')).find(i => i.id === syn.id).miseAJour, null);
  const fichier = path.join(reg, 'm/docker-control.json');
  const avant = fs.readFileSync(fichier, 'utf8');
  const neuf = JSON.parse(avant); neuf.version = '99.0.0';
  fs.writeFileSync(fichier, JSON.stringify(neuf));
  try {
    // « Lance les mises à jour dispo » : l'assistant relit le catalogue lui-même — sans le modèle — et propose chacune.
    const av = fake.state.chats.length;
    const p = await api('POST', '/api/agent/ask', { text: 'lance les mises à jour dispo sur le hub' });
    assert.equal(fake.state.chats.length, av, 'pas de modèle : il inventait des versions');
    assert.match(p.reply, /\*\*dc-maj\*\* 5\.0\.0 → 99\.0\.0/);
    const etape = p.steps.find(st => st.args.action === `POST /api/instances/${syn.id}/update`);
    assert.equal(etape.label, 'Mettre dc-maj à jour : 5.0.0 → 99.0.0');
    assert.deepEqual(etape.problems, []);
    const vue = (await api('GET', '/api/instances')).find(i => i.id === syn.id);
    assert.equal(vue.miseAJour, '99.0.0', 'le catalogue propose plus récent');
    // Un service distant : la mise à jour reprend le manifeste — validée d'un clic.
    const fait = await executer({ ...p, steps: p.steps });
    assert.ok(fait.results.find(r => r.step === p.steps.indexOf(etape)).ok, JSON.stringify(fait.results));
    const apres = (await api('GET', '/api/instances')).find(i => i.id === syn.id);
    assert.deepEqual([apres.version, apres.miseAJour], ['99.0.0', null]);
  } finally {
    fs.writeFileSync(fichier, avant);
    await api('DELETE', `/api/instances/${syn.id}`);
  }
  // Auto : une actualisation récente n'en déclenche pas une autre.
  await api('POST', '/api/catalog/refresh', {});
  const auto = await api('POST', '/api/catalog/refresh', { auto: true });
  assert.equal(auto.recent, true);

  // Une capacité seulement acceptée et absente : ses variables valent vide.
  const m = { install: { ports: [], volumes: [] }, capabilities: { accepts: ['voice.stt'], requires: [] }, config: [] };
  const vars = composeVars({ name: 'x', url: 'http://x', stack: 3 }, m, {}, () => null);
  assert.equal(renderCompose('A: "{{provider.voice.stt.hostUrl}}|{{provider.voice.stt.config.HUB_TOKEN}}"', vars), 'A: "|"');
  // Présente : l'adresse vue de la machine (port publié) et ses réglages.
  const vars2 = composeVars({ name: 'x', url: 'http://x', stack: 3 }, m, {}, () => ({ url: 'http://vox:8160', hostUrl: 'http://127.0.0.1:8140', name: 'vox', config: { HUB_TOKEN: 'j' } }));
  assert.equal(renderCompose('A: "{{provider.voice.stt.hostUrl}}|{{provider.voice.stt.config.HUB_TOKEN}}"', vars2), 'A: "http://127.0.0.1:8140|j"');
});

test('dossiers : créer, ranger à la main ou par l’assistant, renommer, supprimer sans rien perdre', async () => {
  const wfs = await api('GET', '/api/workflows');
  assert.ok(wfs.length >= 2);
  await api('POST', '/api/workflows/dossiers', { chemin: 'Essais /  Vides ' });
  assert.ok((await api('GET', '/api/workflows/dossiers')).dossiers.includes('Essais / Vides'), 'un dossier vide existe, normalisé');
  await assert.rejects(api('POST', '/api/workflows/dossiers', { chemin: 'a/b/c/d' }), /Trois niveaux/);
  await assert.rejects(api('POST', '/api/workflows/dossiers', { chemin: '<script>' }), /invalide/);

  const [a, b] = wfs;
  const r = await api('POST', '/api/workflows/ranger', { affectations: [{ id: a.id, dossier: 'Essais / Un' }, { workflow: b.name, dossier: 'Essais' }] });
  assert.equal(r.deplaces.length, 2);
  const apres = await api('GET', '/api/workflows');
  assert.equal(apres.find(w => w.id === a.id).dossier, 'Essais / Un');
  assert.equal(apres.find(w => w.id === a.id).enabled, a.enabled, 'ranger ne touche pas à l’activation');

  await api('PATCH', '/api/workflows/dossiers', { de: 'Essais', vers: 'Labo' });
  const ren = await api('GET', '/api/workflows');
  assert.equal(ren.find(w => w.id === a.id).dossier, 'Labo / Un', 'les sous-dossiers suivent');
  assert.ok((await api('GET', '/api/workflows/dossiers')).dossiers.includes('Labo / Vides'));
  await api('POST', '/api/workflows/dossiers/supprimer', { chemin: 'Labo / Un' });
  assert.equal((await api('GET', '/api/workflows')).find(w => w.id === a.id).dossier, 'Labo', 'supprimer un dossier remonte ses workflows d’un niveau');
  await api('POST', '/api/workflows/dossiers/supprimer', { chemin: 'Labo' });
  assert.ok((await api('GET', '/api/workflows')).every(w => !w.dossier.startsWith('Labo')));

  // « Range mes workflows » : une proposition calculée, par service puis par rôle, à valider.
  const avant = fake.state.chats.length;
  const p = await api('POST', '/api/agent/ask', { text: 'Range mes workflows' });
  assert.equal(fake.state.chats.length, avant, 'sans modèle');
  assert.equal(p.steps[0].tool, 'ranger_workflows');
  assert.match(p.reply, /Rien ne bouge avant que tu valides/);
  const ex = await executer(p);
  assert.equal(ex.status, 'done', JSON.stringify(ex.results));
  const ranges = await api('GET', '/api/workflows');
  assert.ok(ranges.every(w => / \/ (Alertes|Défense|Surveillance|Automatisation|Liens)$/.test(w.dossier)), ranges.map(w => `${w.name} → ${w.dossier}`).join('\n'));
  const encore = await api('POST', '/api/agent/ask', { text: 'Range mes workflows' });
  assert.match(encore.reply, /Tout est déjà rangé/);
  // « Re-range au cas où » : sans le mot « workflows », sans modèle, et un compte rendu si rien ne bouge.
  const verif = await api('POST', '/api/agent/ask', { text: "re range au cas ou mais j'aime bien comment c'est vérifie au cas ou" });
  assert.equal(fake.state.chats.length, avant, 'toujours sans modèle');
  assert.match(verif.reply, new RegExp(`Vérifié : les ${ranges.length} workflows sont déjà à leur place`));
  await api('POST', '/api/workflows/ranger', { affectations: ranges.map(w => ({ id: w.id, dossier: '' })) });
});


test('jetons d’accès : l’assistant et rien d’autre, sans jamais rien exécuter', async () => {
  const porteur = (jeton, method, p, body) => fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jeton}` }, body: body === undefined ? undefined : JSON.stringify(body) })
    .then(async r => ({ status: r.status, j: await r.json().catch(() => null) }));
  const { jeton, id } = await api('POST', '/api/jetons', { nom: 'creuset', portee: 'assistant' });
  assert.match(jeton, /^hubj_[\w-]{40,}$/);
  const liste = (await api('GET', '/api/jetons')).jetons;
  assert.equal(liste[0].nom, 'creuset');
  assert.ok(!JSON.stringify(liste).includes(jeton.slice(12)), 'seule l’empreinte est gardée');
  await assert.rejects(api('POST', '/api/jetons', { nom: 'creuset', portee: 'assistant' }), /existe déjà/);
  await assert.rejects(api('POST', '/api/jetons', { nom: 'x', portee: 'admin' }), /Portée inconnue/);

  // Il pose des questions, sans cookie ni CSRF.
  assert.equal((await porteur(jeton, 'POST', '/api/agent/nouvelle', {})).status, 200);
  const q = await porteur(jeton, 'POST', '/api/agent/ask', { text: 'état des services' });
  assert.equal(q.status, 200); assert.equal(q.j.model, 'Hub');
  // Rien d'autre : ni les services, ni les réglages, ni l'exécution d'un plan, ni ses propres jetons.
  for (const [m, p] of [['GET', '/api/instances'], ['GET', '/api/secrets'], ['GET', '/api/jetons'], ['PUT', '/api/ai-autonomy']]) assert.equal((await porteur(jeton, m, p, m === 'GET' ? undefined : {})).status, 403, `${m} ${p}`);
  // Même en Autonome, un plan demandé par un jeton attend : il n'est jamais exécuté.
  await api('PUT', '/api/ai-autonomy', { value: 'autonome' });
  const w = await api('POST', '/api/workflows', { name: 'Essai jeton', graph: { nodes: [{ id: 't', type: 'trigger.manual', name: 'Départ', params: {} }], edges: [] } });
  const plan = (await porteur(jeton, 'POST', '/api/agent/ask', { text: 're-range tous les workflows' })).j;
  assert.equal(plan.steps?.[0]?.tool, 'ranger_workflows');
  assert.equal(plan.status, 'proposed', 'le plan attend, même en mode Autonome');
  assert.equal((await porteur(jeton, 'POST', `/api/agent/${plan.id}/execute`, {})).status, 403);
  assert.equal((await porteur(jeton, 'POST', `/api/agent/${plan.id}/reject`, {})).status, 200);
  assert.equal((await api('GET', '/api/workflows')).find(x => x.id === w.workflow.id).dossier, '', 'rien n’a bougé');
  await api('PUT', '/api/ai-autonomy', { value: 'validation' });
  await api('DELETE', `/api/workflows/${w.workflow.id}`);

  // Faux, ou révoqué : refusé.
  assert.equal((await porteur('hubj_' + 'x'.repeat(43), 'POST', '/api/agent/ask', { text: 'salut' })).status, 401);
  await api('DELETE', `/api/jetons/${id}`);
  assert.equal((await porteur(jeton, 'POST', '/api/agent/ask', { text: 'salut' })).status, 401);
});

test('destinations internes : refusées tant qu’un administrateur ne les a pas autorisées, métadonnées jamais', async () => {
  const srv = http.createServer((req, res) => res.end('{"ok":true}'));
  await new Promise(r => srv.listen(0, '127.0.0.2', r));
  const graphe = url => ({ nodes: [{ id: 't', type: 'trigger.manual', name: 'Départ', params: {} }, { id: 'h', type: 'net.http', name: 'Requête', params: { url } }], edges: [{ from: 't', to: 'h' }] });
  const { workflow } = await api('POST', '/api/workflows', { name: 'Vers le réseau', graph: graphe(`http://127.0.0.2:${srv.address().port}/`) });
  const lancer = async () => {
    const run = await api('POST', `/api/workflows/${workflow.id}/run`, {});
    return waitFor(async () => { const e = await api('GET', `/api/executions/${run.id}`); return e.status !== 'running' && e; });
  };
  try {
    let ex = await lancer();
    assert.equal(ex.status, 'error');
    assert.match(ex.error, /destination interne non autorisée : 127\.0\.0\.2/);
    await assert.rejects(api('PUT', '/api/destinations', { destinations: ['169.254.0.0/16'] }), /seules les adresses privées/);
    await assert.rejects(api('PUT', '/api/destinations', { destinations: ['10.0.0.0/4'] }), /trop large/);
    assert.deepEqual((await api('PUT', '/api/destinations', { destinations: ['127.0.0.2', ' 127.0.0.2 '] })).destinations, ['127.0.0.2']);
    const d = await api('GET', '/api/destinations');
    assert.ok(d.automatiques.some(a => a.origine === 'service' && a.hote === '127.0.0.1'), 'un service connecté est autorisé de lui-même');
    ex = await lancer();
    assert.equal(ex.status, 'success', ex.error);
    await api('PUT', `/api/workflows/${workflow.id}`, { graph: graphe('http://169.254.169.254/latest/meta-data/') });
    ex = await lancer();
    assert.match(ex.error, /toujours refusée/);
    assert.ok((await api('GET', '/api/audit')).some(l => l.action === 'destinations.modifiées'));
  } finally {
    srv.close();
    await api('PUT', '/api/destinations', { destinations: [] });
    await api('DELETE', `/api/workflows/${workflow.id}`);
  }
});

test('autorisation : chaque route balayée sans session, en lecture seule et en membre', async () => {
  const inviter = async (identifiant, role) => {
    let r = await admin.post('/api/compte/admin/comptes', { identifiant, role });
    if (r.status === 403) {
      const o = await admin.post('/api/compte/renfort/options');
      await admin.post('/api/compte/renfort', { methode: 'cle', reponse: cleAdmin.signer(o.json, admin.origine) });
      r = await admin.post('/api/compte/admin/comptes', { identifiant, role });
    }
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const c = new Client(admin.port);
    const jeton = r.json.lien.split('#invitation=')[1];
    assert.equal((await c.post('/api/compte/jeton', { usage: 'invitation', jeton, motDePasse: `${identifiant} a une phrase bien à lui` })).status, 200);
    const t = await c.post('/api/compte/totp');
    assert.equal((await c.post('/api/compte/totp/confirmer', { code: codeTotp(t.json.secret) })).json.niveau, 'complet');
    return c;
  };
  const membre = await inviter('bruno', 'membre'), lecteur = await inviter('chloe', 'lecture'), anonyme = new Client(admin.port);
  const ecarts = [];
  const cheminDe = r => r.re.source.replace(/^\^|\$$/g, '').replace(/\\\//g, '/').replace(/\(\[\^\/\]\+\)/g, 'x');
  let balayees = 0;
  for (const r of hub.router.routes) {
    const o = r.options || {};
    if (o.public) continue;
    balayees++;
    const chemin = cheminDe(r);
    const lecture = ['GET', 'HEAD'].includes(r.methode);
    const attendus = [['anonyme', anonyme, 401], ['lecture', lecteur, lecture && o.role !== 'admin' ? null : 403], ['membre', membre, o.role === 'admin' ? 403 : null]];
    for (const [nom, c, attendu] of attendus) {
      if (attendu === null) continue;
      const s = (await c.req(r.methode, chemin, lecture || r.methode === 'DELETE' ? undefined : {})).status;
      if (s !== attendu) ecarts.push(`${nom} ${r.methode} ${chemin} → ${s} (attendu ${attendu})`);
    }
  }
  assert.deepEqual(ecarts, []);
  assert.ok(balayees > 90, `${balayees} routes balayées`);
  // La politique elle-même, écrite ici plutôt que relue dans le routeur : une
  // route d'administration relâchée par erreur fait échouer cet essai.
  const ADMIN = [
    'GET /api/accounts',
    'POST /api/accounts/x/stepup',
    'POST /api/accounts/x/lock',
    'GET /api/accounts/x',
    'POST /api/accounts/x',
    'PATCH /api/accounts/x/x',
    'POST /api/accounts/x/x/password',
    'POST /api/accounts/x/x/reset',
    'POST /api/accounts/x/x/mfa',
    'DELETE /api/accounts/x/x',
    'POST /api/catalog/refresh',
    'PUT /api/catalog/sources',
    'PUT /api/catalog/registres/auto',
    'POST /api/catalog/depots/adapter',
    'POST /api/catalog/import',
    'PUT /api/exposition',
    'PUT /api/theme',
    'POST /api/instances',
    'PATCH /api/instances/x',
    'PUT /api/instances/x/ia',
    'POST /api/instances/x/manifest',
    'POST /api/instances/x/autos',
    'POST /api/instances/x/update',
    'POST /api/instances/x/redeploy',
    'DELETE /api/instances/x',
    'GET /api/instances/x/logs',
    'POST /api/catalog/x/test-remote',
    'POST /api/ai',
    'PUT /api/ai/x',
    'DELETE /api/ai/x',
    'GET /api/ai/outils',
    'GET /api/ai/outils/x/connexion',
    'POST /api/ai/outils/x/connexion',
    'POST /api/ai/outils/x/connexion/code',
    'POST /api/ai/order',
    'POST /api/ai/modeles',
    'GET /api/destinations',
    'PUT /api/destinations',
    'PUT /api/coupure',
    'GET /api/courriel',
    'PUT /api/courriel',
    'PUT /api/connexions/domaines',
    'GET /api/alertes',
    'PUT /api/alertes',
    'POST /api/alertes/essai',
    'PUT /api/connexions/cloudflare',
    'DELETE /api/connexions/cloudflare',
    'POST /api/connexions/routes',
    'PATCH /api/connexions/routes/x',
    'DELETE /api/connexions/routes/x',
    'PUT /api/connexions/services/x',
    'DELETE /api/connexions/services/x',
    'PUT /api/connexions/hub',
    'DELETE /api/connexions/hub',
    'POST /api/connexions/appliquer',
    'GET /api/connexions/tunnel',
    'PUT /api/connexions/tunnel',
    'DELETE /api/connexions/tunnel',
    'POST /api/connexions/tunnel/tout',
    'PUT /api/fuseau',
    'PUT /api/ai-autonomy',
    'POST /api/agent/ecoute/stop',
    'POST /api/agent/x/execute',
    'GET /api/jetons',
    'POST /api/jetons',
    'DELETE /api/jetons/x',
    'GET /api/secrets',
    'GET /api/secrets/valeur/x',
    'GET /api/secrets/logo/x',
    'POST /api/secrets/test',
    'POST /api/secrets/telegram/chats',
    'POST /api/secrets/elevenlabs/voix',
    'GET /api/secrets/elevenlabs/apercu/x',
    'POST /api/secrets',
    'DELETE /api/secrets/x',
    'PUT /api/variables/x',
    'DELETE /api/variables/x',
    'GET /api/audit',
    'GET /api/audit/verify',
  ];
  assert.deepEqual(hub.router.routes.filter(r => r.options?.role === 'admin').map(r => `${r.methode} ${cheminDe(r)}`).sort(), [...ADMIN].sort());
  assert.deepEqual((await lecteur.get('/api/overview')).json.recent, [], 'le journal ne passe pas par la vue d’ensemble');
  // Mesures : lisibles en lecture seule, sauf le détail du Hub lui-même ; période bornée.
  const tm = Date.now() - 600e3;
  hub.db.run("INSERT OR REPLACE INTO mesures_groupes (t, groupe, rx, tx, cpu, mem) VALUES (?, 'Hub', 10, 10, 1, 1), (?, 'vigie', 100, 50, 2, 2)", tm, tm);
  const vueLecteur = (await lecteur.get('/api/overview')).json;
  assert.ok(Array.isArray(vueLecteur.aTraiter));
  assert.deepEqual(vueLecteur.mesures.top.map(g => g.nom), ['vigie']);
  assert.deepEqual((await api('GET', '/api/mesures?periode=7j')).top.map(g => g.nom), ['vigie', 'Hub']);
  assert.equal((await lecteur.get('/api/mesures?periode=1an')).status, 400);
  // Le flux d'événements : les lignes du journal pour l'administrateur, pas pour la lecture seule.
  const ecouter = client => new Promise(resolve => {
    let recu = '';
    const req = http.get({ host: '127.0.0.1', port: admin.port, path: '/api/events', headers: { host: `localhost:${admin.port}`, cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } }, res => {
      res.on('data', c => { recu += c; });
      setTimeout(() => { req.destroy(); resolve(recu); }, 600);
    });
  });
  const flux = [ecouter(lecteur), ecouter(admin)];
  await new Promise(r => setTimeout(r, 150));
  hub.audit.write('essai', 'essai.flux');
  const [vuLecteur, vuAdmin] = await Promise.all(flux);
  assert.match(vuAdmin, /event: audit/);
  assert.doesNotMatch(vuLecteur, /event: audit/);
  assert.ok((await api('GET', '/api/overview')).recent.length > 0);
  // Une action destructive d'un service : administrateurs seulement, même confirmée.
  const dc = (await api('GET', '/api/instances')).find(i => i.extId === 'docker-control')
    || await api('POST', '/api/instances', { extId: 'docker-control', mode: 'remote', url: fake.base, name: 'dc-droits', config: { REMOTE_TOKEN: 'jeton-dc-droits' } });
  const rm = await membre.post(`/api/instances/${dc.id}/actions/container.remove`, { params: { id: 'x' }, confirm: true });
  assert.equal(rm.status, 403);
  assert.match(rm.json.error, /réservée aux administrateurs/);
  // Un membre ne fait partir aucun message sans le clic d'un administrateur.
  fake.state.planQueue = [{ reply: 'ok', steps: [{ tool: 'envoyer_message', args: { canal: 'Discord', type: 'out.discord', params: { message: 'depuis un membre' } } }] }];
  const avantD = (fake.state.discord || []).length;
  const pm = await membre.post('/api/agent/ask', { text: 'préviens-moi sur discord' });
  assert.equal(pm.json.status, 'proposed');
  assert.equal((fake.state.discord || []).length, avantD);
  // Chaque compte a sa conversation ; l'administrateur voit ce qui attend sa validation.
  assert.ok((await api('GET', '/api/agent')).some(h => h.id === pm.json.id && h.autreCompte));
  assert.deepEqual((await lecteur.get('/api/agent')).json, [], 'rien de la conversation des autres');
  assert.equal((await lecteur.post(`/api/agent/${pm.json.id}/reject`, {})).status, 403, 'la lecture seule ne refuse rien');
  assert.equal((await membre.get('/api/agent')).json.filter(h => h.autreCompte).length, 0);
  await api('POST', `/api/agent/${pm.json.id}/reject`);
});

test('confidentialité : un compte qui se supprime emporte ses questions et ses quotas, l’export les lui rend avant', async () => {
  let r = await admin.post('/api/compte/admin/comptes', { identifiant: 'dora', role: 'membre' });
  if (r.status === 403) {
    const o = await admin.post('/api/compte/renfort/options');
    await admin.post('/api/compte/renfort', { methode: 'cle', reponse: cleAdmin.signer(o.json, admin.origine) });
    r = await admin.post('/api/compte/admin/comptes', { identifiant: 'dora', role: 'membre' });
  }
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const dora = new Client(admin.port);
  assert.equal((await dora.post('/api/compte/jeton', { usage: 'invitation', jeton: r.json.lien.split('#invitation=')[1], motDePasse: 'dora a une phrase bien à elle' })).status, 200);
  const t = await dora.post('/api/compte/totp');
  assert.equal((await dora.post('/api/compte/totp/confirmer', { code: codeTotp(t.json.secret) })).json.niveau, 'complet');
  const id = hub.db.get("SELECT id FROM socle_comptes WHERE identifiant = 'dora'").id;
  hub.db.run("INSERT INTO agent_plans(id,request,plan,status,created,compte) VALUES('q-dora','question de dora','{}','answered',?,?), ('q-autre','question d’un autre','{}','answered',?,'autre')", Date.now(), id, Date.now());
  hub.db.run("INSERT INTO quotas(cle, jour, n) VALUES(?, '2026-01-01', 3), ('assistant:compte:autre', '2026-01-01', 1)", `assistant:compte:${id}`);
  const ex = await dora.get('/api/compte/export');
  assert.equal(ex.status, 200, JSON.stringify(ex.json));
  assert.deepEqual(ex.json.hub.questions.map(q => q.request), ['question de dora'], 'ses questions, et seulement les siennes');
  assert.equal((await dora.post('/api/compte/supprimer', { identifiant: 'dora' })).status, 200);
  assert.equal(hub.db.get("SELECT count(*) n FROM agent_plans WHERE compte = ?", id).n, 0);
  assert.equal(hub.db.get("SELECT count(*) n FROM quotas WHERE cle = ?", `assistant:compte:${id}`).n, 0);
  assert.ok(hub.db.get("SELECT 1 FROM agent_plans WHERE id = 'q-autre'") && hub.db.get("SELECT 1 FROM quotas WHERE cle = 'assistant:compte:autre'"), 'rien d’un autre compte');
  hub.db.run("DELETE FROM agent_plans WHERE id = 'q-autre'");
  hub.db.run("DELETE FROM quotas WHERE cle = 'assistant:compte:autre'");
});

test('clés d’accès d’avant HTTPS : rattachées à localhost sans relais déclaré, laissées telles quelles avec un relais', async () => {
  assert.deepEqual(hub.db.all('SELECT DISTINCT rp FROM socle_cles').map(l => l.rp), ['localhost'], 'une clé neuve porte son domaine');
  hub.db.run('UPDATE socle_cles SET rp = NULL');
  assert.equal(main.rattacherClesAnciennes(hub.db, { SOCLE_PROXYS: '172.16.0.0/12' }), 0, 'derrière un relais, le domaine d’alors est inconnu');
  assert.ok(main.rattacherClesAnciennes(hub.db, {}) > 0);
  assert.deepEqual(hub.db.all('SELECT DISTINCT rp FROM socle_cles').map(l => l.rp), ['localhost']);
});

test('Caddy de Relay cru par le Hub : l’adresse relevée devient un relais de confiance, puis cesse de l’être', async () => {
  const { adresseClient } = await import('../socle/src/index.js');
  const req = ip => ({ socket: { remoteAddress: ip }, headers: { 'x-forwarded-for': '198.51.100.7' } });
  assert.equal(adresseClient(req('172.18.0.9'), hub.socle.portail.proxys), '172.18.0.9', 'avant : l’en-tête n’est pas cru');
  hub.connexions.surRelais('172.18.0.9');
  assert.equal(adresseClient(req('172.18.0.9'), hub.socle.portail.proxys), '198.51.100.7', 'Caddy de Relay : l’adresse du client est la sienne');
  assert.equal(adresseClient(req('172.18.0.10'), hub.socle.portail.proxys), '172.18.0.10', 'un voisin ne l’est pas');
  hub.connexions.surRelais('');
  assert.equal(adresseClient(req('172.18.0.9'), hub.socle.portail.proxys), '172.18.0.9');
});

test('interface sous /v/<version>/ : une mise à jour change l’adresse de chaque fichier, aucun cache ne rend l’ancienne interface', async () => {
  const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const page = await (await fetch(base + '/')).text();
  assert.ok(page.includes(`<script type="module" src="/v/${version}/app.js"`));
  assert.ok(page.includes(`"/socle/": "/v/${version}/socle/"`), 'les modules du socle suivent la version par la carte d’import');
  assert.match(page, /<script type="importmap" nonce="[^"]+">/);
  const courant = await fetch(`${base}/v/${version}/app.js`);
  assert.equal(courant.status, 200);
  assert.equal(courant.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const socle = await fetch(`${base}/v/${version}/socle/compte.js`);
  assert.equal(socle.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const ancien = await fetch(`${base}/v/0.0.1/app.js`);
  assert.equal(ancien.status, 200, 'une page gardée en cache reçoit le fichier courant');
  assert.equal(ancien.headers.get('cache-control'), 'no-cache');
  assert.equal((await fetch(`${base}/v/${version}/../../package.json`)).status, 404);
});
