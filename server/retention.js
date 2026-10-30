// Conservation des données (SEC-PRIV-001) : ce qui n'a plus d'usage part, aux
// durées annoncées dans web/confidentialite.txt.
export const JOURS = { questions: 90, executions: 90, usageIa: 400, livraisons: 7, mesures: 31 };

export function purgerDonnees(db, audit, maintenant = Date.now()) {
  const avant = n => maintenant - n * 86400e3;
  return {
    questions: Number(db.run('DELETE FROM agent_plans WHERE created < ?', avant(JOURS.questions)).changes),
    executions: Number(db.run("DELETE FROM executions WHERE started < ? AND status NOT IN ('running', 'waiting')", avant(JOURS.executions)).changes),
    usageIa: Number(db.run('DELETE FROM ai_usage WHERE ts < ?', avant(JOURS.usageIa)).changes),
    livraisons: Number(db.run('DELETE FROM livraisons WHERE t < ?', avant(JOURS.livraisons)).changes),
    mesures: Number(db.run('DELETE FROM mesures WHERE t < ?', avant(JOURS.mesures)).changes) + Number(db.run('DELETE FROM mesures_groupes WHERE t < ?', avant(JOURS.mesures)).changes),
    journal: audit.purger(maintenant),
  };
}
