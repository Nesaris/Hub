// Les listes déroulantes du Hub, en plus lisible que celles du système.
//
// Le <select> d'origine reste en place, caché : c'est toujours lui qui porte
// la valeur. Les formulaires le lisent, le remplissent (options, .value),
// écoutent son « change » — rien de tout cela n'a besoin de savoir qu'un menu
// le remplace à l'écran. Ce module suit ses changements et les reflète.
//
// Couvre tous les formulaires : ceux des extensions (SYNAPSE, MapMyLAN, VOX…),
// les réglages, l'éditeur de workflows. Un <select data-natif> reste natif.
import { I } from './icons.js';
import { html, poser } from '/socle/gabarit.js';

const VALEUR = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
const INDEX = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
const RECHERCHE_DES = 9;          // au-delà de ce nombre d'options, un champ de recherche
let ouvert = null;                // le menu affiché, un seul à la fois
let seq = 0;

/* « small — le bon compromis sur CPU » : le nom, puis la précision. */
function decoupe(o) {
  const t = (o.label || o.textContent || '').trim();
  if (o.dataset.detail) return [t, o.dataset.detail];
  const m = t.match(/^(.{2,40}?)\s+[—–]\s+(.+)$/) || t.match(/^(.{2,40}?)\s+\(([^)]+)\)$/);
  return m ? [m[1], m[2]] : [t, ''];
}
const vide = o => !o || o.value === '' || /^(—|-|choisir…?|aucun(e)?)$/i.test((o.textContent || '').trim());

