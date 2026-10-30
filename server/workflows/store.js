// Stockage, validation et versions des workflows.
import { NODE_DEFS, COMMON_SETTINGS, outputsOf } from './nodes.js';
import { HttpError, id } from '../util/common.js';

const MAX_NODES = 200;

/**
 * Remet en place un graphe mal disposé, en place.
 *
 * Un workflow écrit par un modèle arrive souvent sans coordonnées, avec
 * des « NaN », ou tous ses nœuds empilés au même endroit : l'éditeur
 * affichait alors une toile vide (« NaN % ») ou des nœuds cachés sous la
 * palette. Un graphe correctement placé n'est jamais touché ; un graphe
 * cassé est rangé en couches, de gauche à droite, depuis ses déclencheurs.
 * Renvoie vrai s'il a fallu le ranger.
 */
export function disposer(graph, { force = false } = {}) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  if (!nodes.length) return false;
  const fini = v => v !== null && v !== '' && Number.isFinite(Number(v));
  const mal = force || nodes.some(n => !fini(n.x) || !fini(n.y) || Number(n.x) < 0 || Number(n.y) < 0)
    || nodes.some((a, i) => nodes.some((b, j) => j > i && Math.abs(a.x - b.x) < 200 && Math.abs(a.y - b.y) < 70));
  if (!mal) return false;
  const ids = new Set(nodes.map(n => n.id));
  const liens = (graph.edges || []).filter(e => ids.has(e.from) && ids.has(e.to));
  const entrants = new Set(liens.map(e => e.to));
  const couche = new Map(nodes.filter(n => NODE_DEFS[n.type]?.trigger || !entrants.has(n.id)).map(n => [n.id, 0]));
  // Le plus long chemin depuis une source, borné : une boucle ne l'emballe pas.
  for (let tour = 0; tour < nodes.length; tour++) {
    let bouge = false;
    for (const e of liens) {
      const c = couche.get(e.from);
      if (c == null || c + 1 >= nodes.length) continue;
      if ((couche.get(e.to) ?? -1) < c + 1) { couche.set(e.to, c + 1); bouge = true; }
    }
    if (!bouge) break;
  }
  const rangs = new Map();
  for (const n of nodes) { const c = couche.get(n.id) ?? 0; rangs.set(c, [...(rangs.get(c) || []), n]); }
  const haut = Math.max(...[...rangs.values()].map(l => l.length));
  for (const [c, l] of rangs) l.forEach((n, i) => { n.x = 380 + c * 280; n.y = 160 + (i + (haut - l.length) / 2) * 150; });
  return true;
}

/**
 * Rend les noms de nœuds uniques, en place.
 *
 * Les noms servent d'adresse aux expressions `$node["…"]`. Deux nœuds
 * homonymes rendent donc l'expression ambiguë, et c'est le premier qui
 * l'emporte : on renomme les suivants, jamais le premier, pour qu'une
 * expression déjà écrite continue de désigner ce qu'elle désignait.
 */
export function nomsUniques(graph) {
  const nodes = graph.nodes || [];
  const base = n => String(n.name || '').slice(0, 54) || 'Nœud';
  // Les noms d'origine sont tous réservés : si un « Action de service 2 »
  // existe déjà plus loin, le renommage ne vient pas le lui prendre.
  const pris = new Set(nodes.map(base));
  const vus = new Set();
  const renommes = [];
  for (const n of nodes) {
    const b = base(n);
    if (!vus.has(b)) { vus.add(b); n.name = b; continue; }
    let i = 2, cand = `${b} ${i}`;
    while (vus.has(cand) || pris.has(cand)) cand = `${b} ${++i}`;
    renommes.push({ de: b, vers: cand });
    n.name = cand; vus.add(cand);
  }
  return renommes;
}

export class WorkflowStore {
  constructor({ db, vault, audit, bus, services }) { Object.assign(this, { db, vault, audit, bus, services }); }
  attach({ triggers }) { this.triggers = triggers; }

