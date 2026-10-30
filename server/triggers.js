// Activation des déclencheurs : webhooks entrants, interrogations, flux, cron, sondes, événements.
import crypto from 'node:crypto';
import { NODE_DEFS } from './workflows/nodes.js';
import { parseCron, cronMatches } from './cron.js';
import { jsonPath } from './manifest/template.js';
import { config } from './config.js';
import { compare } from './workflows/nodes.js';
import { HttpError, id, log, parseDuration, safeEqual, sleep } from './util/common.js';
import { destinationTcp, sortir } from './sortie.js';
import { coupure, exigerOuvert } from './coupure.js';

// Secret d'un webhook : 192 bits, scellé au repos par le coffre du Hub, montré
// une seule fois, à sa création (nouveauSecret).
const secretNeuf = () => crypto.randomBytes(24).toString('base64url');

export class Triggers {
  constructor({ db, bus, audit, store, engine, services, runtime, vault }) {
    Object.assign(this, { db, bus, audit, store, engine, services, runtime, vault });
    // Secrets d'avant le scellement : scellés une fois pour toutes.
    for (const s of db.all("SELECT id, secret FROM subscriptions WHERE secret NOT LIKE 'v1:%'")) db.run('UPDATE subscriptions SET secret=? WHERE id=?', vault.seal(s.secret), s.id);
    this.active = new Map(); // workflowId -> [cleanup fns]
    this.cronJobs = new Map(); // key -> {fields, fire}
    this.listeners = new Map(); // key -> {event, fn}
    this.probeState = new Map();
    this.cronTimer = setInterval(() => this.cronTick(), 15000);
    this.cronTimer.unref();
    this.lastMinute = -1;
    this.webhookHits = new Map();
    bus.on('probe', s => this.onProbe(s));
    bus.on('execution.finished', e => this.emitTo('workflow', e));
    bus.on('hub.event', e => this.emitTo('hub', e));
  }

  async activateAll() {
    for (const w of this.db.all('SELECT id, name FROM workflows WHERE enabled=1')) {
      try { await this.activate(w.id); } catch (e) { log.warn('activation', w.name, e.message); }
    }
  }

  fire(workflowId, nodeId, data) {
    return this.engine.start(workflowId, nodeId, data).catch(e => log.error('déclenchement', workflowId, e.message));
  }

  async activate(workflowId) {
    await this.deactivate(workflowId);
    const w = this.store.get(workflowId, { reveal: true });
    const cleanups = [];
    for (const n of w.graph.nodes) {
      if (!NODE_DEFS[n.type]?.trigger) continue;
      const key = `${workflowId}:${n.id}`;
      const p = n.params || {};
      switch (n.type) {
        case 'trigger.manual': break;
        case 'trigger.webhook': {
          const sub = this.ensureSubscription(workflowId, n.id, 'webhook');
          cleanups.push(() => {});
          log.debug('webhook prêt', sub.id);
          break;
        }
        case 'trigger.cron': {
          const fields = parseCron(p.expr || '*/5 * * * *');
          this.cronJobs.set(key, { fields, fire: () => this.fire(workflowId, n.id, { at: new Date().toISOString(), expr: p.expr }) });
          cleanups.push(() => this.cronJobs.delete(key));
          break;
        }
        case 'trigger.interval': {
          const ms = Math.max(10000, parseDuration(p.every, 600000));
          const t = setInterval(() => this.fire(workflowId, n.id, { at: new Date().toISOString() }), ms);
          cleanups.push(() => clearInterval(t));
          break;
        }
        case 'trigger.poll': cleanups.push(this.startPoll(workflowId, n, { url: p.url, headers: p.headers, every: p.every, items: p.items, dedupe: p.dedupe })); break;
        case 'trigger.probe': {
          this.listeners.set(key, { event: 'probe', fn: s => this.checkProbe(workflowId, n, s) });
          cleanups.push(() => { this.listeners.delete(key); this.probeState.delete(key); });
          break;
        }
        case 'trigger.workflow':
          this.listeners.set(key, { event: 'workflow', fn: e => {
            if (e.workflowId === workflowId) return;
            if (p.workflow && p.workflow !== e.workflowId) return;
            if (p.status && p.status !== 'any' && p.status !== e.status) return;
            this.fire(workflowId, n.id, e);
          } });
          cleanups.push(() => this.listeners.delete(key));
          break;
        case 'trigger.hub':
          this.listeners.set(key, { event: 'hub', fn: e => { if (e.event === p.event) this.fire(workflowId, n.id, e); } });
          cleanups.push(() => this.listeners.delete(key));
          break;
        case 'trigger.service': cleanups.push(await this.startServiceTrigger(workflowId, n)); break;
      }
    }
    this.active.set(workflowId, cleanups);
  }

