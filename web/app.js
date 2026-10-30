// Interface du Hub : coque, pages et assistant. La porte du socle gère la
// connexion ; tout ce qui suit suppose une session complète, et le serveur
// revérifie chaque droit.
import { porte, pageSecurite, pageComptes, basculeTheme, appliquerTheme, icone, boutonDevoiler } from '/socle/compte.js';
import { courbe, jauge, calendrier } from '/socle/graphes.js';
import { I, P } from './icons.js';
import { $, $$, html, poser, rendre, element, api, session, GET, POST, PUT, PATCH, DEL, toast, fail, pulse, modal, confirmBox, formulaire, readForm, bindDynamic, when, sparkSvg, statusTag, originChip, ecouterApercu } from './lib.js';
import { openEditor } from './editor.js';
import { basculerVoix, monter as monterVoix, tourVocal, rejouer, arreter as arreterVoix, brancher as brancherVoix } from './voix.js';
import { surveiller as surveillerListes } from './choix.js';

// Les logos de Hub, dans la couleur du texte (mêmes tracés que le dossier
// Logo) : la marque seule pour les tuiles et l'écran de connexion, le logo
// complet avec le nom pour la barre.
const LOGO_NS = 'http://www.w3.org/2000/svg';
function dessinLogo(vb, traces, largeur, hauteur, nom) {
  const s = document.createElementNS(LOGO_NS, 'svg');
  s.setAttribute('width', largeur); s.setAttribute('height', hauteur); s.setAttribute('viewBox', vb);
  if (nom) { s.setAttribute('role', 'img'); s.setAttribute('aria-label', nom); } else s.setAttribute('aria-hidden', 'true');
  for (const [d, regle] of traces) {
    const p = document.createElementNS(LOGO_NS, 'path');
    p.setAttribute('d', d); p.setAttribute('fill', 'currentColor');
    if (regle) p.setAttribute('fill-rule', regle);
    s.append(p);
  }
  return s;
}
const LOGO_MARQUE = ['-29 8 204 204', [['M0 200V48L28 20V88.36A58 58 0 0 1 116 138V142A30 30 0 0 0 146 172V200A58 58 0 0 1 88 142V138A30 30 0 0 0 28 138V200Z']]];
const LOGO_TEXTE = ['-6 14 304 192', [['M0 200V48L28 20V88.36A58 58 0 0 1 116 138V142A30 30 0 0 0 176 142V48L204 20V88.36A58 58 0 0 1 292 138V142A58 58 0 0 1 204 191.64V200H176V191.64A58 58 0 0 1 88 142V138A30 30 0 0 0 28 138V200ZM204 138A30 30 0 0 1 264 138V142A30 30 0 0 1 204 142Z', 'evenodd']]];
function logoMarque(taille = 16) {
  const s = dessinLogo(LOGO_MARQUE[0], LOGO_MARQUE[1], taille, taille, '');
  s.setAttribute('class', 'logo-marque');
  return s;
}
function logoTexte(hauteur = 20) {
  const s = dessinLogo(LOGO_TEXTE[0], LOGO_TEXTE[1], Math.round(hauteur * 1.5833), hauteur, 'Hub');
  s.setAttribute('class', 'logo-texte');
  return s;
}

// Le choix clair/sombre d'avant le socle suit l'utilisateur.
try { const t = localStorage.getItem('hub-theme'); if (t && !localStorage.getItem('theme')) localStorage.setItem('theme', t); } catch { /* stockage indisponible */ }
appliquerTheme();

/* L'adresse à laquelle un humain ouvre un service. Le serveur la donne
   entière quand il connaît l'adresse de sa machine ; sinon il donne le port,
   et le nom d'hôte par lequel ce navigateur joint le Hub fait l'affaire —
   c'est la même machine. */
const hoteNav = () => location.hostname.includes(':') ? `[${location.hostname}]` : location.hostname;
const urlOuverture = o => o.url || `${o.scheme || 'http'}://${hoteNav()}:${o.port}`;
const adresseService = s => s.mode === 'remote' ? s.url : (s.open || []).length ? urlOuverture(s.open[0]) : '';

const S = { page: 'dash', wf: null, aiOpen: false, filter: 'all', extTab: 'catalog', agentBusy: false, liensCaches: (() => { try { return localStorage.getItem('hub-liens-caches') === '1'; } catch { return false; } })() };

// Événements temps réel
const listeners = new Map();
let scoped = [];
const app = {
  on(ev, fn) { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(fn); scoped.push([ev, fn]); },
  go(page, arg) { navigate(page, arg); },
};
let es;
function connectEvents() {
  es?.close();
  es = new EventSource('/api/events');
  for (const ev of ['install', 'instance', 'workflow', 'execution', 'execution.node', 'probe', 'approval', 'catalog', 'audit', 'agent.token', 'agent.ecoute']) {
    es.addEventListener(ev, m => { const d = JSON.parse(m.data); for (const fn of listeners.get(ev) || []) fn(d); });
  }
}
app.on('approval', a => toast(`Validation demandée : ${a.message}`));
/* L'écoute d'une réponse Telegram : une carte avec le temps restant ; la
   réponse reçue devient une demande à l'assistant, qu'on montre en cours. */
let minuteurEcoute = null;
function majEcoute() {
  const box = $('#aiEcoute'); if (!box) return;
  if (!S.ecoute) { box.replaceChildren(); box.hidden = true; clearInterval(minuteurEcoute); return; }
  const reste = Math.max(0, Math.round((S.ecoute.fin - Date.now()) / 1000));
  box.hidden = false;
  const cv = S.ecoute.conversation;
  const titre = cv ? `Conversation sur ${S.ecoute.canal} · échange ${cv.tour + 1}${cv.total ? '/' + cv.total : ''}` : `En écoute sur ${S.ecoute.canal}`;
  poser(box, html`<span class="onde"><i></i><i></i><i></i></span><div class="grow"><b>${titre}</b><small>Réponds dans Telegram · ${Math.floor(reste / 60)}:${String(reste % 60).padStart(2, '0')}</small></div><button class="btn sm" id="aiEcouteStop">${cv ? 'Terminer' : 'Arrêter'}</button>`);
  $('#aiEcouteStop').onclick = () => POST('/api/agent/ecoute/stop', {}).catch(fail);
}
app.on('agent.ecoute', d => {
  if (!d.fin) { S.ecoute = { canal: d.canal, fin: d.fin, conversation: d.conversation || null }; clearInterval(minuteurEcoute); minuteurEcoute = setInterval(majEcoute, 1000); majEcoute(); return; }
  S.ecoute = null; majEcoute();
  if (d.erreur) toast(`Écoute interrompue : ${d.erreur}`, 'err');
  else if (d.recu) {
    Object.assign(S, { agentBusy: true, agentAttente: true, agentAsk: `📩 Réponse reçue sur ${d.canal} : « ${d.recu} »`, agentLive: '', agentEtapes: -1, agentPhase: '' });
    if (S.aiOpen) renderAi(); else toast(`Réponse reçue sur ${d.canal}`);
  } else if (d.conversation) toast(`Conversation sur ${d.canal} terminée : pas de réponse à temps`);
  else toast(`Aucune réponse sur ${d.canal} dans le temps imparti`);
});
// La réponse de l'assistant arrive mot à mot. On écrit directement dans la
// bulle plutôt que de redessiner le panneau : redessiner ferait perdre le
// focus du champ de saisie à chaque morceau, et ferait sauter le défilement.
app.on('agent.token', d => {
  if (d.fin) {
    /* Une demande retrouvée après un changement de page : ce n'est pas notre
       `ask()` qui l'attend, c'est cet événement qui dit qu'elle est finie. */
    if (d.termine && S.agentAttente) { S.agentAttente = false; S.agentBusy = false; S.agentAsk = ''; S.agentLive = ''; S.agentPhase = ''; renderAi(); }
    return;
  }
  S.agentLive = d.text; S.agentEtapes = d.etapes ?? -1; S.agentPhase = d.phase || S.agentPhase || '';
  const bulle = $('#aiLive');
  if (!bulle) return;
  poser(bulle, rendu(d.text));
  // La phrase est écrite, le modèle rédige encore les étapes : on le dit,
  // sinon l'attente ressemble à une réponse terminée et le plan surgit.
  const note = $('#aiEtapes');
  if (note) note.textContent = noteEtapes();
  const ms = $('#msgs');
  if (ms) ms.scrollTop = ms.scrollHeight;
});
scoped = [];

function noteEtapes() {
  if (S.agentPhase === 'vérification') return 'Le Hub a trouvé des erreurs dans le plan : l’IA le corrige…';
  return S.agentEtapes < 0 ? '' : S.agentEtapes === 0 ? 'Prépare le plan…'
    : `Prépare le plan — ${S.agentEtapes} étape${S.agentEtapes > 1 ? 's' : ''}…`;
}

// Démarrage
async function boot() {
  const etat = await porte({ api, service: 'Hub', marque: logoMarque(20), sousTitre: 'centre de contrôle' });
  session.user = etat.session.compte.identifiant;
  session.role = etat.session.compte.role;
  surveillerListes();
  connectEvents();
  // Le fuseau du navigateur : les heures envoyées par les workflows seront les tiennes.
  GET('/api/fuseau').then(f => { const tz = Intl.DateTimeFormat().resolvedOptions().timeZone; if (!f.fuseau && tz && session.role === 'admin') PUT('/api/fuseau', { fuseau: tz }).catch(() => {}); }).catch(() => {});
  const hash = location.hash.slice(1).split('/');
  /* #assistant?q=… : une autre IA (MapMyLAN…) passe la main au Hub pour une
     action qui est de son ressort. La demande est pré-remplie, pas envoyée :
     c'est ici qu'on la relit et qu'on la valide. */
  if (/^assistant\b/.test(hash[0])) {
    let q = '';
    try { q = new URLSearchParams(hash[0].split('?')[1] || '').get('q') || ''; } catch { /* adresse illisible : rien de pré-rempli */ }
    navigate('dash');
    history.replaceState(null, '', location.pathname + '#dash');
    if (!S.aiOpen) toggleAi();
    if (q) { S.aiPreRempli = q.slice(0, 2000); renderAi(); }
  } else if (hash[0] === 'wf' && hash[1]) navigate('editor', hash[1]); else navigate(hash[0] || 'dash');
  // Le catalogue se relit à chaque chargement (le serveur en espace deux de
  // suite) : une version poussée sur GitHub se voit sans rien cliquer.
  if (session.role === 'admin') {
    POST('/api/catalog/refresh', { auto: true }).then(annoncerMisesAJour).catch(() => {});
    proposerIa().catch(() => {});
  }
}

/* Première fois, sans IA : l'assistant configure le Hub à ta place, encore
   faut-il lui en donner une. Proposé une fois ; « Plus tard » ne revient pas. */
async function proposerIa() {
  try { if (localStorage.getItem('hub-ia-plus-tard')) return; } catch { /* stockage indisponible : on propose */ }
  const ai = await GET('/api/ai');
  if (ai.connections.length) return;
  const choix = [['ollama', 'chip', 'Ollama', 'Sur cette machine ou un autre ordinateur du réseau'], ['anthropic', 'key', 'Claude', 'Clé API Anthropic'], ['openai', 'key', 'GPT', 'Clé API OpenAI'], ['gemini', 'key', 'Gemini', 'Clé API Google'], ['kimi', 'key', 'Kimi', 'Clé API Moonshot']];
  modal({
    title: 'Quelle IA ?', sub: 'L’assistant configure le Hub à ta place. Choisis une IA maintenant ou plus tard dans la page IA.',
    body: html`<div class="choix">${choix.map(([k, ic, nom, d]) => html`<button type="button" class="opt" data-k=${k}><span class="ic">${I(ic)}</span><div><b>${nom}</b><p>${d}</p></div></button>`)}</div>`,
    actions: [{ label: 'Plus tard', cls: 'flat', run: () => { try { localStorage.setItem('hub-ia-plus-tard', '1'); } catch { /* rien */ } } }],
    onOpen: (m, fermer) => $$('[data-k]', m).forEach(b => { b.onclick = () => { fermer(); aiDialog({ kind: b.dataset.k, roles: ['config', 'workflows', 'embeddings'] }); }; }),
  });
}

/* Les services dont le catalogue propose une version plus récente : un
   compteur sur « Extensions », et une annonce par version, pas à chaque page. */
async function annoncerMisesAJour() {
  const inst = await GET('/api/instances');
  const maj = inst.filter(i => i.miseAJour);
  counts.majs = maj.length;
  peindreCompteExt(inst);
  let vues = [];
  try { vues = JSON.parse(sessionStorage.getItem('hub_maj_vues') || '[]'); } catch { /* stockage indisponible */ }
  const neuves = maj.filter(i => !vues.includes(`${i.id}@${i.miseAJour}`));
  if (neuves.length) {
    toast(neuves.length === 1 ? (neuves[0].imageNeuve ? `Mise à jour disponible : nouvelle image de ${neuves[0].ext.name} construite sur la machine` : (neuves[0].remplacePar ? `Mise à jour disponible : ${neuves[0].ext.name} devient ${neuves[0].remplacePar.name} ${neuves[0].miseAJour}` : `Mise à jour disponible : ${neuves[0].ext.name} ${neuves[0].miseAJour} (installé : ${neuves[0].version})`)) : `${neuves.length} mises à jour disponibles — Extensions → Mes services`);
    try { sessionStorage.setItem('hub_maj_vues', JSON.stringify([...vues, ...neuves.map(i => `${i.id}@${i.miseAJour}`)].slice(-50))); } catch { /* stockage indisponible */ }
  }
  if (S.page === 'ext') navigate('ext');
}
function peindreCompteExt(inst) {
  const c = $('[data-cnt="ext"]'); if (!c) return;
  const maj = inst.filter(i => i.miseAJour).length;
  poser(c, maj ? html`<span class="maj-pastille" title="${maj} mise(s) à jour">${maj} maj</span>` : String(inst.length));
}

// Coque
const NAV = [
  ['Supervision', [['dash', 'Vue d’ensemble', 'overview'], ['probes', 'Sondes', 'chart'], ['liens', 'Liens', 'map'], ['conn', 'Connexions', 'globe']]],
  ['Services', [['ext', 'Extensions', 'devices'], ['wf', 'Workflows', 'libre'], ['users', 'Comptes services', 'users'], ['secrets', 'Clés & API', 'key']]],
  ['Intelligence', [['ai', 'Assistant', 'sparkle'], ['ia', 'IA', 'chip']]],
  ['Suivi', [['journal', 'Journal', 'logs'], ['theme', 'Thème', 'mode'], ['settings', 'Réglages', 'settings']]],
  ['Compte', [['securite', 'Sécurité', 'shield'], ['comptes', 'Comptes du Hub', 'user']]],
];
const ADMIN_SEUL = new Set(['users', 'secrets', 'comptes', 'journal', 'ia']);
const navVisible = k => session.role === 'admin' || !ADMIN_SEUL.has(k);
let counts = {};
/* Le cadre — rail, barre du haut, panneau de l'assistant — se construit une
   fois. Changer de page ne remplace que la page : l'assistant garde sa
   conversation, son défilement, ce qui est tapé et ce qu'il est en train de
   faire. Le reconstruire à chaque clic, c'était le recharger à chaque clic. */
function shell() {
  if (!$('#appFrame')) {
    document.body.append(element(html`<div class="app" id="appFrame">
    <nav class="rail" aria-label="Navigation"><div class="mark">${logoTexte(20)}<span class="g logo-replie">${logoMarque(16)}</span><span class="pulse"></span></div>
      ${NAV.map(([g, items]) => html`<div class="grp"><span>${g}</span>${items.filter(([k]) => navVisible(k)).map(([k, l, ic]) => html`<button class="nav" type="button" data-go=${k} title=${l}>${I(ic)}<span>${l}</span><span class="cnt" data-cnt=${k}>${counts[k] ?? ''}</span></button>`)}</div>`)}
      <div class="railcard" id="railcard"><div class="row">${I('user', 14)}Compte<b>${session.user}</b></div><div class="row">${I('server', 14)}Services<b id="rcSvc">—</b></div><div class="row">${I('sparkle', 14)}IA<b id="rcAi">—</b></div></div>
    </nav>
    <div class="voile-rail"></div>
    <div class="main">
      <header class="top"><button class="ghost menu" type="button" aria-label="Menu">${icone('menu')}</button><div class="grow"></div>
        <div class="topright" id="topright"><button class="ghost" type="button" id="logout" aria-label="Se déconnecter" title="Se déconnecter">${I('power')}</button><span class="who" title=${session.user}>${session.user.slice(0, 2).toUpperCase()}</span></div></header>
      <div class="stage" id="stage"><div class="page" id="page"></div></div>
    </div></div>`));
    const cadre = $('#appFrame');
    $('#topright').prepend(basculeTheme());
    $$('[data-go]').forEach(b => { b.onclick = () => { cadre.classList.remove('menu-ouvert'); b.dataset.go === 'ai' ? toggleAi() : navigate(b.dataset.go); }; });
    $('.top .menu').onclick = () => cadre.classList.toggle('menu-ouvert');
    $('.voile-rail').onclick = () => cadre.classList.remove('menu-ouvert');
    $('#logout').onclick = async () => { es?.close(); await POST('/api/compte/deconnexion').catch(() => {}); location.hash = ''; location.reload(); };
  }
  majShell();
}
/* Ce qui dépend de la page courante ou de l'ouverture de l'assistant, sans
   rien reconstruire. */
function majShell() {
  const editing = S.page === 'editor';
  const cadre = $('#appFrame'); if (!cadre) return;
  cadre.classList.toggle('editing', editing);
  cadre.classList.toggle('aiopen', S.aiOpen);
  $$('[data-go]').forEach(b => b.classList.toggle('on', b.dataset.go === 'ai' ? S.aiOpen : S.page === b.dataset.go || (b.dataset.go === 'wf' && editing)));
  let panel = $('#aiPanel');
  if (S.aiOpen && !panel) {
    panel = element(html`<aside class="ai" id="aiPanel" aria-label="Assistant"></aside>`);
    cadre.append(panel);
    renderAi();
  } else if (!S.aiOpen && panel) panel.remove();
  if (S.aiOpen) $('#aiBord')?.classList.remove('vu');
  $('#aiSec')?.classList.toggle('on', S.page === 'secrets');
}
async function refreshCounts() {
  try {
    const [inst, ai] = await Promise.all([GET('/api/instances'), GET('/api/ai')]);
    const on = inst.filter(i => i.status === 'online').length;
    if ($('#rcSvc')) $('#rcSvc').textContent = `${on}/${inst.length}`;
    if ($('#rcAi')) { $('#rcAi').textContent = ai.connections[0]?.name || 'aucune'; $('#rcAi').title = ai.connections[0]?.name || ''; }
    counts.ext = inst.length;
    peindreCompteExt(inst);
    // Connexions n'existe qu'avec Relay (capacité edge.routes).
    const relais = inst.some(i => i.ext?.capabilities?.provides?.includes('edge.routes'));
    $$('[data-go="conn"]').forEach(b => { b.hidden = !relais; });
  } catch { /* le cadre garde ses derniers chiffres */ }
}

let navToken = 0;
async function navigate(page, arg) {
  for (const [ev, fn] of scoped) listeners.get(ev)?.delete(fn);
  scoped = [];
  window.onbeforeunload = null;
  if (!navVisible(page)) page = 'dash';
  S.page = page; if (page === 'editor') S.wf = arg;
  location.hash = page === 'editor' ? `wf/${arg}` : page;
  shell();
  const token = ++navToken;
  // Une page neuve à chaque fois (l'éditeur retire la classe, pose ses
  // écouteurs) ; le reste du cadre ne bouge pas.
  const el = element(html`<div class="page" id="page"></div>`);
  $('#page').replaceWith(el);
  $('#stage').scrollTop = 0; window.scrollTo(0, 0);
  refreshCounts();
  const views = { dash: viewDash, ext: viewExt, wf: viewWf, editor: viewEditor, probes: viewProbes, liens: viewLiens, conn: viewConnexions, journal: viewJournal, theme: viewTheme, settings: viewSettings, ia: viewIA, users: viewUsers, secrets: viewSecrets, securite: viewSecurite, comptes: viewComptes };
  try { await (views[page] || viewDash)(el, token); }
  catch (e) { if (token === navToken) poser(el, html`<div class="errbox">${e.message}</div>`); }
}
const alive = t => t === navToken;
const headrow = (title, lede, actions = '') => html`<div class="headrow"><div><h1 class="title">${title}</h1><p class="lede">${lede}</p></div><div class="actions">${actions}</div></div>`;

// Compte (pages du socle)
async function viewSecurite(el) { poser(el, await pageSecurite(api, { service: 'Hub', confidentialite: '/confidentialite.txt' })); }
async function viewComptes(el) { poser(el, await pageComptes(api, { service: 'Hub' })); }

// Vue d'ensemble
/* Vue d'ensemble : ce qui tourne, ce qui attend quelqu'un, ce que la machine
   et les extensions consomment. Les chiffres viennent du Hub (mesures.js,
   a-traiter.js) ; ici on ne fait que dessiner. */
const nfr = (v, d = 0) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: d }).format(v);
const debit = v => { const b = (Number(v) || 0) * 8; return b >= 1e9 ? `${nfr(b / 1e9, 2)} Gb/s` : b >= 1e6 ? `${nfr(b / 1e6, 1)} Mb/s` : `${nfr(b / 1e3, 0)} kb/s`; };
const octets = v => { const n = Number(v) || 0, u = ['o', 'Ko', 'Mo', 'Go', 'To']; let i = 0, x = n; while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; } return `${nfr(x, x < 10 && i ? 1 : 0)} ${u[i]}`; };
const pc = v => (v === null || v === undefined ? '—' : `${nfr(v, 0)} %`);
const PERIODES = [['24h', '24 h'], ['7j', '7 j'], ['30j', '30 j']];
const SOURCES_TRAFIC = [['hote', 'Machine'], ['extensions', 'Extensions'], ['conteneurs', 'Tous les conteneurs']];
const NIVEAUX = { crit: ['held', 'critique'], warn: ['warn', 'à surveiller'], info: ['info', 'information'] };
S.periode = '24h'; S.trafic = null;

function axeInstants(instants, periode) {
  const f = periode === '24h' ? { hour: '2-digit', minute: '2-digit' } : periode === '7j' ? { weekday: 'short', day: 'numeric' } : { day: 'numeric', month: 'short' };
  const n = Math.min(6, instants.length);
  return {
    etiquettes: n < 2 ? [] : Array.from({ length: n }, (_, i) => new Date(instants[Math.round(i * (instants.length - 1) / (n - 1))]).toLocaleString('fr-FR', f)),
    instants: instants.map(t => new Date(t).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })),
  };
}
const zero = l => (l || []).map(v => v ?? 0);

async function viewDash(el, t) {
  let o = await GET('/api/overview');
  if (!alive(t)) return;
  let m = S.periode === '24h' ? o.mesures : await GET(`/api/mesures?periode=${S.periode}`).catch(() => o.mesures);
  if (!alive(t)) return;
  const peindre = () => poser(el, contenuDash(o, m));
  const relire = async ({ tout = true } = {}) => {
    try {
      const [no, nm] = await Promise.all([tout ? GET('/api/overview') : o, S.periode === '24h' && tout ? null : GET(`/api/mesures?periode=${S.periode}`)]);
      if (!alive(t)) return;
      o = no; m = nm || no.mesures; peindre(); brancherDash(el, relire);
    } catch (e) { if (alive(t)) fail(e); }
  };
  peindre(); brancherDash(el, relire);
  let attente = null;
  const bientot = () => { clearTimeout(attente); attente = setTimeout(() => alive(t) && relire(), 1500); };
  for (const ev of ['instance', 'approval', 'probe', 'execution', 'audit']) app.on(ev, bientot);
  const minute = setInterval(() => { if (!alive(t)) clearInterval(minute); else if (!document.hidden) relire(); }, 60e3);
}

function contenuDash(o, m) {
  const admin = session.role === 'admin';
  const at = o.aTraiter || [];
  const crit = at.filter(x => x.niveau === 'crit').length;
  const a = m?.actuel;
  const dispo = Object.fromEntries(SOURCES_TRAFIC.filter(([k]) => m?.trafic?.[k]).map(([k]) => [k, m.trafic[k]]));
  if (!dispo[S.trafic]) S.trafic = Object.keys(dispo)[0] || null;
  const maintenant = S.trafic ? a?.[S.trafic] : null;
  const serie = S.trafic ? dispo[S.trafic] : null;
  const libelleSource = (SOURCES_TRAFIC.find(([k]) => k === S.trafic) || [, 'aucune mesure'])[1];
  const cpu = a?.hote?.cpu ?? null, mem = a?.memoire ?? null;
  const fig = (ic, lbl, val, em, delta, { classe = '', tuile = '', spark = null } = {}) => html`<div class="fig ${classe}"><div class="tile ${tuile}">${I(ic)}</div><span>${lbl}</span><strong>${val}${em ? html`<em>${em}</em>` : ''}</strong><div class="delta ${classe === 'alerte' ? 'err' : ''}">${delta}</div>${spark || ''}</div>`;
  const ligne = (k, v, classe = '') => html`<div class="resume-ligne"><span>${k}</span><b class=${classe}>${v}</b></div>`;
  const d7 = m?.disponibilite?.pct;
  const periodeTxt = (PERIODES.find(([k]) => k === m?.periode) || PERIODES[0])[1];

  return html`
  <div class="rapport-tete" aria-hidden="true"><b>Hub · rapport d’exploitation</b><span>${new Date().toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'short' })} · période ${periodeTxt}</span></div>
  ${headrow('Vue d’ensemble', html`${o.services.online} services en ligne sur ${o.services.total}, ${o.workflows.enabled} workflows actifs.${o.docker ? '' : html` <span class="err">Docker est injoignable : l’installation locale est indisponible.</span>`}`,
    html`<button class="btn cache-s" data-rapport title="Imprimer ou enregistrer en PDF (A4)">${I('file', 15)}Rapport</button><button class="btn" data-ai>${I('sparkle', 15)}Assistant</button><button class="btn solid" data-nav="ext">${I('plus', 15)}Ajouter un service</button>`)}
  <div class="figs">
    ${fig('devices', 'Services en ligne', String(o.services.online), `sur ${o.services.total}`, o.services.total - o.services.online ? `${o.services.total - o.services.online} injoignable${o.services.total - o.services.online > 1 ? 's' : ''}` : 'tous joignables', { tuile: o.services.online < o.services.total ? 'warn' : '' })}
    ${fig('bell', 'À traiter', String(at.length), '', crit ? `${crit} critique${crit > 1 ? 's' : ''}` : at.length ? 'rien de critique' : 'rien en attente', { classe: crit ? 'alerte' : '', tuile: at.length ? 'warn' : '' })}
    ${fig('globe', 'Trafic réseau', maintenant ? debit(maintenant.entrant) : '—', maintenant ? '↓' : '', maintenant ? `↑ ${debit(maintenant.sortant)} · ${libelleSource.toLowerCase()}` : 'mesure en attente', { tuile: 'plain', spark: serie ? sparkSvg(zero(serie.entrant).slice(-24), 'plain') : null })}
    ${fig('gauge', 'Machine', pc(cpu), cpu === null ? '' : 'CPU', mem === null ? (a?.extensions ? `extensions : ${pc(a.extensions.cpu)} CPU, ${octets(a.extensions.memoire)}` : 'mesure en attente') : `mémoire ${pc(mem)}${m?.sources?.memoire ? ` de ${octets(m.sources.memoire)}` : ''}`, { tuile: cpu >= 85 || mem >= 90 ? 'warn' : '' })}
  </div>
  ${o.approvals.length ? html`<div class="card mb16"><header><h2>Validations en attente</h2><span class="note">${o.approvals.length}</span></header>${o.approvals.map(x => html`<div class="approval"><span class="itile key cache-s">${I('shield')}</span><p>${x.message}<small>${x.workflow} · ${when(x.created)}</small></p><div class="actions"><button class="btn sm" data-ap=${x.id} data-ok="0">Refuser</button><button class="btn solid sm" data-ap=${x.id} data-ok="1">Accepter</button></div></div>`)}</div>` : ''}
  <div class="split">
    <div class="card"><header><h2>Trafic réseau</h2><div class="pousse en-tete-choix">
        ${Object.keys(dispo).length > 1 ? html`<div class="views">${SOURCES_TRAFIC.filter(([k]) => dispo[k]).map(([k, l]) => html`<button class="view ${S.trafic === k ? 'on' : ''}" type="button" data-source=${k} aria-pressed=${String(S.trafic === k)}>${l}</button>`)}</div>` : ''}
        <div class="views">${PERIODES.map(([k, l]) => html`<button class="view ${m?.periode === k ? 'on' : ''}" type="button" data-periode=${k} aria-pressed=${String(m?.periode === k)}>${l}</button>`)}</div></div></header>
      <div class="pad">
        ${serie && serie.entrant.length ? html`<div class="releve"><strong>${debit(maintenant?.entrant ?? serie.entrant.at(-1))}</strong><span>entrants · ${libelleSource.toLowerCase()}</span><span class="pousse">pic ${debit(Math.max(...zero(serie.entrant)))} · moyenne ${debit(zero(serie.entrant).reduce((x, v) => x + v, 0) / serie.entrant.length)}</span></div>
          ${courbe({ libelle: `Trafic réseau, ${libelleSource.toLowerCase()}, ${periodeTxt}`, hauteur: 210, format: debit, ...axeInstants(m.instants, m.periode), series: [{ nom: 'Entrant', valeurs: zero(serie.entrant) }, { nom: 'Sortant', valeurs: zero(serie.sortant) }] })}`
          : html`<p class="vide">${m?.sources?.docker || m?.sources?.hote ? 'Premières mesures dans quelques minutes : une tranche toutes les cinq minutes.' : 'Aucune mesure : ni Docker ni le conteneur hub-mesure ne répondent.'}</p>`}
        ${m && !m.sources?.hote ? html`<p class="help mt10">${I('alert', 13)} Le trafic de la machine entière demande le conteneur <span class="mono">hub-mesure</span> (compose.yml). Sans lui, seuls les conteneurs sont mesurés.</p>` : ''}
      </div></div>
    <div class="card carte-pleine"><header><h2>État du Hub</h2><span class="note">7 jours</span></header>
      <div class="pad etat-hub">
        ${jauge({ valeur: d7 ?? 0, centre: d7 === null || d7 === undefined ? '—' : `${nfr(d7, 1)} %`, sous: 'en ligne', libelle: 'Part du temps où les services étaient en ligne, sept jours', etat: d7 === null || d7 === undefined ? 'g-vide' : d7 >= 99 ? 'g-ok' : d7 >= 95 ? 'g-degrade' : 'g-incident' })}
        <div class="resume">
          ${ligne('Services en ligne', `${o.services.online} / ${o.services.total}`, o.services.online < o.services.total ? 'warn' : '')}
          ${ligne('Processeur', pc(cpu), cpu >= 85 ? 'warn' : '')}
          ${ligne('Mémoire', pc(mem), mem >= 90 ? 'warn' : '')}
          ${ligne('Workflows actifs', `${o.workflows.enabled} / ${o.workflows.total}`)}
          ${ligne('Exécutions, 24 h', o.executions.errors ? `${o.executions.day} · ${o.executions.errors} en échec` : String(o.executions.day), o.executions.errors ? 'warn' : '')}
        </div></div></div>
  </div>
  <div class="colonnes mt16">
    <div class="colonne">
    <div class="card"><header><h2>À traiter<span class="nb-titre">${at.length}</span></h2></header>
      <div class="tw"><table><thead><tr><th>Élément</th><th>Observation</th><th class="cache-s fin">Depuis</th></tr></thead><tbody>
      ${at.length ? at.slice(0, 8).map(x => html`<tr class="cliquable" tabindex="0" data-aller=${x.aller}><td><b class="mono fw5 sans-retour">${x.element}</b></td><td class="principal"><span class="obs ${NIVEAUX[x.niveau][0]}" title=${NIVEAUX[x.niveau][1]}><i class="d"></i><span class="tronque">${x.observation}</span></span></td><td class="cache-s fin mono">${x.depuis ? when(x.depuis) : '—'}</td></tr>`)
        : html`<tr><td colspan="3" class="vide">Rien à traiter.</td></tr>`}
      </tbody></table></div>${at.length > 8 ? html`<p class="help pad-x">${at.length - 8} de plus : Sondes, Extensions et Workflows les détaillent.</p>` : ''}</div>
    <div class="card"><header><h2>Ressources de la machine</h2><span class="note">${periodeTxt}</span></header>
      <div class="pad">${m?.ressources?.cpu || m?.ressources?.extCpu
        ? courbe({ libelle: `Processeur et mémoire, ${periodeTxt}`, hauteur: 180, max: 100, aire: false, format: v => `${nfr(v, 0)} %`, ...axeInstants(m.instants, m.periode),
          series: [m.ressources.cpu && { nom: 'Processeur', valeurs: zero(m.ressources.cpu) }, m.ressources.memoire && { nom: 'Mémoire', valeurs: zero(m.ressources.memoire) }, m.ressources.extCpu && { nom: 'Processeur des extensions', valeurs: zero(m.ressources.extCpu) }].filter(Boolean) })
        : html`<p class="vide">Pas encore de mesure.</p>`}
        ${m?.sources?.ncpu ? html`<p class="help mt10">${m.sources.ncpu} processeur${m.sources.ncpu > 1 ? 's' : ''}${m.sources.memoire ? ` · ${octets(m.sources.memoire)} de mémoire` : ''}. La part des extensions est rapportée à toute la machine.</p>` : ''}</div></div>
    <div class="card"><header><h2>Services</h2><button class="note link" data-nav="ext">gérer</button></header>
      ${o.services.list.length ? html`<div class="tw"><table><thead><tr><th>Service</th><th class="cache-m">Adresse</th><th class="cache-s">Mode</th><th>État</th></tr></thead><tbody>
      ${o.services.list.map(s => html`<tr><td class="principal"><div class="who-cell"><span class="itile ${s.status === 'online' ? 'key' : ''}">${I(s.ext.icon || 'server')}</span><div><b>${s.name}</b><small>${s.ext.name} ${s.version}</small></div></div></td><td class="mono cache-m">${adresseService(s) || '—'}</td><td class="cache-s">${s.mode === 'remote' ? html`<span class="chip">distant</span>` : html`<span class="chip a">installé ici</span>`}</td><td>${statusTag(s.status)}${s.statusDetail ? html`<div class="mini">${s.statusDetail}</div>` : ''}</td></tr>`)}
      </tbody></table></div>` : html`<div class="list-empty">Aucun service. Ouvre Extensions pour installer ou connecter ton premier service.</div>`}
    </div>
    </div>
    <div class="colonne">
    <div class="card"><header><h2>Journal d’activité</h2><span class="note">en direct</span></header>
      <div class="journal-direct">
      ${o.alerts.slice(0, 2).map(x => html`<div class="evenement ${x.level === 'crit' ? 'critique' : 'avertissement'}"><span class="ev-ic">${I('alert', 15)}</span><div class="ev-txt"><b>${`${x.instance} · ${x.probe}`}</b><span>${x.value} ${x.unit}${Object.values(x.labels || {}).length ? ' · ' + Object.values(x.labels).join(' ') : ''}</span></div></div>`)}
      ${admin ? (o.recent.length ? o.recent.slice(0, Math.max(3, 6 - Math.min(2, o.alerts.length))).map(r => html`<div class="evenement"><span class="ev-ic">${I(actionIcon(r.action), 15)}</span><div class="ev-txt"><b>${labelAction(r)}</b><span>${r.actor}</span></div><time datetime=${new Date(r.ts).toISOString()}>${when(r.ts)}</time></div>`) : html`<p class="vide">Rien pour l’instant.</p>`)
        : o.alerts.length ? '' : html`<p class="vide">Le journal des actions est réservé aux administrateurs.</p>`}
      </div>${admin ? html`<button class="note link lien-pied" data-nav="journal">Tout le journal</button>` : ''}</div>
    <div class="card"><header><h2>Consommation par extension</h2><span class="note">${periodeTxt}</span></header>
      ${consommation(m?.top || [])}</div>
    <div class="card"><header><h2>Disponibilité</h2><span class="note">7 jours, heure par heure</span></header>
      <div class="pad">${calendrierDispo(m?.disponibilite)}
        <div class="legende-etats"><span><i class="g-ok"></i>Tous en ligne</span><span><i class="g-degrade"></i>Une partie</span><span><i class="g-incident"></i>Moins de la moitié</span><span><i class="g-vide"></i>Pas de mesure</span></div></div></div>
    </div>
  </div>`;
}