  row(r, { reveal = false } = {}) {
    if (!r) return null;
    const graph = JSON.parse(r.graph);
    return { id: r.id, name: r.name, origin: r.origin, autoKey: r.auto_key, enabled: !!r.enabled, version: r.version, dossier: r.dossier || '', created: r.created, updated: r.updated, graph: reveal ? this.openSecrets(graph) : this.maskSecrets(graph) };
  }
  list() {
    const stats = new Map(this.db.all(`SELECT workflow_id, COUNT(*) n, MAX(started) last, SUM(status='error') errors FROM executions GROUP BY workflow_id`).map(s => [s.workflow_id, s]));
    return this.db.all('SELECT * FROM workflows ORDER BY updated DESC').map(r => {
      const w = this.row(r); const s = stats.get(r.id) || {};
      const last = s.last ? this.db.get('SELECT status FROM executions WHERE workflow_id=? ORDER BY started DESC LIMIT 1', r.id) : null;
      return { ...w, runs: s.n || 0, lastRun: s.last || null, lastStatus: last?.status || null, errors: s.errors || 0, instances: this.instancesOf(w.graph) };
    });
  }
  get(wid, opts) {
    const r = this.row(this.db.get('SELECT * FROM workflows WHERE id=?', wid), opts);
    if (!r) throw new HttpError(404, 'Workflow introuvable');
    return r;
  }
  graphAt(wid, version) {
    const r = this.db.get('SELECT graph FROM workflow_versions WHERE workflow_id=? AND version=?', wid, version);
    if (!r) throw new HttpError(404, 'Version introuvable');
    return this.openSecrets(JSON.parse(r.graph));
  }
  instancesOf(graph) { return [...new Set(graph.nodes.map(n => n.instanceId).filter(Boolean))]; }

  // ---- secrets dans les paramètres ----
  secretKeys(node) {
    const def = this.defOf(node);
    return (def?.params || []).filter(f => f.type === 'secret').map(f => f.key);
  }
  sealSecrets(graph, previous) {
    const prev = new Map((previous?.nodes || []).map(n => [n.id, n]));
    for (const n of graph.nodes) for (const k of this.secretKeys(n)) {
      const v = n.params?.[k];
      if (v == null || v === '') continue;
      if (String(v).startsWith('•')) n.params[k] = prev.get(n.id)?.params?.[k] ?? '';
      else if (!String(v).startsWith('v1:')) n.params[k] = this.vault.seal(v);
    }
    return graph;
  }
  maskSecrets(graph) {
    const g = structuredClone(graph);
    for (const n of g.nodes) for (const k of this.secretKeys(n)) if (n.params?.[k]) n.params[k] = '••• défini';
    return g;
  }
  openSecrets(graph) {
    const g = structuredClone(graph);
    for (const n of g.nodes) for (const k of this.secretKeys(n)) if (String(n.params?.[k] || '').startsWith('v1:')) n.params[k] = this.vault.open(n.params[k]);
    return g;
  }

  defOf(node) {
    if (node.type === 'trigger.service' || node.type === 'service.action') {
      let inst; try { inst = this.services.get(node.instanceId); } catch { return null; }
      const list = node.type === 'trigger.service' ? inst.manifest.triggers : inst.manifest.actions;
      const d = list.find(x => x.id === node.ref);
      return d ? { ...NODE_DEFS[node.type], params: d.params || [], manifestDef: d, instance: inst } : null;
    }
    return NODE_DEFS[node.type] || null;
  }

  /* Un problème doit dire quoi corriger. « Service ou élément de service
     introuvable » ne le disait pas : ni à l'utilisateur, ni au modèle à qui
     l'on renvoie le plan, qui recopiait alors la même erreur. On nomme le
     nœud, ce qui manque, et ce qui existe. */
  introuvable(n) {
    const liste = (a, max = 10) => a.slice(0, max).join(', ') + (a.length > max ? '…' : '');
    // Retiré : il exécutait du code arbitraire dans le processus du Hub (manuel, SEC-INJ-006).
    if (n.type === 'data.script') return `« ${n.name || n.id} » : le nœud Script JS n’existe plus — il exécutait du code arbitraire sur le serveur. Remplace-le par « Champs », « Condition » ou une expression {{ }}.`;
    if (n.type !== 'trigger.service' && n.type !== 'service.action') {
      const types = Object.keys(NODE_DEFS).filter(k => NODE_DEFS[k].cat !== 'hidden' && !NODE_DEFS[k].service);
      // Le cas courant : le modèle voulait appeler un service et a inventé
      // un type. On lui donne la forme exacte et ce qui existe vraiment.
      const actions = this.services.list().flatMap(i => (i.manifest.actions || []).map(a => `${i.name} (instanceId ${i.id}) › ${a.id}`));
      return `« ${n.name || n.id} » : type inconnu « ${n.type} ». Pour appeler un service : type « service.action », instanceId = id du service, ref = id de l'action${actions.length ? ` — ${liste(actions, 8)}` : ''}. Types intégrés : ${liste(types, 14)}`;
    }
    let inst = null;
    try { inst = n.instanceId ? this.services.get(n.instanceId) : null; } catch { inst = null; }
    const tous = this.services.list();
    if (!inst) return `« ${n.name || n.id} » : aucun service « ${n.instanceId || '(vide)'} ». instanceId doit être l'id d'un service installé : ${liste(tous.map(i => `${i.name} = ${i.id}`))}`;
    const trig = n.type === 'trigger.service';
    const dispo = (trig ? inst.manifest.triggers : inst.manifest.actions).map(x => x.id);
    return `« ${n.name || n.id} » : ${inst.name} n'a pas ${trig ? 'de déclencheur' : 'd’action'} « ${n.ref || '(vide)'} ». ${trig ? 'Déclencheurs' : 'Actions'} de ${inst.name} : ${liste(dispo) || 'aucun'}`;
  }

