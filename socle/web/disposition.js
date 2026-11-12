// Où se tient le menu : à gauche, en haut, en bas ou à droite.
//
// La page arrive avec la disposition du service (data-disposition-defaut,
// posée par le Hub via SOCLE_DISPOSITION) et, déjà appliqué avant le premier
// rendu, le choix de la personne s'il y en a un (data-disposition). Ce choix
// vit dans le navigateur, par application : on le change dans les réglages
// (controleDisposition) ou d'un geste, appui long sur le menu puis glisser
// vers un bord. « Par défaut » efface le choix et rend celle du service.

export const DISPOSITIONS = ['gauche', 'haut', 'bas', 'droite'];
export const LIBELLES_DISPOSITION = { gauche: 'À gauche', haut: 'En haut', bas: 'En bas', droite: 'À droite' };
const CLE = 'socle.disposition';
const APPUI_MS = 450;
const BOUGE_PX = 8;

const racine = () => document.documentElement;
const valide = d => DISPOSITIONS.includes(d);
const ecouteurs = new Set();

function lirePersonnel() {
  try { const d = localStorage.getItem(CLE); return valide(d) ? d : null; } catch { return null; }
}
function ecrirePersonnel(d) {
  try { if (d) localStorage.setItem(CLE, d); else localStorage.removeItem(CLE); } catch { /* navigation privée : le choix vaut pour la page */ }
}

/** Celle du service (le Hub ou SOCLE_DISPOSITION). */
export function dispositionParDefaut() {
  const d = racine().getAttribute('data-disposition-defaut');
  return valide(d) ? d : 'gauche';
}
/** Le choix de la personne, ou null quand elle suit celle du service. */
export const choixPersonnel = () => lirePersonnel();
export function dispositionActuelle() {
  const d = racine().getAttribute('data-disposition');
  return valide(d) ? d : 'gauche';
}

function appliquer(d) {
  if (racine().getAttribute('data-disposition') !== d) racine().setAttribute('data-disposition', d);
  for (const f of ecouteurs) { try { f(d); } catch { /* un écouteur fautif ne bloque pas les autres */ } }
}

/** Choisit une disposition pour cette personne ; null revient à celle du service. */
export function choisirDisposition(d) {
  ecrirePersonnel(valide(d) ? d : null);
  appliquer(lirePersonnel() || dispositionParDefaut());
}

/** Appelé à chaque changement (réglages, geste, autre onglet). Renvoie de quoi se désabonner. */
export function surDisposition(f) { ecouteurs.add(f); return () => ecouteurs.delete(f); }

let installe = false;
const avecGeste = new WeakSet();
/**
 * À appeler une fois au démarrage de l'interface. `rail` : l'élément du menu
 * (nav.rail par défaut). Sans rail, seul le choix est appliqué.
 */
export function installerDisposition({ rail = document.querySelector('nav.rail'), bouton = true, nomDefaut = 'Par défaut' } = {}) {
  appliquer(lirePersonnel() || dispositionParDefaut());
  if (!installe) {
    installe = true;
    addEventListener('storage', e => { if (e.key === CLE) appliquer(lirePersonnel() || dispositionParDefaut()); });
  }
  // Une interface qui reconstruit son cadre (changement de langue) rappelle
  // l'installation : le nouveau menu reçoit le geste, une seule fois.
  if (!rail) return;
  if (!avecGeste.has(rail)) { avecGeste.add(rail); gesteDeplacer(rail); }
  // Le choix à portée de main, à côté de la bascule clair ou sombre de la barre du haut.
  const voisin = bouton && document.querySelector('.top .bascule-theme, .topright .bascule-theme');
  if (voisin && !document.querySelector('.bouton-disposition')) voisin.after(boutonDisposition({ nomDefaut }));
}

