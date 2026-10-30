// Pont vers les outils d'abonnement (conteneur hub-outils-ia).
//
// Claude Code et Codex sont faits pour être lancés, pas pour prêter leur
// jeton : le Hub ne les appelle donc jamais par leur API, il lance l'outil
// lui-même, ici, avec le compte que tu as connecté une fois dans ce conteneur
// (`claude setup-token`, `codex login --device-auth`). Pour le Hub, c'est une
// IA de plus : POST /chat, même forme que ses autres fournisseurs.
//
// Seul le Hub appelle ce port : sur un réseau à part (hub_outils, où les
// services installés n'entrent pas), et avec le jeton partagé du pont
// (secret Docker pont_jeton) ; sans jeton configuré, le pont refuse tout.
// Aucune dépendance.
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.PONT_PORT || 7110);
const MAISON = process.env.HOME || os.homedir();
const DELAI = Number(process.env.PONT_DELAI_MS || 600_000);
const MAX_CORPS = 2 * 1024 * 1024;
const EN_COURS = { max: Number(process.env.PONT_PARALLELE || 2), n: 0 };
// L'outil répond en un tour, sans ses outils : un texte venu d'un service ne
// peut pas lui faire lire un fichier du conteneur (ses jetons y vivent) ni
// lancer une commande.
export const OUTILS_COUPES = ['Bash', 'BashOutput', 'KillShell', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'NotebookRead', 'NotebookEdit', 'Task', 'TodoWrite', 'SlashCommand', 'ExitPlanMode'];

/** Le jeton partagé avec le Hub : PONT_JETON, ou le fichier PONT_JETON_FILE (secret Docker). */
export function jetonDuPont(env = process.env) {
  if (env.PONT_JETON) return String(env.PONT_JETON).trim();
  if (env.PONT_JETON_FILE) { try { return fs.readFileSync(env.PONT_JETON_FILE, 'utf8').trim(); } catch { return ''; } }
  return '';
}
const memeJeton = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// Les modèles que l'outil accepte par son option -m / --model. Claude Code
// prend aussi un alias (sonnet, opus, haiku) ; Codex le nom exact.
export const MODELES = {
  claude: ['sonnet', 'opus', 'haiku', 'claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
  codex: ['gpt-5-codex', 'gpt-5', 'o4-mini', 'o3'],
};

const ou = nom => { for (const d of (process.env.PATH || '').split(':')) { try { fs.accessSync(path.join(d, nom), fs.constants.X_OK); return path.join(d, nom); } catch { /* suivant */ } } return null; };

/** Ce que le Hub affiche : outil présent, compte connecté. */
export function etat(env = process.env) {
  const claude = ou('claude'), codex = ou('codex');
  let codexConnecte = false;
  try { codexConnecte = fs.statSync(path.join(MAISON, '.codex', 'auth.json')).size > 2; } catch { /* pas connecté */ }
  let claudeConnecte = !!env.CLAUDE_CODE_OAUTH_TOKEN;
  // Sans jeton transmis par le Hub, une connexion faite dans le conteneur compte aussi.
  if (!claudeConnecte) { try { claudeConnecte = fs.statSync(path.join(MAISON, '.claude', '.credentials.json')).size > 2; } catch { /* non */ } }
  return {
    claude: { installe: !!claude, connecte: claudeConnecte, modeles: MODELES.claude, connexion: 'docker exec -it hub-outils-ia claude setup-token' },
    codex: { installe: !!codex, connecte: codexConnecte, modeles: MODELES.codex, connexion: 'docker exec -it hub-outils-ia codex login --device-auth' },
  };
}

// Le fil de la conversation, aplati : les outils prennent un seul texte.
function transcrire(messages) {
  const l = Array.isArray(messages) ? messages : [];
  if (l.length === 1 && l[0].role === 'user') return String(l[0].content ?? '');
  return l.map(m => `${m.role === 'assistant' ? 'Assistant' : 'Utilisateur'} : ${String(m.content ?? '')}`).join('\n\n') + '\n\nAssistant :';
}

function lancer(cmd, args, { stdin = '', env = {}, cwd, signal }) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, signal, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => { if (out.length < 4e6) out += d; });
    p.stderr.on('data', d => { if (err.length < 1e5) err += d; });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve({ out, err }) : reject(new Error(`${path.basename(cmd)} a échoué (code ${code}) : ${err.trim().slice(-400) || out.trim().slice(-400)}`)));
    // Un outil qui refuse avant de lire son entrée ferme le tuyau : c'est son
    // code de sortie qui dit l'erreur, pas l'écriture interrompue.
    p.stdin.on('error', () => {});
    p.stdin.end(stdin);
  });
}

