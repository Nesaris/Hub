// Moteur d'exécution : exécutions persistées, branches, fusion, relances, attentes, validations.
import { NODE_DEFS, EXEC, outputsOf } from './nodes.js';
import { render, tempsLisible } from '../manifest/template.js';
import { HttpError, id, log, parseDuration, redact, sleep } from '../util/common.js';
import { exigerOuvert } from '../coupure.js';

const MAX_STEPS = 500;
const WF_TIMEOUT = 15 * 60e3;

export class Engine {
  constructor({ db, audit, bus, store, services, runtime, ai, vault }) {
    Object.assign(this, { db, audit, bus, store, services, runtime, ai, vault });
    this.running = new Map();
    this.concurrency = new Map();
    this.kv = {
      get: k => db.get('SELECT value FROM kv WHERE key=?', k)?.value ?? null,
      set: (k, v) => db.run('INSERT INTO kv(key,value,updated) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated=excluded.updated', k, v, Date.now()),
      del: k => db.run('DELETE FROM kv WHERE key=?', k),
    };
  }

  vars() {
    const out = {};
    for (const r of this.db.all('SELECT * FROM variables')) out[r.key] = r.secret ? this.vault.open(r.value) : r.value;
    return out;
  }

  // Démarre une exécution. mode : live | test
  async start(workflowId, triggerNodeId, data, { mode = 'live', wait = false, depth = 0 } = {}) {
    exigerOuvert(this.db, 'workflows');
    const w = this.db.get('SELECT id, name, version, enabled FROM workflows WHERE id=?', workflowId);
    if (!w) throw new HttpError(404, 'Workflow introuvable');
    const active = this.concurrency.get(workflowId) || 0;
    if (active >= 5 && mode === 'live') { log.warn('exécution ignorée (5 en cours)', w.name); return null; }
    const exId = id('x_');
    const state = { nodes: {}, steps: 0, depth };
    this.db.run('INSERT INTO executions(id,workflow_id,version,status,mode,trigger_node,trigger_data,state,started) VALUES(?,?,?,?,?,?,?,?,?)',
      exId, workflowId, w.version, 'running', mode, triggerNodeId, JSON.stringify(data ?? {}), JSON.stringify(state), Date.now());
    this.bus.emit('execution', { id: exId, workflowId, status: 'running' });
    const p = this.run(exId);
    if (wait) return p;
    p.catch(e => log.error('exécution', exId, e.message));
    return { id: exId };
  }

  async runSub(workflowId, data, depth) {
    const w = this.db.get('SELECT graph FROM workflows WHERE id=?', workflowId);
    if (!w) throw new Error('Sous-workflow introuvable');
    const g = JSON.parse(w.graph);
    const trig = g.nodes.find(n => n.type === 'trigger.manual') || g.nodes.find(n => NODE_DEFS[n.type]?.trigger);
    if (!trig) throw new Error('Le sous-workflow n’a pas de déclencheur');
    const r = await this.start(workflowId, trig.id, data, { wait: true, depth });
    if (r.status !== 'success') throw new Error(`Sous-workflow en échec : ${r.error || r.status}`);
    return r.output;
  }

  load(exId) {
    const ex = this.db.get('SELECT * FROM executions WHERE id=?', exId);
    if (!ex) throw new HttpError(404, 'Exécution introuvable');
    return { ...ex, state: JSON.parse(ex.state), trigger_data: JSON.parse(ex.trigger_data || '{}') };
  }
  save(exId, state, status = null, extra = {}) {
    const sets = ['state=?']; const vals = [JSON.stringify(state)];
    if (status) { sets.push('status=?'); vals.push(status); }
    if ('error' in extra) { sets.push('error=?'); vals.push(extra.error); }
    if (extra.finished) { sets.push('finished=?'); vals.push(extra.finished); }
    this.db.run(`UPDATE executions SET ${sets.join(',')} WHERE id=?`, ...vals, exId);
  }

  async run(exId) {
    if (this.running.has(exId)) return this.running.get(exId);
    const p = this._run(exId).finally(() => this.running.delete(exId));
    this.running.set(exId, p);
    return p;
  }

