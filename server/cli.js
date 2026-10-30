// Administration en ligne de commande, depuis la machine :
//
//   docker exec hub node server/cli.js jeton <nom> [portée]
//   docker exec hub node server/cli.js sauvegarde > hub-AAAA-MM-JJ.sauv
//   node server/cli.js restaurer <clé-privée.pem> <cible.db> < hub-AAAA-MM-JJ.sauv
//
// jeton : crée un jeton d'accès (portée « assistant » par défaut) et l'écrit,
// seul, sur la sortie standard : de quoi le passer à un autre programme par un
// tube sans qu'il apparaisse à l'écran. Un jeton du même nom est révoqué
// d'abord : relancer la commande fait une rotation.
//
// sauvegarde : un instantané chiffré pour HUB_SAUVEGARDE_CLE (clé publique) ;
// restaurer : sur une autre machine, avec la clé privée, vers un fichier neuf.
//
// coupure : l'IA ou les workflows hors ligne tout de suite, sur le Hub qui
// tourne (docker exec hub node server/cli.js coupure ia oui) ; sans argument,
// l'état actuel.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { openDb } from './db/index.js';
import { Audit } from './audit.js';
import { Jetons } from './auth/jetons.js';
import { sauvegarder, dechiffrer } from './sauvegarde.js';
import { coupure, poserCoupure, FONCTIONS } from './coupure.js';

// Le journal (migrations…) part sur la sortie d'erreur : la sortie standard ne porte que le résultat.
console.log = (...a) => process.stderr.write(a.join(' ') + '\n');
console.info = console.log;

const USAGE = 'Usage : node server/cli.js jeton <nom> [assistant] | sauvegarde | restaurer <clé-privée.pem> <cible.db> | coupure [ia|workflows oui|non]\n';
const [commande, a1, a2] = process.argv.slice(2);
const base = () => openDb(path.join(config.dataDir, 'hub.db'));

try {
  if (commande === 'jeton' && a1) {
    const db = base();
    const jetons = new Jetons(db, new Audit(db));
    for (const j of jetons.lister().filter(x => x.nom === a1)) jetons.revoquer(j.id, 'ligne de commande');
    process.stdout.write(jetons.creer(a1, a2 || 'assistant', 'ligne de commande').jeton + '\n');
  } else if (commande === 'sauvegarde') {
    if (!config.sauvegardeCle) throw new Error('HUB_SAUVEGARDE_CLE (ou HUB_SAUVEGARDE_CLE_FILE) : la clé publique pour laquelle chiffrer.');
    if (process.stdout.isTTY) throw new Error('Redirige la sortie vers un fichier : node server/cli.js sauvegarde > hub.sauv');
    const db = base();
    const sortie = await sauvegarder(db, config.sauvegardeCle, { version: config.version });
    new Audit(db).write('ligne de commande', 'sauvegarde.faite', null, { octets: sortie.length });
    process.stdout.write(sortie);
  } else if (commande === 'coupure' && (!a1 || (a1 in FONCTIONS && ['oui', 'non'].includes(a2)))) {
    const db = base();
    const etat = a1 ? poserCoupure(db, new Audit(db), { [a1]: a2 === 'oui' }, 'ligne de commande') : coupure(db);
    process.stdout.write(Object.entries(etat).map(([f, c]) => `${f} : ${c ? 'COUPÉ' : 'en service'}`).join('\n') + '\n');
  } else if (commande === 'restaurer' && a1 && a2) {
    if (fs.existsSync(a2)) throw new Error(`${a2} existe déjà : la restauration écrit un fichier neuf.`);
    const { entete, base: clair } = dechiffrer(fs.readFileSync(0), fs.readFileSync(a1, 'utf8'));
    fs.writeFileSync(a2, clair, { mode: 0o600, flag: 'wx' });
    process.stderr.write(`Base du Hub ${entete.version} du ${entete.date} restaurée dans ${a2}.\n`);
  } else {
    process.stderr.write(USAGE);
    process.exit(2);
  }
} catch (e) {
  process.stderr.write(`${e.message}\n`);
  process.exit(1);
}