  /* Ce qu'un paramètre requis peut recevoir : les champs que le
     déclencheur fournit. Sans eux, le modèle laissait le champ vide — il
     ne savait pas que l'appareil de l'alerte s'écrit {{ $trigger.device }}. */
  donneesDispo(graph) {
    const champs = new Set();
    const aplatit = (o, pre) => {
      for (const [k, v] of Object.entries(o || {})) {
        if (v && typeof v === 'object' && !Array.isArray(v) && pre.split('.').length < 2) aplatit(v, `${pre}${k}.`);
        else champs.add(`{{ $trigger.${pre}${k} }}`);
      }
    };
    for (const n of graph.nodes || []) {
      if (n.type !== 'trigger.service') continue;
      let d = null;
      try { d = this.services.get(n.instanceId).manifest.triggers.find(t => t.id === n.ref); } catch { d = null; }
      if (d?.sample) aplatit(d.sample, '');
    }
    const l = [...champs];
    return l.length ? ` — donne une valeur fixe ou une expression, par exemple : ${l.slice(0, 8).join(', ')}${l.length > 8 ? '…' : ''}` : '';
  }

  sansDeclencheur() {
    const integres = Object.keys(NODE_DEFS).filter(k => NODE_DEFS[k].trigger && !NODE_DEFS[k].service);
    const services = this.services.list().flatMap(i => (i.manifest.triggers || []).map(t => `${i.name} › ${t.id}`));
    return `Ajoute au moins un déclencheur : ${integres.join(', ')}${services.length ? ` — ou trigger.service : ${services.slice(0, 8).join(', ')}` : ''}.`;
  }