function consommation(top) {
  if (!top.length) return html`<p class="vide pad">Pas encore de mesure par extension.</p>`;
  const max = Math.max(1, ...top.map(g => g.volume));
  return html`<div class="conso">${top.slice(0, 8).map(g => html`<div class="conso-ligne" title=${`${g.nom} · ↓ ${debit(g.entrant)} · ↑ ${debit(g.sortant)} en moyenne · ${nfr(g.cpu, 1)} % CPU · ${octets(g.memoire)}`}>
    <span class="nom ${g.autres || g.hub ? 'dim' : ''}">${g.nom}</span><span class="val">${octets(g.volume)}</span>
    <span class="piste"><i style=${`width:${(g.volume / max * 100).toFixed(1)}%`}></i></span>
    <span class="sous">↓ ${debit(g.entrant)} · ↑ ${debit(g.sortant)}<span class="cache-s"> · ${nfr(g.cpu, 1)} % CPU · ${octets(g.memoire)}</span></span></div>`)}</div>`;
}

function calendrierDispo(d) {
  if (!d?.heures?.some(x => x !== null)) return html`<p class="vide">Pas encore de mesure : une case par heure, sur sept jours.</p>`;
  const cellules = d.heures.map((x, i) => ({
    etat: x === null ? 'vide' : x >= 99.9 ? 'ok' : x >= 50 ? 'degrade' : 'incident',
    titre: `${new Date(d.debut + i * 3600e3).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} : ${x === null ? 'pas de mesure' : `${nfr(x, 1)} % des services en ligne`}`,
  }));
  const lignes = Array.from({ length: 7 }, (_, j) => new Date(d.debut + j * 864e5).toLocaleDateString('fr-FR', { weekday: 'short' }));
  return calendrier({ cellules, colonnes: 24, lignes, libelle: 'Part des services en ligne, heure par heure, sur sept jours', cote: 11, ecart: 3 });
}

function brancherDash(el, relire) {
  bindCommon(el);
  $$('[data-ap]', el).forEach(b => { b.onclick = async () => { try { await POST(`/api/approvals/${encodeURIComponent(b.dataset.ap)}`, { approved: b.dataset.ok === '1' }); toast('Décision enregistrée'); relire(); } catch (e) { fail(e); } }; });
  $$('[data-periode]', el).forEach(b => { b.onclick = () => { S.periode = b.dataset.periode; relire({ tout: false }); }; });
  $$('[data-source]', el).forEach(b => { b.onclick = () => { S.trafic = b.dataset.source; relire({ tout: false }); }; });
  $$('[data-aller]', el).forEach(tr => {
    const aller = () => { if (tr.dataset.aller !== 'dash') navigate(tr.dataset.aller); else $('.approval', el)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
    tr.onclick = aller;
    tr.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); aller(); } };
  });
  const r = $('[data-rapport]', el);
  if (r) r.onclick = () => window.print();
}
const actionIcon = a => (a.startsWith('workflow') ? 'libre' : a.startsWith('service') ? 'server' : a.startsWith('ia') ? 'sparkle' : a.startsWith('connexion') || a.startsWith('mfa') ? 'key' : a.startsWith('journal') ? 'logs' : 'check');
const ACTIONS = { 'workflow.créé': 'Workflow créé', 'workflow.activé': 'Workflow activé', 'workflow.coupé': 'Workflow coupé', 'workflow.modifié': 'Workflow modifié', 'workflow.supprimé': 'Workflow supprimé', 'workflow.test': 'Test lancé', 'service.connexion': 'Service distant connecté', 'service.installation': 'Service installé', 'service.suppression': 'Service retiré', 'service.échec': 'Échec d’ajout de service', 'capacité.liée': 'Capacité reliée', 'connexion': 'Connexion', 'connexion.échec': 'Connexion refusée', 'ia.plan': 'Plan proposé par l’IA', 'ia.plan_exécuté': 'Plan de l’IA exécuté', 'ia.ajoutée': 'IA ajoutée', 'catalogue.actualisé': 'Catalogue actualisé', 'validation.acceptée': 'Validation acceptée', 'validation.refusée': 'Validation refusée' };
Object.assign(ACTIONS, {'action.lancée': 'Action lancée', 'alertes.essai': 'Alerte d’essai envoyée', 'alertes.mise_a_jour_lancée': 'Mise à jour lancée depuis une alerte', 'alertes.mise_a_jour_reportée': 'Mise à jour reportée', 'alertes.réglées': 'Alertes réglées', 'apparence.modifiée': 'Apparence modifiée', 'coffre.tourné': 'Clé du coffre tournée', 'compte.a2f_exigée': 'A2F exigée pour un compte', 'compte.créé': 'Compte créé', 'compte.invité': 'Compte invité', 'compte.lien_réinitialisation': 'Lien de réinitialisation créé', 'compte.modifié': 'Compte modifié', 'compte.mot_de_passe': 'Mot de passe changé', 'compte.supprimé': 'Compte supprimé', 'comptes.a2f': 'A2F des comptes', 'connexion.appliquee': 'Relay réappliqué', 'connexion.cloudflare': 'Cloudflare connecté', 'connexion.cloudflare_retire': 'Cloudflare déconnecté', 'connexion.creee': 'Route créée', 'connexion.domaines': 'Domaines modifiés', 'connexion.exposition_retiree': 'Exposition retirée', 'connexion.hub_publie': 'Hub publié', 'connexion.hub_retire': 'Nom du Hub retiré', 'connexion.modifiee': 'Route modifiée', 'connexion.publiee': 'Service publié', 'connexion.retiree': 'Nom retiré', 'connexion.supprimee': 'Route supprimée', 'connexion.tout_en_ligne': 'Tout passé par le tunnel', 'connexion.tunnel': 'Tunnel choisi', 'connexion.tunnel_coupe': 'Tunnel coupé', 'coupure.modifiée': 'Coupure d’urgence modifiée', 'courriel.modifié': 'Courriel des comptes modifié', 'destinations.modifiées': 'Destinations internes modifiées', 'destinations.reprises': 'Destinations internes reprises', 'dossier.créé': 'Dossier créé', 'dossier.renommé': 'Dossier renommé', 'exposition.modifiée': 'Exposition modifiée', 'exécution.rejouée': 'Exécution rejouée', 'ia.autonomie': 'Autonomie de l’assistant', 'ia.canal_par_défaut': 'Canal par défaut de l’assistant', 'ia.cerveau_refusé': 'Mémoire refusée', 'ia.conversation': 'Question à l’assistant', 'ia.corrigée': 'Réponse corrigée', 'ia.hub': 'Action de l’assistant', 'ia.interrompue': 'Réponse interrompue', 'ia.lien': 'Lien IA d’un service', 'ia.modifiée': 'IA modifiée', 'ia.nouvelle_conversation': 'Nouvelle conversation', 'ia.ordre': 'Ordre des IA', 'ia.outil.connecté': 'Outil IA connecté', 'ia.outil.connexion': 'Connexion d’un outil IA lancée', 'ia.plafond': 'Plafond de l’IA atteint', 'ia.plan_refusé': 'Plan refusé', 'ia.retirée': 'IA retirée', 'ia.service_branché': 'Service branché à l’IA', 'image.construite': 'Image construite', 'jeton.créé': 'Jeton d’accès créé', 'jeton.révoqué': 'Jeton d’accès révoqué', 'liens.hub': 'Liens du Hub mis à jour', 'manifeste.importé': 'Manifeste importé', 'message.essai': 'Message d’essai', 'message.écoute': 'Message reçu', 'mfa.activé': 'Second facteur activé', 'mfa.code_secours': 'Code de secours utilisé', 'mfa.échec': 'Second facteur refusé', 'registres.modifiés': 'Registres modifiés', 'secret.dévoilé': 'Clé dévoilée', 'secret.oublié': 'Clé oubliée', 'secret.posé': 'Clé enregistrée', 'service.adresse': 'Adresse d’un service changée', 'service.manifeste_actualisé': 'Manifeste repris', 'service.relié': 'Service relié', 'service.réglages': 'Réglages d’un service', 'service.secret_effacé': 'Secret d’un service effacé', 'variable.définie': 'Variable définie', 'variable.supprimée': 'Variable supprimée', 'voix.question': 'Question vocale', 'webhook.secret_renouvelé': 'Secret de webhook renouvelé', 'workflow.activation_reportée': 'Activation reportée', 'workflow.conversion_ia_échec': 'Conversion vers l’IA du Hub impossible', 'workflow.noms_réparés': 'Noms de workflows réparés', 'workflow.rangé': 'Workflow rangé', 'workflows.rangés': 'Workflows rangés', 'workflows.recréés': 'Workflows recréés', 'workflows.vers_ia_du_hub': 'Workflows passés par l’IA du Hub'});
const labelAction = r => `${ACTIONS[r.action] || r.action}${r.target ? ' : ' + r.target : ''}`;

function bindCommon(el) {
  $$('[data-nav]', el).forEach(b => { b.onclick = () => navigate(b.dataset.nav); });
  $$('[data-ai]', el).forEach(b => { b.onclick = () => { if (!S.aiOpen) toggleAi(); }; });
}

// Extensions
const pictoService = ic => (P[ic] ? ic : 'server');
async function viewExt(el, t) {
  const [cat, inst] = await Promise.all([GET('/api/catalog'), GET('/api/instances')]);
  if (!alive(t)) return;
  const onglets = html`<div class="tabs"><button class="view ${S.extTab === 'catalog' ? 'on' : ''}" data-tab="catalog">Catalogue<span class="n">${cat.items.filter(it => !inst.some(i => i.extId === it.id || i.remplacePar?.id === it.id)).length}</span></button><button class="view ${S.extTab === 'installed' ? 'on' : ''}" data-tab="installed">Mes services<span class="n">${inst.length}</span>${inst.some(i => i.miseAJour) ? html`<span class="maj-pastille">${inst.filter(i => i.miseAJour).length} maj</span>` : ''}</button><button class="view ${S.extTab === 'sources' ? 'on' : ''}" data-tab="sources">Registres</button></div>`;
  let corps;
  // Ce qui est déjà en service n'a plus sa place au catalogue : il vit dans
  // « Mes services », et c'est de là qu'on lui ajoute une deuxième machine.
  // Le catalogue répond à « qu'est-ce que je peux ajouter », pas à « qu'est-ce
  // qui existe » : une carte qu'on ne peut plus installer n'y a rien à faire.
  // Une extension qui en remplace une en service (renommage) arrive par la
  // mise à jour de celle-ci, pas par une deuxième installation.
  const posés = new Set(inst.flatMap(i => [i.extId, i.remplacePar?.id].filter(Boolean)));
  const dispo = cat.items.filter(it => !posés.has(it.id));
  if (S.extTab === 'catalog') {
    corps = dispo.length ? html`<div class="cat">${dispo.map(it => {
      const m = it.manifest;
      const caps = l => (l || []).map(c => html`<span class="chip m">${c}</span>`);
      return html`<div class="card ext">
        <header><span class="itile">${I(pictoService(m.icon))}</span><div class="grow"><h2>${m.name}</h2><p class="mini">${m.version} · ${it.source}</p></div></header>
        <div class="body"><p>${m.description}</p>
          <dl class="caps"><dt>Fournit</dt><dd>${m.capabilities.provides?.length ? caps(m.capabilities.provides) : '—'}</dd>
          ${m.capabilities.requires?.length ? html`<dt>Requiert</dt><dd>${caps(m.capabilities.requires)}</dd>` : ''}
          ${m.capabilities.accepts?.length ? html`<dt>Utilise</dt><dd>${caps(m.capabilities.accepts)}</dd>` : ''}
          <dt>Nœuds</dt><dd><span class="chip m">${m.triggers.length} décl.</span><span class="chip m">${m.actions.length} actions</span><span class="chip m">${m.probes.length} sondes</span></dd></dl>
        </div>
        <footer><span class="dim">${m.install.type === 'external' ? 'Service externe' : m.install.remote?.supported ? 'Ici ou à distance' : 'Installé ici'}</span>
          <div class="act">${m.install.type === 'compose' ? html`<button class="btn solid sm" data-add=${m.id} data-mode="compose">${I('plus', 14)}Installer</button>` : ''}${m.install.remote?.supported ? html`<button class="btn sm" data-add=${m.id} data-mode="remote">${I('globe', 14)}Connecter</button>` : ''}</div>
        </footer></div>`;
    })}</div>` : html`<div class="card list-empty">${cat.items.length ? 'Tout le catalogue est déjà en service. Retrouve-les dans « Mes services ».' : html`Catalogue vide. ${cat.errors.length ? cat.errors.map(e => html`<br><span class="err">${e.error}</span>`) : 'Vérifie les registres.'}`}</div>`;
  } else if (S.extTab === 'installed') {
    corps = html`<div class="card">${inst.length ? inst.map(i => html`<div class="flowrow svc" data-inst=${i.id} tabindex="0" role="button">
        <span class="itile ${i.status === 'online' ? 'key' : ''}">${I(pictoService(i.ext.icon))}</span>
        <div class="svc-t"><strong>${i.name}</strong><div class="chain une-ligne">${i.ext.name} ${i.version}${adresseService(i) ? html` <span class="ar">·</span> <span class="tronque" title=${adresseService(i)}>${adresseService(i)}</span>` : ''}</div>${i.statusDetail ? html`<div class="svc-detail" title=${i.statusDetail}>${i.statusDetail}</div>` : ''}</div>
        <div class="fin">
          ${(i.open || []).slice(0, 1).map(urlOuverture).filter(u => /^https?:/.test(u)).map(u => html`<a class="btn sm cache-s" href=${u} target="_blank" rel="noopener" data-lien-externe>${I('globe', 14)}Ouvrir</a>`)}
          ${i.miseAJour ? html`<button class="btn solid sm" data-maj=${i.id} title="Version ${i.version} en place">${I('refresh', 13)}<span class="cache-s">Mettre à jour · </span>${i.remplacePar ? `${i.remplacePar.name} ` : ''}${i.miseAJour}</button>` : ''}
          <span class="cache-m">${i.mode === 'remote' ? html`<span class="chip">distant</span>` : html`<span class="chip a">installé ici</span>`}</span>
          <div class="svc-etat">${statusTag(i.status)}</div>
        </div>
      </div>`) : html`<div class="list-empty">Aucun service pour l’instant.</div>`}</div>`;
  } else {
    corps = html`<div class="card"><div class="sec"><span class="itile key">${I('globe')}</span><div><h2>Registres d’extensions</h2><p>Un par ligne : <span class="mono">github-user:compte</span>, <span class="mono">github:propriétaire/dépôt@branche</span>, <span class="mono">https://…/index.json</span>, <span class="mono">dir:/chemin</span> ou <span class="mono">local</span>.</p></div></div>
      <div class="pad"><textarea class="field" id="sources">${cat.sources.join('\n')}</textarea>
      <div class="gap"></div><div class="row pied-reg"><span class="help">Dernière actualisation : ${when(cat.refreshed)}</span><div class="act"><button class="btn" id="refresh">${I('refresh', 14)}Actualiser</button><button class="btn solid" id="saveSrc">Enregistrer</button></div></div>
      ${cat.errors.length ? html`<div class="gap"></div><div class="problems"><b>Erreurs de chargement</b>${cat.errors.map((e, i) => html`${i ? html`<br>` : ''}${`${e.source}${e.id ? ' / ' + e.id : ''} : ${e.error}`}`)}</div>` : ''}</div></div>
      <div class="card"><div class="sec"><span class="itile">${I('code')}</span><div><h2>Importer un manifeste</h2><p>Pour tester une extension en développement. Un manifeste importé ne peut être utilisé qu’en mode distant.</p></div></div>
      <div class="pad"><textarea class="field" id="manifest" placeholder='{ "manifestVersion": 1, "id": "…" }'></textarea><div class="gap"></div><div class="row"><span class="grow"></span><button class="btn solid" id="import">Importer</button></div></div></div>`;
  }
  poser(el, headrow('Extensions', 'Installe un service ici en un clic, ou connecte-toi à un service qui tourne sur une autre machine. Le Hub le configure et le relie aux autres.',
    html`<button class="btn" id="refreshTop">${I('refresh', 15)}<span class="cache-s">Actualiser le catalogue</span></button>`), onglets, corps);
  $$('[data-tab]', el).forEach(b => { b.onclick = () => { S.extTab = b.dataset.tab; viewExt(el, t); }; });
  $$('[data-add]', el).forEach(b => { b.onclick = () => addServiceDialog(cat.items.find(x => x.id === b.dataset.add).manifest, b.dataset.mode); });
  $$('[data-inst]', el).forEach(r => {
    r.onclick = () => instanceDialog(r.dataset.inst);
    r.onkeydown = e => { if (e.key === 'Enter' && e.target === r) instanceDialog(r.dataset.inst); };
  });
  // « Ouvrir » part dans un onglet : la fiche du service ne s'ouvre pas derrière.
  $$('[data-lien-externe]', el).forEach(a => a.addEventListener('click', e => e.stopPropagation()));
  $$('[data-maj]', el).forEach(b => { b.onclick = e => { e.stopPropagation(); mettreAJour(b.dataset.maj, b); }; });
  // Une version plus récente au catalogue : l'onglet « Mes services » le dit d'emblée.
  if (S.extTab === 'catalog' && inst.some(i => i.miseAJour) && !S.majVu) { S.majVu = true; S.extTab = 'installed'; return viewExt(el, t); }
  // Un refresh qui ne charge rien n'est pas une information neutre : c'est
  // une panne. Le dire avec la raison, plutôt qu'un « 0 extension » qu'on
  // prend pour un succès et qui laisse chercher ailleurs pendant une heure.
  const refresh = btn => pulse(btn, async () => {
    const r = await POST('/api/catalog/refresh');
    if (!r.count && r.errors.length) throw new Error(r.errors[0].error);
    toast(`${r.count} extension(s) chargée(s)${r.errors.length ? ` · ${r.errors.length} en erreur, voir ci-dessous` : ''}`);
    setTimeout(() => alive(t) && viewExt(el, t), 1400);
    annoncerMisesAJour().catch(() => {});
  }).catch(fail);
  $('#refreshTop', el).onclick = e => refresh(e.currentTarget);
  if ($('#refresh', el)) $('#refresh', el).onclick = e => refresh(e.currentTarget);
  if ($('#saveSrc', el)) $('#saveSrc', el).onclick = e => pulse(e.currentTarget, async () => {
    await PUT('/api/catalog/sources', { sources: $('#sources', el).value.split('\n').map(s => s.trim()).filter(Boolean) });
    toast('Registres enregistrés');
    setTimeout(() => alive(t) && viewExt(el, t), 1400);
  }).catch(fail);
  if ($('#import', el)) $('#import', el).onclick = async () => { try { const m = JSON.parse($('#manifest', el).value); await POST('/api/catalog/import', { manifest: m }); toast('Manifeste importé'); S.extTab = 'catalog'; viewExt(el, t); } catch (e) { fail(e); } };
  app.on('instance', () => alive(t) && S.extTab === 'installed' && viewExt(el, t));
}

/* Le fil d'une installation ou d'une mise à jour, étape par étape. */
const CLASSES_ETAPE = { error: 'err', link: 'ln', warn: 'warn', run: '' };
const etapes = lignes => lignes.map(s => html`<div class=${CLASSES_ETAPE[s.state] ?? 'ok'}>${s.step}</div>`);

/* Mettre à jour un service : la progression s'affiche comme à l'installation. */
async function mettreAJour(id, btn) {
  const i = await GET(`/api/instances/${encodeURIComponent(id)}`);
  const lignes = [];
  const m = modal({ title: `Mise à jour de ${i.name}`, sub: `${i.ext.name} ${i.version} → ${i.remplacePar ? `${i.remplacePar.name} ` : ''}${i.miseAJour || i.version}`, body: html`<div class="term" id="majSteps"><div>Démarrage…</div></div>`, actions: [{ label: 'Fermer' }] });
  const box = $('#majSteps', m.el);
  const peindre = () => { poser(box, etapes(lignes)); box.scrollTop = box.scrollHeight; };
  const suivre = ev => { if (ev.instanceId === id) { lignes.push(ev); peindre(); } };
  app.on('install', suivre);
  try {
    await (btn ? pulse(btn, () => POST(`/api/instances/${encodeURIComponent(id)}/update`, {})) : POST(`/api/instances/${encodeURIComponent(id)}/update`, {}));
    if (i.mode !== 'compose') { lignes.push({ step: 'Manifeste repris', state: 'ok' }); peindre(); }
    toast(`${i.name} est à jour`);
  } catch (e) { lignes.push({ step: e.message, state: 'error' }); peindre(); }
  finally { listeners.get('install')?.delete(suivre); refreshCounts(); annoncerMisesAJour().catch(() => {}); }
}

// mêmes règles que server/services.js : sensitivePermissions()
function permsOf(m) {
  const p = m.permissions || {}, out = [];
  if (p.hostNetwork) out.push({ label: 'Réseau de la machine', why: 'le service partage la pile réseau de l’hôte : il voit le trafic des interfaces et ses ports ne sont plus isolés' });
  for (const c of p.capAdd || []) out.push({ label: 'Capacité ' + c, why: 'privilège noyau supplémentaire accordé au conteneur' });
  if (p.dockerSocket === 'proxy') out.push({ label: 'Accès à Docker', why: 'le service peut lister et piloter des conteneurs à travers le proxy du Hub' });
  return out;
}

function addServiceDialog(m, mode) {
  const remote = mode === 'remote';
  const perms = permsOf(m);
  // Un champ à choix fermé était écarté du formulaire d'installation : le
  // service n'existe pas encore, donc personne ne pouvait répondre. Ceux
  // dont la liste vit chez un AUTRE service, lui déjà installé, sont
  // répondables — et c'est justement là qu'on tape des noms de modèles à
  // la main, avec les fautes de frappe que ça implique.
  const fields = (m.config || []).filter(f => !(f.type === 'secret' && f.generate)
    && (!f.optionsFrom || f.optionsFrom.from?.capability));
  const r = m.install.remote || {};
  const steps = [];
  modal({
    title: `${remote ? 'Connecter' : 'Installer'} ${m.name}`,
    sub: remote ? 'Le service tourne déjà sur une autre machine.' : 'Le Hub télécharge, configure et démarre le conteneur.',
    body: html`
      <div class="formgrid">
        <div class="fl"><label for="svcName">Nom de l’instance</label><input class="field mono" id="svcName" value=${m.id}><div class="help">Minuscules, chiffres et tirets. Ex. ollama-gpu-pc</div></div>
        ${remote ? html`<div class="fl"><label for="svcUrl">${r.label || 'Adresse'}</label><div class="row nowrap-row"><input class="field mono grow" id="svcUrl" placeholder=${r.placeholder || 'http://192.0.2.50:' + (r.defaultPort || 80)}><button class="btn sm" type="button" id="testUrl">Tester</button></div><div class="help" id="testRes"></div></div>` : ''}
      </div>
      ${remote && r.setupHelp ? html`<div class="hookbox"><b>Sur l’autre machine</b><span>${r.setupHelp}</span></div>` : ''}
      ${!remote && perms.length ? html`<div class="hookbox warn"><b>Permissions demandées</b>${perms.map(p => html`<span><b>${p.label}</b> — ${p.why}</span>`)}<label class="check"><input type="checkbox" id="permOk"> J’accorde ces permissions à ${m.name}</label></div>` : ''}
      ${fields.length ? html`<div id="cfgForm">${formulaire(fields.filter(f => remote ? true : !/REMOTE|PROXY/i.test(f.key)), {}, {}, 'c')}</div>` : ''}
      <div class="term" id="steps" hidden></div>`,
    actions: [{ label: 'Annuler' }, { label: remote ? 'Connecter' : 'Installer', cls: 'solid', run: async modalEl => {
      const box = $('#steps', modalEl); box.hidden = false; poser(box, html`<div>Démarrage…</div>`);
      const onInstall = ev => { steps.push(ev); poser(box, etapes(steps)); };
      app.on('install', onInstall);
      try {
        const cfg = $('#cfgForm', modalEl) ? readForm($('#cfgForm', modalEl)) : {};
        if (!remote && perms.length && !$('#permOk', modalEl)?.checked) { poser(box, html`<div class="err">Coche la case des permissions pour installer.</div>`); listeners.get('install')?.delete(onInstall); return false; }
        const inst = await POST('/api/instances', { extId: m.id, name: $('#svcName', modalEl).value.trim(), mode: remote ? 'remote' : 'compose', url: remote ? $('#svcUrl', modalEl).value.trim() : undefined, config: cfg, acceptPermissions: perms.length > 0 });
        listeners.get('install')?.delete(onInstall);
        toast(`${inst.name} est en ligne`);
        S.extTab = 'installed';
        if (m.id === 'ollama') {
          const ai = await GET('/api/ai');
          if (!ai.connections.length && await confirmBox('Utiliser cet Ollama pour l’assistant ?', 'Aucune IA n’est encore configurée. Le Hub peut utiliser cette instance pour l’assistant, les workflows et les embeddings.', 'Oui, l’utiliser', false)) {
            await POST('/api/ai', { kind: 'ollama', name: inst.name, instanceId: inst.id, roles: ['config', 'workflows', 'embeddings'] });
            toast('Ollama branché sur l’assistant. Choisis le modèle dans Réglages.');
          }
        }
        navigate('ext');
      } catch (e) {
        listeners.get('install')?.delete(onInstall);
        // Le message d'échec est déjà arrivé par le flux d'installation :
        // ne pas l'écrire deux fois.
        const deja = steps.some(st => st.state === 'error' && st.step === e.message);
        if (!deja) box.append(element(html`<div class="err">${e.message}${e.details?.candidates ? ' — à installer d’abord : ' + e.details.candidates.join(', ') : ''}</div>`));
        return false;
      }
    } }],
    onOpen: async m2 => {
      // Les listes qui vivent chez un autre service se chargent tout de
      // suite : l'utilisateur choisit un modèle au lieu de l'écrire.
      bindDynamic(m2, { extId: m.id }, 'config', null);
      // Et ce qu'un service déjà installé sait déjà — son adresse, ses
      // modèles — est rempli sans rien demander. L'utilisateur voit d'où
      // ça vient et peut corriger : c'est une avance, pas un verrou.
      try {
        const resolus = await GET(`/api/catalog/${encodeURIComponent(m.id)}/resolve`);
        for (const [cle, r2] of Object.entries(resolus)) {
          const champ = [...m2.querySelectorAll('[data-key]')].find(x => x.dataset.key === cle);
          if (!champ) continue;
          // Ne pas écraser ce que l'utilisateur a saisi — mais le défaut du
          // manifeste n'est pas une saisie : personne ne l'a choisi.
          const def = (m.config || []).find(f => f.key === cle)?.default;
          if (champ.value && champ.value !== String(def ?? '')) continue;
          if (champ.tagName === 'SELECT' && ![...champ.options].some(o => o.value === r2.valeur)) champ.prepend(element(html`<option value=${r2.valeur}>${r2.valeur}</option>`));
          champ.value = r2.valeur;
          const aide = champ.closest('.fl')?.querySelector('.help');
          if (aide) aide.prepend(element(html`<b>Repris de ${r2.service}.</b>`), ' ');
        }
      } catch { /* aucun fournisseur installé : on laisse la saisie */ }
      const tb = $('#testUrl', m2);
      if (tb) tb.onclick = async () => {
        const res = $('#testRes', m2);
        res.textContent = 'Test…';
        try { const r2 = await POST(`/api/catalog/${encodeURIComponent(m.id)}/test-remote`, { url: $('#svcUrl', m2).value.trim() }); poser(res, r2.ok ? html`<span class="ok-t">Joignable</span>` : html`<span class="err">Injoignable : ${r2.error}</span>`); }
        catch (e) { poser(res, html`<span class="err">${e.message}</span>`); }
      };
    },
  });
}

