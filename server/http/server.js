// Serveur HTTP du Hub sur le socle : en-têtes et politique de contenu à nonce,
// comptes et sessions du socle, jetons d'accès du Hub, routes déclarées avec
// leurs exigences (refus par défaut), fichiers de l'interface, flux SSE.
import http from 'node:http';
import path from 'node:path';
import { Debit, ErreurHttp, Routeur, cheminVersionne, entetesSecurite, envelopper, lireCorps, nonceCsp, politiqueContenu, repondreErreur, repondreJson, servirFichier, valider } from '../../socle/src/index.js';
import { HttpError, log } from '../util/common.js';
import { serveurDouble } from './tls.js';

export { Routeur as Router };

// Le micro sert au mode vocal de l'assistant, sur cette origine seulement.
const PERMISSIONS = 'camera=(), microphone=(self), geolocation=(), payment=(), usb=(), serial=(), hid=(), midi=(), magnetometer=(), gyroscope=(), accelerometer=(), display-capture=()';
const METHODES_SURES = new Set(['GET', 'HEAD']);

// Corps brut, pour les routes qui ne reçoivent pas du JSON (webhooks, audio).
function lireBrut(req, limite) {
  return new Promise((resolve, reject) => {
    let taille = 0; const morceaux = [];
    req.on('data', c => { taille += c.length; if (taille > limite) { reject(new HttpError(413, 'Corps trop volumineux')); req.destroy(); } else morceaux.push(c); });
    req.on('end', () => resolve(Buffer.concat(morceaux)));
    req.on('error', reject);
  });
}

// Exigence d'une route : administrateur si elle le dit, sinon lecture pour
// consulter et membre pour agir. Un compte « lecture » ne modifie rien.
const roleExige = (o, methode) => (o.role === 'admin' ? 'admin' : METHODES_SURES.has(methode) ? 'lecture' : 'membre');

