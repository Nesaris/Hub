// HTTPS servi par le Hub lui-même, sur son propre port (REQ-WEB-001) : le
// certificat et sa clé sont lus dans HUB_TLS_DIR (hub.crt, hub.key) et relus
// quand ils changent, pour qu'un renouvellement ne demande pas de redémarrage.
//
// Le même port accepte les deux. Une connexion TLS est servie. Une connexion
// en clair reçoit une redirection vers HTTPS, sauf dans deux cas : elle vient
// du conteneur lui-même (le test de santé), ou elle demande le Hub par son nom
// Docker (« hub:8100 », un nom sans point). Ce sont les webhooks des services
// voisins sur le réseau Docker ; un navigateur ne connaît pas ce nom.
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import path from 'node:path';

const OCTET_TLS = 0x16;
const AVANT_TRI_MS = 10_000;
const VERIFICATION_MS = 60_000;
const ALERTE_MS = 21 * 86400e3;
const OPTIONS_TLS = { minVersion: 'TLSv1.2' };

/** Le certificat et sa clé, vérifiés ensemble ; null si le dossier n'en a pas. */
export function lireTls(dossier) {
  if (!dossier) return null;
  const crt = path.join(dossier, 'hub.crt'), cle = path.join(dossier, 'hub.key');
  if (!fs.existsSync(crt) || !fs.existsSync(cle)) return null;
  const cert = fs.readFileSync(crt), key = fs.readFileSync(cle);
  const x = new crypto.X509Certificate(cert);
  if (!x.checkPrivateKey(crypto.createPrivateKey(key))) throw new Error(`${crt} ne correspond pas à ${cle}.`);
  return {
    cert, key, expire: Date.parse(x.validTo), noms: x.subjectAltName || '',
    marque: `${fs.statSync(crt).mtimeMs}:${fs.statSync(cle).mtimeMs}`,
  };
}

const BOUCLE = new Set(['localhost', '127.0.0.1', '::1']);

/** Nom d'hôte et port d'un en-tête Host : « [::1]:8100 » → { nom: '::1', port: '8100' }. */
export function hoteDe(entete) {
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/.exec(String(entete || '').trim().toLowerCase());
  return m ? { nom: m[1].replace(/^\[|\]$/g, ''), port: m[2] || '' } : null;
}

/** Le nom Docker d'un conteneur voisin : une seule étiquette, sans point. */
export const nomInterne = nom => /^[a-z0-9][a-z0-9-]{0,62}$/.test(nom) && nom !== 'localhost';

/**
 * La même adresse, en HTTPS : le Hub s'ouvre par son nom comme par son adresse
 * IP (au TOTP sur une IP, les clés d'accès ne s'y ouvrant pas). null : hôte illisible.
 */
export function cibleHttps(entete, chemin) {
  const h = hoteDe(entete);
  if (!h) return null;
  const hote = net.isIPv6(h.nom) ? `[${h.nom}]` : h.nom;
  return `https://${hote}${h.port ? ':' + h.port : ''}${String(chemin || '/').startsWith('/') ? chemin : '/'}`;
}

function rediriger(res, vers) {
  res.writeHead(308, { Location: vers, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': 0 });
  res.end();
}

/**
 * Un serveur unique sur le port du Hub : TLS servi, clair redirigé (sauf
 * test de santé et nom Docker). Rend le serveur à l'écoute, avec ses deux
 * serveurs intérieurs (délais) et son certificat en cours.
 */
const depuisLeConteneur = req => BOUCLE.has(String(req.socket.remoteAddress || '').replace(/^::ffff:/, ''));

export function serveurDouble(gestionnaire, { dossier, journal = console, maintenant = () => Date.now(), estLocal = depuisLeConteneur }) {
  let tls = lireTls(dossier);
  if (!tls) throw new Error(`Aucun certificat dans ${dossier} (hub.crt, hub.key).`);
  const chiffre = https.createServer({ ...OPTIONS_TLS, cert: tls.cert, key: tls.key }, gestionnaire);
  const clair = http.createServer((req, res) => {
    const h = hoteDe(req.headers.host);
    if (estLocal(req) || (h && nomInterne(h.nom))) return gestionnaire(req, res);
    const vers = cibleHttps(req.headers.host, req.url);
    if (!vers) { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Requête sans hôte.'); }
    rediriger(res, vers);
  });
  const porte = net.createServer(sock => {
    sock.setTimeout(AVANT_TRI_MS, () => sock.destroy());
    sock.on('error', () => sock.destroy());
    sock.once('data', premier => {
      sock.setTimeout(0);
      sock.pause();
      sock.unshift(premier);
      (premier[0] === OCTET_TLS ? chiffre : clair).emit('connection', sock);
      process.nextTick(() => sock.resume());
    });
  });
  porte.interieurs = [chiffre, clair];
  porte.certificat = () => ({ expire: tls.expire, noms: tls.noms });

  let alerte = 0;
  const verifier = () => {
    try {
      const neuf = lireTls(dossier);
      if (neuf && neuf.marque !== tls.marque) {
        chiffre.setSecureContext({ ...OPTIONS_TLS, cert: neuf.cert, key: neuf.key });
        tls = neuf;
        journal.info(`certificat HTTPS rechargé, valable jusqu’au ${new Date(tls.expire).toISOString().slice(0, 10)}`);
      }
    } catch (e) { journal.warn(`certificat HTTPS illisible, l’ancien reste en place : ${e.message}`); }
    const reste = tls.expire - maintenant();
    if (reste < ALERTE_MS && maintenant() - alerte > 86400e3) {
      alerte = maintenant();
      journal.warn(reste <= 0 ? 'le certificat HTTPS a expiré : renouvelle-le (outils/tls-local.sh).' : `le certificat HTTPS expire dans ${Math.ceil(reste / 86400e3)} jour(s) : renouvelle-le (outils/tls-local.sh).`);
    }
  };
  verifier();
  const minuteur = setInterval(verifier, VERIFICATION_MS);
  minuteur.unref();
  const fermer = porte.close.bind(porte);
  porte.close = cb => { clearInterval(minuteur); chiffre.close(); clair.close(); return fermer(cb); };
  return porte;
}
