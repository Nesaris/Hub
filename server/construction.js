// Construire une image depuis les sources de son dépôt GitHub, quand aucun
// registre ne la fournit (paquets d'un compte désactivés, image jamais
// publiée). Ce que le Hub construit est borné :
//
//   - seulement une image que le Compose de l'extension nomme, et dont le
//     nom est celui de son dépôt (ghcr.io/<compte>/<dépôt>[-<cible>]) : une
//     extension ne fait jamais construire l'image d'un autre ;
//   - depuis le tag de la version (v1.0.0), ou depuis la branche lue par le
//     catalogue si sa version est celle demandée ;
//   - l'archive passe par la garde de sortie, et le Hub la réempaquette :
//     fichiers, dossiers et liens seulement, aucun chemin qui remonte.
//
// La construction passe par le proxy de socket (BUILD) avec le constructeur
// classique : il ne demande au démon que POST /build.
import zlib from 'node:zlib';
import { sortir } from './sortie.js';

const BLOC = 512;
const DEPOT_GITHUB = /^https:\/\/github\.com\/([\w.-]{1,39})\/([\w.-]{1,100}?)(?:\.git)?\/?$/i;

/** Le dépôt GitHub d'une extension : celui du catalogue, sinon celui que déclare son manifeste. */
export function depotGithub(manifest, origin) {
  if (origin?.type === 'github' && /^[\w.-]+\/[\w.-]+$/.test(origin.repo || '')) {
    const [owner, repo] = origin.repo.split('/');
    return { owner, repo, branche: origin.ref || 'main' };
  }
  const m = DEPOT_GITHUB.exec(String(manifest?.repository || ''));
  return m ? { owner: m[1], repo: m[2], branche: 'main' } : null;
}

/**
 * Ce qu'il faut construire pour une image : { cible } (null : la dernière
 * étape du Dockerfile), ou null si l'image n'appartient pas à ce dépôt.
 *   ghcr.io/codexx64/relay:2.1.2        → { cible: null }
 *   ghcr.io/codexx64/relay-caddy:2.1.2  → { cible: 'caddy' }
 *   ghcr.io/codexx64/oracle-ai:2.1.0    → { cible: null } pour le dépôt OracleAI
 */
export function cibleDeConstruction(ref, depot) {
  if (!depot) return null;
  const sansTag = String(ref).replace(/@.*$/, '').replace(/:[\w.-]+$/, '');
  const parts = sansTag.split('/');
  if (parts.length < 2) return null;
  const [owner, nom] = parts.slice(-2).map(x => x.toLowerCase());
  const repo = depot.repo.toLowerCase();
  if (owner !== depot.owner.toLowerCase()) return null;
  // Le dépôt « OracleAI » publie « oracle-ai » : même nom, aux tirets et à la casse près.
  const sansTirets = x => x.replace(/[^a-z0-9]/g, '');
  if (nom === repo || sansTirets(nom) === sansTirets(repo)) return { cible: null };
  if (nom.startsWith(repo + '-')) {
    const cible = nom.slice(repo.length + 1);
    return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(cible) ? { cible } : null;
  }
  return null;
}

// ---------- tar ----------
const lireChaine = (b, debut, long) => { const s = b.subarray(debut, debut + long); const z = s.indexOf(0); return (z < 0 ? s : s.subarray(0, z)).toString('utf8'); };
const lireOctal = (b, debut, long) => parseInt(lireChaine(b, debut, long).trim() || '0', 8) || 0;

function lirePax(donnees) {
  const out = {};
  let i = 0;
  while (i < donnees.length) {
    const espace = donnees.indexOf(0x20, i);
    if (espace < 0) break;
    const long = parseInt(donnees.subarray(i, espace).toString('ascii'), 10);
    if (!long) break;
    const enreg = donnees.subarray(espace + 1, i + long - 1).toString('utf8');
    const eg = enreg.indexOf('=');
    if (eg > 0) out[enreg.slice(0, eg)] = enreg.slice(eg + 1);
    i += long;
  }
  return out;
}

/** Les entrées d'une archive tar : { nom, type: 'fichier'|'dossier'|'lien', mode, mtime, donnees, lien }. */
export function* lireTar(tar) {
  let i = 0, pax = {}, long = null, lienLong = null;
  while (i + BLOC <= tar.length) {
    const h = tar.subarray(i, i + BLOC);
    if (h.every(o => o === 0)) break;
    const taille = lireOctal(h, 124, 12);
    const type = String.fromCharCode(h[156] || 48);
    const donnees = tar.subarray(i + BLOC, i + BLOC + taille);
    i += BLOC + Math.ceil(taille / BLOC) * BLOC;
    if (type === 'x') { pax = lirePax(donnees); continue; }
    if (type === 'g') continue;
    if (type === 'L') { long = lireChaine(donnees, 0, donnees.length); continue; }
    if (type === 'K') { lienLong = lireChaine(donnees, 0, donnees.length); continue; }
    const prefixe = lireChaine(h, 345, 155);
    const nom = pax.path || long || (prefixe ? `${prefixe}/${lireChaine(h, 0, 100)}` : lireChaine(h, 0, 100));
    const lien = pax.linkpath || lienLong || lireChaine(h, 157, 100);
    pax = {}; long = null; lienLong = null;
    const genre = type === '0' || type === '\0' || type === '7' ? 'fichier' : type === '5' ? 'dossier' : type === '2' ? 'lien' : null;
    if (!genre) continue;
    yield { nom, type: genre, mode: lireOctal(h, 100, 8) & 0o777, mtime: lireOctal(h, 136, 12), donnees: genre === 'fichier' ? donnees : null, lien };
  }
}