// Un paramètre d'adresse (/api/instances/:id) : un identifiant ou un nom de
// clé (« Outil Maison »), rien d'autre.
const PARAMETRE = /^[\p{L}\p{N}_.:@~ '’-]{1,128}$/u;
const ECRITURES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// tls : { dossier, nom, journal } — le Hub sert alors HTTPS lui-même (tls.js).
export function createServer({ router, socle, jetons, quotas, webDir, socleWebDir, gamme = () => 'soma', disposition = () => 'gauche', tls = null, apresEcriture = null, version = '' }) {
  // Refus par défaut : une route qui écrit sans schéma de corps (schemas.js) arrête le démarrage.
  const sansSchema = router.routes.filter(r => ECRITURES.has(r.methode) && !r.options.raw && !r.options.corps);
  if (sansSchema.length) throw new Error(`Routes sans schéma de corps : ${sansSchema.map(r => `${r.methode} ${r.re.source}`).join(', ')}`);
  // Toute requête compte, fichiers et flux compris : une page en demande
  // quelques dizaines, une rafale automatique des milliers.
  const debit = new Debit({ max: 1200 });
  const gestionnaire = envelopper(async (req, res) => {
    const url = new URL(req.url, 'http://hub');
    const base = socle.portail.contexte(req, res);
    try {
      if (!debit.prendre(base.ip)) {
        socle.journal.rare(`debit:${base.ip}`, { action: 'limite.atteinte', objet: 'requetes', ip: base.ip, resultat: 'refus' });
        throw new ErreurHttp(429, 'Trop de requêtes.');
      }
      const nonce = nonceCsp();
      entetesSecurite(res, { secure: base.securise, hote: req.headers.host, csp: politiqueContenu({ nonce, secure: base.securise, media: ['blob:'], img: ['blob:'] }), permissions: PERMISSIONS });
      if (await socle.portail.traiter(req, res, url, base)) return;

      const trouve = router.trouver(req.method, url.pathname);
      if (!trouve) {
        // Un fichier caché (.env, .git…) n'est jamais une page : 404, pas l'interface.
        if (METHODES_SURES.has(req.method) && !/^\/(api|hooks)(\/|$)/.test(url.pathname) && !url.pathname.split('/').some(x => x.startsWith('.'))) {
          // Sous /v/<version>/, les fichiers de cette version : gardés un an, l'adresse change à la suivante.
          const { chemin, durable } = cheminVersionne(url.pathname, version);
          const cache = durable ? 'public, max-age=31536000, immutable' : undefined;
          if (chemin.startsWith('/socle/') && servirFichier(req, res, socleWebDir, chemin.slice(6), { nonce, cache: cache || 'public, max-age=3600' })) return;
          // Une adresse sans extension est une page de l'interface : #page côté navigateur.
          const fichier = chemin === '/' || !path.extname(chemin) ? '/index.html' : chemin;
          if (servirFichier(req, res, webDir, fichier, { nonce, gamme: gamme(), disposition: disposition(), version, ...(cache ? { cache } : {}) })) return;
        }
        throw new HttpError(404, 'Introuvable');
      }
      if (trouve.methodes) { res.setHeader('Allow', trouve.methodes.join(', ')); throw new HttpError(405, 'Méthode non admise'); }
      const o = trouve.route.options;
      const ctx = {
        req, res, url, ip: base.ip, cookies: base.cookies, query: Object.fromEntries(url.searchParams), params: trouve.params, socle: base,
        json(status, body) { if (!res.headersSent) repondreJson(res, status, body); },
      };

      // Un jeton d'accès (en-tête Authorization, jamais en cookie) n'ouvre que
      // les routes de sa portée. Sans cookie, aucun navigateur ne l'envoie seul :
      // pas de contrôle anti-CSRF pour lui.
      const porteur = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '')?.[1];
      if (!o.public && porteur) {
        const j = jetons.verifier(porteur);
        if (!j) throw new HttpError(401, 'Jeton refusé');
        if (o.jeton !== j.portee) throw new HttpError(403, `Ce jeton ne sert qu’à sa portée (${j.portee}).`);
        // Un secret en clair ne sort que pour une personne dans son navigateur.
        if (o.devoiler) throw new HttpError(403, 'Dévoiler un secret est réservé à une personne connectée.');
        ctx.jeton = j; ctx.user = `jeton « ${j.nom} »`;
        ctx.vivante = () => !!jetons.verifier(porteur);
      } else if (!o.public) {
        ctx.session = socle.portail.exiger(base, { role: roleExige(o, req.method), renfort: !!o.renfort, devoiler: !!o.devoiler });
        ctx.compte = ctx.session.compteLigne;
        ctx.user = ctx.compte.identifiant;
        ctx.vivante = () => socle.comptes.sessionVivante(base.jeton);
      }
      // Ce qui coûte (IA, voix, lancements) : débit par minute et quota par jour, par compte ou par jeton.
      if (o.quota) quotas.prendre(o.quota.nom, ctx.jeton ? `jeton:${ctx.jeton.id}` : `compte:${ctx.compte.id}`, o.quota);
      // L'adresse : des identifiants dans le chemin, et seulement les paramètres déclarés après « ? ».
      if (Object.values(ctx.params).some(v => !PARAMETRE.test(v))) throw new HttpError(400, 'Adresse invalide.');
      ctx.query = valider(ctx.query, o.requete || {});

      if (!METHODES_SURES.has(req.method)) {
        if (o.raw) {
          ctx.rawBody = await lireBrut(req, o.bodyLimit || 1024 * 1024);
          const type = String(req.headers['content-type'] || '');
          if (ctx.rawBody.length && type.includes('json')) {
            try { ctx.body = JSON.parse(ctx.rawBody.toString('utf8')); } catch { ctx.body = {}; }
          }
          ctx.body ??= {};
        } else ctx.body = valider(await lireCorps(req, { limite: o.bodyLimit || 1024 * 1024 }), o.corps);
      }
      const out = await trouve.route.gestionnaire(ctx);
      // Ce qui vient de changer peut être une connexion : ses liens suivent (liens-hub.js).
      if (ECRITURES.has(req.method)) apresEcriture?.();
      if (!res.headersSent && !o.stream) repondreJson(res, 200, out ?? { ok: true });
    } catch (e) {
      if (res.headersSent) { res.destroy(); return; }
      const status = e.status || 500;
      // Une HttpError du Hub porte un message écrit pour l'utilisateur, même
      // en 5xx (« docker pull a échoué ») ; le socle ne montre jamais le texte
      // d'une erreur imprévue.
      if (e instanceof HttpError) {
        if (status >= 500) log.error(req.method, url.pathname, e.message);
        return repondreJson(res, status, { error: e.message, details: e.details });
      }
      repondreErreur(res, e, { journal: { error: (...a) => log.error(...a), warn: (...a) => log.warn(...a) } });
    }
  });
  return tls ? serveurDouble(gestionnaire, tls) : http.createServer(gestionnaire);
}

// Flux SSE. Revérifié à chaque battement : une session fermée ailleurs (autre
// appareil, « ce n'était pas moi ») coupe aussi le flux, et le flux lui-même ne
// compte pas comme une activité qui garderait la session ouverte.
// pour : ne laisse partir que les événements destinés à cette session.
export function sse(ctx, bus, events, { vivante = () => true, pour = () => true } = {}) {
  ctx.res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  ctx.res.write(': ok\n\n');
  const handlers = events.map(ev => [ev, data => { if (pour(data)) ctx.res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); }]);
  handlers.forEach(([e, h]) => bus.on(e, h));
  const ping = setInterval(() => { if (vivante()) ctx.res.write(': ping\n\n'); else ctx.res.end(); }, 20000);
  const fin = () => { clearInterval(ping); handlers.forEach(([e, h]) => bus.off(e, h)); };
  ctx.req.on('close', fin);
  ctx.res.on('close', fin);
}
