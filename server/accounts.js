// Gestion des comptes des services depuis le Hub.
//
// Chaque service décrit dans son manifeste comment lister et modifier ses
// comptes (bloc `accounts`). Le Hub n'invente rien : il appelle ce que le
// service a déclaré, avec un jeton d'administration qui lui est propre, séparé
// du jeton de service. Toute entrée dans un service exige un renfort du socle
// (le facteur le plus fort du compte), valable cinq minutes et pour ce service seul.
import { jsonPath } from './manifest/template.js';
import { HttpError } from './util/common.js';
import { reglageCourriel } from './courriel.js';

// Un service du socle commun : le Hub connaît son API de comptes entière
// (adresse e-mail, clé d'accès exigée, activation, envoi des liens).
const estSocle = a => a?.list?.path === '/api/compte/hub/comptes';
// Ce que le compte détient et ce que la politique du service lui réclame
// encore, tels que le socle les donne ; un socle plus ancien n'en dit rien.
const MANQUANTS = new Set(['motdepasse', 'totp', 'cle', 'second']);
function facteursDe(x) {
  const f = x?.facteurs;
  if (!f || typeof f !== 'object') return {};
  const n = v => (Number.isInteger(v) && v >= 0 ? Math.min(v, 999) : 0);
  return {
    facteurs: { motdepasse: f.motdepasse === true, totp: f.totp === true, cles: n(f.cles), secours: n(f.secours) },
    manquants: (Array.isArray(x.manquants) ? x.manquants : []).filter(m => MANQUANTS.has(m)),
  };
}
const ADRESSE = /^[^@\s<>",;:\\]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;

// Les services de la suite dont la version installée ne déclare pas encore
// la gestion de ses comptes par le Hub : ils la déclarent à partir de celle-ci.
const A_METTRE_A_JOUR = { mapmylan: '2.0.2', sentinel: '2.0.0', nexarc: '2.0.0', codmail: '1.0.0', vox: '6.5.1' };

// L'adresse à laquelle l'opérateur ouvre le service : les liens d'invitation
// et de réinitialisation en partent quand le service n'a pas d'adresse publique.
const adresseValide = a => {
  try { const u = new URL(String(a || '')); return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password ? u.origin : null; } catch { return null; }
};

export class Accounts {
  constructor({ services, runtime, audit, comptes, db = null, vault = null }) {
    this.services = services; this.runtime = runtime; this.audit = audit; this.comptes = comptes; this.db = db; this.vault = vault;
    this.steps = new Map(); // `${sessionId}:${instanceId}` -> expiration
  }

  blockOf(inst) {
    const a = inst.manifest.accounts;
    if (!a) throw new HttpError(400, `${inst.name} ne déclare pas de gestion de comptes dans son manifeste.`);
    return a;
  }

  /**
   * Tous les services connus, et si leurs comptes se gèrent ici :
   *   - « hub »         : le manifeste décrit la gestion (bloc accounts) ;
   *   - « mise-a-jour » : la version installée ne la décrit pas encore, la
   *                       suivante oui ;
   *   - « aucun »       : le service n'a pas de comptes.
   */
  services_() {
    return this.services.list().map(i => {
      const m = i.manifest;
      const base = { id: i.id, name: i.name, ext: m.name, icon: m.icon, status: i.status };
      if (m.accounts) {
        const a = m.accounts;
        const cfg = this.services.configOf(i);
        return {
          ...base, gestion: 'hub', ready: !!cfg[a.tokenKey], tokenKey: a.tokenKey, roles: a.roles || [],
          can: { create: !!a.create, invitation: !!a.invitation, update: !!a.update, remove: !!a.remove, password: !!a.password, reset: !!a.reset, mfa: !!a.requireMfa, socle: estSocle(a) },
        };
      }
      const version = A_METTRE_A_JOUR[m.id || i.ext_id];
      if (version) return { ...base, gestion: 'mise-a-jour', version };
      return { ...base, gestion: 'aucun' };
    });
  }

  /** Une requête du bloc accounts, avec le jeton d'administration, l'opérateur et l'adresse du service. */
  appel(inst, a, req, { actor = null, adresse = null, params = {}, ...o } = {}) {
    const entetes = { ...(req.headers || {}) };
    if (actor) entetes['X-Hub-Operateur'] = String(actor).slice(0, 64);
    const ad = adresseValide(adresse);
    if (ad) entetes['X-Hub-Adresse'] = ad;
    return this.runtime.request(inst, { ...req, headers: entetes }, { tokenKey: a.tokenKey, params, timeout: 15000, ...o });
  }

  // ---- second facteur, par service ----
  key(session, instId) { return `${session.id}:${instId}`; }

  // Le renfort lui-même (code, clé ou mot de passe) se fait par le socle : ici,
  // on ouvre ce service seul, jusqu'à la fin de la fenêtre de renfort.
  stepUp(session, instId, user) {
    this.comptes.exigerRenfort(session);
    this.services.get(instId);
    const until = session.renfort + 5 * 60e3;
    this.steps.set(this.key(session, instId), until);
    this.audit.write(user, 'comptes.a2f', instId, {});
    return { until };
  }

  requireStep(session, instId) {
    const until = this.steps.get(this.key(session, instId)) || 0;
    if (until < Date.now()) {
      this.steps.delete(this.key(session, instId));
      throw new HttpError(403, 'Second facteur requis pour ce service.', { stepUp: true });
    }
    return until;
  }

  release(session, instId) { this.steps.delete(this.key(session, instId)); }

  // ---- lecture ----
  async list(instId) {
    const inst = this.services.get(instId);
    const a = this.blockOf(inst);
    const raw = await this.appel(inst, a, a.list, { retries: 1 });
    const rows = (Array.isArray(raw) ? raw : []).map(x => ({
      id: String(jsonPath(x, a.fields.id) ?? ''),
      name: String(jsonPath(x, a.fields.name) ?? ''),
      role: a.fields.role ? jsonPath(x, a.fields.role) : null,
      mfa: a.fields.mfa ? !!jsonPath(x, a.fields.mfa) : null,
      created: a.fields.created ? jsonPath(x, a.fields.created) : null,
      lastSeen: a.fields.lastSeen ? jsonPath(x, a.fields.lastSeen) : null,
      flagged: a.fields.protected ? !!jsonPath(x, a.fields.protected) : false,
      ...(estSocle(a) ? { email: x.courriel || '', cle: x.cle || null, actif: x.actif !== false, ...facteursDe(x) } : {}),
    })).filter(r => r.id);
    return { rows: this.markProtected(rows, a), roles: a.roles || [], emailDefaut: this.emailDefaut(), envoi: this.envoiPossible(inst) };
  }

  emailDefaut() { return this.db && this.vault ? reglageCourriel(this.db, this.vault).defaut : ''; }

  // Un lien part par e-mail si le service a un relais : le sien, ou celui du
  // Hub (repris seulement avec une adresse publique en HTTPS).
  envoiPossible(inst) {
    const cfg = this.services.configOf(inst);
    if (String(cfg.SOCLE_SMTP_HOTE || '').trim()) return true;
    const r = this.db && this.vault ? reglageCourriel(this.db, this.vault).relais : {};
    return !!(r.hote && r.de && /^https:\/\//i.test(String(cfg.SOCLE_URL_PUBLIQUE || '')));
  }

  // Le compte d'origine — le premier administrateur créé — n'est jamais
  // supprimable depuis le Hub : c'est le compte par lequel on reprend la main
  // si le Hub se trompe, ou si on lui retire ses droits.
  markProtected(rows, a) {
    // Si le service désigne lui-même son compte d'origine, on le croit.
    if (rows.some(r => r.flagged)) return rows.map(r => ({ ...r, protected: r.flagged }));
    const admins = rows.filter(r => !a.adminRole || r.role === a.adminRole);
    const ordered = [...(admins.length ? admins : rows)].sort((x, y) => String(x.created || '').localeCompare(String(y.created || '')));
    const first = ordered[0];
    return rows.map(r => ({ ...r, protected: !!first && r.id === first.id }));
  }

  async protectedId(instId) {
    const { rows } = await this.list(instId);
    return rows.find(r => r.protected)?.id || null;
  }

  // ---- écritures ----
  async create(instId, body, actor) {
    const inst = this.services.get(instId);
    const a = this.blockOf(inst);
    if (!a.create) throw new HttpError(400, `${inst.name} ne permet pas de créer un compte depuis le Hub.`);
    const params = { username: String(body.username || '').trim(), password: String(body.password || ''), role: String(body.role || (a.roles || [])[0] || '') };
    if (!params.username) throw new HttpError(400, 'Identifiant requis.');
    if (a.roles && params.role && !a.roles.includes(params.role)) throw new HttpError(400, `Rôle inconnu : ${params.role}`);
    // Sur invitation, aucun mot de passe ne passe par le Hub : l'invité choisit le sien.
    if (a.invitation) delete params.password;
    if (estSocle(a)) {
      // L'adresse saisie, sinon l'adresse par défaut des comptes réglée dans le Hub.
      // Sans champ e-mail (service au socle plus ancien), rien n'est envoyé de plus.
      const email = body.email === undefined ? '' : String(body.email).trim() || this.emailDefaut();
      if (email && !ADRESSE.test(email)) throw new HttpError(400, 'Adresse e-mail invalide.');
      const corps = { identifiant: params.username, role: params.role || 'membre', ...(email ? { courriel: email } : {}), envoyer: !!body.envoyer };
      const out = await this.appel(inst, a, { method: 'POST', path: a.create.path, body: corps }, { actor, adresse: body.adresse, brut: true });
      this.audit.write(actor, 'compte.invité', inst.name, { identifiant: params.username, rôle: corps.role, envoyé: !!body.envoyer });
      return this.avecAutres(inst, out);
    }
    const out = await this.appel(inst, a, a.create, { actor, adresse: body.adresse, params });
    this.audit.write(actor, a.invitation ? 'compte.invité' : 'compte.créé', inst.name, { identifiant: params.username, rôle: params.role });
    return this.avecAutres(inst, out);
  }

  async update(instId, userId, body, actor) {
    const inst = this.services.get(instId);
    const a = this.blockOf(inst);
    if (!a.update) throw new HttpError(400, `${inst.name} ne permet pas de modifier un compte depuis le Hub.`);
    if (a.roles && body.role && !a.roles.includes(body.role)) throw new HttpError(400, `Rôle inconnu : ${body.role}`);
    const params = { id: String(userId), role: body.role, username: body.username };
    if (estSocle(a)) {
      const corps = {};
      if (body.role) corps.role = body.role;
      if (body.email !== undefined) {
        const email = String(body.email).trim();
        if (email && !ADRESSE.test(email)) throw new HttpError(400, 'Adresse e-mail invalide.');
        if (email) corps.courriel = email; else corps.retirerCourriel = true;
      }
      if (body.cleExigee !== undefined) corps.cleExigee = !!body.cleExigee;
      if (body.actif !== undefined) corps.actif = !!body.actif;
      if (!Object.keys(corps).length) throw new HttpError(400, 'Rien à modifier.');
      const out = await this.appel(inst, a, { method: 'PATCH', path: `/api/compte/hub/comptes/${encodeURIComponent(String(userId))}`, body: corps }, { actor, brut: true });
      this.audit.write(actor, 'compte.modifié', inst.name, { id: userId, ...('courriel' in corps || corps.retirerCourriel ? { email: corps.courriel ? 'posée' : 'retirée' } : {}), ...(corps.role ? { rôle: corps.role } : {}), ...('cleExigee' in corps ? { cléExigée: corps.cleExigee } : {}), ...('actif' in corps ? { actif: corps.actif } : {}) });
      return out;
    }
    const out = await this.appel(inst, a, a.update, { actor, params });
    this.audit.write(actor, 'compte.modifié', inst.name, { id: userId, rôle: body.role });
    return out;
  }

  async password(instId, userId, body, actor) {
    const inst = this.services.get(instId);
    const a = this.blockOf(inst);
    if (!a.password) throw new HttpError(400, `${inst.name} ne permet pas de changer un mot de passe depuis le Hub.`);
    if (String(body.password || '').length < 12) throw new HttpError(400, 'Mot de passe : 12 caractères au minimum.');
    const out = await this.appel(inst, a, a.password, { actor, params: { id: String(userId), password: String(body.password) } });
    this.audit.write(actor, 'compte.mot_de_passe', inst.name, { id: userId });
    return out;
  }

  async requireMfa(instId, userId, actor) {
    const inst = this.services.get(instId);
    const a = this.blockOf(inst);
    if (!a.requireMfa) throw new HttpError(400, `${inst.name} ne permet pas d’exiger le second facteur depuis le Hub.`);
    const out = await this.appel(inst, a, a.requireMfa, { actor, params: { id: String(userId) } });
    this.audit.write(actor, 'compte.a2f_exigée', inst.name, { id: userId });
    return out;
  }

  async remove(instId, userId, actor) {
    const inst = this.services.get(instId);
    const a = this.blockOf(inst);
    if (!a.remove) throw new HttpError(400, `${inst.name} ne permet pas de supprimer un compte depuis le Hub.`);
    const protégé = await this.protectedId(instId);
    if (protégé && String(userId) === String(protégé)) {
      throw new HttpError(403, 'Le compte administrateur d’origine ne se supprime pas depuis le Hub. C’est par lui qu’on reprend la main.');
    }
    const out = await this.appel(inst, a, a.remove, { actor, params: { id: String(userId) } });
    this.audit.write(actor, 'compte.supprimé', inst.name, { id: userId });
    return out;
  }

  // Lien de réinitialisation : le service le fabrique, l'opérateur le transmet.
  async reset(instId, userId, body, actor) {
    const inst = this.services.get(instId);
    const a = this.blockOf(inst);
    if (!a.reset) throw new HttpError(400, `${inst.name} ne fabrique pas de lien de réinitialisation.`);
    const out = estSocle(a)
      ? await this.appel(inst, a, { method: 'POST', path: `/api/compte/hub/comptes/${encodeURIComponent(String(userId))}/reinit`, body: { envoyer: !!body?.envoyer } }, { actor, adresse: body?.adresse, brut: true })
      : await this.appel(inst, a, a.reset, { actor, adresse: body?.adresse, params: { id: String(userId) } });
    this.audit.write(actor, 'compte.lien_réinitialisation', inst.name, { id: userId, envoyé: !!body?.envoyer });
    return this.avecAutres(inst, out);
  }

  /**
   * Le même lien sur les autres adresses du service (réseau, machine) : son
   * nom public peut ne pas répondre encore. Le jeton est dans le chemin ou
   * l'ancre, il vaut sur toutes les adresses du même service.
   */
  avecAutres(inst, out) {
    if (!out?.lien) return out;
    let u; try { u = new URL(out.lien); } catch { return out; }
    const suite = u.pathname + u.search + u.hash;
    const vues = this.services.publicView?.(inst)?.open || [];
    const origines = [...new Set(vues.map(o => { try { return o.url ? new URL(o.url).origin : null; } catch { return null; } }).filter(o => o && o !== u.origin))];
    return origines.length ? { ...out, autres: origines.map(o => o + suite) } : out;
  }
}