  async deactivate(workflowId, { local = false } = {}) {
    for (const c of this.active.get(workflowId) || []) { try { await c(local); } catch (e) { log.warn('désactivation', e.message); } }
    this.active.delete(workflowId);
    if (local) return;
    this.active.delete(workflowId);
    const subs = this.db.all('SELECT * FROM subscriptions WHERE workflow_id=?', workflowId);
    this.db.run('DELETE FROM subscriptions WHERE workflow_id=? AND kind != ?', workflowId, 'webhook');
    // les webhooks libres gardent leur URL tant que le nœud existe
    const w = this.db.get('SELECT graph FROM workflows WHERE id=?', workflowId);
    const ids = new Set(w ? JSON.parse(w.graph).nodes.map(n => n.id) : []);
    for (const s of subs) if (s.kind === 'webhook' && !ids.has(s.node_id)) this.db.run('DELETE FROM subscriptions WHERE id=?', s.id);
  }

  emitTo(event, payload) {
    for (const l of this.listeners.values()) if (l.event === event) { try { l.fn(payload); } catch (e) { log.warn(e.message); } }
  }

  cronTick() {
    const d = new Date();
    const minute = Math.floor(d.getTime() / 60000);
    if (minute === this.lastMinute) return;
    this.lastMinute = minute;
    for (const j of this.cronJobs.values()) if (cronMatches(j.fields, d)) j.fire();
  }

  ensureSubscription(workflowId, nodeId, kind) {
    let s = this.db.get('SELECT * FROM subscriptions WHERE workflow_id=? AND node_id=? AND kind=?', workflowId, nodeId, kind);
    if (!s) {
      const sid = id('h_');
      this.db.run('INSERT INTO subscriptions(id,workflow_id,node_id,kind,secret,state,created) VALUES(?,?,?,?,?,?,?)', sid, workflowId, nodeId, kind, this.vault.seal(secretNeuf()), '{}', Date.now());
      s = this.db.get('SELECT * FROM subscriptions WHERE id=?', sid);
    }
    return { ...s, state: JSON.parse(s.state) };
  }
  saveState(subId, state) { this.db.run('UPDATE subscriptions SET state=? WHERE id=?', JSON.stringify(state), subId); }
  secretDe(s) { return this.vault.open(s.secret); }

  /** L'adresse d'un webhook libre, jamais son secret. */
  webhookInfo(workflowId, nodeId) {
    const s = this.ensureSubscription(workflowId, nodeId, 'webhook');
    return { url: `${config.publicUrl}/hooks/${s.id}` };
  }

  /** Un secret neuf pour un déclencheur par webhook, montré cette fois seulement ;
   *  l'ancien cesse aussitôt de valider les envois. */
  async nouveauSecret(workflowId, nodeId, actor) {
    const w = this.store.get(workflowId);
    const n = w.graph.nodes.find(x => x.id === nodeId);
    if (!n || !['trigger.webhook', 'trigger.service'].includes(n.type)) throw new HttpError(404, 'Déclencheur par webhook introuvable');
    const kind = n.type === 'trigger.webhook' ? 'webhook' : 'service';
    if (kind === 'service' && !this.db.get('SELECT 1 FROM subscriptions WHERE workflow_id=? AND node_id=? AND kind=?', workflowId, nodeId, kind)) throw new HttpError(409, 'Active d’abord le workflow : le service n’est pas encore abonné.');
    const s = this.ensureSubscription(workflowId, nodeId, kind);
    const secret = secretNeuf();
    this.db.run('UPDATE subscriptions SET secret=? WHERE id=?', this.vault.seal(secret), s.id);
    this.audit.write(actor, 'webhook.secret_renouvelé', w.name, { nœud: n.name });
    // Un service abonné reçoit le nouveau secret en se réabonnant.
    if (kind === 'service' && this.active.has(workflowId)) await this.activate(workflowId);
    return { url: `${config.publicUrl}/hooks/${s.id}`, ...(kind === 'webhook' ? { secret } : {}) };
  }

