// Exercice de rotation de bout en bout (REQ-CFG-005) : le Hub lancé comme en
// production, clés lues dans des fichiers (_FILE), un compte avec TOTP, clé
// d'accès et codes de secours, une variable secrète et un webhook ; puis les
// deux clés maîtresses tournées comme le dit le README, et tout ce qui
// existait revérifié. Dure un peu plus de trente secondes (un pas TOTP).
//   node outils/exercice-rotation.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
const HUB = path.resolve(import.meta.dirname, '..');
const { Client, connexion } = await import(`${HUB}/socle/essai/client.js`);
const { Authentificateur } = await import(`${HUB}/socle/essai/authentificateur.js`);
const totp = await import(`${HUB}/socle/src/totp.js`);
const { Vault } = await import(`${HUB}/server/vault.js`);
const { DatabaseSync } = await import('node:sqlite');

const D = fs.mkdtempSync(path.join(os.tmpdir(), 'exercice-'));
const S = path.join(D, 'secrets'); fs.mkdirSync(S, { mode: 0o700 });
const PORT = 18000 + crypto.randomInt(1000), JETON = crypto.randomBytes(24).toString('base64url'), MDP = 'phrase de passe de l’exercice de rotation';
const cle = () => crypto.randomBytes(32).toString('base64');
const poser = (f, v) => fs.writeFileSync(path.join(S, f), v, { mode: 0o600 });
const lire = f => fs.readFileSync(path.join(S, f), 'utf8');
const rapport = [];
const note = (ok, quoi) => { rapport.push(`${ok ? 'OK ' : 'ÉCHEC'} ${quoi}`); if (!ok) { console.log(rapport.join('\n')); process.exit(1); } };

poser('hub_cle', cle()); poser('socle_cle', cle()); poser('hub_cle_ancienne', ''); poser('socle_cle_ancienne', '');
let proc, sortie = '';
async function demarrer() {
  sortie = '';
  proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/main.js'], { cwd: HUB, env: {
    PATH: process.env.PATH, HUB_DATA: path.join(D, 'data'), HUB_PORT: String(PORT), HUB_HOST: '127.0.0.1', HUB_PUBLIC_URL: `http://localhost:${PORT}`,
    HUB_CLE_FILE: path.join(S, 'hub_cle'), SOCLE_CLE_FILE: path.join(S, 'socle_cle'),
    HUB_CLE_ANCIENNE_FILE: path.join(S, 'hub_cle_ancienne'), SOCLE_CLE_ANCIENNE_FILE: path.join(S, 'socle_cle_ancienne'),
    SOCLE_JETON_INSTALLATION: JETON, HUB_CATALOGUE_AUTO_MS: '0',
  } });
  proc.stdout.on('data', d => { sortie += d; }); proc.stderr.on('data', d => { sortie += d; });
  const fin = new Promise(r => proc.on('exit', c => r({ code: c })));
  for (let i = 0; i < 100; i++) {
    const r = await Promise.race([fetch(`http://127.0.0.1:${PORT}/api/status`).then(x => x.status, () => 0), fin]);
    if (r === 200) return { code: null };
    if (typeof r === 'object') return r;
    await new Promise(r => setTimeout(r, 200));
  }
  return { code: 'délai' };
}
const arreter = () => new Promise(r => { proc.on('exit', r); proc.kill('SIGTERM'); });

