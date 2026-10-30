// Gabarits {{ chemin | filtre(arg) }} et JSONPath minimal. Aucun eval.

// ---- JSONPath : $, .clé, ['clé'], [n], [*], .length ----
export function jsonPath(data, expr) {
  if (expr == null || expr === '' || expr === '$') return data;
  const tokens = tokenizePath(String(expr).replace(/^\$\.?/, ''));
  let cur = [data], multi = false;
  for (const t of tokens) {
    const next = [];
    for (const c of cur) {
      if (t === '*') { if (Array.isArray(c)) next.push(...c); else if (c && typeof c === 'object') next.push(...Object.values(c)); multi = true; }
      else if (t === 'length' && (Array.isArray(c) || typeof c === 'string')) next.push(c.length);
      else if (c != null && typeof c === 'object' && t in c) next.push(c[t]);
      else next.push(undefined);
    }
    cur = next;
  }
  return multi ? cur.filter(x => x !== undefined) : cur[0];
}

export function tokenizePath(p) {
  const out = []; let i = 0, buf = '';
  const flush = () => { if (buf) { out.push(buf); buf = ''; } };
  while (i < p.length) {
    const ch = p[i];
    if (ch === '.') { flush(); i++; continue; }
    if (ch === '[') {
      flush();
      const end = p.indexOf(']', i);
      if (end < 0) throw new Error('Chemin invalide : ' + p);
      let inner = p.slice(i + 1, end).trim();
      if (/^['"].*['"]$/.test(inner)) inner = inner.slice(1, -1);
      out.push(/^\d+$/.test(inner) ? Number(inner) : inner);
      i = end + 1; continue;
    }
    buf += ch; i++;
  }
  flush();
  return out;
}

// ---- Filtres ----
const FILTERS = {
  upper: v => String(v ?? '').toUpperCase(),
  lower: v => String(v ?? '').toLowerCase(),
  trim: v => String(v ?? '').trim(),
  default: (v, d) => (v === undefined || v === null || v === '' ? d : v),
  json: v => JSON.stringify(v),
  length: v => (v == null ? 0 : (v.length ?? Object.keys(v).length)),
  first: v => (Array.isArray(v) ? v[0] : v),
  last: v => (Array.isArray(v) ? v[v.length - 1] : v),
  join: (v, s = ', ') => (Array.isArray(v) ? v.join(s) : v),
  number: v => Number(v),
  string: v => (typeof v === 'string' ? v : JSON.stringify(v)),
  truncate: (v, n = 200) => { const s = String(v ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; },
  date: (v, fmt = 'YYYY-MM-DD HH:mm') => formatDate(v, fmt),
  keys: v => Object.keys(v || {}),
};

/* Le fuseau de l'utilisateur, pas celui du conteneur (souvent UTC) : une
   heure envoyée sur Telegram doit être celle de sa montre. Le navigateur le
   donne au Hub à la première connexion. */
let FUSEAU = '';
export function poserFuseau(tz) {
  try { if (tz) { new Intl.DateTimeFormat('fr-FR', { timeZone: tz }); FUSEAU = tz; } } catch { /* fuseau inconnu : on garde l'actuel */ }
  return FUSEAU;
}
export const fuseau = () => FUSEAU;

export function formatDate(v, fmt) {
  const d = v instanceof Date ? v : new Date(v ?? Date.now());
  if (isNaN(d)) return '';
  const pad = n => String(n).padStart(2, '0');
  let c = { YYYY: d.getFullYear(), MM: pad(d.getMonth() + 1), DD: pad(d.getDate()), HH: pad(d.getHours()), mm: pad(d.getMinutes()), ss: pad(d.getSeconds()) };
  if (FUSEAU) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: FUSEAU, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(d).map(x => [x.type, x.value]));
    c = { YYYY: p.year, MM: p.month, DD: p.day, HH: p.hour, mm: p.minute, ss: p.second };
  }
  return fmt.replace(/YYYY|MM|DD|HH|mm|ss/g, t => c[t]);
}
/* L'heure, la date ou les deux (« 24/09/2026 12:30 »), dans le fuseau de l'utilisateur. */
export const tempsLisible = () => { const d = new Date(); return { $maintenant: formatDate(d, 'DD/MM/YYYY HH:mm'), $heure: formatDate(d, 'HH:mm'), $date: formatDate(d, 'DD/MM/YYYY') }; };

function parseArgs(s) {
  if (!s.trim()) return [];
  const args = []; const re = /\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|-?\d+(?:\.\d+)?|true|false|null)\s*(?:,|$)/y;
  let m;
  while ((m = re.exec(s)) && m[0]) {
    const a = m[1];
    args.push(a.startsWith('"') ? JSON.parse(a) : a.startsWith("'") ? a.slice(1, -1).replace(/\\'/g, "'") : a === 'true' ? true : a === 'false' ? false : a === 'null' ? null : Number(a));
    if (re.lastIndex >= s.length) break;
  }
  return args;
}

// Évalue une expression "chemin | filtre(args) | filtre".
export function evalExpr(expr, ctx) {
  const parts = splitPipes(expr);
  const head = parts.shift().trim();
  let v;
  if (/^(".*"|'.*'|-?\d+(\.\d+)?|true|false|null)$/.test(head)) v = parseArgs(head)[0];
  else v = resolvePath(head, ctx);
  for (const f of parts) {
    const m = /^\s*([a-z]+)\s*(?:\((.*)\))?\s*$/i.exec(f);
    if (!m || !FILTERS[m[1]]) throw new Error(`Filtre inconnu : ${f.trim()}`);
    v = FILTERS[m[1]](v, ...parseArgs(m[2] || ''));
  }
  return v;
}

function splitPipes(s) {
  const out = []; let cur = '', q = null, depth = 0;
  for (const ch of s) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '(') depth++; if (ch === ')') depth--;
    if (ch === '|' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function resolvePath(head, ctx) {
  const tokens = tokenizePath(head);
  if (!tokens.length) return undefined;
  let cur = ctx;
  for (const t of tokens) {
    if (cur == null) return undefined;
    if (typeof cur === 'function') cur = cur(t);
    else if (t === 'length' && (Array.isArray(cur) || typeof cur === 'string')) cur = cur.length;
    else cur = Object.prototype.hasOwnProperty.call(Object(cur), t) ? cur[t] : undefined;
  }
  return typeof cur === 'function' ? undefined : cur;
}

// Une seule expression qui occupe toute la valeur. « {{ a }}|{{ b }} » n'en
// est pas une : l'ancienne forme la lisait comme « a }}|{{ b » et échouait.
const WHOLE = /^\s*\{\{((?:(?!\}\})[\s\S])+)\}\}\s*$/;
const ANY = /\{\{([\s\S]+?)\}\}/g;

// Rend une valeur (chaîne, objet, tableau). Une chaîne composée d'une seule
// expression garde le type du résultat ; sinon, conversion en texte.
export function render(value, ctx) {
  if (typeof value === 'string') {
    const w = WHOLE.exec(value);
    if (w) return evalExpr(w[1], ctx);
    return value.replace(ANY, (_, e) => { const r = evalExpr(e, ctx); return r == null ? '' : typeof r === 'object' ? JSON.stringify(r) : String(r); });
  }
  if (Array.isArray(value)) return value.map(v => render(v, ctx));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, render(v, ctx)]));
  return value;
}