  validate(graph, { forEnable = false } = {}) {
    const problems = [];
    if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new HttpError(400, 'Graphe invalide');
    if (graph.nodes.length > MAX_NODES) throw new HttpError(400, `Au plus ${MAX_NODES} nœuds`);
    const byId = new Map();
    for (const n of graph.nodes) {
      if (!n.id || byId.has(n.id)) throw new HttpError(400, `Identifiant de nœud manquant ou en double : ${n.id}`);
      byId.set(n.id, n);
      n.params ||= {};
      n.name = String(n.name || NODE_DEFS[n.type]?.name || n.type).slice(0, 60);
      const def = this.defOf(n);
      if (!def) { problems.push({ node: n.id, message: this.introuvable(n) }); continue; }
      if (forEnable) for (const f of def.params) {
        const v = n.params[f.key];
        if (f.required && (v === undefined || v === '' || v === null) && f.default === undefined) problems.push({ node: n.id, message: `${n.name} : « ${f.label} » (${f.key}) est requis${this.donneesDispo(graph)}` });
      }
    }
    const names = graph.nodes.map(n => n.name);
    const dup = names.find((x, i) => names.indexOf(x) !== i);
    // `fix` dit à l'éditeur qu'il sait réparer ça tout seul : il affiche un
    // bouton au lieu de laisser l'utilisateur chercher lequel renommer.
    if (dup) problems.push({ fix: 'noms', message: `Deux nœuds portent le nom « ${dup} ». Les noms servent aux expressions $node["…"] : renomme-en un.` });
    for (const e of graph.edges) {
      if (!byId.has(e.from) || !byId.has(e.to)) throw new HttpError(400, 'Lien vers un nœud inexistant');
      e.port ||= 'main';
      const to = byId.get(e.to);
      if (NODE_DEFS[to.type]?.trigger) problems.push({ node: to.id, message: `${to.name} est un déclencheur : il ne peut pas recevoir de lien` });
      const from = byId.get(e.from);
      const outs = outputsOf(from, this.defOf(from) || NODE_DEFS[from.type]);
      if (!outs.includes(e.port)) problems.push({ node: from.id, message: `${from.name} n’a pas de sortie « ${e.port} »` });
    }
    // cycles
    const adj = new Map(graph.nodes.map(n => [n.id, []]));
    graph.edges.forEach(e => adj.get(e.from).push(e.to));
    const color = new Map();
    const dfs = u => { color.set(u, 1); for (const v of adj.get(u)) { if (color.get(v) === 1) return true; if (!color.get(v) && dfs(v)) return true; } color.set(u, 2); return false; };
    if (graph.nodes.some(n => !color.get(n.id) && dfs(n.id))) problems.push({ message: 'Le workflow contient une boucle. Utilise un sous-workflow pour répéter une étape.' });
    const triggers = graph.nodes.filter(n => NODE_DEFS[n.type]?.trigger);
    if (forEnable) {
      if (!triggers.length && !graph.nodes.every(n => n.type === 'core.link')) problems.push({ message: this.sansDeclencheur() });
      // actions destructives : validation humaine obligatoire sur tous les chemins
      for (const n of graph.nodes) {
        const d = this.defOf(n);
        if (n.type !== 'service.action' || d?.manifestDef?.risk !== 'destructive') continue;
        const unsafe = (u, seen = new Set()) => {
          if (u === n.id) return true;
          if (seen.has(u)) return false; seen.add(u);
          if (byId.get(u).type === 'logic.approval') return false;
          return graph.edges.filter(e => e.from === u).some(e => unsafe(e.to, seen));
        };
        if (triggers.some(t => unsafe(t.id))) problems.push({ node: n.id, message: `${n.name} est destructive : place une « Validation humaine » avant elle.` });
      }
    }
    return problems;
  }

  /**
   * Un nom de workflow libre, suffixé si besoin. Deux workflows homonymes
   * sont indiscernables dans la liste, dans le journal et dans le nœud
   * « Sous-workflow » : mieux vaut un « 2 » qu'une ambiguïté.
   */
  nomLibre(name) {
    const base = String(name || 'Nouveau workflow').slice(0, 76).trim() || 'Nouveau workflow';
    const pris = new Set(this.db.all('SELECT name FROM workflows').map(r => r.name));
    if (!pris.has(base)) return base;
    let i = 2; while (pris.has(`${base} ${i}`)) i++;
    return `${base} ${i}`;
  }

  create({ name, graph, origin = 'Manuel', autoKey = null }, actor) {
    nomsUniques(graph);
    disposer(graph);
    const problems = this.validate(graph);
    const wid = id('w_');
    const t = Date.now();
    const sealed = this.sealSecrets(graph);
    name = this.nomLibre(name);
    this.db.tx(() => {
      this.db.run('INSERT INTO workflows(id,name,origin,auto_key,enabled,version,graph,created,updated) VALUES(?,?,?,?,0,1,?,?,?)', wid, name, origin, autoKey, JSON.stringify(sealed), t, t);
      this.db.run('INSERT INTO workflow_versions VALUES(?,?,?,?,?)', wid, 1, JSON.stringify(sealed), actor, t);
    });
    this.audit.write(actor, 'workflow.créé', name, { id: wid, origine: origin });
    this.bus.emit('workflow', { id: wid });
    return { workflow: this.get(wid), problems };
  }

  async update(wid, { name, graph }, actor) {
    const cur = this.db.get('SELECT * FROM workflows WHERE id=?', wid);
    if (!cur) throw new HttpError(404, 'Workflow introuvable');
    let g = JSON.parse(cur.graph), version = cur.version;
    if (graph) {
      disposer(graph);
      const problems = this.validate(graph, { forEnable: !!cur.enabled });
      if (cur.enabled && problems.length) throw new HttpError(400, 'Corrige ces points ou désactive le workflow avant d’enregistrer', problems);
      g = this.sealSecrets(graph, g);
      version++;
    }
    const nm = name ? String(name).slice(0, 80) : cur.name;
    this.db.tx(() => {
      this.db.run('UPDATE workflows SET name=?, graph=?, version=?, updated=? WHERE id=?', nm, JSON.stringify(g), version, Date.now(), wid);
      if (graph) this.db.run('INSERT INTO workflow_versions VALUES(?,?,?,?,?)', wid, version, JSON.stringify(g), actor, Date.now());
    });
    this.audit.write(actor, 'workflow.modifié', nm, { id: wid, version });
    if (cur.enabled && graph) { await this.triggers.deactivate(wid); await this.triggers.activate(wid); }
    this.bus.emit('workflow', { id: wid });
    return { workflow: this.get(wid), problems: graph ? this.validate(graph, { forEnable: true }) : [] };
  }

