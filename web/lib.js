// Outils partagés de l'interface : API, notifications, modales, formulaires.
// Tout le rendu passe par les gabarits du socle : une valeur y devient du
// texte, un attribut ou un nœud, jamais du balisage.
import { Api, toast as toastSocle } from '/socle/compte.js';
import { html, poser, rendre, element } from '/socle/gabarit.js';
import { I } from './icons.js';

export { html, poser, rendre, element };
export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];

// Qui est connecté : rempli par app.js une fois la porte du socle franchie.
export const session = { user: '', role: '' };

// Le client du socle : jeton anti-CSRF, renfort demandé puis rejoué, retour à
// la porte quand la session tombe.
export const api = new Api({ surDeconnexion: () => setTimeout(() => location.reload(), 800) });
export const GET = p => api.get(p);
export const POST = (p, b = {}) => api.post(p, b);
export const PUT = (p, b = {}) => api.put(p, b);
export const PATCH = (p, b = {}) => api.patch(p, b);
export const DEL = p => api.del(p);

// Retour visuel d'un bouton : roue pendant l'appel, puis coche ou croix.
// Sans cela, un bouton qui répond en 200 ms laisse croire qu'il n'a rien fait.
export async function pulse(btn, fn) {
  if (!btn || btn.dataset.busy) return;
  const avant = [...btn.childNodes].map(n => n.cloneNode(true)), label = btn.textContent.trim();
  btn.dataset.busy = '1';
  btn.classList.remove('is-ok', 'is-ko');
  btn.classList.add('is-busy');
  poser(btn, html`<span class="spin"></span>${label}`);
  const rendreBouton = (cls, ic) => {
    btn.classList.remove('is-busy');
    btn.classList.add(cls);
    poser(btn, I(ic, 14), label);
    setTimeout(() => {
      btn.classList.remove('is-ok', 'is-ko');
      btn.replaceChildren(...avant);
      delete btn.dataset.busy;
    }, 1300);
  };
  try {
    const r = await fn();
    rendreBouton('is-ok', 'check');
    return r;
  } catch (e) {
    rendreBouton('is-ko', 'x');
    throw e;
  }
}

export const toast = (msg, kind = 'ok') => toastSocle(String(msg), kind === 'err');
export const fail = e => {
  const det = Array.isArray(e.details) ? ' — ' + e.details.slice(0, 3).map(d => d.message || d).join(' ; ') : '';
  toast((e.message || String(e)) + det, 'err');
};