  async _run(exId) {
    const ex = this.load(exId);
    const wfRow = this.db.get('SELECT name FROM workflows WHERE id=?', ex.workflow_id);
    const graph = this.store.graphAt(ex.workflow_id, ex.version);
    const st = ex.state;
    const byId = new Map(graph.nodes.map(n => [n.id, n]));
    const incoming = new Map(graph.nodes.map(n => [n.id, graph.edges.filter(e => e.to === n.id)]));
    const secrets = graph.nodes.flatMap(n => this.store.secretKeys(n).map(k => n.params?.[k])).filter(Boolean);
    const vars = this.vars();
    this.concurrency.set(ex.workflow_id, (this.concurrency.get(ex.workflow_id) || 0) + 1);
    const deadline = ex.started + WF_TIMEOUT;

    // initialisation : le déclencheur qui a tiré est « fait », les autres sont ignorés
    if (!Object.keys(st.nodes).length) {
      for (const n of graph.nodes) {
        if (NODE_DEFS[n.type]?.trigger) st.nodes[n.id] = n.id === ex.trigger_node ? { status: 'done', output: ex.trigger_data, port: 'main', started: Date.now(), finished: Date.now() } : { status: 'skipped' };
        else if (n.type === 'core.link') st.nodes[n.id] = { status: 'skipped' };
      }
      this.save(exId, st);
    }

    const outputOf = nid => st.nodes[nid]?.output;
    const nodeCtx = {};
    for (const gn of graph.nodes) Object.defineProperty(nodeCtx, gn.name, { enumerable: true, get: () => ({ json: outputOf(gn.id) }) });
    const exprCtx = input => ({
      $json: input, $input: input, $trigger: ex.trigger_data, $vars: vars, $now: new Date().toISOString(), ...tempsLisible(),
      $execution: { id: exId, mode: ex.mode, workflow: wfRow?.name },
      $node: nodeCtx,
    });

    let finalStatus = 'success', finalError = null, lastOutput = null;
    try {
      for (;;) {
        if (Date.now() > deadline) throw new Error('Délai maximal du workflow dépassé (15 min)');
        exigerOuvert(this.db, 'workflows');
        // calcul des nœuds prêts
        const ready = [];
        let pendingLeft = false;
        for (const n of graph.nodes) {
          const s = st.nodes[n.id];
          if (s && s.status !== 'pending' && s.status !== 'running') continue;
          if (s?.status === 'running') { ready.push(n); continue; } // reprise après redémarrage
          const inc = incoming.get(n.id);
          if (!inc.length) { st.nodes[n.id] = { status: 'skipped' }; continue; }
          const resolved = inc.every(e => ['done', 'skipped', 'error-handled'].includes(st.nodes[e.from]?.status));
          if (!resolved) { pendingLeft = true; continue; }
          const active = inc.filter(e => st.nodes[e.from]?.status === 'done' && st.nodes[e.from].port === e.port
            || st.nodes[e.from]?.status === 'error-handled' && e.port === 'error'
            || st.nodes[e.from]?.status === 'error-handled' && st.nodes[e.from].continue && e.port === 'main');
          if (!active.length) { st.nodes[n.id] = { status: 'skipped' }; continue; }
          ready.push(Object.assign(n, { _inputs: active.map(e => outputOf(e.from)) }));
        }
        const waiting = graph.nodes.some(n => st.nodes[n.id]?.status === 'waiting');
        if (!ready.length) {
          if (waiting) { this.save(exId, st, 'waiting'); this.bus.emit('execution', { id: exId, workflowId: ex.workflow_id, status: 'waiting' }); return { id: exId, status: 'waiting' }; }
          if (pendingLeft) {
            // attente d'un nœud qui ne se résoudra pas (branche en attente) : on arrête proprement
          }
          break;
        }
        if (st.steps + ready.length > MAX_STEPS) throw new Error('Trop d’étapes dans cette exécution');
        st.steps += ready.length;
        await Promise.all(ready.map(n => this.runNode(n, st, { ex, graph, exprCtx, secrets, wfName: wfRow?.name })));
        this.save(exId, st);
        const stop = graph.nodes.map(n => st.nodes[n.id]).find(s => s?.stop);
        if (stop) { finalStatus = stop.stop.status === 'error' ? 'error' : 'success'; finalError = stop.stop.status === 'error' ? (stop.stop.message || 'Arrêté par le nœud Arrêter') : null; break; }
        const failed = graph.nodes.find(n => st.nodes[n.id]?.status === 'error');
        if (failed) { finalStatus = 'error'; finalError = `${failed.name} : ${st.nodes[failed.id].error}`; break; }
      }
      const done = graph.nodes.filter(n => st.nodes[n.id]?.status === 'done' && st.nodes[n.id].finished).sort((a, b) => st.nodes[a.id].finished - st.nodes[b.id].finished);
      lastOutput = done.length ? st.nodes[done[done.length - 1].id].output : null;
    } catch (e) {
      finalStatus = 'error'; finalError = e.message;
    } finally {
      this.concurrency.set(ex.workflow_id, Math.max(0, (this.concurrency.get(ex.workflow_id) || 1) - 1));
    }
    this.save(exId, st, finalStatus, { error: finalError, finished: Date.now() });
    this.bus.emit('execution', { id: exId, workflowId: ex.workflow_id, status: finalStatus, error: finalError });
    this.bus.emit('execution.finished', { executionId: exId, workflowId: ex.workflow_id, workflowName: wfRow?.name, status: finalStatus, error: finalError, output: lastOutput, mode: ex.mode });
    this.db.run(`DELETE FROM executions WHERE workflow_id=? AND id NOT IN (SELECT id FROM executions WHERE workflow_id=? ORDER BY started DESC LIMIT 200)`, ex.workflow_id, ex.workflow_id);
    return { id: exId, status: finalStatus, error: finalError, output: lastOutput };
  }

