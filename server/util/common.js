import crypto from 'node:crypto';
import { config } from '../config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const min = LEVELS[config.logLevel] ?? 20;

export const log = Object.fromEntries(Object.keys(LEVELS).map(l => [l, (...a) => {
  if (LEVELS[l] < min) return;
  const line = `${new Date().toISOString()} ${l.toUpperCase().padEnd(5)} ${a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')}`;
  (l === 'error' || l === 'warn' ? console.error : console.log)(line);
}]));

export const id = (prefix = '') => prefix + crypto.randomBytes(9).toString('base64url');
export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function parseDuration(s, fallback = 0) {
  if (typeof s === 'number') return s;
  if (!s) return fallback;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(String(s).trim());
  if (!m) return fallback;
  const n = Number(m[1]);
  return n * { ms: 1, s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7 }[m[2]];
}

export class HttpError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}

export const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Masque les valeurs qui ressemblent à des secrets avant stockage d'un historique.
export function redact(obj, secrets = []) {
  const list = secrets.filter(s => s && String(s).length >= 6).map(String);
  const walk = v => {
    if (typeof v === 'string') { let out = v; for (const s of list) out = out.split(s).join('••••'); return out; }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = /pass|secret|token|apikey|api_key|authorization/i.test(k) && typeof x === 'string' ? '••••' : walk(x);
      return o;
    }
    return v;
  };
  return walk(obj);
}
