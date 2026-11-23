// Logos des services, pris chez eux.
//
// Une grille de noms se lit ; une grille de logos se reconnaît d'un coup
// d'œil. Plutôt que d'embarquer des dizaines de logos de marques dans le
// dépôt, le Hub va chercher, une fois, l'icône que chaque service publie
// lui-même sur son site (celle que le navigateur affiche dans l'onglet), et la
// garde dans son dossier de données. Hors ligne ou introuvable : l'interface
// affiche un monogramme coloré, rien ne casse.
//
// Garde-fous, parce que le Hub télécharge ici quelque chose d'extérieur :
//  - HTTPS seulement, nom de domaine public seulement (pas d'IP, pas de
//    localhost) : le Hub ne sert pas de relais vers le réseau interne ;
//  - reconnus à leurs premiers octets, jamais au type annoncé, puis décodés
//    et réécrits en PNG par le Hub (image.js) : ce qui est servi n'a ni
//    métadonnées ni charge cachée. PNG, ou ICO qui embarque un PNG ; pas de
//    SVG, qui peut porter du script ;
//  - taille bornée, délai borné, un seul essai par jour en cas d'échec.
import fs from 'node:fs';
import path from 'node:path';
import { sortir } from './sortie.js';
import { reencoder } from './image.js';

const DOMAINE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/i;
const MAX_PAGE = 600_000;
const MAX_IMAGE = 300_000;
const REESSAI_MS = 86_400_000;

export function domaineValide(d) {
  const h = String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!DOMAINE.test(h) || /^(localhost|.*\.local|.*\.lan|.*\.internal|.*\.home\.arpa)$/.test(h)) return null;
  return h;
}

/** Le type réel d'une image, d'après ses premiers octets. */
export function typeImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return 'image/x-icon';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('latin1', 0, 3) === 'GIF') return 'image/gif';
  return null;
}

/**
 * Les icônes qu'une page déclare, de la plus prometteuse à la moins bonne.
 * apple-touch-icon d'abord : c'est presque toujours un PNG carré de 180 px,
 * net à toutes les tailles où on l'affiche.
 */
