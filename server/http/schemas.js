// Ce que chaque route accepte (SEC-API-001, REQ-WEB-006) : les champs du corps,
// ceux de l'adresse (?…), leurs types et leurs bornes. Un champ inconnu est
// refusé, ce qui ferme aussi l'affectation de masse. Une route qui écrit sans
// schéma empêche le Hub de démarrer (server.js) : rien n'est ouvert par oubli.
import { GAMMES, MODES_THEME, DISPOSITIONS } from '../theme.js';

const TXT = (max = 200, o = {}) => ({ type: 'chaine', max, ...o });
const REQ = s => ({ ...s, requis: true });
const ID = { type: 'chaine', max: 128, motif: /^[\p{L}\p{N}_.:@~-]+$/u };
const OUI = { type: 'booleen' };
const ENT = (min, max) => ({ type: 'entier', min, max });
const JSONV = (profondeur = 8) => ({ type: 'json', profondeur });
const LISTE = (de, max = 100) => ({ type: 'liste', de, max });
const VIDE = {};
const URL_ = TXT(2048);

// Un graphe de workflow : nœuds, liens, paramètres imbriqués (corps JSON d'une requête).
const GRAPHE = JSONV(16);
const CONNEXION_IA = { kind: REQ(TXT(40)), name: TXT(40), instanceId: ID, url: URL_, cleRef: TXT(100), apiKey: TXT(4096), model: TXT(200), embedModel: TXT(200), roles: LISTE(TXT(20), 5) };

// Une route de Relay : ses contrôles fins (nom, cible) sont faits par Relay.
const MODES_ROUTE = ['local', 'public', 'clair', 'cloudflare'];
const ROUTE_MODIF = { hote: TXT(253), cible: TXT(300), mode: TXT(10, { parmi: ['local', 'public', 'clair'] }), cf: OUI, verifier: OUI, enteteHote: TXT(260), actif: OUI, nom: TXT(60) };
const ROUTE = { ...ROUTE_MODIF, hote: REQ(TXT(253)), cible: REQ(TXT(300)) };