  /**
   * Au démarrage : les workflows déjà enregistrés mal disposés sont rangés
   * une fois, sans nouvelle version — seules les positions changent.
   */
  remettreEnPlace() {
    let n = 0;
    for (const r of this.db.all('SELECT id, name, graph FROM workflows')) {
      let g; try { g = JSON.parse(r.graph); } catch { continue; }
      if (!disposer(g)) continue;
      this.db.run('UPDATE workflows SET graph=? WHERE id=?', JSON.stringify(g), r.id);
      this.audit.write('hub', 'workflow.rangé', r.name, { id: r.id });
      n++;
    }
    return n;
  }

  /**
   * Répare les noms de nœuds en double, et enregistre.
   *
   * Le renommage ne touche qu'aux étiquettes, jamais à la topologie : il est
   * donc sûr à appliquer d'un clic, et il produit une version comme n'importe
   * quelle modification — elle se défait par l'historique du workflow.
   */
  reparerNoms(wid, actor) {
    const w = this.get(wid, { reveal: true });
    const renommes = nomsUniques(w.graph);
    if (!renommes.length) return { renommes: [], workflow: this.get(wid) };
    const g = this.sealSecrets(w.graph, JSON.parse(this.db.get('SELECT graph FROM workflows WHERE id=?', wid).graph));
    const version = w.version + 1;
    const t = Date.now();
    this.db.tx(() => {
      this.db.run('UPDATE workflows SET graph=?, version=?, updated=? WHERE id=?', JSON.stringify(g), version, t, wid);
      this.db.run('INSERT INTO workflow_versions VALUES(?,?,?,?,?)', wid, version, JSON.stringify(g), actor, t);
    });
    this.audit.write(actor, 'workflow.noms_réparés', w.name, { id: wid, renommés: renommes });
    this.bus.emit('workflow', { id: wid });
    return { renommes, workflow: this.get(wid) };
  }

  async setEnabled(wid, enabled, actor) {
    const w = this.get(wid, { reveal: true });
    if (enabled) {
      if (w.graph.nodes.every(n => n.type === 'core.link')) throw new HttpError(400, 'Ce lien décrit une dépendance entre services, il n’a rien à exécuter.');
      const problems = this.validate(w.graph, { forEnable: true });
      if (problems.length) throw new HttpError(400, 'Impossible d’activer ce workflow', problems);
      await this.triggers.activate(wid);
    } else await this.triggers.deactivate(wid);
    this.db.run('UPDATE workflows SET enabled=?, updated=? WHERE id=?', enabled ? 1 : 0, Date.now(), wid);
    this.audit.write(actor, enabled ? 'workflow.activé' : 'workflow.coupé', w.name, { id: wid });
    this.bus.emit('workflow', { id: wid });
    return this.get(wid);
  }

  async remove(wid, actor) {
    const w = this.get(wid);
    await this.triggers.deactivate(wid);
    this.db.run('DELETE FROM workflows WHERE id=?', wid);
    this.audit.write(actor, 'workflow.supprimé', w.name, { id: wid });
    this.bus.emit('workflow', { id: wid, removed: true });
  }

