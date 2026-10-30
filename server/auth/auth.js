// Comptes, sessions, TOTP, codes de secours, code d'appairage.
import crypto from 'node:crypto';
import { id, HttpError, safeEqual, sha256 } from '../util/common.js';
import { config } from '../config.js';

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
const SESSION_MS = 12 * 3600e3;

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(pw, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${dk.toString('base64')}`;
}
export function verifyPassword(pw, stored) {
  const [alg, n, s, h] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const dk = crypto.scryptSync(pw, Buffer.from(s, 'base64'), 32, { ...SCRYPT, N: Number(n) });
  return crypto.timingSafeEqual(dk, Buffer.from(h, 'base64'));
}

// ---- TOTP (RFC 6238) ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s) {
  const clean = s.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
  let bits = 0, val = 0; const out = [];
  for (const c of clean) { const i = B32.indexOf(c); if (i < 0) throw new Error('base32 invalide'); val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
export function totp(secret, t = Date.now(), step = 30) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(t / 1000 / step)));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0');
}
export function verifyTotp(secret, code, t = Date.now()) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  return [-1, 0, 1].some(w => safeEqual(totp(secret, t + w * 30000), c));
}

export class Auth {
  constructor(db, audit) {
    this.db = db; this.audit = audit;
    this.attempts = new Map();
    if (!db.setting('pairing_code') && !this.hasUsers()) {
      const code = crypto.randomBytes(4).toString('hex').toUpperCase().replace(/(.{4})/, '$1-');
      db.setSetting('pairing_code', code);
    }
  }
  hasUsers() { return !!this.db.get('SELECT 1 FROM users LIMIT 1'); }
  pairingCode() { return this.hasUsers() ? null : this.db.setting('pairing_code'); }

  throttle(key) {
    const nowT = Date.now();
    const a = (this.attempts.get(key) || []).filter(t => nowT - t < 15 * 60e3);
    if (a.length >= 8) throw new HttpError(429, 'Trop de tentatives. Réessaie dans quelques minutes.');
    a.push(nowT); this.attempts.set(key, a);
  }

  // Première configuration : exige le code d'appairage affiché au démarrage.
  setup({ pairing, username, password }) {
    if (this.hasUsers()) throw new HttpError(409, 'Le Hub est déjà configuré.');
    const expected = this.db.setting('pairing_code');
    if (!expected || !safeEqual(String(pairing || '').toUpperCase().trim(), expected)) throw new HttpError(403, 'Code d’appairage incorrect. Il est affiché dans les journaux du Hub.');
    validateCredentials(username, password);
    const uid = id('u_');
    const secret = base32Encode(crypto.randomBytes(20));
    this.db.run('INSERT INTO users(id,username,pass_hash,role,totp_secret,created) VALUES(?,?,?,?,?,?)', uid, username, hashPassword(password), 'admin', secret, Date.now());
    this.db.run('DELETE FROM settings WHERE key=?', 'pairing_code');
    this.audit.write(username, 'compte.créé', uid, { role: 'admin' });
    return { userId: uid, totpSecret: secret, otpauth: otpauthUri(username, secret) };
  }

  // Active le TOTP (obligatoire) et renvoie les codes de secours en clair une seule fois.
  enableTotp(userId, code) {
    const u = this.db.get('SELECT * FROM users WHERE id=?', userId);
    if (!u) throw new HttpError(404, 'Compte introuvable');
    if (u.totp_enabled) throw new HttpError(409, 'Second facteur déjà activé');
    if (!verifyTotp(u.totp_secret, code)) throw new HttpError(400, 'Code incorrect. Vérifie l’heure de ton téléphone.');
    const codes = Array.from({ length: 10 }, () => crypto.randomBytes(5).toString('hex').replace(/(.{5})/, '$1-'));
    this.db.run('UPDATE users SET totp_enabled=1, recovery=? WHERE id=?', JSON.stringify(codes.map(c => sha256(c))), userId);
    this.audit.write(u.username, 'mfa.activé', userId);
    return codes;
  }

  login({ username, password }, ip) {
    this.throttle('login:' + ip);
    const u = this.db.get('SELECT * FROM users WHERE username=?', String(username || ''));
    const ok = u ? verifyPassword(String(password || ''), u.pass_hash) : (verifyPassword('x', hashPassword('y')), false);
    if (!ok) { this.audit.write(String(username || '?'), 'connexion.échec', null, { ip }); throw new HttpError(401, 'Identifiant ou mot de passe incorrect.'); }
    return this.createSession(u, ip, false);
  }

  createSession(u, ip, mfa) {
    const sid = crypto.randomBytes(32).toString('base64url');
    const csrf = crypto.randomBytes(24).toString('base64url');
    const t = Date.now();
    this.db.run('INSERT INTO sessions(id,user_id,csrf,mfa_ok,created,expires,ip) VALUES(?,?,?,?,?,?,?)', sha256(sid), u.id, csrf, mfa ? 1 : 0, t, t + SESSION_MS, ip);
    return { sid, csrf, needMfa: !mfa, mfaEnrolled: !!u.totp_enabled };
  }

  mfa(sid, code, ip) {
    this.throttle('mfa:' + ip);
    const s = this.session(sid, { allowPartial: true });
    if (!s) throw new HttpError(401, 'Session expirée');
    const u = this.db.get('SELECT * FROM users WHERE id=?', s.user_id);
    let ok = u.totp_enabled && verifyTotp(u.totp_secret, code);
    if (!ok && u.totp_enabled) {
      const rec = JSON.parse(u.recovery); const h = sha256(String(code || '').trim().toLowerCase());
      const i = rec.indexOf(h);
      if (i >= 0) { rec.splice(i, 1); this.db.run('UPDATE users SET recovery=? WHERE id=?', JSON.stringify(rec), u.id); ok = true; this.audit.write(u.username, 'mfa.code_secours', u.id, { restants: rec.length }); }
    }
    if (!ok) { this.audit.write(u.username, 'mfa.échec', u.id, { ip }); throw new HttpError(401, 'Code incorrect.'); }
    // rotation de session après élévation
    this.db.run('DELETE FROM sessions WHERE id=?', sha256(sid));
    this.audit.write(u.username, 'connexion', u.id, { ip });
    return this.createSession(u, ip, true);
  }

  session(sid, { allowPartial = false } = {}) {
    if (!sid) return null;
    const s = this.db.get('SELECT s.*, u.username, u.role, u.totp_enabled FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=?', sha256(sid));
    if (!s || s.expires < Date.now()) return null;
    if (!s.mfa_ok && !allowPartial) return null;
    if (s.expires - Date.now() < SESSION_MS / 2) this.db.run('UPDATE sessions SET expires=? WHERE id=?', Date.now() + SESSION_MS, s.id);
    return s;
  }
  logout(sid) { if (sid) this.db.run('DELETE FROM sessions WHERE id=?', sha256(sid)); }
  purge() { this.db.run('DELETE FROM sessions WHERE expires < ?', Date.now()); }
}

function validateCredentials(username, password) {
  if (!/^[a-z0-9._-]{3,32}$/i.test(String(username || ''))) throw new HttpError(400, 'Identifiant : 3 à 32 caractères (lettres, chiffres, . _ -).');
  if (String(password || '').length < 12) throw new HttpError(400, 'Mot de passe : 12 caractères minimum.');
}
export const otpauthUri = (user, secret) => `otpauth://totp/Hub:${encodeURIComponent(user)}?secret=${secret}&issuer=Hub&algorithm=SHA1&digits=6&period=30`;
export { config as _cfg };
