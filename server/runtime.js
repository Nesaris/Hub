// Exécute les requêtes décrites dans les manifestes, pour une instance donnée.
import { render, jsonPath } from './manifest/template.js';
import { config } from './config.js';
import { HttpError, parseDuration, sleep } from './util/common.js';
import { destinationTcp, sortir } from './sortie.js';

/* Tous ceux qui parlent à Ollama doivent demander le MÊME contexte : dès
   que num_ctx change d'un appel à l'autre, Ollama recharge le modèle (un 14b :
   10 à 20 s, et tout le prompt relu). Les workflows passaient par l'action
   « chat » sans num_ctx — donc au défaut de la machine, 8 k — pendant que
   l'assistant et SYNAPSE demandaient 16 k : le modèle se rechargeait sans
   arrêt. On aligne ici tout appel /api/chat ou /api/generate qui ne fixe pas
   lui-même son contexte. */
export const CTX_OLLAMA = config.ollamaCtx;
export function ollamaAligne(chemin, corps) {
  if (!/\/api\/(chat|generate)$/.test(String(chemin)) || !corps || typeof corps !== 'object' || !corps.model) return corps;
  const options = { ...(corps.options || {}) };
  if (options.num_ctx == null) options.num_ctx = CTX_OLLAMA;
  return { ...corps, options, keep_alive: corps.keep_alive ?? '30m', think: corps.think ?? false };
}

export class Runtime {
  constructor({ services }) { this.services = services; }

  // Contexte de gabarit propre à une instance.
  context(inst, extra = {}) {
    const m = inst.manifest;
    const cfg = this.services.configOf(inst);
    const auth = m.api?.auth || {};
    // extra.tokenKey : une autre clé de configuration que celle de l'API
    // courante — la gestion des comptes utilise un jeton d'administration
    // distinct du jeton de service.
    const tokenKey = extra.tokenKey || (inst.mode === 'compose' ? auth.localToken : auth.remoteToken);
    const ports = Object.fromEntries((m.install.ports || []).map(p => [p.name, p.container]));
    const service = {
      id: inst.id, name: inst.name, url: inst.url.replace(/\/$/, ''),
      host: containerName(inst), token: tokenKey ? (cfg[tokenKey] || '') : '',
    };
    return {
      config: cfg, service, port: ports,
      hub: { url: config.publicUrl, network: config.dockerNetwork, ...(extra.hub || {}) },
      params: extra.params || {}, state: extra.state || {},
      $json: extra.$json, $vars: extra.$vars,
    };
  }

  async request(inst, req, opts = {}) {
    if (!req) throw new HttpError(400, 'Requête absente du manifeste');
    const ctx = this.context(inst, opts);
    const m = inst.manifest;
    const base = String(render(m.api?.baseUrl || '{{service.url}}', ctx)).replace(/\/$/, '');
    const pathPart = String(render(req.path, ctx));
    const url = new URL(base + (pathPart.startsWith('/') ? pathPart : '/' + pathPart));
    // les requêtes ne peuvent viser que l'hôte enregistré pour l'instance
    const allowed = new URL(ctx.service.url);
    if (url.host !== allowed.host) throw new HttpError(400, `Requête refusée : ${url.host} n’est pas l’hôte de ${inst.name}`);
    for (const [k, v] of Object.entries(render(req.query || {}, ctx))) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
    }
    const headers = { Accept: 'application/json', 'User-Agent': `hub/${config.version}`, ...stringMap(render(req.headers || {}, ctx)) };
    const auth = m.api?.auth || { type: 'none' };
    if (ctx.service.token) {
      if (auth.type === 'bearer') headers.Authorization = `Bearer ${ctx.service.token}`;
      else if (auth.type === 'header') headers[auth.header || 'X-Api-Key'] = ctx.service.token;
    }
    let body;
    if (req.body !== undefined && req.method !== 'GET') {
      /* brut : un corps fait de données (événements, fiches), jamais d'un
         gabarit du manifeste. Le rendre ferait d'un « {{service.token}} » glissé
         dans un message d'erreur une fuite du jeton. */
      body = JSON.stringify(opts.brut ? req.body : ollamaAligne(url.pathname, clean(render(req.body, ctx))));
      headers['Content-Type'] = 'application/json';
    }
    const timeout = opts.timeout || 30000;
    const attempts = opts.retries ?? 0;
    let lastErr;
    for (let i = 0; i <= attempts; i++) {
      try {
        const res = await sortir(url.href, { method: req.method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeout) });
        const text = await res.text();
        const ct = res.headers.get('content-type') || '';
        let data = text;
        if (ct.includes('json') || /^\s*[[{]/.test(text)) { try { data = text ? JSON.parse(text) : null; } catch { /* texte */ } }
        if (!res.ok) {
          const msg = typeof data === 'object' && data ? (data.error || data.message || JSON.stringify(data)) : String(text).slice(0, 200);
          const err = new HttpError(502, `${inst.name} a répondu ${res.status} : ${String(msg).slice(0, 200)}`);
          err.upstreamStatus = res.status;
          throw err;
        }
        return req.select ? jsonPath(data, req.select) : data;
      } catch (e) {
        lastErr = e;
        const network = !e.upstreamStatus;
        if (!network || i === attempts) break;
        await sleep(500 * 2 ** i);
      }
    }
    if (lastErr.name === 'TimeoutError') throw new HttpError(504, `${inst.name} n’a pas répondu à temps`);
    if (!lastErr.status) throw new HttpError(502, `${inst.name} injoignable (${lastErr.cause?.code || lastErr.message})`);
    throw lastErr;
  }

