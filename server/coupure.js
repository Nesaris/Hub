// Coupure d'urgence (SEC-LOG-007) : mettre une fonction compromise hors ligne
// tout de suite, sans redéploiement, depuis Réglages ou la ligne de commande.
// L'état est relu à chaque appel : la ligne de commande agit sur un Hub qui
// tourne, et une exécution en cours s'arrête au nœud suivant.
import { HttpError } from './util/common.js';

export const FONCTIONS = {
  ia: 'Aucun appel à un modèle, ni pour l’assistant ni pour un nœud.',
  workflows: 'Aucun déclenchement, aucune exécution, webhooks refusés, interrogations suspendues.',
};
const NOMS = { ia: 'L’intelligence artificielle', workflows: 'Les workflows' };

export const coupure = db => ({ ia: false, workflows: false, ...db.setting('coupure', {}) });

export function exigerOuvert(db, fonction) {
  if (coupure(db)[fonction]) throw new HttpError(503, `${NOMS[fonction]} : coupure d’urgence posée par un administrateur (Réglages → Coupure d’urgence).`);
}

export function poserCoupure(db, audit, valeurs, acteur) {
  const net = coupure(db);
  for (const f of Object.keys(FONCTIONS)) if (typeof valeurs?.[f] === 'boolean') net[f] = valeurs[f];
  db.setSetting('coupure', net);
  audit.write(acteur, 'coupure.modifiée', null, net);
  return net;
}
