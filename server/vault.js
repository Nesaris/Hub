// Coffre de secrets : AES-256-GCM. La clé maîtresse vient de HUB_CLE (secret
// Docker, hors du volume de données) ; à défaut, d'un fichier 0600 du volume,
// créé au premier démarrage. Quand HUB_CLE arrive alors que ce fichier existe
// encore, il doit porter la même clé (ou HUB_CLE_ANCIENNE, pendant une
// rotation) : il est alors retiré, et une copie du volume seule ne déchiffre
// plus rien. Une clé différente arrête le démarrage.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const cleBrute = cle => {
  const k = Buffer.from(String(cle).trim(), 'base64');
  if (k.length !== 32) throw new Error('HUB_CLE doit faire 32 octets encodés en base64.');
  return k;
};

export class Vault {
  constructor(dataDir, { cle = '', ancienne = '' } = {}) {
    // Pendant une rotation seulement : relit ce que l'ancienne clé a scellé.
    this.precedente = ancienne ? Vault.depuisCle(ancienne) : null;
    const dir = path.join(dataDir, 'keys');
    const file = path.join(dir, 'master.key');
    if (cle) {
      this.key = cleBrute(cle);
      if (this.precedente && crypto.timingSafeEqual(this.precedente.key, this.key)) throw new Error('HUB_CLE_ANCIENNE est la clé actuelle : pose la clé neuve dans HUB_CLE.');
      if (fs.existsSync(file)) {
        const duVolume = fs.readFileSync(file);
        const connue = k => duVolume.length === 32 && crypto.timingSafeEqual(duVolume, k);
        if (!connue(this.key) && !(this.precedente && connue(this.precedente.key))) throw new Error(`HUB_CLE diffère de la clé du volume (${file}) : pose la même, ou les secrets chiffrés seraient perdus.`);
        fs.rmSync(file);
      }
      return;
    }
    if (this.precedente) throw new Error('HUB_CLE_ANCIENNE sans HUB_CLE : pose la clé neuve dans HUB_CLE.');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32), { mode: 0o600 });
    this.key = fs.readFileSync(file);
    if (this.key.length !== 32) throw new Error('Clé maîtresse invalide');
  }
  static depuisCle(cle) {
    const v = Object.create(Vault.prototype);
    v.key = cleBrute(cle);
    v.precedente = null;
    return v;
  }
  // Ce qui dit, sans rien révéler de la clé, sous quelle clé la base a été écrite.
  controle() {
    return crypto.createHmac('sha256', this.key).update('hub:controle-cle').digest('hex');
  }
  seal(plain) {
    if (plain == null || plain === '') return null;
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
    return 'v1:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
  }
  open(sealed) {
    if (!sealed) return '';
    if (!String(sealed).startsWith('v1:')) throw new Error('Format de secret inconnu');
    const raw = Buffer.from(sealed.slice(3), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  }
  // Pour un objet de config : chiffre les clés listées comme secrètes.
  sealFields(obj, secretKeys) {
    const out = { ...obj };
    for (const k of secretKeys) if (out[k] != null && out[k] !== '' && !String(out[k]).startsWith('v1:')) out[k] = this.seal(out[k]);
    return out;
  }
  openFields(obj, secretKeys) {
    const out = { ...obj };
    for (const k of secretKeys) if (out[k]) out[k] = this.open(out[k]);
    return out;
  }
}

// Un scellé du coffre : « v1: » puis au moins 29 octets (IV, étiquette, un
// octet), soit 39 caractères base64 avant le remplissage. Il vit seul dans
// une cellule ou dans une chaîne JSON.
const SCELLE = /v1:[A-Za-z0-9+/]{39,}={0,2}/g;
// Journaux chaînés : jamais réécrits, et aucun scellé n'y entre.
const INTOUCHABLES = new Set(['audit', 'socle_journal', '_migrations']);

/**
 * Rotation de HUB_CLE, au démarrage. L'empreinte de contrôle dit sous quelle
 * clé la base a été écrite : rien à faire si c'est la clé actuelle ; une base
 * écrite sous une clé inconnue arrête le démarrage. Pendant une rotation
 * (HUB_CLE_ANCIENNE), chaque scellé de chaque table (clés d'API, variables,
 * réglages des services, paramètres secrets des workflows et de leurs
 * versions, secrets de webhook) est rescellé sous la clé neuve, en une
 * transaction. Un scellé qu'aucune des deux clés n'ouvre est laissé tel quel et
 * compté.
 */
export function tournerCle({ db, vault, audit }) {
  const actuelle = vault.controle(), avant = vault.precedente;
  const posee = db.setting('coffre.controle', '');
  if (posee === actuelle) return null;
  if (posee && posee !== avant?.controle()) throw new Error('HUB_CLE n’est pas la clé qui a écrit cette base, HUB_CLE_ANCIENNE non plus : pose la bonne, ou les clés d’API et les secrets seraient perdus.');
  const ouvrir = (jeton, k) => { try { return k.open(jeton); } catch { return null; } };
  const q = n => `"${String(n).replace(/"/g, '""')}"`;
  return db.tx(() => {
    const bilan = { lus: 0, rescelles: 0, illisibles: 0, tables: {} };
    for (const { name: table } of db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")) {
      if (INTOUCHABLES.has(table)) continue;
      for (const { name: col } of db.all('SELECT name FROM pragma_table_info(?)', table)) {
        for (const l of db.all(`SELECT rowid AS r, ${q(col)} AS v FROM ${q(table)} WHERE typeof(${q(col)})='text' AND ${q(col)} LIKE '%v1:%'`)) {
          let change = false;
          const neuf = l.v.replace(SCELLE, jeton => {
            if (ouvrir(jeton, vault) !== null) { bilan.lus++; return jeton; }
            const clair = avant ? ouvrir(jeton, avant) : null;
            if (clair === null) { bilan.illisibles++; bilan.tables[`${table}.${col}`] = (bilan.tables[`${table}.${col}`] || 0) + 1; return jeton; }
            bilan.rescelles++; change = true;
            return vault.seal(clair);
          });
          if (change) db.run(`UPDATE ${q(table)} SET ${q(col)}=? WHERE rowid=?`, neuf, l.r);
        }
      }
    }
    // Première fois, sans rotation : une clé qui n'ouvre rien de ce qui existe est la mauvaise.
    if (!posee && !avant && bilan.illisibles && !bilan.lus) throw new Error('HUB_CLE n’ouvre aucun des secrets de cette base : pose la clé qui les a écrits.');
    db.setSetting('coffre.controle', actuelle);
    if (avant) audit?.write('système', 'coffre.tourné', null, { rescellés: bilan.rescelles, illisibles: bilan.illisibles });
    return bilan;
  });
}

export function generateSecret(spec) {
  if (spec === 'uuid') return crypto.randomUUID();
  if (spec === 'hub-token') return 'hub_' + crypto.randomBytes(24).toString('base64url');
  const m = /^random:(\d+)$/.exec(spec || '');
  return crypto.randomBytes(Math.max(16, Number(m?.[1] || 32))).toString('base64url');
}
