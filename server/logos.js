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
    for (const f of fs.readdirSync(dir)) if (!f.endsWith('.png')) fs.rmSync(path.join(dir, f), { force: true });
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

  oublier(id) { try { fs.unlinkSync(this.fichier(id)); } catch { /* */ } this.echecs.delete(id); }
}
