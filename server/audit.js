// Journal d'audit chaîné : chaque ligne contient le haché de la précédente.
// Chaque ligne part aussi sur la sortie standard, que les journaux du
// conteneur gardent hors de portée du Hub (REQ-DATA-004) : effacer la base ne
// fait pas disparaître la trace.
import { sha256, redact } from './util/common.js';

// Durée de conservation du journal : un an, puis les plus anciennes lignes partent.
export const CONSERVATION_MS = 365 * 86400e3;

export class Audit {
  constructor(db, bus, { sortie = ligne => console.log(ligne) } = {}) { this.db = db; this.bus = bus; this.sortie = sortie; }
  write(actor, action, target = null, detail = null) {
    const last = this.db.get('SELECT hash FROM audit ORDER BY seq DESC LIMIT 1');
    const prev = last?.hash || 'genesis';
    const ts = Date.now();
    const d = detail == null ? null : JSON.stringify(redact(detail));
    const hash = sha256([prev, ts, actor, action, target ?? '', d ?? ''].join('|'));
    this.db.run('INSERT INTO audit(ts,actor,action,target,detail,prev_hash,hash) VALUES(?,?,?,?,?,?,?)', ts, actor, action, target, d, prev, hash);
    this.sortie(JSON.stringify({ journal: 'hub-audit', t: ts, acteur: actor, action, objet: target, details: d == null ? null : JSON.parse(d), hash }));
    this.bus?.emit('audit', { ts, actor, action, target });
  }
  list(limit = 200, before = null) {
    return this.db.all(`SELECT seq,ts,actor,action,target,detail FROM audit ${before ? 'WHERE seq < ?' : ''} ORDER BY seq DESC LIMIT ?`, ...(before ? [before, limit] : [limit]))
      .map(r => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
  }
  // La chaîne se vérifie depuis la plus ancienne ligne gardée : ce qui est
  // parti avec la conservation a laissé sa trace (« journal.purgé »).
  verify() {
    let prev = null, n = 0;
    for (const r of this.db.all('SELECT * FROM audit ORDER BY seq')) {
      prev ??= r.prev_hash;
      const h = sha256([prev, r.ts, r.actor, r.action, r.target ?? '', r.detail ?? ''].join('|'));
      if (r.prev_hash !== prev || r.hash !== h) return { ok: false, brokenAt: r.seq };
      prev = r.hash; n++;
    }
    return { ok: true, entries: n };
  }
  purger(maintenant = Date.now()) {
    const avant = maintenant - CONSERVATION_MS;
    const n = this.db.get('SELECT COUNT(*) n FROM audit WHERE ts < ?', avant).n;
    if (!n) return 0;
    this.db.run('DELETE FROM audit WHERE ts < ?', avant);
    this.write('hub', 'journal.purgé', null, { lignes: n, plusAnciennesQue: new Date(avant).toISOString() });
    return n;
  }
}
