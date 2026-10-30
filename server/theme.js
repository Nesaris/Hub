// Gamme de l'interface : celle du Hub, et celle des services qui l'acceptent.
//
// Un service la reçoit par une variable de son Compose (posée en SOCLE_THEME) ;
// un service dont le Compose ne la lit pas garde son apparence, quel que soit
// ce réglage. Changer de gamme redéploie ceux qui la lisent.
//
// Trois variables, parce qu'un service publié a un socle qui refuse au
// démarrage une gamme qu'il ne connaît pas : {{hub.theme}} ne rend que SOMA ou
// Console, {{hub.gamme}} y ajoute Exploitation, {{hub.apparence}} rend toutes
// les gammes, Lavande comprise. Une gamme qu'un service ne connaît pas lui
// arrive en SOMA.
//
// Deux façons de choisir, page Thème : une gamme pour tout, ou une par
// service (le Hub compris, sous la clé « hub »). En mode par service, ce qui
// n'a pas de choix propre prend la gamme commune.
import { GAMMES } from '../socle/src/index.js';

export { GAMMES };
export const LIBELLES_GAMME = {
  soma: 'SOMA — fond papier ou sombre, accent bleu',
  console: 'Console — noir et vert, ou blanc et bleu',
  exploitation: 'Exploitation — surfaces neutres, accent sauge, claire ou sombre',
  lavande: 'Lavande — verre clair sur fond lavande, rail sombre, accent indigo',
};
// Ce que comprend le socle des services publiés avant la gamme Exploitation.
export const GAMMES_PREMIERES = ['soma', 'console'];
export const gammeCompatible = g => (GAMMES_PREMIERES.includes(g) ? g : 'soma');
// Ce que comprend le socle des services publiés avant la gamme Lavande.
export const GAMMES_EXPLOITATION = ['soma', 'console', 'exploitation'];
// Ce que lit le Compose d'un service : {{hub.theme}} (« premieres »),
// {{hub.gamme}} (« exploitation ») ou {{hub.apparence}} (« toutes »).
export const composeLitToutes = texte => /\{\{\s*hub\.gamme\s*\}\}/.test(texte || '');
export const composeLitApparence = texte => /\{\{\s*hub\.apparence\s*\}\}/.test(texte || '');
export const gammesOffertes = niveau => (niveau === 'toutes' ? GAMMES : niveau === 'exploitation' ? GAMMES_EXPLOITATION : GAMMES_PREMIERES);
/** La gamme qu'un service reçoit vraiment : la sienne s'il la connaît, sinon SOMA. */
export const gammeRecue = (g, niveau) => (gammesOffertes(niveau).includes(g) ? g : 'soma');
export const MODES_THEME = ['commun', 'service'];
export const CLE_HUB = 'hub';

export function gammeDu(db, defaut = 'soma') {
  const g = db.setting('theme_services', defaut);
  return GAMMES.includes(g) ? g : 'soma';
}

/** Le réglage tel qu'il est enregistré, nettoyé de toute valeur inconnue. */
export function reglageTheme(db) {
  const mode = db.setting('theme_mode', 'commun') === 'service' ? 'service' : 'commun';
  const brut = db.setting('theme_par_service', {});
  const parService = brut && typeof brut === 'object' && !Array.isArray(brut)
    ? Object.fromEntries(Object.entries(brut).filter(([, g]) => GAMMES.includes(g)))
    : {};
  return { mode, commun: gammeDu(db), parService };
}

/** La gamme qui s'applique à `cle` : un identifiant de service, ou CLE_HUB. */
export const gammePour = (reglage, cle) => (reglage.mode === 'service' && reglage.parService[cle]) || reglage.commun;

// La pile rendue d'un service dit s'il suit la gamme : SOCLE_THEME y est posé.
export const pileSuitLaGamme = texte => /^\s*SOCLE_THEME\s*:/m.test(texte || '');
