// Jetons d'accès : pour un programme qui parle à l'assistant du Hub (un banc
// d'essai, un script), sans compte humain ni second facteur.
//
// Montré une seule fois à la création, gardé sous forme d'empreinte. Sa
// portée est fermée : « assistant » ouvre les questions à l'assistant, et
// rien d'autre — pas les réglages, pas les services, pas l'exécution d'un
// plan (qui reste un geste d'administrateur).
import crypto from 'node:crypto';
import { HttpError } from '../util/common.js';

export const PORTEES = { assistant: 'Poser des questions à l’assistant (ne peut rien exécuter)' };
const NOM_OK = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u;
const empreinte = t => crypto.createHash('sha256').update(t).digest('hex');

export class Jetons {
  constructor(db, audit) { this.db = db; this.audit = audit; }

  creer(nom, portee, actor) {
    nom = String(nom || '').trim();
    if (!NOM_OK.test(nom)) throw new HttpError(400, 'Nom du jeton : 40 caractères au plus, lettres, chiffres, espace, point, tiret.');
    if (!PORTEES[portee]) throw new HttpError(400, `Portée inconnue : ${portee}`);
    if (this.db.get('SELECT 1 FROM jetons WHERE nom=? AND revoque IS NULL', nom)) throw new HttpError(409, `Un jeton « ${nom} » existe déjà : révoque-le d'abord.`);
    const jeton = `hubj_${crypto.randomBytes(32).toString('base64url')}`;
    const id = `j_${crypto.randomBytes(6).toString('hex')}`;
    this.db.run('INSERT INTO jetons(id,nom,prefixe,empreinte,portee,cree) VALUES(?,?,?,?,?,?)', id, nom, jeton.slice(0, 10), empreinte(jeton), portee, Date.now());
    this.audit.write(actor, 'jeton.créé', nom, { portée: portee });
    return { id, nom, portee, jeton };
  }

  /** Le jeton présenté, s'il est valide et non révoqué. */
  verifier(brut) {
    if (!/^hubj_[\w-]{40,60}$/.test(String(brut || ''))) return null;
    const j = this.db.get('SELECT id, nom, portee FROM jetons WHERE empreinte=? AND revoque IS NULL', empreinte(brut));
    if (j) this.db.run('UPDATE jetons SET utilise=? WHERE id=?', Date.now(), j.id);
    return j || null;
  }

  lister() {
    return this.db.all('SELECT id, nom, prefixe, portee, cree, utilise FROM jetons WHERE revoque IS NULL ORDER BY cree DESC');
  }

  revoquer(id, actor) {
    const j = this.db.get('SELECT nom FROM jetons WHERE id=? AND revoque IS NULL', id);
    if (!j) throw new HttpError(404, 'Jeton introuvable');
    this.db.run('UPDATE jetons SET revoque=? WHERE id=?', Date.now(), id);
    this.audit.write(actor, 'jeton.révoqué', j.nom, {});
    return { ok: true };
  }
}
