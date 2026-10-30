// Mesures de la machine et des extensions, pour la Vue d'ensemble.
//
// Deux sources, chacune facultative :
//  - les conteneurs, par l'API de Docker derrière le proxy de socket
//    (GET /containers/json et /containers/{id}/stats, que CONTAINERS=1 ouvre
//    déjà) : trafic, processeur et mémoire de chaque conteneur, regroupés par
//    extension (projet Compose « hub-<nom> ») ;
//  - la machine, par le petit conteneur hub-mesure (outils/mesure-hote.sh) qui
//    recopie toutes les quinze secondes les compteurs du noyau dans un volume
//    lu ici en lecture seule : trafic des cartes réseau physiques, processeur,
//    mémoire. Le Hub lui-même ne voit que son propre réseau.
//
// Un relevé par minute ; les débits sont des écarts entre deux relevés. Une
// ligne par tranche de cinq minutes est gardée trente et un jours (retention.js).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export const TRANCHE = 300e3;
const PERIODES = { '24h': { duree: 864e5, pas: 600e3 }, '7j': { duree: 7 * 864e5, pas: 3600e3 }, '30j': { duree: 30 * 864e5, pas: 4 * 3600e3 } };
export const HUB = 'Hub';
export const AUTRES = 'Autres conteneurs';