  /* ---------- dossiers ----------
     Un chemin court, « MapMyLAN / Alertes » : trois niveaux au plus, des
     noms lisibles. Ranger ne touche ni au graphe ni à l'activation — c'est
     un classement, pas une modification du workflow. */
  static cheminValide(brut) {
    const parties = String(brut ?? '').split('/').map(s => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
    if (parties.length > 3) throw new HttpError(400, 'Trois niveaux de dossiers au plus.');
    for (const p of parties) {
      if (!/^[\p{L}\p{N}][\p{L}\p{N} ._'’&()-]{0,39}$/u.test(p)) throw new HttpError(400, `Nom de dossier invalide : « ${p} » (40 caractères, lettres, chiffres, espace, . _ - ’ & ( )).`);
    }
    return parties.join(' / ');
  }

  dossiers() {
    const tous = new Set(this.db.all('SELECT chemin FROM workflow_dossiers').map(r => r.chemin));
    for (const r of this.db.all("SELECT DISTINCT dossier FROM workflows WHERE dossier <> ''")) tous.add(r.dossier);
    // Les parents existent dès qu'un enfant existe : « MapMyLAN » pour « MapMyLAN / Alertes ».
    for (const c of [...tous]) { const p = c.split(' / '); for (let i = 1; i < p.length; i++) tous.add(p.slice(0, i).join(' / ')); }
    return [...tous].sort((a, b) => a.localeCompare(b, 'fr'));
  }

  creerDossier(brut, actor) {
    const chemin = WorkflowStore.cheminValide(brut);
    if (!chemin) throw new HttpError(400, 'Nom de dossier requis.');
    this.db.run('INSERT INTO workflow_dossiers(chemin, created) VALUES(?, ?) ON CONFLICT(chemin) DO NOTHING', chemin, Date.now());
    this.audit.write(actor, 'dossier.créé', chemin);
    this.bus.emit('workflow', { dossier: chemin });
    return { chemin };
  }

  /** Ranger plusieurs workflows d'un coup : c'est ce que fait l'IA. */
  ranger(affectations, actor) {
    const faits = [];
    this.db.tx(() => {
      for (const a of affectations || []) {
        const w = this.db.get('SELECT id, name, dossier FROM workflows WHERE id=? OR name=?', a.id ?? a.workflow, a.id ?? a.workflow);
        if (!w) throw new HttpError(404, `Workflow introuvable : ${a.id ?? a.workflow}`);
        const chemin = WorkflowStore.cheminValide(a.dossier);
        if (w.dossier === chemin) continue;
        this.db.run('UPDATE workflows SET dossier=? WHERE id=?', chemin, w.id);
        faits.push({ id: w.id, nom: w.name, de: w.dossier, vers: chemin });
      }
    });
    if (faits.length) {
      this.audit.write(actor, 'workflows.rangés', `${faits.length} workflow(s)`, { vers: [...new Set(faits.map(f => f.vers || '(racine)'))] });
      this.bus.emit('workflow', { ranges: faits.length });
    }
    return { deplaces: faits };
  }

  renommerDossier(de, vers, actor) {
    const a = WorkflowStore.cheminValide(de), b = WorkflowStore.cheminValide(vers);
    if (!a) throw new HttpError(400, 'Dossier d’origine requis.');
    // « _ » est permis dans un nom de dossier : échappé, il ne joue pas le joker de LIKE.
    const sous = `${a.replace(/[\\%_]/g, '\\$&')} / %`;
    this.db.tx(() => {
      for (const w of this.db.all("SELECT id, dossier FROM workflows WHERE dossier = ? OR dossier LIKE ? ESCAPE '\\'", a, sous)) {
        this.db.run('UPDATE workflows SET dossier=? WHERE id=?', WorkflowStore.cheminValide(b + w.dossier.slice(a.length)), w.id);
      }
      for (const d of this.db.all("SELECT chemin FROM workflow_dossiers WHERE chemin = ? OR chemin LIKE ? ESCAPE '\\'", a, sous)) {
        this.db.run('DELETE FROM workflow_dossiers WHERE chemin=?', d.chemin);
        const n = WorkflowStore.cheminValide(b + d.chemin.slice(a.length));
        if (n) this.db.run('INSERT INTO workflow_dossiers(chemin, created) VALUES(?, ?) ON CONFLICT(chemin) DO NOTHING', n, Date.now());
      }
    });
    this.audit.write(actor, 'dossier.renommé', a, { vers: b });
    this.bus.emit('workflow', { dossier: b });
    return { chemin: b };
  }

  /** Supprimer un dossier ne supprime aucun workflow : ils remontent d'un niveau. */
  supprimerDossier(brut, actor) {
    const a = WorkflowStore.cheminValide(brut);
    if (!a) throw new HttpError(400, 'Dossier requis.');
    const parent = a.split(' / ').slice(0, -1).join(' / ');
    return this.renommerDossier(a, parent, actor);
  }

  versions(wid) { return this.db.all('SELECT version, author, created FROM workflow_versions WHERE workflow_id=? ORDER BY version DESC', wid); }
  async restore(wid, version, actor) { return this.update(wid, { graph: this.graphAt(wid, version) }, actor); }

  exportJson(wid) {
    const w = this.get(wid);
    return { format: 'hub-workflow/1', name: w.name, graph: this.maskSecrets(w.graph) };
  }
}

export { COMMON_SETTINGS };
