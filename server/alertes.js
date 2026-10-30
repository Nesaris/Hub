// Les alertes du Hub sur Telegram : ce qui demande l'administrateur, sans
// ouvrir le Hub.
//
//   - une mise à jour disponible, avec un bouton pour la lancer ;
//   - un workflow en échec, puis de nouveau réussi ;
//   - une IA injoignable, puis revenue ;
//   - un service qui tombe, puis revient.
//
// Le bot et la discussion sont ceux d'un compte Telegram de Clés & API : le
// Hub n'en garde pas de copie. Un bouton est à usage unique, expire, et n'est
// accepté que depuis la discussion configurée — un message transféré ou un
// autre membre d'un groupe ne lance rien. Chaque mise à jour lancée ainsi est
// journalisée avec l'auteur Telegram.
import crypto from 'node:crypto';
import { config } from './config.js';
import { sortir } from './sortie.js';
import { HttpError, log } from './util/common.js';
import { depuisService } from './ai/journal.js';

export const TYPES = {
  maj: 'Mises à jour disponibles (avec un bouton pour les lancer)',
  workflow: 'Workflows en échec, puis rétablis',
  ia: 'IA injoignable, puis revenue',
  service: 'Services hors ligne, puis revenus',
};
const DEFAUT = { canal: '', types: Object.fromEntries(Object.keys(TYPES).map(k => [k, true])) };
const VALIDITE_BOUTON = 3 * 86400e3;
const court = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export class Alertes {
  constructor({ db, bus, audit, services, ai, agent }) {
    Object.assign(this, { db, bus, audit, services, ai, agent });
    this.etat = { envoyees: 0, derniere: null, erreur: null, ecoute: false };
    this.connus = new Map();        // service → { name, status, version, detail }
    this.workflowsEnPanne = new Map();
    this.iaEnPanne = new Map();
    this.minuteurs = [];
    this.ecoute = null;
  }

  reglage() {
    const r = this.db.setting('alertes', null) || {};
    return { canal: r.canal || '', types: { ...DEFAUT.types, ...(r.types || {}) } };
  }
  /** Les comptes Telegram de Clés & API, tels que l'assistant les connaît. */
  canaux() { return (this.agent?.canaux() || []).filter(c => c.noeud.type === 'out.telegram').map(c => ({ canal: c.canal, pret: c.pret, manque: c.manque || null })); }
  vue() { return { ...this.reglage(), canaux: this.canaux(), libelles: TYPES, etat: this.etat }; }

  poser(b, acteur) {
    const avant = this.reglage();
    const canal = b.canal === undefined ? avant.canal : String(b.canal || '');
    if (canal && !this.canaux().some(c => c.canal === canal && c.pret)) throw new HttpError(400, `${canal} n’est pas un compte Telegram prêt dans Clés & API (jeton du bot et identifiant de discussion).`);
    const types = { ...avant.types };
    for (const k of Object.keys(TYPES)) if (b.types && k in b.types) types[k] = !!b.types[k];
    this.db.setSetting('alertes', { canal, types });
    this.audit.write(acteur, 'alertes.réglées', canal || null, { types });
    this.relancerEcoute();
    return this.vue();
  }

  /** Le jeton et la discussion du canal choisi, lus dans Clés & API au moment de servir. */
  telegram() {
    const { canal } = this.reglage();
    if (!canal) return null;
    try { return this.agent.identifiantsTelegram(canal); } catch { return null; }
  }

  async appel(t, methode, corps) {
    const r = await sortir(`${config.telegramApi}/bot${t.token}/${methode}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corps), signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(`Telegram : ${j.description || 'HTTP ' + r.status}`);
    return j.result;
  }

  /** Un message sur le canal des alertes ; rien si aucun canal n'est choisi ou si ce type est coupé. */
  async signaler(type, texte, boutons = null) {
    const r = this.reglage();
    if (type && !r.types[type]) return null;
    const t = this.telegram();
    if (!t) return null;
    try {
      const m = await this.appel(t, 'sendMessage', { chat_id: t.chat, text: texte.slice(0, 4000), ...(boutons ? { reply_markup: { inline_keyboard: [boutons] } } : {}) });
      Object.assign(this.etat, { envoyees: this.etat.envoyees + 1, derniere: Date.now(), erreur: null });
      return m;
    } catch (e) {
      this.etat.erreur = court(e.message, 200);
      log.warn('alertes', e.message);
      return null;
    }
  }

  async essai(acteur) {
    if (!this.telegram()) throw new HttpError(409, 'Choisis d’abord un compte Telegram prêt.');
    const m = await this.signaler(null, '✅ Alertes du Hub branchées ici : mises à jour, workflows en échec, IA et services injoignables.');
    if (!m) throw new HttpError(502, `Envoi impossible : ${this.etat.erreur || 'Telegram ne répond pas'}`);
    this.audit.write(acteur, 'alertes.essai', this.reglage().canal);
    return { ok: true };
  }

  // ---- ce qui se passe dans le Hub ----

  photo() {
    const m = new Map();
    for (const i of this.services.list()) m.set(i.id, { name: i.name, status: i.status, version: i.version || null, detail: i.status_detail || null });
    return m;
  }
  comparerServices() {
    const neuf = this.photo();
    for (const [id, apres] of neuf) {
      const e = depuisService(this.connus.get(id), apres);
      if (!e) continue;
      if (e.kind === 'incident.service') this.signaler('service', `🔴 ${e.title}`);
      else if (e.kind === 'service.recovered') this.signaler('service', `🟢 ${e.title}`);
      else if (e.kind === 'service.updated') this.signaler('maj', `✅ ${e.title}`);
    }
    this.connus = neuf;
  }

  /** Un workflow lancé pour de vrai qui échoue : une alerte, puis une seule quand il refonctionne. */
  execution(x) {
    if (x.mode === 'test') return;
    const nom = court(x.workflowName || x.workflowId, 120);
    if (x.status === 'error') {
      if (this.workflowsEnPanne.has(x.workflowId)) return;
      this.workflowsEnPanne.set(x.workflowId, Date.now());
      this.signaler('workflow', `🔴 Workflow « ${nom} » en échec : ${court(x.error || 'erreur inconnue', 300)}`);
    } else if (x.status === 'success' && this.workflowsEnPanne.delete(x.workflowId)) {
      this.signaler('workflow', `🟢 Workflow « ${nom} » de nouveau réussi.`);
    }
  }

  /** Chaque connexion IA, interrogée sans dépenser de jeton : la liste de ses modèles. */
  async verifierIA() {
    for (const c of this.ai?.list() || []) {
      let erreur = null;
      try { await this.ai.models(c.id); } catch (e) { erreur = court(e.message, 200); }
      if (erreur && !this.iaEnPanne.has(c.id)) { this.iaEnPanne.set(c.id, Date.now()); await this.signaler('ia', `🔴 IA « ${c.name} » injoignable : ${erreur}`); }
      else if (!erreur && this.iaEnPanne.delete(c.id)) await this.signaler('ia', `🟢 IA « ${c.name} » de nouveau joignable.`);
    }
  }

  /** Une mise à jour pas encore annoncée : une fois par service et par version. */
  async verifierMisesAJour() {
    if (!this.telegram() || !this.reglage().types.maj) return;
    const vues = { ...(this.db.setting('alertes_maj_vues', {}) || {}) };
    for (const inst of this.services.list()) {
      const v = this.services.versionDisponible(inst);
      const image = !v && this.services.imagesNeuves?.has(inst.id);
      if (!v && !image) continue;
      const cle = `${inst.id}:${v || `image:${inst.version}`}`;
      if (vues[cle]) continue;
      vues[cle] = Date.now();
      const r = v && this.services.remplacePar?.(inst);
      const quoi = v ? `${inst.name} : v${inst.version} → ${r ? `${r.name} ` : ''}v${v}` : `${inst.name} : nouvelle image locale (v${inst.version})`;
      const [oui, non] = [this.bouton(inst.id, v || inst.version), crypto.randomBytes(9).toString('base64url')];
      this.boutons()[non] = { ...this.boutons()[oui], tard: true };
      this.enregistrerBoutons();
      await this.signaler('maj', `⬆️ Mise à jour disponible — ${quoi}`, [{ text: 'Mettre à jour', callback_data: `maj:${oui}` }, { text: 'Plus tard', callback_data: `maj:${non}` }]);
    }
    // Les annonces de versions passées ne servent plus : la liste reste courte.
    for (const k of Object.keys(vues)) if (Date.now() - vues[k] > 90 * 86400e3) delete vues[k];
    this.db.setSetting('alertes_maj_vues', vues);
  }

  // ---- boutons : à usage unique, expirants, liés à la discussion ----

  boutons() { return (this._boutons ??= { ...(this.db.setting('alertes_boutons', {}) || {}) }); }
  enregistrerBoutons() {
    const b = this.boutons();
    for (const [k, v] of Object.entries(b)) if (v.expire < Date.now()) delete b[k];
    this.db.setSetting('alertes_boutons', b);
  }
  bouton(instId, version) {
    const n = crypto.randomBytes(9).toString('base64url');
    this.boutons()[n] = { instId, version, expire: Date.now() + VALIDITE_BOUTON };
    this.enregistrerBoutons();
    return n;
  }

  /** Un bouton pressé dans Telegram. */
  async rappel(cq) {
    const t = this.telegram();
    if (!t) return;
    const repondre = texte => this.appel(t, 'answerCallbackQuery', { callback_query_id: cq.id, text: texte }).catch(() => {});
    const m = /^maj:([\w-]{8,24})$/.exec(String(cq.data || ''));
    const chat = String(cq.message?.chat?.id ?? '');
    // La discussion configurée seulement ; en privé, son seul interlocuteur.
    if (!m || chat !== t.chat || (!t.chat.startsWith('-') && String(cq.from?.id) !== t.chat)) { await repondre('Ce bouton ne vaut pas ici.'); return; }
    const b = this.boutons()[m[1]];
    const sansBoutons = suite => this.appel(t, 'editMessageText', { chat_id: t.chat, message_id: cq.message.message_id, text: `${cq.message.text || ''}\n${suite}`.slice(0, 4000) }).catch(() => {});
    if (!b || b.expire < Date.now()) { await repondre('Ce bouton a expiré : ouvre le Hub.'); await sansBoutons('⌛ Bouton expiré.'); return; }
    // Usage unique : ce bouton et son voisin (« Plus tard ») partent ensemble.
    for (const [k, v] of Object.entries(this.boutons())) if (v.instId === b.instId && v.version === b.version) delete this.boutons()[k];
    this.enregistrerBoutons();
    const qui = `telegram:${cq.from?.username || cq.from?.id}`;
    if (b.tard) { await repondre('D’accord, plus de rappel pour cette version.'); await sansBoutons('⏸ Plus tard.'); this.audit.write(qui, 'alertes.mise_a_jour_reportée', b.instId, { version: b.version }); return; }
    let inst;
    try { inst = this.services.get(b.instId); } catch { await repondre('Ce service n’existe plus.'); await sansBoutons('— service retiré.'); return; }
    await repondre('Mise à jour lancée.');
    await sansBoutons('⏳ Mise à jour lancée…');
    this.audit.write(qui, 'alertes.mise_a_jour_lancée', inst.name, { version: b.version });
    try {
      await this.services.update(inst.id, qui);
      const apres = this.services.get(inst.id);
      await this.signaler(null, `✅ ${apres.name} mis à jour (v${apres.version}).`);
    } catch (e) {
      await this.signaler(null, `❌ Mise à jour de ${inst.name} impossible : ${court(e.message, 300)}`);
    }
  }

  /**
   * Les boutons arrivent par getUpdates, en attente longue. Le bot n'a qu'une
   * file : quand l'assistant écoute une réponse sur le même bot, on lui cède
   * la place (il nous passe les boutons qu'il reçoit), et on reprend après.
   */
  relancerEcoute() {
    this.ecoute?.abort();
    this.ecoute = null;
    this.etat.ecoute = false;
    const t = this.telegram();
    if (!t || !this.reglage().types.maj) return;
    const fin = new AbortController();
    this.ecoute = fin;
    this.etat.ecoute = true;
    const pause = ms => new Promise(r => { const x = setTimeout(r, ms); x.unref?.(); fin.signal.addEventListener('abort', () => { clearTimeout(x); r(); }, { once: true }); });
    (async () => {
      let offset = null, echecs = 0;
      while (!fin.signal.aborted) {
        if (this.agent?.ecoute?.token === t.token) { offset = null; await pause(3000); continue; }
        this.requete = new AbortController();
        const get = async (params, attente = 0) => {
          const r = await sortir(`${config.telegramApi}/bot${t.token}/getUpdates?${new URLSearchParams(params)}`,
            { signal: AbortSignal.any([fin.signal, this.requete.signal, AbortSignal.timeout((attente + 10) * 1000)]) });
          const j = await r.json();
          if (!j.ok) throw new Error(j.description || 'Telegram refuse');
          return j.result || [];
        };
        try {
          if (offset == null) { const a = await get({ offset: -1 }); offset = (a.at(-1)?.update_id ?? 0) + 1; }
          const lot = await get({ offset, timeout: 25, allowed_updates: '["message","callback_query"]' }, 25);
          echecs = 0;
          for (const u of lot) {
            offset = u.update_id + 1;
            if (u.callback_query) await this.rappel(u.callback_query).catch(e => log.warn('alertes', 'bouton', e.message));
          }
        } catch (e) {
          if (fin.signal.aborted) break;
          if (this.requete.signal.aborted) { offset = null; continue; }   // cédé à l'assistant
          if (/unauthorized|not found/i.test(e.message)) { this.etat.erreur = court(e.message, 200); this.etat.ecoute = false; log.warn('alertes', 'écoute', e.message); break; }
          echecs++;
          await pause(Math.min(60000, 2000 * 2 ** Math.min(echecs, 5)));
        }
      }
    })();
  }
  /** L'assistant prend le bot : la requête en cours s'arrête tout de suite. */
  ceder() { this.requete?.abort(); }

  demarrer() {
    this.connus = this.photo();   // l'état au démarrage n'est pas une nouvelle
    let relance = null;
    this.bus.on('instance', () => { clearTimeout(relance); relance = setTimeout(() => this.comparerServices(), 3000); relance.unref?.(); });
    this.bus.on('execution.finished', x => this.execution(x));
    this.bus.on('catalog', () => setTimeout(() => this.verifierMisesAJour().catch(e => log.warn('alertes', e.message)), 2000).unref?.());
    this.bus.on('agent.ecoute', e => { if (e && e.fin !== true) this.ceder(); });
    const toutes = (ms, fn) => { const x = setInterval(() => fn().catch(e => log.warn('alertes', e.message)), ms); x.unref?.(); this.minuteurs.push(x); };
    toutes(600e3, () => this.verifierIA());
    toutes(600e3, () => this.verifierMisesAJour());
    this.relancerEcoute();
  }
  arreter() { this.ecoute?.abort(); for (const x of this.minuteurs) clearInterval(x); }
}
