// Sondes : lecture périodique, niveaux, stockage et agrégats.
import { jsonPath } from './manifest/template.js';
import { config } from './config.js';
import { log, parseDuration } from './util/common.js';

export class Probes {
  constructor({ db, bus, services, runtime }) {
    Object.assign(this, { db, bus, services, runtime });
    this.timers = new Map();
    this.latest = new Map();
  }

  sync() {
    const want = new Set();
    for (const inst of this.services.list()) {
      if (inst.status === 'installing') continue;
      for (const p of inst.manifest.probes || []) {
        const key = `${inst.id}:${p.id}`;
        want.add(key);
        if (!this.timers.has(key)) this.schedule(inst.id, p, key);
      }
    }
    for (const [k, t] of this.timers) if (!want.has(k)) { clearTimeout(t); this.timers.delete(k); }
  }

  schedule(instId, probe, key, delay = 2000 + Math.random() * 5000) {
    const t = setTimeout(async () => {
      let inst;
      try { inst = this.services.get(instId); } catch { this.timers.delete(key); return; }
      if (inst.status === 'online') await this.read(inst, probe).catch(e => log.debug('sonde', inst.name, probe.id, e.message));
      if (this.timers.has(key)) this.schedule(instId, probe, key, Math.max(10000, parseDuration(probe.interval, 60000)) * (0.95 + Math.random() * 0.1));
    }, delay);
    t.unref?.();
    this.timers.set(key, t);
  }

  level(probe, value) {
    if (probe.kind === 'state') {
      const s = probe.states || {};
      if (s.crit?.includes(value)) return 'crit';
      if (s.warn?.includes(value)) return 'warn';
      return value == null ? 'crit' : 'ok';
    }
    const th = probe.thresholds;
    if (!th || typeof value !== 'number') return 'ok';
    const below = th.direction === 'below';
    const hit = x => x != null && (below ? value <= x : value >= x);
    return hit(th.crit) ? 'crit' : hit(th.warn) ? 'warn' : 'ok';
  }

  async read(inst, probe) {
    let data;
    try { data = await this.runtime.request(inst, probe.request, { timeout: 15000 }); }
    catch (e) {
      if (probe.kind === 'state') { this.store(inst, probe, {}, null, e.message, 'crit'); return; }
      throw e;
    }
    const rows = Array.isArray(data) ? data : [data];
    for (const row of rows) {
      const raw = jsonPath(row, probe.value);
      const labels = Object.fromEntries(Object.entries(probe.labels || {}).map(([k, p]) => [k, jsonPath(row, p)]));
      const num = typeof raw === 'number' ? raw : raw != null && raw !== '' && !isNaN(Number(raw)) && probe.kind !== 'state' && probe.kind !== 'text' ? Number(raw) : null;
      const value = num ?? raw;
      this.store(inst, probe, labels, num, num == null ? (raw == null ? null : String(raw)) : null, this.level(probe, value));
    }
  }

  store(inst, probe, labels, num, txt, level) {
    const lab = Object.keys(labels).length ? JSON.stringify(labels) : '';
    const ts = Date.now();
    this.db.run('INSERT INTO probe_samples(instance_id,probe_id,labels,ts,num,txt,level) VALUES(?,?,?,?,?,?,?)', inst.id, probe.id, lab, ts, num, txt, level);
    const sample = { instanceId: inst.id, instance: inst.name, probeId: probe.id, probe: probe.name, labels, value: num ?? txt, unit: probe.unit || '', level, ts };
    this.latest.set(`${inst.id}:${probe.id}:${lab}`, sample);
    this.bus.emit('probe', sample);
  }

  overview() {
    const out = [];
    for (const inst of this.services.list()) for (const p of inst.manifest.probes || []) {
      const series = this.db.all(`SELECT labels, num, txt, level, ts FROM probe_samples WHERE instance_id=? AND probe_id=? AND ts = (SELECT MAX(ts) FROM probe_samples s2 WHERE s2.instance_id=probe_samples.instance_id AND s2.probe_id=probe_samples.probe_id AND s2.labels=probe_samples.labels) ORDER BY labels`, inst.id, p.id);
      out.push({ instanceId: inst.id, instance: inst.name, id: p.id, name: p.name, kind: p.kind, unit: p.unit || '', thresholds: p.thresholds || null, interval: p.interval,
        series: series.map(s => ({ labels: s.labels ? JSON.parse(s.labels) : {}, value: s.num ?? s.txt, level: s.level, ts: s.ts })) });
    }
    return out;
  }

  history(instId, probeId, { hours = 24, labels = '' } = {}) {
    const since = Date.now() - hours * 3600e3;
    const bucket = hours <= 6 ? 60e3 : hours <= 72 ? 3600e3 / 4 : 3600e3;
    return this.db.all(`SELECT labels, (ts / ?) * ? AS t, AVG(num) AS avg, MIN(num) AS min, MAX(num) AS max, MAX(CASE level WHEN 'crit' THEN 2 WHEN 'warn' THEN 1 ELSE 0 END) AS lvl
      FROM probe_samples WHERE instance_id=? AND probe_id=? AND ts>=? ${labels ? 'AND labels=?' : ''} GROUP BY labels, t ORDER BY t`, bucket, bucket, instId, probeId, since, ...(labels ? [labels] : []))
      .map(r => ({ labels: r.labels ? JSON.parse(r.labels) : {}, t: r.t, avg: r.avg, min: r.min, max: r.max, level: ['ok', 'warn', 'crit'][r.lvl] }));
  }

  purge() { this.db.run('DELETE FROM probe_samples WHERE ts < ?', Date.now() - config.probeRetentionDays * 86400e3); }
  stop() { for (const t of this.timers.values()) clearTimeout(t); this.timers.clear(); }
}