function ameliorer(sel) {
  if (sel.dataset.csel || sel.hasAttribute('data-natif') || !sel.isConnected) return;
  sel.dataset.csel = '1';
  const multi = sel.multiple;
  const id = 'csel' + (++seq);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `${sel.className} csel-btn`.replace(/\bfield\b/, 'field');
  if (sel.style.cssText) btn.style.cssText = sel.style.cssText;
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-controls', id);
  if (sel.id) { btn.dataset.pour = sel.id; }
  sel.after(btn);
  sel.classList.add('csel-cache');
  sel.tabIndex = -1;
  sel.setAttribute('aria-hidden', 'true');

  // Un <label for> vise le select caché : il ouvre le menu à la place.
  if (sel.id) document.querySelectorAll(`label[for="${CSS.escape(sel.id)}"]`).forEach(l => l.addEventListener('click', e => { e.preventDefault(); btn.focus(); }));

  const maj = () => {
    btn.disabled = sel.disabled;
    const choisies = [...sel.options].filter(o => o.selected);
    if (multi) {
      const noms = choisies.map(o => decoupe(o)[0]);
      poser(btn, html`<span class="csel-txt ${noms.length ? '' : 'vide'}"><b>${noms.length ? noms.slice(0, 3).join(', ') + (noms.length > 3 ? ` +${noms.length - 3}` : '') : 'Aucun'}</b></span>${I('chev', 14)}`);
    } else {
      const o = choisies[0] || sel.options[sel.selectedIndex];
      const [nom, detail] = o ? decoupe(o) : ['—', ''];
      poser(btn, html`<span class="csel-txt ${vide(o) ? 'vide' : ''}"><b>${nom || '—'}</b>${detail ? html`<small>${detail}</small>` : ''}</span>${I('chev', 14)}`);
    }
    if (ouvert?.sel === sel) dessiner();
  };

  // .value et .selectedIndex posés par le code : le bouton suit.
  Object.defineProperty(sel, 'value', { configurable: true, get() { return VALEUR.get.call(sel); }, set(v) { VALEUR.set.call(sel, v); maj(); } });
  Object.defineProperty(sel, 'selectedIndex', { configurable: true, get() { return INDEX.get.call(sel); }, set(v) { INDEX.set.call(sel, v); maj(); } });
  new MutationObserver(maj).observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'selected', 'label'] });
  sel.addEventListener('change', maj);

  const menu = document.createElement('div');
  menu.className = 'csel-menu';
  menu.id = id;
  menu.setAttribute('role', 'listbox');
  if (multi) menu.setAttribute('aria-multiselectable', 'true');
  let filtre = '';

  function dessiner() {
    const f = filtre.toLowerCase();
    const ligne = o => {
      const [nom, detail] = decoupe(o);
      if (f && !`${nom} ${detail} ${o.value}`.toLowerCase().includes(f)) return null;
      return html`<div class="csel-opt ${o.selected ? 'on' : ''} ${o.disabled ? 'off' : ''} ${vide(o) ? 'vide' : ''}" role="option" tabindex="-1"
        aria-selected=${String(o.selected)} aria-disabled=${o.disabled ? 'true' : null} data-i=${o.index}>
        ${multi ? html`<span class="csel-case">${o.selected ? I('check', 12) : ''}</span>` : ''}
        <span class="grow"><b>${nom || '—'}</b>${detail ? html`<small>${detail}</small>` : ''}</span>
        ${!multi && o.selected ? I('check', 14) : ''}</div>`;
    };
    const lignes = [];
    for (const enfant of sel.children) {
      if (enfant.tagName === 'OPTGROUP') {
        const l = [...enfant.children].map(ligne).filter(Boolean);
        if (l.length) lignes.push(html`<div class="csel-titre">${enfant.label}</div>`, ...l);
      } else { const l = ligne(enfant); if (l) lignes.push(l); }
    }
    const garde = menu.querySelector('.csel-cherche input');
    const pos = garde ? [garde.selectionStart, garde.selectionEnd] : null;
    poser(menu, sel.options.length > RECHERCHE_DES ? html`<div class="csel-cherche">${I('search', 13)}<input type="text" placeholder="Rechercher…" aria-label="Rechercher" value=${filtre} spellcheck="false" autocomplete="off"></div>` : '',
      html`<div class="csel-liste">${lignes.length ? lignes : html`<div class="csel-rien">Aucun résultat</div>`}</div>`);
    const cherche = menu.querySelector('.csel-cherche input');
    if (cherche) {
      cherche.oninput = () => { filtre = cherche.value; dessiner(); };
      if (pos) { cherche.focus(); cherche.setSelectionRange(...pos); }
    }
  }

  function placer() {
    if (!btn.isConnected) { fermerCe(); return; }
    const r = btn.getBoundingClientRect();
    const bas = innerHeight - r.bottom - 12, haut = r.top - 12;
    const enHaut = bas < 240 && haut > bas;
    const largeur = Math.max(r.width, 220);
    menu.style.width = largeur + 'px';
    menu.style.left = Math.max(8, Math.min(r.left, innerWidth - largeur - 8)) + 'px';
    menu.style.maxHeight = Math.max(160, Math.min(380, enHaut ? haut : bas)) + 'px';
    if (enHaut) { menu.style.top = ''; menu.style.bottom = (innerHeight - r.top + 6) + 'px'; }
    else { menu.style.bottom = ''; menu.style.top = (r.bottom + 6) + 'px'; }
    menu.classList.toggle('haut', enHaut);
  }

  function ouvrir() {
    if (btn.disabled) return;
    ouvert?.fermer();
    filtre = '';
    dessiner();
    document.body.appendChild(menu);
    placer();
    btn.setAttribute('aria-expanded', 'true');
    btn.classList.add('ouvert');
    ouvert = { sel, fermer: fermerCe, placer, dessiner };
    const cible = menu.querySelector('.csel-cherche input') || menu.querySelector('.csel-opt.on:not(.off)') || menu.querySelector('.csel-opt:not(.off)');
    menu.querySelector('.csel-opt.on')?.scrollIntoView({ block: 'nearest' });
    cible?.focus();
  }
  function fermerCe(rendre = false) {
    if (ouvert?.sel !== sel) return;
    menu.remove();
    ouvert = null;
    btn.setAttribute('aria-expanded', 'false');
    btn.classList.remove('ouvert');
    if (rendre) btn.focus();
  }
  function choisir(i) {
    const o = sel.options[i];
    if (!o || o.disabled) return;
    if (multi) o.selected = !o.selected;
    else VALEUR.set.call(sel, o.value);
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    maj();
    if (!multi) fermerCe(true);
    else menu.querySelector(`[data-i="${i}"]`)?.focus();
  }

  btn.addEventListener('click', () => (ouvert?.sel === sel ? fermerCe() : ouvrir()));
  btn.addEventListener('keydown', e => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); ouvrir(); }
    else if (e.key === 'Escape' && ouvert?.sel === sel) { e.stopPropagation(); fermerCe(true); }
  });
  menu.addEventListener('mousedown', e => { if (!e.target.closest('input')) e.preventDefault(); });
  menu.addEventListener('click', e => { const o = e.target.closest('.csel-opt'); if (o) choisir(Number(o.dataset.i)); });
  let tape = '', tapeT = 0;
  menu.addEventListener('keydown', e => {
    const items = [...menu.querySelectorAll('.csel-opt:not(.off)')];
    const i = items.indexOf(document.activeElement);
    const dansRecherche = e.target.tagName === 'INPUT';
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = dansRecherche ? (e.key === 'ArrowDown' ? 0 : items.length - 1) : Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
      items[n]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') { if (!dansRecherche) { e.preventDefault(); items[e.key === 'Home' ? 0 : items.length - 1]?.focus(); } }
    else if (e.key === 'Enter' || (e.key === ' ' && !dansRecherche)) {
      e.preventDefault();
      const cible = dansRecherche ? items[0] : items[i];
      if (cible) choisir(Number(cible.dataset.i));
    } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fermerCe(true); }
    else if (e.key === 'Tab') fermerCe();
    else if (!dansRecherche && e.key.length === 1 && /\S/.test(e.key)) {
      // Taper les premières lettres saute à l'option.
      tape = Date.now() - tapeT > 700 ? e.key : tape + e.key; tapeT = Date.now();
      const t = items.find(x => x.textContent.trim().toLowerCase().startsWith(tape.toLowerCase()));
      t?.focus();
    }
  });
  maj();
}

function parcourir(racine) {
  if (racine.nodeType !== 1) return;
  if (racine.matches?.('select.field')) ameliorer(racine);
  racine.querySelectorAll?.('select.field').forEach(ameliorer);
}

/** À appeler une fois : améliore les listes présentes et celles qui viendront. */
export function surveiller(racine = document.body) {
  parcourir(racine);
  new MutationObserver(ms => { for (const m of ms) m.addedNodes.forEach(parcourir); }).observe(racine, { childList: true, subtree: true });
  // Cliquer ailleurs ferme ; défiler ou redimensionner replace le menu.
  document.addEventListener('mousedown', e => {
    if (!ouvert) return;
    if (e.target.closest?.('.csel-menu') || e.target.closest?.('.csel-btn') === ouvert.sel.nextElementSibling) return;
    ouvert.fermer();
  }, true);
  addEventListener('resize', () => ouvert?.placer());
  document.addEventListener('scroll', e => { if (ouvert && !e.target.closest?.('.csel-menu')) ouvert.placer(); }, true);
}
