// Le pont des outils d'abonnement (outils-ia/pont.mjs), avec de faux outils :
// même forme de réponse que les autres fournisseurs, comptes détectés, délai.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pont-'));
const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
// Un faux Claude Code : rejoue ses options et répond en JSON, comme l'outil.
fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh
if [ "$1" = "setup-token" ]; then
  printf 'Browser didn'"'"'t open? Use the url below to sign in:\nhttps://claude.ai/oauth/authorize?code=true&client_id=abc&state=xyz\n\nPaste code here if prompted > '
  read -r code
  [ "$code" = "le-bon-code#etat" ] || { echo "Invalid code" >&2; exit 1; }
  printf '\n\nLong-lived token: sk-ant-oat01-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef\n'; exit 0
fi
prompt=$(cat)
model=claude; sys=
while [ $# -gt 0 ]; do case "$1" in --model) model=$2; shift;; --system-prompt) sys=$2; shift;; esac; shift; done
[ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] || { echo "not logged in" >&2; exit 1; }
printf '{"type":"result","is_error":false,"result":"réponse de %s à « %s » (consigne : %s)","model":"%s","usage":{"input_tokens":12,"output_tokens":7}}' "$model" "$prompt" "$sys" "$model"
`, { mode: 0o755 });
// Un faux Codex : écrit le dernier message dans le fichier demandé.
fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh
if [ "$1" = "login" ]; then
  echo "Open the following URL in your browser: https://auth.openai.com/codex/device"
  echo "and enter the code: WXYZ-1234"
  sleep 1; mkdir -p "$HOME/.codex"; echo '{"tokens":{}}' > "$HOME/.codex/auth.json"; echo "Successfully logged in"; exit 0
fi
out=; model=codex; prompt=
while [ $# -gt 0 ]; do case "$1" in --output-last-message) out=$2; shift;; -m) model=$2; shift;; exec|--skip-git-repo-check|-s|read-only) ;; *) prompt=$1;; esac; shift; done
printf 'codex %s dit : %s' "$model" "$prompt" > "$out"
`, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.HOME = tmp;
const { serveur, etat, chat, demarrerConnexion, envoyerCode, etatConnexion } = await import('../outils-ia/pont.mjs');
const JETON = 'jeton-du-pont-pour-les-essais-0123456789';
const H = { authorization: `Bearer ${JETON}` };
let srv, base;
before(async () => { srv = serveur({ jeton: JETON }); await new Promise(r => srv.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${srv.address().port}`; });
after(() => { srv.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('état : outils présents, Codex connecté par son fichier, Claude par le jeton', () => {
  let e = etat({});
  assert.equal(e.claude.installe, true); assert.equal(e.claude.connecte, false);
  assert.equal(e.codex.installe, true); assert.equal(e.codex.connecte, false);
  fs.mkdirSync(path.join(tmp, '.codex')); fs.writeFileSync(path.join(tmp, '.codex', 'auth.json'), '{"tokens":{}}');
  e = etat({ CLAUDE_CODE_OAUTH_TOKEN: 'x' });
  assert.equal(e.codex.connecte, true); assert.equal(e.claude.connecte, true);
  assert.match(e.claude.connexion, /claude setup-token/); assert.match(e.codex.connexion, /codex login --device-auth/);
});

test('chat : Claude Code reçoit la consigne, le modèle et le jeton ; Codex rend son dernier message', async () => {
  const r = await fetch(`${base}/chat`, { method: 'POST', headers: { 'content-type': 'application/json', ...H }, body: JSON.stringify({ outil: 'claude', model: 'sonnet', system: 'Réponds court.', messages: [{ role: 'user', content: 'Bonjour' }], jeton: 'sk-ant-oat-essai' }) });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.text, 'réponse de sonnet à « Bonjour » (consigne : Réponds court.)');
  assert.equal(j.model, 'sonnet'); assert.equal(j.tokensIn, 12); assert.equal(j.tokensOut, 7);
  // Sans jeton ni connexion dans le conteneur : l'outil refuse, et on le dit.
  const sans = await fetch(`${base}/chat`, { method: 'POST', headers: { 'content-type': 'application/json', ...H }, body: JSON.stringify({ outil: 'claude', messages: [{ role: 'user', content: 'x' }] }) });
  assert.equal(sans.status, 502);
  assert.match((await sans.json()).error, /not logged in/);
  const c = await chat({ outil: 'codex', model: 'gpt-5-codex', system: 'Sois bref.', messages: [{ role: 'user', content: 'Salut' }, { role: 'assistant', content: 'Oui ?' }, { role: 'user', content: 'Ça va' }] });
  assert.equal(c.text, 'codex gpt-5-codex dit : Sois bref.\n\nUtilisateur : Salut\n\nAssistant : Oui ?\n\nUtilisateur : Ça va\n\nAssistant :');
  const m = await (await fetch(`${base}/modeles?outil=codex`, { headers: H })).json();
  assert.ok(m.modeles.includes('gpt-5-codex'));
  const inconnu = await fetch(`${base}/chat`, { method: 'POST', headers: { 'content-type': 'application/json', ...H }, body: JSON.stringify({ outil: 'gemini-cli', messages: [] }) });
  assert.equal(inconnu.status, 400);
});

const attendre = async (fn, ms = 5000) => { const fin = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > fin) throw new Error('délai'); await new Promise(r => setTimeout(r, 50)); } };

test('connexion pilotée : Claude Code donne son lien, reçoit le code collé, rend son jeton une seule fois', async () => {
  let e = demarrerConnexion('claude');
  assert.equal(e.outil, 'claude');
  e = await attendre(() => { const x = etatConnexion('claude'); return x.lien ? x : null; });
  assert.equal(e.etape, 'attente-code');
  assert.equal(e.lien, 'https://claude.ai/oauth/authorize?code=true&client_id=abc&state=xyz');
  e = envoyerCode('claude', 'le-bon-code#etat');
  assert.equal(e.etape, 'verification');
  e = await attendre(() => { const x = etatConnexion('claude'); return x.etape === 'ok' ? x : null; });
  assert.equal(e.jetonPret, true);
  const r = await fetch(`${base}/connexion/claude/jeton`, { method: 'POST', headers: H });
  const j = await r.json();
  assert.equal(j.jeton, 'sk-ant-oat01-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef');
  assert.equal(etatConnexion('claude').jetonPret, false, 'rendu une fois, puis oublié');
  // Un mauvais code : l'outil s'arrête, et on le dit.
  demarrerConnexion('claude');
  await attendre(() => etatConnexion('claude').lien);
  envoyerCode('claude', 'faux');
  e = await attendre(() => { const x = etatConnexion('claude'); return x.fini ? x : null; });
  assert.equal(e.etape, 'erreur'); assert.match(e.erreur, /Invalid code/);
});

test('connexion pilotée : Codex donne son lien et son code, puis se connecte tout seul', async () => {
  const r = await fetch(`${base}/connexion/codex/demarrer`, { method: 'POST', headers: H });
  assert.equal(r.status, 200);
  const e = await attendre(async () => { const x = await (await fetch(`${base}/connexion/codex`, { headers: H })).json(); return x.code ? x : null; });
  assert.equal(e.lien, 'https://auth.openai.com/codex/device'); assert.equal(e.code, 'WXYZ-1234'); assert.equal(e.etape, 'attente-lien');
  const fin = await attendre(async () => { const x = await (await fetch(`${base}/connexion/codex`, { headers: H })).json(); return x.etape === 'ok' ? x : null; });
  assert.equal(fin.fini, true);
  assert.equal(etat({}).codex.connecte, true);
});

test('pont : sans le jeton du Hub, rien ; sans jeton configuré, rien pour personne ; Claude Code sans ses outils', async () => {
  assert.equal((await fetch(`${base}/etat`)).status, 401);
  assert.equal((await fetch(`${base}/connexion/claude/jeton`, { method: 'POST', headers: { authorization: 'Bearer faux' } })).status, 401);
  assert.equal((await fetch(`${base}/chat`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${JETON}x` }, body: '{}' })).status, 401);
  assert.equal((await fetch(`${base}/etat`, { headers: H })).status, 200);
  const nu = serveur({ jeton: '' }); await new Promise(r => nu.listen(0, '127.0.0.1', r));
  try { assert.equal((await fetch(`http://127.0.0.1:${nu.address().port}/etat`, { headers: H })).status, 503); } finally { nu.close(); }
  let vu = null;
  await chat({ outil: 'claude', messages: [{ role: 'user', content: 'lis ~/.claude' }], jeton: 'x' }, { executer: async (cmd, args) => { vu = args; return { out: '{"result":"non"}' }; } });
  const i = vu.indexOf('--disallowedTools');
  assert.ok(i > 0 && ['Bash', 'Read', 'Glob', 'Grep', 'WebFetch'].every(o => vu.includes(o)), JSON.stringify(vu));
});
