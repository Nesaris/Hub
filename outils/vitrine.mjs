// Un Hub de démonstration, relié aux faux services des essais, avec de quoi
// remplir chaque page : services distants, workflows, IA, clés. Pour voir
// l'interface et la contrôler au navigateur, jamais pour la production.
//   node outils/vitrine.mjs PORT JETON_INSTALLATION   (VITRINE_GAMME=console pour la seconde gamme)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [port = '8190', jeton = 'jeton-installation-de-la-vitrine-du-hub'] = process.argv.slice(2);
const ICI = path.dirname(new URL(import.meta.url).pathname);
const FIX = path.join(ICI, '..', 'test', 'fixtures');
const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-vitrine-'));
const reg = path.join(dossier, 'registre');
fs.mkdirSync(path.join(reg, 'm'), { recursive: true });
for (const [id, src] of [['docker-control', path.join(FIX, 'docker-control.hub.json')], ['synapse', path.join(FIX, 'synapse.hub.json')], ['vox', path.join(FIX, 'vox.hub.json')], ['ollama', path.join(ICI, '..', 'registry-local', 'manifests', 'ollama.hub.json')]]) fs.copyFileSync(src, path.join(reg, 'm', `${id}.json`));
fs.writeFileSync(path.join(reg, 'index.json'), JSON.stringify({ extensions: ['docker-control', 'synapse', 'ollama', 'vox'].map(id => ({ id, manifest: `m/${id}.json` })) }));

