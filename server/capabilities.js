// Liens entre services par capacités. Règle : tout lien devient un workflow visible.
import { id, log } from './util/common.js';
import { champsIA, etatIA } from './choix-ia.js';

const CORE_ALIASES = { 'set-fields': 'data.set', 'filter': 'logic.filter', 'condition': 'logic.if', 'dedupe': 'logic.dedupe', 'wait': 'logic.wait', 'notify': 'out.ntfy', 'log': 'out.log', 'summarize': 'ai.summarize' };

/* Les capacités que le Hub fournit lui-même, par ses connexions IA
   (page IA) : Ollama, Kimi, OpenAI, Claude… Un workflow automatique
   qui en a besoin passe par un nœud « IA » du Hub plutôt que d'appeler un
   service en direct : changer de fournisseur se fait alors à un seul
   endroit, et un service qui veut une IA de conversation l'a même sans
   Ollama installé. */
export const IA_DU_HUB = 'hub-ia';
const CAPS_HUB = ['llm.chat'];

const EVENEMENTS = new Set(['alerts.source']);

export class Capabilities {
  constructor({ db, bus, audit, services, store, ai = null }) { Object.assign(this, { db, bus, audit, services, store, ai }); }
  attach({ ai }) { this.ai = ai; }

  iaDuHub() {
    let n = 0; try { n = this.ai?.list().length || 0; } catch { n = 0; }
    return n ? { id: IA_DU_HUB, name: 'IA du Hub', manifest: { name: 'IA du Hub', capabilities: { provides: CAPS_HUB }, actions: [] } } : null;
  }

  /* Le nœud IA qui remplace l'appel à un service de conversation. Il garde
     le NOM du nœud d'origine : des expressions $node["…"] peuvent y
     renvoyer. Le modèle n'est plus fixé ici : c'est la connexion IA du rôle
     « workflows » qui décide. */
  noeudIA(params = {}, base = {}) {
    return {
      ...base, type: 'ai.chat', instanceId: undefined, ref: undefined,
      params: {
        system: params.system || '',
        prompt: params.prompt || '{{ $json | json }}',
        json: params.format === 'json' || params.json === true,
        temperature: params.temperature === '' || params.temperature == null ? 0.3 : Number(params.temperature),
      },
    };
  }

  workflowsUsing(instId) {
    return this.db.all('SELECT id, name, origin, graph FROM workflows').filter(w => JSON.parse(w.graph).nodes.some(n => n.instanceId === instId)).map(({ graph, ...w }) => w);
  }

  // Appelé après l'ajout d'une instance, et à chaque reprise de manifeste :
  // crée les liens dans les deux sens. Idempotent — un lien déjà posé et un
  // workflow déjà créé sont reconnus et laissés tels quels — ce qui permet de
  // le rejouer quand une nouvelle version d'un manifeste déclare une capacité
  // qu'elle ne déclarait pas. Sans cela, un `accepts` ajouté après coup
  // n'aurait jamais donné son workflow.
  onAdded(inst, actor, { annonce = true } = {}) {
    const made = [];
    const others = this.services.list().filter(o => o.id !== inst.id && o.status !== 'installing');
    const providers = { ...inst.providers };
    for (const o of others) {
      made.push(...this.link(inst, o, providers, actor));
      const op = { ...o.providers };
      const back = this.link(o, inst, op, actor);
      if (back.length) this.db.run('UPDATE instances SET providers=? WHERE id=?', JSON.stringify(op), o.id);
      made.push(...back);
    }
    made.push(...this.lierIADuHub(inst, providers));
    this.db.run('UPDATE instances SET providers=? WHERE id=?', JSON.stringify(providers), inst.id);
    // L'événement annonce une arrivée : il n'a pas lieu d'être quand on ne fait
    // que reprendre le manifeste d'un service déjà là.
    if (annonce) this.bus.emit('hub.event', { event: 'service.added', instanceId: inst.id, name: inst.name });
    // Un Ollama qui arrive, un service qui choisit son IA : les liens d'IA suivent.
    this.refletIA = this.refleterToutIA(actor);
    return made;
  }