export function iconesDeclarees(html, base) {
  const out = [];
  for (const m of String(html).matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = (/\brel\s*=\s*["']?([^"'>]+)/i.exec(tag) || [])[1]?.toLowerCase() || '';
    if (!/\bicon\b|apple-touch-icon/.test(rel)) continue;
    const href = (/\bhref\s*=\s*["']?([^"'\s>]+)/i.exec(tag) || [])[1];
    if (!href || /\.svg(\?|$)/i.test(href) || /^data:/i.test(href)) continue;
    const taille = Number((/\bsizes\s*=\s*["']?(\d+)x/i.exec(tag) || [])[1] || 0);
    let url; try { url = new URL(href, base); } catch { continue; }
    if (url.protocol !== 'https:') continue;
    const score = (rel.includes('apple-touch-icon') ? 1000 : 0) + Math.min(taille, 512) + (/\.png(\?|$)/i.test(href) ? 50 : 0);
    out.push({ url: url.href, score });
  }
  return out.sort((a, b) => b.score - a.score).map(x => x.url);
}

/* Adresse privée, locale ou réservée : le Hub ne va pas y chercher de logo.
   Un nom public peut pointer vers 10.x ; on vérifie donc l'adresse résolue,
   à chaque saut de redirection, pas seulement le nom. */
// Le domaine est public par son nom ; l'enveloppe de sortie vérifie, en plus,
// que chaque adresse résolue l'est aussi, et épingle celle qu'elle a jugée.
function sur(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !domaineValide(u.hostname)) throw new Error('adresse refusée');
  return u;
}

async function lire(url, max, accept) {
  let courant = url;
  for (let saut = 0; saut < 4; saut++) {
    sur(courant);
    const r = await sortir(courant, { redirect: 'manual', signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'Hub/1 (+logos)', Accept: accept } }, { confiance: 'publique', taille: max });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { courant = new URL(r.headers.get('location'), courant).href; continue; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const morceaux = []; let n = 0;
    for await (const c of r.body) { n += c.length; if (n > max) throw new Error('trop gros'); morceaux.push(c); }
    return { buf: Buffer.concat(morceaux), url: courant };
  }
  throw new Error('trop de redirections');
}

export class Logos {
  constructor({ dir, fetcher = lire }) {
    this.dir = dir; this.lire = fetcher; this.echecs = new Map(); this.enCours = new Map();
    fs.mkdirSync(dir, { recursive: true });
    // Les logos gardés tels que téléchargés, avant le ré-encodage : ils partent.
    // (Les SVG d'extensions, eux, sont écrits après leur contrôle : ils restent.)
    for (const f of fs.readdirSync(dir)) if (!f.endsWith('.png') && !/^ext-.+\.svg$/.test(f)) fs.rmSync(path.join(dir, f), { force: true });
  }

  fichier(id) { return path.join(this.dir, String(id).replace(/[^a-z0-9_-]/gi, '_') + '.png'); }

  /** Le logo en cache (un PNG écrit par le Hub), ou null. */
  enCache(id) {
    try { return { buf: fs.readFileSync(this.fichier(id)), type: 'image/png' }; }
    catch { return null; }
  }

  async obtenir(id, domaine) {
    const cache = this.enCache(id);
    if (cache) return cache;
    const d = domaineValide(domaine);
    if (!d) return null;
    if (Date.now() - (this.echecs.get(id) || 0) < REESSAI_MS) return null;
    // Deux cartes qui demandent le même logo en même temps : un seul téléchargement.
    if (!this.enCours.has(id)) this.enCours.set(id, this.telecharger(id, d).finally(() => this.enCours.delete(id)));
    return this.enCours.get(id);
  }

  async telecharger(id, d) {
    const essais = [];
    try {
      const page = await this.lire(`https://${d}/`, MAX_PAGE, 'text/html');
      essais.push(...iconesDeclarees(page.buf.toString('utf8'), page.url));
    } catch { /* page illisible : on tente quand même /favicon.ico */ }
    essais.push(`https://${d}/favicon.ico`);
    for (const url of [...new Set(essais)].slice(0, 5)) {
      try {
        const { buf } = await this.lire(url, MAX_IMAGE, 'image/*');
        if (!typeImage(buf)) continue;
        const png = reencoder(buf);
        fs.writeFileSync(this.fichier(id), png);
        return { buf: png, type: 'image/png' };
      } catch { /* suivant */ }
    }
    this.echecs.set(id, Date.now());
    return null;
  }

  /**
   * Le logo qu'une extension publie dans son propre dépôt : le champ « logo »
   * de son manifeste, sinon les emplacements où on les range d'habitude.
   * Un fichier par version : une nouvelle version relit son logo.
   */
  async extension(id, version, manifeste, lireFichier) {
    const base = 'ext-' + `${id}@${version}`.replace(/[^a-z0-9_.@-]/gi, '_');
    for (const ext of ['svg', 'png']) {
      try { return { buf: fs.readFileSync(path.join(this.dir, `${base}.${ext}`)), type: ext === 'svg' ? 'image/svg+xml' : 'image/png' }; } catch { /* */ }
    }
    const cle = base;
    if (Date.now() - (this.echecs.get(cle) || 0) < REESSAI_MS) return null;
    if (!this.enCours.has(cle)) this.enCours.set(cle, this.chercherExtension(id, base, manifeste, lireFichier).finally(() => this.enCours.delete(cle)));
    return this.enCours.get(cle);
  }

  async chercherExtension(id, base, manifeste, lireFichier) {
    for (const rel of cheminsLogo(id, manifeste)) {
      let buf;
      try { buf = await lireFichier(rel, MAX_IMAGE); } catch { continue; }
      if (!buf?.length || buf.length > MAX_IMAGE) continue;
      try {
        const sortie = /\.svg$/i.test(rel) ? { buf: svgPropre(buf), type: 'image/svg+xml', ext: 'svg' } : { buf: reencoder(buf), type: 'image/png', ext: 'png' };
        const prefixe = 'ext-' + String(id).replace(/[^a-z0-9_.-]/gi, '_') + '@';
        for (const f of fs.readdirSync(this.dir)) if (f.startsWith(prefixe)) fs.rmSync(path.join(this.dir, f), { force: true });
        fs.writeFileSync(path.join(this.dir, `${base}.${sortie.ext}`), sortie.buf, { mode: 0o600 });
        return { buf: sortie.buf, type: sortie.type };
      } catch { /* refusé : suivant */ }
    }
    this.echecs.set(base, Date.now());
    return null;
  }

  oublier(id) { try { fs.unlinkSync(this.fichier(id)); } catch { /* */ } this.echecs.delete(id); }
}

const CHEMIN = /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[\w./-]{1,200}\.(svg|png)$/i;
/** Où chercher le logo d'une extension, du plus sûr (déclaré) au plus probable. */
export function cheminsLogo(id, m = {}) {
  const declares = [m.logo, /\.(svg|png)$/i.test(m.icon || '') ? m.icon : null].filter(x => typeof x === 'string' && CHEMIN.test(x));
  const habituels = ['web/icone.svg', 'ui/icone.svg', 'medias/icone.svg', 'public/icone.svg', 'assets/icone.svg', 'assets/icon.svg', 'assets/logo.svg',
    `assets/logo/${id}-logo.svg`, 'web/icon.svg', 'public/icon.svg', 'icon.svg', 'logo.svg', 'web/icone-512.png', 'icon.png', 'logo.png'];
  return [...new Set([...declares, ...habituels])];
}

/*
 * Un SVG peut porter du script, appeler l'extérieur ou ouvrir des entités
 * XML. Il n'est servi qu'en <img> (où rien de tout cela ne s'exécute) et avec
 * une politique de contenu fermée ; on ne le garde, en plus, que s'il n'est
 * fait que de formes : la moindre construction suspecte le fait refuser
 * entier, on ne tente pas de le « nettoyer ».
 */
const INTERDITS = [/<script/i, /<foreignobject/i, /<(iframe|embed|object|image|a|use|animate\w*|set|feimage|audio|video|canvas|handler|listener)\b/i,
  /<!doctype/i, /<!entity/i, /<\?xml-stylesheet/i, /\son[a-z]+\s*=/i, /javascript:/i, /data:/i, /@import/i, /@font-face/i,
  /url\(\s*['"]?\s*(?!#)/i, /\b(xlink:)?href\s*=/i, /<!\[cdata\[/i, /&#/];
export function svgPropre(buf) {
  let t = buf.toString('utf8');
  if (t.includes('\uFFFD')) throw new Error('SVG illisible');
  t = t.replace(/^\uFEFF/, '').replace(/<\?xml[^>]*\?>/i, '').replace(/<!--[\s\S]*?-->/g, '').trim();
  if (!/^<svg\b[^>]*\bxmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/i.test(t) || !/<\/svg>$/i.test(t)) throw new Error('pas un SVG');
  for (const r of INTERDITS) if (r.test(t)) throw new Error('SVG refusé');
  // La variante sombre d'un logo est blanche : posée sur la tuile blanche du Hub, elle disparaîtrait.
  t = t.replace(/@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/gi, '');
  return Buffer.from(t, 'utf8');
}