export const when = ts => {
  if (!ts) return '—';
  const d = new Date(ts), diff = (Date.now() - d) / 1000;
  if (diff < 60) return 'à l’instant';
  if (diff < 3600) return `il y a ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `il y a ${Math.floor(diff / 3600)} h`;
  return d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};
export const hhmm = ts => (ts ? new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');

// Modale
// Les modales s'empilent : chacune vit dans son propre voile et ne ferme
// qu'elle-même. Sans cela, une modale ouverte depuis une autre — le renfort
// puis les comptes, une confirmation par-dessus une liste — effaçait celle qui
// l'avait ouverte, ou se faisait effacer par elle.
const pile = [];
export function modal({ title, sub = '', body, actions = [], wide = false, onOpen, onClose }) {
  const boutons = actions.map(a => element(html`<button type="button" class="btn ${a.cls || ''}">${a.label}</button>`));
  const boite = element(html`<div class="dialogue large ${wide ? 'tres-large' : ''}" role="dialog" aria-modal="true" aria-label=${title}>
    <header class="dtete"><div class="grow"><h3>${title}</h3>${sub ? html`<p>${sub}</p>` : ''}</div><button type="button" class="ghost" aria-label="Fermer">${I('x', 14)}</button></header>
    <div class="mb">${body}</div>
    ${boutons.length ? html`<div class="pied">${boutons}</div>` : ''}
  </div>`);
  const voile = element(html`<div class="voile"></div>`);
  voile.append(boite);
  document.body.append(voile);
  pile.push(voile);
  const precedent = document.activeElement;
  const close = () => {
    voile.remove();
    pile.splice(pile.indexOf(voile), 1);
    document.removeEventListener('keydown', onKey);
    precedent?.focus?.();
    onClose?.();
  };
  // Échap ne ferme que la modale du dessus.
  const onKey = e => { if (e.key === 'Escape' && pile.at(-1) === voile) close(); };
  document.addEventListener('keydown', onKey);
  $('.dtete .ghost', boite).addEventListener('click', close);
  voile.addEventListener('mousedown', e => { if (e.target === voile) close(); });
  boutons.forEach((b, i) => b.addEventListener('click', async () => {
    const a = actions[i];
    if (!a.run) { close(); return; }
    b.disabled = true;
    try {
      const r = await pulse(b, () => a.run(boite));
      if (r !== false) close();
    } catch (e) { fail(e); }
    finally { b.disabled = false; }
  }));
  onOpen?.(boite, close);
  $('input,select,textarea', boite)?.focus();
  return { el: boite, close };
}
export function confirmBox(title, text, label = 'Confirmer', danger = true) {
  return new Promise(resolve => {
    modal({ title, body: html`<p>${text}</p>`, actions: [{ label: 'Annuler', run: () => { resolve(false); } }, { label, cls: danger ? 'solid danger' : 'solid', run: () => { resolve(true); } }] });
  });
}

/* L'extrait d'écoute d'une voix ElevenLabs, relayé par le Hub. Un seul à la
   fois : en lancer un autre coupe le précédent. */
let extraitEnCours = null;
async function jouerExtrait(id) {
  const r = await fetch(`/api/secrets/elevenlabs/apercu/${encodeURIComponent(id)}`, { credentials: 'same-origin' });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Extrait indisponible');
  const ctx = new AudioContext(), src = ctx.createBufferSource();
  src.buffer = await ctx.decodeAudioData(await r.arrayBuffer()); src.connect(ctx.destination); src.start();
  return { pause: () => { try { src.stop(); ctx.close(); } catch { /* déjà fini */ } } };
}
export async function ecouterApercu(id) {
  if (extraitEnCours) extraitEnCours.pause();
  extraitEnCours = await jouerExtrait(id);
}

// Formulaires générés depuis les champs des manifestes
// ctx : { instanceId, kind, ref, lookups: {instances, probes, workflows, ai} }

// Un champ qui porte showIf n'apparaît que si les champs qu'il nomme ont
// l'une des valeurs listées : la clé d'API disparaît quand on choisit un
// mode qui n'en a pas besoin. L'enveloppe est en display:contents, donc la
// grille du formulaire ne voit que le champ lui-même.
export function champForm(f, value, ctx = {}, prefix = 'f') {
  const c = controle(f, value, ctx, prefix);
  return f.showIf ? html`<div class="cond" data-show-if=${JSON.stringify(f.showIf)}>${c}</div>` : c;
}

const texteDe = x => (x === undefined || x === null ? '' : typeof x === 'object' ? JSON.stringify(x, null, 2) : String(x));
const optionsDe = list => (list || []).map(o => (typeof o === 'object' ? o : { value: o, label: o }));

function controle(f, value, ctx = {}, prefix = 'f') {
  const idAttr = `${prefix}_${f.key}`;
  // Un défaut calculé par le Hub ({{hub.ip}}…) ne s'affiche pas brut : vide, il est rempli au déploiement.
  const calcule = typeof f.default === 'string' && f.default.includes('{{');
  const v = value === undefined ? (calcule ? '' : f.default) : value;
  const label = html`<label for=${idAttr}>${f.label}${f.required ? ' *' : ''}</label>`;
  const help = f.help ? html`<div class="help">${f.help}</div>` : '';
  let ctrl;
  switch (f.type) {
    case 'boolean':
      return html`<label class="check full"><input type="checkbox" id=${idAttr} data-key=${f.key} data-type="boolean" checked=${v === true || v === 'true'}> ${f.label}</label>${help}`;
    case 'select': case 'multiselect': {
      const multi = f.type === 'multiselect';
      const cur = multi ? (Array.isArray(v) ? v.map(String) : []) : [texteDe(v)];
      const list = optionsDe(f.options);
      const hasCur = !multi && cur[0] && !list.some(o => String(o.value) === cur[0]);
      ctrl = html`<select class="field" id=${idAttr} data-key=${f.key} data-type=${f.type} multiple=${multi} size=${multi ? 5 : null} data-dyn=${f.optionsFrom ? '1' : null}>
        ${!multi && !f.required ? html`<option value="">—</option>` : ''}
        ${hasCur ? html`<option value=${cur[0]} selected>${cur[0]}</option>` : ''}
        ${list.map(o => html`<option value=${o.value} selected=${cur.includes(String(o.value))}>${o.label}</option>`)}
      </select>`;
      break;
    }
    case 'instance': ctrl = selectFrom(idAttr, f, v, (ctx.lookups?.instances || []).map(i => ({ value: i.id, label: i.name }))); break;
    case 'probe': {
      const inst = (ctx.lookups?.instances || []).find(i => i.id === ctx.values?.instance);
      ctrl = selectFrom(idAttr, f, v, (inst?.probes || []).map(p => ({ value: p.id, label: p.name })));
      break;
    }
    case 'workflow-ref': ctrl = selectFrom(idAttr, f, v, (ctx.lookups?.workflows || []).map(w => ({ value: w.id, label: w.name }))); break;
    case 'ai-connection': ctrl = selectFrom(idAttr, f, v, (ctx.lookups?.ai || []).map(c => ({ value: c.id, label: c.name }))); break;
    case 'text': case 'json':
      ctrl = html`<textarea class="field" id=${idAttr} data-key=${f.key} data-type=${f.type} spellcheck="false">${texteDe(v)}</textarea>`; break;
    case 'secret':
      ctrl = html`<input class="field mono" type="password" autocomplete="new-password" id=${idAttr} data-key=${f.key} data-type="secret" value=${texteDe(v)} placeholder=${v ? '' : 'non défini'}>`; break;
    case 'tags': {
      const mots = String(v ?? '').split(',').map(s => s.trim()).filter(Boolean);
      ctrl = html`<div class="mots field" data-tags>
        <input type="hidden" data-key=${f.key} data-type="tags" value=${mots.join(',')}>
        <span class="mots-liste">${mots.map(etiquetteMot)}</span>
        <input class="mots-saisie" id=${idAttr} type="text" autocomplete="off" spellcheck="false" placeholder="Ajouter un mot…" aria-label="Ajouter un mot à ${f.label}">
      </div><div class="mots-idees" hidden></div>`;
      return html`<div class="fl full">${label}${ctrl}${help}</div>`;
    }
    case 'voice': {
      const liste = optionsDe(f.options);
      ctrl = html`<div class="vpick" data-vpick data-voix=${JSON.stringify(liste)}>
        <input type="hidden" data-key=${f.key} data-type="voice" value=${texteDe(v)}>
        <button type="button" class="field vpick-btn" id=${idAttr} aria-haspopup="listbox" aria-expanded="false"></button>
        <div class="vpick-menu" role="listbox" hidden></div>
      </div>`;
      return html`<div class="fl full">${label}${ctrl}${help}</div>`;
    }
    case 'number': case 'integer':
      ctrl = html`<input class="field" type="text" inputmode="decimal" id=${idAttr} data-key=${f.key} data-type=${f.type} value=${texteDe(v)}>`; break;
    default: {
      const mono = ['expression', 'cron', 'duration', 'container-ref', 'node-ref', 'service-ref'].includes(f.type) || /\{\{|\/|\$/.test(texteDe(v));
      ctrl = [html`<input class="field ${mono ? 'mono' : ''}" id=${idAttr} data-key=${f.key} data-type=${f.type} value=${texteDe(v)} pattern=${f.pattern || null} placeholder=${calcule ? 'automatique' : null}>`];
      if (f.optionsFrom && (ctx.instanceId || f.optionsFrom.from?.capability)) ctrl.push(html`<button type="button" class="link small" data-load=${f.key}>Charger les valeurs depuis le service</button>`);
    }
  }
  return html`<div class="fl ${f.type === 'text' || f.type === 'json' ? 'full' : ''}">${label}${ctrl}${help}</div>`;
}
const etiquetteMot = m => html`<span class="mot" data-mot=${m}>${m}<button type="button" class="mot-x" aria-label="Retirer ${m}">${I('x', 11)}</button></span>`;
const MOT_OK = /^[\p{L}\p{N}][\p{L}\p{N} ._'’-]{0,39}$/u;

/* Liste de mots : Entrée, virgule ou Tab ajoute ; un collage « a, b, c » en
   ajoute plusieurs ; Retour arrière sur la saisie vide retire le dernier. */
function bindTags(box) {
  const cache = $('[data-type="tags"]', box), saisie = $('.mots-saisie', box), liste = $('.mots-liste', box);
  const idees = box.nextElementSibling?.classList.contains('mots-idees') ? box.nextElementSibling : null;
  const mots = () => cache.value.split(',').filter(Boolean);
  const fixer = l => { cache.value = l.join(','); poser(liste, l.map(etiquetteMot)); proposer(); };
  const ajouter = texte => {
    const l = mots(), bas = new Set(l.map(x => x.toLowerCase())), refus = [];
    for (const brut of String(texte).split(/[,;\n]/)) {
      const m = brut.trim().replace(/\s+/g, ' ');
      if (!m) continue;
      if (!MOT_OK.test(m)) { refus.push(m); continue; }
      if (!bas.has(m.toLowerCase())) { l.push(m); bas.add(m.toLowerCase()); }
    }
    fixer(l);
    if (refus.length) toast(`Ignoré : ${refus.join(', ')} — lettres, chiffres, espace, point, tiret`);
  };
  const proposer = () => {
    if (!idees) return;
    const deja = new Set(mots().map(x => x.toLowerCase()));
    const l = (box._idees || []).filter(x => !deja.has(x.toLowerCase())).slice(0, 12);
    idees.hidden = !l.length;
    poser(idees, l.length ? html`<span class="mini">Tes services :</span> ${l.map(x => html`<button type="button" class="chip a" data-idee=${x}>${I('plus', 11)}${x}</button>`)}` : '');
    $$('[data-idee]', idees).forEach(b => { b.onclick = () => ajouter(b.dataset.idee); });
  };
  box.onclick = e => {
    const x = e.target.closest('.mot-x');
    if (x) { const m = x.parentElement.dataset.mot; fixer(mots().filter(y => y !== m)); saisie.focus(); return; }
    if (e.target === box || e.target === liste) saisie.focus();
  };
  saisie.onkeydown = e => {
    if ((e.key === 'Enter' || e.key === ',' || (e.key === 'Tab' && saisie.value.trim())) && saisie.value.trim()) { e.preventDefault(); ajouter(saisie.value); saisie.value = ''; }
    else if (e.key === 'Enter') e.preventDefault();
    else if (e.key === 'Backspace' && !saisie.value && mots().length) fixer(mots().slice(0, -1));
  };
  saisie.onpaste = e => { const t = e.clipboardData?.getData('text') || ''; if (/[,;\n]/.test(t)) { e.preventDefault(); ajouter(t); } };
  saisie.onblur = () => { if (saisie.value.trim()) { ajouter(saisie.value); saisie.value = ''; } };
  // Les noms des services déjà installés : ce sont eux qu'on prononce.
  GET('/api/instances').then(l => { box._idees = [...new Set((l || []).map(i => i.name).filter(n => MOT_OK.test(n)))]; proposer(); }).catch(() => {});
}

/* Choix d'une voix : un menu par rubrique, avec écoute pour celles qui ont
   un extrait. Les voix ElevenLabs viennent du compte rangé dans Clés & API. */
function bindVoix(box) {
  const cache = $('[data-type="voice"]', box), btn = $('.vpick-btn', box), menu = $('.vpick-menu', box);
  let locales = []; try { locales = JSON.parse(box.dataset.voix || '[]'); } catch { /* liste illisible : aucune voix locale */ }
  let eleven = null, elevenErr = '', lecteur = null;
  const toutes = () => [...locales, ...(eleven || []).map(v => ({ value: 'eleven:' + v.id, label: v.nom, group: 'ElevenLabs', detail: v.detail || (v.genre ? '' : 'Voix du compte'), genre: v.genre, apercu: v.apercu ? v.id : null }))];
  const pastille = o => { const n = String(o.label || '?').match(/(\d+)$/); return html`<span class="vp-av ${o.group === 'ElevenLabs' ? 'cloud' : ''}">${n ? n[1] : String(o.label || '?').replace(/^[^\p{L}\p{N}]+/u, '').slice(0, 2)}</span>`; };
  const affiche = () => {
    const o = toutes().find(x => String(x.value) === cache.value);
    poser(btn, o
      ? html`${pastille(o)}<span class="grow"><b>${o.label}</b><small>${[o.group, o.detail].filter(Boolean).join(' · ')}</small></span>${I('chev', 14)}`
      : html`<span class="vp-av">?</span><span class="grow"><b>${cache.value || 'Choisir une voix'}</b><small>${cache.value.startsWith('eleven:') ? 'ElevenLabs · ouvre le menu pour la retrouver' : 'Aucune voix choisie'}</small></span>${I('chev', 14)}`);
  };
  const dessine = () => {
    const groupes = new Map();
    for (const o of toutes()) { const g = o.group || 'Voix'; if (!groupes.has(g)) groupes.set(g, []); groupes.get(g).push(o); }
    if (!groupes.has('ElevenLabs')) groupes.set('ElevenLabs', []);
    poser(menu, [...groupes].map(([g, l]) => html`<div class="vp-groupe"><div class="vp-titre">${g} <span class="mini">${g === 'ElevenLabs' ? 'cloud · meilleure qualité' : 'gratuit · hors ligne'}</span></div>
      ${l.map(o => html`<div class="vp-item ${String(o.value) === cache.value ? 'on' : ''}" role="option" tabindex="0" aria-selected=${String(String(o.value) === cache.value)} data-v=${o.value}>
        ${pastille(o)}<span class="grow"><b>${o.label}</b><small>${o.detail || ''}</small></span>
        ${o.genre ? html`<span class="chip">${o.genre}</span>` : ''}
        ${o.apercu ? html`<button type="button" class="ghost vp-play" data-play=${o.apercu} aria-label="Écouter ${o.label}" title="Écouter">${I('play', 13)}</button>` : ''}
        ${String(o.value) === cache.value ? I('check', 14) : ''}</div>`)}
      ${g === 'ElevenLabs' && !l.length ? html`<div class="vp-vide">${eleven === null && !elevenErr ? 'Chargement des voix du compte…' : elevenErr || 'Aucune voix dans ce compte.'}</div>` : ''}</div>`));
  };
  const charger = async () => {
    if (eleven !== null) return;
    try { eleven = (await POST('/api/secrets/elevenlabs/voix', {})).voix; }
    catch (e) { eleven = []; elevenErr = /Aucune clé ElevenLabs/.test(e.message) ? 'Ajoute ta clé dans Clés & API → ElevenLabs pour choisir parmi tes voix.' : e.message; }
    affiche(); if (!menu.hidden) dessine();
  };
  const ouvrir = oui => {
    menu.hidden = !oui; btn.setAttribute('aria-expanded', String(oui));
    if (oui) {
      dessine(); charger();
      // Ouvert vers le haut quand la place manque dessous (bas de la fenêtre).
      const r = btn.getBoundingClientRect(), bas = innerHeight - r.bottom - 16, haut = r.top - 16;
      const enHaut = bas < 300 && haut > bas;
      menu.classList.toggle('haut', enHaut);
      menu.style.maxHeight = Math.max(180, Math.min(360, enHaut ? haut : bas)) + 'px';
      $('.vp-item.on', menu)?.scrollIntoView({ block: 'nearest' });
    } else if (lecteur) { lecteur.pause(); lecteur = null; }
  };
  const choisir = v => { cache.value = v; affiche(); ouvrir(false); btn.focus(); };
  btn.onclick = () => ouvrir(menu.hidden);
  menu.onclick = async e => {
    const play = e.target.closest('[data-play]');
    if (play) {
      e.stopPropagation();
      if (lecteur) lecteur.pause();
      try { lecteur = await jouerExtrait(play.dataset.play); } catch (err) { toast(err.message); }
      return;
    }
    const it = e.target.closest('.vp-item'); if (it) choisir(it.dataset.v);
  };
  menu.onkeydown = e => {
    const items = $$('.vp-item', menu), i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus(); }
    else if (e.key === 'Enter' || e.key === ' ') { if (i >= 0) { e.preventDefault(); choisir(items[i].dataset.v); } }
    else if (e.key === 'Escape') { e.stopPropagation(); ouvrir(false); btn.focus(); }
  };
  document.addEventListener('click', e => { if (!box.contains(e.target) && !menu.hidden) ouvrir(false); });
  affiche();
  if (cache.value.startsWith('eleven:')) charger();
}

/** Active les champs riches (mots, voix) d'un formulaire rendu par formulaire(). */
export function bindRiches(root) {
  $$('[data-tags]', root).forEach(b => { if (!b._lie) { b._lie = true; bindTags(b); } });
  $$('[data-vpick]', root).forEach(b => { if (!b._lie) { b._lie = true; bindVoix(b); } });
}

function selectFrom(idAttr, f, v, list) {
  return html`<select class="field" id=${idAttr} data-key=${f.key} data-type=${f.type}><option value="">${f.required ? 'Choisir…' : '—'}</option>${list.map(o => html`<option value=${o.value} selected=${String(o.value) === String(v ?? '')}>${o.label}</option>`)}</select>`;
}

export function formulaire(fields, values = {}, ctx = {}, prefix = 'f') {
  // La version de l'image suit le catalogue : la choisir est un geste avancé.
  const avance = f => f.advanced || f.key === 'IMAGE_TAG';
  const basic = fields.filter(f => !avance(f)), adv = fields.filter(avance);
  return html`<div class="formgrid">${basic.map(f => champForm(f, values[f.key], { ...ctx, values }, prefix))}</div>
    ${adv.length ? html`<details><summary class="link small">Réglages avancés (${adv.length})</summary><div class="gap"></div><div class="formgrid">${adv.map(f => champForm(f, values[f.key], { ...ctx, values }, prefix))}</div></details>` : ''}`;
}

export function readForm(root, { keepEmpty = false } = {}) {
  const out = {};
  for (const el of $$('[data-key]', root)) {
    if (el.closest('[data-show-if]')?.hidden) continue;   // masqué : ni affiché ni envoyé
    const k = el.dataset.key, t = el.dataset.type;
    let v;
    if (t === 'boolean') v = el.checked;
    else if (t === 'multiselect') v = [...el.selectedOptions].map(o => o.value);
    else if (t === 'number' || t === 'integer') v = el.value === '' ? '' : (/^\{\{/.test(el.value) ? el.value : Number(el.value));
    else if (t === 'json') {
      if (el.value.trim() === '') v = '';
      else { try { v = JSON.parse(el.value); } catch { throw new Error(`« ${el.closest('.fl')?.querySelector('label')?.textContent || k} » : JSON invalide`); } }
    } else v = el.value;
    if (!keepEmpty && v === '' && t !== 'secret') continue;
    out[k] = v;
  }
  return out;
}

// Affiche ou masque les champs à condition (showIf) selon les valeurs
// courantes du formulaire, et suit chaque changement.
export function bindConditions(root) {
  const blocs = $$('[data-show-if]', root);
  if (!blocs.length || root.dataset.conditions) return;
  root.dataset.conditions = '1';
  const valeur = cle => {
    const el = [...root.querySelectorAll('[data-key]')].find(x => x.dataset.key === cle);
    if (!el) return '';
    return el.dataset.type === 'boolean' ? String(el.checked) : String(el.value ?? '');
  };
  const maj = () => {
    for (const b of blocs) {
      let regle = {};
      try { regle = JSON.parse(b.dataset.showIf); } catch { /* règle illisible : champ visible */ }
      b.hidden = !Object.entries(regle).every(([cle, vals]) => (vals || []).map(String).includes(valeur(cle)));
    }
  };
  root.addEventListener('change', maj);
  root.addEventListener('input', maj);
  maj();
}

/**
 * Charge les options dynamiques d'un champ (optionsFrom) depuis le service.
 * @param cible  { instanceId } pour interroger un service installé, ou
 *               { extId } avant l'installation — auquel cas seules les
 *               listes hébergées par un autre service répondent.
 */
export function bindDynamic(root, cible, kind, ref) {
  bindRiches(root);
  bindConditions(root);
  const par = typeof cible === 'string' ? { instanceId: cible } : (cible || {});
  const url = par.extId ? `/api/catalog/${encodeURIComponent(par.extId)}/options` : `/api/instances/${encodeURIComponent(par.instanceId)}/options`;
  const champ = key => [...root.querySelectorAll('[data-key]')].find(x => x.dataset.key === key);
  // La liste n'a pas pu venir du service : on le dit dans le choix lui-même,
  // au lieu de laisser la valeur par défaut passer pour une valeur vérifiée.
  const indisponible = (target, pourquoi) => {
    if (target?.tagName !== 'SELECT' || target.querySelector('option[data-indispo]')) return;
    for (const o of target.options) if (o.value && !o.dataset.verifie) o.textContent = `${o.value} (non vérifié)`;
    target.append(element(html`<option disabled data-indispo>${pourquoi}</option>`));
  };
  const load = async (key, target) => {
    try {
      // Avant l'installation, seule la clé du champ compte : le catalogue n'a ni déclencheur ni action.
      const list = await POST(url, par.extId ? { key } : { kind, ref, key });
      if (!list.length) { indisponible(target, 'Liste vide : aucun service ne la fournit pour l’instant'); return; }
      let sel = target;
      if (target.tagName !== 'SELECT') {
        sel = element(html`<select class="field" data-key=${key} data-type="select"><option value=${target.value}>${target.value || '—'}</option></select>`);
        target.replaceWith(sel);
      }
      const cur = [...sel.selectedOptions].map(o => o.value);
      const keep = [...sel.options].filter(o => !list.some(x => String(x.value) === o.value));
      for (const o of keep) if (o.value) o.textContent = `${o.value} (absent de la liste)`;
      sel.replaceChildren(...keep, rendre(list.map(o => html`<option value=${o.value} data-verifie="1" selected=${cur.includes(String(o.value))}>${o.label}</option>`)));
    } catch (e) { indisponible(target, `Liste indisponible : ${String(e.message || e).slice(0, 80)}`); }
  };
  $$('select[data-dyn]', root).forEach(s => load(s.dataset.key, s));
  $$('[data-load]', root).forEach(b => { b.onclick = () => { load(b.dataset.load, champ(b.dataset.load)); b.remove(); }; });
}

export function sparkSvg(vals, tone = 'accent') {
  if (!vals.length) vals = [0, 0];
  if (vals.length === 1) vals = [vals[0], vals[0]];
  const W = 300, H = 46, max = Math.max(...vals, 1), min = Math.min(...vals, 0);
  const pts = vals.map((v, i) => [i / (vals.length - 1) * W, H - 4 - (v - min) / (max - min || 1) * (H - 14)]);
  const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  const col = tone === 'plain' ? 'var(--faint)' : tone === 'alarm' ? 'var(--alarm)' : 'var(--accent)';
  const gid = 'g' + Math.random().toString(36).slice(2, 7);
  return html`<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id=${gid} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color=${col} stop-opacity=".16"/><stop offset="1" stop-color=${col} stop-opacity="0"/></linearGradient></defs><path d="${d} L${W},${H} L0,${H}Z" fill="url(#${gid})"/><path d=${d} fill="none" stroke=${col} stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`;
}

const ETATS = { online: ['', 'en ligne'], offline: ['held', 'injoignable'], installing: ['busy', 'installation'] };
export const statusTag = s => { const [c, t] = ETATS[s] || ['idle', 'inconnu']; return html`<span class="tag ${c}"><span class="d"></span>${t}</span>`; };

const EXECUTIONS = { success: ['', 'réussi'], error: ['held', 'échec'], running: ['busy', 'en cours'], waiting: ['warn', 'en attente'] };
export const exTag = s => { const [c, t] = EXECUTIONS[s] || ['idle', s || '—']; return html`<span class="tag ${c}"><span class="d"></span>${t}</span>`; };

export const originChip = o => (o === 'Auto' ? html`<span class="chip a">${I('auto', 12)}auto</span>` : o === 'IA' ? html`<span class="chip ink">${I('sparkle', 12)}IA</span>` : html`<span class="chip">${I('user', 12)}manuel</span>`);