  /**
   * Délai maximal d'un nœud quand l'utilisateur n'en a pas fixé un lui-même.
   *
   * Une minute convient à presque tout. Elle ne convient pas à une action de
   * service qui annonce elle-même qu'elle sera plus longue : un modèle de
   * langage qui doit d'abord charger ses poids met couramment plusieurs
   * minutes à rendre sa première phrase. Le plafond générique coupait alors
   * l'appel avant que le service ait eu tort ou raison, et l'échec désignait
   * le Hub là où c'était le modèle qui chauffait.
   */
  plafondNoeud(n) {
    const base = 60000;
    if (n.type !== 'service.action' || !n.instanceId) return base;
    try {
      const inst = this.services.get(n.instanceId);
      const a = (inst.manifest.actions || []).find(x => x.id === n.ref);
      return Math.max(base, parseDuration(a?.timeout, 0));
    } catch { return base; }
  }

  async runNode(n, st, { ex, graph, exprCtx, secrets, wfName }) {
    const prev = st.nodes[n.id];
    const inputs = n._inputs || prev?.inputs || [];
    const input = inputs.length === 1 ? inputs[0] : inputs.reduce((a, b) => (b && typeof b === 'object' && !Array.isArray(b) ? { ...a, ...b } : a), {});
    const s = st.nodes[n.id] = { status: 'running', started: Date.now(), inputs, input: redact(input, secrets) };
    this.bus.emit('execution.node', { executionId: ex.id, nodeId: n.id, status: 'running' });
    const retries = Number(n.params?._retries || 0);
    const timeout = parseDuration(n.params?._timeout, this.plafondNoeud(n));
    let attempt = 0, lastErr;
    const ctx = { ...exprCtx(input), $inputs: inputs };
    while (attempt <= retries) {
      try {
        const p = this.renderParams(n, ctx);
        const r = await withTimeout(this.execNode(n, p, { input, ex, ctx, wfName }), n.type === 'logic.wait' ? timeout + parseDuration(p.duration, 0) : timeout, n.name);
        if (r.approval) {
          const apId = id('a_');
          this.db.run('INSERT INTO approvals(id,execution_id,node_id,message,created) VALUES(?,?,?,?,?)', apId, ex.id, n.id, r.approval.message, Date.now());
          Object.assign(s, { status: 'waiting', approval: apId, expires: r.approval.expires });
          this.bus.emit('approval', { id: apId, executionId: ex.id, workflow: wfName, message: r.approval.message });
          return;
        }
        if (r.wait) { Object.assign(s, { status: 'waiting', until: r.wait.until }); return; }
        const output = r.output === undefined ? input : r.output;
        Object.assign(s, { status: 'done', output: redact(output, secrets), port: r.port === undefined ? 'main' : r.port, finished: Date.now(), attempts: attempt + 1 });
        if (r.stop) s.stop = r.stop;
        delete s.inputs;
        this.bus.emit('execution.node', { executionId: ex.id, nodeId: n.id, status: 'done', port: s.port });
        return;
      } catch (e) {
        lastErr = e;
        attempt++;
        if (attempt <= retries) await sleep(parseDuration(n.params?._retryDelay, 5000) * attempt);
      }
    }
    const onErr = n.params?._onError || 'stop';
    Object.assign(s, { status: onErr === 'stop' ? 'error' : 'error-handled', error: lastErr.message, finished: Date.now(), continue: onErr === 'continue', output: onErr !== 'stop' ? { error: lastErr.message, input } : undefined, port: null });
    delete s.inputs;
    this.bus.emit('execution.node', { executionId: ex.id, nodeId: n.id, status: s.status, error: lastErr.message });
  }

