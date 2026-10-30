// Courriel des comptes : l'adresse par défaut des comptes créés depuis le Hub,
// et le relais d'envoi que les services reprennent pour envoyer leurs liens
// (invitation, réinitialisation) et leurs alertes.
//
// Le mot de passe du relais est scellé par le coffre du Hub ; il n'est rendu
// en clair qu'au rendu du Compose d'un service, comme ses autres secrets. Un
// service ne reçoit le relais que s'il a une adresse publique en HTTPS : le
// socle refuse d'envoyer des liens vers une adresse en clair.
import { HttpError } from './util/common.js';

const ADRESSE = /^[^@\s<>",;:\\]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;
const HOTE = /^[A-Za-z0-9.-]{1,253}$/;
export const SECURITES = ['tls', 'starttls'];

export function reglageCourriel(db, vault) {
  const r = db.setting('courriel_comptes', {}) || {};
  const relais = r.relais || {};
  let motdepasse = '';
  try { motdepasse = relais.motdepasse ? vault.open(relais.motdepasse) : ''; } catch { motdepasse = ''; }
  return {
    defaut: r.defaut || '',
    relais: { hote: relais.hote || '', port: relais.port || 587, securite: relais.securite || 'starttls', utilisateur: relais.utilisateur || '', motdepasse, de: relais.de || '' },
  };
}

// Ce que l'interface lit : jamais le mot de passe.
export function vueCourriel(db, vault) {
  const r = reglageCourriel(db, vault);
  return { defaut: r.defaut, relais: { ...r.relais, motdepasse: r.relais.motdepasse ? '••••' : '' }, actif: !!(r.relais.hote && r.relais.de) };
}

export function poserCourriel(db, vault, audit, corps, acteur) {
  const avant = reglageCourriel(db, vault);
  const defaut = String(corps.defaut ?? avant.defaut).trim();
  if (defaut && !ADRESSE.test(defaut)) throw new HttpError(400, 'Adresse par défaut invalide.');
  const n = corps.relais || {};
  const relais = {
    hote: String(n.hote ?? avant.relais.hote).trim(),
    port: Number(n.port ?? avant.relais.port),
    securite: String(n.securite ?? avant.relais.securite),
    utilisateur: String(n.utilisateur ?? avant.relais.utilisateur).trim(),
    de: String(n.de ?? avant.relais.de).trim(),
  };
  if (relais.hote && !HOTE.test(relais.hote)) throw new HttpError(400, 'Relais : nom d’hôte invalide.');
  if (!Number.isInteger(relais.port) || relais.port < 1 || relais.port > 65535) throw new HttpError(400, 'Relais : port invalide.');
  if (!SECURITES.includes(relais.securite)) throw new HttpError(400, 'Relais : chiffrement « tls » ou « starttls ».');
  if (relais.de && !ADRESSE.test(relais.de)) throw new HttpError(400, 'Relais : adresse d’expédition invalide.');
  if (relais.hote && !relais.de) throw new HttpError(400, 'Relais : l’adresse d’expédition est requise.');
  if (/[\r\n\0]/.test(relais.utilisateur)) throw new HttpError(400, 'Relais : identifiant invalide.');
  // Mot de passe : absent, inchangé ; chaîne vide, retiré.
  const ancien = (db.setting('courriel_comptes', {}) || {}).relais?.motdepasse || '';
  let motdepasse = ancien;
  if (n.motdepasse !== undefined) {
    if (/[\r\n\0]/.test(String(n.motdepasse))) throw new HttpError(400, 'Relais : mot de passe invalide.');
    motdepasse = n.motdepasse ? vault.seal(String(n.motdepasse)) : '';
  }
  db.setSetting('courriel_comptes', { defaut, relais: { ...relais, motdepasse } });
  audit.write(acteur, 'courriel.modifié', null, { defaut: !!defaut, relais: relais.hote ? `${relais.hote}:${relais.port}` : null, motdepasse: n.motdepasse !== undefined ? 'changé' : 'inchangé' });
  return vueCourriel(db, vault);
}

// Les réglages SOCLE_SMTP_* qu'un service reçoit du Hub, quand les siens sont
// vides et que son adresse publique est en HTTPS.
export function smtpPourService(reglage, cfg) {
  const r = reglage.relais;
  if (!r.hote || !r.de) return {};
  if (!/^https:\/\//i.test(String(cfg.SOCLE_URL_PUBLIQUE || ''))) return {};
  if (String(cfg.SOCLE_SMTP_HOTE || '').trim()) return {};
  return {
    SOCLE_SMTP_HOTE: r.hote, SOCLE_SMTP_PORT: String(r.port), SOCLE_SMTP_SECURITE: r.securite,
    SOCLE_SMTP_UTILISATEUR: r.utilisateur, SOCLE_SMTP_MOTDEPASSE: r.motdepasse, SOCLE_SMTP_DE: r.de,
  };
}