  // consumer utilise (requires/accepts) ce que provider fournit
  link(consumer, provider, providers, actor) {
    const made = [];
    const cm = consumer.manifest, pm = provider.manifest;
    // Ce que le service demande — et ce que ses workflows automatiques attendent
    // (un « when » vaut un « accepts » : déclarer un workflow pour une capacité,
    // c'est l'accepter).
    const wants = [...new Set([...(cm.capabilities.requires || []), ...(cm.capabilities.accepts || []), ...(cm.autoWorkflows || []).map(a => a.when).filter(Boolean)])];
    for (const cap of wants) {
      if (!(pm.capabilities.provides || []).includes(cap)) continue;
      // Une capacité se prend chez un seul fournisseur — sauf une source
      // d'événements : les alertes de chaque service qui en émet comptent,
      // et chacun a son lien (son workflow).
      const deja = providers[cap];
      if (deja && !EVENEMENTS.has(cap)) continue; // déjà servi par une autre instance
      const secondaire = !!deja && deja !== provider.id;
      if (!deja) providers[cap] = provider.id;
      const autos = (cm.autoWorkflows || []).filter(a => a.when === cap);
      if (autos.length) {
        made.push(...this.creerAutos(consumer, provider, cap, { secondaire }));
      } else if (cap === 'llm.chat' && champsIA(cm)) {
        // Un service qui choisit son IA a son propre lien, qui dit laquelle : refleterIA.
      } else {
        const key = `${consumer.id}:${cap}:${provider.id}`;
        if (this.db.get('SELECT 1 FROM workflows WHERE auto_key=?', key)) continue;
        const graph = {
          nodes: [
            { id: 'p', type: 'core.link', name: `${provider.name} fournit ${cap}`, instanceId: provider.id, params: { note: `${pm.name} fournit ${cap}` }, x: 360, y: 200 },
            { id: 'c', type: 'core.link', name: `${consumer.name} l’utilise`, instanceId: consumer.id, params: { note: `${cm.name} utilise ${cap}` }, x: 660, y: 200 },
          ],
          edges: [{ from: 'p', port: 'main', to: 'c' }],
        };
        const { workflow } = this.store.create({ name: `${consumer.name} utilise ${cap} de ${provider.name}`, graph, origin: 'Auto', autoKey: key }, 'hub');
        made.push(workflow);
      }
      this.audit.write(actor, 'capacité.liée', cap, { fournisseur: provider.name, consommateur: consumer.name });
    }
    return made;
  }

  /* Les workflows qu'un service déclare pour cette capacité, s'ils
     n'existent pas déjà. Idempotent : c'est ce qui permet de les recréer
     après une suppression sans dupliquer ceux qui sont restés. */
  creerAutos(consumer, provider, cap, { secondaire = false } = {}) {
    const made = [];
    for (const a of (consumer.manifest.autoWorkflows || []).filter(x => x.when === cap)) {
      // Le premier fournisseur garde la clé d'origine ; un second (source
      // d'événements) a la sienne, et son nom dit d'où viennent les événements.
      const key = secondaire ? `${consumer.id}:${a.id}@${provider.id}` : `${consumer.id}:${a.id}`;
      if (this.db.get('SELECT 1 FROM workflows WHERE auto_key=?', key)) continue;
      const graph = this.buildAuto(a, consumer, provider);
      if (!graph) continue;
      const { workflow } = this.store.create({ name: secondaire ? `${a.name} (${provider.name})` : a.name, graph, origin: 'Auto', autoKey: key }, 'hub');
      made.push(workflow);
      // activation immédiate, silencieuse si le service ne le permet pas encore
      this.store.setEnabled(workflow.id, true, 'hub').catch(e => this.audit.write('hub', 'workflow.activation_reportée', a.name, { erreur: e.message }));
    }
    return made;
  }

  /* Ce qu'un service veut et que l'IA du Hub peut lui donner, quand aucun
     service ne le fournit. */
  lierIADuHub(inst, providers) {
    const ia = this.iaDuHub();
    if (!ia) return [];
    const made = [];
    const wants = [...(inst.manifest.capabilities.requires || []), ...(inst.manifest.capabilities.accepts || [])];
    for (const cap of wants) {
      if (!CAPS_HUB.includes(cap) || providers[cap]) continue;
      if (!(inst.manifest.autoWorkflows || []).some(a => a.when === cap)) continue;
      providers[cap] = IA_DU_HUB;
      made.push(...this.creerAutos(inst, ia, cap));
    }
    return made;
  }