// 1. Installation, facteurs, données scellées.
note((await demarrer()).code === null, 'démarrage sous HUB_CLE et SOCLE_CLE initiales');
const a = new Client(PORT), auth = new Authentificateur();
note((await a.post('/api/compte/installation', { jeton: JETON, identifiant: 'ana', motDePasse: MDP })).status === 200, 'installation du premier compte');
const secret = (await a.post('/api/compte/totp')).json.secret;
note((await a.post('/api/compte/totp/confirmer', { code: totp.code(secret, totp.pasCourant(Date.now())) })).status === 200, 'TOTP inscrit');
const o = await a.post('/api/compte/cles/options');
note((await a.post('/api/compte/cles', { reponse: auth.creer(o.json, a.origine), nom: 'Exercice' })).json?.niveau === 'complet', 'clé d’accès inscrite');
const codes = (await a.post('/api/compte/secours')).json.codes;
note((await a.put('/api/variables/JETON_EXERCICE', { value: 'valeur-secrete-exercice', secret: true })).status === 200, 'variable secrète posée');
const wf = (await a.post('/api/workflows', { name: 'Exercice', graph: { nodes: [{ id: 'h', type: 'trigger.webhook', name: 'Entrée', params: { auth: 'hmac' } }], edges: [] } })).json.workflow;
await a.post(`/api/workflows/${wf.id}/enable`, {});
const hook = (await a.post(`/api/workflows/${wf.id}/webhooks/h/secret`, {})).json;
note(!!hook?.secret, 'secret de webhook créé');
const signe = s => ({ method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature': 'sha256=' + crypto.createHmac('sha256', s).update('{}').digest('hex') }, body: '{}' });
note((await fetch(hook.url.replace('localhost', '127.0.0.1'), signe(hook.secret))).status === 200, 'webhook signé accepté');
await arreter();

// 2. Rotation des deux clés maîtresses, selon le README.
const K1 = lire('hub_cle'), K2 = cle();
poser('hub_cle_ancienne', K1); poser('hub_cle', K2);
poser('socle_cle_ancienne', lire('socle_cle')); poser('socle_cle', cle());
note((await demarrer()).code === null, 'redémarrage avec les clés neuves et les anciennes posées');
note(/clé tournée : [1-9]\d* secret\(s\) rescellé\(s\)/.test(sortie), 'HUB_CLE : ' + (sortie.match(/clé tournée : [^.]*\./)?.[0] || 'aucune trace'));
note(/\[coffre\] Clé tournée : 1 secret\(s\) TOTP rescellé\(s\), 10 code\(s\) de secours/.test(sortie), 'SOCLE_CLE : ' + (sortie.match(/\[coffre\] Clé tournée : [^.]*\./)?.[0] || 'aucune trace'));
let c = new Client(PORT);
note((await connexion(c, 'ana', MDP)).json?.etape === 'second', 'mot de passe accepté');
await new Promise(r => setTimeout(r, 31_000));
note((await c.post('/api/compte/connexion/totp', { code: totp.code(secret, totp.pasCourant(Date.now())) })).json?.niveau === 'complet', 'TOTP inscrit avant la rotation accepté');
c = new Client(PORT); await connexion(c, 'ana', MDP);
note((await c.post('/api/compte/connexion/secours', { code: codes[4] })).status === 200, 'code de secours d’avant la rotation accepté');
note((await fetch(hook.url.replace('localhost', '127.0.0.1'), signe(hook.secret))).status === 200, 'webhook signé avec le secret d’avant la rotation accepté');
await arreter();

// 3. Anciennes clés retirées : tout tient, et rien n'est plus lisible sous l'ancienne clé.
poser('hub_cle_ancienne', ''); poser('socle_cle_ancienne', '');
note((await demarrer()).code === null, 'redémarrage, anciennes clés retirées');
c = new Client(PORT);
const oc = await c.post('/api/compte/connexion/cle/options');
note((await c.post('/api/compte/connexion/cle', { reponse: auth.signer(oc.json, c.origine) })).json?.niveau === 'complet', 'connexion par clé d’accès');
await arreter();
const db = new DatabaseSync(path.join(D, 'data', 'hub.db'), { readOnly: true });
const scelle = db.prepare("SELECT value FROM variables WHERE key='JETON_EXERCICE'").get().value;
note(Vault.depuisCle(K2).open(scelle) === 'valeur-secrete-exercice', 'variable secrète lue sous la clé neuve');
let ancienneLit = true; try { Vault.depuisCle(K1).open(scelle); } catch { ancienneLit = false; }
note(!ancienneLit, 'l’ancienne clé ne lit plus la variable');
const journal = db.prepare("SELECT action, detail FROM audit WHERE action='coffre.tourné'").all();
note(journal.length === 1, `journal du Hub : coffre.tourné ${journal[0]?.detail}`);
db.close();

// 4. Une clé inconnue arrête le démarrage.
poser('hub_cle', cle());
const r = await demarrer();
note(r.code !== null && /n’est pas la clé qui a écrit cette base/.test(sortie), 'clé inconnue : démarrage refusé');
fs.rmSync(D, { recursive: true, force: true });
console.log(`Exercice de rotation, ${new Date().toISOString()}\n${rapport.join('\n')}`);