const { startFake } = await import('../test/fake-services.js');
const faux = await startFake();
Object.assign(process.env, {
  HUB_DATA: dossier, HUB_PUBLIC_URL: `http://127.0.0.1:${port}`, HUB_REGISTRY: `dir:${reg}`, HUB_LOG_LEVEL: 'warn',
  HUB_TELEGRAM_API: faux.base + '/tg', HUB_ELEVEN_API: faux.base + '/el',
  SOCLE_JETON_INSTALLATION: jeton,
});
const { buildHub } = await import('../server/main.js');
const hub = await buildHub();
await new Promise(r => hub.server.listen(Number(port), '127.0.0.1', r));
await hub.registry.refresh('vitrine');
// VITRINE_GAMME=console : la vitrine dans la seconde gamme du socle.
if (process.env.VITRINE_GAMME) hub.db.setSetting('theme_services', process.env.VITRINE_GAMME);
const qui = 'vitrine';
const oll = await hub.services.add('ollama', { name: 'ollama-gpu-pc', url: faux.base }, qui);
await hub.services.add('synapse', { mode: 'remote', url: faux.base, config: { REMOTE_TOKEN: 'jeton-synapse-de-la-vitrine' } }, qui);
await hub.services.add('docker-control', { mode: 'remote', url: faux.base, config: { REMOTE_TOKEN: 'jeton-docker-de-la-vitrine' } }, qui);
// Deux services installés par Compose, pour la page Thème : MapMyLAN lit le
// thème (sa pile pose SOCLE_THEME), Oracle garde le sien. Aucune pile n'est
// lancée : la vitrine n'a pas Docker.
for (const [nom, titre, pile] of [['mapmylan', 'MapMyLAN', 'SOCLE_THEME: "soma"'], ['oracle', 'Oracle', 'SOCLE_CLE: "x"']]) {
  hub.db.run('INSERT INTO instances(id,ext_id,name,mode,url,stack,config,manifest,version,status,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    `vitrine-${nom}`, nom, nom, 'compose', nom === 'mapmylan' ? faux.base : `http://hub-${nom}:8090`, hub.services.nextStack(), nom === 'mapmylan' ? JSON.stringify({ HUB_ADMIN_TOKEN: 'jeton-admin-de-la-vitrine-0123456789abcdef' }) : '{}', JSON.stringify({ id: nom, name: titre, version: '1.0.0', description: '', install: { type: 'compose', ports: [], healthcheck: { type: 'http', path: '/api/health', expect: 200, timeout: '2s' } }, capabilities: { provides: [], requires: [], accepts: [] }, actions: [], triggers: [], probes: [], config: nom === 'mapmylan' ? [{ key: 'SOCLE_CLE', type: 'secret' }] : [], ...(nom === 'mapmylan' ? { accounts: { tokenKey: 'HUB_ADMIN_TOKEN', invitation: true, roles: ['admin', 'membre', 'lecture'], fields: { id: '$.id', name: '$.identifiant', role: '$.role', mfa: '$.a2f', created: '$.cree', lastSeen: '$.derniere' }, adminRole: 'admin', list: { method: 'GET', path: '/api/compte/hub/comptes' }, create: { method: 'POST', path: '/api/compte/hub/comptes' }, update: { method: 'PATCH', path: '/api/compte/hub/comptes/{{params.id}}' }, reset: { method: 'POST', path: '/api/compte/hub/comptes/{{params.id}}/reinit' }, remove: { method: 'DELETE', path: '/api/compte/hub/comptes/{{params.id}}' } } } : {}), autoWorkflows: [], permissions: {} }), '1.0.0', 'online', Date.now());
  fs.mkdirSync(path.join(dossier, 'stacks', nom), { recursive: true });
  // Oracle en panne : le détail de l'état s'affiche sous son nom.
  if (nom === 'oracle') hub.db.run('UPDATE instances SET status=?, status_detail=? WHERE id=?', 'offline', 'connect ECONNREFUSED hub-oracle:80', `vitrine-${nom}`);
  fs.writeFileSync(path.join(dossier, 'stacks', nom, 'compose.yml'), `services:\n  ${nom}:\n    environment:\n      ${pile}\n`);
}
// SYNAPSE, hors socle : ses comptes par une API à lui, décrite dans le manifeste.
hub.db.run("UPDATE instances SET manifest = json_set(manifest, '$.accounts', json(?)), config = json_set(config, '$.HUB_ADMIN_TOKEN', ?) WHERE name = 'synapse'",
  JSON.stringify({ tokenKey: 'HUB_ADMIN_TOKEN', roles: ['admin', 'user', 'reader'], adminRole: 'admin', fields: { id: '$.id', name: '$.username', role: '$.role', mfa: '$.totp', lastSeen: '$.last_login', protected: '$.origin' },
    list: { method: 'GET', path: '/api/users' }, create: { method: 'POST', path: '/api/users', body: { username: '{{params.username}}', password: '{{params.password}}', role: '{{params.role}}' } },
    update: { method: 'PATCH', path: '/api/users/{{params.id}}', body: { role: '{{params.role}}' } }, password: { method: 'POST', path: '/api/users/{{params.id}}/password', body: { password: '{{params.password}}' } },
    requireMfa: { method: 'POST', path: '/api/users/{{params.id}}/mfa' }, remove: { method: 'DELETE', path: '/api/users/{{params.id}}' } }),
  'jeton-admin-synapse-de-la-vitrine-0123456789');
// MapMyLAN publié par Relay : ses liens de comptes proposent aussi l'adresse directe.
hub.db.setSetting('publications', { 'vitrine-mapmylan': 'https://mapmylan.un-domaine-assez-long-pour-voir.example.org' });
// Relay, joint aux faux services : la page Connexions apparaît.
hub.db.run('INSERT INTO instances(id,ext_id,name,mode,url,stack,config,manifest,version,status,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
  'vitrine-relay', 'relay', 'relay', 'remote', faux.base, null, JSON.stringify(hub.vault.sealFields({ HUB_TOKEN: 'vitrine'.repeat(5) }, ['HUB_TOKEN'])),
  JSON.stringify({ id: 'relay', name: 'Relay', version: '2.0.0', description: '', icon: 'globe', install: { type: 'compose', ports: [] }, api: { baseUrl: '{{service.url}}', auth: { type: 'bearer', token: '{{service.token}}', localToken: 'HUB_TOKEN', remoteToken: 'HUB_TOKEN' } }, capabilities: { provides: ['edge.routes'], requires: [], accepts: [] }, actions: [], triggers: [], probes: [], config: [{ key: 'HUB_TOKEN', type: 'secret' }], autoWorkflows: [], permissions: {} }),
  '2.0.0', 'online', Date.now());
// Oracle propose une interface au relais, sans nom encore : publiable.
hub.db.run("UPDATE instances SET manifest = json_set(manifest, '$.install.ports', json('[{\"name\":\"http\",\"container\":8090,\"protocol\":\"http\",\"expose\":\"proxy\"}]')) WHERE id = 'vitrine-oracle'");
hub.probes.sync();
hub.ai.save({ kind: 'ollama', name: 'Ollama (local ou autre machine)', instanceId: oll.id, model: 'qwen3:8b', roles: ['config', 'workflows', 'embeddings'] }, qui);
const graphe = { nodes: [{ id: 't', type: 'trigger.manual', name: 'Départ', params: {}, x: 380, y: 200 }, { id: 'a', type: 'ai.chat', name: 'Diagnostic', params: { prompt: 'Que se passe-t-il ?' }, x: 660, y: 200 }], edges: [{ from: 't', to: 'a' }] };
hub.store.create({ name: 'Diagnostic des conteneurs', graph: graphe }, qui);
hub.store.create({ name: 'Formulaire de contact', graph: { nodes: [{ id: 'h', type: 'trigger.webhook', name: 'Formulaire reçu', params: { auth: 'hmac' }, x: 380, y: 200 }, { id: 's', type: 'data.set', name: 'Mise en forme', params: { fields: { sujet: '{{ $json.sujet }}' } }, x: 660, y: 200 }], edges: [{ from: 'h', to: 's' }] } }, qui);
hub.store.creerDossier('Surveillance / Alertes', qui);
hub.secrets.poser({ service: 'telegram', champs: { BOT_TOKEN: '1:jeton-de-demonstration', CHAT_ID: '-100' } }, qui);
hub.secrets.poser({ nom: 'Outil Maison', champs: { API_KEY: 'cle-de-demonstration' }, site: '' }, qui);
hub.destinations.poser(['nas.lan', '10.0.20.0/24', 'imprimante-du-bureau-au-fond-du-couloir.lan'], qui);
// Mesures de démonstration (inventées) : sept jours de tranches, puis un faux
// Docker et un faux hub-mesure dont les compteurs avancent avec l'horloge.
{
  const T = 300e3, fin = Math.floor(Date.now() / T) * T;
  let graine = 7;
  const alea = () => (graine = (graine * 16807) % 2147483647) / 2147483647;
  const parts = { 'mapmylan': 2.2, 'synapse': 1, 'docker-control': 0.5, 'relay': 1.6, 'Hub': 0.3, 'Autres conteneurs': 0.8 };
  hub.db.tx(() => {
    for (let t = fin - 7 * 864e5; t < fin; t += T) {
      const h = new Date(t).getUTCHours(), activite = 0.25 + 0.75 * Math.max(0, Math.sin((h - 5) / 24 * 2 * Math.PI)), bruit = () => 0.8 + alea() * 0.4;
      const panne = t > fin - 3 * 864e5 && t < fin - 3 * 864e5 + 2 * 3600e3 ? 2 : t > fin - 26 * 3600e3 ? 1 : 0;
      let ext = 0, cont = 0, extTx = 0, contTx = 0;
      for (const [g, k] of Object.entries(parts)) {
        const rx = 90e3 * k * activite * bruit(), tx = rx * (0.3 + alea() * 0.3);
        hub.db.run('INSERT INTO mesures_groupes (t, groupe, rx, tx, cpu, mem) VALUES (?,?,?,?,?,?)', t, g, rx, tx, k * 2.1 * activite * bruit(), k * 180e6);
        cont += rx; contTx += tx; if (g !== 'Hub' && g !== 'Autres conteneurs') { ext += rx; extTx += tx; }
      }
      hub.db.run('INSERT INTO mesures (t, hote_rx, hote_tx, hote_cpu, hote_mem, ext_rx, ext_tx, cont_rx, cont_tx, ext_cpu, ext_mem, svc_total, svc_ok) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        t, cont * 1.6 + 40e3, contTx * 1.4 + 15e3, 12 + 38 * activite * bruit(), 52 + 9 * activite, ext, extTx, cont, contTx, 9 * activite * bruit(), 1.2e9, 6, 6 - panne);
    }
  });
  const debut = Date.now(), ecoule = () => (Date.now() - debut) / 1000;
  const conteneurs = [['a', 'hub-mapmylan', 210e3], ['b', 'hub-relay', 150e3], ['c', 'hub', 30e3], ['d', 'perso', 70e3]];
  hub.mesures.docker = async chemin => {
    if (chemin === '/info') return { NCPU: 8 };
    if (chemin === '/containers/json') return conteneurs.map(([Id, p]) => ({ Id, Labels: { 'com.docker.compose.project': p } }));
    const [, , debit] = conteneurs.find(([id]) => chemin.includes(`/${id}/`));
    return { cpu_stats: { cpu_usage: { total_usage: ecoule() * 0.4e9 } }, memory_stats: { usage: 260e6, stats: { inactive_file: 40e6 } }, networks: { eth0: { rx_bytes: Math.round(ecoule() * debit), tx_bytes: Math.round(ecoule() * debit * 0.4) } } };
  };
  const mesure = path.join(dossier, 'mesure');
  fs.mkdirSync(mesure);
  hub.mesures.dossier = mesure;
  const ecrire = () => { const e = ecoule(); fs.writeFileSync(path.join(mesure, 'hote'), `t ${Math.floor(Date.now() / 1000)}\ncpu  ${Math.round(e * 230)} 0 0 ${Math.round(e * 570)} 0 0 0 0\nMemTotal: 16000000 kB\nMemAvailable: 6900000 kB\nif eth0 ${Math.round(e * 820e3)} ${Math.round(e * 240e3)}\n`); };
  ecrire(); setInterval(ecrire, 1000).unref();
}
await hub.startBackground();
setTimeout(() => hub.mesures.releve(), 3000);
faux.state.planResponse = { reply: 'Voici l’état :\n- **ollama-gpu-pc** en ligne\n- **synapse** en ligne\n\n| Service | État |\n|---|---|\n| docker-control | en ligne |', steps: [] };
console.log(`Hub de démonstration sur http://localhost:${port} — jeton d’installation : ${jeton}`);