async function instanceDialog(id) {
  const i = await GET(`/api/instances/${encodeURIComponent(id)}`);
  const m = i.manifest;
  const cfgFields = m.config || [];
  const base = `/api/instances/${encodeURIComponent(i.id)}`;
  const admin = session.role === 'admin';
  modal({
    wide: true, title: i.name, sub: `${m.name} ${i.version} · ${i.mode === 'remote' ? 'distant' : 'installé ici'}${adresseService(i) ? ` · ${adresseService(i)}` : ''}`,
    body: html`
      ${i.miseAJour ? html`<div class="maj-bandeau"><span class="itile key cache-s">${I('refresh', 16)}</span><div class="grow"><b>${i.imageNeuve ? 'Nouvelle image construite sur la machine' : i.remplacePar ? `${i.ext.name} devient ${i.remplacePar.name} ${i.miseAJour}` : `Version ${i.miseAJour} disponible`}</b><span class="mini">${i.imageNeuve ? 'Même version, code plus récent : elle n’a pas encore remplacé celle qui tourne. ' : `En place : ${i.version}. `}${i.remplacePar && i.mode === 'compose' ? 'Même service sous son nouveau nom : réglages, données et adresses publiées suivent ; l’ancien volume reste intact, et tout revient comme avant si le nouveau ne démarre pas.' : i.mode === 'compose' ? 'Le Hub reprend le manifeste, retélécharge les images et relance la pile — les volumes et les données restent.' : 'Service distant : le Hub reprend le nouveau manifeste ; le service se met à jour sur sa machine.'}</span></div><button class="btn solid sm" id="majNow">${I('refresh', 13)}Mettre à jour</button></div>` : ''}
      <div class="svc-tete"><div class="row">${statusTag(i.status)}<span class="mini">${i.statusDetail || ''}</span></div><div class="svc-act"><button class="btn sm" id="check">${I('refresh', 13)}Vérifier</button>${admin ? html`<button class="btn sm" id="syncMan" title="Reprendre le manifeste publié dans le catalogue">${I('export', 13)}Manifeste</button>` : ''}${admin && i.mode === 'compose' ? html`<button class="btn sm" id="redeploy" title="Reprendre le manifeste, re-rendre le Compose et relancer la pile. Les volumes ne sont pas touchés.">${I('refresh', 13)}Redéployer</button><button class="btn sm" id="logs">${I('logs', 13)}Journaux</button>` : ''}${admin && m.install.remote?.supported ? html`<button class="btn sm" id="autreMachine" title="Le même service, sur une autre machine : une seconde instance, avec ses propres réglages.">${I('globe', 13)}Autre machine</button>` : ''}</div></div>
      ${i.mode === 'remote' ? html`<div class="fl"><label for="iUrl">Adresse</label><input class="field mono" id="iUrl" value=${i.url}></div>` : ''}
      ${(i.open || []).length && i.mode !== 'remote' ? html`<div class="hookbox"><b>Ouvrir le service</b>${i.open.map(o => html`<span><a class="link" href=${urlOuverture(o)} target="_blank" rel="noopener">${urlOuverture(o)}</a> — ${o.label}${o.host ? ', depuis cette machine (tunnel SSH depuis ailleurs)' : ''}</span>`)}<span class="mini">Entre services, le Hub utilise ${i.url} : ce nom ne résout que sur son réseau Docker.</span></div>` : ''}
      ${cfgFields.length ? html`<div id="iCfg">${formulaire(cfgFields, i.config, { instanceId: i.id }, 'i')}</div>` : ''}
      <div class="formgrid">
        <div><span class="lab">Déclencheurs</span><div class="help">${m.triggers.map(x => x.name).join(', ') || '—'}</div></div>
        <div><span class="lab">Sondes</span><div class="help">${m.probes.map(x => x.name).join(', ') || '—'}</div></div>
      </div>
      <div><span class="lab">Actions</span><div class="row avec-marge">${m.actions.length ? m.actions.map(a => html`<button class="btn sm ${a.risk === 'destructive' ? 'danger' : ''}" data-act=${a.id}>${a.name}</button>`) : '—'}</div></div>
      <div><span class="lab">Workflows qui l’utilisent</span><div class="help">${i.workflows.map(w => `${w.name} (${w.origin})`).join(', ') || 'aucun'}</div>
        ${(m.autoWorkflows || []).length ? html`<div class="row avec-marge"><button class="btn sm" id="recreer" title="Recrée ceux que ${m.name} déclare et qui ont été supprimés. Ceux qui existent ne sont pas touchés.">${I('refresh', 13)}Recréer les workflows automatiques</button><span class="mini">${m.autoWorkflows.length} déclaré${m.autoWorkflows.length > 1 ? 's' : ''} : ${m.autoWorkflows.map(a => a.name).join(', ')}</span></div>` : ''}</div>
      <div id="out"></div>`,
    actions: [
      { label: 'Retirer le service', cls: 'danger', run: async () => new Promise(resolve => {
        modal({ title: `Retirer ${i.name} ?`, body: html`<p>Les workflows automatiques liés seront supprimés. Les workflows que tu as créés resteront mais seront à corriger.</p>${i.mode === 'compose' ? html`<label class="check"><input type="checkbox" id="delVol"> Supprimer aussi les volumes (données)</label>` : ''}`,
          actions: [{ label: 'Annuler', run: () => resolve(false) }, { label: 'Retirer', cls: 'solid danger', run: async me => {
            const r = await DEL(`${base}${$('#delVol', me)?.checked ? '?volumes=1' : ''}`);
            toast(`${i.name} retiré${r.brokenWorkflows.length ? ` · à corriger : ${r.brokenWorkflows.join(', ')}` : ''}`);
            resolve(true); navigate('ext');
          } }] });
      }) },
      { label: 'Fermer' },
      { label: 'Enregistrer', cls: 'solid', run: async me => {
        const body = {};
        if ($('#iUrl', me)) body.url = $('#iUrl', me).value.trim();
        if ($('#iCfg', me)) {
          // Seulement ce qui a changé : un secret affiché masqué n'est pas une modification.
          const lu = readForm($('#iCfg', me), { keepEmpty: false });
          body.config = Object.fromEntries(Object.entries(lu).filter(([k, v]) => !String(v).startsWith('•') && JSON.stringify(v) !== JSON.stringify(i.config?.[k])));
        }
        await PATCH(base, body);
        // Un service installé ici lit ses réglages au démarrage : sans
        // redéploiement, « enregistré » ne changeait rien à ce qu'il fait.
        if (i.mode === 'compose' && body.config && Object.keys(body.config).length) {
          toast('Réglages enregistrés — relance du service…');
          await POST(`${base}/redeploy`, {});
          toast('Réglages appliqués, service relancé');
        } else toast('Réglages enregistrés');
      } },
    ],
    onOpen: (me, fermer) => {
      if ($('#iCfg', me)) bindDynamic($('#iCfg', me), i.id, 'config', null);
      if ($('#majNow', me)) $('#majNow', me).onclick = () => { fermer(); mettreAJour(i.id); };
      $('#check', me).onclick = () => pulse($('#check', me), async () => {
        const r = await POST(`${base}/check`);
        if (!r.ok) throw new Error(`Injoignable : ${r.error}`);
        toast('Service joignable');
      }).catch(fail);
      if ($('#syncMan', me)) $('#syncMan', me).onclick = () => pulse($('#syncMan', me), async () => {
        const r = await POST(`${base}/manifest`, {});
        toast(`Manifeste repris : ${r.après.triggers} déclencheurs, ${r.après.actions} actions, ${r.après.probes} sondes${r.après.comptes ? ', comptes gérés' : ''}${r.liens?.length ? ` · ${r.liens.length} workflow(s) créé(s)` : ''}`);
      }).catch(fail);
      if ($('#redeploy', me)) $('#redeploy', me).onclick = () => pulse($('#redeploy', me), async () => {
        await POST(`${base}/redeploy`, {});
        toast('Pile relancée avec la configuration à jour');
      }).catch(fail);
      if ($('#recreer', me)) $('#recreer', me).onclick = () => pulse($('#recreer', me), async () => {
        const r = await POST(`${base}/autos`, {});
        toast(r.recrees.length ? `Recréé${r.recrees.length > 1 ? 's' : ''} : ${r.recrees.join(', ')}` : 'Aucun ne manquait');
      }).catch(fail);
      if ($('#logs', me)) $('#logs', me).onclick = async () => { try { const r = await GET(`${base}/logs?tail=200`); poser($('#out', me), html`<pre class="pre">${r.text}</pre>`); } catch (e) { fail(e); } };
      // Ajouter une deuxième machine part d'ici, plus du catalogue : c'est
      // le service existant qu'on étend, pas une extension qu'on découvre.
      if ($('#autreMachine', me)) $('#autreMachine', me).onclick = () => { fermer(); addServiceDialog(m, 'remote'); };
      $$('[data-act]', me).forEach(b => { b.onclick = () => actionDialog(i, m.actions.find(a => a.id === b.dataset.act)); });
    },
  });
}

function actionDialog(inst, a) {
  modal({
    title: a.name, sub: html`${inst.name} · ${a.risk === 'read' ? 'lecture' : a.risk === 'reversible' ? 'modifie un état' : html`<span class="err">destructive</span>`}`,
    body: html`<p class="hint">${a.description}</p><div id="aForm">${formulaire(a.params || [], {}, { instanceId: inst.id }, 'a')}</div><div id="aOut"></div>`,
    actions: [{ label: 'Fermer' }, { label: 'Lancer', cls: a.risk === 'destructive' ? 'solid danger' : 'solid', run: async me => {
      if (a.risk === 'destructive' && !(await confirmBox('Action destructive', `Confirmer « ${a.name} » sur ${inst.name} ?`, 'Lancer'))) return false;
      const r = await POST(`/api/instances/${encodeURIComponent(inst.id)}/actions/${encodeURIComponent(a.id)}`, { params: readForm($('#aForm', me)), confirm: true });
      poser($('#aOut', me), html`<span class="lab">Résultat</span><pre class="pre">${JSON.stringify(r.output, null, 2)}</pre>`);
      return false;
    } }],
    onOpen: me => bindDynamic($('#aForm', me), inst.id, 'action', a.id),
  });
}

// Workflows
async function viewWf(el, t) {
  const [list, inst, { dossiers }] = await Promise.all([GET('/api/workflows'), GET('/api/instances'), GET('/api/workflows/dossiers')]);
  if (!alive(t)) return;
  // Un lien : un workflow fait de nœuds « core.link » seuls (une connexion
  // entre services, l'IA d'un service, un nom publié…). Toujours comptés,
  // masquables d'un bouton — jamais absents.
  const estLien = w => w.graph.nodes.length > 0 && w.graph.nodes.every(n => n.type === 'core.link');
  const nbLiens = list.filter(estLien).length;
  const shown = list.filter(w => (S.filter === 'all' || w.origin === S.filter) && !(S.liensCaches && estLien(w)));
  const count = o => list.filter(w => o === 'all' || w.origin === o).length;
  const nameOf = id => inst.find(i => i.id === id)?.name || '?';
  let plies = [];
  try { plies = JSON.parse(sessionStorage.getItem('hub_wf_plies') || '[]'); } catch { /* stockage indisponible : tout est déplié */ }
  const plie = new Set(plies);
  const ligne = w => {
    const trig = w.graph.nodes.find(n => n.type.startsWith('trigger.'));
    const passive = w.graph.nodes.every(n => n.type === 'core.link');
    const chaine = w.instances.map(nameOf);
    return html`<div class="flowrow wf" data-open=${w.id} draggable="true" data-glisse=${w.id} tabindex="0" role="button">
      ${passive ? html`<span class="chip m">lien</span>` : html`<button class="toggle ${w.enabled ? 'on' : ''}" data-tog=${w.id} aria-label="Activer ou couper"><i></i></button>`}
      <div class="wf-t"><span class="itile c-ico cache-s ${w.origin === 'IA' ? 'ink' : w.origin === 'Auto' ? 'key' : ''}">${I(passive ? 'pair' : trig ? 'auto' : 'libre')}</span><div class="wf-nom"><strong>${w.name}</strong><div class="chain">${chaine.length ? chaine.map((n, i) => html`${i ? html` <span class="ar">→</span> ` : ''}${n}`) : `${w.graph.nodes.length} nœuds`}${w.lastStatus === 'error' ? html` <span class="err">· dernier passage en échec</span>` : ''}</div></div></div>
      <div class="fin"><span class="cache-s">${originChip(w.origin)}</span>
        <div class="stat cache-m"><b>${w.graph.nodes.length} nœuds · ${w.runs} exéc.</b>${w.lastRun ? when(w.lastRun) : 'jamais lancé'}</div>
        <button class="ghost" data-deplacer=${w.id} title="Ranger dans un dossier" aria-label="Ranger « ${w.name} » dans un dossier">${I('folder', 15)}</button></div>
    </div>`;
  };
  /* L'arbre : les dossiers (même vides), puis ce qui n'est rangé nulle part. */
  const racine = { enfants: new Map(), wfs: [] };
  const noeud = chemin => {
    let n = racine;
    if (!chemin) return n;
    const parties = chemin.split(' / ');
    parties.forEach((p, i) => {
      if (!n.enfants.has(p)) n.enfants.set(p, { nom: p, chemin: parties.slice(0, i + 1).join(' / '), enfants: new Map(), wfs: [] });
      n = n.enfants.get(p);
    });
    return n;
  };
  dossiers.forEach(noeud);
  shown.forEach(w => noeud(w.dossier).wfs.push(w));
  const total = n => n.wfs.length + [...n.enfants.values()].reduce((s, e) => s + total(e), 0);
  const dessinerDossier = (n, niveau) => {
    const ferme = plie.has(n.chemin);
    const nb = total(n);
    return html`<div class="dossier" style=${{ '--niv': niveau }}>
      <div class="dossier-tete" data-cible=${n.chemin} data-plier=${n.chemin} role="button" tabindex="0" aria-expanded=${String(!ferme)}>
        <span class="dossier-chev ${ferme ? '' : 'ouvert'}">${I('chev', 13)}</span>${I('folder', 16)}
        <b class="tronque">${n.nom}</b><span class="n">${nb}</span><span class="grow"></span>
        <button class="ghost" data-renommer=${n.chemin} title="Renommer" aria-label="Renommer le dossier ${n.nom}">${I('text', 14)}</button>
        <button class="ghost" data-sup-dossier=${n.chemin} title="Supprimer le dossier (les workflows remontent d’un niveau)" aria-label="Supprimer le dossier ${n.nom}">${I('x', 14)}</button>
      </div>
      ${ferme ? '' : html`<div class="dossier-corps">${[...n.enfants.values()].sort((a, b) => a.nom.localeCompare(b.nom, 'fr')).map(e => dessinerDossier(e, niveau + 1))}${n.wfs.map(ligne)}${nb || n.enfants.size ? '' : html`<div class="dossier-vide">Dossier vide : glisse un workflow ici.</div>`}</div>`}
    </div>`;
  };
  const sousDossiers = [...racine.enfants.values()].sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
  const vide = html`<div class="list-empty">Aucun workflow ici.<br>Le bouton <b>Nouveau</b> en crée un à la main : un déclencheur d’un de tes services, puis ce qu’il doit faire.<br><span class="mini">Le Hub en crée aussi tout seul, mais seulement quand un service <i>consomme</i> ce qu’un autre <i>fournit</i> — deux services qui ne font que fournir n’ont rien à se dire.</span></div>`;
  poser(el, headrow('Workflows', 'Chaque lien entre deux services est ici, qu’il vienne du Hub, de l’IA ou de toi. Aucun lien caché.',
    html`<button class="btn cache-m" id="rangerIa" title="L’assistant propose un rangement par service puis par rôle ; rien ne bouge avant ta validation">${I('sparkle', 15)}Ranger avec l’IA</button><button class="btn cache-s" id="newDossier">${I('folder', 15)}Nouveau dossier</button><button class="btn cache-s" id="imp">${I('export', 15)}Importer</button><button class="btn seul-s" id="plusWf" aria-label="Autres actions">•••</button><button class="btn solid" id="newWf">${I('plus', 15)}Nouveau workflow</button>`),
  html`<div class="filtres"><div class="views">${[['all', 'Tous'], ['Auto', 'Auto'], ['IA', 'IA'], ['Manuel', 'Manuels']].map(([k, l]) => html`<button class="view ${S.filter === k ? 'on' : ''}" data-f=${k}>${l}<span class="n">${count(k)}</span></button>`)}</div>
    <button class="btn sm ${S.liensCaches ? '' : 'flat'}" id="liensMasque" title="Les liens (connexions entre services, IA des services, noms publiés) restent comptés : ce bouton ne fait que les replier">${I('pair', 13)}${S.liensCaches ? `Afficher les ${nbLiens} liens` : `Masquer les liens · ${nbLiens}`}</button></div>
    <div class="card wf-arbre">${shown.length || sousDossiers.length
      ? [sousDossiers.map(n => dessinerDossier(n, 0)), racine.wfs.length ? [sousDossiers.length ? html`<div class="dossier-racine" data-cible="">${I('libre', 14)}<span>Sans dossier</span><span class="n">${racine.wfs.length}</span></div>` : '', racine.wfs.map(ligne)] : '']
      : vide}</div>`);
  const ranger = async (id, dossier) => {
    try { await POST('/api/workflows/ranger', { affectations: [{ id, dossier }] }); toast(dossier ? `Rangé dans « ${dossier} »` : 'Sorti des dossiers'); viewWf(el, t); } catch (e) { fail(e); }
  };
  const retenirPlies = () => { try { sessionStorage.setItem('hub_wf_plies', JSON.stringify([...plie])); } catch { /* stockage indisponible */ } };
  $$('[data-plier]', el).forEach(h => {
    const basculer = () => { plie.has(h.dataset.plier) ? plie.delete(h.dataset.plier) : plie.add(h.dataset.plier); retenirPlies(); viewWf(el, t); };
    h.onclick = e => { if (!e.target.closest('button')) basculer(); };
    h.onkeydown = e => { if (e.target === h && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); basculer(); } };
  });
  $$('[data-deplacer]', el).forEach(b => { b.onclick = e => {
    e.stopPropagation();
    const w = list.find(x => x.id === b.dataset.deplacer);
    modal({ title: 'Ranger le workflow', sub: w.name, body: html`<div class="fl"><label for="dosSel">Dossier</label><select class="field" id="dosSel"><option value="">Sans dossier</option>${dossiers.map(d => html`<option value=${d} selected=${d === w.dossier}>${d}</option>`)}</select></div>
      <div class="fl"><label for="dosNeuf">Ou un nouveau dossier</label><input class="field" id="dosNeuf" placeholder="ex. MapMyLAN / Alertes" autocomplete="off"></div>`,
      actions: [{ label: 'Annuler' }, { label: 'Ranger', cls: 'solid', run: async me => { await ranger(w.id, $('#dosNeuf', me).value.trim() || $('#dosSel', me).value); } }] });
  }; });
  $$('[data-renommer]', el).forEach(b => { b.onclick = e => {
    e.stopPropagation();
    const de = b.dataset.renommer;
    modal({ title: 'Renommer le dossier', sub: de, body: html`<div class="fl"><label for="dosNom">Nouveau chemin</label><input class="field" id="dosNom" value=${de} autocomplete="off"></div><p class="hint">Les sous-dossiers et les workflows suivent.</p>`,
      actions: [{ label: 'Annuler' }, { label: 'Renommer', cls: 'solid', run: async me => { await PATCH('/api/workflows/dossiers', { de, vers: $('#dosNom', me).value }); toast('Dossier renommé'); viewWf(el, t); } }] });
  }; });
  $$('[data-sup-dossier]', el).forEach(b => { b.onclick = async e => {
    e.stopPropagation();
    if (!await confirmBox('Supprimer ce dossier ?', `« ${b.dataset.supDossier} » disparaît ; ses workflows et sous-dossiers remontent d’un niveau. Aucun workflow n’est supprimé.`, 'Supprimer le dossier')) return;
    try { await POST('/api/workflows/dossiers/supprimer', { chemin: b.dataset.supDossier }); viewWf(el, t); } catch (err) { fail(err); }
  }; });
  const nouveauDossier = () => modal({ title: 'Nouveau dossier', body: html`<div class="fl"><label for="dosCree">Nom</label><input class="field" id="dosCree" placeholder="ex. MapMyLAN / Alertes" autocomplete="off"></div><p class="hint">« / » crée des sous-dossiers, trois niveaux au plus.</p>`,
    actions: [{ label: 'Annuler' }, { label: 'Créer', cls: 'solid', run: async me => { await POST('/api/workflows/dossiers', { chemin: $('#dosCree', me).value }); viewWf(el, t); } }] });
  // L'assistant range : une proposition par service puis par rôle, qu'on valide dans son panneau.
  const rangerIa = () => { if (!S.aiOpen) toggleAi(); S.aiPreRempli = 'Range mes workflows'; renderAi(); };
  const importer = () => modal({ title: 'Importer un workflow', body: html`<textarea class="field haut-240" id="impJson" placeholder='{ "format": "hub-workflow/1", … }'></textarea>`,
    actions: [{ label: 'Annuler' }, { label: 'Importer', cls: 'solid', run: async me => { const r = await POST('/api/workflows', { import: JSON.parse($('#impJson', me).value) }); navigate('editor', r.workflow.id); } }] });
  $('#newDossier', el).onclick = nouveauDossier;
  $('#rangerIa', el).onclick = rangerIa;
  $('#imp', el).onclick = importer;
  // Sur un écran étroit, les actions secondaires se retrouvent ici.
  $('#plusWf', el).onclick = () => feuilleActions('Workflows', [{ texte: 'Ranger avec l’IA', agir: rangerIa }, { texte: 'Nouveau dossier', agir: nouveauDossier }, { texte: 'Importer', agir: importer }]);
  // Glisser une ligne sur un dossier la range dedans.
  $$('[data-glisse]', el).forEach(r => { r.ondragstart = e => { e.dataTransfer.setData('text/x-hub-wf', r.dataset.glisse); e.dataTransfer.effectAllowed = 'move'; }; });
  $$('[data-cible]', el).forEach(c => {
    c.ondragover = e => { if ([...e.dataTransfer.types].includes('text/x-hub-wf')) { e.preventDefault(); c.classList.add('survol'); } };
    c.ondragleave = () => c.classList.remove('survol');
    c.ondrop = e => { e.preventDefault(); c.classList.remove('survol'); const id = e.dataTransfer.getData('text/x-hub-wf'); if (id) ranger(id, c.dataset.cible); };
  });
  bindCommon(el);
  $$('[data-f]', el).forEach(b => { b.onclick = () => { S.filter = b.dataset.f; viewWf(el, t); }; });
  $('#liensMasque', el).onclick = () => { S.liensCaches = !S.liensCaches; try { localStorage.setItem('hub-liens-caches', S.liensCaches ? '1' : '0'); } catch { /* rien */ } viewWf(el, t); };
  $$('[data-open]', el).forEach(r => { r.onclick = e => { if (!e.target.closest('button')) navigate('editor', r.dataset.open); }; r.onkeydown = e => { if (e.key === 'Enter' && e.target === r) navigate('editor', r.dataset.open); }; });
  $$('[data-tog]', el).forEach(b => { b.onclick = async e => {
    e.stopPropagation();
    const w = list.find(x => x.id === b.dataset.tog);
    try { await POST(`/api/workflows/${encodeURIComponent(w.id)}/enable`, { enabled: !w.enabled }); toast(w.enabled ? 'Workflow coupé' : 'Workflow activé'); viewWf(el, t); }
    catch (err) {
      // Des noms en double, le Hub sait réparer : on le propose ici plutôt
      // que de renvoyer l'utilisateur ouvrir l'éditeur pour deux clics.
      const nom = Array.isArray(err.details) && err.details.find(p => p.fix === 'noms');
      if (!nom) return fail(err);
      if (!await confirmBox('Renommer et activer ?', nom.message, 'Renommer')) return;
      try {
        const r = await POST(`/api/workflows/${encodeURIComponent(w.id)}/reparer/noms`, {});
        toast(r.renommes.map(x => `« ${x.de} » → « ${x.vers} »`).join(', '));
        await POST(`/api/workflows/${encodeURIComponent(w.id)}/enable`, { enabled: true });
        toast('Workflow activé'); viewWf(el, t);
      } catch (e2) { fail(e2); }
    }
  }; });
  $('#newWf', el).onclick = async () => { try { const r = await POST('/api/workflows', { name: 'Nouveau workflow' }); navigate('editor', r.workflow.id); } catch (e) { fail(e); } };
  app.on('workflow', () => alive(t) && viewWf(el, t));
}

// Les actions retirées d'un écran étroit, une par ligne.
function feuilleActions(titre, actions) {
  modal({ title: titre, body: html`<div class="feuille">${actions.map((a, i) => html`<button type="button" class="btn flat" data-i=${i}>${a.texte}</button>`)}</div>`,
    onOpen: (m, fermer) => $$('[data-i]', m).forEach(b => { b.onclick = () => { fermer(); actions[Number(b.dataset.i)].agir(); }; }) });
}

async function viewEditor(el) {
  el.classList.remove('page');
  await openEditor(el, S.wf, app);
}

// Comptes des services
// Un service à la fois : on entre avec un renfort de cinq minutes (le
// facteur le plus fort du compte, demandé par le socle), on gère, on ressort.
// Le compte administrateur d'origine ne se supprime pas d'ici.
async function viewUsers(el, t) {
  const [{ services }, instances] = await Promise.all([GET('/api/accounts'), GET('/api/instances')]);
  if (!alive(t)) return;
  const parId = new Map(instances.map(i => [i.id, i]));
  // L'adresse à laquelle ce navigateur ouvre le service : les liens d'invitation en partent.
  for (const sv of services) { const i = parId.get(sv.id); sv.adresse = i ? adresseService(i) : ''; }
  const detail = sv => sv.gestion === 'hub'
    ? [sv.can.invitation ? 'invitation' : sv.can.create ? 'création' : '', sv.can.reset ? 'réinitialisation' : '', sv.can.remove ? 'suppression' : '', sv.can.mfa ? 'A2F' : ''].filter(Boolean).join(' · ') || 'gérés ici'
    : sv.gestion === 'mise-a-jour' ? `mets-le à jour (${sv.version}) pour gérer ses comptes ici` : 'pas de comptes';
  const fin = sv => {
    if (sv.gestion === 'hub') return sv.ready ? html`<span class="chip a">prêt</span>` : html`<span class="chip cache-s">jeton ${sv.tokenKey} à renseigner</span>`;
    return sv.gestion === 'mise-a-jour' ? html`<span class="chip cache-s">mise à jour</span>` : '';
  };
  poser(el, headrow('Comptes des services', 'Les comptes de chaque service, gérés ici. Chaque service demande de confirmer ton identité à l’entrée.'),
    services.length ? html`<div class="card">${services.map(sv => html`<div class=${sv.gestion === 'hub' ? 'flowrow svc' : 'flowrow svc fixe'} data-svc=${sv.gestion === 'hub' ? sv.id : null} tabindex=${sv.gestion === 'hub' ? '0' : null} role=${sv.gestion === 'hub' ? 'button' : null}>
        <span class="itile ${sv.status === 'online' ? 'key' : ''}">${I(pictoService(sv.icon))}</span>
        <div class="svc-t"><strong>${sv.name}</strong><div class="chain">${sv.ext} <span class="ar">·</span> ${detail(sv)}</div></div>
        <div class="fin">${fin(sv)}<div class="svc-etat">${statusTag(sv.status)}</div></div>
      </div>`)}</div>`
      : html`<div class="card list-empty">Aucun service installé ou connecté pour l’instant.</div>`);
  $$('[data-svc]', el).forEach(rw => {
    const open = () => {
      const sv = services.find(x => x.id === rw.dataset.svc);
      if (!sv.ready) { toast(`Renseigne d’abord ${sv.tokenKey} dans la fiche du service.`); return; }
      entrerService(sv);
    };
    rw.onclick = open;
    rw.onkeydown = e => { if (e.key === 'Enter') open(); };
  });
}

// Le renfort du socle s'ouvre de lui-même si la session n'en a pas de récent.
async function entrerService(sv) {
  try { await POST(`/api/accounts/${encodeURIComponent(sv.id)}/stepup`, {}); accountsDialog(sv); }
  catch (e) { fail(e); }
}