export const SCHEMAS = {
  'POST /api/accounts/:id/stepup': { corps: VIDE },
  'POST /api/accounts/:id/lock': { corps: VIDE },
  'POST /api/accounts/:id': { corps: { username: REQ(TXT(64)), password: TXT(1024), role: TXT(40), adresse: URL_, email: TXT(254), envoyer: OUI } },
  'POST /api/accounts/:id/:uid/reset': { corps: { adresse: URL_, envoyer: OUI } },
  'PATCH /api/accounts/:id/:uid': { corps: { role: TXT(40), username: TXT(64), email: TXT(254), cleExigee: OUI, actif: OUI } },
  'POST /api/accounts/:id/:uid/password': { corps: { password: REQ(TXT(1024)) } },
  'POST /api/accounts/:id/:uid/mfa': { corps: VIDE },
  'DELETE /api/accounts/:id/:uid': { corps: VIDE },

  'POST /api/catalog/refresh': { corps: { auto: OUI } },
  'PUT /api/catalog/sources': { corps: { sources: REQ(LISTE(TXT(300), 50)) } },
  'POST /api/catalog/import': { corps: { manifest: REQ(JSONV(24)) } },
  'PUT /api/catalog/registres/auto': { corps: { source: REQ(TXT(300)), auto: REQ(OUI) } },
  'POST /api/catalog/depots/adapter': { corps: { repo: REQ(TXT(141, { motif: /^[\w.-]{1,39}\/[\w.-]{1,100}$/ })) } },
  // kind et ref : envoyés par les pages déjà ouvertes avant la 0.9.12 ; sans effet avant l'installation.
  'POST /api/catalog/:extId/options': { corps: { key: REQ(TXT(100)), kind: TXT(10, { parmi: ['trigger', 'action', 'config'] }), ref: TXT(100) } },
  'POST /api/catalog/:id/test-remote': { corps: { url: REQ(URL_) } },

  'PUT /api/exposition': { corps: { global: TXT(20), machine: TXT(253), parService: JSONV(1) } },

  'POST /api/instances': { corps: { extId: REQ(ID), name: TXT(40), mode: TXT(10, { parmi: ['remote', 'compose'] }), url: URL_, config: JSONV(4), acceptPermissions: OUI } },
  'PATCH /api/instances/:id': { corps: { url: URL_, config: JSONV(4) } },
  'PUT /api/instances/:id/ia': { corps: { config: REQ(JSONV(2)) } },
  'POST /api/ai/outils/:outil/connexion': { corps: VIDE },
  'POST /api/ai/outils/:outil/connexion/code': { corps: { code: REQ(TXT(2000)) } },
  'POST /api/instances/:id/manifest': { corps: VIDE },
  'POST /api/instances/:id/autos': { corps: VIDE },
  'POST /api/instances/:id/update': { corps: VIDE },
  'POST /api/instances/:id/redeploy': { corps: VIDE },
  'DELETE /api/instances/:id': { corps: VIDE, requete: { volumes: TXT(1, { parmi: ['0', '1'] }) } },
  'POST /api/instances/:id/check': { corps: VIDE },
  'GET /api/instances/:id/logs': { requete: { tail: ENT(1, 2000) } },
  'POST /api/instances/:id/options': { corps: { kind: TXT(10, { parmi: ['trigger', 'action', 'config'] }), ref: TXT(100), key: REQ(TXT(100)) } },
  'POST /api/instances/:id/actions/:action': { corps: { params: JSONV(8), confirm: OUI } },

  'GET /api/mesures': { requete: { periode: TXT(3, { parmi: ['24h', '7j', '30j'] }) } },

  'GET /api/probes/:instance/:probe': { requete: { hours: ENT(1, 24 * 90), labels: TXT(300) } },
  'POST /api/probes/:instance/:probe/read': { corps: VIDE },

  'POST /api/workflows/dossiers': { corps: { chemin: REQ(TXT(200)) } },
  'PATCH /api/workflows/dossiers': { corps: { de: REQ(TXT(200)), vers: REQ(TXT(200)) } },
  'POST /api/workflows/dossiers/supprimer': { corps: { chemin: REQ(TXT(200)) } },
  'POST /api/workflows/ranger': { corps: { affectations: REQ(LISTE({ type: 'objet', champs: { id: ID, workflow: TXT(80), dossier: TXT(200) } }, 300)) } },
  'POST /api/workflows': { corps: { name: TXT(80), graph: GRAPHE, import: JSONV(18) } },
  'PUT /api/workflows/:id': { corps: { name: TXT(80), graph: GRAPHE } },
  'DELETE /api/workflows/:id': { corps: VIDE },
  'POST /api/workflows/:id/enable': { corps: { enabled: OUI } },
  'POST /api/workflows/:id/reparer/noms': { corps: VIDE },
  'POST /api/workflows/:id/webhooks/:node/secret': { corps: VIDE },
  'POST /api/workflows/:id/restore': { corps: { version: REQ(ENT(1, 1e9)) } },
  'POST /api/workflows/:id/run': { corps: { nodeId: TXT(100), data: JSONV(12), live: OUI } },
  'POST /api/executions/:id/replay': { corps: { nodeId: REQ(TXT(100)) } },
  'POST /api/approvals/:id': { corps: { approved: REQ(OUI) } },

  'POST /api/ai': { corps: CONNEXION_IA },
  'PUT /api/ai/:id': { corps: CONNEXION_IA },
  'DELETE /api/ai/:id': { corps: VIDE },
  'POST /api/ai/order': { corps: { ids: REQ(LISTE(ID, 100)) } },
  'POST /api/ai/:id/test': { corps: VIDE },
  'POST /api/ai/modeles': { corps: { kind: REQ(TXT(40)), url: URL_, instanceId: ID, id: ID, cleRef: TXT(100), apiKey: TXT(4096) } },

  'PUT /api/destinations': { corps: { destinations: REQ(LISTE(TXT(260), 200)) } },
  'PUT /api/coupure': { corps: { ia: OUI, workflows: OUI } },
  'PUT /api/fuseau': { corps: { fuseau: REQ(TXT(64)) } },
  'PUT /api/alertes': { corps: { canal: TXT(120), types: { type: 'objet', champs: { maj: OUI, workflow: OUI, ia: OUI, service: OUI } } } },
  'POST /api/alertes/essai': { corps: VIDE },
  'PUT /api/connexions/cloudflare': { corps: { jeton: REQ(TXT(200, { motif: /^[A-Za-z0-9_-]{20,200}$/ })) } },
  'DELETE /api/connexions/cloudflare': { corps: VIDE },
  'PUT /api/connexions/tunnel': { corps: { tunnel: TXT(36, { motif: /^[0-9a-f-]{36}$/ }), nom: TXT(60, { motif: /^[A-Za-z0-9][\w.-]{0,59}$/ }) } },
  'DELETE /api/connexions/tunnel': { corps: VIDE },
  'POST /api/connexions/tunnel/tout': { corps: VIDE },
  'PUT /api/connexions/domaines': { corps: { domaines: REQ(LISTE(TXT(253), 20)) } },
  'POST /api/connexions/routes': { corps: ROUTE },
  'PATCH /api/connexions/routes/:id': { corps: ROUTE_MODIF },
  'DELETE /api/connexions/routes/:id': { corps: VIDE },
  'PUT /api/connexions/services/:id': { corps: { sousDomaine: TXT(63, { motif: /^[a-z0-9][a-z0-9-]{0,62}$/ }), hote: TXT(253), mode: TXT(12, { parmi: MODES_ROUTE }) } },
  'DELETE /api/connexions/services/:id': { corps: VIDE },
  'PUT /api/connexions/hub': { corps: { sousDomaine: TXT(63, { motif: /^[a-z0-9][a-z0-9-]{0,62}$/ }), hote: TXT(253), mode: TXT(12, { parmi: MODES_ROUTE }) } },
  'DELETE /api/connexions/hub': { corps: VIDE },
  'POST /api/connexions/appliquer': { corps: VIDE },
  'PUT /api/courriel': { corps: { defaut: TXT(254), relais: JSONV(1) } },
  'PUT /api/theme': { corps: { mode: REQ(TXT(10, { parmi: MODES_THEME })), commun: REQ(TXT(20, { parmi: GAMMES })), parService: JSONV(1), disposition: TXT(10, { parmi: DISPOSITIONS }), dispositionParService: JSONV(1) } },
  'PUT /api/ai-autonomy': { corps: { value: REQ(TXT(20, { parmi: ['conseil', 'validation', 'autonome'] })) } },

  'POST /api/agent/nouvelle': { corps: VIDE },
  'POST /api/agent/ask': { corps: { text: REQ(TXT(20000)), voix: OUI } },
  'POST /api/voix/dire': { corps: { text: REQ(TXT(5000)) } },
  'POST /api/agent/stop': { corps: VIDE },
  'POST /api/agent/ecoute/stop': { corps: VIDE },
  'POST /api/agent/cerveau/plus-tard': { corps: { jamais: OUI } },
  'POST /api/agent/:id/execute': { corps: { only: LISTE(ENT(0, 1000), 100) } },
  'POST /api/agent/:id/reject': { corps: VIDE },
  'POST /api/agent/:id/corriger': { corps: { correction: REQ(TXT(4000)) } },

  'POST /api/jetons': { corps: { nom: REQ(TXT(40)), portee: TXT(20) } },
  'DELETE /api/jetons/:id': { corps: VIDE },

  'POST /api/secrets/test': { corps: { service: REQ(TXT(100)), message: TXT(1000) } },
  'POST /api/secrets/telegram/chats': { corps: { service: TXT(100), token: TXT(200) } },
  'POST /api/secrets/elevenlabs/voix': { corps: { service: TXT(100), token: TXT(500) } },
  'POST /api/secrets': { corps: { service: TXT(100), nom: TXT(60), compte: TXT(40), site: TXT(300), champs: JSONV(1) } },
  'DELETE /api/secrets/:service': { corps: VIDE },
  // ?d= : le domaine, qui change l'adresse de l'image quand le site d'une clé change.
  'GET /api/secrets/logo/:id': { requete: { d: TXT(253) } },

  'PUT /api/variables/:key': { corps: { value: TXT(10000), secret: OUI } },
  'DELETE /api/variables/:key': { corps: VIDE },
  'GET /api/audit': { requete: { limit: ENT(1, 1000), before: ENT(1, Number.MAX_SAFE_INTEGER) } },
};

/**
 * Le routeur, avec le schéma de chaque route posé dans ses options. Toute
 * entrée de la table doit trouver sa route : un schéma orphelin dirait qu'une
 * route est protégée alors qu'elle a changé de nom.
 */
export function avecSchemas(routeur, table = SCHEMAS) {
  const vus = new Set();
  const poser = methode => (motif, gestionnaire, options = {}) => {
    const cle = `${methode} ${motif}`;
    if (table[cle]) vus.add(cle);
    // motif : la route telle qu'écrite (/api/instances/:id), pour l'assistant (acces-hub.js).
    return routeur.ajouter(methode, motif, gestionnaire, { ...options, ...table[cle], motif });
  };
  return {
    get: poser('GET'), post: poser('POST'), put: poser('PUT'), patch: poser('PATCH'), del: poser('DELETE'),
    verifier() {
      const orphelins = Object.keys(table).filter(k => !vus.has(k));
      if (orphelins.length) throw new Error(`Schémas sans route : ${orphelins.join(', ')}`);
    },
  };
}
