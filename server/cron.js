// Parseur cron à 5 champs (minute heure jour mois jour-semaine), heure locale du serveur.
const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
const NAMES = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12, sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

export function parseCron(expr) {
  const aliases = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *' };
  const parts = (aliases[String(expr).trim()] || String(expr)).trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('Expression cron : 5 champs attendus (minute heure jour mois jour-semaine)');
  return parts.map((p, i) => {
    const [lo, hi] = RANGES[i];
    const set = new Set();
    for (const chunk of p.toLowerCase().split(',')) {
      const [range, stepS] = chunk.split('/');
      const step = stepS ? Number(stepS) : 1;
      if (!Number.isInteger(step) || step < 1) throw new Error(`Pas invalide : ${chunk}`);
      let a = lo, b = hi;
      if (range !== '*') {
        const [x, y] = range.split('-').map(v => (v in NAMES ? NAMES[v] : Number(v)));
        if (!Number.isInteger(x)) throw new Error(`Valeur invalide : ${chunk}`);
        a = x; b = y ?? (stepS ? hi : x);
      }
      if (i === 4 && b === 7) b = 6;
      if (a < lo || b > hi + (i === 4 ? 1 : 0) || a > b) throw new Error(`Hors limites : ${chunk}`);
      for (let v = a; v <= b; v += step) set.add(i === 4 && v === 7 ? 0 : v);
    }
    return { set, any: p === '*' };
  });
}

export function cronMatches(fields, d = new Date()) {
  const [mi, h, dom, mon, dow] = fields;
  if (!mi.set.has(d.getMinutes()) || !h.set.has(d.getHours()) || !mon.set.has(d.getMonth() + 1)) return false;
  const domOk = dom.set.has(d.getDate()), dowOk = dow.set.has(d.getDay());
  if (dom.any || dow.any) return domOk && dowOk;
  return domOk || dowOk;
}

export function nextRun(expr, from = new Date()) {
  const f = parseCron(expr);
  const d = new Date(from); d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) { if (cronMatches(f, d)) return d; d.setMinutes(d.getMinutes() + 1); }
  return null;
}