async function accountsDialog(sv) {
  let dlg;
  // « grille », « nouveau » ou { id } : ce que la fenêtre montre, gardé d'un rafraîchissement à l'autre.
  let vue = 'grille';
  const base = `/api/accounts/${encodeURIComponent(sv.id)}`;
  const render = async me => {
    const box = $('#accBox', me);
    try {
      const { rows, roles, until, emailDefaut, envoi } = await GET(base);
      const reste = Math.max(0, Math.round((until - Date.now()) / 1000));
      if (sv.can.socle) return rendreSocle(me, box, { rows, roles, reste, emailDefaut, envoi });
      rendreGenerique(me, box, { rows, roles, reste });
    } catch (e) {
      poser(box, html`<div class="err">${e.message}</div>`);
      // Cinq minutes écoulées : on referme cette fenêtre et on redemande le
      // renfort, plutôt que d'empiler une seconde liste par-dessus la première.
      if (e.details?.stepUp) { dlg?.close(); entrerService(sv); }
    }
  };
  // Un service hors socle (SYNAPSE, docker-control…) : la même disposition —
  // une carte par compte, une carte « + », la fiche dans la même fenêtre — avec
  // ce que son manifeste sait faire (rôle, mot de passe ou lien, A2F, suppression).
  const lettresDe = n => { const m = String(n).split(/[^\p{L}\p{N}]+/u).filter(Boolean); return ((m.length > 1 ? m[0][0] + m[1][0] : (m[0] || '').slice(0, 2)) || '?').toUpperCase(); };
  const rendreGenerique = (me, box, { rows, roles, reste }) => {
    const vide = !rows.length;
    if (vide && sv.can.create) vue = 'nouveau';
    const u = typeof vue === 'object' ? rows.find(x => x.id === vue.id) : null;
    if (typeof vue === 'object' && !u) vue = 'grille';
    if (vue === 'nouveau' && !sv.can.create) vue = 'grille';
    const entete = html`<div class="mini">Ouvert encore ${Math.floor(reste / 60)} min ${reste % 60} s</div>`;
    const retour = vide ? '' : html`<button class="btn flat sm compte-retour" type="button" data-vue="grille">${I('back', 14)}Tous les comptes</button>`;
    const derniere = x => x.lastSeen ? when(Date.parse(x.lastSeen) || x.lastSeen) : 'jamais connecté';
    const a2f = x => x.mfa === null || x.mfa === undefined ? '' : html`<div class="facteurs"><span class=${x.mfa ? 'fct ok' : 'fct manque'}>${x.mfa ? I('check', 11) : ''}${x.mfa ? 'A2F active' : 'A2F à inscrire'}</span></div>`;
    const premier = vide && sv.can.invitation;
    let corps;
    if (vue === 'nouveau') {
      const rolesProposes = sv.can.invitation ? roles.filter(r => r !== 'admin') : roles;
      corps = html`${retour}<div class="sec nouveau-compte"><h3>${premier ? 'Créer l’administrateur' : 'Nouveau compte'}</h3>
        <p class="help">${premier ? `${sv.name} n’a encore aucun compte : crée ici son administrateur. Tu reçois un lien à ouvrir, où tu choisis ton mot de passe puis tes facteurs. Aucun jeton d’installation à recopier.`
          : sv.can.invitation ? 'L’invité reçoit un lien : il choisit lui-même son mot de passe et ses facteurs. Un administrateur se promeut ensuite, une fois ses facteurs inscrits.'
          : `Le compte est créé dans ${sv.name} avec ce mot de passe ; transmets-le à la personne, qui le changera.`}</p>
        <div class="formgrid">
          <div class="fl"><label for="nuName">Identifiant</label><input class="field mono" id="nuName" autocomplete="off" spellcheck="false"></div>
          ${sv.can.invitation ? '' : html`<div class="fl"><label for="nuPass">Mot de passe</label><input class="field mono" id="nuPass" type="password" autocomplete="new-password"></div>`}
          ${premier ? html`<input type="hidden" id="nuRole" value="admin">` : rolesProposes.length ? html`<div class="fl"><label for="nuRole">Rôle</label><select class="field" id="nuRole">${rolesProposes.map(r => html`<option selected=${r === (rolesProposes.find(x => x !== 'admin') || rolesProposes[0])}>${r}</option>`)}</select></div>` : ''}
        </div>
        <div class="row"><span class="grow"></span><button class="btn solid sm" id="nuAdd">${I('plus', 14)}${premier ? 'Créer l’administrateur' : sv.can.invitation ? 'Inviter' : 'Créer le compte'}</button></div>
      </div>`;
    } else if (u) {
      corps = html`${retour}<div class="compte-fiche">
        <div class="compte-tete"><span class="compte-av" aria-hidden="true">${lettresDe(u.name)}</span><b class="compte-nom">${u.name}</b>
          ${u.protected ? html`<span class="chip" title="Compte d’origine : non supprimable depuis le Hub">origine</span>` : ''}
          <span class="grow"></span>
          ${sv.can.update && roles.length ? html`<div class="compte-role"><select class="field mono compact" data-role=${u.id} aria-label="Rôle">${roles.map(r => html`<option selected=${r === u.role}>${r}</option>`)}</select></div>` : html`<span class="chip">${u.role || '—'}</span>`}</div>
        ${a2f(u)}
        <div class="mini">Dernière connexion : ${derniere(u)}</div>
        <div class="act compte-actions">
          ${sv.can.reset ? html`<button class="btn sm" data-reinit=${u.id} title="Un lien de réinitialisation du mot de passe, à transmettre toi-même">Copier un lien</button>` : sv.can.password ? html`<button class="btn sm" data-pass=${u.id}>Changer le mot de passe</button>` : ''}
          ${sv.can.mfa && u.mfa === false ? html`<button class="btn sm" data-mfa=${u.id}>Exiger l’A2F</button>` : ''}
          ${sv.can.remove && !u.protected ? html`<button class="btn sm danger" data-del=${u.id}>Supprimer</button>` : ''}
        </div>
      </div>`;
    } else {
      corps = html`<div class="comptes-grille">${rows.map(x => html`<button type="button" class="compte-carte" data-ouvrir=${x.id} aria-label=${`Compte ${x.name}`}>
          <span class="compte-av" aria-hidden="true">${lettresDe(x.name)}</span>
          <span class="compte-nom">${x.name}</span>
          <span class="compte-sous">${x.role || '—'}${x.protected ? ' · origine' : ''}</span>
          ${a2f(x)}
          <span class="compte-etat">${derniere(x)}</span>
        </button>`)}
        ${sv.can.create ? html`<button type="button" class="compte-carte ajout" data-vue="nouveau" aria-label="Nouveau compte">${I('plus', 26)}<span>Nouveau compte</span></button>` : ''}
      </div>`;
    }
    poser(box, html`${entete}${corps}`);
    const act = async (fn, btn, ok) => {
      try { const out = await (btn ? pulse(btn, fn) : fn()); if (ok) toast(ok(out)); setTimeout(() => render(me), btn ? 900 : 0); }
      catch (e) { box.prepend(element(html`<div class="err">${e.message}</div>`)); }
    };
    const url = id => `${base}/${encodeURIComponent(id)}`;
    $$('[data-vue]', box).forEach(b => { b.onclick = () => { vue = b.dataset.vue; render(me); }; });
    $$('[data-ouvrir]', box).forEach(b => { b.onclick = () => { vue = { id: b.dataset.ouvrir }; render(me); }; });
    $$('[data-role]', box).forEach(sel => { sel.onchange = () => act(() => PATCH(url(sel.dataset.role), { role: sel.value }), null, () => 'Rôle modifié'); });
    $$('[data-mfa]', box).forEach(b => { b.onclick = () => act(() => POST(`${url(b.dataset.mfa)}/mfa`, {}), b, () => 'A2F exigée'); });
    $$('[data-pass]', box).forEach(b => { b.onclick = () => passwordDialog(sv, b.dataset.pass, () => render(me)); });
    $$('[data-reinit]', box).forEach(b => { b.onclick = () => act(async () => {
      const out = await POST(`${url(b.dataset.reinit)}/reset`, sv.adresse ? { adresse: sv.adresse } : {});
      if (out?.lien) lienDialog('Lien de réinitialisation', out.lien, out.message, out.autres);
    }, b); });
    $$('[data-del]', box).forEach(b => { b.onclick = async () => {
      if (!await confirmBox('Supprimer ce compte ?', 'Le compte et ses accès disparaissent du service. Cette action ne s’annule pas.', 'Supprimer', true)) return;
      vue = 'grille';
      act(() => DEL(url(b.dataset.del)), b, () => 'Compte supprimé');
    }; });
    const add = $('#nuAdd', box);
    if (add) add.onclick = () => act(async () => {
      const out = await POST(base, { username: $('#nuName', box).value.trim(), ...(sv.can.invitation ? {} : { password: $('#nuPass', box).value }), role: $('#nuRole', box)?.value || '', ...(sv.adresse ? { adresse: sv.adresse } : {}) });
      if (out?.lien) lienDialog($('#nuRole', box)?.value === 'admin' ? 'Lien du premier administrateur' : 'Lien d’invitation', out.lien, out.message, out.autres);
      vue = 'grille';
      return out;
    }, add, out => (typeof out?.message === 'string' ? out.message.slice(0, 200) : 'Compte créé'));
    (box.querySelector('#nuName') || null)?.focus();
  };
  // Un service du socle : le Hub tient ses comptes en entier — adresse e-mail,
  // clé d'accès exigée, activation, liens copiés ou envoyés par e-mail.
  // Une carte par compte et une carte « + » ; un clic ouvre la fiche du compte,
  // ou le formulaire d'invitation, dans la même fenêtre.
  const rendreSocle = (me, box, { rows, roles, reste, emailDefaut, envoi }) => {
    const LIB_CLE = { http: 'Sans objet : service en HTTP', toujours: 'Toujours exigée (administrateur)' };
    const vide = !rows.length;
    // Un service au socle plus ancien ne connaît ni l'e-mail ni la clé par compte.
    const complet = rows.every(u => u.cle);
    if (vide) vue = 'nouveau';
    const u = typeof vue === 'object' ? rows.find(x => x.id === vue.id) : null;
    if (typeof vue === 'object' && !u) vue = 'grille';
    const entete = html`<div class="mini">Ouvert encore ${Math.floor(reste / 60)} min ${reste % 60} s${envoi ? '' : ' · liens à copier : aucun relais d’envoi pour ce service (Réglages → Courriel, et une adresse publique en HTTPS)'}</div>
      ${complet ? '' : html`<div class="note-maj">${sv.name} ne gère pas encore l’e-mail ni la clé d’accès par compte : mets-le à jour pour les régler d’ici.</div>`}`;
    const retour = vide ? '' : html`<button class="btn flat sm compte-retour" type="button" data-vue="grille">${I('back', 14)}Tous les comptes</button>`;
    const lettres = lettresDe;
    const derniere = x => x.lastSeen ? when(Date.parse(x.lastSeen) || x.lastSeen) : 'jamais connecté';
    // Les facteurs détenus ; « à inscrire » quand la politique les réclame encore.
    const pastilles = x => {
      const f = x.facteurs, manque = new Set(x.manquants || []);
      if (!f) return html`<div class="facteurs"><span class=${x.mfa ? 'fct ok' : 'fct'}>${x.mfa ? 'A2F active' : 'A2F à inscrire'}</span></div>`;
      const p = (ok, requis, texte) => html`<span class=${ok ? 'fct ok' : requis ? 'fct manque' : 'fct'}>${ok ? I('check', 11) : ''}${texte}</span>`;
      return html`<div class="facteurs">
        ${p(f.motdepasse, manque.has('motdepasse'), 'Mot de passe')}
        ${p(f.totp, manque.has('totp') || manque.has('second'), 'A2F')}
        ${x.cle === 'http' ? '' : p(f.cles > 0, manque.has('cle'), f.cles > 1 ? `${f.cles} clés` : 'Clé d’accès')}</div>`;
    };
    const alerte = x => {
      if (!x.actif) return 'désactivé';
      if (!x.lastSeen && !x.facteurs?.motdepasse) return 'invitation en attente';
      if ((x.manquants || []).length) return 'facteur à inscrire';
      return '';
    };
    let corps;
    if (vue === 'nouveau') {
      corps = html`${retour}<div class="sec nouveau-compte"><h3>${vide ? 'Créer l’administrateur' : 'Nouveau compte'}</h3>
        <p class="help">${vide ? `${sv.name} n’a encore aucun compte : son administrateur se crée ici, sans jeton d’installation.` : 'L’invité reçoit un lien : il choisit lui-même son mot de passe et ses facteurs. Un administrateur se promeut ensuite, une fois ses facteurs inscrits.'}</p>
        <div class="formgrid">
          <div class="fl"><label for="nuName">Identifiant</label><input class="field mono" id="nuName" autocomplete="off" spellcheck="false"></div>
          ${vide ? html`<input type="hidden" id="nuRole" value="admin">` : html`<div class="fl"><label for="nuRole">Rôle</label><select class="field" id="nuRole">${roles.filter(r => r !== 'admin').map(r => html`<option>${r}</option>`)}</select></div>`}
          ${complet ? html`<div class="fl full"><label for="nuMel">E-mail</label><input class="field mono" id="nuMel" type="email" value=${emailDefaut} autocomplete="off" spellcheck="false"></div>` : ''}
        </div>
        <div class="row">${envoi && complet ? html`<label class="bascule"><input type="checkbox" id="nuEnvoi" checked><span>Envoyer le lien par e-mail</span></label>` : ''}<span class="grow"></span>
          <button class="btn solid sm" id="nuAdd">${I('plus', 14)}${vide ? 'Créer l’administrateur' : 'Inviter'}</button></div>
      </div>`;
    } else if (u) {
      // Une clé d'accès naît sur l'appareil de la personne, pour le nom du
      // service : le Hub ne peut pas l'enregistrer à sa place.
      const f = u.facteurs;
      const nomSv = sv.ext || sv.name;
      const ouvrir = sv.adresse ? html` <a class="link" href=${sv.adresse} target="_blank" rel="noopener noreferrer">Ouvrir ${nomSv}</a>` : '';
      const cleTexte = u.cle === 'http' ? 'Le service tourne en HTTP : aucune clé n’est possible tant qu’il n’est pas servi en HTTPS.'
        : !f ? ''
        : f.cles > 0 ? `${f.cles > 1 ? `${f.cles} clés enregistrées` : 'Une clé enregistrée'}. La personne en ajoute ou en retire dans ${nomSv}, page Sécurité.`
        : (u.manquants || []).includes('cle') || u.cle === 'toujours' || u.cle === 'exigee'
          ? `Aucune clé enregistrée. Elle se crée dans ${nomSv}, sur l’appareil de la personne (Windows Hello, Touch ID, téléphone, clé USB) : à sa prochaine connexion, ${nomSv} la lui demande avant d’ouvrir quoi que ce soit.`
          : `Aucune clé enregistrée, et aucune n’est exigée. Elle s’ajoute dans ${nomSv}, page Sécurité.`;
      corps = html`${retour}<div class=${u.actif ? 'compte-fiche' : 'compte-fiche inactif'}>
        <div class="compte-tete"><span class="compte-av" aria-hidden="true">${lettres(u.name)}</span><b class="compte-nom">${u.name}</b>
          ${u.protected ? html`<span class="chip" title="Compte d’origine : non supprimable depuis le Hub">origine</span>` : ''}
          ${u.actif ? '' : html`<span class="chip w">désactivé</span>`}
          <span class="grow"></span>
          <div class="compte-role"><select class="field mono compact" data-role=${u.id} aria-label="Rôle">${roles.map(r => html`<option selected=${r === u.role}>${r}</option>`)}</select></div></div>
        ${pastilles(u)}
        <div class="mini">Dernière connexion : ${derniere(u)}</div>
        ${complet ? html`<div class="compte-champs">
          <div class="fl"><label for=${'mel-' + u.id}>E-mail</label>
            <div class="champ-bouton"><input class="field mono" id=${'mel-' + u.id} type="email" value=${u.email} placeholder=${emailDefaut || 'aucune'} autocomplete="off" spellcheck="false"><button class="btn sm" data-mel=${u.id}>Enregistrer</button></div></div>
          <div class="fl"><span class="lab">Clé d’accès</span>
            ${LIB_CLE[u.cle] ? html`<div class="valeur-fixe">${LIB_CLE[u.cle]}</div>` : html`<label class="bascule"><input type="checkbox" data-cle=${u.id} checked=${u.cle === 'exigee'}><span>Exiger une clé d’accès</span></label>`}</div>
        </div>` : ''}
        ${cleTexte ? html`<p class="help cle-aide">${I('key', 13)}<span>${cleTexte}${ouvrir}</span></p>` : ''}
        <div class="act compte-actions">
          ${envoi && u.email ? html`<button class="btn sm solid" data-envoi=${u.id} title=${`Envoie à ${u.email} un lien pour choisir un nouveau mot de passe`}>${I('mail', 14)}Lien par e-mail</button>` : ''}
          <button class="btn sm" data-reinit=${u.id} title="Un lien de réinitialisation du mot de passe, à transmettre toi-même">Copier un lien</button>
          ${u.protected || !complet ? '' : html`<button class="btn sm" data-actif=${u.id} data-etat=${u.actif ? '0' : '1'}>${u.actif ? 'Désactiver' : 'Réactiver'}</button>`}
          ${u.protected ? '' : html`<button class="btn sm danger" data-del=${u.id}>Supprimer</button>`}
        </div>
      </div>`;
    } else {
      corps = html`<div class="comptes-grille">${rows.map(x => html`<button type="button" class=${x.actif ? 'compte-carte' : 'compte-carte inactif'} data-ouvrir=${x.id} aria-label=${`Compte ${x.name}`}>
          <span class="compte-av" aria-hidden="true">${lettres(x.name)}</span>
          <span class="compte-nom">${x.name}</span>
          <span class="compte-sous">${x.role || '—'}${x.protected ? ' · origine' : ''}</span>
          ${pastilles(x)}
          <span class=${alerte(x) ? 'compte-etat w' : 'compte-etat'}>${alerte(x) || derniere(x)}</span>
        </button>`)}
        <button type="button" class="compte-carte ajout" data-vue="nouveau" aria-label="Nouveau compte">${I('plus', 26)}<span>Nouveau compte</span></button>
      </div>`;
    }
    poser(box, html`${entete}${corps}`);
    const act = async (fn, btn, ok) => {
      try { const out = await (btn ? pulse(btn, fn) : fn()); if (ok) toast(ok(out)); setTimeout(() => render(me), btn ? 900 : 0); }
      catch (e) { box.prepend(element(html`<div class="err">${e.message}</div>`)); }
    };
    const url = id => `${base}/${encodeURIComponent(id)}`;
    $$('[data-vue]', box).forEach(b => { b.onclick = () => { vue = b.dataset.vue; render(me); }; });
    $$('[data-ouvrir]', box).forEach(b => { b.onclick = () => { vue = { id: b.dataset.ouvrir }; render(me); }; });
    $$('[data-role]', box).forEach(sel => { sel.onchange = () => act(() => PATCH(url(sel.dataset.role), { role: sel.value }), null, () => 'Rôle modifié'); });
    $$('[data-mel]', box).forEach(b => { b.onclick = () => act(() => PATCH(url(b.dataset.mel), { email: $('#mel-' + CSS.escape(b.dataset.mel), box).value.trim() }), b, () => 'Adresse enregistrée'); });
    $$('[data-cle]', box).forEach(c => { c.onchange = () => act(() => PATCH(url(c.dataset.cle), { cleExigee: c.checked }), null, () => c.checked ? 'Clé d’accès exigée' : 'Clé d’accès facultative'); });
    $$('[data-actif]', box).forEach(b => { b.onclick = () => act(() => PATCH(url(b.dataset.actif), { actif: b.dataset.etat === '1' }), b, () => b.dataset.etat === '1' ? 'Compte réactivé' : 'Compte désactivé'); });
    $$('[data-envoi]', box).forEach(b => { b.onclick = () => act(() => POST(`${url(b.dataset.envoi)}/reset`, { envoyer: true, ...(sv.adresse ? { adresse: sv.adresse } : {}) }), b, out => out?.message || 'Lien envoyé'); });
    $$('[data-reinit]', box).forEach(b => { b.onclick = () => act(async () => {
      const out = await POST(`${url(b.dataset.reinit)}/reset`, sv.adresse ? { adresse: sv.adresse } : {});
      if (out?.lien) lienDialog('Lien de réinitialisation', out.lien, out.message, out.autres);
    }, b); });
    $$('[data-del]', box).forEach(b => { b.onclick = async () => {
      if (!await confirmBox('Supprimer ce compte ?', 'Le compte et ses accès disparaissent du service. Cette action ne s’annule pas.', 'Supprimer', true)) return;
      vue = 'grille';
      act(() => DEL(url(b.dataset.del)), b, () => 'Compte supprimé');
    }; });
    const add = $('#nuAdd', box);
    if (add) add.onclick = () => act(async () => {
      const envoyer = !!$('#nuEnvoi', box)?.checked;
      const mel = $('#nuMel', box)?.value.trim();
      const out = await POST(base, { username: $('#nuName', box).value.trim(), role: $('#nuRole', box).value, ...(mel !== undefined ? { email: mel } : {}), envoyer, ...(sv.adresse ? { adresse: sv.adresse } : {}) });
      if (out?.lien) lienDialog(vide ? 'Lien du premier administrateur' : 'Lien d’invitation', out.lien, out.message, out.autres);
      vue = 'grille';
      return out;
    }, add, out => out?.envoye ? out.message : 'Compte créé');
    (box.querySelector('#nuName') || null)?.focus();
  };
  dlg = modal({
    wide: true, title: `Comptes de ${sv.name}`, sub: `${sv.ext} · toute action est journalisée`,
    body: html`<div id="accBox">Chargement…</div>`,
    actions: [{ label: 'Fermer', run: async () => { await POST(`${base}/lock`, {}).catch(() => {}); } }],
    onOpen: render,
  });
}

// Un lien à usage unique fabriqué par le service : montré une fois, à transmettre.
function lienDialog(titre, lien, message, autres = []) {
  modal({
    title: titre,
    sub: typeof message === 'string' ? message.slice(0, 300) : 'À transmettre à la personne concernée. Il ne sert qu’une fois.',
    body: html`<div class="fl"><label for="lienUnique">Lien</label><input class="field mono" id="lienUnique" readonly value=${lien}></div>
      ${autres.length ? html`<div class="fl"><label for="lienAutre">Si ce nom ne répond pas encore, le même lien par l’adresse directe</label>${autres.map((x, i) => html`<input class="field mono" id=${i ? null : 'lienAutre'} readonly value=${x}>`)}</div>` : ''}`,
    actions: [{ label: 'Fermer' }, { label: 'Copier', cls: 'solid', run: async me => {
      try { await navigator.clipboard.writeText(lien); toast('Lien copié'); }
      catch { $('#lienUnique', me).select(); toast('Sélectionné : copie-le avec ⌘C'); }
      return false;
    } }],
  });
}

function passwordDialog(sv, uid, done) {
  modal({
    title: 'Nouveau mot de passe',
    sub: 'Il remplace celui du compte, sans confirmation par l’utilisateur.',
    body: html`<div class="fl"><label for="pwNew">Mot de passe</label><input class="field mono" id="pwNew" type="password"><div class="help">12 caractères au minimum.</div></div><div id="pwErr"></div>`,
    actions: [{ label: 'Annuler' }, { label: 'Changer', cls: 'solid', run: async me => {
      try { await POST(`/api/accounts/${encodeURIComponent(sv.id)}/${encodeURIComponent(uid)}/password`, { password: $('#pwNew', me).value }); }
      catch (e) { poser($('#pwErr', me), html`<div class="err">${e.message}</div>`); return false; }
      toast('Mot de passe remplacé'); done();
    } }],
  });
}

// Sondes
async function viewProbes(el, t) {
  const list = await GET('/api/probes');
  if (!alive(t)) return;
  const fmt = (v, u) => (typeof v === 'number' ? (Math.abs(v) >= 1e6 && /octet|byte/i.test(u) ? (v / 1e9).toFixed(2) + ' Go' : `${Math.round(v * 100) / 100} ${u || ''}`) : String(v ?? '—'));
  const niveau = l => (l === 'crit' ? 'lvl-crit' : l === 'warn' ? 'lvl-warn' : '');
  poser(el, headrow('Sondes', 'Valeurs lues régulièrement sur tes services. Utilise-les comme déclencheur (« Seuil de sonde ») dans un workflow.'),
    list.length ? html`<div class="probes">${list.map(p => {
      const worst = p.series.some(s => s.level === 'crit') ? 'crit' : p.series.some(s => s.level === 'warn') ? 'warn' : 'ok';
      const one = p.series.length === 1 ? p.series[0] : null;
      return html`<div class="card probe" data-probe="${p.instanceId}|${p.id}" role="button" tabindex="0">
        <header><span class="itile ${worst === 'crit' ? 'hot' : worst === 'warn' ? '' : 'key'}">${I(p.kind === 'state' ? 'check' : 'chart')}</span><div class="grow"><h2>${p.name}</h2><p class="mini">${p.instance} · toutes les ${p.interval}</p></div><span class="note ${niveau(worst)}">${worst === 'ok' ? 'normal' : worst}</span></header>
        ${one ? html`<div class="pad"><div class="val ${niveau(one.level)}">${fmt(one.value, p.unit)}</div><div class="mini">${when(one.ts)}</div></div>`
          : p.series.length ? html`<div class="series">${p.series.map(s => html`<div><span class=${niveau(s.level)}>●</span><span class="tronque">${Object.values(s.labels).join(' · ') || '—'}</span><b>${fmt(s.value, p.unit)}</b></div>`)}</div>`
          : html`<div class="pad help">Pas encore de mesure.</div>`}
      </div>`;
    })}</div>` : html`<div class="card list-empty">Aucune sonde. Les sondes viennent des services ajoutés dans Extensions.</div>`);
  $$('[data-probe]', el).forEach(c => {
    const ouvrir = () => { const [i, p] = c.dataset.probe.split('|'); probeDialog(list.find(x => x.instanceId === i && x.id === p)); };
    c.onclick = ouvrir;
    c.onkeydown = e => { if (e.key === 'Enter') ouvrir(); };
  });
  let pend;
  app.on('probe', () => { clearTimeout(pend); pend = setTimeout(() => alive(t) && !document.querySelector('.voile') && viewProbes(el, t), 1500); });
}
async function probeDialog(p) {
  const draw = async (me, hours) => {
    const rows = await GET(`/api/probes/${encodeURIComponent(p.instanceId)}/${encodeURIComponent(p.id)}?hours=${hours}`);
    const series = {};
    for (const r of rows) (series[JSON.stringify(r.labels)] ||= []).push(r);
    const all = rows.filter(r => r.avg != null);
    if (!all.length) { poser($('#chart', me), html`<p class="help">Pas de valeur numérique sur cette période.</p>`); return; }
    const W = 800, H = 220, L = 50, B = 24;
    const t0 = Math.min(...all.map(r => r.t)), t1 = Math.max(...all.map(r => r.t)) || t0 + 1;
    const vals = all.flatMap(r => [r.min, r.max]);
    if (p.thresholds?.warn != null) vals.push(p.thresholds.warn);
    if (p.thresholds?.crit != null) vals.push(p.thresholds.crit);
    const vmin = Math.min(0, ...vals), vmax = Math.max(...vals) || 1;
    const x = v => L + (v - t0) / (t1 - t0 || 1) * (W - L - 10), y = v => H - B - (v - vmin) / (vmax - vmin || 1) * (H - B - 10);
    const cols = ['var(--accent)', 'var(--ink-soft)', 'var(--warn)', 'var(--muted)', 'var(--alarm)'];
    const ticks = [vmin, (vmin + vmax) / 2, vmax];
    const date = v => new Date(v).toLocaleString('fr-FR', { day: '2-digit', hour: '2-digit', minute: '2-digit' });
    poser($('#chart', me), html`<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Historique de ${p.name}">
      ${ticks.map(v => html`<line class="grid" x1=${L} x2=${W - 10} y1=${y(v)} y2=${y(v)}/><text class="axis" x=${L - 6} y=${y(v) + 3} text-anchor="end">${Math.round(v * 10) / 10}</text>`)}
      <text class="axis" x=${L} y=${H - 6}>${date(t0)}</text>
      <text class="axis" x=${W - 10} y=${H - 6} text-anchor="end">${date(t1)}</text>
      ${['warn', 'crit'].filter(k => p.thresholds?.[k] != null).map(k => html`<line x1=${L} x2=${W - 10} y1=${y(p.thresholds[k])} y2=${y(p.thresholds[k])} stroke=${k === 'crit' ? 'var(--alarm)' : 'var(--warn)'} stroke-dasharray="4 4"/><text class="axis" x=${W - 12} y=${y(p.thresholds[k]) - 4} text-anchor="end">${k}</text>`)}
      ${Object.values(series).map((s, i) => html`<path fill="none" stroke=${cols[i % cols.length]} stroke-width="1.8" d=${s.filter(r => r.avg != null).map((r, j) => `${j ? 'L' : 'M'}${x(r.t).toFixed(1)},${y(r.avg).toFixed(1)}`).join(' ')}/>`)}
    </svg><div class="row small">${Object.keys(series).map((k, i) => html`<span><span style=${{ color: cols[i % cols.length] }}>●</span> ${Object.values(JSON.parse(k)).join(' · ') || p.name}</span>`)}</div>`);
  };
  const base = `/api/probes/${encodeURIComponent(p.instanceId)}/${encodeURIComponent(p.id)}`;
  modal({ wide: true, title: p.name, sub: `${p.instance} · ${p.unit || ''}`,
    body: html`<div class="tabs sans-marge">${[1, 6, 24, 168].map(h => html`<button class="view ${h === 24 ? 'on' : ''}" data-h=${h}>${h < 24 ? h + ' h' : h === 24 ? '24 h' : '7 j'}</button>`)}</div><div class="chartbox" id="chart"></div>`,
    actions: [{ label: 'Lire maintenant', run: async me => { await POST(`${base}/read`); await draw(me, 24); return false; } }, { label: 'Fermer', cls: 'solid' }],
    onOpen: me => { draw(me, 24); $$('[data-h]', me).forEach(b => { b.onclick = () => { $$('[data-h]', me).forEach(x => x.classList.toggle('on', x === b)); draw(me, Number(b.dataset.h)); }; }); } });
}

// Connexions
async function viewLiens(el, t) {
  const [inst, wfs] = await Promise.all([GET('/api/instances'), GET('/api/workflows')]);
  if (!alive(t)) return;
  const W = 900, H = 460, cx = W / 2, cy = H / 2;
  const pos = {};
  inst.forEach((c, i) => { const a = -Math.PI / 2 + i * 2 * Math.PI / Math.max(1, inst.length); pos[c.id] = inst.length === 1 ? [cx, cy] : [cx + Math.cos(a) * 300, cy + Math.sin(a) * 160]; });
  const links = [];
  for (const w of wfs) for (let k = 1; k < w.instances.length; k++) links.push([w.instances[k - 1], w.instances[k], w]);
  const picto = c => { const s = I(pictoService(c.ext.icon)); s.setAttribute('x', 4); s.setAttribute('y', 4); return s; };
  poser(el, headrow('Liens', 'Chaque trait vient d’un workflow. Bleu : posé par le Hub. Noir : posé par l’IA ou par toi. Pointillé : coupé.', html`<button class="btn" data-nav="wf">Voir les workflows</button>`),
    html`<div class="card"><div class="planwrap graphe-cadre">${inst.length ? html`<svg class="graph" viewBox="0 0 ${W} ${H}" role="img" aria-label="Graphe des services">
      <defs><filter id="sh" x="-20%" y="-30%" width="140%" height="180%"><feDropShadow dx="0" dy="4" stdDeviation="6" flood-opacity=".08"/></filter></defs>
      ${links.map(([a, b, w]) => {
        if (!pos[a] || !pos[b]) return null;
        const [x1, y1] = pos[a], [x2, y2] = pos[b]; const mx = (x1 + x2) / 2 + (y2 - y1) * 0.18, my = (y1 + y2) / 2 - (x2 - x1) * 0.18;
        const coupe = !(w.enabled || w.graph.nodes.every(n => n.type === 'core.link'));
        return html`<path d="M${x1},${y1} Q${mx},${my} ${x2},${y2}" fill="none" stroke=${w.origin === 'Auto' ? 'var(--accent)' : 'var(--ink)'} stroke-width="1.5" stroke-dasharray=${coupe ? '2 5' : null} opacity=${coupe ? '.5' : null}><title>${w.name}</title></path>`;
      })}
      ${inst.map(c => { const [x, y] = pos[c.id]; return html`<g><rect class="plate" x=${x - 80} y=${y - 22} width="160" height="44" rx="11" filter="url(#sh)"/>
        <g transform="translate(${x - 70},${y - 12})" style=${{ color: c.status === 'online' ? 'var(--accent)' : 'var(--alarm)' }}><rect width="24" height="24" rx="7" fill="var(--well)"/>${picto(c)}</g>
        <text class="glabel" x=${x - 38} y=${y - 1}>${c.name.slice(0, 16)}</text><text class="gsub" x=${x - 38} y=${y + 12}>${c.mode === 'remote' ? 'distant' : 'local'}</text></g>`; })}
    </svg>` : html`<div class="list-empty">Aucun service.</div>`}</div></div>`);
  bindCommon(el);
}

// Connexions : les noms des services, tenus par Relay. Le Hub y publie chaque
// service qu'il installe ; ici, on voit ce qui répond et on règle le reste.
const MODES_ROUTE = { local: 'Local — certificat de Relay', public: 'Public — Let’s Encrypt', clair: 'Sans TLS — derrière un relais' };
const MODE_COURT = { local: 'local', public: 'public', clair: 'sans TLS' };
/* L'état d'une route, tel qu'un navigateur le vivrait : le nom n'est servi que
   si Caddy a sa configuration, et la cible doit répondre en HTTP sans erreur. */