/** Une réponse de l'outil demandé. → { text, model, tokensIn, tokensOut } */
export async function chat({ outil, model, system, messages, maxTokens, jeton }, { executer = lancer } = {}) {
  if (!['claude', 'codex'].includes(outil)) throw Object.assign(new Error('outil inconnu'), { status: 400 });
  const cmd = ou(outil);
  if (!cmd) throw Object.assign(new Error(`${outil} n'est pas installé dans ce conteneur.`), { status: 503 });
  const prompt = transcrire(messages);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pont-'));
  const ac = new AbortController();
  const minuteur = setTimeout(() => ac.abort(), DELAI);
  try {
    if (outil === 'claude') {
      const args = ['-p', '--output-format', 'json', '--max-turns', '1', '--disallowedTools', ...OUTILS_COUPES];
      if (model) args.push('--model', String(model));
      if (system) args.push('--system-prompt', String(system));
      const env = jeton ? { CLAUDE_CODE_OAUTH_TOKEN: String(jeton) } : {};
      const { out } = await executer(cmd, args, { stdin: prompt, env, cwd, signal: ac.signal });
      let j = null; try { j = JSON.parse(out); } catch { /* texte brut */ }
      if (j?.is_error) throw new Error(String(j.result || 'Claude Code a refusé'));
      return { text: String(j?.result ?? out).trim(), model: j?.model || model || 'claude', tokensIn: j?.usage?.input_tokens || 0, tokensOut: j?.usage?.output_tokens || 0 };
    }
    const fichier = path.join(cwd, 'reponse.txt');
    const args = ['exec', '--skip-git-repo-check', '-s', 'read-only', '--output-last-message', fichier];
    if (model) args.push('-m', String(model));
    const texte = (system ? `${system}\n\n` : '') + prompt;
    await executer(cmd, [...args, texte], { cwd, signal: ac.signal });
    let text = ''; try { text = fs.readFileSync(fichier, 'utf8').trim(); } catch { /* vide */ }
    return { text, model: model || 'codex', tokensIn: 0, tokensOut: 0 };
  } finally {
    clearTimeout(minuteur);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

// ---- connexion d'un compte, pilotée depuis le Hub ----
//
// L'outil fait sa propre connexion (« claude setup-token », « codex login
// --device-auth ») : il affiche un lien, l'utilisateur s'y connecte, puis
// l'outil reçoit un code (Claude : collé ; Codex : il attend tout seul). Ici,
// on lance l'outil, on lit ce qu'il affiche, et le Hub montre le lien et le
// code à sa place — sans terminal. Claude Code veut un vrai terminal : on le
// lui donne avec `script` (un pseudo-terminal), et on lui tape le code dedans.
const DEPOUILLE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\r/g;
const LIEN = /https?:\/\/[^\s'"<>)\]]+/g;
const JETON_CLAUDE = /sk-ant-oat[0-9]*-[A-Za-z0-9_-]{20,}/;
const CODE_CODEX = /\b([A-Z0-9]{4,}-[A-Z0-9]{4,})\b/;
const connexions = {};

export function demarrerConnexion(outil, { executer = null } = {}) {
  if (!['claude', 'codex'].includes(outil)) throw Object.assign(new Error('outil inconnu'), { status: 400 });
  const cmd = ou(outil);
  if (!cmd) throw Object.assign(new Error(`${outil} n'est pas installé dans ce conteneur.`), { status: 503 });
  const vivante = connexions[outil];
  if (vivante && !vivante.fini) return etatConnexion(outil);
  const c = { outil, sortie: '', lien: null, code: null, jeton: null, etape: 'lancement', erreur: null, fini: false, debut: Date.now() };
  connexions[outil] = c;
  const pty = ou('script');
  // Claude Code refuse un flux sans terminal ; Codex se contente d'un tuyau.
  const args = outil === 'claude' ? ['setup-token'] : ['login', '--device-auth'];
  const spawnArgs = outil === 'claude' && pty ? [pty, ['-q', '-e', '-c', [cmd, ...args].map(a => `'${a}'`).join(' '), '/dev/null']] : [cmd, args];
  const p = (executer || spawn)(...spawnArgs, { env: { ...process.env, TERM: 'dumb', NO_COLOR: '1', CI: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  c.processus = p;
  const lire = d => {
    c.sortie = (c.sortie + String(d)).slice(-20000);
    const clair = c.sortie.replace(DEPOUILLE, '');
    const liens = clair.match(LIEN) || [];
    const lienOauth = liens.find(l => /oauth|login|auth|device/i.test(l)) || liens[liens.length - 1];
    if (lienOauth && !c.lien) { c.lien = lienOauth.replace(/[.,;:]+$/, ''); c.etape = outil === 'claude' ? 'attente-code' : 'attente-lien'; }
    if (outil === 'codex' && !c.code) { const m = CODE_CODEX.exec(clair); if (m) c.code = m[1]; }
    if (outil === 'claude') { const m = JETON_CLAUDE.exec(clair); if (m) { c.jeton = m[0]; c.etape = 'ok'; } }
  };
  p.stdout.on('data', lire); p.stderr.on('data', lire);
  p.stdin.on('error', () => {});
  p.on('error', e => { c.erreur = e.message; c.etape = 'erreur'; c.fini = true; });
  p.on('close', code => {
    c.fini = true;
    if (c.etape === 'ok') return;
    if (outil === 'codex' && code === 0) { c.etape = 'ok'; return; }
    if (outil === 'claude' && c.jeton) { c.etape = 'ok'; return; }
    c.etape = 'erreur';
    c.erreur = c.erreur || `${outil} s'est arrêté (code ${code}) sans finir la connexion : ${c.sortie.replace(DEPOUILLE, '').trim().split('\n').filter(Boolean).slice(-3).join(' · ').slice(0, 300)}`;
  });
  c.minuteur = setTimeout(() => { if (!c.fini) { c.erreur = 'Connexion non terminée en dix minutes.'; try { p.kill(); } catch { /* déjà fini */ } } }, 10 * 60e3);
  c.minuteur.unref?.();
  return etatConnexion(outil);
}

export function envoyerCode(outil, code) {
  const c = connexions[outil];
  if (!c || c.fini) throw Object.assign(new Error('Aucune connexion en cours : relance-la.'), { status: 409 });
  const propre = String(code || '').trim();
  if (!propre || propre.length > 2000) throw Object.assign(new Error('Code vide.'), { status: 400 });
  c.processus.stdin.write(propre + '\n');
  c.etape = 'verification';
  return etatConnexion(outil);
}

/** Le jeton de Claude Code n'est rendu qu'une fois : le Hub le range dans Clés & API et il disparaît d'ici. */
export function etatConnexion(outil, { prendreJeton = false } = {}) {
  const c = connexions[outil];
  if (!c) return { outil, etape: 'aucune' };
  const out = { outil, etape: c.etape, lien: c.lien, code: c.code, erreur: c.erreur, fini: c.fini, depuis: c.debut };
  if (prendreJeton && c.jeton) { out.jeton = c.jeton; c.jeton = null; }
  else out.jetonPret = !!c.jeton;
  return out;
}

export function serveur({ executer, jeton = jetonDuPont() } = {}) {
  return http.createServer(async (req, res) => {
    const repondre = (status, corps) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(corps)); };
    try {
      if (!jeton) { req.resume(); return repondre(503, { error: 'Pont sans jeton (PONT_JETON_FILE) : il ne répond à personne.' }); }
      const presente = /^Bearer (.+)$/.exec(String(req.headers.authorization || ''))?.[1] || '';
      if (!memeJeton(presente, jeton)) { req.resume(); return repondre(401, { error: 'Jeton du pont refusé.' }); }
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/etat') return repondre(200, etat());
      if (req.method === 'GET' && url.pathname === '/modeles') { const o = url.searchParams.get('outil'); return repondre(200, { modeles: MODELES[o] || [] }); }
      const mc = /^\/connexion\/(claude|codex)(\/(demarrer|code|jeton))?$/.exec(url.pathname);
      if (mc) {
        const outil = mc[1], action = mc[3];
        if (req.method === 'GET' && !action) return repondre(200, etatConnexion(outil));
        if (req.method === 'POST' && action === 'demarrer') return repondre(200, demarrerConnexion(outil));
        if (req.method === 'POST' && action === 'jeton') return repondre(200, etatConnexion(outil, { prendreJeton: true }));
        if (req.method === 'POST' && action === 'code') {
          let brut = ''; for await (const d of req) { brut += d; if (brut.length > 10000) return repondre(413, { error: 'Corps trop grand.' }); }
          let b; try { b = JSON.parse(brut || '{}'); } catch { return repondre(400, { error: 'JSON attendu.' }); }
          return repondre(200, envoyerCode(outil, b.code));
        }
      }
      if (req.method === 'POST' && url.pathname === '/chat') {
        if (EN_COURS.n >= EN_COURS.max) return repondre(429, { error: 'Trop d’appels en même temps.' });
        let brut = '';
        for await (const d of req) { brut += d; if (brut.length > MAX_CORPS) return repondre(413, { error: 'Corps trop grand.' }); }
        let b; try { b = JSON.parse(brut || '{}'); } catch { return repondre(400, { error: 'JSON attendu.' }); }
        EN_COURS.n++;
        try { return repondre(200, await chat(b, { executer })); }
        finally { EN_COURS.n--; }
      }
      repondre(404, { error: 'inconnu' });
    } catch (e) { repondre(e.status || 502, { error: e.name === 'AbortError' ? 'L’outil n’a pas répondu à temps.' : e.message }); }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  serveur().listen(PORT, '0.0.0.0', () => console.log(`pont des outils IA sur :${PORT}`));
}