  // ---- réception d'un webhook (libre ou de service) ----
  async receive(subId, ctx) {
    const s = this.db.get('SELECT * FROM subscriptions WHERE id=?', subId);
    if (!s) throw new HttpError(404, 'Webhook inconnu');
    const nowT = Date.now();
    const hits = (this.webhookHits.get(subId) || []).filter(t => nowT - t < 60000);
    if (hits.length >= 120) throw new HttpError(429, 'Trop de requêtes');
    hits.push(nowT); this.webhookHits.set(subId, hits);
    exigerOuvert(this.db, 'workflows');
    const w = this.db.get('SELECT enabled, graph FROM workflows WHERE id=?', s.workflow_id);
    if (!w?.enabled) throw new HttpError(409, 'Workflow désactivé');
    const node = JSON.parse(w.graph).nodes.find(n => n.id === s.node_id);
    if (!node) throw new HttpError(404, 'Webhook inconnu');
    const raw = ctx.rawBody || Buffer.alloc(0);
    const h = ctx.req.headers;
    // Aucun webhook n'entre sans preuve : jeton en en-tête si le workflow le
    // demande, signature HMAC du corps brut sinon — y compris pour un ancien
    // nœud réglé sur « aucune vérification », option retirée.
    const secret = this.secretDe(s);
    if (s.kind === 'webhook') {
      if (node.params?.auth === 'token') { if (!safeEqual(h['x-hub-token'] || '', secret)) throw new HttpError(401, 'Jeton invalide'); }
      else checkSig(h['x-hub-signature'], raw, secret, 'sha256=');
    } else {
      const inst = this.services.get(node.instanceId);
      const def = inst.manifest.triggers.find(t => t.id === node.ref);
      const sig = def?.delivery?.signature;
      if (!sig) throw new HttpError(401, 'Webhook de service non signé : le manifeste doit déclarer « delivery.signature ».');
      checkSig(h[sig.header.toLowerCase()], raw, secret, sig.prefix || '');
      const ts = Number(h['x-hub-timestamp'] || h['x-timestamp'] || 0);
      if (ts && Math.abs(Date.now() - (ts < 1e12 ? ts * 1000 : ts)) > 5 * 60e3) throw new HttpError(401, 'Requête trop ancienne');
    }
    // Une livraison déjà reçue (même identifiant) ne relance rien : l'expéditeur
    // qui réessaie, ou un envoi rejoué, n'a qu'un seul effet. La clé est posée
    // avant l'exécution, pas après.
    const livraison = ['x-hub-delivery', 'x-github-delivery', 'x-delivery-id', 'idempotency-key'].map(k => h[k]).find(Boolean);
    if (livraison && this.db.run('INSERT INTO livraisons(cle, t) VALUES(?, ?) ON CONFLICT(cle) DO NOTHING', `${subId}:${String(livraison).slice(0, 200)}`, Date.now()).changes === 0) {
      return { ok: true, doublon: true };
    }
    let data = ctx.body;
    if (data === undefined || (typeof data === 'object' && !Object.keys(data).length && raw.length)) data = { raw: raw.toString('utf8').slice(0, 100000) };
    if (s.kind === 'service') {
      const inst = this.services.get(node.instanceId);
      const def = inst.manifest.triggers.find(t => t.id === node.ref);
      if (def?.delivery?.select) data = jsonPath(data, def.delivery.select);
    }
    const r = await this.engine.start(s.workflow_id, s.node_id, { ...(typeof data === 'object' && !Array.isArray(data) ? data : { data }), _headers: pickHeaders(h) });
    return { ok: true, execution: r?.id };
  }

