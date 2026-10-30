// Ranger les workflows dans des dossiers : « MapMyLAN / Alertes ».
//
// La proposition se calcule sans modèle, en quelques millisecondes : un
// dossier par service (celui que le workflow sert), puis un sous-dossier par
// rôle. L'assistant la présente comme un plan ; rien ne bouge avant qu'on la
// valide. Pour un rangement sur mesure (« mets les alertes dans Urgent »),
// c'est le modèle qui écrit les affectations, avec le même outil.

const ROLES = [
  ['Alertes', /alerte|critique|triage|incident|urgen|notifi|pr[ée]vien/i],
  ['Défense', /quarantaine|bloqu|isol|d[ée]fense|bann|intrus/i],
  ['Surveillance', /scan|balayage|statistique|rapport|journal|surveill|sonde|sant[ée]|analyse|inventaire/i],
];

/** Le rôle d'un workflow, lu dans son nom ; un lien entre services est un lien. */
export function roleDe(w) {
  if (w.graph?.nodes?.length && w.graph.nodes.every(n => n.type === 'core.link')) return 'Liens';
  for (const [role, re] of ROLES) if (re.test(w.name)) return role;
  return 'Automatisation';
}

/**
 * Le dossier proposé pour chaque workflow.
 *
 * @param workflows  la liste du store (avec `instances`, dans l'ordre des nœuds)
 * @param instances  les services installés (id, name, manifest.name)
 * @param tous       re-ranger aussi ceux qui sont déjà dans un dossier
 */
export function proposerRangement(workflows, instances, { tous = false } = {}) {
  const nomService = id => {
    const i = instances.find(x => x.id === id);
    return i ? (i.manifest?.name || i.name) : null;
  };
  const out = [];
  for (const w of workflows) {
    if (w.dossier && !tous) continue;
    const ids = w.instances || [];
    // Un lien appartient à celui qui consomme (le dernier nœud) ; le reste, au premier service qu'il touche.
    const lien = roleDe(w) === 'Liens';
    const service = nomService(lien ? ids.at(-1) : ids[0]) || 'Hub';
    const dossier = `${service} / ${roleDe(w)}`;
    if (dossier !== w.dossier) out.push({ workflow: w.name, id: w.id, dossier });
  }
  return out;
}

/** Une phrase par dossier : « MapMyLAN / Alertes : 3 (Triage…, Gestion…) ». */
export function resumeRangement(affectations) {
  const par = new Map();
  for (const a of affectations) par.set(a.dossier, [...(par.get(a.dossier) || []), a.workflow]);
  return [...par].sort((a, b) => a[0].localeCompare(b[0], 'fr'))
    .map(([d, l]) => `- **${d}** : ${l.length} — ${l.slice(0, 3).join(', ')}${l.length > 3 ? '…' : ''}`).join('\n');
}
