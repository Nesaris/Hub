// Débit par minute et quota par jour, par compte ou par jeton d'accès, pour
// les routes qui coûtent (manuel, SEC-LLM-002 et REQ-WEB-008). Le débit vit en
// mémoire (un seul processus longue durée) ; le quota du jour, en base, survit
// à un redémarrage.
import { Debit } from '../socle/src/http.js';
import { HttpError } from './util/common.js';

export class Quotas {
  constructor(db, { maintenant = () => Date.now() } = {}) {
    this.db = db; this.maintenant = maintenant; this.debits = new Map();
  }

  prendre(nom, qui, { minute, jour }) {
    const d = `${nom}:${minute}`;   // un débit par limite : changer la limite en prend un neuf
    if (!this.debits.has(d)) this.debits.set(d, new Debit({ max: minute }));
    if (!this.debits.get(d).prendre(qui)) throw new HttpError(429, 'Trop de demandes en une minute : réessaie dans un instant.');
    const cle = `${nom}:${qui}`, date = new Date(this.maintenant()).toISOString().slice(0, 10);
    const n = this.db.get('SELECT n FROM quotas WHERE cle=? AND jour=?', cle, date)?.n || 0;
    if (n >= jour) throw new HttpError(429, `Quota du jour atteint (${jour}) : il se renouvelle à minuit (UTC).`);
    this.db.run('INSERT INTO quotas(cle, jour, n) VALUES(?,?,1) ON CONFLICT(cle, jour) DO UPDATE SET n = n + 1', cle, date);
    if (n === 0) this.db.run('DELETE FROM quotas WHERE jour < ?', new Date(this.maintenant() - 7 * 86400e3).toISOString().slice(0, 10));
  }
}