const causeSante = s => (s.code ? `cible : erreur ${s.code}` : `cible : ${s.erreur || 'injoignable'}`);
function tagRoute(r, caddy) {
  if (!r.actif) return html`<span class="tag idle"><span class="d"></span>en pause</span>`;
  if (caddy && !caddy.ok) return html`<span class="tag held" title=${caddy.erreur || ''}><span class="d"></span>non servi</span>`;
  if (!r.sante) return html`<span class="tag idle"><span class="d"></span>sonde à venir</span>`;
  return r.sante.ok ? html`<span class="tag"><span class="d"></span>en ligne · ${r.sante.ms} ms</span>` : html`<span class="tag held"><span class="d"></span>${causeSante(r.sante)}</span>`;
}
const urlRoute = r => `${r.mode === 'clair' && !r.cf ? 'http' : 'https'}://${r.hote}`;
async function viewConnexions(el, t) {
  const admin = session.role === 'admin';
  // Le tunnel, en même temps que le reste ; une erreur ici ne cache pas la page.
  const [c, tunnelLu] = await Promise.all([GET('/api/connexions'), admin ? GET('/api/connexions/tunnel').catch(e => ({ erreur: e.message })) : null]);
  if (!alive(t)) return;
  // La carte paraît dès que Cloudflare est connecté, ou tant qu'un connecteur tourne (pour pouvoir le couper).
  const tun = tunnelLu && c.relay && (c.zonesCloudflare?.length || tunnelLu.connecteur) ? tunnelLu : null;
  if (!c.relay) {
    poser(el, headrow('Connexions', 'Un nom pour chaque service, en HTTPS ou par un tunnel Cloudflare : c’est le rôle de Relay.', html`<button class="btn solid" data-nav="ext">${I('plus', 15)}Installer Relay</button>`),
      html`<div class="card"><div class="list-empty">Relay n’est pas installé. Une fois ajouté depuis Extensions, chaque service installé ici reçoit son nom et cette page montre toutes les routes.</div></div>`);
    return bindCommon(el);
  }
  const libres = c.services.filter(s => s.cible && !s.routes.length);
  const proprio = r => (r.proprietaire?.startsWith('hub:') ? html`<span class="chip a">${I('auto', 12)}${r.proprietaire.slice(4)}</span>` : r.proprietaire?.startsWith('service:') ? html`<span class="chip">${r.proprietaire.slice(8)}</span>` : html`<span class="chip">${I('user', 12)}à la main</span>`);
  poser(el, headrow('Connexions', html`Les noms servis par ${c.relay.nom}. ${c.domaines.length ? '' : html`<span class="err">Aucun domaine : ajoute-en un pour nommer les services.</span>`}`,
      admin ? html`<button class="btn solid" id="cnNouvelle">${I('plus', 15)}Nouvelle route</button>` : ''),
    c.erreur ? html`<div class="errbox">${c.erreur}</div>` : '',
    carteDomaines(c, admin),
    tun ? carteTunnel(tun, c) : '',
    html`<div class="card"><header><h2>Le Hub</h2>${c.hub.routes.length ? html`<span class="note">publié</span>` : ''}</header><div class="pad">
      ${c.hub.routes.length
        ? html`<p class="hint">Le Hub répond aussi sous ${c.hub.routes.map((h, i) => html`${i ? ', ' : ''}<a class="lnk mono" href=${`https://${h}`} target="_blank" rel="noopener">${h}</a>`)}, en plus de son adresse sur le port 8100.</p>${admin ? html`<button class="btn" id="cnHubRetirer">Retirer ce nom</button>` : ''}`
        : html`<p class="hint">Publie le Hub derrière Relay pour l’ouvrir par un nom : sur le réseau (mode local), ou depuis Internet (Let’s Encrypt, ou le tunnel Cloudflare).</p>${admin ? html`<button class="btn solid" id="cnHubPublier">${I('globe', 15)}Publier le Hub</button>` : ''}`}
    </div></div>`,
    html`<div class="card"><header><h2>Routes</h2><span class="note ${c.caddy && !c.caddy.ok ? 'err' : ''}">${c.caddy ? (c.caddy.ok ? 'Caddy à jour' : 'Caddy en panne') : ''}</span></header>
      ${c.caddy && !c.caddy.ok ? html`<div class="pad"><div class="errbox">Aucun nom n’est servi : ${c.caddy.erreur}</div></div>` : ''}
      ${c.routes.length ? html`<div class="tw"><table><thead><tr><th>Nom</th><th class="cache-m">Cible</th><th class="cache-s">Mode</th><th class="cache-s">Posée par</th><th>État</th>${admin ? html`<th></th>` : ''}</tr></thead><tbody>
      ${c.routes.map(r => html`<tr data-donnee><td class="principal"><div class="who-cell"><span class="itile ${r.actif && r.sante?.ok ? 'key' : ''}">${I(r.cf ? 'send' : 'globe')}</span><div class="tronque"><a class="lnk tronque" href=${urlRoute(r)} target="_blank" rel="noopener">${r.hote}</a><small class="tronque">${r.nom || ''}</small></div></div></td>
        <td class="mono cache-m"><span class="cible-route tronque" title=${r.cible}>${r.cible}</span></td><td class="cache-s">${r.cf ? 'tunnel' : MODE_COURT[r.mode]}</td><td class="cache-s">${proprio(r)}</td><td>${tagRoute(r, c.caddy)}</td>
        ${admin ? html`<td class="fin"><button class="btn sm flat" data-route=${r.id} aria-label=${`Actions pour ${r.hote}`}>${I('settings', 15)}</button></td>` : ''}</tr>`)}
      </tbody></table></div>` : html`<div class="list-empty">Aucune route pour l’instant.</div>`}
    </div>
    ${libres.length ? html`<div class="card"><header><h2>Services sans nom</h2><span class="note">${libres.length}</span></header>
      ${libres.map(s => html`<div class="flowrow"><span class="itile">${I(pictoService(s.icone))}</span><div class="grow tronque"><strong>${s.nom}</strong><small class="mono tronque">${s.cible}</small></div>${admin ? html`<div class="fin"><button class="btn sm solid" data-publier=${s.id}>Publier</button></div>` : ''}</div>`)}
    </div>` : ''}
    ${domainesLocaux(c).length && c.ip ? carteAppareils(c) : ''}`);
  bindCommon(el);
  const recharger = () => navigate('conn');
  if ($('#cnAutorite', el)) $('#cnAutorite', el).onclick = () => pulse($('#cnAutorite', el), async () => {
    const r = await fetch('/api/connexions/autorite', { credentials: 'same-origin' });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Certificat indisponible');
    const a = element(html`<a download="relay-autorite.crt"></a>`); a.href = URL.createObjectURL(await r.blob()); document.body.append(a); a.click(); a.remove();
  }).catch(fail);
  if ($('#cnCopier', el)) $('#cnCopier', el).onclick = async () => {
    try { await navigator.clipboard.writeText(blocMac(c)); toast('Bloc copié'); } catch { toast('Sélectionne le bloc et copie-le', 'err'); }
  };
  if (!admin) return;
  const poserDomaines = async (domaines, quoi) => {
    const o = await PUT('/api/connexions/domaines', { domaines });
    const n = o.deplaces.faits.length + o.publies.faits.length;
    toast(n ? `${quoi} : ${n} nom(s) posé(s)` : quoi);
    for (const x of [...o.deplaces.erreurs, ...o.publies.erreurs]) toast(`${x.service} : ${x.erreur}`, 'err');
    recharger();
  };
  const ajouter = d => pulse($('#domAjouter', el), () => poserDomaines([...c.domaines, d], `${d} ajouté`)).catch(fail);
  $('#domForm', el).onsubmit = e => { e.preventDefault(); const d = $('#domNeuf', el).value.trim().toLowerCase(); if (d) ajouter(d); };
  if ($('#domLocal', el)) $('#domLocal', el).onclick = () => ajouter('home.arpa');
  $$('[data-dom-ajouter]', el).forEach(b => { b.onclick = () => ajouter(b.dataset.domAjouter); });
  if ($('#cfConnecter', el)) $('#cfConnecter', el).onclick = () => formCloudflare(c, recharger);
  if ($('#cfRetirer', el)) $('#cfRetirer', el).onclick = async () => {
    if (!(await confirmBox('Déconnecter Cloudflare ?', 'Les enregistrements que Relay a écrits sont effacés, et les noms reviennent au résolveur et au certificat de Relay.', 'Déconnecter'))) return;
    try { await DEL('/api/connexions/cloudflare'); toast('Cloudflare déconnecté'); recharger(); } catch (e) { fail(e); }
  };
  $$('[data-dom-defaut]', el).forEach(b => { b.onclick = () => pulse(b, () => poserDomaines([b.dataset.domDefaut, ...c.domaines.filter(d => d !== b.dataset.domDefaut)], `${b.dataset.domDefaut} par défaut`)).catch(fail); });
  $$('[data-dom-retirer]', el).forEach(b => { b.onclick = async () => {
    const d = b.dataset.domRetirer, reste = c.domaines.filter(x => x !== d);
    if (!(await confirmBox(`Retirer ${d} ?`, reste.length ? `Les noms posés par le Hub sous ${d} passent sous ${reste[0]}. Ceux posés à la main restent tels quels.` : 'C’est le dernier domaine : plus aucun service ne recevra de nom.', 'Retirer'))) return;
    try { await poserDomaines(reste, `${d} retiré`); } catch (e) { fail(e); }
  }; });
  if ($('#tunActiver', el)) $('#tunActiver', el).onclick = () => pulse($('#tunActiver', el), async () => {
    const choix = $('#tunChoix', el).value;
    const corps = choix === '+' ? { nom: $('#tunNom', el).value.trim() } : { tunnel: choix };
    if (corps.nom === '') throw new Error('Donne un nom au nouveau tunnel.');
    const o = await PUT('/api/connexions/tunnel', corps);
    toast(`Tunnel ${o.tunnel.nom} activé : Relay redémarre avec son connecteur${o.republiees ? ` · ${o.republiees} nom(s) le rejoignent` : ''}`);
    recharger();
  }).catch(fail);
  if ($('#tunChoix', el)) $('#tunChoix', el).onchange = () => { $('#tunNomRang', el).hidden = $('#tunChoix', el).value !== '+'; };
  if ($('#tunTout', el)) $('#tunTout', el).onclick = async () => {
    const noms = aPasserAuTunnel(c.routes).map(r => r.hote);
    if (!(await confirmBox('Tout passer par le tunnel ?', `Ces noms s’ouvriront depuis Internet : ${noms.join(', ')}. Chaque service ne tient plus qu’à ses comptes. Le Hub, lui, reste à part.`, 'Passer par le tunnel'))) return;
    pulse($('#tunTout', el), async () => {
    const o = await POST('/api/connexions/tunnel/tout');
    toast(o.faits.length ? `${o.faits.length} nom(s) passé(s) par le tunnel` : 'Tous les noms passent déjà par le tunnel');
    for (const x of o.erreurs) toast(`${x.hote} : ${x.erreur}`, 'err');
    recharger();
    }).catch(fail);
  };
  if ($('#tunCouper', el)) $('#tunCouper', el).onclick = async () => {
    if (!(await confirmBox('Couper le tunnel ?', 'Le connecteur s’arrête et ses noms quittent le tunnel : ils ne répondent plus depuis Internet, jusqu’à ce que tu le relances ou que tu les repasses en local.', 'Couper'))) return;
    try { const o = await DEL('/api/connexions/tunnel'); toast('Tunnel coupé'); if (o.avertissement) toast(o.avertissement, 'err'); recharger(); } catch (e) { fail(e); }
  };
  $('#cnNouvelle', el).onclick = () => formRoute(null, c, recharger);
  if ($('#cnHubPublier', el)) $('#cnHubPublier', el).onclick = () => formPublierHub(c, recharger);
  if ($('#cnHubRetirer', el)) $('#cnHubRetirer', el).onclick = async () => {
    if (!(await confirmBox('Retirer le nom du Hub ?', 'Le Hub reste joignable sur son port 8100.', 'Retirer'))) return;
    try { await DEL('/api/connexions/hub'); toast('Nom retiré'); recharger(); } catch (e) { fail(e); }
  };
  $$('[data-route]', el).forEach(b => { b.onclick = () => actionsRoute(c.routes.find(r => r.id === b.dataset.route), c, recharger); });
  $$('[data-publier]', el).forEach(b => { b.onclick = () => formPublier(c.services.find(s => s.id === b.dataset.publier), c, recharger); });
}
/* Sur chaque appareil : son DNS demande le domaine à Relay, et il croit son
   certificat. Le bloc porte le domaine et l'adresse de cette installation. */
// Les domaines qui ne sont pas chez Cloudflare : ceux-là passent par le résolveur et le certificat de Relay.
const domainesLocaux = c => c.domaines.filter(d => !c.zonesCloudflare.some(z => d === z || d.endsWith(`.${z}`)));
function blocMac(c) {
  return `sudo mkdir -p /etc/resolver && for d in ${domainesLocaux(c).join(' ')}; do echo "nameserver ${c.ip}" | sudo tee /etc/resolver/$d >/dev/null; done && sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/Downloads/relay-autorite.crt && echo "Domaines prêts sur ce Mac"`;
}
function carteAppareils(c) {
  return html`<div class="card"><header><h2>Sur tes appareils</h2><span class="note mono">${domainesLocaux(c).join(', ')}</span></header><div class="pad">
    <p class="hint">Ces domaines ne sont pas chez Cloudflare : chaque appareil doit demander leurs noms au résolveur de Relay (${c.ip}) et croire son certificat. Télécharge le certificat, puis copie le bloc dans le Terminal du Mac.</p>
    <pre class="pre">${blocMac(c)}</pre>
    <div class="rang-btn"><button class="btn" id="cnAutorite">${I('export', 15)}Certificat</button><button class="btn" id="cnCopier">${I('file', 15)}Copier</button></div>
    <p class="hint">Pour tout le réseau d’un coup (téléphones compris) : mets ${c.ip} comme DNS dans ton routeur. Le certificat reste à installer sur chaque appareil.</p>
  </div></div>`;
}
/* Les domaines, en un seul endroit : chaque route se nomme ensuite
   « nom . domaine » en choisissant parmi eux. Le premier sert d'office.
   Un domaine chez Cloudflare (jeton connecté) n'a rien à installer sur les
   appareils : nom publié vers la machine, certificat Let's Encrypt. */
function carteDomaines(c, admin) {
  const cf = d => c.zonesCloudflare.some(z => d === z || d.endsWith(`.${z}`));
  const aAjouter = c.zonesCloudflare.filter(z => !c.domaines.includes(z));
  return html`<div class="card"><header><h2>Domaines</h2>${c.zonesCloudflare.length ? html`<span class="note">Cloudflare connecté</span>` : ''}</header>
    ${c.domaines.length ? c.domaines.map((d, i) => html`<div class="flowrow"><span class="itile ${i ? '' : 'key'}">${I('globe')}</span><div class="grow tronque"><strong class="mono tronque">${d}</strong><small class="tronque">${i ? '' : 'par défaut · '}${cf(d) ? 'Cloudflare : rien à installer sur les appareils' : 'résolveur et certificat de Relay'}</small></div>
      ${admin ? html`<div class="fin">${i ? html`<button class="btn sm" data-dom-defaut=${d}>Par défaut</button>` : ''}<button class="btn sm flat" data-dom-retirer=${d} aria-label=${`Retirer ${d}`}>${I('x', 15)}</button></div>` : ''}</div>`)
      : html`<div class="list-empty">Aucun domaine. Connecte Cloudflare pour tes domaines, ou ajoute home.arpa pour ton réseau.</div>`}
    ${admin ? aAjouter.map(z => html`<div class="flowrow"><span class="itile">${I('globe')}</span><div class="grow tronque"><strong class="mono tronque" title=${z}>${z}</strong><small class="tronque">chez Cloudflare, pas encore ajouté</small></div><div class="fin"><button type="button" class="btn sm" data-dom-ajouter=${z} aria-label=${`Ajouter ${z}`}>${I('plus', 13)}Ajouter</button></div></div>`) : ''}
    ${admin ? html`<div class="pad"><form class="saisie-ajout" id="domForm"><input class="field mono" id="domNeuf" placeholder="exemple.fr" aria-label="Domaine à ajouter" autocomplete="off" spellcheck="false"><button class="btn solid" id="domAjouter">${I('plus', 15)}Ajouter</button></form>
      <div class="rang-btn">${c.zonesCloudflare.length
        ? html`<button type="button" class="btn sm" id="cfRetirer">Déconnecter Cloudflare</button>`
        : html`<button type="button" class="btn sm" id="cfConnecter">${I('globe', 13)}Connecter Cloudflare</button>`}${c.domaines.includes('home.arpa') ? '' : html`<button type="button" class="btn sm flat" id="domLocal">${I('plus', 13)}home.arpa</button>`}</div></div>` : ''}
  </div>`;
}
/* Le tunnel Cloudflare : un tunnel du compte (choisi ou créé par Relay), dont
   le connecteur tourne dans la pile de Relay. Les noms qui passent par lui
   répondent de partout, sans port ouvert ni adresse privée dans le DNS. */
// Les noms qu'« Tout par le tunnel » ferait passer : ceux des services posés par le Hub, jamais le Hub lui-même.
const aPasserAuTunnel = routes => routes.filter(r => !r.cf && r.proprietaire?.startsWith('hub:') && r.proprietaire !== 'hub:le-hub');
function carteTunnel(t, c) {
  const tete = (note = '') => html`<header><h2>Tunnel Cloudflare</h2>${note ? html`<span class="note">${note}</span>` : ''}</header>`;
  if (t.distant) return html`<div class="card">${tete()}<div class="pad"><p class="hint">${c.relay.nom} tourne sur une autre machine : règle son tunnel depuis son interface, là où tourne son connecteur.</p></div></div>`;
  if (t.ancien) return html`<div class="card">${tete()}<div class="pad"><p class="hint">Mets ${c.relay.nom} à jour (Extensions) : depuis la 2.2.0, le tunnel se règle ici et son connecteur tourne avec Relay.</p></div></div>`;
  if (t.erreur && !t.connecte) {
    return html`<div class="card">${tete(t.connecteur ? 'connecteur en marche' : '')}<div class="pad"><div class="errbox">${t.erreur}</div>
      ${t.connecteur ? html`<div class="rang-btn"><button class="btn" id="tunCouper">Couper</button></div>` : ''}</div></div>`;
  }
  const viaTunnel = c.routes.filter(r => r.cf).length, enLocal = aPasserAuTunnel(c.routes).length;
  if (t.actif || t.connecteur) {
    return html`<div class="card">${tete('actif')}<div class="pad">
      <div class="flowrow"><span class="itile key">${I('send')}</span><div class="grow tronque"><strong class="tronque">${t.tunnel?.nom || 'tunnel'}</strong><small class="tronque">${viaTunnel} nom(s) par le tunnel · ${enLocal} en local${t.compte?.nom ? ` · compte ${t.compte.nom}` : ''}</small></div></div>
      ${t.erreur ? html`<div class="errbox">${t.erreur}</div>` : ''}
      <p class="hint">Un nom qui passe par le tunnel s’ouvre de partout, en HTTPS, sans port ouvert chez toi. Un nom en local ne s’ouvre que sur ton réseau.</p>
      <div class="rang-btn">${enLocal ? html`<button class="btn solid" id="tunTout">${I('send', 15)}Tout par le tunnel</button>` : ''}<button class="btn" id="tunCouper">Couper</button></div>
    </div></div>`;
  }
  const tunnels = t.tunnels || [];
  return html`<div class="card">${tete()}<div class="pad">
    <p class="hint">Pour ouvrir tes services de partout : Relay crée (ou reprend) un tunnel de ton compte Cloudflare et lance son connecteur. Le jeton d’API doit avoir aussi Compte → Cloudflare Tunnel → Modifier, et Compte → Paramètres du compte → Lire.</p>
    ${t.erreur ? html`<div class="errbox">${t.erreur}</div>` : ''}
    <div class="fl"><label for="tunChoix">Tunnel</label><select class="field" id="tunChoix">
      <option value="+">Nouveau tunnel</option>
      ${tunnels.map(x => x.choisissable ? html`<option value=${x.id}>${x.nom}</option>` : html`<option value=${x.id} disabled>${x.nom} (indisponible)</option>`)}
    </select></div>
    <div class="fl" id="tunNomRang"><label for="tunNom">Nom du nouveau tunnel</label><input class="field mono" id="tunNom" value="hub" autocomplete="off" spellcheck="false"></div>
    <div class="rang-btn"><button class="btn solid" id="tunActiver">${I('send', 15)}Activer le tunnel</button></div>
  </div></div>`;
}
function formCloudflare(c, recharger) {
  modal({ title: 'Connecter Cloudflare', sub: 'Tes domaines chez Cloudflare marchent sur tous tes appareils, sans rien y installer : Relay publie chaque nom et obtient son certificat Let’s Encrypt.',
    body: html`<ol class="etapes">
        <li><a class="lnk" href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noopener">Jetons d’API</a> → Créer un jeton → modèle « Modifier la zone DNS ».</li>
        <li>Autorisations : Zone → DNS → Modifier, et ajoute Zone → Zone → Lire. Ressources : ton domaine. Pour le tunnel (accès de partout), ajoute Compte → Cloudflare Tunnel → Modifier et Compte → Paramètres du compte → Lire.</li>
        <li>Colle le jeton ici.</li></ol>
      <div class="fl"><label for="cfJeton">Jeton d’API</label><input class="field mono" id="cfJeton" type="password" autocomplete="off" spellcheck="false"></div>
      <p class="hint">Un nom en mode local pointe vers ${c.ip || 'l’adresse de la machine'} dans le DNS de Cloudflare : il ne s’ouvre que chez toi, mais cette adresse privée y est visible. Le jeton est scellé dans Relay ; le Hub ne le garde pas.</p>`,
    actions: [{ label: 'Annuler' }, { label: 'Connecter', cls: 'solid', run: async me => {
      const jeton = $('#cfJeton', me).value.trim();
      if (!jeton) throw new Error('Colle le jeton d’API.');
      const o = await PUT('/api/connexions/cloudflare', { jeton });
      toast(`Cloudflare connecté : ${o.zones.join(', ')}${o.enregistrements.faits.length ? ` · ${o.enregistrements.faits.length} nom(s) publié(s)` : ''}`);
      for (const x of o.enregistrements.erreurs) toast(`${x.hote} : ${x.erreur}`, 'err');
      if (o.avertissement) toast(o.avertissement, 'err');
      recharger();
    } }] });
}
/* « nom . domaine » : le nom saisi, le domaine choisi parmi ceux enregistrés.
   Un nom existant hors de ces domaines garde le sien dans la liste. */
function champNom(id, c, { hote = '', nom = '' } = {}) {
  const doms = [...c.domaines];
  let dom = doms[0] || '';
  if (hote) {
    const d = doms.filter(x => hote.endsWith(`.${x}`)).sort((a, b) => b.length - a.length)[0];
    if (d) { nom = hote.slice(0, -(d.length + 1)); dom = d; }
    else { const i = hote.indexOf('.'); nom = i > 0 ? hote.slice(0, i) : hote; dom = i > 0 ? hote.slice(i + 1) : ''; if (dom) doms.push(dom); }
  }
  return html`<div class="fl"><label for=${id}>Nom</label><div class="saisie-domaine"><input class="field mono" id=${id} value=${nom} placeholder="nom" autocomplete="off" spellcheck="false"><span class="mono dim" aria-hidden="true">.</span><select class="field mono" id=${`${id}Dom`} aria-label="Domaine">${doms.length ? doms.map(d => html`<option value=${d} selected=${d === dom}>${d}</option>`) : html`<option value="">aucun domaine</option>`}</select></div></div>`;
}
function lireNom(me, id) {
  const nom = $(`#${id}`, me).value.trim().toLowerCase().replace(/^\.+|\.+$/g, ''), dom = $(`#${id}Dom`, me).value;
  if (!dom) throw new Error('Ajoute d’abord un domaine (carte Domaines).');
  if (!nom) throw new Error('Nom : obligatoire.');
  return `${nom}.${dom}`;
}
function actionsRoute(r, c, recharger) {
  modal({ title: r.hote, sub: `${r.cible} · ${r.cf ? 'tunnel Cloudflare' : MODE_COURT[r.mode]}`,
    body: html`<p class="hint">Une route posée par le Hub revient au prochain déploiement de son service si tu la supprimes : retire plutôt le service, ou mets-la en pause.</p>`,
    actions: [
      { label: 'Supprimer', cls: 'danger', run: async () => { if (!(await confirmBox(`Retirer ${r.hote} ?`, 'Le nom ne sera plus servi par Relay.', 'Retirer'))) return false; const o = await DEL(`/api/connexions/routes/${r.id}`); if (o.avertissement) toast(o.avertissement, 'err'); recharger(); } },
      { label: r.actif ? 'Mettre en pause' : 'Reprendre', run: async () => { await PATCH(`/api/connexions/routes/${r.id}`, { actif: !r.actif }); recharger(); } },
      { label: 'Modifier', cls: 'solid', run: () => { formRoute(r, c, recharger); } },
    ] });
}
function formRoute(r, c, recharger) {
  const nouveau = !r;
  modal({ title: nouveau ? 'Nouvelle route' : `Modifier ${r.hote}`, sub: 'Un nom, une machine vue depuis Relay : un service du Hub (hub-<nom>:port) ou une adresse du réseau.',
    body: html`${champNom('rtHote', c, { hote: r?.hote || '' })}
      <div class="fl"><label for="rtCible">Cible</label><input class="field mono" id="rtCible" value=${r?.cible || ''} placeholder="hub-mapmylan:8090 ou https://192.0.2.20:8006" autocomplete="off" spellcheck="false"></div>
      <div class="fl"><label for="rtMode">Certificat</label><select class="field" id="rtMode">${Object.entries(MODES_ROUTE).map(([v, l]) => html`<option value=${v} selected=${(r?.mode || 'local') === v}>${l}</option>`)}</select></div>
      ${c.cloudflare ? html`<label class="check"><input type="checkbox" id="rtCf" checked=${!!r?.cf}> Publier par le tunnel Cloudflare</label>` : ''}
      <label class="check"><input type="checkbox" id="rtVerif" checked=${!!r?.verifier}> Vérifier le certificat de la cible (https:// avec un vrai certificat)</label>`,
    actions: [{ label: 'Annuler' }, { label: nouveau ? 'Créer' : 'Enregistrer', cls: 'solid', run: async me => {
      const corps = { hote: lireNom(me, 'rtHote'), cible: $('#rtCible', me).value.trim(), mode: $('#rtMode', me).value, verifier: $('#rtVerif', me).checked, ...($('#rtCf', me) ? { cf: $('#rtCf', me).checked } : {}) };
      const o = nouveau ? await POST('/api/connexions/routes', corps) : await PATCH(`/api/connexions/routes/${r.id}`, corps);
      if (o.avertissement) toast(o.avertissement, 'err');
      toast(nouveau ? 'Route créée' : 'Route enregistrée'); recharger();
    } }] });
}
function formPublierHub(c, recharger) {
  modal({ title: 'Publier le Hub', sub: 'Le Hub pilote Docker, donc toute la machine. Depuis Internet, il ne tient plus qu’à ses comptes : clé d’accès pour chaque administrateur, et rien d’autre d’ouvert.',
    body: html`${champNom('phSous', c, { nom: 'hub' })}
      <div class="fl"><label for="phMode">Certificat</label><select class="field" id="phMode">${Object.entries(MODES_ROUTE).filter(([v]) => v !== 'clair').map(([v, l]) => html`<option value=${v}>${l}</option>`)}${c.cloudflare ? html`<option value="cloudflare">Tunnel Cloudflare</option>` : ''}</select></div>
      <p class="hint">Public : le nom doit pointer vers ta box, et les ports 80 et 443 être redirigés vers cette machine. Tunnel Cloudflare : rien à ouvrir.</p>`,
    actions: [{ label: 'Annuler' }, { label: 'Publier', cls: 'solid', run: async me => {
      const o = await PUT('/api/connexions/hub', { mode: $('#phMode', me).value, hote: lireNom(me, 'phSous') });
      if (o.avertissement) toast(o.avertissement, 'err');
      toast(`Hub publié sur ${o.url}`); recharger();
    } }] });
}
function formPublier(s, c, recharger) {
  modal({ title: `Publier ${s.nom}`, sub: `Vers ${s.cible}`,
    body: html`${champNom('pbSous', c, { nom: s.nom })}
      <div class="fl"><label for="pbMode">Certificat</label><select class="field" id="pbMode">${Object.entries(MODES_ROUTE).map(([v, l]) => html`<option value=${v} disabled=${v === 'public' && s.internet === false}>${l}${v === 'public' && s.internet === false ? ' (indisponible)' : ''}</option>`)}${c.cloudflare ? html`<option value="cloudflare" disabled=${s.internet === false}>Tunnel Cloudflare${s.internet === false ? ' (indisponible)' : ''}</option>` : ''}</select>
        ${s.internet === false ? html`<div class="mini">Pas sur Internet : ${s.extension} crée son premier compte administrateur sans lien d’installation. Mets-le à jour d’abord.</div>` : ''}</div>`,
    actions: [{ label: 'Annuler' }, { label: 'Publier', cls: 'solid', run: async me => {
      const o = await PUT(`/api/connexions/services/${s.id}`, { hote: lireNom(me, 'pbSous'), mode: $('#pbMode', me).value });
      if (o.avertissement) toast(o.avertissement, 'err');
      toast(`Publié sur ${o.url}`); recharger();
    } }] });
}

// Journal
async function viewJournal(el, t) {
  const [rows, ver] = await Promise.all([GET('/api/audit?limit=300'), GET('/api/audit/verify')]);
  if (!alive(t)) return;
  /* Une ligne par action : l'heure, qui, quoi — et le détail en une ligne
     lisible (« hote : proxlab… · mode : public »), déplié d'un clic. Les
     journées se séparent par un intertitre plutôt que de répéter la date. */
  let filtre = '';
  const valeur = v => v == null ? '—' : typeof v === 'object' ? (Array.isArray(v) ? v.map(valeur).join(', ') : JSON.stringify(v)) : String(v);
  const paires = d => d && typeof d === 'object' && !Array.isArray(d) ? Object.entries(d).filter(([, v]) => v !== undefined && v !== '') : (d == null ? [] : [['valeur', d]]);
  const resume = d => paires(d).map(([k, v]) => `${k} : ${valeur(v)}`).join(' · ');
  const jour = ts => { const d = new Date(ts), a = new Date(); const j = x => x.toDateString(); if (j(d) === j(a)) return 'Aujourd’hui'; a.setDate(a.getDate() - 1); if (j(d) === j(a)) return 'Hier'; return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }); };
  const heure = ts => new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const peindre = () => {
    const f = filtre.trim().toLowerCase();
    const vues = rows.filter(r => !f || `${r.actor} ${r.action} ${labelAction(r)} ${resume(r.detail)}`.toLowerCase().includes(f));
    const groupes = [];
    for (const r of vues) { const k = jour(r.ts); if (!groupes.length || groupes.at(-1).k !== k) groupes.push({ k, l: [] }); groupes.at(-1).l.push(r); }
    poser(el, headrow('Journal', html`Toutes les actions : les tiennes, celles du Hub et celles de l’IA. Chaîne d’intégrité : ${ver.ok ? html`<span class="ok-t">intacte (${ver.entries} entrées)</span>` : html`<span class="err">rompue à l’entrée ${ver.brokenAt}</span>`}.`,
        html`<input class="field recherche" id="jQ" type="search" placeholder="Filtrer…" value=${filtre} aria-label="Filtrer le journal">`),
      vues.length ? html`<div class="card jl">${groupes.map(g => html`<div class="jl-jour">${g.k}<span>${g.l.length}</span></div>${g.l.map(r => {
        const det = resume(r.detail);
        return html`<details class="jl-ligne">
          <summary><span class="jl-h mono">${heure(r.ts)}</span><span class="itile sm cache-s">${I(actionIcon(r.action), 13)}</span>
            <span class="jl-quoi"><b>${labelAction(r)}</b>${det ? html`<small>${det}</small>` : ''}</span>
            <span class="jl-qui">${r.actor === 'hub' ? html`<span class="chip a">hub</span>` : html`<span class="chip">${r.actor}</span>`}</span></summary>
          ${paires(r.detail).length ? html`<dl class="jl-det">${paires(r.detail).map(([k, v]) => html`<dt>${k}</dt><dd class="mono">${valeur(v)}</dd>`)}</dl>` : html`<p class="jl-det vide-det">Pas de détail.</p>`}
        </details>`;
      })}`)}</div>` : html`<div class="card list-empty">${f ? 'Rien ne correspond.' : 'Journal vide.'}</div>`);
    const q = $('#jQ', el);
    q.oninput = () => { filtre = q.value; const pos = q.selectionStart; peindre(); const n = $('#jQ', el); n.focus(); n.setSelectionRange(pos, pos); };
  };
  peindre();
  let pend;
  app.on('audit', () => { clearTimeout(pend); pend = setTimeout(() => alive(t) && viewJournal(el, t), 1000); });
}

