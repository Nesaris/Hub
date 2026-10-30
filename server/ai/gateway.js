// Passerelle IA : un format interne, un adaptateur par fournisseur, bascule et comptage.
import fs from 'node:fs';
import { HttpError, id, log } from '../util/common.js';
import { config } from '../config.js';
import { CATALOGUE } from '../secrets.js';
const CATALOGUE_IA = () => CATALOGUE.filter(c => c.ia);

const URL_OUTILS = process.env.HUB_OUTILS_IA_URL || 'http://hub-outils-ia:7110';
// Le jeton partagé avec le pont des outils (secret Docker pont_jeton) : le pont ne répond qu'à lui.
let jetonPontLu = null;
export function entetePont(env = process.env) {
  if (jetonPontLu === null) {
    jetonPontLu = String(env.HUB_OUTILS_IA_JETON || '').trim();
    if (!jetonPontLu && env.HUB_OUTILS_IA_JETON_FILE) { try { jetonPontLu = fs.readFileSync(env.HUB_OUTILS_IA_JETON_FILE, 'utf8').trim(); } catch { jetonPontLu = ''; } }
  }
  return jetonPontLu ? { authorization: `Bearer ${jetonPontLu}` } : {};
}
export const AI_KINDS = {
  ollama: { label: 'Ollama (local ou autre machine)', needsKey: false, defaultUrl: 'http://ollama:11434', defaultModel: 'qwen3:8b' },
  openai: { label: 'OpenAI (GPT)', needsKey: true, defaultUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini' },
  'openai-compatible': { label: 'API compatible OpenAI (Mistral, OpenRouter…)', needsKey: true, defaultUrl: 'https://api.mistral.ai/v1', defaultModel: '' },
  anthropic: { label: 'Claude (Anthropic)', needsKey: true, defaultUrl: 'https://api.anthropic.com', defaultModel: 'claude-sonnet-4-5' },
  gemini: { label: 'Gemini (Google)', needsKey: true, defaultUrl: 'https://generativelanguage.googleapis.com', defaultModel: 'gemini-2.5-flash' },
  kimi: { label: 'Kimi (Moonshot)', needsKey: true, defaultUrl: 'https://api.moonshot.ai/v1', defaultModel: 'kimi-k2-0905-preview' },
  // Par abonnement, via l'outil lui-même (conteneur hub-outils-ia, outils-ia/pont.mjs) :
  // le Hub lance Claude Code ou Codex avec le compte connecté dans le conteneur.
  'claude-code': { label: 'Claude Code (abonnement Claude)', needsKey: false, outil: 'claude', defaultUrl: URL_OUTILS, defaultModel: 'sonnet' },
  codex: { label: 'Codex (abonnement ChatGPT)', needsKey: false, outil: 'codex', defaultUrl: URL_OUTILS, defaultModel: 'gpt-5-codex' },
};
export const URL_OUTILS_DEFAUT = URL_OUTILS;
export const ROLES = ['config', 'workflows', 'embeddings'];
import { CTX_OLLAMA } from '../runtime.js';
import { exigerOuvert } from '../coupure.js';
import { sortir } from '../sortie.js';

// Une génération peut durer plusieurs minutes sur un petit modèle local.
const GENERATION = { delai: 600000 };

export class AiGateway {
  constructor({ db, vault, audit, services }) { Object.assign(this, { db, vault, audit, services }); }
  attach({ secrets }) { this.secrets = secrets; }

  /* La clé d'une connexion vit dans Clés & API (« var:KIMI_API_KEY ») :
     changée là-bas, elle l'est ici. Les anciennes connexions gardent leur
     clé scellée à part, qui se lit toujours. */
  cleDe(ref) {
    if (!ref) return '';
    if (String(ref).startsWith('var:')) return this.secrets?.valeur(ref.slice(4)) || '';
    return this.vault.open(ref);
  }

  /* Une clé tapée dans la fiche IA part dans Clés & API, rangée sous le
     fournisseur, et la connexion la référence. Une seule place pour les clés. */
  rangerCle(kind, apiKey, nom, actor) {
    const entree = this.secrets && CATALOGUE_IA().find(c => c.ia === kind);
    if (!entree) return this.vault.seal(apiKey);
    const existe = this.secrets.list().some(s => s.service === entree.id);
    const r = this.secrets.poser({ service: entree.id, compte: existe ? nom : '', champs: { API_KEY: apiKey } }, actor);
    return 'var:' + r.clés[0];
  }

  list() {
    return this.db.all('SELECT * FROM ai_connections ORDER BY position, created').map(r => ({
      id: r.id, kind: r.kind, name: r.name, url: r.url, instanceId: r.instance_id, model: r.model, embedModel: r.embed_model,
      roles: JSON.parse(r.roles), position: r.position, hasKey: !!r.secret_ref, kindLabel: AI_KINDS[r.kind]?.label,
      cleRef: String(r.secret_ref || '').startsWith('var:') ? r.secret_ref.slice(4) : null,
    }));
  }
  get(cid) {
    const r = this.db.get('SELECT * FROM ai_connections WHERE id=? OR name=?', cid, cid);
    if (!r) throw new HttpError(404, 'Connexion IA introuvable');
    return r;
  }

  save(input, actor) {
    const kind = AI_KINDS[input.kind] ? input.kind : null;
    if (!kind) throw new HttpError(400, 'Type de connexion inconnu');
    const name = String(input.name || AI_KINDS[kind].label).slice(0, 40);
    let url = input.url || '';
    // Une connexion adossée à un service installé lui emprunte son adresse —
    // et, faute de mieux, son modèle. Le modèle par défaut du Hub n'est qu'une
    // supposition : elle est fausse dès que la machine n'a pas tiré celui-là,
    // et le refus arrive alors des mois plus tard, à la première question.
    let herite = '';
    if (input.instanceId) {
      const inst = this.services.get(input.instanceId);
      url = inst.url;
      try { herite = this.services.configOf(inst).DEFAULT_MODEL || ''; } catch { /* service sans ce réglage */ }
    }
    if (!url) url = AI_KINDS[kind].defaultUrl;
    try { new URL(url); } catch { throw new HttpError(400, 'Adresse invalide'); }
    const roles = (input.roles || []).filter(r => ROLES.includes(r));
    const existing = input.id ? this.get(input.id) : null;
    if (input.cleRef && this.secrets && this.secrets.valeur(input.cleRef) == null) throw new HttpError(400, `Aucune clé « ${input.cleRef} » dans Clés & API.`);
    if (!existing && AI_KINDS[kind].needsKey && !input.apiKey && !input.cleRef) throw new HttpError(400, 'Clé API requise : choisis-en une de Clés & API, ou colle-la.');
    const secret = input.cleRef ? 'var:' + input.cleRef
      : input.apiKey ? this.rangerCle(kind, input.apiKey, name, actor)
      : existing?.secret_ref || null;
    if (existing) {
      this.db.run('UPDATE ai_connections SET name=?, url=?, instance_id=?, secret_ref=?, model=?, embed_model=?, roles=? WHERE id=?', name, url, input.instanceId || null, secret, input.model || '', input.embedModel || '', JSON.stringify(roles), existing.id);
      this.audit.write(actor, 'ia.modifiée', name, { kind, roles });
      return this.get(existing.id).id;
    }
    const cid = id('ai_');
    const pos = (this.db.get('SELECT MAX(position) m FROM ai_connections')?.m ?? -1) + 1;
    this.db.run('INSERT INTO ai_connections(id,kind,name,url,instance_id,secret_ref,model,embed_model,roles,position,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      cid, kind, name, url, input.instanceId || null, secret, input.model || herite || AI_KINDS[kind].defaultModel, input.embedModel || '', JSON.stringify(roles), pos, Date.now());
    this.audit.write(actor, 'ia.ajoutée', name, { kind, url: kind === 'ollama' ? url : undefined, roles });
    return cid;
  }
  remove(cid, actor) { const r = this.get(cid); this.db.run('DELETE FROM ai_connections WHERE id=?', r.id); this.audit.write(actor, 'ia.retirée', r.name); }
  reorder(ids, actor) { ids.forEach((x, i) => this.db.run('UPDATE ai_connections SET position=? WHERE id=?', i, x)); this.audit.write(actor, 'ia.ordre', null, { ids }); }

  conn(r) {
    let url = r.url;
    if (r.instance_id) { try { url = this.services.get(r.instance_id).url; } catch { /* instance supprimée */ } }
    return { ...r, url: url.replace(/\/$/, ''), key: this.cleDe(r.secret_ref) };
  }

  candidates(role, connection) {
    if (connection) return [this.conn(this.get(connection))];
    const all = this.db.all('SELECT * FROM ai_connections ORDER BY position, created');
    const withRole = all.filter(r => JSON.parse(r.roles).includes(role));
    const list = withRole.length ? withRole : all;
    if (!list.length) throw new HttpError(400, 'Aucune connexion IA. Ajoute-en une dans la page IA.');
    return list.map(r => this.conn(r));
  }

  async models(cid) { return this.modelesDe(this.conn(this.get(cid))); }

  /**
   * Connexion d'un compte dans le conteneur des outils, pilotée depuis la page
   * IA : le pont lance l'outil, on lui montre le lien (et le code, pour Codex),
   * on lui transmet le code collé (Claude). Le jeton de Claude Code, une fois
   * obtenu, est rangé dans Clés & API et la connexion IA est créée ; Codex
   * garde son compte dans le conteneur, la connexion est créée aussi.
   */
  async connexionOutil(outil, action, corps, actor) {
    if (!['claude', 'codex'].includes(outil)) throw new HttpError(400, 'Outil inconnu.');
    const url = `${URL_OUTILS}/connexion/${outil}`;
    const politique = { confiance: 'admin' };
    const kind = outil === 'claude' ? 'claude-code' : 'codex';
    if (action === 'demarrer') { const r = await postJsonAdmin(`${url}/demarrer`, {}, politique, entetePont()); this.audit.write(actor, 'ia.outil.connexion', outil, {}); return r; }
    if (action === 'code') return postJsonAdmin(`${url}/code`, { code: String(corps?.code || '') }, politique, entetePont());
    const e = await getJson(url, entetePont(), politique);
    if (outil === 'claude' && e.jetonPret) {
      const j = await postJsonAdmin(`${url}/jeton`, {}, politique, entetePont());
      if (j.jeton) {
        const ref = this.rangerCle(kind, j.jeton, 'Abonnement', actor);
        const existante = this.db.get('SELECT id FROM ai_connections WHERE kind=?', kind);
        if (existante) this.db.run('UPDATE ai_connections SET secret_ref=? WHERE id=?', ref, existante.id);
        else this.save({ kind, name: 'Claude Code', cleRef: ref.startsWith('var:') ? ref.slice(4) : undefined, roles: ['workflows'] }, actor);
        e.etape = 'ok'; e.connexion = (existante || this.db.get('SELECT id FROM ai_connections WHERE kind=?', kind))?.id || null;
        this.audit.write(actor, 'ia.outil.connecté', outil, {});
      }
    }
    if (outil === 'codex' && e.etape === 'ok' && !this.db.get('SELECT id FROM ai_connections WHERE kind=?', kind)) {
      e.connexion = this.save({ kind, name: 'Codex', roles: ['workflows'] }, actor);
      this.audit.write(actor, 'ia.outil.connecté', outil, {});
    }
    return e;
  }

  /** Le conteneur des outils d'abonnement : outils présents, comptes connectés, commandes de connexion. */
  async outils() {
    const url = URL_OUTILS;
    try { return { joignable: true, url, ...(await getJson(`${url}/etat`, entetePont(), { confiance: 'admin' })) }; }
    catch (e) { return { joignable: false, url, erreur: e.message }; }
  }

  /* Les modèles d'une connexion pas encore enregistrée : pour le menu
     déroulant de la fiche, dès que la clé est choisie. */
  async apercuModeles({ kind, url, apiKey, cleRef, instanceId, id: cid }) {
    if (!AI_KINDS[kind]) throw new HttpError(400, 'Type de connexion inconnu');
    let u = url || AI_KINDS[kind].defaultUrl;
    if (instanceId) u = this.services.get(instanceId).url;
    let key = apiKey || (cleRef ? this.cleDe('var:' + cleRef) : '');
    if (!key && cid) key = this.conn(this.get(cid)).key;
    if (AI_KINDS[kind].needsKey && !key) throw new HttpError(400, 'Choisis d’abord une clé.');
    // L'adresse vient d'être saisie par un administrateur : son geste vaut autorisation.
    return this.modelesDe({ kind, url: String(u).replace(/\/$/, ''), key }, { confiance: 'admin' });
  }

  async modelesDe(c, politique) {
    if (AI_KINDS[c.kind]?.outil) { const r = await getJson(`${c.url}/modeles?outil=${AI_KINDS[c.kind].outil}`, entetePont(), politique); return r.modeles || []; }
    if (c.kind === 'ollama') { const r = await getJson(`${c.url}/api/tags`, {}, politique); return (r.models || []).map(m => m.name); }
    if (c.kind === 'anthropic') { const r = await getJson(`${c.url}/v1/models`, { 'x-api-key': c.key, 'anthropic-version': '2023-06-01' }, politique); return (r.data || []).map(m => m.id); }
    if (c.kind === 'gemini') { const r = await getJson(`${c.url}/v1beta/models?key=${encodeURIComponent(c.key)}`, {}, politique); return (r.models || []).map(m => m.name.replace(/^models\//, '')); }
    const r = await getJson(`${c.url}/models`, { Authorization: `Bearer ${c.key}` }, politique);
    return (r.data || []).map(m => m.id);
  }

  async test(cid) {
    const t0 = Date.now();
    const r = await this.chat({ connection: cid, messages: [{ role: 'user', content: 'Réponds seulement : ok' }], maxTokens: 10 });
    return { ok: true, ms: Date.now() - t0, model: r.model, reply: r.text.slice(0, 50) };
  }

  // { connection?, role, system, messages:[{role,content}], json, temperature, maxTokens }
  /* Plafond global sur 24 heures glissantes, toutes connexions confondues
     (SEC-LLM-002) : un workflow emballé ou une boucle de l'assistant s'arrête
     avant la facture. Le dépassement est tracé une fois par jour. */
  plafond() {
    const j = this.db.get('SELECT COUNT(*) n, COALESCE(SUM(tokens_in + tokens_out), 0) t FROM ai_usage WHERE ts > ?', Date.now() - 86400e3);
    if (j.n < config.iaAppelsJour && j.t < config.iaJetonsJour) return;
    const jour = new Date().toISOString().slice(0, 10);
    if (this.db.setting('ia_plafond_signale', '') !== jour) {
      this.db.setSetting('ia_plafond_signale', jour);
      this.audit.write('hub', 'ia.plafond', null, { appels: j.n, jetons: j.t, plafondAppels: config.iaAppelsJour, plafondJetons: config.iaJetonsJour });
    }
    throw new HttpError(429, `Plafond quotidien de l’IA atteint (${j.n} appels, ${j.t} jetons sur 24 h). Il se relève de lui-même ; HUB_IA_APPELS_JOUR et HUB_IA_JETONS_JOUR le règlent.`);
  }

  async chat(req) {
    exigerOuvert(this.db, 'ia');
    this.plafond();
    const list = this.candidates(req.role || 'workflows', req.connection);
    let lastErr;
    for (const c of list) {
      try {
        const r = await this.call(c, req);
        this.db.run('INSERT INTO ai_usage(ts,connection_id,role,tokens_in,tokens_out) VALUES(?,?,?,?,?)', Date.now(), c.id, req.role || null, r.tokensIn || 0, r.tokensOut || 0);
        let parsed = null;
        if (req.json) parsed = extractJson(r.text);
        return { text: r.text, json: parsed, model: r.model, connection: c.name };
      } catch (e) {
        lastErr = e;
        log.warn('IA', c.name, e.message);
        if (req.connection) break;
      }
    }
    const quoi = list[0] ? ` (${list[0].name}, modèle « ${req.model || list[0].model || 'non défini'} »)` : '';
    throw new HttpError(502, `IA indisponible${quoi} : ${lastErr?.message}`);
  }

  async call(c, req) {
    exigerOuvert(this.db, 'ia');
    const model = req.model || c.model;
    const temp = req.temperature ?? 0.3;
    const maxTokens = Math.min(req.maxTokens || 2048, config.iaJetonsMax);
    const timeout = c.kind === 'ollama' || AI_KINDS[c.kind]?.outil ? 300000 : 120000;
    // Un seul signal pour les deux raisons d'arrêter : le délai, et le bouton
    // « Arrêter ». `AbortSignal.any` déclenche au premier des deux.
    const signal = req.signal ? AbortSignal.any([AbortSignal.timeout(timeout), req.signal]) : AbortSignal.timeout(timeout);
    // Suivre la réponse n'a d'intérêt que si quelqu'un regarde : sans
    // `onToken`, chaque fournisseur garde exactement l'appel d'avant.
    const suivre = typeof req.onToken === 'function' ? req.onToken : null;
    if (AI_KINDS[c.kind]?.outil) {
      // L'outil répond d'un bloc ; le jeton (Claude Code) vient de Clés & API, Codex garde le sien dans le conteneur.
      const r = await postJson(`${c.url}/chat`, { outil: AI_KINDS[c.kind].outil, model, system: req.system || '', messages: req.messages, maxTokens, jeton: c.key || '' }, entetePont(), signal);
      if (suivre) { try { suivre(r.text || '', r.text || ''); } catch { /* affichage */ } }
      return { text: r.text || '', model: r.model || model, tokensIn: r.tokensIn || 0, tokensOut: r.tokensOut || 0 };
    }
    if (c.kind === 'ollama') {
      const messages = [...(req.system ? [{ role: 'system', content: req.system }] : []), ...req.messages];
      /* Trois réglages qui faisaient toute la lenteur :
         - think:false — qwen3 « réfléchit » par défaut : des centaines de
           jetons invisibles avant la première lettre de la réponse ;
         - num_ctx — Ollama tronque en silence au-delà de 2 048 ou 4 096
           jetons. Le contexte de l'assistant (catalogue, services,
           workflows) dépasse : le modèle perdait ses consignes. On prend un
           palier fixe, pour ne pas recharger le modèle à chaque appel ;
         - keep_alive — le modèle reste chargé une demi-heure au lieu de
           cinq minutes : la question suivante ne paie pas le rechargement. */
      /* UNE taille de contexte, toujours la même : Ollama recharge le modèle
         dès que num_ctx change. Des paliers selon la taille du prompt
         (8 k pour un nœud IA, 16 k pour l'assistant…) — et SYNAPSE, qui
         partage le modèle, à 8 k — le faisaient recharger à tour de rôle :
         10 à 20 s perdues à chaque question sur un 14b. Au-delà du palier
         fixe seulement, on monte, faute de mieux. */
      const estime = Math.ceil(JSON.stringify(messages).length / 3) + maxTokens;
      const num_ctx = estime <= CTX_OLLAMA ? CTX_OLLAMA : 32768;
      // Monter au-delà du palier recharge le modèle pour tout le monde : on le signale.
      if (num_ctx !== CTX_OLLAMA) log.warn('IA', `prompt de ~${estime} jetons : contexte ${num_ctx} (le modèle va se recharger)`);
      const corps = { model, messages, format: req.json ? 'json' : undefined, think: false, keep_alive: '30m',
        /* Une pénalité de répétition légère : un petit modèle qui recopie une
           liste de souvenirs peut boucler sur la même ligne jusqu'à la limite. */
        options: { temperature: temp, num_predict: maxTokens, num_ctx, repeat_penalty: 1.1, repeat_last_n: 256 } };
      if (suivre) {
        const { texte, meta } = await postStream(`${c.url}/api/chat`, { ...corps, stream: true }, {}, signal,
          (o, m) => { if (o.prompt_eval_count) m.in = o.prompt_eval_count; if (o.eval_count) m.out = o.eval_count; return o.message?.content || ''; }, suivre);
        return { text: texte, model, tokensIn: meta.in, tokensOut: meta.out };
      }
      const r = await postJson(`${c.url}/api/chat`, { ...corps, stream: false }, {}, signal);
      return { text: r.message?.content || '', model, tokensIn: r.prompt_eval_count, tokensOut: r.eval_count };
    }
    if (c.kind === 'anthropic') {
      const corps = { model, system: req.system || undefined, messages: req.messages, max_tokens: maxTokens, temperature: temp };
      const entetes = { 'x-api-key': c.key, 'anthropic-version': '2023-06-01' };
      if (suivre) {
        const { texte, meta } = await postStream(`${c.url}/v1/messages`, { ...corps, stream: true }, entetes, signal,
          (o, m) => {
            if (o.message?.usage?.input_tokens) m.in = o.message.usage.input_tokens;
            if (o.usage?.output_tokens) m.out = o.usage.output_tokens;
            return o.type === 'content_block_delta' ? (o.delta?.text || '') : '';
          }, suivre);
        return { text: texte, model, tokensIn: meta.in, tokensOut: meta.out };
      }
      const r = await postJson(`${c.url}/v1/messages`, corps, entetes, signal);
      return { text: (r.content || []).filter(b => b.type === 'text').map(b => b.text).join(''), model, tokensIn: r.usage?.input_tokens, tokensOut: r.usage?.output_tokens };
    }
    if (c.kind === 'gemini') {
      const r = await postJson(`${c.url}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        systemInstruction: req.system ? { parts: [{ text: req.system }] } : undefined,
        contents: req.messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        generationConfig: { temperature: temp, maxOutputTokens: maxTokens, responseMimeType: req.json ? 'application/json' : undefined },
      }, { 'x-goog-api-key': c.key }, signal);
      return { text: r.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '', model, tokensIn: r.usageMetadata?.promptTokenCount, tokensOut: r.usageMetadata?.candidatesTokenCount };
    }
    // openai, openai-compatible, kimi
    const messages = [...(req.system ? [{ role: 'system', content: req.system }] : []), ...req.messages];
    const corps = { model, messages, temperature: temp, max_tokens: maxTokens, response_format: req.json && c.kind === 'openai' ? { type: 'json_object' } : undefined };
    const entetes = { Authorization: `Bearer ${c.key}` };
    if (suivre) {
      const { texte, meta } = await postStream(`${c.url}/chat/completions`, { ...corps, stream: true, stream_options: { include_usage: true } }, entetes, signal,
        (o, m) => {
          if (o.usage?.prompt_tokens) m.in = o.usage.prompt_tokens;
          if (o.usage?.completion_tokens) m.out = o.usage.completion_tokens;
          return o.choices?.[0]?.delta?.content || '';
        }, suivre);
      return { text: texte, model, tokensIn: meta.in, tokensOut: meta.out };
    }
    const r = await postJson(`${c.url}/chat/completions`, corps, entetes, signal);
    return { text: r.choices?.[0]?.message?.content || '', model, tokensIn: r.usage?.prompt_tokens, tokensOut: r.usage?.completion_tokens };
  }

  async embed({ connection, input }) {
    exigerOuvert(this.db, 'ia');
    this.plafond();
    const list = this.candidates('embeddings', connection);
    let lastErr;
    for (const c of list) {
      try {
        if (c.kind === 'ollama') {
          const model = c.embed_model || 'nomic-embed-text';
          const r = await postJson(`${c.url}/api/embed`, { model, input }, {}, AbortSignal.timeout(120000));
          this.compterEmbed(c, input);
          return { vector: r.embeddings?.[0], dims: r.embeddings?.[0]?.length, model };
        }
        if (c.kind === 'openai' || c.kind === 'openai-compatible') {
          const model = c.embed_model || 'text-embedding-3-small';
          const r = await postJson(`${c.url}/embeddings`, { model, input }, { Authorization: `Bearer ${c.key}` }, AbortSignal.timeout(60000));
          this.compterEmbed(c, input);
          return { vector: r.data?.[0]?.embedding, dims: r.data?.[0]?.embedding?.length, model };
        }
        throw new Error(`${c.name} ne fournit pas d’embeddings`);
      } catch (e) { lastErr = e; if (connection) break; }
    }
    throw new HttpError(502, `Embeddings indisponibles : ${lastErr?.message}`);
  }

  // Un vecteur compte dans le plafond du jour, à raison d'un jeton pour quatre caractères.
  compterEmbed(c, input) {
    this.db.run('INSERT INTO ai_usage(ts,connection_id,role,tokens_in,tokens_out) VALUES(?,?,?,?,?)', Date.now(), c.id, 'embeddings', Math.ceil(String(input ?? '').length / 4), 0);
  }

  usage(days = 30) {
    return this.db.all(`SELECT c.name, u.connection_id, SUM(tokens_in) tin, SUM(tokens_out) tout, COUNT(*) calls FROM ai_usage u LEFT JOIN ai_connections c ON c.id=u.connection_id WHERE ts > ? GROUP BY u.connection_id`, Date.now() - days * 86400e3);
  }
}

/**
 * Même chose, mais en écoutant la réponse au fur et à mesure.
 *
 * Chaque fournisseur a sa façon d'envoyer les morceaux : Ollama une ligne JSON
 * par jeton, les autres un flux d'événements « data: ». `extrait` sait lire un
 * objet et en tirer le bout de texte ; le reste — découpage en lignes, fin de
 * flux — est commun. Le texte complet est rendu à la fin, comme si l'appel
 * n'avait pas été suivi : l'appelant qui ignore `onToken` ne voit aucune
 * différence.
 */
async function postStream(url, body, headers, signal, extrait, onToken) {
  const res = await sortir(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body), signal,
  }, GENERATION);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 180)}`);
  const lecteur = res.body.getReader();
  const dec = new TextDecoder();
  let reste = '', texte = '', meta = {};
  const ligne = (brute) => {
    const l = brute.trim();
    if (!l || l.startsWith(':')) return;
    const charge = l.startsWith('data:') ? l.slice(5).trim() : l;
    if (charge === '[DONE]') return;
    let o; try { o = JSON.parse(charge); } catch { return; }
    const bout = extrait(o, meta);
    if (bout) { texte += bout; try { onToken(texte, bout); } catch { /* l'affichage ne casse pas l'appel */ } }
  };
  for (;;) {
    const { done, value } = await lecteur.read();
    if (done) break;
    reste += dec.decode(value, { stream: true });
    const lignes = reste.split('\n');
    reste = lignes.pop() || '';
    for (const l of lignes) ligne(l);
  }
  // Le dernier morceau n'est pas toujours suivi d'un retour à la ligne — et un
  // serveur qui ignore « stream » répond même tout en un seul bloc. Sans cette
  // ligne, cette réponse-là était lue puis jetée.
  if (reste.trim()) ligne(reste);
  return { texte, meta };
}

async function postJson(url, body, headers, signal) {
  const res = await sortir(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal }, GENERATION);
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 180)}`);
  return JSON.parse(text);
}
async function postJsonAdmin(url, body, politique, entetes = {}) {
  const res = await sortir(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...entetes }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) }, politique);
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, j?.error || `HTTP ${res.status}`);
  return j;
}
async function getJson(url, headers = {}, politique = {}) {
  const res = await sortir(url, { headers, signal: AbortSignal.timeout(15000) }, politique);
  if (!res.ok) {
    // Ce que le fournisseur dit (« Invalid Authentication ») vaut mieux qu'un code nu.
    const j = await res.json().catch(() => ({}));
    const dit = j?.error?.message || (typeof j?.error === 'string' ? j.error : '') || j?.message || '';
    throw new HttpError(502, `${res.status === 401 || res.status === 403 ? 'Clé refusée par le fournisseur' : `HTTP ${res.status}`}${dit ? ` : ${String(dit).slice(0, 160)}` : ''}`);
  }
  return res.json();
}
export function extractJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* */ }
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fence) { try { return JSON.parse(fence[1]); } catch { /* */ } }
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch { /* */ } }
  return null;
}