/** Un bouton qui ouvre le choix de la position du menu (petite fenêtre ancrée). */
export function boutonDisposition({ nomDefaut = 'Par défaut' } = {}) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ghost bouton-disposition';
  b.title = 'Position du menu';
  b.setAttribute('aria-label', 'Position du menu');
  b.setAttribute('aria-haspopup', 'true');
  b.setAttribute('aria-expanded', 'false');
  const peindre = () => b.replaceChildren(schemaDisposition(dispositionActuelle()));
  peindre();
  surDisposition(peindre);
  let fenetre = null;
  const fermer = () => {
    if (!fenetre) return;
    fenetre.remove();
    fenetre = null;
    b.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', dehors, true);
    document.removeEventListener('keydown', echap, true);
  };
  const dehors = e => { if (fenetre && !fenetre.contains(e.target) && !b.contains(e.target)) fermer(); };
  const echap = e => { if (e.key === 'Escape') { fermer(); b.focus(); } };
  b.addEventListener('click', () => {
    if (fenetre) return fermer();
    fenetre = document.createElement('div');
    fenetre.className = 'fenetre-disposition';
    const titre = document.createElement('b');
    titre.textContent = 'Position du menu';
    const aide = document.createElement('small');
    aide.textContent = 'Ou appui long sur le menu, puis glisser vers un bord.';
    const choix = controleDisposition({ nomDefaut });
    choix.addEventListener('click', e => { if (e.target.closest('button')) setTimeout(fermer, 120); });
    fenetre.append(titre, choix, aide);
    document.body.append(fenetre);
    const r = b.getBoundingClientRect();
    const l = Math.min(Math.max(8, r.right - fenetre.offsetWidth), innerWidth - fenetre.offsetWidth - 8);
    const haut = r.bottom + 8 + fenetre.offsetHeight > innerHeight ? Math.max(8, r.top - 8 - fenetre.offsetHeight) : r.bottom + 8;
    fenetre.style.left = `${l}px`;
    fenetre.style.top = `${haut}px`;
    b.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', dehors, true);
    document.addEventListener('keydown', echap, true);
    fenetre.querySelector('[aria-checked="true"]')?.focus();
  });
  return b;
}

/* Appui long sur le menu (souris, doigt ou stylet), puis glisser : les quatre
   bords s'allument, le plus proche du pointeur est visé, on lâche pour poser.
   Échap ou un geste interrompu annule. Un déplacement avant la fin de l'appui
   (faire défiler la barre) n'est pas un appui long. */