// Thème : deux onglets. « Thème global » choisit la gamme commune ; « Par
// service » donne au Hub et à chaque service la sienne, ou le laisse suivre le
// thème global. Rien ne part avant « Appliquer » : changer de gamme redémarre
// les services concernés. Un service ne se voit offrir que les gammes que son
// socle connaît ; les autres lui arriveraient en SOMA.
const NOM_GAMME = { soma: 'SOMA', console: 'Console', exploitation: 'Exploitation', lavande: 'Lavande' };
const apercuGamme = g => html`<span class="apercu" data-g=${g} aria-hidden="true">${['clair', 'sombre'].map(v => html`<span class=${`ecran ${v}`}><i class="rail"></i><i class="barre"></i><i class="ligne"></i><i class="ligne courte"></i><i class="bouton"></i></span>`)}</span>`;
let ongletTheme = null;
async function viewTheme(el, t) {
  let th = await GET('/api/theme');
  if (!alive(t)) return;
  const admin = session.role === 'admin';
  // par : seulement les choix propres ; absent = suit le thème global.
  const depart = () => ({ commun: th.commun, par: th.mode === 'service' ? { ...th.parService } : {} });
  let choix = depart();
  if (!ongletTheme) ongletTheme = th.mode === 'service' ? 'service' : 'global';
  const nom = g => NOM_GAMME[g] || g;
  const detail = Object.fromEntries(th.gammes.map(g => [g.id, g.label.split(' — ')[1] || g.label]));
  const gammeDe = cle => choix.par[cle] || choix.commun;
  const modifie = () => JSON.stringify(choix) !== JSON.stringify(depart());
  // Ce que « Appliquer » enverra, dit en clair : un choix fait dans un onglet
  // part aussi quand on applique depuis l'autre (le thème global en premier).
  const changements = () => {
    const avant = depart().par, l = [];
    if (choix.commun !== th.commun) l.push(`Thème global : ${nom(th.commun)} → ${nom(choix.commun)}`);
    for (const x of lignes()) {
      if (avant[x.cle] !== choix.par[x.cle]) l.push(`${x.nom} : ${choix.par[x.cle] ? nom(choix.par[x.cle]) : 'suit le thème global'}`);
    }
    return l;
  };
  const lignes = () => [{ cle: 'hub', nom: 'Hub', sous: 'cette interface', suit: true, gammes: th.gammes.map(g => g.id) },
    ...th.services.map(s => ({ cle: s.id, nom: s.nom, sous: s.name, suit: s.suit, gammes: s.gammes || ['soma', 'console', ...(s.toutes ? ['exploitation'] : [])] }))];
  // La gamme qu'un service affichera vraiment : SOMA s'il ne connaît pas la sienne.
  const affichee = l => (l.gammes.includes(gammeDe(l.cle)) ? gammeDe(l.cle) : 'soma');
  let resultat = '';
  const peindre = () => {
    const ls = lignes(), suivent = ls.filter(l => l.suit), gardent = ls.filter(l => !l.suit);
    const enSoma = suivent.filter(l => !choix.par[l.cle] && affichee(l) !== choix.commun);
    const onglets = html`<div class="views theme-onglets" role="tablist" aria-label="Thème">
      ${[['global', 'Thème global', 'mode'], ['service', 'Par service', 'panel']].map(([k, l, ic]) => html`<button type="button" role="tab" class=${ongletTheme === k ? 'view on' : 'view'} aria-selected=${ongletTheme === k ? 'true' : 'false'} data-onglet=${k}>${I(ic, 14)}${l}${k === 'service' && Object.keys(choix.par).length ? html`<span class="theme-compte">${Object.keys(choix.par).length}</span>` : ''}</button>`)}</div>`;
    const global = html`<div class="card">
      <div class="sec"><span class="itile key">${I('mode')}</span><div class="grow"><h2>Thème global</h2>
        <p>Celui du Hub et de tous les services qui n'ont pas de choix propre. Clair ou sombre se règle à part, dans chaque interface (soleil ou lune).</p></div></div>
      <div class="pad"><div class="gammes-theme" role="radiogroup" aria-label="Thème global">
        ${th.gammes.map(g => html`<button type="button" class="gamme-theme" role="radio" aria-checked=${g.id === choix.commun ? 'true' : 'false'} data-commun=${g.id} disabled=${!admin}>
          ${apercuGamme(g.id)}<span class="gamme-titre"><b>${nom(g.id)}</b>${g.id === th.commun ? html`<span class="chip">actuel</span>` : ''}</span><small>${detail[g.id]}</small></button>`)}
      </div></div>
      <div class="theme-portee">
        <span>${I('check', 14)}Le prennent : ${suivent.filter(l => !choix.par[l.cle]).map(l => l.nom).join(', ') || 'aucun'}</span>
        ${Object.keys(choix.par).length ? html`<span>${I('panel', 14)}Thème propre : ${suivent.filter(l => choix.par[l.cle]).map(l => `${l.nom} (${nom(choix.par[l.cle])})`).join(', ')}</span>` : ''}
        ${enSoma.length ? html`<span class="warn-t">${I('alert', 14)}${enSoma.map(l => l.nom).join(', ')} ${enSoma.length > 1 ? 'restent' : 'reste'} en SOMA : ${nom(choix.commun)} demande une mise à jour de ${enSoma.length > 1 ? 'ces services' : 'ce service'}.</span>` : ''}
        ${gardent.length ? html`<span class="dim">${I('minus', 14)}Gardent leur apparence (ne lisent pas le thème) : ${gardent.map(l => l.nom).join(', ')}</span>` : ''}
      </div>
    </div>`;
    const ligne = l => {
      const propre = choix.par[l.cle];
      return html`<div class="theme-ligne">
        <div class="theme-qui">${apercuGamme(affichee(l))}<div class="grow"><b>${l.nom}</b><small>${!l.suit ? 'garde son apparence : il ne lit pas le thème du Hub' : propre ? `thème propre : ${nom(propre)}` : `suit le thème global (${nom(choix.commun)})`}${l.suit && affichee(l) !== gammeDe(l.cle) ? ' — affiché en SOMA jusqu’à sa mise à jour' : ''}</small></div></div>
        ${l.suit ? html`<div class="theme-choix" role="radiogroup" aria-label=${`Thème de ${l.nom}`}>
          <button type="button" role="radio" class="theme-puce" aria-checked=${!propre ? 'true' : 'false'} data-cle=${l.cle} data-g="" disabled=${!admin}><i class="pastille global"></i>Global</button>
          ${th.gammes.map(g => {
            const offerte = l.gammes.includes(g.id);
            return html`<button type="button" role="radio" class="theme-puce" aria-checked=${propre === g.id ? 'true' : 'false'} data-cle=${l.cle} data-g=${g.id} disabled=${!admin || !offerte} title=${offerte ? detail[g.id] : `${l.nom} ne connaît pas encore ${nom(g.id)} : à sa prochaine mise à jour`}><i class="pastille" data-g=${g.id}></i>${nom(g.id)}</button>`;
          })}</div>` : html`<span class="chip">inchangé</span>`}
      </div>`;
    };
    const parService = html`<div class="card">
      <div class="sec"><span class="itile key">${I('panel')}</span><div class="grow"><h2>Par service</h2>
        <p>« Global » suit le thème global (${nom(choix.commun)}${choix.commun !== th.commun ? html`, <b class="warn-t">choisi dans l’onglet Thème global, pas encore appliqué : actuel ${nom(th.commun)}</b>` : ''}). Une gamme grisée n'est pas encore connue du service : elle arrivera avec sa mise à jour.</p></div></div>
      ${ls.map(ligne)}
    </div>`;
    poser(el, headrow('Thème', 'L’apparence du Hub et de tes services : un thème global, et si tu veux, un thème propre à certains services.'),
      onglets, ongletTheme === 'global' ? global : parService,
      admin ? html`<div class="theme-barre"><span class="mini" id="themeRes" role="status">${modifie() ? `À appliquer : ${changements().join(' · ')}` : resultat}</span><span class="grow"></span>
        ${modifie() ? html`<button class="btn flat" id="themeAnnuler">Annuler</button>` : ''}<button class="btn solid" id="themeSave" disabled=${!modifie()}>Appliquer</button></div>` : html`<p class="help">Seul un administrateur change le thème.</p>`);
    $$('[data-onglet]', el).forEach(b => { b.onclick = () => { ongletTheme = b.dataset.onglet; peindre(); }; });
    if (!admin) return;
    $$('[data-commun]', el).forEach(b => { b.onclick = () => { choix.commun = b.dataset.commun; resultat = ''; peindre(); }; });
    $$('[data-cle]', el).forEach(b => { b.onclick = () => { if (b.dataset.g) choix.par[b.dataset.cle] = b.dataset.g; else delete choix.par[b.dataset.cle]; resultat = ''; peindre(); }; });
    const annuler = $('#themeAnnuler', el);
    if (annuler) annuler.onclick = () => { choix = depart(); resultat = ''; peindre(); };
    $('#themeSave', el).onclick = e => pulse(e.currentTarget, async () => {
      const par = choix.par;
      th = await PUT('/api/theme', { mode: Object.keys(par).length ? 'service' : 'commun', commun: choix.commun, parService: par });
      if (!alive(t)) return;
      document.documentElement.dataset.gamme = th.hub;
      choix = depart();
      resultat = th.appliqueA.length ? `Appliqué. Redémarrage de ${th.appliqueA.join(', ')} pour recevoir le thème.` : 'Appliqué.';
      peindre();
    }).catch(fail);
  };
  peindre();
}

// Réglages
/* Les alertes du Hub sur Telegram : quel compte de Clés & API, quoi signaler.
   Une mise à jour arrive avec un bouton qui la lance. */
function carteAlertes(a) {
  const prets = a.canaux.filter(c => c.pret);
  return html`<div class="card">
    <div class="sec"><span class="itile key">${I('send')}</span><div class="grow"><h2>Alertes sur Telegram</h2>
      <p>Le Hub te prévient sur Telegram quand quelque chose demande ton attention, sans ouvrir le Hub. Une mise à jour arrive avec un bouton « Mettre à jour » : il ne marche que dans cette discussion, une seule fois, et chaque mise à jour lancée ainsi entre au journal.</p></div></div>
    <div class="pad">
      ${a.canaux.length ? html`<div class="fl"><label for="alrCanal">Bot et discussion</label>
        <select class="field" id="alrCanal"><option value="">Aucun : pas d’alerte</option>${prets.map(c => html`<option value=${c.canal} selected=${c.canal === a.canal}>${c.canal}</option>`)}</select>
        <div class="help">${a.canaux.length > prets.length ? `Pas encore prêt : ${a.canaux.filter(c => !c.pret).map(c => `${c.canal} (${c.manque})`).join(', ')}.` : 'Un compte Telegram de Clés & API : son bot écrit dans sa discussion.'}</div></div>`
        : html`<p class="hint">Ajoute d’abord un compte Telegram dans <button type="button" class="link" data-nav="secrets">Clés & API</button> : le jeton du bot (@BotFather) et l’identifiant de ta discussion.</p><select class="field" id="alrCanal" hidden><option value=""></option></select>`}
      ${Object.entries(a.libelles).map(([k, l]) => html`<label class="check full"><input type="checkbox" data-alr=${k} checked=${a.types[k]}> ${l}</label>`)}
      <div class="row"><button class="btn solid sm" id="alrSave">Enregistrer</button><button class="btn sm" id="alrEssai" disabled=${!prets.length}>Envoyer un essai</button><span class="mini" id="alrRes">${a.etat.erreur ? `Dernier envoi en échec : ${a.etat.erreur}` : a.canal ? `Alertes sur ${a.canal}.` : ''}</span></div>
    </div>
  </div>`;
}
async function viewSettings(el, t) {
  const [ai, vars, expo, jt, dest, cp, mel, alr] = await Promise.all([GET('/api/ai'), GET('/api/variables'), GET('/api/exposition'), GET('/api/jetons').catch(() => ({ jetons: [] })),
    session.role === 'admin' ? GET('/api/destinations') : null, session.role === 'admin' ? GET('/api/coupure') : null, session.role === 'admin' ? GET('/api/courriel') : null,
    session.role === 'admin' ? GET('/api/alertes').catch(() => null) : null]);
  if (!alive(t)) return;
  const roleLbl = { config: 'assistant', workflows: 'workflows', embeddings: 'embeddings' };
  const AUTONOMIES = [['conseil', 'Conseil', 'L’assistant propose, tu fais toi-même.'], ['validation', 'Validation (recommandé)', 'Chaque plan attend ton clic.'], ['autonome', 'Autonome', 'Il fait seul ce qui se défait : créer, corriger, activer, tester, t’écrire sur tes canaux. Supprimer, installer, régler un service, et tout workflow qui envoie des données ailleurs attendent ton accord.']];
  poser(el, headrow('Réglages', 'Exposition, IA, assistant et variables partagées.'), html`
  <div class="card">
    <div class="sec"><span class="itile key">${I('globe')}</span><div class="grow"><h2>Exposition des services</h2>
      <p>Comment on atteint un service depuis l’extérieur de la machine. Seuls les ports destinés aux humains sont concernés : une base de données reste sur la boucle locale quoi qu’on règle.</p></div></div>
    <div class="pad">
      <div class="fl"><label for="expoMode">Par défaut, pour tous les services</label>
        <select class="field" id="expoMode">${expo.modes.map(m => html`<option value=${m.id} selected=${m.id === expo.global} disabled=${!m.disponible}>${m.label}</option>`)}</select>
        <div class="help">Un service peut y déroger depuis sa fiche. Changer ce réglage ne bouge rien tant que les piles n’ont pas été redéployées.</div></div>
      <div class="fl"><label for="expoMachine">Adresse de la machine</label>
        <input class="field mono" id="expoMachine" value=${expo.machine || ''} placeholder=${location.hostname} autocomplete="off" spellcheck="false">
        <div class="help">L’IP ou le nom sous lequel le réseau joint cette machine, sans http:// ni port. Le Hub ne peut pas la deviner depuis son conteneur. Vide : l’adresse par laquelle ton navigateur joint le Hub.</div></div>
      <div class="row"><button class="btn solid sm" id="expoSave">Enregistrer</button><span class="mini" id="expoRes"></span></div>
    </div>
  </div>
  ${alr ? carteAlertes(alr) : ''}
  ${mel ? html`<div class="card">
    <div class="sec"><span class="itile key">${I('mail')}</span><div class="grow"><h2>Courriel des comptes</h2>
      <p>L’adresse proposée à chaque compte créé depuis le Hub, et le relais qui envoie les liens d’invitation et de réinitialisation. Un service le reprend s’il n’a pas le sien et qu’il est servi en HTTPS (adresse publique), à son prochain redéploiement.</p></div></div>
    <div class="pad">
      <div class="fl"><label for="melDefaut">Adresse par défaut des comptes</label>
        <input class="field mono" id="melDefaut" type="email" value=${mel.defaut} placeholder="toi@exemple.org" autocomplete="off" spellcheck="false">
        <div class="help">Remplie d’office à l’invitation, modifiable compte par compte.</div></div>
      <div class="formgrid">
        <div class="fl"><label for="melHote">Relais SMTP</label><input class="field mono" id="melHote" value=${mel.relais.hote} placeholder="smtp.exemple.org" autocomplete="off" spellcheck="false"></div>
        <div class="fl"><label for="melPort">Port</label><input class="field mono" id="melPort" inputmode="numeric" value=${String(mel.relais.port)}></div>
        <div class="fl"><label for="melSecu">Chiffrement</label><select class="field" id="melSecu"><option value="starttls" selected=${mel.relais.securite === 'starttls'}>STARTTLS (587)</option><option value="tls" selected=${mel.relais.securite === 'tls'}>TLS direct (465)</option></select></div>
        <div class="fl"><label for="melDe">Expéditeur</label><input class="field mono" id="melDe" value=${mel.relais.de} placeholder="hub@exemple.org" autocomplete="off" spellcheck="false"></div>
        <div class="fl"><label for="melUser">Identifiant</label><input class="field mono" id="melUser" value=${mel.relais.utilisateur} autocomplete="off" spellcheck="false"></div>
        <div class="fl"><label for="melPass">Mot de passe</label><input class="field mono" id="melPass" type="password" placeholder=${mel.relais.motdepasse ? 'inchangé' : ''} autocomplete="new-password"></div>
      </div>
      <div class="row"><button class="btn solid sm" id="melSave">Enregistrer</button><span class="mini" id="melRes">${mel.actif ? 'Relais configuré.' : 'Aucun relais : les liens se copient à la main.'}</span></div>
    </div>
  </div>` : ''}
  ${cp ? html`<div class="card">
    <div class="sec"><span class="itile key">${I('shield')}</span><div class="grow"><h2>Coupure d’urgence</h2>
      <p>Met une fonction hors ligne tout de suite, sans redéploiement : pour contenir un incident, une fuite de clé ou une facture qui s’emballe. Chaque changement demande de confirmer ton identité et entre au journal.</p></div></div>
    ${Object.entries(cp.fonctions).map(([f, d]) => html`<label class="setrow check"><input type="checkbox" data-coupure=${f} checked=${cp.etat[f]}><div><b>${f === 'ia' ? 'Couper l’IA' : 'Couper les workflows'}</b><small>${d}</small></div></label>`)}
  </div>` : ''}
  ${dest ? html`<div class="card">
    <div class="sec"><span class="itile key">${I('shield')}</span><div class="grow"><h2>Destinations internes</h2>
      <p>Les adresses du réseau privé que les workflows, les sondes et l’assistant ont le droit de joindre. Un service connecté et une IA le sont d’office ; les métadonnées de nuage et le lien local, jamais. Une adresse publique se joint en https.</p></div></div>
    <div class="pad">
      ${dest.automatiques.length ? html`<div class="fl"><span class="lab">Autorisées d’office</span><div class="row dest">${[...Map.groupBy(dest.automatiques, a => a.hote)].map(([hote, l]) => html`<span class="chip" title=${l.map(a => a.nom).join(', ')}>${hote}</span>`)}</div></div>` : ''}
      <div class="fl"><label for="destListe">Autorisées par toi</label>
        <textarea class="field mono" id="destListe" spellcheck="false" placeholder="nas.lan">${dest.destinations.join('\n')}</textarea>
        <div class="help">Une entrée par ligne : un nom d’hôte, une adresse ou une plage (CIDR, /8 au plus large). Enregistrer demande de confirmer ton identité.</div></div>
      <div class="row"><button class="btn solid sm" id="destSave">Enregistrer</button><span class="mini" id="destRes"></span></div>
    </div>
  </div>` : ''}
  <div class="card">
    <div class="sec"><span class="itile key cache-s">${I('chip')}</span><div class="grow"><h2>Connexions IA</h2><p>Elles ont leur page : locale, par clé API ou par abonnement, et qui s’en sert.</p></div><button class="btn" id="versIA">${I('chip', 14)}Ouvrir la page IA</button></div>
  </div>
  <div class="card">
    <div class="sec"><span class="itile key">${I('shield')}</span><div class="grow"><h2>Autonomie de l’assistant</h2><p>Suppression, exposition et secrets demandent toujours ton accord.</p></div></div>
    ${AUTONOMIES.map(([k, l, d]) => html`<label class="setrow check"><input type="radio" name="aut" value=${k} checked=${ai.autonomy === k}><div><b>${l}</b><small>${d}</small></div></label>`)}
  </div>
  <div class="card">
    <div class="sec"><span class="itile key cache-s">${I('key')}</span><div class="grow"><h2>Jetons d’accès</h2><p>Pour un programme qui pose des questions à l’assistant (un banc d’essai, un script), sans compte ni second facteur. Il ne peut rien exécuter : un plan proposé attend toujours ton clic.</p></div><button class="btn solid" id="addJeton">${I('plus', 14)}Nouveau jeton</button></div>
    ${jt.jetons.length ? jt.jetons.map(j => html`<div class="setrow"><span class="itile cache-s">${I('key')}</span><div class="grow"><b>${j.nom}</b><small class="mono">${j.prefixe}… · assistant · créé ${when(j.cree)}${j.utilise ? ` · servi ${when(j.utilise)}` : ' · jamais servi'}</small></div><div class="r"><button class="btn flat sm danger" data-revoquer=${j.id}>Révoquer</button></div></div>`) : html`<div class="list-empty">Aucun jeton.</div>`}
  </div>
  <div class="card">
    <div class="sec"><span class="itile">${I('code')}</span><div class="grow"><h2>Variables</h2><p>Utilisables partout avec {{ $vars.NOM }}.</p></div></div>
    ${vars.map(v => html`<div class="setrow"><div class="grow"><b class="mono">${v.key}</b><small class="coupe">${v.secret ? 'secrète' : v.value}</small></div><div class="r"><button class="btn flat sm danger" data-delvar=${v.key}>Supprimer</button></div></div>`)}
    <div class="addrow"><div class="fl"><label for="vKey">Nom</label><input class="field mono" id="vKey" placeholder="DOMAINE"></div><div class="fl"><label for="vVal">Valeur</label><input class="field" id="vVal"></div><label class="check"><input type="checkbox" id="vSec"> secrète</label><button class="btn solid" id="addVar">Ajouter</button></div>
  </div>`);
  $('#expoSave', el).onclick = e => pulse(e.currentTarget, async () => {
    const r = await PUT('/api/exposition', { global: $('#expoMode', el).value, machine: $('#expoMachine', el).value.trim() });
    $('#expoRes', el).textContent = r.aRedeployer.length
      ? `À redéployer pour appliquer : ${r.aRedeployer.join(', ')}`
      : 'Enregistré.';
  }).catch(fail);
  $$('[data-coupure]', el).forEach(c => c.onchange = async () => {
    const f = c.dataset.coupure, coupe = c.checked;
    try { await PUT('/api/coupure', { [f]: coupe }); toast(coupe ? 'Coupé' : 'Remis en service'); }
    catch (e) { c.checked = !coupe; fail(e); }
  });
  if (dest) $('#destSave', el).onclick = e => pulse(e.currentTarget, async () => {
    const r = await PUT('/api/destinations', { destinations: $('#destListe', el).value.split('\n').map(x => x.trim()).filter(Boolean) });
    $('#destListe', el).value = r.destinations.join('\n');
    $('#destRes', el).textContent = `Enregistré : ${r.destinations.length} entrée${r.destinations.length > 1 ? 's' : ''}.`;
  }).catch(fail);
  if (alr) {
    const lire = () => ({ canal: $('#alrCanal', el).value, types: Object.fromEntries($$('[data-alr]', el).map(c => [c.dataset.alr, c.checked])) });
    $('#alrSave', el).onclick = e => pulse(e.currentTarget, async () => {
      const r = await PUT('/api/alertes', lire());
      $('#alrRes', el).textContent = r.canal ? `Enregistré : les alertes partent sur ${r.canal}.` : 'Enregistré : aucune alerte n’est envoyée.';
    }).catch(fail);
    $('#alrEssai', el).onclick = e => pulse(e.currentTarget, async () => {
      await PUT('/api/alertes', lire());
      await POST('/api/alertes/essai', {});
      $('#alrRes', el).textContent = 'Message d’essai envoyé : regarde Telegram.';
    }).catch(fail);
  }
  if (mel) $('#melSave', el).onclick = e => pulse(e.currentTarget, async () => {
    const pass = $('#melPass', el).value;
    const r = await PUT('/api/courriel', { defaut: $('#melDefaut', el).value.trim(), relais: {
      hote: $('#melHote', el).value.trim(), port: Number($('#melPort', el).value) || 587, securite: $('#melSecu', el).value,
      de: $('#melDe', el).value.trim(), utilisateur: $('#melUser', el).value.trim(), ...(pass ? { motdepasse: pass } : {}) } });
    $('#melPass', el).value = '';
    $('#melRes', el).textContent = r.actif ? 'Enregistré. Redéploie un service pour qu’il reprenne le relais.' : 'Enregistré.';
  }).catch(fail);
  $('#versIA', el).onclick = () => navigate('ia');
  $('#addJeton', el).onclick = () => modal({
    title: 'Nouveau jeton d’accès', sub: 'Portée : poser des questions à l’assistant. Rien d’autre.',
    body: html`<div class="fl"><label for="jNom">Nom</label><input class="field" id="jNom" placeholder="creuset" autocomplete="off"><div class="help">Pour le reconnaître dans le journal et le révoquer.</div></div>`,
    actions: [{ label: 'Annuler' }, { label: 'Créer', cls: 'solid', run: async me => {
      const r = await POST('/api/jetons', { nom: $('#jNom', me).value, portee: 'assistant' });
      modal({ title: `Jeton « ${r.nom} »`, sub: 'Copie-le maintenant : il ne sera plus jamais affiché.',
        body: html`<div class="fl"><input class="field mono" id="jVal" value=${r.jeton} readonly></div>`,
        actions: [{ label: 'Copier', cls: 'solid', run: async me2 => {
          $('#jVal', me2).select();
          try { await navigator.clipboard.writeText(r.jeton); toast('Jeton copié'); } catch { toast('Sélectionne le jeton et copie-le', 'err'); }
          return false;
        } }, { label: 'Fermer' }] });
      viewSettings(el, t);
    } }],
  });
  $$('[data-revoquer]', el).forEach(b => { b.onclick = async () => { if (await confirmBox('Révoquer ce jeton ?', 'Le programme qui s’en sert ne pourra plus parler à l’assistant.', 'Révoquer')) { await DEL(`/api/jetons/${encodeURIComponent(b.dataset.revoquer)}`).catch(fail); viewSettings(el, t); } }; });
  $$('input[name="aut"]', el).forEach(r => { r.onchange = async () => { await PUT('/api/ai-autonomy', { value: r.value }).catch(fail); toast('Autonomie mise à jour'); }; });
  $$('[data-delvar]', el).forEach(b => { b.onclick = async () => { await DEL(`/api/variables/${encodeURIComponent(b.dataset.delvar)}`).catch(fail); viewSettings(el, t); }; });
  $('#addVar', el).onclick = async () => { try { await PUT(`/api/variables/${encodeURIComponent($('#vKey', el).value.trim())}`, { value: $('#vVal', el).value, secret: $('#vSec', el).checked }); viewSettings(el, t); } catch (e) { fail(e); } };
}

/* La page IA : toutes les IA du Hub, branchées une fois ici, et les trois
   façons de le faire — locale (Ollama), par clé d'API (rangée dans Clés &
   API), par abonnement via l'outil (Claude Code, Codex : le Hub lance l'outil
   dans son conteneur, avec le compte connecté là). Chaque service choisit
   ensuite la sienne dans sa fiche ou dans son lien, page Workflows. */
async function viewIA(el, t) {
  const [ai, sec, outils] = await Promise.all([GET('/api/ai'), GET('/api/secrets').catch(() => ({ services: [], catalogue: [] })), GET('/api/ai/outils').catch(e => ({ joignable: false, erreur: e.message }))]);
  if (!alive(t)) return;
  const roleLbl = { config: 'assistant', workflows: 'workflows', embeddings: 'embeddings' };
  const parCle = sec.catalogue.filter(c => c.categorie === 'IA' && c.ia && !ai.kinds[c.ia]?.outil);
  const clesDe = k => sec.services.filter(x => x.ia === k).length;
  const locales = ai.connections.filter(c => c.kind === 'ollama');
  const outil = (cle, nom, sous, icone) => {
    const o = outils[cle] || {};
    const conn = ai.connections.filter(c => ai.kinds[c.kind]?.outil === cle);
    const etat = !outils.joignable ? ['idle', 'conteneur injoignable'] : !o.installe ? ['warn', 'outil absent'] : o.connecte ? ['held', 'connecté'] : ['warn', 'pas encore connecté'];
    return html`<div class="outil-ia">
      <div class="outil-tete"><span class="itile">${I(icone)}</span><div class="grow"><b>${nom}</b><small>${sous}</small></div><span class="tag ${etat[0]}"><i class="d"></i>${etat[1]}</span></div>
      <div class="row">${outils.joignable && o.installe && !o.connecte ? html`<button class="btn sm solid" data-connecter=${cle}>${I('key', 13)}Se connecter</button>` : ''}<button class="btn sm" data-kind=${cle === 'claude' ? 'claude-code' : 'codex'} disabled=${!outils.joignable || !o.installe}>${conn.length ? 'Ajouter encore' : 'Ajouter la connexion'}</button>${conn.length ? html`<span class="chip a">${conn.length} connexion${conn.length > 1 ? 's' : ''}</span>` : ''}</div>
      ${outils.joignable && !o.connecte ? html`<details class="outil-cmd"><summary class="mini">Ou dans un terminal sur la machine du Hub</summary><div class="row nowrap-row"><code class="mono grow">${o.connexion}</code><button class="ghost" data-copie-cmd=${o.connexion} aria-label="Copier la commande" title="Copier">${I('copy', 14)}</button></div></details>` : ''}
    </div>`;
  };
  poser(el, headrow('IA', 'Toutes tes IA, branchées une fois ici. Chaque service choisit ensuite la sienne — dans sa fiche, ou depuis son lien dans Workflows.',
      html`<button class="btn solid" id="addAi">${I('plus', 14)}Ajouter</button>`),
    html`<div class="colonnes"><div class="colonne">
      <div class="card">
        <div class="sec"><span class="itile key">${I('chip')}</span><div class="grow"><h2>Locale</h2><p>Ollama, sur cette machine ou une autre du réseau. Rien ne sort.</p></div></div>
        <div class="pad">${locales.length ? html`<div class="help">${locales.map(c => c.name).join(', ')}</div>` : html`<div class="help">Aucune pour l’instant.</div>`}
          <button class="btn sm mt8" data-kind="ollama">${I('plus', 13)}Brancher Ollama</button></div>
      </div>
      <div class="card">
        <div class="sec"><span class="itile key">${I('key')}</span><div class="grow"><h2>Par clé d’API</h2><p>La clé est rangée dans Clés & API, masquée ; la connexion n’en garde que le nom.</p></div></div>
        <div class="pad"><div class="sec-tuiles compact">${parCle.map(c => html`<button class="sec-tuile ${clesDe(c.ia) ? 'fait' : ''}" data-kind=${c.ia} data-fournisseur=${c.id} title=${c.nom}>${logoTuile(c.id, c.nom, c.couleur, 40, c.domaine)}<b>${c.nom}</b>${clesDe(c.ia) ? html`<span class="sec-ok">${I('check', 12)}</span>` : ''}</button>`)}</div></div>
      </div></div>
      <div class="colonne"><div class="card">
        <div class="sec"><span class="itile key">${I('code')}</span><div class="grow"><h2>Par abonnement, via l’outil</h2><p>Le Hub lance l’outil lui-même, dans son conteneur, avec ton compte. Pas de clé d’API.</p></div></div>
        ${outils.joignable ? '' : html`<div class="pad"><div class="note warn">${I('alert')}<div>Conteneur <code>hub-outils-ia</code> injoignable${outils.erreur ? ` : ${outils.erreur}` : ''}. Relance <code>sudo ./install.sh</code> sur la machine du Hub.</div></div></div>`}
        ${outil('claude', 'Claude Code', 'Abonnement Claude. Le jeton de « claude setup-token » va dans Clés & API.', 'sparkle')}
        ${outil('codex', 'Codex', 'Abonnement ChatGPT. La connexion reste dans le conteneur.', 'code')}
      </div></div>
    </div>`,
    html`<div class="card">
      <div class="sec"><span class="itile key cache-s">${I('sparkle')}</span><div class="grow"><h2>Connexions</h2><p>L’ordre définit le relais en cas de panne. Les rôles disent qui s’en sert dans le Hub.</p></div></div>
      ${ai.connections.length ? ai.connections.map((c, i) => html`<div class="setrow"><span class="itile cache-s ${i === 0 ? 'ink' : ''}">${I(c.kind === 'ollama' ? 'chip' : ai.kinds[c.kind]?.outil ? 'code' : 'key')}</span>
        <div class="grow"><b>${c.name}</b><small class="coupe">${[c.kindLabel, c.model || 'modèle par défaut', ai.kinds[c.kind]?.outil ? '' : c.url].filter(Boolean).join(' · ')}</small></div>
        <div class="r"><span class="cache-m puces">${c.roles.map(r => html`<span class="chip a">${roleLbl[r]}</span>`)}</span>
          <button class="btn flat sm" data-up=${i} disabled=${!i} aria-label="Monter">↑</button>
          <button class="btn sm" data-test=${c.id}>Tester</button><button class="btn sm" data-edit=${c.id}>Modifier</button><button class="btn flat sm danger" data-rm=${c.id}>Retirer</button></div></div>`) : html`<div class="list-empty">Aucune IA pour l’instant : choisis une des trois façons ci-dessus.</div>`}
      ${ai.usage.length ? html`<div class="pad"><span class="lab">Consommation 30 jours</span><div class="help">${ai.usage.map((u, i) => html`${i ? html`<br>` : ''}${`${u.name || '?'} : ${u.calls} appels, ${u.tin || 0} jetons en entrée, ${u.tout || 0} en sortie`}`)}</div></div>` : ''}
    </div>`);
  brancherLogos(el);
  const relire = () => viewIA(el, t);
  $('#addAi', el).onclick = () => aiDialog({}, relire);
  $$('[data-kind]', el).forEach(b => { b.onclick = () => aiDialog({ kind: b.dataset.kind, fournisseur: b.dataset.fournisseur, roles: ai.connections.length ? ['workflows'] : ['config', 'workflows', 'embeddings'] }, relire); });
  $$('[data-copie-cmd]', el).forEach(b => { b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copieCmd); toast('Commande copiée'); } catch { toast(b.dataset.copieCmd); } }; });
  $$('[data-connecter]', el).forEach(b => { b.onclick = () => connecterOutil(b.dataset.connecter, relire); });
  $$('[data-edit]', el).forEach(b => { b.onclick = () => aiDialog(ai.connections.find(c => c.id === b.dataset.edit), relire); });
  $$('[data-test]', el).forEach(b => { b.onclick = async () => { b.disabled = true; try { const r = await POST(`/api/ai/${encodeURIComponent(b.dataset.test)}/test`); toast(`Réponse en ${r.ms} ms (${r.model}) : ${r.reply}`); } catch (e) { fail(e); } b.disabled = false; }; });
  $$('[data-rm]', el).forEach(b => { b.onclick = async () => { if (await confirmBox('Retirer cette connexion ?', 'Les workflows qui la ciblent basculeront sur les autres.', 'Retirer')) { await DEL(`/api/ai/${encodeURIComponent(b.dataset.rm)}`).catch(fail); relire(); } }; });
  $$('[data-up]', el).forEach(b => { b.onclick = async () => { const ids = ai.connections.map(c => c.id); const i = Number(b.dataset.up); [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]]; await POST('/api/ai/order', { ids }).catch(fail); relire(); }; });
}