  /* À rejouer quand une connexion IA apparaît : les services qui voulaient
     une IA de conversation sans en trouver l'ont maintenant. */
  rejouerIA() {
    const made = [];
    for (const inst of this.services.list()) {
      const providers = { ...inst.providers };
      const m = this.lierIADuHub(inst, providers);
      if (m.length) { this.db.run('UPDATE instances SET providers=? WHERE id=?', JSON.stringify(providers), inst.id); made.push(...m); }
    }
    return made;
  }

  /**
   * Recrée les workflows automatiques d'un service qui ont été supprimés.
   * Rien n'est touché de ceux qui existent encore.
   */
  recreer(idOrName, actor) {
    const inst = this.services.get(idOrName);
    const providers = { ...inst.providers };
    const made = [];
    for (const [cap, pid] of Object.entries(providers)) {
      let provider = null;
      if (pid === IA_DU_HUB) provider = this.iaDuHub();
      else { try { provider = this.services.get(pid); } catch { provider = null; } }
      if (provider) made.push(...this.creerAutos(inst, provider, cap));
    }
    made.push(...this.lierIADuHub(inst, providers));
    this.db.run('UPDATE instances SET providers=? WHERE id=?', JSON.stringify(providers), inst.id);
    this.audit.write(actor, 'workflows.recréés', inst.name, { workflows: made.map(w => w.name) });
    return { recrees: made.map(w => w.name) };
  }

  /**
   * Fait passer les workflows automatiques par l'IA du Hub.
   *
   * Un workflow auto qui appelait l'action « chat » d'un service (Ollama)
   * voit ce nœud remplacé par un nœud IA : même nom, même place, mêmes
   * liens. Rejoué au démarrage et quand une connexion IA apparaît ; ne fait
   * rien sans connexion IA, ni sur un workflow déjà converti.
   */
  async versIADuHub(actor = 'hub') {
    if (!this.iaDuHub()) return [];
    const convertis = [];
    for (const w of this.db.all(`SELECT id FROM workflows WHERE origin='Auto'`)) {
      let wf; try { wf = this.store.get(w.id, { reveal: true }); } catch { continue; }
      let change = false;
      const nodes = wf.graph.nodes.map(n => {
        if (n.type !== 'service.action') return n;
        let inst; try { inst = this.services.get(n.instanceId); } catch { return n; }
        const d = (inst.manifest.actions || []).find(a => a.id === n.ref);
        if (!CAPS_HUB.includes(d?.capability)) return n;
        change = true;
        const { instanceId, ref, ...reste } = n;
        return this.noeudIA(n.params, reste);
      });
      if (!change) continue;
      try {
        await this.store.update(w.id, { graph: { ...wf.graph, nodes } }, actor);
        convertis.push(wf.name);
      } catch (e) { this.audit.write(actor, 'workflow.conversion_ia_échec', wf.name, { erreur: e.message }); }
    }
    if (convertis.length) this.audit.write(actor, 'workflows.vers_ia_du_hub', null, { workflows: convertis });
    return convertis;
  }

  /** L'Ollama qui sert l'IA locale de ce service : le sien, sinon le premier en ligne. */
  fournisseurIA(inst) {
    const pid = inst.providers?.['llm.chat'];
    const tous = this.services.list().filter(i => (i.manifest.capabilities?.provides || []).includes('llm.chat'));
    return tous.find(i => i.id === pid) || tous.find(i => i.status === 'online') || tous[0] || null;
  }