  renderParams(n, ctx) {
    const def = this.store.defOf(n);
    const out = {};
    for (const f of def?.params || []) {
      let v = n.params?.[f.key];
      if ((v === undefined || v === '') && n.type !== 'service.action') v = f.default;
      if (v === undefined) continue;
      out[f.key] = f.key === 'code' ? v : render(v, ctx);
    }
    for (const k of Object.keys(n.params || {})) if (k.startsWith('_')) out[k] = n.params[k];
    return out;
  }

  /**
   * Un nœud de sortie, seul, tout de suite : « envoie-moi un message de
   * test sur Telegram ». Mêmes paramètres, mêmes expressions ($vars) et même
   * code d'envoi qu'à l'intérieur d'un workflow — si l'essai passe, le
   * workflow passera.
   */
  async essaiNoeud(node, actor) {
    exigerOuvert(this.db, 'workflows');
    if (!/^out\./.test(node.type) || !EXEC[node.type]) throw new Error(`Seuls les nœuds d'envoi (out.*) se lancent seuls, pas « ${node.type} »`);
    const n = { id: 'essai', name: 'Essai', params: {}, ...node };
    const ctx = { $json: {}, $input: {}, $trigger: {}, $vars: this.vars(), $now: new Date().toISOString(), ...tempsLisible(), $execution: { id: 'essai', mode: 'test' }, $node: {} };
    const p = this.renderParams(n, ctx);
    const def = this.store.defOf(n);
    const manque = (def?.params || []).filter(f => f.required && (p[f.key] === undefined || p[f.key] === '')).map(f => f.label);
    if (manque.length) throw new Error(`Paramètre vide : ${manque.join(', ')} (une clé de Clés & API absente ?)`);
    const r = await withTimeout(EXEC[n.type](p, { input: {}, node: n, workflowId: null, workflowName: 'essai', kv: this.kv, ai: this.ai, audit: this.audit, engine: this, depth: 0, ctx }), 20000, n.name);
    this.audit.write(actor, 'message.essai', n.type, {});
    return r.output;
  }

  async execNode(n, p, { input, ex, ctx, wfName }) {
    if (n.type === 'service.action') {
      const inst = this.services.get(n.instanceId);
      const a = inst.manifest.actions.find(x => x.id === n.ref);
      if (!a) throw new Error(`Action ${n.ref} absente de ${inst.name}`);
      if (ex.mode === 'test' && a.risk === 'destructive') return { output: { ...a.sample, _test: 'action destructive simulée' } };
      const params = Object.fromEntries(Object.entries(p).filter(([k]) => !k.startsWith('_')));
      return { output: await this.runtime.action(inst, n.ref, params, { $json: input }) };
    }
    const fn = EXEC[n.type];
    if (!fn) throw new Error(`Nœud non exécutable : ${n.type}`);
    return fn(p, { input, node: n, workflowId: ex.workflow_id, workflowName: wfName, kv: this.kv, ai: this.ai, audit: this.audit, engine: this, depth: ex.state.depth || 0, ctx });
  }