  // ---- déclencheurs de service ----
  async startServiceTrigger(workflowId, n) {
    const inst = this.services.get(n.instanceId);
    const def = inst.manifest.triggers.find(t => t.id === n.ref);
    if (!def) throw new HttpError(400, `Déclencheur ${n.ref} absent de ${inst.name}`);
    const d = def.delivery;
    const params = n.params || {};
    if (d.type === 'poll') {
      return this.startPoll(workflowId, n, { inst, request: d.request, every: d.interval, items: d.items, dedupe: d.dedupeKey, cursor: d.cursor, params });
    }
    if (d.type === 'webhook') {
      const sub = this.ensureSubscription(workflowId, n.id, 'service');
      const hub = { webhookUrl: `${config.publicUrl}/hooks/${sub.id}`, webhookSecret: this.secretDe(sub) };
      // abonnement laissé par un arrêt du Hub : on le remplace pour éviter les doublons
      if (sub.state.subscriptionId != null && d.unsubscribe) {
        await this.runtime.request(inst, d.unsubscribe, { params, hub, state: sub.state, timeout: 10000 }).catch(e => log.debug('ancien abonnement', inst.name, e.message));
      }
      const res = await this.runtime.request(inst, d.subscribe, { params, hub, state: sub.state, timeout: 15000 });
      const state = { ...sub.state, subscriptionId: typeof res === 'object' ? (res?.id ?? res) : res };
      this.saveState(sub.id, state);
      return async local => {
        if (local) return;
        if (d.unsubscribe) {
          try { await this.runtime.request(inst, d.unsubscribe, { params, hub, state, timeout: 10000 }); }
          catch (e) { log.warn('désabonnement', inst.name, e.message); }
        }
        this.db.run('DELETE FROM subscriptions WHERE id=?', sub.id);
      };
    }
    if (d.type === 'sse' || d.type === 'websocket') return this.startStream(workflowId, n, inst, d);
    throw new HttpError(400, `Livraison non gérée : ${d.type}`);
  }

  startPoll(workflowId, n, o) {
    const sub = this.ensureSubscription(workflowId, n.id, 'poll');
    let state = sub.state, stopped = false, timer;
    const every = Math.max(10000, parseDuration(o.every, 60000));
    const tick = async () => {
      if (stopped) return;
      if (coupure(this.db).workflows) { timer = setTimeout(tick, every); return; }
      try {
        let data;
        if (o.inst) data = await this.runtime.request(o.inst, o.request, { params: o.params, state, timeout: 20000 });
        else {
          const res = await sortir(String(o.url), { headers: o.headers || {}, signal: AbortSignal.timeout(20000) });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          data = await res.json();
        }
        let items = jsonPath(data, o.items || '$');
        if (!Array.isArray(items)) items = items == null ? [] : [items];
        const seen = new Set(state.seen || []);
        const fresh = [];
        for (const it of items) {
          const k = JSON.stringify(o.dedupe ? jsonPath(it, o.dedupe) : it);
          if (!seen.has(k)) { seen.add(k); fresh.push(it); }
        }
        const first = !state.initialized;
        state = { ...state, initialized: true, seen: [...seen].slice(-2000), lastPoll: Date.now(), error: null };
        if (o.cursor) { const c = jsonPath(data, o.cursor); if (c != null) state.cursor = c; }
        this.saveState(sub.id, state);
        if (!first) for (const it of fresh.slice(0, 50)) await this.fire(workflowId, n.id, it);
      } catch (e) {
        state = { ...state, error: e.message, lastPoll: Date.now() };
        this.saveState(sub.id, state);
        log.warn('interrogation', n.name, e.message);
      }
      if (!stopped) timer = setTimeout(tick, every);
    };
    timer = setTimeout(tick, 1000 + Math.random() * 2000);
    return () => { stopped = true; clearTimeout(timer); };
  }