  /**
   * Le lien « VIGIE → IA locale qwen3:8b » : chaque service qui choisit son IA
   * a un workflow qui dit laquelle, tenu à jour à chaque changement de ses
   * réglages — par sa fiche, par l'assistant ou par une mise à jour. Aucune
   * IA choisie : pas de lien. Il remplace le lien générique « utilise
   * llm.chat », qui ne disait ni le modèle ni le mode.
   */
  async refleterIA(inst, actor = 'hub') {
    const cle = `ia:${inst.id}`;
    const existant = this.db.get('SELECT id, name FROM workflows WHERE auto_key=?', cle);
    // Déployé avec l'IA du Hub : toutes les IA de la page IA lui sont ouvertes.
    const passerelle = this.services.iaServices?.utilise?.(inst) ? this.services.iaServices : null;
    const e = etatIA(inst, passerelle ? { id: null, name: 'IA du Hub', config: { DEFAULT_MODEL: passerelle.modeleParDefaut(inst) } } : this.fournisseurIA(inst));
    if (!e) { if (existant) await this.store.remove(existant.id, actor); return null; }
    // L'ancien lien générique vers Ollama : son dossier est repris, puis il part.
    let dossier = null;
    for (const w of this.db.all(`SELECT id, graph FROM workflows WHERE auto_key LIKE ? AND origin='Auto'`, `${inst.id}:llm.chat:%`)) {
      if (!JSON.parse(w.graph).nodes.every(n => n.type === 'core.link')) continue;
      dossier ||= this.store.get(w.id).dossier || null;
      await this.store.remove(w.id, actor);
    }
    const m = inst.manifest;
    // Aucune IA choisie : le lien existe quand même — c'est lui qu'on ouvre
    // pour en choisir une (le nœud porte params.ia, l'éditeur le sait).
    if (!e.local && !e.nuage) {
      const seul = { id: 'c', type: 'core.link', name: `${inst.name} — aucune IA`, instanceId: inst.id,
        params: { note: `${m.name} n’a pas d’IA pour l’instant${e.localSansFournisseur ? ' (locale choisie, mais aucun Ollama au Hub)' : ''}. Choisis-en une ici, dans ce nœud — ou dans la fiche du service.`, ia: { instanceId: inst.id } }, x: 360, y: 200 };
      const graphe = { nodes: [seul], edges: [] };
      const nomVide = `${inst.name} → IA : aucune`;
      if (existant) {
        const avant = this.store.get(existant.id);
        if (avant.name === nomVide && JSON.stringify(avant.graph.nodes.map(n => [n.name, n.params?.note])) === JSON.stringify([[seul.name, seul.params.note]])) return avant;
        return (await this.store.update(existant.id, { name: avant.name === nomVide ? nomVide : this.store.nomLibre(nomVide), graph: graphe }, actor)).workflow;
      }
      const { workflow: w } = this.store.create({ name: nomVide, graph: graphe, origin: 'Auto', autoKey: cle }, actor);
      const range = dossier || (this.store.list().some(x => x.dossier) ? `${m.name} / Liens` : null);
      if (range) { try { this.store.ranger([{ id: w.id, dossier: range }], actor); } catch { /* reste à la racine */ } }
      return w;
    }
    const modele = e.modele || (e.modeleParDefaut ? `${e.modeleParDefaut} (défaut)` : 'modèle par défaut');
    const sources = [];
    const d = passerelle && e.local ? passerelle.decrire(e.modele || e.modeleParDefaut) : null;
    if (e.local && d) sources.push({ id: 'l', type: 'core.link', name: `IA du Hub · ${modele}`,
      params: { note: `Par l’IA du Hub : ${modele}, ${d.famille === 'locale' ? `IA locale (${d.connexion}) — rien ne sort du réseau` : d.famille === 'abonnement' ? `par abonnement (${d.connexion}) — les données partent chez ce fournisseur` : `en nuage (${d.connexion}, ${d.fournisseur}) — les données partent chez ce fournisseur`}. Toutes les IA de la page IA lui sont ouvertes.` } });
    else if (e.local) sources.push({ id: 'l', type: 'core.link', name: `${e.fournisseur.name} · ${modele}`, instanceId: e.fournisseur.id,
      params: { note: `IA locale : ${modele}, sur ${e.fournisseur.name}. Rien ne sort du réseau.` } });
    if (e.nuage) sources.push({ id: 'n', type: 'core.link', name: `${e.nuageNom || 'IA en nuage'}${e.modeleNuage ? ` · ${e.modeleNuage}` : ''}`,
      params: { note: `IA en nuage, réglée dans ${m.name} : ${e.nuageNom || '—'}${e.modeleNuage ? `, modèle ${e.modeleNuage}` : ''}. Les données relues partent chez ce fournisseur.` } });
    const graph = {
      nodes: [...sources.map((n, i) => ({ ...n, x: 360, y: 200 + (i - (sources.length - 1) / 2) * 150 })),
        { id: 'c', type: 'core.link', name: `${inst.name} s’en sert`, instanceId: inst.id,
          params: { note: `${m.name}${e.modeLibelle ? ` — ${e.champs.mode.label || e.champs.mode.key} : ${e.modeLibelle}` : ''}. Se change ici, dans ce nœud, dans la fiche du service, ou en le demandant à l’assistant.`, ia: { instanceId: inst.id } }, x: 660, y: 200 }],
      edges: sources.map(n => ({ from: n.id, port: 'main', to: 'c' })),
    };
    const nom = d ? `${inst.name} → IA du Hub · ${e.modele || e.modeleParDefaut || 'modèle par défaut'}`.slice(0, 76)
      : `${inst.name} → IA ${[e.local ? `locale ${e.modele || e.modeleParDefaut || '(modèle par défaut)'}` : '', e.nuage ? e.nuageNom || 'en nuage' : ''].filter(Boolean).join(' + ')}`.slice(0, 76);
    if (existant) {
      const avant = this.store.get(existant.id);
      if (JSON.stringify(avant.graph.nodes.map(n => [n.name, n.instanceId || null, n.params?.note])) === JSON.stringify(graph.nodes.map(n => [n.name, n.instanceId || null, n.params.note])) && avant.name === nom) return avant;
      const libre = avant.name === nom ? nom : this.store.nomLibre(nom);
      return (await this.store.update(existant.id, { name: libre, graph }, actor)).workflow;
    }
    const { workflow } = this.store.create({ name: nom, graph, origin: 'Auto', autoKey: cle }, actor);
    const range = dossier || (this.store.list().some(x => x.dossier) ? `${m.name} / Liens` : null);
    if (range) { try { this.store.ranger([{ id: workflow.id, dossier: range }], actor); } catch { /* reste à la racine */ } }
    this.audit.write(actor, 'ia.lien', inst.name, { workflow: workflow.name });
    return workflow;
  }

