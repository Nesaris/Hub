// Les widgets de l'assistant : des tuiles, un graphique, un classement…
//
// Le modèle ne dessine rien et n'écrit aucun chiffre : il choisit un type
// (« activite », « stats »…), et c'est ici que le Hub va chercher les vraies
// valeurs dans sa base. Un graphique ne peut donc pas inventer une donnée.
// Le résultat est une photo prise au moment de la réponse, rangée avec elle.
import { fuseau } from '../manifest/template.js';

export const TYPES = {
  stats: 'Tuiles : workflows, services, exécutions et appels IA des dernières 24 h',
  activite: 'Graphique des exécutions par jour, réussies / en échec {jours?: 7|14|30, workflow?: "nom exact"}',
  classement: 'Les workflows qui tournent ou échouent le plus {par?: "executions"|"echecs", jours?: 7}',
  services: 'État de chaque service (en ligne, erreur…)',
  sondes: 'Dernière valeur et courbe 24 h de chaque sonde {service?: "nom"}',
  ia: 'Usage de l’IA par connexion : appels et jetons {jours?: 7}',
};

const JOUR = 86400e3;
const borne = (v, min, max, d) => Math.min(max, Math.max(min, Math.round(Number(v) || d)));
/* Un jour, c'est un jour dans le fuseau de l'utilisateur, pas en UTC. */
const cleJour = t => new Intl.DateTimeFormat('fr-CA', { timeZone: fuseau(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
const etiquetteJour = t => new Intl.DateTimeFormat('fr-FR', { timeZone: fuseau(), weekday: 'short', day: 'numeric' }).format(new Date(t));

export function construire(spec, agent) {
  const type = String(spec?.type || '').trim().toLowerCase();
  const f = FABRIQUES[type];
  if (!f) return null;
  try { return { type, ...f(spec, agent) }; } catch { return null; }
}

const FABRIQUES = {
  stats(_, { db, store, services, ai }) {
    const wfs = store.list();
    const liens = wfs.filter(w => (w.graph?.nodes || []).every(n => n.type === 'core.link')).length;
    const inst = services.list();
    const depuis = Date.now() - JOUR;
    const ex = db.get(`SELECT SUM(status='success') ok, SUM(status='error') ko, COUNT(*) n FROM executions WHERE started >= ?`, depuis) || {};
    const appels = db.get('SELECT COUNT(*) n FROM ai_usage WHERE ts >= ?', depuis)?.n || 0;
    const echec = wfs.filter(w => w.lastStatus === 'error').length;
    return {
      titre: 'Le Hub en un coup d’œil',
      tuiles: [
        { label: 'Workflows actifs', valeur: wfs.filter(w => w.enabled).length, sous: `sur ${wfs.length - liens}${liens ? ` · ${liens} lien${liens > 1 ? 's' : ''}` : ''}` },
        { label: 'En échec', valeur: echec, sous: 'au dernier passage', etat: echec ? 'err' : 'ok' },
        { label: 'Services en ligne', valeur: inst.filter(i => i.status === 'online').length, sous: `sur ${inst.length}`, etat: inst.some(i => i.status !== 'online') ? 'warn' : 'ok' },
        { label: 'Exécutions 24 h', valeur: ex.n || 0, sous: `${ex.ok || 0} réussies · ${ex.ko || 0} échec${ex.ko > 1 ? 's' : ''}` },
        { label: 'Appels IA 24 h', valeur: appels, sous: ai.list()[0]?.model || '' },
      ],
    };
  },

  activite(spec, { db, store }) {
    const jours = [7, 14, 30].includes(Number(spec.jours)) ? Number(spec.jours) : 7;
    const w = spec.workflow ? store.list().find(x => x.name === spec.workflow || x.name.toLowerCase() === String(spec.workflow).toLowerCase()) : null;
    const depuis = Date.now() - jours * JOUR;
    const lignes = db.all(`SELECT started, status FROM executions WHERE started >= ? ${w ? 'AND workflow_id = ?' : ''}`, depuis, ...(w ? [w.id] : []));
    const parJour = new Map();
    for (let i = jours - 1; i >= 0; i--) { const t = Date.now() - i * JOUR; parJour.set(cleJour(t), { jour: etiquetteJour(t), ok: 0, err: 0, autre: 0 }); }
    for (const l of lignes) {
      const j = parJour.get(cleJour(l.started)); if (!j) continue;
      if (l.status === 'success') j.ok++; else if (l.status === 'error') j.err++; else j.autre++;
    }
    const barres = [...parJour.values()];
    const total = barres.reduce((s, b) => s + b.ok + b.err + b.autre, 0);
    return { titre: `Exécutions — ${jours} derniers jours${w ? ` · ${w.name}` : ''}`, barres,
      total, ok: barres.reduce((s, b) => s + b.ok, 0), err: barres.reduce((s, b) => s + b.err, 0) };
  },

  classement(spec, { db, store }) {
    const par = spec.par === 'echecs' ? 'echecs' : 'executions';
    const jours = borne(spec.jours, 1, 90, 7);
    const noms = new Map(store.list().map(w => [w.id, w.name]));
    const lignes = db.all(`SELECT workflow_id id, COUNT(*) n, SUM(status='error') ko FROM executions WHERE started >= ? GROUP BY workflow_id`, Date.now() - jours * JOUR)
      .filter(l => noms.has(l.id)).map(l => ({ nom: noms.get(l.id), valeur: par === 'echecs' ? l.ko || 0 : l.n, echecs: l.ko || 0, total: l.n }))
      .filter(l => l.valeur > 0).sort((a, b) => b.valeur - a.valeur).slice(0, 6);
    return { titre: `${par === 'echecs' ? 'Workflows qui échouent le plus' : 'Workflows les plus actifs'} — ${jours} j`, par, lignes };
  },

  services(_, { services }) {
    return { titre: 'État des services', lignes: services.list().map(i => ({ nom: i.name, extension: i.ext_id, etat: i.status, detail: i.status_detail || '' })) };
  },

  sondes(spec, { probes }) {
    const vues = probes.overview().filter(p => !spec.service || p.instance === spec.service);
    const lignes = [];
    for (const p of vues) for (const s of p.series) {
      if (lignes.length >= 8) break;
      const cle = JSON.stringify(s.labels || {});
      const hist = probes.history(p.instanceId, p.id, { hours: 24 }).filter(h => JSON.stringify(h.labels || {}) === cle);
      const lab = Object.values(s.labels || {}).join(' · ');
      lignes.push({ nom: `${p.name}${lab ? ` — ${lab}` : ''}`, service: p.instance, valeur: s.value, unite: p.unit, niveau: s.level,
        points: hist.map(h => h.avg).filter(v => Number.isFinite(v)).slice(-48) });
    }
    return { titre: 'Sondes — 24 h', lignes };
  },

  ia(spec, { db, ai }) {
    const jours = borne(spec.jours, 1, 90, 7);
    const noms = new Map(ai.list().map(c => [c.id, `${c.name}${c.model ? ` · ${c.model}` : ''}`]));
    const lignes = db.all(`SELECT connection_id id, COUNT(*) n, SUM(tokens_in) tin, SUM(tokens_out) tout FROM ai_usage WHERE ts >= ? GROUP BY connection_id ORDER BY n DESC`, Date.now() - jours * JOUR)
      .map(l => ({ nom: noms.get(l.id) || 'connexion supprimée', appels: l.n, entree: l.tin || 0, sortie: l.tout || 0 }));
    return { titre: `Usage de l’IA — ${jours} j`, lignes };
  },
};

/* Ce qu'une demande appelle comme widgets, quand le modèle n'en a pas demandé. */
export function devine(texte, { sobre = false } = {}) {
  const t = String(texte || '');
  const out = [];
  // Sur Telegram (« sobre »), « combien de workflows ? » appelle une phrase, pas un tableau.
  if (/stat|tableau de bord|dashboard|vue d.ensemble|[ée]tat (g[ée]n[ée]ral|du hub)/i.test(t) || (!sobre && /combien.{0,30}workflows?/i.test(t))) out.push({ type: 'stats' });
  if (/activit[ée]|graph|courbe|historique|ex[ée]cutions? (par|de la|cette|du)|combien.{0,25}(ex[ée]cut|tourn)/i.test(t)) out.push({ type: 'activite', jours: /mois|30/i.test(t) ? 30 : /14|deux semaines/i.test(t) ? 14 : 7 });
  if (/(le plus|top|classement).{0,40}(tourn|ex[ée]cut|actif|[ée]chou|plant)/i.test(t)) out.push({ type: 'classement', par: /[ée]chou|plant|erreur/i.test(t) ? 'echecs' : 'executions' });
  if (/services?.{0,30}(en ligne|[ée]tat|statut|marche|tourne|up|down)|([ée]tat|statut)s? (de mes |des? |du )?services?/i.test(t)) out.push({ type: 'services' });
  // « mémoire » seul parle souvent de SYNAPSE, « charge » d'un modèle : on exige le contexte machine.
  if (/sondes?|\bcpu\b|\bram\b|m[ée]moire (des? |du )?(conteneurs?|services?|serveur|vm|machine)|utilisation (m[ée]moire|disque)|charge (cpu|syst[èe]me|serveur|machine)|espace disque/i.test(t)) out.push({ type: 'sondes' });
  if (/(usage|consommation|jetons|tokens|appels).{0,30}(ia|mod[èe]le|ollama|kimi)|combien.{0,20}(appels|jetons)/i.test(t)) out.push({ type: 'ia' });
  return out;
}

/* Le même widget en quelques lignes, pour Telegram qui n'affiche pas de graphique. */
export function enTexte(w) {
  if (!w) return '';
  const l = [`📊 ${w.titre}`];
  if (w.type === 'stats') for (const x of w.tuiles) l.push(`• ${x.label} : ${x.valeur}${x.sous ? ` (${x.sous})` : ''}`);
  if (w.type === 'activite') {
    l.push(`✅ ${w.ok} réussies · ❌ ${w.err} échecs · ${w.total} au total`);
    const max = Math.max(1, ...w.barres.map(b => b.ok + b.err + b.autre));
    for (const b of w.barres) { const n = b.ok + b.err + b.autre; l.push(`${b.jour.padEnd(7)} ${'▇'.repeat(Math.round(n / max * 10)) || '·'} ${n}${b.err ? ` (❌${b.err})` : ''}`); }
  }
  if (w.type === 'classement') w.lignes.forEach((x, i) => l.push(`${i + 1}. ${x.nom} — ${x.valeur}`));
  if (w.type === 'services') for (const x of w.lignes) l.push(`${x.etat === 'online' ? '🟢' : x.etat === 'error' ? '🔴' : '🟡'} ${x.nom} — ${x.etat}`);
  if (w.type === 'sondes') for (const x of w.lignes) l.push(`${x.niveau === 'crit' ? '🔴' : x.niveau === 'warn' ? '🟡' : '🟢'} ${x.nom} : ${x.valeur}${x.unite || ''}`);
  if (w.type === 'ia') for (const x of w.lignes) l.push(`• ${x.nom} : ${x.appels} appels · ${x.entree + x.sortie} jetons`);
  if (l.length === 1) l.push('Rien à montrer pour l’instant.');
  return l.join('\n');
}

/* Une phrase qui dit l'essentiel du widget, pour répondre sans le modèle. */
export function enPhrase(w) {
  const n = v => Number(v || 0).toLocaleString('fr-FR');
  if (w.type === 'services') {
    const ko = w.lignes.filter(l => l.etat !== 'online');
    if (!w.lignes.length) return 'Aucun service installé.';
    const liste = noms => noms.length > 1 ? `${noms.slice(0, -1).join(', ')} et ${noms.at(-1)}` : noms[0];
    const ok = w.lignes.filter(l => l.etat === 'online').map(l => l.nom);
    return ko.length
      ? `${w.lignes.length} services : ${ok.length ? `${liste(ok)} ${ok.length > 1 ? 'répondent' : 'répond'} normalement, ` : ''}${ko.map(l => `**${l.nom}** est ${l.etat === 'error' ? 'en erreur' : l.etat === 'offline' ? 'hors ligne' : l.etat}${l.detail ? ` (${l.detail})` : ''}`).join(', ')}.`
      : `Tes ${w.lignes.length} services sont en ligne : ${liste(ok)} répondent normalement.`;
  }
  if (w.type === 'stats') { const t = Object.fromEntries(w.tuiles.map(x => [x.label, x])); return `${t['Workflows actifs']?.valeur} workflows actifs (${t['Workflows actifs']?.sous}), ${t['En échec']?.valeur ? `**${t['En échec'].valeur} en échec**` : 'aucun en échec'}, ${t['Services en ligne']?.valeur} services en ligne ${t['Services en ligne']?.sous}.`; }
  if (w.type === 'activite') return w.total ? `${w.titre.replace(/^Exécutions — /, 'Sur les ')} : ${n(w.total)} exécutions, ${n(w.ok)} réussies, ${w.err ? `**${n(w.err)} échecs**` : 'aucun échec'}.` : 'Aucune exécution sur la période.';
  if (w.type === 'classement') return w.lignes.length ? (w.par === 'echecs' ? `Celui qui échoue le plus : **${w.lignes[0].nom}** (${n(w.lignes[0].valeur)} échecs).` : `Le plus actif : **${w.lignes[0].nom}** (${n(w.lignes[0].valeur)} exécutions).`) : (w.par === 'echecs' ? 'Aucun échec sur la période.' : 'Aucune exécution sur la période.');
  if (w.type === 'sondes') { const al = w.lignes.filter(l => l.niveau && l.niveau !== 'ok'); return !w.lignes.length ? 'Aucune sonde.' : al.length ? `${al.length} sonde${al.length > 1 ? 's' : ''} en alerte : ${al.map(l => `**${l.nom}** (${l.valeur}${l.unite || ''})`).join(', ')}.` : `Tes ${w.lignes.length} sondes sont normales.`; }
  if (w.type === 'ia') { const a = w.lignes.reduce((s, l) => s + l.appels, 0), j = w.lignes.reduce((s, l) => s + l.entree + l.sortie, 0); return a ? `${w.titre.replace(/^Usage de l’IA — /, 'Sur ')} : ${n(a)} appels à l’IA, ${n(j)} jetons.` : 'Aucun appel à l’IA sur la période.'; }
  return '';
}