  startStream(workflowId, n, inst, d) {
    let stopped = false, ws = null, ctrl = null, delay = 1000;
    const url = inst.url.replace(/\/$/, '') + d.path;
    const handle = msg => {
      let data = msg; try { data = JSON.parse(msg); } catch { data = { message: msg }; }
      if (d.filter && typeof data === 'object') {
        const m = /^\s*([$\w.[\]'"]+)\s*(==|!=)\s*['"]?([^'"]*)['"]?\s*$/.exec(d.filter);
        if (m) { const v = String(jsonPath(data, m[1].startsWith('$') ? m[1] : '$.' + m[1])); if ((m[2] === '==') !== (v === m[3])) return; }
      }
      this.fire(workflowId, n.id, data);
    };
    const token = this.runtime.context(inst).service.token;
    const connect = async () => {
      while (!stopped) {
        try {
          if (d.type === 'websocket') {
            // WebSocket n'accepte pas d'adresse épinglée : l'hôte, celui du
            // service connecté par un administrateur, est au moins contrôlé.
            await destinationTcp(new URL(url).hostname.replace(/^\[|\]$/g, ''));
            await new Promise((resolve, reject) => {
              ws = new WebSocket(url.replace(/^http/, 'ws') + (token ? (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token) : ''));
              ws.onopen = () => { delay = 1000; };
              ws.onmessage = ev => handle(typeof ev.data === 'string' ? ev.data : '');
              ws.onclose = resolve; ws.onerror = () => reject(new Error('websocket'));
            });
          } else {
            ctrl = new AbortController();
            // Un flux ne finit pas : ni délai global, ni plafond de taille cumulée.
            const res = await sortir(url, { headers: { Accept: 'text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, signal: ctrl.signal }, { taille: Infinity });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            delay = 1000;
            const dec = new TextDecoder(); let buf = '';
            for await (const chunk of res.body) {
              buf += dec.decode(chunk, { stream: true });
              let i;
              while ((i = buf.indexOf('\n\n')) >= 0) {
                const block = buf.slice(0, i); buf = buf.slice(i + 2);
                let ev = 'message'; const lines = [];
                for (const l of block.split('\n')) { if (l.startsWith('event:')) ev = l.slice(6).trim(); else if (l.startsWith('data:')) lines.push(l.slice(5).trimStart()); }
                if (lines.length && (!d.event || d.event === ev)) handle(lines.join('\n'));
              }
            }
          }
        } catch (e) { if (!stopped) log.debug('flux', inst.name, e.message); }
        if (stopped) break;
        await sleep(delay); delay = Math.min(delay * 2, 60000);
      }
    };
    connect();
    return () => { stopped = true; try { ws?.close(); } catch { /* */ } ctrl?.abort(); };
  }

  // ---- sondes ----
  onProbe(sample) { this.emitTo('probe', sample); }
  checkProbe(workflowId, n, s) {
    const p = n.params || {};
    if (s.instanceId !== p.instance || s.probeId !== p.probe) return;
    if (p.labels) {
      const want = Object.fromEntries(String(p.labels).split(',').map(x => x.split('=').map(y => y.trim())));
      if (Object.entries(want).some(([k, v]) => String(s.labels?.[k]) !== v)) return;
    }
    const key = `${workflowId}:${n.id}:${JSON.stringify(s.labels || {})}`;
    const st = this.probeState.get(key) || { since: null, fired: false };
    const hit = p.op === 'niveau warn' ? s.level !== 'ok' : p.op === 'niveau crit' ? s.level === 'crit' : compare(s.value, p.op || '>', p.threshold);
    const hold = parseDuration(p.for, 0);
    if (hit) {
      st.since ??= Date.now();
      if (!st.fired && Date.now() - st.since >= hold) { st.fired = true; this.fire(workflowId, n.id, { ...s, state: 'alerte', threshold: p.threshold, op: p.op }); }
    } else {
      if (st.fired && p.recover) this.fire(workflowId, n.id, { ...s, state: 'rétabli' });
      st.since = null; st.fired = false;
    }
    this.probeState.set(key, st);
  }

  status(workflowId) {
    return this.db.all('SELECT id, node_id, kind, state, created FROM subscriptions WHERE workflow_id=?', workflowId).map(s => {
      const st = JSON.parse(s.state);
      return { id: s.id, nodeId: s.node_id, kind: s.kind, lastPoll: st.lastPoll, error: st.error, url: s.kind === 'webhook' ? `${config.publicUrl}/hooks/${s.id}` : undefined };
    });
  }

  async stopAll() { clearInterval(this.cronTimer); for (const wid of [...this.active.keys()]) await this.deactivate(wid, { local: true }); }
}

function checkSig(header, raw, secret, prefix) {
  const expected = prefix + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  if (!header || !safeEqual(header, expected)) throw new HttpError(401, 'Signature invalide');
}
const pickHeaders = h => Object.fromEntries(Object.entries(h).filter(([k]) => /^(content-type|user-agent|x-github-event|x-event|x-request-id)$/.test(k)));