  async action(inst, actionId, params, extra = {}) {
    const a = (inst.manifest.actions || []).find(x => x.id === actionId);
    if (!a) throw new HttpError(404, `Action ${actionId} absente de ${inst.name}`);
    const merged = withDefaults(a.params, params, this.context(inst, extra));
    return this.request(inst, a.request, { ...extra, params: merged, timeout: parseDuration(a.timeout, 30000), retries: a.idempotent || a.risk === 'read' ? 2 : 0 });
  }

  /**
   * Les valeurs possibles d'un champ à choix fermé.
   *
   * Par défaut on interroge le service qu'on configure. Mais certaines
   * valeurs ne lui appartiennent pas : le modèle d'embeddings de SYNAPSE
   * est une liste qui vit chez Ollama. `optionsFrom.from.capability`
   * désigne alors le service qui sait répondre, et on l'interroge lui.
   *
   * C'est ce qui évite de retaper un nom de modèle à la main — et une
   * faute de frappe dans un nom de modèle ne se voit qu'à l'exécution.
   */
  async options(inst, field, fournisseur = null) {
    if (!field.optionsFrom) return field.options || [];
    const cap = field.optionsFrom.from?.capability;
    // Une IA de conversation : la liste est celle de l'IA du Hub — toutes ses IA,
    // locales, par clé d'API et par abonnement — dès qu'il en a une.
    if (cap === 'llm.chat' && !fournisseur && this.iaServices?.actif()) {
      const brut = { models: (await this.iaServices.catalogue(inst)).map(x => ({ name: x.name, model: x.model, details: x.details })) };
      const list = field.optionsFrom.select ? jsonPath(brut, field.optionsFrom.select) : brut.models;
      const map = field.optionsFrom.map || {};
      const ecartes = (field.optionsFrom.exclude || []).map(m => String(m).toLowerCase());
      return (Array.isArray(list) ? list : [])
        .map(x => ({ value: map.value ? jsonPath(x, map.value) : x, label: map.label ? jsonPath(x, map.label) : String(x) }))
        .filter(o => !ecartes.some(m => String(o.value).toLowerCase().includes(m)));
    }
    // fournisseur : celui qui sert vraiment ce service, quand il y en a plusieurs.
    const cible = cap ? fournisseur || this.fournisseurDe(cap) : inst;
    if (!cible) return [];
    // Le fournisseur ne répond pas : on le dit, plutôt qu'une liste vide.
    if (cap && cible.status && cible.status !== 'online') throw new HttpError(503, `${cible.name} est ${cible.status === 'offline' ? 'injoignable' : cible.status}`);
    const data = await this.request(cible, field.optionsFrom, { timeout: 10000 });
    const list = Array.isArray(data) ? data : [];
    const map = field.optionsFrom.map || {};
    // exclude : des mots, pas une expression régulière — un manifeste tiers ne
    // doit pas pouvoir bloquer le Hub avec un motif à retour arrière exponentiel.
    const ecartes = (field.optionsFrom.exclude || []).map(m => String(m).toLowerCase());
    return list
      .map(x => ({ value: map.value ? jsonPath(x, map.value) : x, label: map.label ? jsonPath(x, map.label) : String(x) }))
      .filter(o => !ecartes.some(m => String(o.value).toLowerCase().includes(m)));
  }

  /** La première instance en ligne qui annonce cette capacité. */
  fournisseurDe(capacite) {
    const tous = this.services.list().filter(i => (i.manifest.capabilities?.provides || []).includes(capacite));
    return tous.find(i => i.status === 'online') || tous[0] || null;
  }

  // politique : { confiance: 'admin' } quand un administrateur essaie une adresse avant de la connecter.
  async health(inst, politique = {}) {
    const hc = inst.manifest.install.healthcheck;
    const base = inst.url.replace(/\/$/, '');
    if (hc.type === 'http') {
      const res = await sortir(base + (hc.path || '/'), { signal: AbortSignal.timeout(parseDuration(hc.timeout, 5000)), redirect: 'manual' }, politique);
      if (hc.expect ? res.status !== hc.expect : !res.ok) throw new Error(`santé : HTTP ${res.status}`);
      await res.arrayBuffer();
      return true;
    }
    if (hc.type === 'tcp' || hc.type === 'docker') {
      const u = new URL(base);
      const net = await import('node:net');
      const adresse = await destinationTcp(u.hostname.replace(/^\[|\]$/g, ''), politique);
      await new Promise((ok, ko) => {
        const s = net.connect({ host: adresse, port: Number(u.port || 80), timeout: 5000 }, () => { s.end(); ok(); });
        s.on('error', ko); s.on('timeout', () => { s.destroy(); ko(new Error('délai dépassé')); });
      });
      return true;
    }
    return true;
  }
}

export const containerName = inst => `hub-${inst.name}`;

function withDefaults(fields = [], params = {}, ctx) {
  const out = { ...params };
  for (const f of fields) {
    if (out[f.key] === undefined || out[f.key] === '') {
      if (ctx.$json && typeof ctx.$json === 'object' && !Array.isArray(ctx.$json) && ctx.$json[f.key] !== undefined) out[f.key] = ctx.$json[f.key];
      else if (f.default !== undefined) out[f.key] = typeof f.default === 'string' && f.default.includes('{{') ? render(f.default, ctx) : f.default;
    }
    if (f.required && (out[f.key] === undefined || out[f.key] === '')) throw new HttpError(400, `Paramètre requis : ${f.label}`);
  }
  return out;
}
const stringMap = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)]));
function clean(v) {
  if (Array.isArray(v)) return v.map(clean);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, clean(x)]));
  return v;
}