/* Connexion d'un compte Claude Code ou Codex depuis le Hub : l'outil tourne
   dans son conteneur, le Hub montre le lien à ouvrir (et le code, pour
   Codex), reçoit le code collé (Claude), puis range le jeton et crée la
   connexion. Aucun terminal. */
function connecterOutil(outil, apres) {
  const nom = outil === 'claude' ? 'Claude Code' : 'Codex';
  const base = `/api/ai/outils/${outil}/connexion`;
  let minuteur = null, fini = false;
  modal({
    title: `Connecter ${nom}`, sub: outil === 'claude' ? 'Ton abonnement Claude, par la page de connexion de Claude Code.' : 'Ton abonnement ChatGPT, par la page de connexion de Codex.',
    body: html`<div id="cxCorps"><p class="hint">Lancement de l’outil…</p></div>`,
    actions: [{ label: 'Fermer' }],
    onOpen: async (me, fermer) => {
      const corps = $('#cxCorps', me);
      const peindre = e => {
        if (e.etape === 'lancement' || (e.etape === 'attente-code' && !e.lien) || e.etape === 'aucune') return poser(corps, html`<p class="hint">Lancement de l’outil… ${e.etape === 'aucune' ? 'rien en cours.' : ''}</p>`);
        if (e.etape === 'erreur') return poser(corps, html`<div class="err">${e.erreur || 'Échec.'}</div><div class="row"><button class="btn sm" id="cxRelancer">Réessayer</button></div>`);
        if (e.etape === 'ok') return poser(corps, html`<div class="note ok">${I('check')}<div>${nom} est connecté${e.connexion ? ' et la connexion IA est créée' : ''}.</div></div>`);
        if (e.etape === 'verification') return poser(corps, html`<p class="hint">Vérification du code…</p>`);
        poser(corps, html`
          <div class="cx-etape"><span class="n">1</span><div><b>Ouvre la page de connexion</b><div class="row avec-marge"><button class="btn solid sm" id="cxOuvrir">${I('globe', 13)}Ouvrir le lien</button><button class="ghost" id="cxCopierLien" title="Copier le lien" aria-label="Copier le lien">${I('copy', 14)}</button></div><div class="help coupe">${e.lien}</div></div></div>
          ${outil === 'codex' ? html`<div class="cx-etape"><span class="n">2</span><div><b>Entre ce code sur la page</b><div class="row avec-marge"><code class="cx-code">${e.code || '…'}</code>${e.code ? html`<button class="ghost" id="cxCopierCode" title="Copier le code" aria-label="Copier le code">${I('copy', 14)}</button>` : ''}</div><div class="help">Codex attend la validation tout seul : cette fenêtre se mettra à jour.</div></div></div>`
          : html`<div class="cx-etape"><span class="n">2</span><div><b>Colle ici le code que la page affiche</b><div class="row avec-marge nowrap-row"><input class="field mono grow" id="cxCode" placeholder="code affiché après la connexion" autocomplete="off"><button class="btn solid sm" id="cxValider">Valider</button></div></div></div>`}`);
        $('#cxOuvrir', corps).onclick = () => window.open(e.lien, '_blank', 'noopener');
        $('#cxCopierLien', corps).onclick = async () => { try { await navigator.clipboard.writeText(e.lien); toast('Lien copié'); } catch { toast(e.lien); } };
        if ($('#cxCopierCode', corps)) $('#cxCopierCode', corps).onclick = async () => { try { await navigator.clipboard.writeText(e.code); toast('Code copié'); } catch { toast(e.code); } };
        if ($('#cxValider', corps)) $('#cxValider', corps).onclick = async () => { const code = $('#cxCode', corps).value.trim(); if (!code) return; try { peindre(await POST(`${base}/code`, { code })); } catch (x) { fail(x); } };
      };
      const suivre = async () => {
        if (fini || !me.isConnected) return;
        try {
          const e = await GET(base);
          peindre(e);
          if ($('#cxRelancer', corps)) $('#cxRelancer', corps).onclick = async () => { try { peindre(await POST(base, {})); minuteur = setTimeout(suivre, 1500); } catch (x) { fail(x); } };
          if (e.etape === 'ok') { fini = true; toast(`${nom} connecté`); setTimeout(() => { fermer(); apres?.(); }, 1200); return; }
          if (e.etape === 'erreur') { fini = true; return; }
        } catch (x) { poser(corps, html`<div class="err">${x.message}</div>`); fini = true; return; }
        minuteur = setTimeout(suivre, 1500);
      };
      try { peindre(await POST(base, {})); } catch (x) { poser(corps, html`<div class="err">${x.message}</div>`); return; }
      minuteur = setTimeout(suivre, 1200);
    },
    onClose: () => { fini = true; clearTimeout(minuteur); },
  });
}

async function aiDialog(cur, apres = null) {
  const [meta, inst, sec] = await Promise.all([GET('/api/ai'), GET('/api/instances').then(l => l.filter(i => i.extId === 'ollama')), GET('/api/secrets').catch(() => ({ services: [], catalogue: [] }))]);
  const kind = cur.kind || 'ollama';
  const roles = cur.roles || ['workflows'];
  const ROLES_IA = { config: 'Assistant de configuration', workflows: 'Nœuds IA des workflows', embeddings: 'Embeddings' };
  /* Les clés viennent de Clés & API : on choisit, on ne recopie pas. Une clé
     collée ici y est rangée aussi, sous le fournisseur. */
  const clesPour = k => sec.services.filter(s => s.ia === k).flatMap(s => s.champs.filter(ch => ch.rempli && ch.secret).map(ch => ({ key: ch.key, nom: s.compte ? `${s.nom} · ${s.compte}` : s.nom })));
  modal({
    title: cur.id ? `Modifier ${cur.name}` : 'Ajouter une IA', sub: 'Les clés sont rangées dans Clés & API, chiffrées, jamais réaffichées.',
    body: html`<div class="formgrid">
      <div class="fl"><label for="aKind">Type</label><select class="field" id="aKind" disabled=${!!cur.id}>${Object.entries(meta.kinds).map(([k, v]) => html`<option value=${k} selected=${k === kind}>${v.label}</option>`)}</select></div>
      <div class="fl"><label for="aName">Nom</label><input class="field" id="aName" value=${cur.name || ''} placeholder="ex. Kimi perso"></div>
      <div class="fl full" id="instBox"><label for="aInst">Instance Ollama du Hub</label><select class="field" id="aInst"><option value="">Saisir une adresse</option>${inst.map(i => html`<option value=${i.id} selected=${cur.instanceId === i.id}>${i.name} · ${i.url}</option>`)}</select></div>
      <div class="fl full" id="urlBox"><label for="aUrl">Adresse</label><input class="field mono" id="aUrl" value=${cur.url || ''}></div>
      <div class="fl full" id="keyBox"><label for="aCle">Clé d’API</label><select class="field" id="aCle"></select>
        <input class="field mono avec-marge" type="password" id="aKey" autocomplete="off" hidden placeholder="Colle la clé : elle ira dans Clés & API">
        <div class="help" id="aCleHelp"></div></div>
      <div class="fl"><label for="aModelSel">Modèle</label><select class="field" id="aModelSel"></select>
        <input class="field mono avec-marge" id="aModel" value=${cur.model || ''} hidden placeholder="nom exact du modèle"><div class="help" id="aModelHelp"></div></div>
      <div class="fl"><label for="aEmb">Modèle d’embeddings</label><input class="field mono" id="aEmb" value=${cur.embedModel || ''} placeholder="nomic-embed-text"></div>
      <div class="fl full"><label>Rôles</label><div class="row">${meta.roles.map(r => html`<label class="check"><input type="checkbox" data-role=${r} checked=${roles.includes(r)}> ${ROLES_IA[r]}</label>`)}</div></div>
    </div><div class="help" id="aHelp"></div>`,
    actions: [{ label: 'Annuler' }, { label: cur.id ? 'Enregistrer' : 'Ajouter', cls: 'solid', run: async me => {
      const cle = $('#aCle', me).value;
      const modele = $('#aModelSel', me).value === '__autre' || !$('#aModelSel', me).options.length ? $('#aModel', me).value.trim() : $('#aModelSel', me).value;
      const body = { kind: $('#aKind', me).value, name: $('#aName', me).value, instanceId: $('#aInst', me).value || undefined, url: $('#aUrl', me).value.trim(),
        cleRef: cle && !cle.startsWith('__') ? cle : undefined, apiKey: cle === '__coller' ? ($('#aKey', me).value || undefined) : undefined,
        model: modele, embedModel: $('#aEmb', me).value.trim(), roles: $$('[data-role]', me).filter(c => c.checked).map(c => c.dataset.role) };
      const r = cur.id ? await PUT(`/api/ai/${encodeURIComponent(cur.id)}`, body) : await POST('/api/ai', body);
      toast('Connexion IA enregistrée');
      try { const tst = await POST(`/api/ai/${encodeURIComponent(r.id)}/test`); toast(`Test réussi en ${tst.ms} ms`); } catch (e) { toast(`Enregistrée, mais le test échoue : ${e.message}`, 'err'); }
      if (apres) apres(); else if (S.page === 'ia') navigate('ia');
      refreshCounts();
    } }],
    onOpen: me => {
      let jeton = 0;
      // Le menu des modèles se remplit dès qu'on a de quoi interroger le fournisseur.
      const chargeModeles = async () => {
        const k = $('#aKind', me).value, cle = $('#aCle', me).value, t = ++jeton;
        const sel = $('#aModelSel', me), help = $('#aModelHelp', me);
        const actuel = $('#aModel', me).value || cur.model || meta.kinds[k].defaultModel || '';
        const req = { kind: k, url: $('#aUrl', me).value.trim(), instanceId: $('#aInst', me).value || undefined, id: cur.id,
          cleRef: cle && !cle.startsWith('__') ? cle : undefined, apiKey: cle === '__coller' ? $('#aKey', me).value : undefined };
        const remplir = (liste, note) => {
          const l = [...new Set([...(actuel ? [actuel] : []), ...liste])];
          poser(sel, l.map(m => html`<option value=${m} selected=${m === actuel}>${m}</option>`), html`<option value="__autre">Autre… (saisir)</option>`);
          help.textContent = note || '';
          $('#aModel', me).hidden = sel.value !== '__autre';
        };
        if (meta.kinds[k].needsKey && !req.cleRef && !req.apiKey && !cur.id) { remplir([], 'Choisis une clé : la liste des modèles viendra du fournisseur.'); return; }
        if (meta.kinds[k].outil && !req.url) req.url = meta.kinds[k].defaultUrl;
        help.textContent = 'Lecture des modèles…';
        try {
          const liste = await POST('/api/ai/modeles', req);
          if (t === jeton) remplir(liste, `${liste.length} modèle${liste.length > 1 ? 's' : ''} proposé${liste.length > 1 ? 's' : ''} par le fournisseur`);
        } catch (e) { if (t === jeton) remplir([], `Liste indisponible : ${e.message}`); }
      };
      const syncCle = () => {
        const k = $('#aKind', me).value, l = clesPour(k), sel = $('#aCle', me);
        const courant = sel.value || cur.cleRef || (l[0]?.key ?? '');
        poser(sel, l.map(c => html`<option value=${c.key}>${c.nom} — ${c.key}</option>`),
          cur.id && cur.hasKey && !cur.cleRef ? html`<option value="__garder">Garder la clé actuelle</option>` : '',
          html`<option value="__coller">Coller une nouvelle clé…</option>`);
        sel.value = [...sel.options].some(o => o.value === courant) ? courant : (cur.id && cur.hasKey && !cur.cleRef ? '__garder' : sel.options[0].value);
        $('#aKey', me).hidden = sel.value !== '__coller';
        $('#aCleHelp', me).textContent = meta.kinds[k].outil === 'claude' ? 'Le jeton de « claude setup-token » (facultatif si tu t’es connecté directement dans le conteneur).' : l.length ? '' : 'Aucune clé de ce fournisseur dans Clés & API : colle-la ici, elle y sera rangée.';
      };
      const sync = () => {
        const k = $('#aKind', me).value, d = meta.kinds[k];
        $('#instBox', me).hidden = k !== 'ollama' || !inst.length;
        $('#urlBox', me).hidden = k === 'ollama' && !!$('#aInst', me).value;
        $('#keyBox', me).hidden = !d.needsKey && d.outil !== 'claude';
        $('#urlBox', me).hidden = $('#urlBox', me).hidden || !!d.outil;
        $('#aEmb', me).closest('.fl').hidden = !!d.outil;
        if (!cur.id) $('#aUrl', me).value = d.defaultUrl;
        $('#aHelp', me).textContent = k === 'ollama' ? 'Si Ollama tourne sur un autre PC : OLLAMA_HOST=0.0.0.0:11434 sur ce PC, et n’autoriser le port 11434 que depuis le Hub.' : '';
        if (d.needsKey || d.outil === 'claude') syncCle();
        chargeModeles();
      };
      $('#aKind', me).onchange = () => { $('#aModel', me).value = ''; sync(); };
      $('#aInst', me).onchange = sync;
      $('#aUrl', me).onchange = chargeModeles;
      $('#aCle', me).onchange = () => { $('#aKey', me).hidden = $('#aCle', me).value !== '__coller'; chargeModeles(); };
      $('#aKey', me).onchange = chargeModeles;
      $('#aModelSel', me).onchange = () => { $('#aModel', me).hidden = $('#aModelSel', me).value !== '__autre'; };
      if (!cur.id && !$('#aUrl', me).value) $('#aUrl', me).value = meta.kinds[kind].defaultUrl;
      sync();
    },
  });
}

// Assistant
function toggleAi() { S.aiOpen = !S.aiOpen; if (!S.aiOpen) arreterVoix(); majShell(); }
// Une réponse vocale arrivée : le fil se redessine (les widgets apparaissent).
brancherVoix({
  apresReponse: () => renderAi(),
  /* Pas de service vocal : le panneau propose d'installer celui du catalogue. */
  installer: async x => {
    try {
      const cat = await GET('/api/catalog');
      const e = cat.items.find(i => i.id === x.extId);
      if (!e) return toast(`${x.nom} n’est plus au catalogue : actualise-le dans Extensions`);
      addServiceDialog(e.manifest, x.mode);
    } catch (e) { fail(e); }
  },
  ouvrirService: () => navigate('ext'),
});

/* Les widgets de l'assistant. Les chiffres viennent du Hub (photo prise au
   moment de la réponse) ; ici on ne fait que dessiner. Chaque marque porte
   son chiffre au survol (data-tip), et une couleur ne dit jamais seule
   l'état : il y a toujours le mot ou le nombre à côté. */
function widget(w) {
  const n = v => Number(v || 0).toLocaleString('fr-FR');
  const tete = html`<div class="wg-t">${w.titre || ''}</div>`;
  const pluriel = (k, mot, s = 's') => `${k} ${mot}${k > 1 ? s : ''}`;
  if (w.type === 'stats') return html`<div class="wg">${tete}<div class="wg-tuiles">${w.tuiles.map(t => html`<div class="wg-tuile ${t.etat ? 'e-' + t.etat : ''}"><small>${t.label}</small><b>${n(t.valeur)}</b>${t.sous ? html`<span>${t.sous}</span>` : ''}</div>`)}</div></div>`;
  if (w.type === 'activite') {
    const W = 300, H = 110, pad = 18, bas = H - pad;
    const max = Math.max(1, ...w.barres.map(b => b.ok + b.err + b.autre));
    const pas = W / w.barres.length, larg = Math.max(3, Math.min(22, pas - 2));
    const y = v => (v / max) * (bas - 6);
    const barres = w.barres.map((b, i) => {
      const x = i * pas + (pas - larg) / 2, hOk = y(b.ok + b.autre), hErr = y(b.err);
      const tip = `${b.jour} · ${pluriel(b.ok, 'réussie')} · ${pluriel(b.err, 'échec')}${b.autre ? ` · ${pluriel(b.autre, 'autre')}` : ''}`;
      const seg = (h, y0, cls, haut) => h > 0 ? html`<rect class=${cls} x=${x.toFixed(1)} y=${(y0 - h).toFixed(1)} width=${larg.toFixed(1)} height=${Math.max(1, h).toFixed(1)} rx=${haut ? 3 : 0}/>` : null;
      // Réussies en bas, échecs au-dessus, séparés par 2 px de fond.
      const okH = hOk, errH = hErr > 0 && okH > 0 ? Math.max(1, hErr - 2) : hErr;
      return html`<g data-tip=${tip}><rect class="hit" x=${(i * pas).toFixed(1)} y="0" width=${pas.toFixed(1)} height=${H}/>${seg(okH, bas, 'ok', !errH)}${seg(errH, bas - okH - (okH > 0 && errH > 0 ? 2 : 0), 'err', true)}</g>`;
    });
    const lab = w.barres.map((b, i) => (i === 0 || i === w.barres.length - 1 || (w.barres.length > 7 && i === Math.floor(w.barres.length / 2))) ? html`<text x=${(i * pas + pas / 2).toFixed(1)} y=${H - 3} text-anchor="middle">${b.jour}</text>` : null);
    return html`<div class="wg">${tete}<div class="wg-leg"><span><i class="ok"></i>Réussies <b>${n(w.ok)}</b></span><span><i class="err"></i>Échecs <b>${n(w.err)}</b></span></div>
      <svg class="wg-barres" viewBox="0 0 ${W} ${H}" role="img" aria-label="${w.titre} : ${w.ok} réussies, ${w.err} échecs"><line class="base" x1="0" x2=${W} y1=${bas} y2=${bas}/>${barres}${lab}</svg>
      ${w.total ? '' : html`<p class="wg-vide">Aucune exécution sur la période.</p>`}</div>`;
  }
  if (w.type === 'classement') {
    const max = Math.max(1, ...w.lignes.map(l => l.valeur));
    return html`<div class="wg">${tete}${w.lignes.length ? w.lignes.map(l => html`<div class="wg-rang" data-tip=${`${l.nom} · ${pluriel(l.total, 'exécution')} · ${pluriel(l.echecs, 'échec')}`}><span class="nom">${l.nom}</span><span class="val">${n(l.valeur)}</span><span class="piste"><i class=${w.par === 'echecs' ? 'err' : 'ok'} style="width:${(l.valeur / max * 100).toFixed(1)}%"></i></span></div>`) : html`<p class="wg-vide">Rien sur la période.</p>`}</div>`;
  }
  if (w.type === 'services') {
    const mot = { online: 'en ligne', error: 'en erreur', offline: 'hors ligne', installing: 'installation', stopped: 'arrêté' };
    return html`<div class="wg">${tete}${w.lignes.length ? w.lignes.map(l => html`<div class="wg-svc"><i class="pt ${l.etat === 'online' ? 'ok' : l.etat === 'error' || l.etat === 'offline' ? 'err' : 'warn'}"></i><span class="nom">${l.nom}</span><span class="etat">${mot[l.etat] || l.etat}</span></div>`) : html`<p class="wg-vide">Aucun service.</p>`}</div>`;
  }
  if (w.type === 'sondes') {
    const courbe = pts => {
      if (pts.length < 2) return '';
      const mn = Math.min(...pts), mx = Math.max(...pts), W = 90, H = 24, e = mx - mn || 1;
      return html`<svg class="wg-spark" viewBox="0 0 ${W} ${H}"><polyline points=${pts.map((v, i) => `${(i / (pts.length - 1) * W).toFixed(1)},${(H - 2 - (v - mn) / e * (H - 4)).toFixed(1)}`).join(' ')}/></svg>`;
    };
    return html`<div class="wg">${tete}${w.lignes.length ? w.lignes.map(l => html`<div class="wg-svc" data-tip=${`${l.service} · ${l.nom}`}><i class="pt ${l.niveau === 'crit' ? 'err' : l.niveau === 'warn' ? 'warn' : 'ok'}"></i><span class="nom">${l.nom}</span>${courbe(l.points)}<span class="etat"><b>${String(l.valeur ?? '—')}</b>${l.unite || ''}</span></div>`) : html`<p class="wg-vide">Aucune sonde.</p>`}</div>`;
  }
  if (w.type === 'ia') {
    const max = Math.max(1, ...w.lignes.map(l => l.entree + l.sortie));
    return html`<div class="wg">${tete}${w.lignes.length ? w.lignes.map(l => html`<div class="wg-rang" data-tip=${`${l.nom} · ${n(l.entree)} jetons lus · ${n(l.sortie)} écrits`}><span class="nom">${l.nom}</span><span class="val">${n(l.appels)} appels</span><span class="piste"><i class="ok" style="width:${((l.entree + l.sortie) / max * 100).toFixed(1)}%"></i></span></div>`) : html`<p class="wg-vide">Aucun appel sur la période.</p>`}</div>`;
  }
  return '';
}
/* Une seule bulle d'info pour tous les widgets : elle suit la souris. */
document.addEventListener('mouseover', e => {
  const cible = e.target.closest?.('[data-tip]');
  let bulle = $('#wgTip');
  if (!cible) { bulle?.classList.remove('vu'); return; }
  if (!bulle) { bulle = element(html`<div id="wgTip" class="wg-tip" role="tooltip"></div>`); document.body.append(bulle); }
  bulle.textContent = cible.dataset.tip;
  const r = cible.getBoundingClientRect();
  bulle.classList.add('vu');
  const bw = bulle.offsetWidth;
  bulle.style.left = `${Math.max(8, Math.min(innerWidth - bw - 8, r.left + r.width / 2 - bw / 2))}px`;
  bulle.style.top = `${Math.max(8, r.top - bulle.offsetHeight - 8)}px`;
});

/* Les réponses de l'assistant mises en page : puces, listes numérotées,
   petits titres, gras, code, tableaux. Construites nœud par nœud : aucun
   texte du modèle n'est lu comme du balisage. Les puces qu'un petit modèle
   écrit à la suite (« … : - a - b - c ») sont remises une par ligne. */
