// Point d'entrée du conteneur : le processus lancé supervise le Hub et le
// relance quand l'assistant de configuration a posé de nouveaux réglages.
// L'enfant complète process.env avec ces réglages (l'environnement réel garde
// la main) avant de charger le Hub, qui lit sa configuration au chargement.
import path from 'node:path';
import { appliquerReglages, superviser } from '../socle/src/index.js';

if (!superviser()) {
  appliquerReglages({ dossier: path.resolve(process.env.HUB_DATA || './data'), env: process.env, enPlace: true });
  const { lancer } = await import('./main.js');
  await lancer();
}