function entete(nom, { taille = 0, mode = 0o644, mtime = 0, type = '0', lien = '' }) {
  const h = Buffer.alloc(BLOC);
  const ecrire = (s, debut, long) => Buffer.from(s, 'utf8').copy(h, debut, 0, long);
  const octal = (n, long) => n.toString(8).padStart(long - 1, '0');
  ecrire(nom, 0, 100);
  for (const [v, debut, long] of [[mode, 100, 8], [0, 108, 8], [0, 116, 8], [taille, 124, 12], [mtime, 136, 12]]) ecrire(octal(v, long), debut, long - 1);
  h.fill(0x20, 148, 156);
  h[156] = type.charCodeAt(0);
  ecrire(lien, 157, 100);
  ecrire('ustar\u000000', 257, 8);
  let somme = 0;
  for (const o of h) somme += o;
  ecrire(somme.toString(8).padStart(6, '0') + '\u0000 ', 148, 8);
  return h;
}

function recordPax(cle, valeur) {
  const corps = ` ${cle}=${valeur}\n`;
  let long = Buffer.byteLength(corps) + 1;
  while (String(long).length + Buffer.byteLength(corps) !== long) long = String(long).length + Buffer.byteLength(corps);
  return `${long}${corps}`;
}

const remplissage = n => Buffer.alloc((BLOC - (n % BLOC)) % BLOC);

/** Une archive tar écrite de zéro : un en-tête pax quand un chemin est long ou non ASCII. */
export function ecrireTar(entrees) {
  const morceaux = [];
  for (const e of entrees) {
    const type = e.type === 'dossier' ? '5' : e.type === 'lien' ? '2' : '0';
    const nom = e.type === 'dossier' && !e.nom.endsWith('/') ? `${e.nom}/` : e.nom;
    const long = s => Buffer.byteLength(s) > 99 || /[^\x20-\x7e]/.test(s);
    if (long(nom) || (e.lien && long(e.lien))) {
      const pax = Buffer.from((long(nom) ? recordPax('path', nom) : '') + (e.lien && long(e.lien) ? recordPax('linkpath', e.lien) : ''), 'utf8');
      morceaux.push(entete('PaxHeader', { taille: pax.length, type: 'x' }), pax, remplissage(pax.length));
    }
    const donnees = e.donnees || Buffer.alloc(0);
    morceaux.push(entete(nom.slice(0, 99), { taille: donnees.length, mode: e.mode ?? (type === '5' ? 0o755 : 0o644), mtime: e.mtime || 0, type, lien: e.lien || '' }));
    if (donnees.length) morceaux.push(donnees, remplissage(donnees.length));
  }
  morceaux.push(Buffer.alloc(BLOC * 2));
  return Buffer.concat(morceaux);
}

/**
 * L'archive de GitHub (dossier de tête « compte-dépôt-sha/ ») devient un
 * contexte de construction : le dossier de tête retiré, rien qui remonte.
 */
export function reempaqueter(tgz) {
  const tar = zlib.gunzipSync(tgz, { maxOutputLength: 512 * 1048576 });
  const sorties = [];
  for (const e of lireTar(tar)) {
    const i = e.nom.indexOf('/');
    const nom = i < 0 ? '' : e.nom.slice(i + 1).replace(/\/+$/, '');
    if (!nom) continue;
    const segments = nom.split('/');
    if (nom.startsWith('/') || segments.some(s => s === '..' || s === '')) throw new Error(`chemin refusé dans l’archive : ${nom.slice(0, 120)}`);
    if (e.type === 'lien' && (e.lien.startsWith('/') || e.lien.split('/').includes('..'))) continue;
    sorties.push({ ...e, nom });
  }
  if (!sorties.some(e => e.nom === 'Dockerfile' && e.type === 'fichier')) throw new Error('aucun Dockerfile à la racine du dépôt');
  return ecrireTar(sorties);
}

/** L'archive d'une référence (refs/tags/v1.0.0, refs/heads/main), ou null si elle n'existe pas. */
export async function archiveGithub({ owner, repo }, refGit, { sortie = sortir } = {}) {
  const url = `https://codeload.github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tar.gz/${refGit.split('/').map(encodeURIComponent).join('/')}`;
  const res = await sortie(url, { headers: { 'user-agent': 'hub' } }, { taille: 128 * 1048576, delai: 180000 });
  if (res.status === 404) { await res.body?.cancel(); return null; }
  if (!res.ok) throw new Error(`archive de github.com/${owner}/${repo} impossible (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/** Les références à essayer pour une étiquette d'image, dans l'ordre. */
export function referencesPour(tag, depot, versionCatalogue) {
  const out = [];
  if (/^v?\d+\.\d+\.\d+([-.][\w.]+)?$/.test(tag)) out.push(`refs/tags/${tag.startsWith('v') ? tag : `v${tag}`}`);
  // La branche lue par le catalogue porte la version qu'il affiche : elle
  // vaut pour cette étiquette seulement si c'est la même version.
  const v = String(tag).replace(/^v/, '');
  if (versionCatalogue && v === String(versionCatalogue).replace(/^v/, '')) out.push(`refs/heads/${depot.branche}`);
  return out;
}
