// Reprise des comptes du Hub 0.5 (tables users et sessions) dans le socle.
//
// Les empreintes scrypt se relisent telles quelles et passent en Argon2id à la
// première connexion. Les secrets TOTP, qui étaient en clair, sont scellés.
// Les codes de secours de 40 bits ne sont pas repris : trop faibles, ils sont
// remplacés à l'inscription des facteurs. Les sessions ouvertes sont fermées :
// chacun se reconnecte une fois.
import { normaliseIdentifiant } from '../socle/src/comptes.js';

const ROLES = { admin: 'admin', lecture: 'lecture' };

export function migrerComptes({ db, comptes, coffre, log }) {
  const existe = t => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  if (!existe('users')) return 0;
  const anciens = db.prepare('SELECT * FROM users ORDER BY created').all();
  comptes.transaction(() => {
    for (const u of anciens) {
      let ident = normaliseIdentifiant(u.username).replace(/[^\p{L}\p{N}._@+-]/gu, '-').slice(0, 60);
      if (ident.length < 3) ident = `compte-${u.id.slice(-6)}`;
      if (comptes.parIdentifiant(ident)) ident = `${ident}-${u.id.slice(-6)}`;
      const c = comptes.creerCompte({ identifiant: ident, affichage: u.username, role: ROLES[u.role] || 'membre' });
      const totp = u.totp_enabled && u.totp_secret ? coffre.scelle('totp', String(u.totp_secret).replace(/\s/g, '').toUpperCase(), c.id) : null;
      db.prepare('UPDATE socle_comptes SET mdp = ?, totp = ?, cree = ? WHERE id = ?').run(u.pass_hash || null, totp, u.created || Date.now(), c.id);
    }
    db.exec('DROP TABLE IF EXISTS sessions; DROP TABLE users;');
    db.prepare("DELETE FROM settings WHERE key = 'pairing_code'").run();
  });
  if (!anciens.length) return 0;
  comptes.trace({ action: 'migration.hub', details: { comptes: anciens.length } });
  log.info('comptes', `${anciens.length} compte(s) du Hub 0.5 repris dans le socle : chacun se reconnecte une fois.`);
  return anciens.length;
}
