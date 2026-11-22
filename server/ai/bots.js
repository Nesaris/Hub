// Les bots Telegram de l'assistant : parler à l'IA du Hub depuis Telegram.
//
// Autant de bots qu'on veut — un par service, un seul pour tout, ou un groupe
// qui les réunit — chacun est un compte Telegram de Clés & API. Le Hub les lit
// tous (un seul lecteur par jeton), l'IA comprend la demande, et c'est le bot
// du service visé qui répond, avec son formulaire et ses boutons.
//
// Ce qui protège :
//   - seule la discussion du compte est écoutée ; dans un groupe, seuls les
//     utilisateurs listés. Tout autre message est ignoré ;
//   - un bouton sert une fois, expire, et n'est accepté que de qui l'a reçu ;
//   - une étape qui passe par une route sous renfort (Internet, comptes,
//     sécurité…) ne s'exécute pas depuis Telegram : un lien ouvre le Hub, où la
//     clé d'accès confirme ;
//   - aucun secret ne se tape dans Telegram (il resterait dans l'historique de
//     la discussion) : un champ secret renvoie vers Clés & API.
import crypto from 'node:crypto';
import { config } from '../config.js';
import { sortir } from '../sortie.js';
import { HttpError, id as nouvelId, log } from '../util/common.js';
import { exigerOuvert } from '../coupure.js';
import { SERVICE_HUB } from '../connexions.js';