  /** Tous les services : au démarrage, et quand un fournisseur change (son modèle par défaut est affiché).
      Un passage à la fois : deux passages mêlés créeraient le même lien deux fois. */
  refleterToutIA(actor = 'hub') {
    const tour = (this.fileIA || Promise.resolve()).then(async () => {
      for (const i of this.services.list()) {
        try { await this.refleterIA(i, actor); } catch (e) { log.warn('capacites', `lien IA de ${i.name} : ${e.message}`); }
      }
    });
    this.fileIA = tour;
    return tour;
  }

  buildAuto(a, consumer, provider) {
    const nodes = [], edges = [];
    let x = 360;
    for (const [i, step] of a.steps.entries()) {
      const [kind, ref] = step.use.split(/:(.*)/s);
      const nid = 'n' + (i + 1);
      let node;
      if (kind === 'trigger' || kind === 'action') {
        // Le déclencheur est d'abord cherché chez le service qui déclare le
        // workflow ; une source d'événements (alerts.source) le tient chez le
        // fournisseur : « alert.new » est celui de MapMyLAN, pas de SYNAPSE.
        const chez = [consumer, provider].find(i => (kind === 'trigger' ? i.manifest.triggers : i.manifest.actions || []).some(t => t.id === ref));
        if (!chez) return null;
        const d = (kind === 'trigger' ? chez.manifest.triggers : chez.manifest.actions).find(t => t.id === ref);
        node = { id: nid, type: kind === 'trigger' ? 'trigger.service' : 'service.action', instanceId: chez.id, ref, name: d.name, params: step.params || {} };
      } else if (kind === 'capability' && CAPS_HUB.includes(ref) && this.iaDuHub()) {
        node = this.noeudIA(step.params || {}, { id: nid, name: 'Conversation' });
      } else if (kind === 'capability') {
        const d = provider.manifest.actions.find(x2 => x2.capability === ref);
        if (!d) return null;
        const params = { ...(step.params || {}) };
        for (const f of d.params || []) if (f.required && params[f.key] === undefined) params[f.key] = `{{ $json.${f.key} }}`;
        node = { id: nid, type: 'service.action', instanceId: provider.id, ref: d.id, name: d.name, params };
      } else if (kind === 'core') {
        const type = CORE_ALIASES[ref] || ref;
        node = { id: nid, type, name: nodeName(type, ref), params: type === 'data.set' ? { fields: step.params || {}, keep: true } : (step.params || {}) };
      } else return null;
      node.x = x; node.y = 200; x += 300;
      nodes.push(node);
      if (i) edges.push({ from: 'n' + i, port: 'main', to: nid });
    }
    return { nodes, edges };
  }
}

const nodeName = (type, ref) => ({ 'data.set': 'Préparer les données' })[type] || ref;
export { id };
