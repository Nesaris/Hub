// Ré-encodage des images venues d'ailleurs (SEC-FILE-001, SEC-FILE-007) : un
// PNG est décodé pixel par pixel puis réécrit par le Hub, en RGBA 8 bits, sans
// aucun bloc annexe. Ce qui est servi a été produit ici : ni métadonnées, ni
// charge glissée après l'image, ni bloc qu'un décodeur interpréterait. Une
// icône ICO n'est acceptée que si elle embarque un PNG. Le reste est refusé,
// et l'interface affiche un monogramme.
import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const COTE_MAX = 512;
const CANAUX = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const TABLE = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function refus(raison) { throw new Error(`image refusée : ${raison}`); }

function blocs(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) refus('pas un PNG');
  const out = [];
  for (let i = 8; i < buf.length;) {
    if (i + 12 > buf.length) refus('bloc tronqué');
    const n = buf.readUInt32BE(i), type = buf.toString('latin1', i + 4, i + 8);
    if (i + 12 + n > buf.length) refus('bloc tronqué');
    const donnees = buf.subarray(i + 8, i + 8 + n);
    if (crc32(buf.subarray(i + 4, i + 8 + n)) !== buf.readUInt32BE(i + 8 + n)) refus(`somme de contrôle fausse (${type})`);
    out.push({ type, donnees });
    i += 12 + n;
    if (type === 'IEND') break;
  }
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Décode un PNG (8 bits, non entrelacé) en pixels RGBA. */
export function decoderPng(buf) {
  const liste = blocs(buf);
  const ihdr = liste[0]?.type === 'IHDR' ? liste[0].donnees : refus('en-tête absent');
  const largeur = ihdr.readUInt32BE(0), hauteur = ihdr.readUInt32BE(4);
  const profondeur = ihdr[8], couleur = ihdr[9], entrelace = ihdr[12];
  if (!largeur || !hauteur || largeur > COTE_MAX || hauteur > COTE_MAX) refus(`dimensions ${largeur}×${hauteur} (au plus ${COTE_MAX})`);
  if (profondeur !== 8 || !(couleur in CANAUX) || entrelace !== 0 || ihdr[10] !== 0 || ihdr[11] !== 0) refus('format non pris en charge');
  const bpp = CANAUX[couleur], ligne = largeur * bpp, attendu = hauteur * (ligne + 1);
  const palette = liste.find(b => b.type === 'PLTE')?.donnees;
  const transparence = liste.find(b => b.type === 'tRNS')?.donnees;
  if (couleur === 3 && !palette) refus('palette absente');
  let brut;
  // La taille décompressée est bornée à ce que l'image annonce : pas de bombe.
  try { brut = zlib.inflateSync(Buffer.concat(liste.filter(b => b.type === 'IDAT').map(b => b.donnees)), { maxOutputLength: attendu }); }
  catch { refus('données compressées invalides ou trop grandes'); }
  if (brut.length !== attendu) refus('données de taille inattendue');
  const px = Buffer.alloc(hauteur * ligne);
  for (let y = 0; y < hauteur; y++) {
    const filtre = brut[y * (ligne + 1)];
    for (let x = 0; x < ligne; x++) {
      const v = brut[y * (ligne + 1) + 1 + x];
      const a = x >= bpp ? px[y * ligne + x - bpp] : 0, b = y ? px[(y - 1) * ligne + x] : 0, c = x >= bpp && y ? px[(y - 1) * ligne + x - bpp] : 0;
      const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filtre];
      if (pred === undefined) refus('filtre inconnu');
      px[y * ligne + x] = (v + pred) & 0xff;
    }
  }
  const rgba = Buffer.alloc(largeur * hauteur * 4);
  for (let i = 0; i < largeur * hauteur; i++) {
    const s = px.subarray(i * bpp, i * bpp + bpp), d = i * 4;
    if (couleur === 6) s.copy(rgba, d);
    else if (couleur === 2) { s.copy(rgba, d); rgba[d + 3] = 255; }
    else if (couleur === 0) { rgba.fill(s[0], d, d + 3); rgba[d + 3] = 255; }
    else if (couleur === 4) { rgba.fill(s[0], d, d + 3); rgba[d + 3] = s[1]; }
    else {
      if (s[0] * 3 + 3 > palette.length) refus('index hors de la palette');
      palette.copy(rgba, d, s[0] * 3, s[0] * 3 + 3);
      rgba[d + 3] = transparence && s[0] < transparence.length ? transparence[s[0]] : 255;
    }
  }
  return { largeur, hauteur, rgba };
}

function bloc(type, donnees) {
  const tete = Buffer.alloc(8);
  tete.writeUInt32BE(donnees.length, 0);
  tete.write(type, 4, 'latin1');
  const fin = Buffer.alloc(4);
  fin.writeUInt32BE(crc32(Buffer.concat([tete.subarray(4), donnees])), 0);
  return Buffer.concat([tete, donnees, fin]);
}

/** Réécrit des pixels RGBA en un PNG minimal : IHDR, IDAT, IEND. */
export function encoderPng({ largeur, hauteur, rgba }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(largeur, 0); ihdr.writeUInt32BE(hauteur, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const lignes = Buffer.alloc(hauteur * (largeur * 4 + 1));
  for (let y = 0; y < hauteur; y++) rgba.copy(lignes, y * (largeur * 4 + 1) + 1, y * largeur * 4, (y + 1) * largeur * 4);
  return Buffer.concat([SIGNATURE, bloc('IHDR', ihdr), bloc('IDAT', zlib.deflateSync(lignes)), bloc('IEND', Buffer.alloc(0))]);
}

/** Une icône ICO : le plus grand PNG qu'elle embarque. */
function pngDansIco(buf) {
  if (buf.length < 6 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) refus('pas une icône');
  const n = Math.min(buf.readUInt16LE(4), 32);
  let meilleur = null;
  for (let i = 0; i < n; i++) {
    const e = 6 + i * 16;
    if (e + 16 > buf.length) break;
    const taille = buf.readUInt32LE(e + 8), debut = buf.readUInt32LE(e + 12);
    if (debut + taille > buf.length) continue;
    const img = buf.subarray(debut, debut + taille);
    if (img.subarray(0, 8).equals(SIGNATURE) && (!meilleur || taille > meilleur.length)) meilleur = img;
  }
  return meilleur || refus('icône sans PNG');
}

/** Le PNG ré-encodé par le Hub, à partir d'un PNG ou d'une icône ICO. */
export function reencoder(buf) {
  const png = buf.subarray(0, 8).equals(SIGNATURE) ? buf : pngDansIco(buf);
  return encoderPng(decoderPng(png));
}