// Client minimal de l'API Docker : DOCKER_HOST en tcp:// (le proxy) ou unix://.
export function clientDocker(hote = process.env.DOCKER_HOST || 'unix:///var/run/docker.sock') {
  const cible = hote.startsWith('unix://') ? { socketPath: hote.slice(7) }
    : (() => { const u = new URL(hote.replace(/^tcp:/, 'http:')); return { host: u.hostname, port: Number(u.port) || 2375 }; })();
  return chemin => new Promise((resolve, reject) => {
    const req = http.request({ ...cible, path: chemin, method: 'GET', timeout: 8000 }, res => {
      const morceaux = []; let taille = 0;
      res.on('data', d => { taille += d.length; if (taille > 4e6) req.destroy(new Error('réponse trop grande')); else morceaux.push(d); });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`Docker ${chemin.split('?')[0]} : ${res.statusCode}`));
        try { resolve(JSON.parse(Buffer.concat(morceaux).toString('utf8'))); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Docker : délai dépassé')));
    req.on('error', reject);
    req.end();
  });
}

// Fichier écrit par outils/mesure-hote.sh.
export function lireHote(texte) {
  const o = { t: 0, cpu: null, memTotal: 0, memDispo: 0, rx: 0, tx: 0, cartes: 0 };
  for (const l of String(texte).split('\n')) {
    const c = l.trim().split(/\s+/);
    if (c[0] === 't') o.t = Number(c[1]) * 1000;
    else if (c[0] === 'cpu') { const v = c.slice(1, 9).map(Number); o.cpu = { total: v.reduce((a, x) => a + (x || 0), 0), repos: (v[3] || 0) + (v[4] || 0) }; }
    else if (c[0] === 'MemTotal:') o.memTotal = Number(c[1]) * 1024;
    else if (c[0] === 'MemAvailable:') o.memDispo = Number(c[1]) * 1024;
    else if (c[0] === 'if' && c.length >= 4) { o.rx += Number(c[2]) || 0; o.tx += Number(c[3]) || 0; o.cartes++; }
  }
  return o;
}

// Mémoire d'un conteneur, comme « docker stats » : sans le cache de fichiers.
const memoireDe = m => Math.max(0, (m?.usage || 0) - (m?.stats?.inactive_file ?? m?.stats?.total_inactive_file ?? 0));
const reseauDe = n => Object.values(n || {}).reduce((a, x) => ({ rx: a.rx + (x.rx_bytes || 0), tx: a.tx + (x.tx_bytes || 0) }), { rx: 0, tx: 0 });
const ecart = (a, b) => (b >= a ? b - a : null);   // un compteur remis à zéro (redémarrage) ne compte pas

export class Mesures {
  constructor({ db, services, dossier = '', docker = clientDocker(), maintenant = Date.now }) {
    this.db = db; this.services = services; this.dossier = dossier; this.docker = docker; this.maintenant = maintenant;
    this.avant = null;          // relevé précédent : { t, conteneurs: Map(id → compteurs), hote }
    this.tranche = null;        // tranche de cinq minutes en cours
    this.actuel = null;         // débits du dernier relevé
    this.sources = { docker: false, hote: false };
    this.ncpu = 0;
  }

  groupeDe(projet) {
    if (projet === 'hub') return HUB;
    const nom = /^hub-(.+)$/.exec(projet || '')?.[1];
    return nom && this.services.list().some(i => i.name === nom) ? nom : AUTRES;
  }

  async lireConteneurs() {
    if (!this.ncpu) { try { this.ncpu = (await this.docker('/info')).NCPU || 0; } catch { /* repris au prochain relevé */ } }
    const liste = await this.docker('/containers/json');
    const sortie = new Map();
    let i = 0;
    const suivant = async () => {
      while (i < liste.length) {
        const c = liste[i++];
        try {
          const s = await this.docker(`/containers/${encodeURIComponent(c.Id)}/stats?stream=false&one-shot=true`);
          sortie.set(c.Id, { groupe: this.groupeDe(c.Labels?.['com.docker.compose.project']), cpu: s.cpu_stats?.cpu_usage?.total_usage || 0, mem: memoireDe(s.memory_stats), ...reseauDe(s.networks) });
        } catch { /* conteneur parti entre la liste et ses chiffres */ }
      }
    };
    await Promise.all(Array.from({ length: 4 }, suivant));
    return sortie;
  }

  lireFichierHote() {
    if (!this.dossier) return null;
    try {
      const h = lireHote(fs.readFileSync(path.join(this.dossier, 'hote'), 'utf8'));
      return h.t && this.maintenant() - h.t < 120e3 && h.cpu ? h : null;   // un relevé figé ne dit plus rien
    } catch { return null; }
  }

  async releve() {
    const t = this.maintenant();
    let conteneurs = null;
    try { conteneurs = await this.lireConteneurs(); this.sources.docker = true; } catch { this.sources.docker = false; }
    const hote = this.lireFichierHote();
    this.sources.hote = !!hote;
    const inst = this.services.list().filter(i => i.status !== 'installing');
    const r = { t, svcTotal: inst.length, svcOk: inst.filter(i => i.status === 'online').length, groupes: new Map() };
    const a = this.avant;
    if (a) {
      const dt = (t - a.t) / 1000;
      if (conteneurs && a.conteneurs && dt > 0) {
        for (const [id, c] of conteneurs) {
          const p = a.conteneurs.get(id);
          const g = r.groupes.get(c.groupe) || { rx: 0, tx: 0, cpu: 0, mem: 0 };
          g.mem += c.mem;
          if (p) {
            const drx = ecart(p.rx, c.rx), dtx = ecart(p.tx, c.tx), dcpu = ecart(p.cpu, c.cpu);
            if (drx !== null) g.rx += drx / dt;
            if (dtx !== null) g.tx += dtx / dt;
            if (dcpu !== null && this.ncpu) g.cpu += dcpu / 1e9 / dt / this.ncpu * 100;
          }
          r.groupes.set(c.groupe, g);
        }
      }
      if (hote && a.hote && hote.t > a.hote.t) {
        const dth = (hote.t - a.hote.t) / 1000, dtot = hote.cpu.total - a.hote.cpu.total;
        const drx = ecart(a.hote.rx, hote.rx), dtx = ecart(a.hote.tx, hote.tx);
        r.hote = { rx: drx === null ? null : drx / dth, tx: dtx === null ? null : dtx / dth, cpu: dtot > 0 ? (1 - (hote.cpu.repos - a.hote.cpu.repos) / dtot) * 100 : null };
      }
    }
    if (hote?.memTotal) r.hoteMem = { total: hote.memTotal, pct: (1 - hote.memDispo / hote.memTotal) * 100 };
    this.avant = { t, conteneurs, hote: hote || a?.hote || null };
    this.actuel = r;
    this.accumuler(r);
    return r;
  }

  accumuler(r) {
    const cle = Math.floor(r.t / TRANCHE) * TRANCHE;
    if (this.tranche && this.tranche.t !== cle) this.ecrire();
    if (!this.tranche) this.tranche = { t: cle, n: 0, somme: {}, compte: {}, groupes: new Map() };
    const tr = this.tranche;
    tr.n++;
    const ajouter = (k, v) => { if (v === null || v === undefined || !Number.isFinite(v)) return; tr.somme[k] = (tr.somme[k] || 0) + v; tr.compte[k] = (tr.compte[k] || 0) + 1; };
    const ext = [...r.groupes].filter(([g]) => g !== HUB && g !== AUTRES).map(([, g]) => g);
    const tous = [...r.groupes.values()];
    const somme = (l, k) => l.reduce((a, g) => a + g[k], 0);
    if (r.groupes.size) {
      ajouter('ext_rx', somme(ext, 'rx')); ajouter('ext_tx', somme(ext, 'tx'));
      ajouter('cont_rx', somme(tous, 'rx')); ajouter('cont_tx', somme(tous, 'tx'));
      ajouter('ext_cpu', somme(ext, 'cpu')); ajouter('ext_mem', somme(ext, 'mem'));
    }
    if (r.hote) { ajouter('hote_rx', r.hote.rx); ajouter('hote_tx', r.hote.tx); ajouter('hote_cpu', r.hote.cpu); }
    if (r.hoteMem) ajouter('hote_mem', r.hoteMem.pct);
    ajouter('svc_total', r.svcTotal); ajouter('svc_ok', r.svcOk);
    for (const [nom, g] of r.groupes) {
      const x = tr.groupes.get(nom) || { n: 0, rx: 0, tx: 0, cpu: 0, mem: 0 };
      x.n++; x.rx += g.rx; x.tx += g.tx; x.cpu += g.cpu; x.mem += g.mem;
      tr.groupes.set(nom, x);
    }
  }

  ecrire() {
    const tr = this.tranche; this.tranche = null;
    if (!tr) return;
    const moy = k => (tr.compte[k] ? tr.somme[k] / tr.compte[k] : null);
    this.db.tx(() => {
      this.db.run(`INSERT OR REPLACE INTO mesures (t, hote_rx, hote_tx, hote_cpu, hote_mem, ext_rx, ext_tx, cont_rx, cont_tx, ext_cpu, ext_mem, svc_total, svc_ok)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, tr.t, moy('hote_rx'), moy('hote_tx'), moy('hote_cpu'), moy('hote_mem'), moy('ext_rx'), moy('ext_tx'), moy('cont_rx'), moy('cont_tx'), moy('ext_cpu'), moy('ext_mem'), moy('svc_total'), moy('svc_ok'));
      for (const [nom, g] of tr.groupes) this.db.run('INSERT OR REPLACE INTO mesures_groupes (t, groupe, rx, tx, cpu, mem) VALUES (?,?,?,?,?,?)', tr.t, nom, g.rx / g.n, g.tx / g.n, g.cpu / g.n, g.mem / g.n);
    });
  }

  // La Vue d'ensemble : séries de la période, débits du moment, plus gros
  // consommateurs, disponibilité heure par heure sur sept jours.
  vue(periode = '24h', { admin = false } = {}) {
    const p = PERIODES[periode] || PERIODES['24h'];
    const fin = this.maintenant(), debut = fin - p.duree;
    const lignes = this.db.all(`SELECT (t / ?) * ? AS t, AVG(hote_rx) hote_rx, AVG(hote_tx) hote_tx, AVG(hote_cpu) hote_cpu, AVG(hote_mem) hote_mem,
      AVG(ext_rx) ext_rx, AVG(ext_tx) ext_tx, AVG(cont_rx) cont_rx, AVG(cont_tx) cont_tx, AVG(ext_cpu) ext_cpu, AVG(ext_mem) ext_mem
      FROM mesures WHERE t >= ? GROUP BY 1 ORDER BY 1`, p.pas, p.pas, debut);
    const col = k => lignes.map(l => (l[k] === null ? null : Math.round(l[k] * 100) / 100));
    const aDes = k => lignes.some(l => l[k] !== null);
    const groupes = this.db.all(`SELECT groupe, AVG(rx) rx, AVG(tx) tx, AVG(cpu) cpu, AVG(mem) mem, SUM(rx + tx) * ? / 1000 AS volume
      FROM mesures_groupes WHERE t >= ? GROUP BY groupe ORDER BY volume DESC`, TRANCHE, debut);
    // Les conteneurs étrangers au Hub ne sont nommés qu'en un seul groupe ;
    // et un compte non administrateur ne voit pas le détail du Hub lui-même.
    const top = groupes.map(g => ({ nom: g.groupe, hub: g.groupe === HUB, autres: g.groupe === AUTRES, entrant: g.rx, sortant: g.tx, cpu: g.cpu, memoire: g.mem, volume: g.volume }))
      .filter(g => admin || !g.hub);
    // Disponibilité : sept jours, une case par heure (UTC), part des services en ligne.
    const h0 = Math.floor(fin / 3600e3) * 3600e3 - 167 * 3600e3;
    const heures = new Map(this.db.all('SELECT (t / 3600000) * 3600000 AS h, SUM(svc_ok) ok, SUM(svc_total) total FROM mesures WHERE t >= ? GROUP BY 1', h0).map(r => [r.h, r]));
    const dispo = Array.from({ length: 168 }, (_, i) => {
      const r = heures.get(h0 + i * 3600e3);
      return r && r.total > 0 ? Math.round(r.ok / r.total * 1000) / 10 : null;
    });
    const sommes = [...heures.values()].reduce((a, r) => ({ ok: a.ok + (r.ok || 0), total: a.total + (r.total || 0) }), { ok: 0, total: 0 });
    const a = this.actuel;
    const ext = a ? [...a.groupes].filter(([g]) => g !== HUB && g !== AUTRES).map(([, g]) => g) : [];
    const somme = (l, k) => l.reduce((x, g) => x + g[k], 0);
    return {
      periode: PERIODES[periode] ? periode : '24h', pas: p.pas, debut, fin,
      sources: { ...this.sources, ncpu: this.ncpu || null, memoire: a?.hoteMem?.total || null },
      instants: lignes.map(l => l.t),
      trafic: {
        hote: aDes('hote_rx') ? { entrant: col('hote_rx'), sortant: col('hote_tx') } : null,
        extensions: aDes('ext_rx') ? { entrant: col('ext_rx'), sortant: col('ext_tx') } : null,
        conteneurs: aDes('cont_rx') ? { entrant: col('cont_rx'), sortant: col('cont_tx') } : null,
      },
      ressources: {
        cpu: aDes('hote_cpu') ? col('hote_cpu') : null, memoire: aDes('hote_mem') ? col('hote_mem') : null,
        extCpu: aDes('ext_cpu') ? col('ext_cpu') : null, extMemoire: aDes('ext_mem') ? col('ext_mem') : null,
      },
      actuel: a ? {
        t: a.t,
        hote: a.hote ? { entrant: a.hote.rx, sortant: a.hote.tx, cpu: a.hote.cpu } : null,
        memoire: a.hoteMem ? a.hoteMem.pct : null,
        extensions: a.groupes.size ? { entrant: somme(ext, 'rx'), sortant: somme(ext, 'tx'), cpu: somme(ext, 'cpu'), memoire: somme(ext, 'mem') } : null,
        conteneurs: a.groupes.size ? { entrant: somme([...a.groupes.values()], 'rx'), sortant: somme([...a.groupes.values()], 'tx') } : null,
      } : null,
      top,
      disponibilite: { debut: h0, heures: dispo, pct: sommes.total ? Math.round(sommes.ok / sommes.total * 1000) / 10 : null },
    };
  }

  demarrer() {
    const tour = () => this.releve().catch(() => {});
    tour();
    const t = setInterval(tour, 60e3); t.unref?.();
    return t;
  }
}
