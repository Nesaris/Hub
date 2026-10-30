/*
 * L'IA du Hub, pour les services.
 *
 * Un service qui a besoin d'une IA (llm.chat) reçoit l'adresse de cette
 * passerelle au lieu de celle d'un Ollama : il y trouve TOUTES les IA de la
 * page IA — Ollama, les fournisseurs par clé d'API (Claude, GPT, Gemini, Kimi,
 * Mistral…), Claude Code et Codex par abonnement — sous la forme qu'il sait
 * déjà parler :
 *
 *   API Ollama   …/api/tags  …/api/chat (flux NDJSON ou non)  …/api/embed  …/api/version
 *   API OpenAI   …/v1/models …/v1/chat/completions (flux SSE ou non)
 *
 * Un modèle se nomme « connexion/modèle » (« claude-code/sonnet »,
 * « kimi/kimi-k2-0905-preview ») ; un nom nu (« qwen3.8:9b ») va à l'Ollama
 * qui l'a, comme avant : un service qui parlait à Ollama continue de marcher.
 *
 * Qui appelle : le jeton est dans le chemin (/ia/<jeton>/…), parce qu'un
 * client Ollama n'envoie pas d'en-tête d'autorisation. Il est propre à chaque
 * service (dérivé de son nom par un secret du Hub), circule seulement sur le
 * réseau interne de la pile, et se révoque pour tous en changeant le secret.
 * Le plafond quotidien de l'IA, la coupure d'urgence et le comptage par
 * connexion s'appliquent comme pour le reste du Hub, plus un débit et un
 * quota du jour par service ; l'usage est noté au nom du service. Du reste de
 * l'API Ollama, seules les lectures passent (ps, show) : tirer, pousser,
 * créer, copier ou supprimer un modèle reste à l'administrateur du Hub. Les
 * outils par abonnement (Claude Code, Codex) sont fermés aux services, sauf à
 * ceux que HUB_IA_SERVICES_OUTILS nomme : ils gardent le compte de
 * l'utilisateur à portée du modèle.
 * L'assistant n'a aucune route vers ici : ce n'est pas /api.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { HttpError, log } from './util/common.js';
import { Readable } from 'node:stream';
import { AI_KINDS } from './ai/gateway.js';
import { sortir } from './sortie.js';
import { exigerOuvert } from './coupure.js';
import { config } from './config.js';

export const PORT_INTERNE = Number(process.env.HUB_IA_SERVICES_PORT || 8101);
const HOTE_INTERNE = process.env.HUB_IA_SERVICES_HOTE || 'hub';
const PREFIXE = /^\/ia\/(ias_[a-z0-9-]{2,31}_[0-9a-f]{64})(\/.*)$/;
const MAX_CORPS = 4 * 1048576;
// Ce que la passerelle relaie tel quel à l'Ollama du Hub : des lectures.
const RELAYEES = new Set(['GET /api/ps', 'POST /api/show']);
const CACHE_MS = 60_000;
const slug = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'ia';

export class IaServices {
  constructor({ db, ai, services, audit, quotas = null }) {
    Object.assign(this, { db, ai, services, audit, quotas });
    this.limites = { minute: config.iaServiceAppelsMinute, jour: config.iaServiceAppelsJour };
    this.outilsPermis = new Set(String(config.iaServicesOutils || '').split(',').filter(Boolean));
    this.cache = new Map();
  }

  /** Le secret de dérivation des jetons, tiré une fois et gardé en base. */
  secret() {
    let s = this.db.setting('ia_services_secret', '');
    if (!s) { s = crypto.randomBytes(32).toString('hex'); this.db.setSetting('ia_services_secret', s); }
    return s;
  }
  jeton(nom) {
    if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(String(nom))) return '';
    return `ias_${nom}_${crypto.createHmac('sha256', this.secret()).update('ia:' + nom).digest('hex')}`;
  }
  /** Le service à qui appartient ce jeton, ou null (comparaison en temps constant). */
  serviceDe(jeton) {
    const m = /^ias_([a-z0-9-]{2,31})_[0-9a-f]{64}$/.exec(String(jeton || ''));
    if (!m) return null;
    const attendu = this.jeton(m[1]);
    if (!attendu || attendu.length !== jeton.length || !crypto.timingSafeEqual(Buffer.from(attendu), Buffer.from(jeton))) return null;
    return this.services.list().find(i => i.name === m[1]) || null;
  }
  /** Changer le secret révoque tous les jetons ; les services les reçoivent à leur prochain déploiement. */
  tourner(acteur) {
    this.db.setSetting('ia_services_secret', crypto.randomBytes(32).toString('hex'));
    this.audit?.write(acteur, 'ia.services.jetons_tournés', null, {});
  }

  /** La passerelle sert dès que le Hub a au moins une IA. */
  actif() { try { return this.ai.list().length > 0; } catch { return false; } }
  adresse(nom) { const j = this.jeton(nom); return j ? `http://${HOTE_INTERNE}:${PORT_INTERNE}/ia/${j}` : ''; }

  /** Ce que le Hub donne comme fournisseur llm.chat à ce service. */
  fournisseur(inst) {
    if (!this.actif() || !inst?.name) return null;
    const url = this.adresse(inst.name);
    if (!url) return null;
    const defaut = this.modeleParDefaut(inst);
    // Retenu : ce service a été déployé avec la passerelle (son lien IA le dit).
    const via = this.db.setting('ia_passerelle_services', {}) || {};
    if (!via[inst.id]) { via[inst.id] = Date.now(); this.db.setSetting('ia_passerelle_services', via); }
    return { url, hostUrl: url, name: 'IA du Hub', id: 'hub-ia', config: { DEFAULT_MODEL: defaut }, jetonCerveau: () => '' };
  }
  /** Ce service parle-t-il à la passerelle (déployé avec elle) ? */
  utilise(inst) { return !!(this.actif() && (this.db.setting('ia_passerelle_services', {}) || {})[inst?.id]); }
  oublier(instId) { const via = this.db.setting('ia_passerelle_services', {}) || {}; if (via[instId]) { delete via[instId]; this.db.setSetting('ia_passerelle_services', via); } }

  /** Une connexion ouverte à ce service ? (sans service : la vue de l'administrateur, tout) */
  ouverte(c, inst) { return !inst || !AI_KINDS[c.kind]?.outil || this.outilsPermis.has(inst.name); }

  /** D'où vient un modèle, sans appel réseau : « locale », « cloud » ou « abonnement », et sa connexion. */
  decrire(nom) {
    const n = String(nom || '');
    const l = this.ai.list();
    const i = n.indexOf('/');
    const c = (i > 0 && l.find(x => slug(x.name) === n.slice(0, i))) || l.find(x => x.kind === 'ollama') || null;
    if (!c) return { famille: 'inconnue', connexion: null };
    const kind = AI_KINDS[c.kind] || {};
    return { famille: c.kind === 'ollama' ? 'locale' : kind.outil ? 'abonnement' : 'cloud', connexion: c.name, fournisseur: kind.label || c.kind };
  }

  // ---- les modèles ----
  async modelesDe(c) {
    const k = c.id;
    const v = this.cache.get(k);
    if (v && Date.now() - v.t < CACHE_MS) return v.l;
    let l = [];
    const kind = AI_KINDS[c.kind] || {};
    try {
      if (c.kind === 'ollama') l = await this.ai.models(c.id);
      else if (kind.outil) l = await this.ai.models(c.id);
      else l = [c.model || kind.defaultModel].filter(Boolean);
    } catch (e) { l = c.kind === 'ollama' ? [] : [c.model || kind.defaultModel].filter(Boolean); log.warn('ia-services', `${c.name} : ${e.message}`); }
    this.cache.set(k, { t: Date.now(), l });
    return l;
  }

  /** Toutes les IA du Hub, comme les liste Ollama. */
  async catalogue(inst = null) {
    const out = [], nus = new Set();
    for (const c of this.ai.list().filter(x => this.ouverte(x, inst))) {
      const kind = AI_KINDS[c.kind] || {};
      const prefixe = slug(c.name);
      for (const m of await this.modelesDe(c)) {
        const famille = c.kind === 'ollama' ? 'locale' : kind.outil ? 'abonnement' : 'cloud';
        const details = { family: famille, connexion: c.name, fournisseur: kind.label || c.kind, parameter_size: famille === 'locale' ? undefined : 'cloud' };
        // Un modèle d'Ollama garde son nom nu (le premier Ollama qui l'a) : une
        // liste sans doublon, et les services d'avant ne voient rien changer.
        // « connexion/modèle » reste accepté pour lui aussi.
        if (c.kind === 'ollama' && !nus.has(m)) { nus.add(m); out.push({ name: m, model: m, details, connexion: c.id, modele: m }); continue; }
        out.push({ name: `${prefixe}/${m}`, model: `${prefixe}/${m}`, details, connexion: c.id, modele: m });
      }
    }
    return out;
  }

  /** Le modèle que les services prennent par défaut : celui de la connexion « workflows », sinon la première. */
  modeleParDefaut(inst = null) {
    const l = this.ai.list().filter(x => this.ouverte(x, inst));
    const c = l.find(x => x.roles.includes('workflows')) || l[0];
    if (!c) return '';
    return c.kind === 'ollama' ? (c.model || '') : `${slug(c.name)}/${c.model || AI_KINDS[c.kind]?.defaultModel || ''}`;
  }

  /** « connexion/modèle » ou un nom nu → { connexion, modele }. */
  async resoudre(nom, inst = null) {
    const n = String(nom || '').trim();
    const l = this.ai.list();
    if (!l.length) throw new HttpError(503, 'Le Hub n’a aucune IA : ajoute-en une dans sa page IA.');
    if (!n) { const d = this.modeleParDefaut(inst); if (!d) throw new HttpError(400, 'Modèle manquant.'); return this.resoudre(d, inst); }
    const i = n.indexOf('/');
    if (i > 0) {
      const c = l.find(x => slug(x.name) === n.slice(0, i));
      if (c && !this.ouverte(c, inst)) throw new HttpError(403, `${c.name} : outil par abonnement, fermé aux services (HUB_IA_SERVICES_OUTILS).`);
      if (c) return { connexion: c, modele: n.slice(i + 1) };
    }
    for (const c of l.filter(x => x.kind === 'ollama')) if ((await this.modelesDe(c)).includes(n)) return { connexion: c, modele: n };
    // Un nom nu inconnu : le premier Ollama le tente (il vient peut-être d'être tiré).
    const o = l.find(x => x.kind === 'ollama');
    if (o && !n.includes('/')) return { connexion: o, modele: n };
    throw new HttpError(404, `Modèle inconnu du Hub : ${n.slice(0, 80)}. La liste : /api/tags.`);
  }

  // ---- le serveur interne ----
  serveur() {
    return http.createServer((req, res) => {
      this.traiter(req, res).catch(e => {
        const status = e.status || 502;
        if (res.headersSent) { try { res.end(); } catch { /* fermé */ } return; }
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      });
    });
  }
  ecouter(port = PORT_INTERNE, hote = '0.0.0.0') {
    this.srv = this.serveur();
    // requestTimeout borne la réception de la requête (4 Mio au plus), pas la réponse en flux.
    this.srv.headersTimeout = 20_000; this.srv.requestTimeout = 120_000; this.srv.keepAliveTimeout = 5_000;
    return new Promise(r => this.srv.listen(port, hote, () => r(this.srv.address().port)));
  }
  fermer() { try { this.srv?.close(); } catch { /* déjà fermé */ } }

  async corps(req) {
    let brut = '';
    for await (const d of req) { brut += d; if (brut.length > MAX_CORPS) throw new HttpError(413, 'Corps trop grand.'); }
    try { return brut ? JSON.parse(brut) : {}; } catch { throw new HttpError(400, 'JSON attendu.'); }
  }

  async traiter(req, res) {
    const url = new URL(req.url, 'http://hub');
    const m = PREFIXE.exec(url.pathname);
    if (!m) throw new HttpError(404, 'Introuvable.');
    const inst = this.serviceDe(m[1]);
    if (!inst) throw new HttpError(401, 'Jeton de service refusé.');
    const chemin = m[2], verbe = req.method;
    const json = (status, o) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)); };

    if (verbe === 'GET' && chemin === '/api/version') return json(200, { version: '0.0.0-hub' });
    if (verbe === 'GET' && chemin === '/api/tags') {
      const l = await this.catalogue(inst);
      return json(200, { models: l.map(x => ({ name: x.name, model: x.model, modified_at: new Date(0).toISOString(), size: 0, digest: '', details: x.details })) });
    }
    if (verbe === 'GET' && chemin === '/v1/models') {
      const l = await this.catalogue(inst);
      return json(200, { object: 'list', data: l.map(x => ({ id: x.name, object: 'model', created: 0, owned_by: x.details.connexion })) });
    }
    const appelIA = verbe === 'POST' && ['/api/chat', '/api/generate', '/v1/chat/completions', '/api/embed', '/api/embeddings'].includes(chemin);
    if (appelIA) this.quotas?.prendre('ia-service', inst.name, this.limites);
    if (verbe === 'POST' && (chemin === '/api/chat' || chemin === '/api/generate')) return this.chatOllama(inst, await this.corps(req), res, chemin === '/api/generate');
    if (verbe === 'POST' && chemin === '/v1/chat/completions') return this.chatOpenAI(inst, await this.corps(req), res);
    if (verbe === 'POST' && (chemin === '/api/embed' || chemin === '/api/embeddings')) {
      const b = await this.corps(req);
      const entree = b.input ?? b.prompt ?? '';
      const r = await this.ai.embed({ input: Array.isArray(entree) ? entree[0] : entree });
      return json(200, chemin === '/api/embed' ? { model: r.model, embeddings: [r.vector] } : { embedding: r.vector });
    }
    // Le reste de l'API Ollama (show, ps, pull…) : transmis tel quel au premier
    // Ollama du Hub, pour qu'un service qui parlait à Ollama ne perde rien.
    if (RELAYEES.has(`${verbe} ${chemin}`)) return this.relayer(req, res, chemin + url.search);
    if (chemin.startsWith('/api/')) throw new HttpError(403, `${verbe} ${chemin} : réservé à l’administrateur du Hub (la passerelle ne relaie que api/ps et api/show).`);
    throw new HttpError(404, `${verbe} ${chemin} : pas dans la passerelle (api/tags, api/chat, api/generate, api/embed, v1/models, v1/chat/completions).`);
  }

  async relayer(req, res, chemin) {
    exigerOuvert(this.db, 'ia');
    const o = this.ai.list().find(x => x.kind === 'ollama');
    if (!o) throw new HttpError(404, `${chemin.split('?')[0]} : il faut un Ollama dans la page IA du Hub.`);
    const base = this.ai.conn(this.ai.get(o.id)).url;
    const corps = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.from(JSON.stringify(await this.corps(req)));
    const r = await sortir(base + chemin, { method: req.method, headers: corps ? { 'content-type': 'application/json' } : {}, body: corps, signal: AbortSignal.timeout(600_000) }, { delai: 600_000, taille: 64 * 1048576 });
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' });
    if (!r.body) return res.end();
    Readable.fromWeb(r.body).pipe(res);
  }

  // Les messages : le système à part, le reste tel quel (texte seulement).
  messages(b) {
    const l = Array.isArray(b.messages) ? b.messages : b.prompt !== undefined ? [{ role: 'user', content: String(b.prompt) }] : [];
    const systeme = [b.system, ...l.filter(x => x.role === 'system').map(x => x.content)].filter(Boolean).map(String).join('\n\n');
    const reste = l.filter(x => x.role !== 'system').map(x => ({ role: x.role === 'assistant' ? 'assistant' : 'user', content: typeof x.content === 'string' ? x.content : Array.isArray(x.content) ? x.content.map(p => p.text || '').join('') : String(x.content ?? '') }));
    if (!reste.length) throw new HttpError(400, 'Aucun message.');
    return { systeme, reste };
  }

  async appel(inst, b, { json = false, maxTokens, temperature, onToken, signal }) {
    const { connexion, modele } = await this.resoudre(b.model, inst);
    const { systeme, reste } = this.messages(b);
    const r = await this.ai.chat({ connection: connexion.id, model: modele, role: `service:${inst.name}`, system: systeme, messages: reste, json, maxTokens, temperature, onToken, signal });
    return { ...r, nom: b.model || `${slug(connexion.name)}/${modele}` };
  }

  async chatOllama(inst, b, res, generate) {
    const flux = b.stream !== false;
    const opt = b.options || {};
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    const base = { maxTokens: opt.num_predict > 0 ? opt.num_predict : undefined, temperature: opt.temperature, json: b.format === 'json' || (b.format && typeof b.format === 'object'), signal: ac.signal };
    const fin = (r, t0) => ({ model: r.nom, created_at: new Date().toISOString(), done: true, done_reason: 'stop', total_duration: (Date.now() - t0) * 1e6, prompt_eval_count: r.tokensIn || 0, eval_count: r.tokensOut || 0 });
    const t0 = Date.now();
    if (!flux) {
      const r = await this.appel(inst, b, base);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ...fin(r, t0), ...(generate ? { response: r.text } : { message: { role: 'assistant', content: r.text } }) }));
    }
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
    const morceau = bout => res.write(JSON.stringify({ model: b.model, created_at: new Date().toISOString(), done: false, ...(generate ? { response: bout } : { message: { role: 'assistant', content: bout } }) }) + '\n');
    try {
      const r = await this.appel(inst, b, { ...base, onToken: (_t, bout) => morceau(bout) });
      res.end(JSON.stringify({ ...fin(r, t0), ...(generate ? { response: '' } : { message: { role: 'assistant', content: '' } }) }) + '\n');
    } catch (e) { res.end(JSON.stringify({ error: e.message }) + '\n'); }
  }

  async chatOpenAI(inst, b, res) {
    const flux = b.stream === true;
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    const base = { maxTokens: b.max_tokens || b.max_completion_tokens, temperature: b.temperature, json: b.response_format?.type === 'json_object', signal: ac.signal };
    const id = 'chatcmpl-' + crypto.randomBytes(9).toString('hex'), cree = Math.floor(Date.now() / 1000);
    if (!flux) {
      const r = await this.appel(inst, b, base);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ id, object: 'chat.completion', created: cree, model: r.nom, choices: [{ index: 0, message: { role: 'assistant', content: r.text }, finish_reason: 'stop' }], usage: { prompt_tokens: r.tokensIn || 0, completion_tokens: r.tokensOut || 0, total_tokens: (r.tokensIn || 0) + (r.tokensOut || 0) } }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
    const ev = o => res.write(`data: ${JSON.stringify(o)}\n\n`);
    try {
      const r = await this.appel(inst, b, { ...base, onToken: (_t, bout) => ev({ id, object: 'chat.completion.chunk', created: cree, model: b.model, choices: [{ index: 0, delta: { content: bout }, finish_reason: null }] }) });
      ev({ id, object: 'chat.completion.chunk', created: cree, model: r.nom, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    } catch (e) { ev({ error: { message: e.message } }); }
    res.end('data: [DONE]\n\n');
  }
}