function enLigne(x) {
  const morceaux = [];
  const motif = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let dernier = 0, m;
  while ((m = motif.exec(x))) {
    if (m.index > dernier) morceaux.push(x.slice(dernier, m.index));
    morceaux.push(m[1] !== undefined ? html`<b>${m[1]}</b>` : html`<code>${m[2]}</code>`);
    dernier = motif.lastIndex;
  }
  if (dernier < x.length) morceaux.push(x.slice(dernier));
  return morceaux;
}
function rendu(texte) {
  let t = String(texte || '').replace(/\r/g, '').trim();
  if ((t.match(/(^|\s)[-•]\s+(?=[A-ZÀ-Ý*«"0-9])/g) || []).length >= 2) t = t.replace(/\s+[-•]\s+(?=[A-ZÀ-Ý*«"0-9])/g, '\n- ');
  const sortie = document.createDocumentFragment();
  let liste = null;
  const ferme = () => { liste = null; };
  // Un tableau (« | a | b | ») : la première ligne est l'en-tête, la ligne de tirets est sautée.
  let tableau = [];
  const cellules = l => l.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
  const videTableau = () => {
    if (!tableau.length) return;
    const [tete, ...corps] = tableau;
    sortie.append(rendre(html`<div class="md-tab"><table><thead><tr>${tete.map(c => html`<th>${enLigne(c)}</th>`)}</tr></thead><tbody>${corps.map(r => html`<tr>${tete.map((_, i) => html`<td>${enLigne(r[i] ?? '')}</td>`)}</tr>`)}</tbody></table></div>`));
    tableau = [];
  };
  const puce = (type, contenu) => {
    if (liste?.type !== type) { ferme(); liste = { type, el: element(type === 'ul' ? html`<ul class="md"></ul>` : html`<ol class="md"></ol>`) }; sortie.append(liste.el); }
    liste.el.append(rendre(html`<li>${enLigne(contenu)}</li>`));
  };
  for (const brut of t.split('\n')) {
    const l = brut.trim();
    if (/^\|.*\|$/.test(l)) { ferme(); if (!/^\|[\s:|-]+\|$/.test(l)) tableau.push(cellules(l)); continue; }
    videTableau();
    if (!l) { ferme(); continue; }
    let m;
    if ((m = /^[-•*]\s+(.*)$/.exec(l))) { puce('ul', m[1]); continue; }
    if ((m = /^\d+[.)]\s+(.*)$/.exec(l))) { puce('ol', m[1]); continue; }
    ferme();
    if ((m = /^#{1,4}\s+(.*)$/.exec(l))) { sortie.append(rendre(html`<div class="md-t">${enLigne(m[1])}</div>`)); continue; }
    // Un petit titre : une ligne entièrement en gras (« **Services :** »). Une phrase qui finit par « : » reste une phrase.
    if ((m = /^\*\*([^*]{2,50}?)\s*:?\s*\*\*\s*:?$/.exec(l))) { sortie.append(rendre(html`<div class="md-t">${m[1]}</div>`)); continue; }
    sortie.append(rendre(html`<p class="md-p">${enLigne(l)}</p>`));
  }
  videTableau();
  return sortie;
}

/* Bord droit : la souris collée au bord une seconde fait sortir un petit
   onglet ✦ à sa hauteur ; un clic ouvre l'assistant. Il rentre dès qu'on
   s'éloigne. Rien sur un écran tactile (pas de survol), ni quand
   l'assistant est déjà ouvert. */
(() => {
  let minuteur = null, rentre = null, derniere = { x: 0, y: 0 };
  const largeur = () => Math.min(innerWidth, document.documentElement.clientWidth || innerWidth);
  const auBord = x => largeur() - x <= 8;
  const masquer = () => $('#aiBord')?.classList.remove('vu');
  const onglet = () => {
    let b = $('#aiBord');
    if (b) return b;
    b = element(html`<button type="button" id="aiBord" class="aibord" title="Assistant" aria-label="Ouvrir l’assistant">${I('sparkle', 18)}</button>`);
    b.onclick = () => { masquer(); if (!S.aiOpen) toggleAi(); };
    b.onmouseenter = () => clearTimeout(rentre);
    b.onmouseleave = () => { clearTimeout(rentre); rentre = setTimeout(masquer, 700); };
    document.body.append(b);
    return b;
  };
  const montrer = () => {
    if (S.aiOpen || !$('#appFrame') || !auBord(derniere.x)) return;
    const b = onglet();
    b.style.top = `${Math.max(70, Math.min(innerHeight - 70, derniere.y)) - 22}px`;
    b.classList.add('vu');
  };
  document.addEventListener('mousemove', e => {
    derniere = { x: e.clientX, y: e.clientY };
    if (auBord(e.clientX)) {
      if (!minuteur && !S.aiOpen) minuteur = setTimeout(() => { minuteur = null; montrer(); }, 1000);
    } else {
      clearTimeout(minuteur); minuteur = null;
      if ($('#aiBord')?.classList.contains('vu') && largeur() - e.clientX > 90) { clearTimeout(rentre); rentre = setTimeout(masquer, 700); }
    }
  }, { passive: true });
})();
/* Les relances viennent du Hub : celles que l'IA propose après chaque
   échange, complétées par l'état réel (workflow cassé, service en erreur…). */
let SUGG = [];
const STATUTS_PLAN = { done: 'plan exécuté', failed: 'plan en échec', rejected: 'plan refusé', running: 'en cours…' };
async function renderAi() {
  const panel = $('#aiPanel'); if (!panel) return;
  let hist = [];
  try { hist = await GET('/api/agent'); } catch { /* historique indisponible : le fil repart vide */ }
  const ai = await GET('/api/ai').catch(() => ({ connections: [], autonomy: 'validation' }));
  const cerveau = await GET('/api/agent/cerveau').catch(() => ({ proposer: false }));
  SUGG = (await GET('/api/agent/relances').catch(() => ({ relances: [] }))).relances || [];
  /* Le serveur travaille peut-être encore sur une demande lancée avant un
     changement de page ou un rechargement : on la retrouve au lieu de
     l'oublier. */
  if (!S.agentBusy) {
    const e = await GET('/api/agent/etat').catch(() => null);
    if (e?.encours) Object.assign(S, { agentBusy: true, agentAttente: true, agentAsk: e.demande, agentLive: e.texte || '', agentEtapes: e.etapes ?? -1, agentPhase: e.phase === 'vérification' ? 'vérification' : '' });
    S.ecoute = e?.ecoute || null;
    if (S.ecoute) { clearInterval(minuteurEcoute); minuteurEcoute = setInterval(majEcoute, 1000); }
  }
  if (!panel.isConnected) return;
  const cfg = ai.connections.find(c => c.roles.includes('config')) || ai.connections[0];
  const resultat = (s, res) => {
    if (!res) return '';
    const texte = res.ok ? (res.result?.note || 'fait') : res.skipped ? (typeof s.deja === 'string' ? s.deja : s.deja ? 'déjà actif' : 'ignoré') : res.error;
    return html`<span class="res ${res.ok ? 'ok-t' : res.skipped ? 'muted' : 'err'}">${texte}</span>`;
  };
  const stepLine = (s, i, res) => html`<li><span class="num">${i + 1}</span><span>${s.label}${s.problems?.length ? html`<span class="pb">${s.problems.join(' ; ')}</span>` : ''}${resultat(s, res)}</span></li>`;
  const echange = p => {
    const widgets = (p.widgets || []).map(widget);
    return html`${p.voix ? '' : html`<div class="m u">${p.autreCompte ? html`<span class="chip">un autre compte</span> ` : ''}${p.request}</div>`}<div class="m a${p.widgets?.length || p.voix ? ' large' : ''}${p.voix ? ' vocal' : ''}">${p.voix
        ? tourVocal(p, widgets)
        : [rendu(p.reply || (p.steps.length ? 'Voici le plan :' : '')), widgets]}
      ${p.steps.length ? html`<ol class="steps2">${p.steps.map((s, i) => stepLine(s, i, p.results?.find(r => r.step === i)))}</ol>` : ''}
      ${p.status === 'proposed' ? html`<div class="actions plan-actions"><button class="btn solid sm" data-exec=${p.id} disabled=${ai.autonomy === 'conseil'}>${I('check', 13)}Valider</button><button class="btn sm" data-rej=${p.id}>Refuser</button></div>` : p.steps.length ? html`<span class="res muted">${STATUTS_PLAN[p.status] || ''}</span>` : ''}
      ${p.choix && p === hist[hist.length - 1] && !S.agentBusy ? html`<div class="choix">${p.choix.map((c, i) => html`<button class="btn sm ${c.recommande ? 'solid' : ''}" data-choix=${i} title=${c.pourquoi || ''}>${c.recommande ? I('check', 13) : ''}${c.canal}${c.recommande ? html` <small>conseillé</small>` : ''}</button>`)}</div>` : ''}
      ${(p.suggestions || []).map(g => html`<div class="propo"><span class="itile">${I('plus', 14)}</span><div class="grow"><b>${g.nom || g.name}</b><p>${g.pourquoi}</p></div><button class="btn sm" data-inst-ext=${g.extId}>Voir</button></div>`)}
      <div class="pied">${p.voix ? html`<button class="lienfin" data-rejouer=${p.id} title="Réentendre la réponse">${I('play', 11)} Réécouter</button>` : ''}${p.duree ? html`<small class="duree" title="Temps de réponse">${p.duree < 1000 ? '< 1 s' : `${Math.round(p.duree / 1000)} s`}${p.model ? ` · ${p.model}` : ''}</small>` : ''}<button class="lienfin" data-corr=${p.id} title="Dire ce qu’il fallait répondre. La prochaine question proche ramènera ta correction.">Corriger</button></div>
    </div>`;
  };
  poser(panel, html`
    <header><span class="itile ink">${I('sparkle')}</span><div class="grow"><b>Assistant</b><small class="tronque">${cfg ? `${cfg.name} · ${ai.autonomy}` : 'aucune IA configurée'}</small></div><button class="ghost" id="aiVoixBtn" title="Parler à l’assistant — il répond à voix haute (service VOX)" aria-label="Mode vocal">${I('mic', 14)}</button><button class="ghost" id="aiNew" title="Nouvelle conversation — repart à vide, sans envoyer les échanges précédents au modèle" aria-label="Nouvelle conversation">${I('plus', 14)}</button><button class="ghost ${S.page === 'secrets' ? 'on' : ''}" id="aiSec" title="Clés & API — jetons que l’assistant peut citer sans jamais les voir" aria-label="Clés et API">${I('key', 14)}</button><button class="ghost" id="aiClose" aria-label="Fermer">${I('x', 14)}</button></header>
    <div class="msgs" id="msgs">
      ${!cfg ? html`<div class="m a">Ajoute d’abord une IA dans Réglages (Ollama sur une autre machine, ou une clé API).</div>` : ''}
      ${hist.length ? hist.map(echange) : html`<div class="m a">Dis-moi ce que tu veux : installer ou connecter un service, relier des services, créer un workflow, comprendre un problème. Rien ne change sans ta validation.</div>`}
      ${S.agentAsk ? html`<div class="m u">${S.agentAsk}</div>` : ''}
      ${S.agentErr ? html`<div class="m a"><span class="err">${S.agentErr}</span></div>` : ''}
      ${S.agentBusy ? html`<div class="m a" id="aiLive">${S.agentLive ? S.agentLive : html`<span class="typing"><span></span><span></span><span></span></span>`}</div><div class="m a muted etapes" id="aiEtapes">${noteEtapes()}</div>` : ''}
      ${cerveau.proposer && !S.agentBusy ? html`<div class="propo grand"><span class="itile ink">${I('sparkle', 15)}</span><div class="grow"><b>${cerveau.titre}</b>${cerveau.corps.map(l => html`<p>${l}</p>`)}
        <div class="row avec-marge"><button class="btn solid sm" data-inst-ext=${cerveau.extId}>${I('plus', 13)}Installer ${cerveau.nom}</button><button class="btn sm" id="cvTard">Plus tard</button><button class="btn sm" id="cvJamais">Ne plus proposer</button></div></div></div>` : ''}
    </div>
    <div class="ecoute" id="aiEcoute" hidden></div>
    <div class="sugg">${S.agentBusy ? '' : SUGG.map((s, i) => html`<button data-sugg=${i}>${I('sparkle', 13)}<span>${s}</span></button>`)}</div>
    <form id="aiForm"><input id="aiIn" placeholder="Demande quelque chose…" autocomplete="off" disabled=${!!S.agentBusy} aria-label="Demande à l’assistant">${S.agentBusy
      ? html`<button class="btn sm" type="button" id="aiStop" aria-label="Arrêter">${I('x', 14)}Arrêter</button>`
      : html`<button class="btn solid sm" aria-label="Envoyer">${I('arrow', 14)}</button>`}</form>`);
  const ms = $('#msgs', panel); if (ms) ms.scrollTop = ms.scrollHeight;
  /* Un brouillon (tapé, ou pré-rempli par une autre IA ou un bouton) survit aux
     rafraîchissements du panneau : il ne part que quand on l'envoie. */
  const champ = $('#aiIn', panel);
  if (champ) {
    if (S.aiPreRempli) { champ.value = S.aiPreRempli; champ.focus(); champ.setSelectionRange(champ.value.length, champ.value.length); }
    champ.oninput = () => { S.aiPreRempli = champ.value; };
  }
  majEcoute();
  $('#aiClose', panel).onclick = toggleAi;
  // Déjà sur la page : on n'y retourne pas, on met la recherche sous la main.
  $('#aiSec', panel).onclick = () => { if (S.page === 'secrets') { const q = $('#secQ'); q?.focus(); q?.select(); } else navigate('secrets'); };
  $('#aiNew', panel).onclick = () => pulse($('#aiNew', panel), async () => {
    await POST('/api/agent/nouvelle', {});
    S.agentErr = ''; S.agentAsk = '';
    renderAi();
  }).catch(fail);
  const ask = async text => {
    if (!text.trim() || S.agentBusy) return;
    /* Le même texte deux fois en trois secondes : un double envoi (Entrée +
       validation de la correction automatique), pas une deuxième question. */
    const t0 = Date.now();
    if (S.dernierEnvoi?.texte === text.trim() && t0 - S.dernierEnvoi.t < 3000) return;
    S.dernierEnvoi = { texte: text.trim(), t: t0 };
    S.aiPreRempli = '';
    S.agentBusy = true; S.agentAttente = false; S.agentLive = ''; S.agentEtapes = -1; S.agentPhase = ''; S.agentErr = ''; S.agentAsk = text; renderAi();
    try { await POST('/api/agent/ask', { text }); S.agentAsk = ''; }
    catch (e) { S.agentErr = e.message; }   // la question reste affichée au-dessus
    S.agentBusy = false; S.agentLive = ''; S.agentEtapes = -1; S.agentPhase = ''; renderAi();
  };
  $('#aiForm', panel).onsubmit = e => { e.preventDefault(); ask($('#aiIn', panel).value); };
  // Arrêter coupe l'appel côté serveur ; le `ask()` en vol part en erreur
  // « Réponse interrompue », qui s'affiche comme n'importe quelle autre.
  if ($('#aiStop', panel)) $('#aiStop', panel).onclick = () => POST('/api/agent/stop', {}).catch(fail);
  if ($('#cvTard', panel)) $('#cvTard', panel).onclick = async () => { await POST('/api/agent/cerveau/plus-tard', {}); renderAi(); };
  if ($('#cvJamais', panel)) $('#cvJamais', panel).onclick = async () => { await POST('/api/agent/cerveau/plus-tard', { jamais: true }); renderAi(); };
  // Corriger n'est pas « pouce en bas » : on dit ce qu'il fallait répondre.
  // Un avis sans contenu n'apprend rien à personne.
  $$('[data-corr]', panel).forEach(b => { b.onclick = () => modal({
    title: 'Corriger cette réponse',
    sub: 'Elle sera ressortie la prochaine fois qu’une question proche sera posée.',
    body: html`<div class="fl"><label for="corrTxt">Ce qu’il fallait répondre</label><textarea class="field haut-120" id="corrTxt" placeholder="Le modèle par défaut se lit dans la page IA, il ne s’invente pas."></textarea></div>`,
    actions: [{ label: 'Annuler' }, { label: 'Enregistrer', cls: 'solid', run: async me => {
      const t = $('#corrTxt', me).value.trim();
      if (!t) { toast('Écris la correction'); return false; }
      const r = await POST(`/api/agent/${encodeURIComponent(b.dataset.corr)}/corriger`, { correction: t });
      toast(`Correction retenue (${r.via})`);
    } }],
  }); });
  // Une suggestion n'installe rien : elle ouvre la fiche, avec ses réglages
  // et ses permissions, exactement comme depuis le catalogue.
  $$('[data-inst-ext]', panel).forEach(b => { b.onclick = async () => {
    try {
      const cat = await GET('/api/catalog');
      const e2 = cat.items.find(x => x.id === b.dataset.instExt);
      if (!e2) return toast('Cette extension n’est plus au catalogue');
      addServiceDialog(e2.manifest, e2.manifest.install.type === 'compose' ? 'compose' : 'remote');
    } catch (e) { fail(e); }
  }; });
  $$('[data-sugg]', panel).forEach(b => { b.onclick = () => ask(SUGG[Number(b.dataset.sugg)]); });
  // Choisir un compte : la demande d'origine repart, sur ce compte.
  $$('[data-choix]', panel).forEach(b => { b.onclick = () => { const c = hist[hist.length - 1]?.choix?.[Number(b.dataset.choix)]; if (c) ask(`Sur le compte « ${c.canal} »`); }; });
  $$('[data-exec]', panel).forEach(b => { b.onclick = async () => {
    b.disabled = true;
    try { const r = await POST(`/api/agent/${encodeURIComponent(b.dataset.exec)}/execute`); toast(r.status === 'done' ? 'Plan exécuté' : 'Plan interrompu', r.status === 'done' ? 'ok' : 'err'); } catch (e) { fail(e); }
    renderAi(); if (S.page !== 'editor') navigate(S.page);
  }; });
  $$('[data-rej]', panel).forEach(b => { b.onclick = async () => { await POST(`/api/agent/${encodeURIComponent(b.dataset.rej)}/reject`).catch(fail); renderAi(); }; });
  $$('[data-rejouer]', panel).forEach(b => { b.onclick = () => { const p = hist.find(x => x.id === b.dataset.rejouer); rejouer(p?.parole || p?.reply); }; });
  $('#aiVoixBtn', panel).onclick = () => basculerVoix().catch(fail);
  monterVoix();
}

// Clés & API
/* Une page à part, pensée pour se repérer sans lire : chaque service a son
   logo — celui qu'il publie sur son site, téléchargé une fois par le Hub —
   ou, à défaut, un monogramme à sa couleur. Ce qui est enregistré est en
   haut, avec ce qui s'en sert ; ce qu'on peut ajouter est en dessous, rangé
   par usage. Les valeurs ne s'affichent jamais : ni ici, ni pour l'IA. */
const couleurDe = (nom, c) => c || `hsl(${[...String(nom)].reduce((a, x) => (a * 31 + x.charCodeAt(0)) % 360, 7)} 55% 52%)`;
function logoTuile(id, nom, couleur, taille = 44, domaine = '') {
  // « Home Assistant » → HA, « Discord » → DI : deux lettres qui ressemblent au nom.
  const mots = String(nom || '').split(/[^A-Za-z0-9]+/).filter(Boolean);
  const lettres = (mots.length > 1 ? mots[0][0] + mots[1][0] : (mots[0] || '').slice(0, 2)).toUpperCase() || '?';
  return html`<span class="logo" style=${{ '--c': couleurDe(nom, couleur), '--t': `${taille}px` }}><span class="mono-l">${lettres}</span><img alt="" loading="lazy" src="/api/secrets/logo/${encodeURIComponent(id)}${domaine ? '?d=' + encodeURIComponent(domaine) : ''}"></span>`;
}
// La politique de contenu interdit les gestionnaires en ligne : l'échec d'un logo se traite ici.
function brancherLogos(root) {
  $$('.logo img', root).forEach(img => {
    const ok = () => img.closest('.logo')?.classList.add('a-logo');
    if (img.complete && img.naturalWidth) ok();
    img.addEventListener('load', ok);
    img.addEventListener('error', () => img.remove());
  });
}

async function viewSecrets(el, t) {
  const d = await GET('/api/secrets');
  if (!alive(t)) return;
  let filtre = '';
  const render = () => {
    const f = filtre.trim().toLowerCase();
    const trouve = x => !f || [x.nom, x.categorie, ...(x.champs || []).map(c => c.key || c.label)].join(' ').toLowerCase().includes(f);
    const posés = d.services.filter(trouve);
    const dispo = d.catalogue.filter(trouve);
    const faits = new Set(d.services.map(s => s.base || s.service));
    const nbDe = id => d.services.filter(s => (s.base || s.service) === id).length;
    const complet = c => { const s = d.services.find(x => x.service === c.id) || d.services.find(x => x.base === c.id); return s && c.champs.every(ch => ch.secret === false || s.champs.some(k => k.key.endsWith('_' + ch.key) && k.rempli)); };
    poser(el, headrow('Clés & API', 'Les jetons dont tes workflows ont besoin. L’assistant en connaît les noms, jamais les valeurs.',
      html`<input class="field recherche" id="secQ" type="search" placeholder="Rechercher…" value=${filtre} aria-label="Rechercher"><button class="btn solid" id="secPerso">${I('plus', 14)}Personnalisé</button>`),
      html`<div class="sec-titre"><b>Enregistrés</b><span>${d.services.length}</span></div>`,
      posés.length ? html`<div class="sec-grille">${posés.map(s => html`<div class="sec-carte" data-edit=${s.service} tabindex="0" role="button" aria-label="Modifier ${s.nom}">
          <div class="sec-tete">${s.libre ? html`<span class="logo"><span class="mono-l">${I('text', 20)}</span></span>` : logoTuile(s.base || s.service, s.nom, s.couleur, 44, s.domaine)}<div class="grow"><b>${s.nom}${s.compte ? html` <span class="sec-compte">${s.compte}</span>` : ''}</b><small>${s.categorie}</small></div>
            ${['telegram', 'discord', 'slack', 'ntfy'].includes(s.base) ? html`<button class="ghost" data-essai=${s.service} aria-label="Envoyer un message de test" title="Envoyer un message de test">${I('send', 14)}</button>` : ''}${s.libre ? '' : html`<button class="ghost" data-del=${s.service} aria-label="Oublier ${s.nom}" title="Oublier">${I('x', 14)}</button>`}</div>
          <div class="sec-cles">${s.champs.map(c => html`<button class="sec-cle ${c.rempli ? '' : 'vide'}" data-copie=${c.key} title="Copier {{ $vars.${c.key} }}">${I(c.secret ? 'key' : 'text', 12)}<span class="mono">${c.key}</span></button>`)}</div>
          <div class="sec-pied">${s.utilisePar.length
            ? html`${I('libre', 13)}<span>utilisé par ${s.utilisePar.length} workflow${s.utilisePar.length > 1 ? 's' : ''}</span><em title=${s.utilisePar.join(', ')}>${s.utilisePar.slice(0, 2).join(', ')}${s.utilisePar.length > 2 ? '…' : ''}</em>`
            : html`${I('clock', 13)}<span>aucun workflow ne s’en sert encore</span>`}</div>
        </div>`)}</div>`
        : html`<div class="card list-empty">${f ? 'Rien d’enregistré ne correspond.' : 'Rien d’enregistré. Choisis un service ci-dessous : son jeton ira dans le coffre du Hub.'}</div>`,
      d.categories.map(cat => {
        const l = dispo.filter(c => c.categorie === cat);
        if (!l.length) return null;
        return html`<div class="sec-titre"><b>${cat}</b><span>${l.length}</span></div><div class="sec-tuiles">${l.map(c => html`<button class="sec-tuile ${faits.has(c.id) ? 'fait' : ''}" data-svc=${c.id} title=${c.nom}>
            ${logoTuile(c.id, c.nom, c.couleur, 52, c.domaine)}<b>${c.nom}</b>${faits.has(c.id) ? html`<span class="sec-ok ${complet(c) ? '' : 'part'}">${nbDe(c.id) > 1 ? html`<i>${nbDe(c.id)}</i>` : I('check', 12)}</span>` : ''}</button>`)}</div>`;
      }));
    brancherLogos(el);
    const q = $('#secQ', el);
    q.oninput = () => { filtre = q.value; const pos = q.selectionStart; render(); const n = $('#secQ', el); n.focus(); n.setSelectionRange(pos, pos); };
    $('#secPerso', el).onclick = () => ficheSecret(d, { perso: true }, render);
    $$('[data-svc]', el).forEach(b => { b.onclick = () => ficheSecret(d, { id: b.dataset.svc }, render); });
    $$('[data-edit]', el).forEach(c => {
      const ouvrir = () => { const s = d.services.find(x => x.service === c.dataset.edit); if (s.libre) return navigate('settings'); ficheSecret(d, s.connu ? { id: s.base, existant: s } : { perso: true, existant: s }, render); };
      c.onclick = e => { if (!e.target.closest('[data-del],[data-copie],[data-essai]')) ouvrir(); };
      c.onkeydown = e => { if (e.key === 'Enter' && e.target === c) ouvrir(); };
    });
    $$('[data-essai]', el).forEach(b => { b.onclick = () => pulse(b, async () => {
      const r = await POST('/api/secrets/test', { service: b.dataset.essai });
      toast(`Message envoyé sur ${r.canal}`);
    }).catch(fail); });
    $$('[data-copie]', el).forEach(b => { b.onclick = async () => {
      const txt = `{{ $vars.${b.dataset.copie} }}`;
      try { await navigator.clipboard.writeText(txt); toast(`${txt} copié`); } catch { toast(txt); }
    }; });
    $$('[data-del]', el).forEach(b => { b.onclick = async () => {
      const s = d.services.find(x => x.service === b.dataset.del);
      const extra = s.utilisePar.length ? ` ${s.utilisePar.length} workflow${s.utilisePar.length > 1 ? 's' : ''} s’en ser${s.utilisePar.length > 1 ? 'vent' : 't'} : ${s.utilisePar.join(', ')}.` : '';
      if (!await confirmBox(`Oublier ${s.nom} ?`, `Les valeurs sont effacées du coffre.${extra}`, 'Oublier', true)) return;
      try { await DEL(`/api/secrets/${encodeURIComponent(s.service)}`); Object.assign(d, await GET('/api/secrets')); toast(`${s.nom} oublié`); render(); } catch (e) { fail(e); }
    }; });
  };
  render();
}

/* La fiche d'un service : son logo en tête, un champ par valeur attendue, et
   où trouver chaque jeton. Un champ secret laissé vide garde l'ancienne valeur.
   Un service connu peut avoir plusieurs comptes (deux bots Telegram, deux
   clés Kimi) : chacun a un nom, et ses clés le portent —
   TELEGRAM_ALERTES_BOT_TOKEN. Le premier garde les clés courtes. */
function ficheSecret(d, { id, perso, existant }, apres) {
  const c = id ? d.catalogue.find(x => x.id === id) : null;
  const deja = existant || null;
  const aDefaut = c && d.services.some(x => x.service === c.id);
  const nouveauCompte = c && !existant;
  let champs = c ? c.champs.map(f => ({ ...f })) : (existant ? existant.champs.map(k => ({ key: k.label || k.key, label: k.label, secret: k.secret })) : [{ key: '', label: '' }, { key: '', label: '' }]);
  const nomInit = c ? c.nom : (existant?.service || '');
  const corps = () => html`
    <div class="sec-fiche-tete">${logoTuile(c ? c.id : (existant?.service || 'nouveau'), nomInit || '+', c?.couleur, 56, c ? c.domaine : existant?.domaine)}
      <div><b>${nomInit || 'Service personnalisé'}</b><small>${c ? c.categorie : 'Tes propres clés, scellées dans le coffre'}</small></div></div>
    ${c?.ou ? html`<div class="hookbox"><b>Où le trouver</b><span>${c.ou}</span></div>` : ''}
    ${c ? html`<div class="fl"><label for="secCompte">Nom de ce compte${nouveauCompte && aDefaut ? '' : ' (facultatif)'}</label>
      <input class="field" id="secCompte" value=${existant?.compte || ''} readonly=${!!existant} placeholder=${nouveauCompte && aDefaut ? `Un ${c.nom} existe déjà : nomme celui-ci (ex. Alertes, Perso)` : 'ex. Alertes, Perso — pour en avoir plusieurs'}>
      <div class="help" id="secPrefixe"></div></div>` : ''}
    ${perso ? html`<div class="formgrid">
      <div class="fl"><label for="secNom">Nom du service</label><input class="field" id="secNom" value=${nomInit} readonly=${!!existant} placeholder="Mon service"></div>
      <div class="fl"><label for="secSite">Site (pour son logo)</label><input class="field mono" id="secSite" value=${existant?.domaine || ''} placeholder="exemple.com"></div></div>` : ''}
    <div id="secF">${champs.map((f, i) => perso
      ? html`<div class="formgrid"><div class="fl"><label for="sk${i}">Nom du champ</label><input class="field mono" id="sk${i}" data-k=${i} value=${f.key} placeholder="API_KEY"></div>
         <div class="fl"><label for="sv${i}">Valeur${existant?.champs[i]?.rempli && existant.champs[i].secret ? html` <span class="devoiler-ici" data-cle=${existant.champs[i].key}></span>` : ''}</label><input class="field mono" id="sv${i}" type="password" data-f=${i} autocomplete="new-password" placeholder=${existant ? 'vide = inchangé' : ''}></div></div>`
      : html`<div class="fl"><label for="sv${i}">${I(f.secret ? 'key' : 'text', 12)} ${f.label} <span class="mono mini" data-prefixe=${f.key}>${c.id.toUpperCase()}_${f.key}</span>${deja?.champs.some(k => k.key.endsWith('_' + f.key) && k.rempli) ? html` <span class="chip a">enregistré</span>${f.secret ? html` <span class="devoiler-ici" data-cle=${deja.champs.find(k => k.key.endsWith('_' + f.key)).key}></span>` : ''}` : ''}</label>
         <input class="field mono" id="sv${i}" data-f=${f.key} type=${f.secret ? 'password' : 'text'} autocomplete="new-password" placeholder=${f.secret && deja ? 'vide = inchangé' : ''}>
         ${f.help ? html`<div class="help">${f.help}</div>` : ''}
         ${c.id === 'elevenlabs' && f.key === 'VOICE_ID' ? html`<div class="row avec-marge"><button class="btn sm" id="elVoix" type="button">${I('mic', 13)}Choisir une voix</button><span class="mini" id="elMsg">Liste les voix de ton compte (la clé est vérifiée au passage).</span></div><div id="elOut"></div>` : ''}
         ${c.id === 'telegram' && f.key === 'CHAT_ID' ? html`<div class="row avec-marge"><button class="btn sm" id="tgChats" type="button">${I('search', 13)}Trouver l’identifiant</button><span class="mini" id="tgOut">Écris d’abord /start à ton bot dans Telegram (ou ajoute-le au groupe).</span></div>` : ''}</div>`)}</div>
    ${perso ? html`<button class="btn sm" id="secPlus">${I('plus', 13)}Ajouter un champ</button>` : ''}
    <div id="secErr"></div>`;
  const valeurDe = (box, cle) => [...box.querySelectorAll('[data-f]')].find(x => x.dataset.f === cle);
  const m = modal({
    title: c ? c.nom : 'Service personnalisé', sub: 'L’assistant verra le nom de chaque clé, jamais sa valeur.', wide: true,
    body: html`<div id="secBox"></div>`,
    actions: [{ label: 'Annuler' }, { label: 'Enregistrer', cls: 'solid', run: async me => {
      const box = $('#secBox', me);
      const valeurs = {};
      $$('[data-f]', box).forEach(inp => {
        const nom = perso ? ([...box.querySelectorAll('[data-k]')].find(x => x.dataset.k === inp.dataset.f)?.value || '').trim() : inp.dataset.f;
        if (nom) valeurs[nom] = inp.value;
      });
      const compte = $('#secCompte', box)?.value.trim() || '';
      if (nouveauCompte && aDefaut && !compte) { poser($('#secErr', box), html`<div class="err">Un ${c.nom} est déjà enregistré : donne un nom à celui-ci.</div>`); return false; }
      const req = perso ? { nom: $('#secNom', box).value.trim(), champs: valeurs, site: $('#secSite', box).value.trim() }
        : existant ? { service: existant.service, champs: valeurs } : { service: c.id, compte, champs: valeurs };
      try {
        const r = await POST('/api/secrets', req);
        toast(r.clés.length ? `${r.clés.length} clé(s) enregistrée(s)` : 'Enregistré');
        Object.assign(d, await GET('/api/secrets')); apres();
      } catch (e) { poser($('#secErr', box), html`<div class="err">${e.message}</div>`); return false; }
    } }],
    onOpen: me => {
      const peindre = () => {
        const box = $('#secBox', me); poser(box, corps()); brancherLogos(box);
        // Dévoiler une clé enregistrée : vérification faite exprès (socle), puis 60 s en clair.
        $$('.devoiler-ici', box).forEach(sp => sp.replaceWith(boutonDevoiler(async () => (await GET(`/api/secrets/valeur/${sp.dataset.cle}`)).valeur)));
        // Les noms des clés suivent le nom du compte, en direct.
        const cpt = $('#secCompte', box);
        const majPrefixe = () => {
          const sl = (cpt?.value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
          $$('[data-prefixe]', box).forEach(x => { x.textContent = `${c.id.toUpperCase()}_${sl ? sl + '_' : ''}${x.dataset.prefixe}`; });
        };
        if (cpt && c) { cpt.oninput = majPrefixe; majPrefixe(); }
        // Telegram : l'identifiant de discussion se lit dans les messages reçus par le bot.
        const tg = $('#tgChats', box);
        if (tg) tg.onclick = () => pulse(tg, async () => {
          const r = await POST('/api/secrets/telegram/chats', { service: existant?.service || c.id, token: valeurDe(box, 'BOT_TOKEN')?.value || '' });
          const out = $('#tgOut', box);
          if (!r.chats.length) { out.textContent = 'Aucun message reçu par le bot : écris-lui /start dans Telegram, puis réessaie.'; return; }
          poser(out, r.chats.map(ch => [html`<button class="chip a" type="button" data-chat=${ch.id} title=${ch.type}>${ch.nom} · ${ch.id}</button>`, ' ']));
          $$('[data-chat]', out).forEach(b => { b.onclick = () => { valeurDe(box, 'CHAT_ID').value = b.dataset.chat; toast(`Identifiant ${b.dataset.chat} repris`); }; });
          if (r.chats.length === 1) { valeurDe(box, 'CHAT_ID').value = r.chats[0].id; toast('Identifiant rempli'); }
        }).catch(e => { $('#tgOut', box).textContent = e.message; });
        // ElevenLabs : l'identifiant de voix se choisit dans la liste du compte.
        const el = $('#elVoix', box);
        if (el) el.onclick = () => pulse(el, async () => {
          const r = await POST('/api/secrets/elevenlabs/voix', { service: existant?.service || c.id, token: valeurDe(box, 'API_KEY')?.value || '' });
          const out = $('#elOut', box), msg = $('#elMsg', box), champ = valeurDe(box, 'VOICE_ID');
          msg.classList.remove('err');
          if (!r.voix.length) { msg.textContent = 'Clé acceptée, mais aucune voix dans ce compte : ajoutes-en une depuis la Voice Library.'; out.replaceChildren(); return; }
          msg.textContent = `Clé acceptée · ${r.voix.length} voix dans ton compte`;
          const carte = v => html`<div class="vcarte${champ.value === v.id ? ' on' : ''}" role="option" tabindex="0" aria-selected=${String(champ.value === v.id)} data-voix=${v.id} data-nom=${v.nom.toLowerCase()}>
              <span class="vp-av"><span class="ini">${[...v.nom][0] || '?'}</span><span class="ok">${I('check', 14)}</span></span>
              <span class="grow"><b title=${v.nom}>${v.nom}</b><small title=${v.detail}>${[v.genre, v.detail].filter(Boolean).join(' · ') || 'Voix du compte'}</small></span>
              ${v.apercu ? html`<button type="button" class="ghost vp-play" data-ecoute=${v.id} aria-label="Écouter ${v.nom}" title="Écouter">${I('play', 12)}</button>` : ''}
            </div>`;
          poser(out, r.voix.length > 9 ? html`<input class="field vgrid-cherche" type="search" placeholder="Rechercher une voix…" aria-label="Rechercher une voix" autocomplete="off">` : '',
            html`<div class="vgrid" role="listbox" aria-label="Voix ElevenLabs">${r.voix.map(carte)}</div>`);
          const choisir = c2 => {
            champ.value = c2.dataset.voix;
            $$('.vcarte', out).forEach(x => { x.classList.toggle('on', x === c2); x.setAttribute('aria-selected', String(x === c2)); });
            toast(`Voix « ${c2.querySelector('b').textContent} » choisie`);
          };
          out.onclick = e => {
            const play = e.target.closest('[data-ecoute]');
            if (play) { e.stopPropagation(); ecouterApercu(play.dataset.ecoute).catch(err => toast(err.message, 'err')); return; }
            const c2 = e.target.closest('.vcarte'); if (c2) choisir(c2);
          };
          out.onkeydown = e => { const c2 = e.target.closest('.vcarte'); if (c2 && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); choisir(c2); } };
          const cherche = $('.vgrid-cherche', out);
          if (cherche) cherche.oninput = () => { const q = cherche.value.trim().toLowerCase(); $$('.vcarte', out).forEach(x => { x.hidden = !!q && !x.dataset.nom.includes(q); }); };
        }).catch(e => { const msg = $('#elMsg', box); msg.textContent = e.message; msg.classList.add('err'); $('#elOut', box).replaceChildren(); });
        const plus = $('#secPlus', box);
        if (plus) plus.onclick = () => {
          champs = champs.map((f, i) => ({ ...f, key: [...box.querySelectorAll('[data-k]')].find(x => x.dataset.k === String(i))?.value || f.key }));
          champs.push({ key: '', label: '' }); peindre();
        };
      };
      peindre();
    },
  });
  return m;
}

boot();