function gesteDeplacer(rail) {
  let minuteur = null;
  let depart = null;
  let actif = false;
  let voile = null;
  let vise = null;
  let avaleClic = false;

  const desarmer = () => {
    clearTimeout(minuteur);
    minuteur = null;
    rail.classList.remove('disposition-arme');
  };

  rail.addEventListener('pointerdown', e => {
    if (actif || (e.pointerType === 'mouse' && e.button !== 0)) return;
    depart = { x: e.clientX, y: e.clientY, id: e.pointerId };
    rail.classList.add('disposition-arme');
    minuteur = setTimeout(commencer, APPUI_MS);
  });
  rail.addEventListener('pointermove', e => {
    if (minuteur && depart && Math.hypot(e.clientX - depart.x, e.clientY - depart.y) > BOUGE_PX) desarmer();
  });
  for (const t of ['pointerup', 'pointercancel', 'pointerleave']) rail.addEventListener(t, () => { if (minuteur) desarmer(); });
  // Le menu contextuel du système (appui long sur un lien) ne recouvre pas le geste.
  rail.addEventListener('contextmenu', e => { if (minuteur || actif) e.preventDefault(); });
  // Le bouton sous le doigt au moment de lâcher n'est pas un clic.
  rail.addEventListener('click', e => {
    if (!avaleClic) return;
    avaleClic = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);
  // Pendant le geste, la page ne défile pas sous le doigt.
  document.addEventListener('touchmove', e => { if (actif) e.preventDefault(); }, { passive: false });

  function commencer() {
    minuteur = null;
    rail.classList.remove('disposition-arme');
    actif = true;
    avaleClic = true;
    try { navigator.vibrate?.(12); } catch { /* pas de vibreur */ }
    try { rail.setPointerCapture(depart.id); } catch { /* le pointeur est déjà parti */ }
    voile = document.createElement('div');
    voile.className = 'disposition-glisser';
    voile.setAttribute('aria-hidden', 'true');
    for (const d of DISPOSITIONS) {
      const z = document.createElement('div');
      z.className = 'zone';
      z.dataset.d = d;
      const s = document.createElement('span');
      s.textContent = LIBELLES_DISPOSITION[d];
      z.append(s);
      voile.append(z);
    }
    const aide = document.createElement('div');
    aide.className = 'aide';
    aide.textContent = 'Glisse le menu vers un bord, puis lâche. Échap pour annuler.';
    const fantome = document.createElement('div');
    fantome.className = 'fantome';
    fantome.textContent = 'Menu';
    voile.append(aide, fantome);
    document.body.append(voile);
    racine().classList.add('disposition-en-cours');
    viser(depart.x, depart.y);
    document.addEventListener('pointermove', bouger);
    document.addEventListener('pointerup', lacher);
    document.addEventListener('pointercancel', annuler);
    document.addEventListener('keydown', echap);
  }

  function viser(x, y) {
    const W = innerWidth || 1;
    const H = innerHeight || 1;
    const distances = { gauche: x / W, droite: (W - x) / W, haut: y / H, bas: (H - y) / H };
    vise = DISPOSITIONS.reduce((a, b) => (distances[b] < distances[a] ? b : a));
    for (const z of voile.querySelectorAll('.zone')) z.classList.toggle('vise', z.dataset.d === vise);
    const f = voile.querySelector('.fantome');
    f.style.left = `${x}px`;
    f.style.top = `${y}px`;
  }
  const bouger = e => { if (actif) viser(e.clientX, e.clientY); };
  const lacher = () => finir(vise);
  const annuler = () => finir(null);
  const echap = e => { if (e.key === 'Escape') { e.preventDefault(); finir(null); } };

  function finir(d) {
    if (!actif) return;
    actif = false;
    document.removeEventListener('pointermove', bouger);
    document.removeEventListener('pointerup', lacher);
    document.removeEventListener('pointercancel', annuler);
    document.removeEventListener('keydown', echap);
    racine().classList.remove('disposition-en-cours');
    voile?.remove();
    voile = null;
    if (d) choisirDisposition(d);
    // Le clic qui suit le lâcher est avalé ; s'il ne vient pas, on n'avale pas le suivant.
    setTimeout(() => { avaleClic = false; }, 400);
  }
}

// Un schéma par position : l'écran, et le menu en plein (construit nœud par nœud, sans balisage).
const BARRES = {
  gauche: [[3, 3, 8, 20]], haut: [[3, 3, 30, 6]], bas: [[3, 17, 30, 6]], droite: [[25, 3, 8, 20]],
  defaut: [[3, 3, 8, 20, 0.35], [3, 3, 30, 6, 0.35]],
};
const SVG = 'http://www.w3.org/2000/svg';
function noeud(nom, attributs) {
  const n = document.createElementNS(SVG, nom);
  for (const [k, v] of Object.entries(attributs)) n.setAttribute(k, String(v));
  return n;
}
export function schemaDisposition(d) {
  const s = noeud('svg', { width: 36, height: 26, viewBox: '0 0 36 26', 'aria-hidden': 'true' });
  s.append(noeud('rect', { x: 0.75, y: 0.75, width: 34.5, height: 24.5, rx: 5, fill: 'none', stroke: 'currentColor', 'stroke-opacity': 0.45, 'stroke-width': 1.5 }));
  const g = noeud('g', { fill: 'currentColor', 'fill-opacity': 0.55 });
  for (const [x, y, w, h, o] of BARRES[d] || BARRES.gauche) g.append(noeud('rect', { class: 'barre', x, y, width: w, height: h, rx: 2, ...(o ? { opacity: o } : {}) }));
  s.append(g);
  return s;
}

/**
 * Le choix pour les réglages de l'application : « Par défaut » (celle du
 * service) puis les quatre positions. `nomDefaut` : comment appeler la valeur
 * du service (« Celle du Hub »).
 */
export function controleDisposition({ nomDefaut = 'Par défaut' } = {}) {
  const el = document.createElement('div');
  el.className = 'choix-disposition';
  el.setAttribute('role', 'radiogroup');
  el.setAttribute('aria-label', 'Position du menu');
  const options = [['', `${nomDefaut} (${LIBELLES_DISPOSITION[dispositionParDefaut()].toLowerCase()})`, 'defaut'], ...DISPOSITIONS.map(d => [d, LIBELLES_DISPOSITION[d], d])];
  for (const [valeur, libelle, dessin] of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.disposition = valeur;
    b.title = libelle;
    b.append(schemaDisposition(dessin));
    const s = document.createElement('span');
    s.textContent = libelle;
    b.append(s);
    b.addEventListener('click', () => choisirDisposition(valeur || null));
    el.append(b);
  }
  const marquer = () => {
    const perso = lirePersonnel() || '';
    for (const b of el.children) b.setAttribute('aria-checked', String(b.dataset.disposition === perso));
  };
  marquer();
  // Un contrôle retiré de la page (réglages refaits) cesse d'écouter au changement suivant.
  const fin = surDisposition(() => { if (el.isConnected) marquer(); else fin(); });
  return el;
}