const VALIDITE_BOUTON = 30 * 60e3;
const MAX_BOTS = 30;
const NOM = /^[a-z0-9][a-z0-9-]{0,62}$/;
const court = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const norme = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
// Le markdown de l'assistant, lisible en texte brut (Telegram sans parse_mode).
const brut = s => String(s || '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/^#+\s*/gm, '').trim();
const MODES = { cloudflare: 'Internet, par le tunnel Cloudflare', public: 'Internet, par ton adresse publique', local: 'réseau local seulement' };
const AIDE = [
  'Je suis l’assistant de ton Hub. Écris-moi ce que tu veux, en clair :',
  '• « fais-moi un accès internet pour nexarc »',
  '• « mets à jour vigie » · « qu’est-ce qui est hors ligne ? »',
  '',
  'Une action qui se défait se valide d’un bouton. Une action sensible (Internet, suppression, comptes, sécurité) se confirme dans le Hub avec ta clé d’accès.',
  '/annuler — abandonner le formulaire en cours · /id — tes identifiants Telegram',
].join('\n');

export class BotsIA {
  constructor({ db, audit, agent, services, connexions = null, alertes = null }) {
    Object.assign(this, { db, audit, agent, services, connexions, alertes });
    this.lecteurs = new Map();   // jeton → { fin, requete, etat }
    this.noms = new Map();       // jeton → @nom du bot
    this.discussions = new Map(); // « jeton:chat » → formulaire ou validation en cours
    this.boutons = new Map();    // id → { jeton, chat, de, groupe, faire, expire }
    this.vus = new Set();        // messages déjà pris : un groupe, plusieurs bots, un seul traitement
    this.files = new Map();      // « chat » → promesse : un message après l'autre
  }

  // ── Réglage ────────────────────────────────────────────────────────────

  reglage() {
    const r = this.db.setting('bots_ia', {}) || {};
    return { bots: Array.isArray(r.bots) ? r.bots : [], compte: r.compte || null };
  }

  /** Les comptes Telegram de Clés & API : un bot chacun. */
  comptesTelegram() {
    return (this.agent.canaux() || []).filter(c => c.noeud?.type === 'out.telegram')
      .map(c => ({ service: c.service, canal: c.canal, pret: c.pret, ...(c.manque ? { manque: c.manque } : {}) }));
  }

  administrateurs() {
    try { return this.db.all("SELECT id, identifiant, affichage FROM socle_comptes WHERE role = 'admin' AND actif = 1 ORDER BY cree"); } catch { return []; }
  }

  /** Le compte du Hub au nom duquel l'assistant agit quand on lui écrit sur Telegram. */
  compteHub() {
    const admins = this.administrateurs();
    const voulu = this.reglage().compte;
    return (admins.find(a => a.id === voulu) || admins[0])?.id || null;
  }

  vue() {
    const r = this.reglage();
    return {
      compte: r.compte, comptesHub: this.administrateurs().map(a => ({ id: a.id, nom: a.affichage || a.identifiant })),
      comptes: this.comptesTelegram(),
      services: this.services.list().map(i => ({ id: i.id, nom: i.name })),
      bots: r.bots.map(b => {
        let jeton = null;
        try { jeton = this.identifiants(b).token; } catch { /* compte incomplet */ }
        const l = jeton ? this.lecteurs.get(jeton) : null;
        return { ...b, canal: this.comptesTelegram().find(c => c.service === b.service)?.canal || b.service,
          lecture: !!l?.etat.lecture, erreur: l?.etat.erreur || (b.actif && !jeton ? 'compte Telegram incomplet dans Clés & API' : null),
          nom: jeton ? this.noms.get(jeton) || null : null };
      }),
    };
  }

  poser(corps, acteur) {
    const comptes = new Set(this.comptesTelegram().map(c => c.service));
    const liste = Array.isArray(corps?.bots) ? corps.bots : [];
    if (liste.length > MAX_BOTS) throw new HttpError(400, `${MAX_BOTS} bots au plus.`);
    const vus = new Set();
    const bots = liste.map(b => {
      const service = String(b?.service || '');
      if (!comptes.has(service)) throw new HttpError(400, `« ${court(service, 40)} » n’est pas un compte Telegram de Clés & API.`);
      if (vus.has(service)) throw new HttpError(400, 'Un même compte Telegram ne se branche qu’une fois.');
      vus.add(service);
      let lie = String(b?.lie || '');
      if (lie) { try { lie = this.services.get(lie).id; } catch { throw new HttpError(400, `Service inconnu : ${court(lie, 40)}`); } }
      const utilisateurs = [...new Set((Array.isArray(b?.utilisateurs) ? b.utilisateurs : String(b?.utilisateurs || '').split(/[\s,;]+/))
        .map(x => String(x).trim()).filter(Boolean))];
      if (utilisateurs.length > 20 || utilisateurs.some(u => !/^\d{1,15}$/.test(u))) throw new HttpError(400, 'Utilisateurs autorisés : des identifiants Telegram (chiffres), 20 au plus.');
      return { id: /^b_[\w-]{4,20}$/.test(b?.id || '') ? b.id : nouvelId('b_'), service, lie, utilisateurs, actif: b?.actif !== false };
    });
    let compte = corps?.compte ? String(corps.compte) : null;
    if (compte && !this.administrateurs().some(a => a.id === compte)) throw new HttpError(400, 'Le compte du Hub choisi n’est pas un administrateur.');
    this.db.setSetting('bots_ia', { bots, compte });
    this.audit.write(acteur, 'bots_ia.réglés', null, { bots: bots.map(b => ({ service: b.service, lie: b.lie, actif: b.actif, utilisateurs: b.utilisateurs.length })) });
    this.demarrer();
    return this.vue();
  }

  identifiants(bot) { return this.agent.identifiantsTelegram(bot.service); }

  /** Ce jeton est-il lu ici ? Les alertes et l'écoute de l'assistant lui laissent alors la file. */
  gere(jeton) { return this.lecteurs.has(jeton); }

  // ── Lecture : un lecteur par jeton ─────────────────────────────────────

  demarrer() {
    this.arreter();
    const parJeton = new Map();
    for (const b of this.reglage().bots.filter(x => x.actif)) {
      try { const { token } = this.identifiants(b); if (!parJeton.has(token)) parJeton.set(token, b); } catch { /* compte incomplet : la vue le dit */ }
    }
    for (const jeton of parJeton.keys()) this.lire(jeton);
    // Un jeton qui n'est plus lu ici revient aux alertes s'il est le leur.
    try { this.alertes?.relancerEcoute?.(); } catch (e) { log.warn('bots', 'alertes', e.message); }
  }

  arreter() {
    for (const l of this.lecteurs.values()) l.fin.abort();
    this.lecteurs.clear();
  }

  /** L'assistant écoute une réponse sur un bot : la requête en cours s'arrête tout de suite. */
  ceder() { for (const l of this.lecteurs.values()) l.requete?.abort(); }

  lire(jeton) {
    const fin = new AbortController();
    const l = { fin, requete: null, etat: { lecture: true, erreur: null } };
    this.lecteurs.set(jeton, l);
    const pause = ms => new Promise(r => { const x = setTimeout(r, ms); x.unref?.(); fin.signal.addEventListener('abort', () => { clearTimeout(x); r(); }, { once: true }); });
    this.appel(jeton, 'getMe', {}).then(m => m?.username && this.noms.set(jeton, m.username)).catch(() => {});
    (async () => {
      let offset = null, echecs = 0;
      while (!fin.signal.aborted) {
        // L'assistant écoute une réponse sur ce bot : il lit, on attend.
        if (this.agent?.ecoute?.token === jeton) { offset = null; await pause(3000); continue; }
        l.requete = new AbortController();
        const get = async (params, attente = 0) => {
          const r = await sortir(`${config.telegramApi}/bot${jeton}/getUpdates?${new URLSearchParams(params)}`,
            { signal: AbortSignal.any([fin.signal, l.requete.signal, AbortSignal.timeout((attente + 10) * 1000)]) });
          const j = await r.json();
          if (!j.ok) throw new Error(j.description || 'Telegram refuse');
          return j.result || [];
        };
        try {
          // Ce qui est arrivé pendant que le Hub était éteint ne se rejoue pas :
          // un ordre de la veille n'a pas à partir au redémarrage.
          if (offset == null) { const a = await get({ offset: -1 }); offset = (a.at(-1)?.update_id ?? 0) + 1; }
          const lot = await get({ offset, timeout: 25, allowed_updates: '["message","callback_query"]' }, 25);
          echecs = 0; l.etat.erreur = null; l.etat.lecture = true;
          for (const u of lot) {
            offset = u.update_id + 1;
            this.recevoir(jeton, u).catch(e => log.warn('bots', 'message', e.message));
          }
        } catch (e) {
          if (fin.signal.aborted) break;
          if (l.requete.signal.aborted) { offset = null; continue; }
          if (/unauthorized|not found/i.test(e.message)) { l.etat = { lecture: false, erreur: court(e.message, 200) }; log.warn('bots', 'lecture', e.message); break; }
          if (/conflict/i.test(e.message)) l.etat.erreur = 'Un autre programme lit déjà ce bot (par exemple les commandes de Relay) : donne un bot à chacun, ou coupe ses commandes là-bas.';
          echecs++;
          await pause(Math.min(60000, 2000 * 2 ** Math.min(echecs, 5)));
        }
      }
    })();
  }

  async appel(jeton, methode, corps) {
    const r = await sortir(`${config.telegramApi}/bot${jeton}/${methode}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corps), signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(`Telegram : ${j.description || 'HTTP ' + r.status}`);
    return j.result;
  }

  // ── Réception ──────────────────────────────────────────────────────────

  /** Les bots branchés sur ce jeton et cette discussion. */
  botsDe(jeton, chat) {
    return this.reglage().bots.filter(b => b.actif).filter(b => {
      try { const x = this.identifiants(b); return x.token === jeton && String(x.chat) === String(chat); } catch { return false; }
    });
  }

  async recevoir(jeton, u) {
    if (u.callback_query) {
      const data = String(u.callback_query.data || '');
      if (data.startsWith('maj:')) return this.alertes?.rappel(u.callback_query);
      if (data.startsWith('ia:')) return this.rappel(u.callback_query);
      return;
    }
    const m = u.message;
    if (!m?.text || !m.chat) return;
    const texte = m.text.trim();
    // /id répond partout où le bot est lu : c'est ce qu'il faut pour remplir le réglage d'un groupe.
    if (/^\/id(@\w+)?$/i.test(texte)) {
      return this.appel(jeton, 'sendMessage', { chat_id: m.chat.id, text: `Discussion : ${m.chat.id}\nToi : ${m.from?.id ?? '—'}` }).catch(() => {});
    }
    const bots = this.botsDe(jeton, m.chat.id);
    if (!bots.length) return;
    const bot = bots[0];
    if (!this.autorise(bot, m)) return;
    const cle = `${m.chat.id}:${m.message_id}`;
    if (this.vus.has(cle)) return;
    this.vus.add(cle);
    if (this.vus.size > 500) this.vus.delete(this.vus.values().next().value);
    // Un message après l'autre par discussion : un formulaire ne se croise pas avec la demande suivante.
    const chat = String(m.chat.id);
    const suite = (this.files.get(chat) || Promise.resolve()).then(() => this.traiter(jeton, bot, m)).catch(e => log.warn('bots', 'traitement', e.message));
    this.files.set(chat, suite);
    return suite;
  }

  /** Discussion privée : son propriétaire. Groupe : les seuls utilisateurs listés. */
  autorise(bot, m) {
    const chat = Number(m.chat.id), de = String(m.from?.id ?? '');
    if (m.from?.is_bot) return false;
    if (chat > 0) return de === String(chat) || bot.utilisateurs.includes(de);
    return bot.utilisateurs.includes(de);
  }

  ident(jeton, bot, m) {
    const qui = m.from?.username ? '@' + m.from.username : String(m.from?.id ?? '?');
    let canal = bot.service;
    try { canal = this.identifiants(bot).canal; } catch { /* nom du compte seul */ }
    return { jeton, chat: String(m.chat.id), de: String(m.from?.id ?? ''), bot, acteur: `${qui} (Telegram, ${canal})`, cle: `${jeton}:${m.chat.id}` };
  }

  async traiter(jeton, bot, m) {
    const ctx = this.ident(jeton, bot, m);
    const texte = m.text.trim();
    if (/^\/(start|aide|help)(@\w+)?$/i.test(texte)) return this.dire(ctx, AIDE);
    if (/^\/annuler(@\w+)?$/i.test(texte)) {
      const en = this.discussions.get(ctx.cle);
      this.discussions.delete(ctx.cle);
      if (en?.pid) try { this.agent.reject(en.pid, ctx.acteur, { compte: this.compteHub(), admin: true }); } catch { /* déjà traité */ }
      return this.dire(ctx, en ? 'Abandonné, rien n’a été fait.' : 'Rien en cours.');
    }
    const en = this.discussions.get(ctx.cle);
    if (en?.etape === 'formulaire' && en.champs[en.i]?.type === 'texte') return this.repondreChamp(ctx, en, texte);
    return this.demande(ctx, texte);
  }

  // ── Une demande ────────────────────────────────────────────────────────

  async demande(ctx, texte) {
    try { exigerOuvert(this.db, 'ia'); } catch (e) { return this.dire(ctx, `⛔ ${e.message}`); }
    // Un geste que le Hub sait mener lui-même, formulaire compris.
    const geste = await this.gesteAcces(ctx, texte);
    if (geste) return;
    const compte = this.compteHub();
    if (!compte) return this.dire(ctx, 'Aucun administrateur dans le Hub : crée d’abord ton compte.');
    this.appel(ctx.jeton, 'sendChatAction', { chat_id: ctx.chat, action: 'typing' }).catch(() => {});
    // Une demande déjà en cours dans le Hub : on attend qu'elle finisse.
    for (let i = 0; i < 120 && this.agent.courant; i++) await new Promise(r => setTimeout(r, 1000));
    let r;
    try { r = await this.agent.ask(texte, ctx.acteur, { compte }); }
    catch (e) { return this.dire(ctx, `⚠ ${court(e.message, 300)}`); }
    return this.apresDemande(ctx, r, texte);
  }

  async apresDemande(ctx, r, texte) {
    const reponse = brut(r?.reply);
    if (r?.status === 'proposed' && r.steps?.length) {
      this.marquerOrigine(r.id, ctx);
      return this.preparerValidation(ctx, r.id, reponse);
    }
    if (r?.results?.length) return this.dire(ctx, [reponse, this.bilan(r)].filter(Boolean).join('\n\n'));
    return this.dire(ctx, reponse || 'C’est noté.', [], this.serviceVise(r?.steps, texte));
  }

  /** Le plan sait d'où il vient : le résultat repart là, même s'il est exécuté dans le Hub. */
  marquerOrigine(pid, ctx) {
    try { this.db.run("UPDATE agent_plans SET plan = json_set(plan, '$.origine', json(?)) WHERE id = ?", JSON.stringify({ telegram: ctx.bot.service, chat: ctx.chat, de: ctx.de }), pid); }
    catch (e) { log.warn('bots', 'origine', e.message); }
  }

  /** Le service qu'une demande vise : celui des étapes, sinon celui qu'elle nomme. */
  serviceVise(steps, texte) {
    for (const s of steps || []) {
      const a = s.args || {};
      const nom = a.instance || a.service || (/\/api\/(?:instances|connexions\/services)\/([^/\s?]+)/.exec(String(a.action || '')) || [])[1];
      if (nom) { try { return this.services.get(nom).id; } catch { /* nom inconnu */ } }
    }
    const cites = texte ? this.agent.servicesCites(texte) : [];
    return cites.length === 1 ? cites[0].id : null;
  }

  // ── Formulaires ────────────────────────────────────────────────────────

  /** Les paramètres qu'une étape laisse vides et qu'il faut demander. */
  async champsManquants(plan) {
    const champs = [];
    for (const [i, s] of plan.steps.entries()) {
      const a = s.args || {};
      if (s.tool === 'run_action') {
        let def = null, inst = null;
        try { inst = this.services.get(a.instance); def = (inst.manifest.actions || []).find(x => x.id === a.action); } catch { /* service inconnu : la revue le dira */ }
        for (const p of def?.params || []) {
          const v = a.params?.[p.key];
          if (v !== undefined && v !== null && v !== '') continue;
          if (!p.required) continue;
          // Une liste que le service fournit (ses piles, ses modèles…) : demandée à lui, en boutons.
          let options = p.options;
          if (p.optionsFrom) { try { options = await this.agent.engine.runtime.options(inst, p); } catch { options = null; } }
          champs.push(this.champ({ ...p, options }, { etape: i, ou: 'params' }));
        }
      }
      // Le modèle peut aussi dire ce qu'il lui manque : {"demander":[{key,label,type,options}]}.
      for (const p of Array.isArray(a.demander) ? a.demander.slice(0, 8) : []) {
        if (p?.key) champs.push(this.champ(p, { etape: i, ou: s.tool === 'hub' ? 'corps' : 'params' }));
      }
    }
    return champs;
  }

  champ(p, quoi) {
    const options = (p.options || []).map(o => (typeof o === 'object' ? { valeur: String(o.value ?? o.valeur), libelle: String(o.label ?? o.libelle ?? o.value) } : { valeur: String(o), libelle: String(o) }));
    const type = p.type === 'secret' ? 'secret' : options.length ? 'choix' : p.type === 'boolean' ? 'ouinon' : 'texte';
    return { ...quoi, key: String(p.key), libelle: String(p.label || p.key), type, options, defaut: p.default !== undefined ? String(p.default) : undefined, aide: p.help ? String(p.help) : '' };
  }

  async formulaire(ctx, { titre, champs, valeurs = {}, fin, service = null }) {
    const en = { etape: 'formulaire', titre, champs, i: 0, valeurs, fin, service };
    this.discussions.set(ctx.cle, en);
    return this.poserQuestion(ctx, en);
  }

  async poserQuestion(ctx, en) {
    const c = en.champs[en.i];
    if (!c) {
      this.discussions.delete(ctx.cle);
      return en.fin(en.valeurs);
    }
    const tete = en.i === 0 && en.titre ? `${en.titre}\n\n` : '';
    const annuler = this.bouton(ctx, '✖ Annuler', () => this.traiter(ctx.jeton, ctx.bot, { text: '/annuler', chat: { id: ctx.chat }, from: { id: ctx.de } }), 'f');
    if (c.type === 'choix' || c.type === 'ouinon') {
      const opts = c.type === 'ouinon' ? [{ valeur: 'true', libelle: 'Oui' }, { valeur: 'false', libelle: 'Non' }] : c.options.slice(0, 24);
      const lignes = [];
      for (let k = 0; k < opts.length; k += 2) lignes.push(opts.slice(k, k + 2).map(o => this.bouton(ctx, o.libelle, () => this.choisir(ctx, en, o.valeur, o.libelle), 'f')));
      lignes.push([annuler]);
      return this.dire(ctx, `${tete}${c.libelle} ?${c.aide ? `\n${c.aide}` : ''}`, lignes, en.service);
    }
    if (c.type === 'secret') {
      const lien = this.lienHub('#secrets');
      return this.dire(ctx, `${tete}🔑 ${c.libelle} : une clé ne se tape jamais ici (elle resterait dans cette discussion). Pose-la dans Clés & API, je n’en verrai que le nom.`,
        [[{ text: 'Ouvrir Clés & API', url: lien }], [this.bouton(ctx, 'C’est posé', () => this.choisir(ctx, en, undefined, 'posée'), 'f'), annuler]], en.service);
    }
    const lignes = c.defaut ? [[this.bouton(ctx, `Garder « ${court(c.defaut, 30)} »`, () => this.choisir(ctx, en, c.defaut, c.defaut), 'f')], [annuler]] : [[annuler]];
    return this.dire(ctx, `${tete}✏️ ${c.libelle} : réponds par un message.${c.aide ? `\n${c.aide}` : ''}`, lignes, en.service);
  }

  async choisir(ctx, en, valeur, libelle) {
    if (this.discussions.get(ctx.cle) !== en) return;
    const c = en.champs[en.i];
    if (valeur !== undefined) en.valeurs[c.key] = c.type === 'ouinon' ? valeur === 'true' : valeur;
    en.i++;
    return this.poserQuestion(ctx, en);
  }

  async repondreChamp(ctx, en, texte) {
    const c = en.champs[en.i];
    if (c.motif && !c.motif.test(texte)) return this.dire(ctx, `« ${court(texte, 40)} » ne convient pas : ${c.aide || 'réessaie'}.`, [], en.service);
    return this.choisir(ctx, en, texte, texte);
  }

  // ── Validation et exécution ────────────────────────────────────────────

  plan(pid) {
    const row = this.db.get('SELECT * FROM agent_plans WHERE id = ?', pid);
    return row ? { row, plan: JSON.parse(row.plan) } : null;
  }

  ecrirePlan(pid, plan) { this.db.run('UPDATE agent_plans SET plan = ? WHERE id = ?', JSON.stringify(plan), pid); }

  async preparerValidation(ctx, pid, reponse = '') {
    const p = this.plan(pid);
    if (!p) return this.dire(ctx, 'Ce plan a disparu.');
    const champs = await this.champsManquants(p.plan);
    const service = this.serviceVise(p.plan.steps);
    if (champs.length) {
      return this.formulaire(ctx, { titre: reponse || 'Il me manque quelques réponses :', champs, service, fin: async valeurs => {
        const q = this.plan(pid);
        if (!q || q.row.status !== 'proposed') return this.dire(ctx, 'Ce plan a déjà été traité.');
        for (const c of champs) {
          if (!(c.key in valeurs)) continue;
          const s = q.plan.steps[c.etape];
          s.args = s.args || {};
          s.args[c.ou] = { ...(s.args[c.ou] || {}), [c.key]: valeurs[c.key] };
          if (Array.isArray(s.args.demander)) s.args.demander = s.args.demander.filter(d => d.key !== c.key);
        }
        this.ecrirePlan(pid, q.plan);
        return this.proposer(ctx, pid, '');
      } });
    }
    return this.proposer(ctx, pid, reponse);
  }

  /** Le récapitulatif et ses boutons : Valider ici, ou confirmer dans le Hub avec la clé. */
  async proposer(ctx, pid, reponse) {
    const p = this.plan(pid);
    const etapes = p.plan.steps.map(s => `• ${s.label || s.tool}`).join('\n');
    const service = this.serviceVise(p.plan.steps);
    this.discussions.set(ctx.cle, { etape: 'validation', pid });
    if (this.agent.autonomy() === 'conseil') return this.dire(ctx, `${reponse ? reponse + '\n\n' : ''}📋 Je ferais :\n${etapes}\n\nL’assistant est en mode conseil : à toi de le faire dans le Hub.`, [], service);
    const annuler = this.bouton(ctx, '✖ Annuler', async () => {
      this.discussions.delete(ctx.cle);
      try { this.agent.reject(pid, ctx.acteur, { compte: this.compteHub(), admin: true }); } catch { /* déjà traité */ }
      return this.dire(ctx, 'Annulé, rien n’a été fait.', [], service);
    }, 'v');
    const problemes = p.plan.steps.flatMap(s => s.problems || []);
    if (problemes.length) {
      return this.dire(ctx, `${reponse ? reponse + '\n\n' : ''}📋 Je ferais :\n${etapes}\n\n⚠ Pas tel quel :\n${problemes.map(x => `• ${court(x, 200)}`).join('\n')}\n\nReformule, ou ouvre le Hub.`,
        [[{ text: 'Ouvrir l’assistant', url: this.lienHub('#assistant') }], [annuler]], service);
    }
    if (this.agent.exigeRenfort(pid)) {
      return this.dire(ctx, `${reponse ? reponse + '\n\n' : ''}📋 Je vais :\n${etapes}\n\n🔐 C’est sensible : confirme dans le Hub avec ta clé d’accès. Le résultat arrivera ici.`,
        [[{ text: '🔐 Confirmer dans le Hub', url: this.lienHub(`#confirmer/${pid}`) }], [annuler]], service);
    }
    return this.dire(ctx, `${reponse ? reponse + '\n\n' : ''}📋 Je vais :\n${etapes}`,
      [[this.bouton(ctx, '✅ Valider', () => this.executer(ctx, pid), 'v'), annuler]], service);
  }

  async executer(ctx, pid) {
    this.discussions.delete(ctx.cle);
    const service = this.serviceVise(this.plan(pid)?.plan.steps);
    let r;
    try { r = await this.agent.execute(pid, ctx.acteur, { renfort: false }); }
    catch (e) { return this.dire(ctx, `⚠ ${court(e.message, 300)}`, [], service); }
    return this.dire(ctx, this.bilan(r), [], service);
  }

  /** Après une exécution confirmée dans le Hub : le résultat repart sur Telegram. */
  async apresExecution(pid, r) {
    const p = this.plan(pid);
    const o = p?.plan.origine;
    if (!o?.telegram) return;
    const bot = this.reglage().bots.find(b => b.service === o.telegram && b.actif);
    if (!bot) return;
    let x;
    try { x = this.identifiants(bot); } catch { return; }
    const ctx = { jeton: x.token, chat: String(o.chat), de: String(o.de || ''), bot, acteur: 'hub', cle: `${x.token}:${o.chat}` };
    if (this.discussions.get(ctx.cle)?.pid === pid) this.discussions.delete(ctx.cle);
    await this.dire(ctx, this.bilan(r), [], this.serviceVise(p.plan.steps)).catch(e => log.warn('bots', 'résultat', e.message));
  }

  bilan(r) {
    const etapes = r?.steps || [];
    const lignes = (r?.results || []).map(x => {
      const label = etapes[x.step]?.label || `Étape ${x.step + 1}`;
      if (x.skipped) return `⏭ ${label}`;
      if (!x.ok) return `❌ ${label} — ${court(x.error, 200)}`;
      const url = x.result?.url || (() => { try { return JSON.parse(x.result?.resultat || '{}').url; } catch { return null; } })();
      return `✅ ${label}${url ? `\n${url}` : ''}`;
    });
    return `${r?.status === 'done' ? 'C’est fait.' : 'Pas tout à fait :'}\n${lignes.join('\n')}`.trim();
  }

  // ── Le geste « accès internet pour un service » ─────────────────────────

  /**
   * « Fais-moi un accès internet pour nexarc » : le service, le domaine parmi
   * ceux de Connexions, le préfixe, et une étape « hub » vers la même route
   * que la page Connexions — donc la même confirmation par clé.
   */
  async gesteAcces(ctx, texte) {
    const t = norme(texte);
    if (/workflow|\btous les services\b|\btout\b/.test(t)) return false;
    if (!/(acces|accessible|joignable|publi|expos|en ligne|adresse|url|nom de domaine|sous-domaine|lien)/.test(t)) return false;
    if (!/(internet|exterieur|dehors|public|partout|en ligne|domaine|url|adresse|reseau local|\blocal\b)/.test(t)) return false;
    if (!this.connexions) return false;
    let etat;
    try { etat = await this.connexions.etat(); } catch (e) { await this.dire(ctx, `⚠ Connexions injoignables : ${court(e.message, 200)}`); return true; }
    if (!etat.relay) { await this.dire(ctx, 'Pour donner une adresse à un service, il faut Relay : installe-le depuis Extensions.'); return true; }
    const publiables = (etat.services || []).filter(s => s.cible);
    const cites = this.agent.servicesCites(texte).filter(i => publiables.some(s => s.id === i.id));
    const lie = ctx.bot.lie && publiables.some(s => s.id === ctx.bot.lie) ? ctx.bot.lie : null;
    let serviceId = cites.length === 1 ? cites[0].id : (!cites.length ? lie : null);
    const domaines = [...new Set([...(etat.domaines || []), ...(etat.zonesCloudflare || []).map(z => z.nom || z.name || z)].map(String).filter(Boolean))];
    if (!domaines.length) {
      await this.dire(ctx, 'Aucun domaine dans Connexions : ajoute le tien dans le Hub (Connexions → Domaines), puis redemande-moi.', [[{ text: 'Ouvrir Connexions', url: this.lienHub('#conn') }]]);
      return true;
    }
    const mode = /(reseau local|\blocal\b)/.test(t) && !/internet/.test(t) ? 'local' : etat.cloudflare ? 'cloudflare' : 'public';
    const champs = [];
    if (!serviceId) champs.push({ key: 'service', libelle: 'Quel service', type: 'choix', options: (cites.length ? publiables.filter(s => cites.some(c => c.id === s.id)) : publiables).map(s => ({ valeur: s.id, libelle: s.nom })) });
    if (domaines.length > 1) champs.push({ key: 'domaine', libelle: 'Sur quel domaine', type: 'choix', options: domaines.map(d => ({ valeur: d, libelle: d })) });
    const defautPrefixe = id => publiables.find(s => s.id === id)?.nom?.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || '';
    champs.push({ key: 'prefixe', libelle: 'Quel préfixe (ce qui vient avant le domaine)', type: 'texte', motif: NOM, aide: 'minuscules, chiffres et tirets — par exemple nexarc', defaut: serviceId ? defautPrefixe(serviceId) : undefined });
    const nomDe = id => publiables.find(s => s.id === id)?.nom || id;
    await this.formulaire(ctx, {
      titre: serviceId ? `🌐 Une adresse pour ${nomDe(serviceId)} (${MODES[mode]}).` : `🌐 Une adresse pour un service (${MODES[mode]}).`,
      champs, service: serviceId, fin: async v => {
        const sid = v.service || serviceId;
        const domaine = v.domaine || domaines[0];
        const prefixe = String(v.prefixe || defautPrefixe(sid)).toLowerCase();
        if (!NOM.test(prefixe)) return this.dire(ctx, 'Préfixe invalide : minuscules, chiffres et tirets.');
        const hote = `${prefixe}.${domaine}`;
        const plan = { reply: '', steps: [{ tool: 'hub', args: { action: `PUT /api/connexions/services/${sid}`, corps: { hote, mode } }, label: `Publier ${nomDe(sid)} sur ${mode === 'local' ? 'http' : 'https'}://${hote} (${MODES[mode]})`, risk: 'sensible' }],
          origine: { telegram: ctx.bot.service, chat: ctx.chat, de: ctx.de } };
        const pid = nouvelId('p_');
        this.db.run('INSERT INTO agent_plans(id,request,plan,status,created,compte) VALUES(?,?,?,?,?,?)', pid, String(texte).slice(0, 4000), JSON.stringify(plan), 'proposed', Date.now(), this.compteHub());
        this.audit.write(ctx.acteur, 'bots_ia.plan', nomDe(sid), { plan: pid, hote, mode });
        return this.proposer(ctx, pid, '');
      },
    });
    return true;
  }

  // ── « Connecte le bot Telegram qui correspond à Relay » ────────────────

  /** La demande de brancher un bot Telegram sur un service (ou sur tout le Hub). */
  estBrancher(texte) {
    const t = norme(texte);
    return t.length <= 240 && /\bbots?\b/.test(t) && /(connect|branch|reli|associ|\blie\b|\blier\b|attribu|donne|mets?\b|utilise)/.test(t) && !/workflow|alerte|\bchat\b|conversation|parl|discut|ecout|repon|message|envoi/.test(t);
  }

  /**
   * Le bot se trouve par son nom : celui qu'on écrit, sinon celui qui ressemble
   * au service (« Relais » pour Relay). Un seul : on le branche (validé, clé
   * d'accès). Plusieurs ou aucun : on demande, sans deviner.
   */
  reponseBrancher(texte) {
    const t = ' ' + norme(texte).replace(/[^a-z0-9]+/g, ' ') + ' ';
    const mots = t.trim().split(' ').filter(m => m.length >= 3);
    const proche = (a, b) => { a = norme(a).replace(/[^a-z0-9]/g, ''); b = norme(b).replace(/[^a-z0-9]/g, ''); if (a.length < 3 || b.length < 3) return false; if (a === b || a.startsWith(b) || b.startsWith(a)) return true; let n = 0; while (n < a.length && a[n] === b[n]) n++; return n >= 4; };
    const comptes = this.comptesTelegram();
    const prets = comptes.filter(c => c.pret);
    if (!comptes.length) return { reponse: 'Tu n’as encore aucun bot Telegram dans **Clés & API**. Crée-le avec **@BotFather** (/newbot), puis ajoute-le comme compte Telegram dans **Clés & API** : son jeton et l’identifiant de ta discussion. Redemande-moi ensuite.' };
    const nomDe = c => c.canal.replace(/^Telegram \((.*)\)$/, '$1');
    // Le service visé : ce qui suit « à / pour / sur / de », parmi les services installés.
    const services = this.services.list();
    const cites = this.agent.servicesCites(texte);
    const flous = services.filter(i => !cites.some(c => c.id === i.id) && mots.some(m => [i.name, i.manifest?.name].some(n => proche(m, n))));
    const tous = [...cites, ...flous];
    const pourTout = /\b(tout|hub|general|tous)\b/.test(t) && !tous.length;
    // Un bot nommé dans la phrase (hors du nom du service).
    const nommes = prets.filter(c => { const n = ' ' + norme(nomDe(c)).replace(/[^a-z0-9]+/g, ' ') + ' '; return n.trim().length >= 3 && !/^(telegram|bot|tg)$/.test(n.trim()) && t.includes(n) && !tous.some(i => proche(nomDe(c), i.name) && !t.includes(' bot ' + n.trim())); });
    let service = tous.length === 1 ? tous[0] : null;
    if (tous.length > 1) {
      // Le nom d'un bot peut ressembler à un service : celui qui n'est pas un bot est le service.
      const pasBots = tous.filter(i => !prets.some(c => proche(nomDe(c), i.name)));
      if (pasBots.length === 1) service = pasBots[0];
      else return { reponse: `Tu parles de plusieurs services (${tous.map(i => `**${i.name}**`).join(', ')}) : sur lequel je branche le bot ?` };
    }
    if (!service && !pourTout) return { reponse: `Pour quel service ? Dis par exemple « connecte le bot Telegram ${prets[0] ? nomDe(prets[0]) : 'Relais'} à Relay », ou « … pour tout le Hub ».` };
    let bot = nommes.length === 1 ? nommes[0] : null;
    let pourquoi = bot ? 'son nom est dans ta demande' : '';
    if (!bot && service) {
      const ressemblent = prets.filter(c => [service.name, service.manifest?.name].some(n => proche(nomDe(c), n) || nomDe(c).split(/\s+/).some(m => proche(m, n))));
      if (ressemblent.length === 1) { bot = ressemblent[0]; pourquoi = `son nom rejoint ${service.name}`; }
      else if (ressemblent.length > 1) return { reponse: `Plusieurs bots ressemblent à **${service.name}** : ${ressemblent.map(c => `**${nomDe(c)}**`).join(', ')}. Lequel ?` };
    }
    if (!bot) {
      if (!prets.length) return { reponse: `Aucun bot Telegram n’est prêt dans **Clés & API** : ${comptes.map(c => `${nomDe(c)} (${c.manque})`).join(', ')}.` };
      if (prets.length === 1 && nommes.length === 0 && !/\bbot\s+\w{3,}/.test(t.replace(/\bbot (telegram|tg)\b/g, 'bot'))) { bot = prets[0]; pourquoi = 'c’est ton seul bot'; }
      else return { reponse: `Je ne sais pas quel bot prendre${service ? ` pour **${service.name}**` : ''}. Tes bots prêts : ${prets.map(c => `**${nomDe(c)}**`).join(', ')}. Lequel ?${comptes.length > prets.length ? `\n\nPas encore prêts : ${comptes.filter(c => !c.pret).map(c => nomDe(c)).join(', ')}.` : ''}` };
    }
    const r = this.reglage();
    const existant = r.bots.find(b => b.service === bot.service);
    const bots = [...r.bots.filter(b => b.service !== bot.service), { ...(existant || {}), service: bot.service, lie: service ? service.id : '', utilisateurs: existant?.utilisateurs || [], actif: true }];
    const cible = service ? service.name : 'tout le Hub';
    return {
      reply: `Je branche le bot **${nomDe(bot)}** sur **${cible}** (${pourquoi}). Ensuite, écris-lui en clair ce que tu veux : il prépare, te pose ses questions en boutons, et tu valides.`,
      steps: [{ tool: 'hub', args: { action: 'PUT /api/bots-ia', corps: { bots, ...(r.compte ? { compte: r.compte } : {}) }, titre: `Brancher le bot Telegram « ${nomDe(bot)} » sur ${cible}` } }],
    };
  }

  // ── Envoi et boutons ───────────────────────────────────────────────────

  /** Le bot du service visé s'il est dans cette discussion, sinon celui qui a reçu. */
  botPour(ctx, service) {
    if (service) {
      for (const b of this.reglage().bots.filter(x => x.actif && x.lie === service)) {
        try { const x = this.identifiants(b); if (String(x.chat) === ctx.chat) return { jeton: x.token, bot: b }; } catch { /* incomplet */ }
      }
    }
    return { jeton: ctx.jeton, bot: ctx.bot };
  }

  async dire(ctx, texte, lignes = [], service = null) {
    const { jeton } = this.botPour(ctx, service);
    const corps = { chat_id: ctx.chat, text: String(texte || '…').slice(0, 4000), ...(lignes.length ? { reply_markup: { inline_keyboard: lignes } } : {}) };
    try { return await this.appel(jeton, 'sendMessage', corps); }
    catch (e) {
      // Le bot du service n'est pas (encore) dans le groupe : celui qui a reçu répond.
      if (jeton !== ctx.jeton) return this.appel(ctx.jeton, 'sendMessage', corps);
      throw e;
    }
  }

  /** Un bouton à usage unique : il expire, et seul son destinataire peut le presser. */
  bouton(ctx, texte, faire, groupe) {
    const now = Date.now();
    for (const [k, b] of this.boutons) if (b.expire < now) this.boutons.delete(k);
    const cle = crypto.randomBytes(6).toString('base64url');
    this.boutons.set(cle, { jeton: ctx.jeton, chat: ctx.chat, de: ctx.de, cleDiscussion: ctx.cle, groupe: `${ctx.cle}:${groupe}`, faire, expire: now + VALIDITE_BOUTON });
    return { text: String(texte).slice(0, 60), callback_data: `ia:${cle}` };
  }

  async rappel(cq) {
    const cle = String(cq.data || '').slice(3);
    const b = this.boutons.get(cle);
    const repondre = (jeton, texte) => this.appel(jeton, 'answerCallbackQuery', { callback_query_id: cq.id, text: texte }).catch(() => {});
    if (!b || b.expire < Date.now()) {
      // Sans entrée, on ne sait pas quel bot : on répond par n'importe lequel des jetons lus.
      const jeton = b?.jeton || [...this.lecteurs.keys()][0];
      if (jeton) await repondre(jeton, 'Ce bouton a expiré.');
      return;
    }
    if (String(cq.message?.chat?.id) !== b.chat || (b.de && String(cq.from?.id) !== b.de)) { await repondre(b.jeton, 'Ce bouton n’est pas pour toi.'); return; }
    // Un choix fait, les autres boutons du même message tombent.
    for (const [k, x] of this.boutons) if (x.groupe === b.groupe) this.boutons.delete(k);
    await repondre(b.jeton, '✓');
    if (cq.message?.message_id) this.appel(b.jeton, 'editMessageReplyMarkup', { chat_id: b.chat, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    const chat = b.chat;
    const suite = (this.files.get(chat) || Promise.resolve()).then(() => b.faire()).catch(e => log.warn('bots', 'bouton', e.message));
    this.files.set(chat, suite);
    return suite;
  }

  /** Une adresse du Hub, telle qu'on l'atteint de dehors si elle est publiée. */
  lienHub(ancre) {
    let base = '';
    try { base = this.connexions?.publications?.()[SERVICE_HUB] || ''; } catch { /* pas de Relay */ }
    return `${String(base || config.publicUrl).replace(/\/+$/, '')}/${ancre}`;
  }
}