  // ---- attentes ----
  async decide(approvalId, approved, actor) {
    const ap = this.db.get('SELECT * FROM approvals WHERE id=?', approvalId);
    if (!ap || ap.status !== 'pending') throw new HttpError(404, 'Demande de validation introuvable ou déjà traitée');
    const ex = this.load(ap.execution_id);
    const s = ex.state.nodes[ap.node_id];
    s.status = 'done'; s.port = approved ? 'approved' : 'rejected'; s.output = { approved, by: actor, at: new Date().toISOString(), ...(s.input || {}) }; s.finished = Date.now();
    delete s.inputs;
    this.db.run('UPDATE approvals SET status=? WHERE id=?', approved ? 'approved' : 'rejected', approvalId);
    this.save(ex.id, ex.state, 'running');
    this.audit.write(actor, approved ? 'validation.acceptée' : 'validation.refusée', ap.message, { execution: ex.id });
    this.run(ex.id).catch(e => log.error(e.message));
    return { ok: true };
  }

  pendingApprovals() {
    return this.db.all(`SELECT a.*, w.name workflow FROM approvals a JOIN executions e ON e.id=a.execution_id JOIN workflows w ON w.id=e.workflow_id WHERE a.status='pending' ORDER BY a.created DESC`);
  }

  // tick : reprend les attentes échues, expire les validations
  async tick() {
    for (const ex of this.db.all(`SELECT id, state FROM executions WHERE status='waiting'`)) {
      const st = JSON.parse(ex.state);
      let changed = false;
      for (const [nid, s] of Object.entries(st.nodes)) {
        if (s.status !== 'waiting') continue;
        if (s.until && s.until <= Date.now()) { Object.assign(s, { status: 'done', port: 'main', output: s.input, finished: Date.now() }); delete s.inputs; changed = true; }
        if (s.approval && s.expires <= Date.now()) {
          this.db.run(`UPDATE approvals SET status='expired' WHERE id=?`, s.approval);
          Object.assign(s, { status: 'done', port: 'rejected', output: { approved: false, expired: true }, finished: Date.now() }); delete s.inputs; changed = true;
        }
      }
      if (changed) { this.save(ex.id, st, 'running'); this.run(ex.id).catch(e => log.error(e.message)); }
    }
  }

  // au démarrage : reprise des exécutions interrompues
  resume() {
    for (const ex of this.db.all(`SELECT id FROM executions WHERE status='running'`)) {
      log.info('reprise de l’exécution', ex.id);
      this.run(ex.id).catch(e => log.error(e.message));
    }
  }

  async replayFrom(exId, nodeId, actor) {
    exigerOuvert(this.db, 'workflows');
    const ex = this.load(exId);
    const graph = this.store.graphAt(ex.workflow_id, ex.version);
    // efface le nœud et tout ce qui est en aval
    const down = new Set([nodeId]);
    let grew = true;
    while (grew) { grew = false; for (const e of graph.edges) if (down.has(e.from) && !down.has(e.to)) { down.add(e.to); grew = true; } }
    const st = structuredClone(ex.state);
    for (const nid of down) delete st.nodes[nid];
    const newId = id('x_');
    this.db.run('INSERT INTO executions(id,workflow_id,version,status,mode,trigger_node,trigger_data,state,started) VALUES(?,?,?,?,?,?,?,?,?)',
      newId, ex.workflow_id, ex.version, 'running', ex.mode, ex.trigger_node, JSON.stringify(ex.trigger_data), JSON.stringify(st), Date.now());
    this.audit.write(actor, 'exécution.rejouée', ex.workflow_id, { depuis: nodeId, origine: exId });
    this.run(newId).catch(e => log.error(e.message));
    return { id: newId };
  }

  list(workflowId, limit = 50) {
    return this.db.all('SELECT id, workflow_id, version, status, mode, trigger_node, error, started, finished FROM executions WHERE workflow_id=? ORDER BY started DESC LIMIT ?', workflowId, limit);
  }
  get(exId) { const e = this.load(exId); return { ...e, trigger_data: e.trigger_data }; }
}

function withTimeout(promise, ms, name) {
  let t;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${name} : délai de ${Math.round(ms / 1000)} s dépassé`)), ms); }),
  ]);
}

export { outputsOf };
