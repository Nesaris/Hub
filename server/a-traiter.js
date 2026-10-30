// « À traiter » de la Vue d'ensemble : ce qui attend quelqu'un, toutes sources
// confondues — services injoignables, sondes en alerte (dont celles que les
// services déclarent pour leurs propres alertes : ProxLab, NEXARC…),
// validations en attente, workflows en échec, mises à jour disponibles.
const RANG = { crit: 0, warn: 1, info: 2 };

export function aTraiter({ services, probes, engine, db, maintenant = Date.now() }) {
  const sortie = [];
  for (const i of services.list()) {
    if (i.status === 'error' || i.status === 'offline') {
      sortie.push({ niveau: 'crit', element: i.name, observation: i.status_detail || (i.status === 'offline' ? 'Hors ligne' : 'Injoignable'), depuis: null, aller: 'ext' });
    }
  }
  for (const p of probes.overview()) {
    for (const s of p.series) {
      if (s.level !== 'warn' && s.level !== 'crit') continue;
      const etiquettes = Object.values(s.labels || {}).join(' ');
      sortie.push({ niveau: s.level, element: p.instance, observation: `${p.name}${etiquettes ? ' · ' + etiquettes : ''} : ${s.value}${p.unit ? ' ' + p.unit : ''}`, depuis: s.ts || null, aller: 'probes' });
    }
  }
  for (const a of engine.pendingApprovals()) {
    sortie.push({ niveau: 'warn', element: a.workflow, observation: `Validation attendue : ${a.message}`, depuis: a.created, aller: 'dash' });
  }
  const echecs = db.all(`SELECT w.name nom, COUNT(*) n, MAX(e.started) dernier FROM executions e JOIN workflows w ON w.id = e.workflow_id
    WHERE e.status = 'error' AND e.started > ? GROUP BY w.id ORDER BY dernier DESC`, maintenant - 864e5);
  for (const e of echecs) sortie.push({ niveau: 'warn', element: e.nom, observation: `${e.n} exécution${e.n > 1 ? 's' : ''} en échec sur 24 h`, depuis: e.dernier, aller: 'wf' });
  for (const v of services.list().map(i => services.publicView(i)).filter(v => v.miseAJour)) {
    sortie.push({ niveau: 'info', element: v.name, observation: v.imageNeuve ? 'Nouvelle image construite sur la machine' : `Mise à jour ${v.miseAJour} disponible (installé : ${v.version})`, depuis: null, aller: 'ext' });
  }
  return sortie.sort((a, b) => RANG[a.niveau] - RANG[b.niveau] || (b.depuis || 0) - (a.depuis || 0));
}
