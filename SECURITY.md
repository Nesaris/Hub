# Security compliance — Hub

Standard: Project Baseline Requirements & Security Manual, Edition 2.0 (258 controls)
Audited: 2026-09-29   ·   Owner: Codex64   ·   Status: NON-COMPLIANT

## Summary
| Part | Controls | Pass | Fail | N/A | Unknown |
|---|---|---|---|---|---|
| I — Baseline requirements | 68 | 53 | 14 | 1 | 0 |
| II — Security controls | 190 | 108 | 27 | 55 | 0 |
| Total | 258 | 161 | 41 | 56 | 0 |

## Authentication posture
Comptes et sessions viennent du socle commun, embarqué et essayé avec le Hub. Quatre facteurs cumulables sur chaque compte : mot de passe (Argon2id, 64 Mio, 3 passes, parallélisme 4, plancher 19 Mio / 2 / 1, rehachage transparent, empreintes scrypt du Hub 0.5 reprises puis rehachées à la connexion, liste de fuites locale, 12 à 1024 caractères), application TOTP (RFC 6238, secret généré côté serveur et scellé AES-256-GCM, QR code dessiné dans le navigateur, rejeu refusé), clés d'accès WebAuthn (résidentes, vérification de l'utilisateur exigée, jusqu'à vingt, nommées et révocables) et dix codes de secours de 100 bits hachés. Politique par facteur : mot de passe et TOTP facultatifs, clé requise pour les administrateurs, qui tiennent deux facteurs dont une clé. Un mot de passe seul n'ouvre qu'une session d'inscription. Sessions serveur (jeton de 256 bits, empreinte seule en base), renouvelées à chaque changement de niveau, 12 heures au plus et 60 minutes d'inactivité, listées et révocables une à une ou toutes. Renfort de cinq minutes avec le facteur le plus fort avant tout changement de facteur, de rôle, de politique, de clé d'API, de destination autorisée, avant une suppression ou un export. Limiteur persistant par adresse et par compte, preuve de travail après trois échecs, paliers de verrouillage. Programmes : jetons d'accès `hubj_` de 256 bits, montrés une fois, gardés en SHA-256, portée fermée « assistant » (questions seulement, jamais d'exécution), révocables, débit et quota du jour propres. Rôles : lecture, membre, administrateur ; l'essai de balayage passe chaque route sans session, en lecture et en membre. Webhooks entrants : preuve HMAC du corps brut ou jeton obligatoire, secret de 192 bits scellé au repos, montré une seule fois à sa création, remplaçable depuis l'éditeur. Clés maîtresses (HUB_CLE, SOCLE_CLE) et poivre tournables sans réinscription ; coupure d'urgence de l'IA et des workflows.


Suivi du 2026-10-19 (0.11.0 → 0.12.1) : relecture de ce qui s'est ajouté depuis l'audit — dévoilement d'une clé enregistrée (socle `4659e87`, Clés & API), connexion des outils d'abonnement pilotée depuis la page IA, conteneur `hub-outils-ia` et son pont, passerelle IA des services, journal. Constats et correctifs, chacun avec son essai :

| # | Gravité | Contrôles | Constat | Commits |
|---|---|---|---|---|
| S1 | CRITICAL | SEC-AUTHZ-002, SEC-LLM-001, SEC-INFRA-003 | Le pont des outils d'abonnement écoutait sur `hub_net`, le réseau partagé avec chaque service installé, sans aucune authentification : n'importe quel conteneur de service pouvait se servir de l'abonnement Claude ou ChatGPT, lancer une connexion, et prendre le jeton de Claude Code pendant qu'une connexion était en cours. Le pont vit désormais sur un réseau à part (`hub_outils`, le Hub seul), exige le jeton partagé du Hub (secret Docker, comparé en temps constant), et refuse tout quand aucun jeton n'est configuré. | 1417b06 |
| S2 | HIGH | SEC-LLM-005, SEC-LLM-006 | Claude Code était lancé avec ses outils : un texte venu d'un service pouvait lui faire lire un fichier du conteneur, dont ses propres jetons. Il est lancé sans ses outils (`--disallowedTools`), en un tour ; et les outils par abonnement sont fermés aux services par la passerelle, sauf à ceux que `HUB_IA_SERVICES_OUTILS` nomme. | 1417b06, ad7fd92 |
| S3 | HIGH | SEC-LLM-005, SEC-AUTHZ-002 | La passerelle IA des services relayait toute l'API d'Ollama : un service pouvait tirer, pousser (vers un registre extérieur), créer, copier ou supprimer les modèles du Hub. Seules les lectures `ps` et `show` passent ; le reste répond 403. | e7f2d19 |
| S4 | MEDIUM | SEC-LLM-002, REQ-WEB-008 | Aucun débit ni quota par service sur la passerelle : un seul service pouvait épuiser le plafond du jour de tous. 60 appels par minute et 1 000 par jour et par service par défaut (`HUB_IA_SERVICE_APPELS_MINUTE`, `HUB_IA_SERVICE_APPELS_JOUR`), en base. | e7f2d19 |
| S5 | LOW | SEC-BE-002 | Réception d'une requête sans délai sur la passerelle. Bornée à deux minutes (la réponse en flux, elle, n'est pas bornée). | e7f2d19 |

Relu sans constat : le dévoilement (vérification faite exprès, deux minutes, jamais pour le Hub délégué ni l'assistant, chaque lecture au journal), la connexion pilotée (administrateur, journalisée, jeton de Claude Code rendu une seule fois et rangé dans Clés & API), le journal. Essais : 211 (Hub et socle embarqué), tous verts, dont ceux du pont (jeton exigé, refus sans jeton, outils coupés) et de la passerelle (lectures seules, débit par service, outils fermés aux services). Action humaine nouvelle : H17.

Suivi du 2026-10-20 (0.12.1 → 0.13.0) : remplacement d'une extension renommée (`replaces` du manifeste). Le changement donne à une extension les données, la clé maîtresse et les noms publiés d'un service installé depuis une autre : c'est une prise de contrôle s'il est mal borné. Bornes posées et essayées (`test/remplacement.test.js`) :

| # | Gravité | Contrôles | Point | Où |
|---|---|---|---|---|
| R1 | HIGH | SEC-AUTHZ-002, SEC-INJ-005 | Un remplaçant n'est retenu que s'il vient du même registre que l'extension remplacée, jamais d'un manifeste importé ni de lui-même : un autre registre ne peut pas déclarer `replaces` sur un service qui n'est pas à lui et en recevoir les données à la prochaine mise à jour. | server/registry.js (`remplacantDe`) |
| R2 | HIGH | SEC-INFRA-003 | Un remplaçant qui demande une permission sensible de plus (réseau de la machine, capacité noyau, Docker) est refusé : il s'installe à part, où la permission se valide. | server/services.js (`remplacer`) |
| R3 | MEDIUM | SEC-INFRA-004 | La copie des volumes tourne dans un conteneur jetable : sans réseau, système en lecture seule, original monté en lecture seule, `no-new-privileges`, trois capacités seulement (CHOWN, DAC_OVERRIDE, FOWNER), supprimé après usage. | server/docker.js (`copierVolume`) |
| R4 | MEDIUM | REQ-DATA-003, SEC-DB-010 | Rien ne s'arrête avant que tout ce qui peut empêcher le changement soit vérifié (volume de destination déjà là, Relay muet, permissions) ; l'ancien volume n'est jamais modifié ni supprimé ; un échec retire la nouvelle pile et ses copies, rend la ligne, les routes et l'ancienne pile, et le dit. | server/services.js (`remplacer`, `defaireRemplacement`) |

Chaque remplacement, réussi ou défait, entre au journal (REQ-DATA-004) (`service.remplacement`, `service.remplacé`, `service.remplacement_annulé`). Essais : 217, tous verts.

Suivi du 2026-10-23 (0.13.0 → 0.14.0) : gamme Lavande et page Thème en deux onglets. Un service ne reçoit jamais une gamme que son socle refuserait au démarrage : `{{hub.theme}}` rend SOMA ou Console, `{{hub.gamme}}` y ajoute Exploitation, `{{hub.apparence}}` rend toutes les gammes ; ce qu'un service ne connaît pas lui arrive en SOMA (`server/theme.js:36`), relevé au déploiement d'après son Compose. La route d'écriture reste réservée à l'administrateur, gammes et services validés contre des listes fermées (`server/http/api.js:249`), chaque changement au journal (`apparence.modifiée`). Socle embarqué `10c7ba2` (polices Poppins servies par le Hub, aucune requête vers un tiers). Aucun contrôle ne change de statut. Essais : 217 du Hub, 77 du socle ; page Thème contrôlée dans Chromium à 1280 et 390 pixels (huit écrans, 0 défaut), Hub en Lavande clair et sombre (neuf écrans, 0 défaut).

Suivi du 2026-10-23 (0.14.0 → 0.14.1) : page Thème, constat d'usage — un thème global choisi dans un onglet sans être appliqué partait avec le choix fait ensuite dans l'onglet « Par service », sans que la barre le dise. La barre d'application énumère désormais chaque changement envoyé (thème global avant → après, puis chaque service), et l'onglet « Par service » signale un thème global choisi mais pas encore appliqué. Interface seulement : aucune route, aucun contrôle ne change. Essais : 217 du Hub ; page contrôlée dans Chromium (choix global en attente visible depuis « Par service »).

## Control status
| ID | Severity | Status | Evidence | Notes |
|---|---|---|---|---|
| REQ-AUTH-001 | CRITICAL | PASS | `socle/src/comptes.js:24` ; mot de passe, TOTP, clés et codes de secours cumulables : essai `socle/test/parcours.test.js:135` | socle embarqué, ses essais rejoués par le Hub ; QR code du TOTP dessiné dans le navigateur (`socle/web/qr.js:240`) |
| REQ-AUTH-002 | CRITICAL | PASS | `socle/src/comptes.js:27` ; `socle/src/index.js:49` ; réglable sans déploiement : `socle/src/portail.js:372` | défaut : mot de passe et TOTP facultatifs, clé requise pour les administrateurs |
| REQ-AUTH-003 | CRITICAL | PASS | `socle/src/webauthn.js:26` ; vingt clés nommées : `socle/src/comptes.js:38` ; renommer et retirer : `socle/src/portail.js:293` | liste avec dates de création et d’usage dans Compte → Sécurité |
| REQ-AUTH-004 | CRITICAL | PASS | `socle/src/webauthn.js:46` ; origine `socle/src/webauthn.js:47` ; rpIdHash `socle/src/webauthn.js:103` | défi à usage unique lié à la session, UP et UV exigés, signature et compteur vérifiés |
| REQ-AUTH-005 | CRITICAL | PASS | `socle/src/comptes.js:696` ; renfort et fermeture des autres sessions : `socle/src/comptes.js:712` | la notification part à l’adresse vérifiée quand un relais existe (REQ-AUTH-014) |
| REQ-AUTH-006 | CRITICAL | PASS | `socle/src/comptes.js:901` ; jeton de 20 minutes, haché, unique : `socle/src/comptes.js:36` | essai `socle/test/parcours.test.js:218` |
| REQ-AUTH-007 | HIGH | PASS | `socle/src/comptes.js:39` ; 100 bits, haché Argon2id, usage unique : `socle/src/comptes.js:496` | alerte « secours.utilise » |
| REQ-AUTH-008 | HIGH | PASS | `socle/src/totp.js:35` ; rejeu refusé : `socle/src/comptes.js:588` | RFC 6238, 6 chiffres, 30 s, ±1 pas, secret scellé AES-256-GCM |
| REQ-AUTH-009 | CRITICAL | PASS | aucune voie SMS ni code par courriel : `grep -rniE "sms\|twilio" socle/src server/http server/auth` → 0 ligne (Twilio n’existe que comme fiche de clé d’un service tiers, `server/secrets.js:87`) ; connexions : `socle/src/comptes.js:429`, `socle/src/comptes.js:477` | un mot de passe seul n’ouvre qu’une session d’inscription |
| REQ-AUTH-010 | CRITICAL | PASS | `socle/src/limiteur.js:20` (SQLite, par adresse et par compte, paliers, preuve de travail) | annexe B.4 : 401 trois fois, puis 428 (preuve de travail exigée) ; essai `socle/test/parcours.test.js:156` |
| REQ-AUTH-011 | HIGH | PASS | vérification leurre : `socle/src/argon.js:110` ; message unique « Identifiant ou mot de passe incorrect. » | essai `socle/test/parcours.test.js:81` |
| REQ-AUTH-012 | HIGH | PASS | `socle/src/comptes.js:940` ; `socle/src/comptes.js:949` | l’adresse ne sert qu’aux alertes ; pas d’inscription libre, invitation seulement |
| REQ-AUTH-013 | HIGH | PASS | `socle/src/comptes.js:782` | essai `test/hub.test.js:95` |
| REQ-AUTH-014 | MEDIUM | FAIL | `socle/src/notifications.js:78` ; « ce n’était pas moi » : `socle/src/comptes.js:927` | implémenté et essayé (`socle/test/courriel.test.js:63` par courriel») ; ne part que si un relais SMTP est posé → action H2 |
| REQ-CRYPT-001 | CRITICAL | PASS | `socle/src/argon.js:15` ; 64 Mio, t=3, p=4 par défaut : `socle/src/index.js:42` | les essais tournent désormais aux paramètres de production (`socle/test/banc.js:20`) |
| REQ-CRYPT-002 | HIGH | PASS | `socle/src/argon.js:72` ; `socle/src/argon.js:129` | les empreintes scrypt du Hub 0.5 sont reprises (`server/migration-socle.js:12`) puis rehachées à la connexion : essai `test/unit.test.js:1422` |
| REQ-CRYPT-003 | MEDIUM | N/A | bcrypt absent : `grep -rni bcrypt socle/src server` → 0 ligne ; Argon2id seul |  |
| REQ-CRYPT-004 | HIGH | PASS | `socle/src/motdepasse.js:12`, `socle/src/motdepasse.js:13`, liste locale `socle/src/motdepasse.js:18` | aussi pour les comptes des services créés par le Hub : `server/accounts.js:123` |
| REQ-CRYPT-005 | HIGH | PASS | `socle/src/outils.js:16` ; identifiants du Hub : `server/util/common.js:13` ; secrets de webhook : `server/triggers.js:14` ; comparaison : `server/util/common.js:33` | annexe B.3 : Math.random seulement pour des délais, des identifiants d’affichage et une animation (NO-VIBE.md) |
| REQ-CRYPT-006 | MEDIUM | PASS | sessions : `socle/src/comptes.js:264` ; jetons d’accès du Hub : `server/auth/jetons.js:13` | essai `socle/test/courriel.test.js:108` |
| REQ-SESS-001 | CRITICAL | PASS | `socle/src/http.js:103` ; __Host- en HTTPS : `socle/src/portail.js:44` | aucune session dans le stockage du navigateur |
| REQ-SESS-002 | CRITICAL | PASS | `socle/src/comptes.js:274` | sessions serveur, pas de jeton de rafraîchissement |
| REQ-SESS-003 | HIGH | PASS | `socle/src/comptes.js:310` ; `socle/src/portail.js:385` | page Compte → Sécurité |
| REQ-SESS-004 | HIGH | PASS | `socle/src/comptes.js:714` | le flux d’événements d’une session fermée se coupe aussi : `server/http/server.js:131` |
| REQ-SESS-005 | HIGH | PASS | `socle/src/comptes.js:326` ; route du Hub sous renfort : `server/http/api.js:274` | comptes des services : `server/accounts.js:42` |
| REQ-SESS-006 | MEDIUM | PASS | `socle/src/index.js:40` (12 h, 60 min d’inactivité) | pas de JWT |
| REQ-ANON-001 | CRITICAL | PASS | `git log --all --format="%an <%ae>" \| sort -u` et `--format="%cn <%ce>"` → une ligne chacun, le pseudonyme | identité posée dans le dépôt avant son premier commit |
| REQ-ANON-002 | CRITICAL | FAIL | arbre : annexe B.1 → valeurs d’exemple et vecteurs d’essai seulement (lab.local, plages RFC 1918 du classement anti-SSRF, chemins d’API /api/users/) ; historique : le premier commit porte encore les termes retirés | historique local, jamais publié : partir de la racine propre fournie → action H12 |
| REQ-ANON-003 | CRITICAL | FAIL | liste hors dépôt, jamais committée ; contrôle CI par secret : `.github/workflows/verification.yml:86` | crochet global sur le poste et secret du dépôt : action H4 |
| REQ-ANON-004 | CRITICAL | FAIL | messages : `git log --all --format=%B \| grep -inE "co-authored-by\|generated (by\|with)\|as an ai"` → 0 ; fichiers de consignes d’outil retirés de l’arbre | ils restent dans le premier commit local : même décision que REQ-ANON-002 (H12) |
| REQ-ANON-005 | HIGH | PASS | `package.json:6` sans champ auteur ; `LICENSE:3` | README et package.json décrivent le logiciel, jamais une machine ni une personne |
| REQ-ANON-006 | HIGH | PASS | `git ls-files "*.png" "*.jpg" "*.jpeg" "*.pdf" "*.mp4" "*.gif" "*.webp" "*.ico"` → 0 fichier | captures gardées hors dépôt ; logos téléchargés réécrits sans métadonnées (`server/image.js:123`) |
| REQ-ANON-007 | HIGH | PASS | comptes « ana », « bruno », « chloe », adresses de la plage de documentation 192.0.2.0/24, domaines d’exemple | la vitrine sème des valeurs de démonstration (`outils/vitrine.mjs:39`) |
| REQ-ANON-008 | MEDIUM | PASS | `git log --all --format=%aI \| grep -v "+00:00$" \| wc -l` → 0 ; idem pour %cI | tous les commits en UTC |
| REQ-ANON-009 | MEDIUM | FAIL | pages d’erreur sans chemin : `socle/src/http.js:163` ; aucun domaine dans le dépôt | domaine éventuel, WHOIS : action H13 |
| REQ-ANON-010 | MEDIUM | PASS | identité stable et unique, dates réelles (TZ=UTC, jamais antidatées) | dépôt personnel, pas de contribution externe |
| REQ-CFG-001 | CRITICAL | PASS | gitleaks sur tout l’historique → 7 résultats, tous des valeurs d’essai fabriquées (test/hub.test.js, vecteur RFC 6238 de socle/test/crypto.test.js) ; git grep de l’annexe B.2 → valeurs de démonstration et d’essai seulement ; `-----BEGIN … PRIVATE` → 0 | détail dans l’annexe B ci-dessous |
| REQ-CFG-002 | CRITICAL | PASS | les clés entrent et ne ressortent jamais : `server/http/api.js:389` ; paramètres secrets masqués : `server/workflows/store.js:118` ; secret d’un webhook montré une fois, à sa création : `server/triggers.js:134` | le navigateur ne reçoit que « rempli » ou « vide » ; essai `test/hub.test.js:309` |
| REQ-CFG-003 | HIGH | FAIL | VM d’essai et production distinctes (règle de l’exploitant) | clés séparées par environnement : action H6 |
| REQ-CFG-004 | HIGH | PASS | `server/config.js:11` sur `socle/src/config.js:14` | essai `test/unit.test.js:1479` |
| REQ-CFG-005 | HIGH | PASS | inventaire, émetteur et procédure par secret ci-dessous (« Secrets inventory ») ; chaque secret se tourne sans réinscription : HUB_CLE `server/vault.js:95`, SOCLE_CLE `socle/src/comptes.js:109`, poivre `socle/src/argon.js:128`, secrets de webhook `server/triggers.js:142`, jetons `server/cli.js:10` ; exercice de bout en bout : `node outils/exercice-rotation.mjs \| grep -c "^OK "` → 20, sur 20 vérifications (HUB_CLE et SOCLE_CLE tournées sur une instance lancée comme en production, TOTP, clé d’accès, code de secours, webhook et variable secrète toujours valables, clé inconnue refusée) | essais `test/unit.test.js:1363`, `socle/test/rotation.test.js:14` ; les clés des fournisseurs vues pendant le développement restent à brûler : SEC-SECRETS-006, action H5 |
| REQ-CI-001 | CRITICAL | FAIL | `.github/workflows/verification.yml:47` | Actions indisponibles (facturation), crochet local et protection de poussée : actions H3, H4 |
| REQ-CI-002 | HIGH | FAIL | `.github/workflows/verification.yml:110` | bloquant une fois les Actions rétablies et le contrôle requis : action H3 |
| REQ-CI-003 | HIGH | FAIL | aucune dépendance npm, contrôlé : `.github/workflows/verification.yml:37` ; image de base épinglée `Dockerfile:5` ; nomenclature : `.github/workflows/verification.yml:141` | exécution en CI : action H3 |
| REQ-CI-004 | HIGH | FAIL | `.github/workflows/verification.yml:86` | échoue tant que le secret n’existe pas : action H4 |
| REQ-CI-005 | MEDIUM | FAIL | permissions minimales `.github/workflows/verification.yml:16` ; actions épinglées par commit | protection de branche : action H3 |
| REQ-CI-006 | MEDIUM | PASS | `test/hub.test.js:1600` (anonyme → 401, lecture sur écriture → 403, membre sur route d’administrateur → 403, sur chaque route du routeur) ; la liste des routes d’administration écrite dans l’essai, pas relue dans le routeur : `test/hub.test.js:1636` | plus les parcours du socle ; action destructive d’un service refusée à un membre ; cassure volontaire (rôle retiré d’une route) détectée, voir NO-VIBE.md |
| REQ-WEB-001 | CRITICAL | FAIL | HSTS dès que la requête est chiffrée : `socle/src/http.js:86` | le Hub écoute sur 127.0.0.1 ; un relais HTTPS devant reste à poser : action H1 |
| REQ-WEB-002 | HIGH | PASS | `socle/src/http.js:62` ; `curl -sI /` → script-src 'self' 'nonce-…', style-src 'self', object-src 'none', frame-ancestors 'none' | gabarits sans balisage interprété ni style en ligne : 0 violation, 0 erreur console sur 149 écrans × largeurs |
| REQ-WEB-003 | HIGH | PASS | `socle/src/http.js:79` ; no-store sur l’API ; Permissions-Policy : `server/http/server.js:12` | `curl -sI /` : ni Server ni X-Powered-By |
| REQ-WEB-004 | HIGH | PASS | aucun en-tête CORS émis : `curl -sI -H "Origin: https://evil.example" /api/status` → aucun Access-Control-* | API de même origine |
| REQ-WEB-005 | HIGH | PASS | CSRF : `socle/src/portail.js:86` ; SSRF : `server/sortie.js:192` ; redirections : aucune route n’en émet ; webhooks : `server/triggers.js:183` | essais `test/sortie.test.js:31`, `test/hub.test.js:303` |
| REQ-WEB-006 | CRITICAL | PASS | schéma de chaque route : `server/http/schemas.js:19` ; démarrage refusé si une route écrit sans schéma : `server/http/server.js:37` ; rôle à chaque route : `server/http/server.js:27` | essais `test/hub.test.js:115` et balayage des rôles |
| REQ-WEB-007 | HIGH | PASS | requêtes préparées ; annexe B.3 → aucun SQL concaténé ; LIKE échappé `server/workflows/store.js:413` ; processus sans shell `server/docker.js:17` ; aucun eval ni vm `test/unit.test.js:1289` | gabarits DOM : `socle/web/gabarit.js:33` |
| REQ-WEB-008 | MEDIUM | PASS | débit global `server/http/server.js:40` ; corps bornés (1 Mio par défaut) ; listes bornées par schéma ; coût : `server/quotas.js:8`, `server/ai/gateway.js:203` | essai : ?limit=100000 → 400, corps de 2 Mio → 413 |
| REQ-DATA-001 | CRITICAL | PASS | SQLite embarqué, aucun port : `server/db/index.js:12` ; base en 0600, dossier en 0700 : `server/db/index.js:14` | essai `test/unit.test.js:1545` |
| REQ-DATA-002 | HIGH | FAIL | secrets scellés AES-256-GCM : `server/vault.js:53` ; clés maîtresses hors du volume : `compose.yml:17` ; sauvegardes chiffrées | chiffrement du disque de l’hôte : action H7 |
| REQ-DATA-003 | HIGH | FAIL | `server/sauvegarde.js:24` : instantané chiffré pour une clé publique ; restauration vers une base neuve, essayée : `test/unit.test.js:1491` | planification, copie hors hôte et restauration réelle datée : action H8 |
| REQ-DATA-004 | HIGH | PASS | `socle/src/journal.js:10` ; refus et limites journalisés ; journal du Hub chaîné et copié sur la sortie standard : `server/audit.js:19` | secrets masqués : `server/util/common.js:37` |
| REQ-DATA-005 | MEDIUM | PASS | vigie : `socle/src/vigie.js:11` ; plafond de l’IA atteint, tracé : `server/ai/gateway.js:209` ; runbook ci-dessous | exercice du runbook à dater : action H8 |
| REQ-DATA-006 | MEDIUM | PASS | `web/confidentialite.txt:7` ; durées appliquées : `server/retention.js:3` ; export : `socle/src/portail.js:328` | essai `test/unit.test.js:1452` |
| REQ-DATA-007 | MEDIUM | PASS | contenus reçus : audio relayé à VOX sans stockage (12 Mio au plus), manifestes et workflows en JSON validés ; logos : type par les octets, réécrits en PNG, servis en pièce jointe sous « default-src 'none' » (`server/http/api.js:399`) | essai `test/unit.test.js:984` |
| REQ-CODE-001 | HIGH | PASS | essais de référence verts avant et après la passe de qualité ; API publique inchangée par cette passe | voir NO-VIBE.md |
| REQ-CODE-002 | HIGH | PASS | voir NO-VIBE.md, couche des commentaires |  |
| REQ-CODE-003 | HIGH | PASS | voir NO-VIBE.md, couches structurelle et défensive |  |
| REQ-CODE-004 | HIGH | PASS | voir NO-VIBE.md, profil de style du dépôt |  |
| REQ-CODE-005 | MEDIUM | PASS | cinq cassures volontaires (SSRF, signature de webhook, rôle d’une route, coupure d’urgence, rotation de SOCLE_CLE), chacune détectée par au moins un essai : NO-VIBE.md, « Essais » ; une assertion vide retirée | la cassure du rôle n’était pas détectée : essai renforcé dans la même passe |
| REQ-CODE-006 | MEDIUM | PASS | `git log --stat` : un sujet par commit, style du dépôt, aucune mention d’outil |  |
| GOV-001 | HIGH | PASS | ce document : revue datée, périmètre (258 contrôles), résolution ligne par ligne | à refaire à chaque changement généré important |
| GOV-002 | MEDIUM | PASS | section « Inventory » ci-dessous : routes, données, tiers, secrets |  |
| GOV-003 | LOW | FAIL | `socle/src/portail.js:135` ; contact : `server/main.js:53` | essai `test/hub.test.js:132` ; activer le signalement privé sur le dépôt : action H3 |
| GOV-004 | MEDIUM | FAIL | VM d’essai distincte de la production (règle de l’exploitant) ; données d’essai fabriquées | secrets et comptes tiers distincts à confirmer : action H6 |
| GOV-005 | HIGH | FAIL | CI en lecture seule par défaut : `.github/workflows/verification.yml:16` ; rôles admin, membre, lecture dans le Hub | 2FA sur GitHub et consoles des fournisseurs : action H3 |
| SEC-SECRETS-001 | CRITICAL | PASS | voir REQ-CFG-001 | gitleaks en CI (H3) |
| SEC-SECRETS-002 | CRITICAL | PASS | aucune variable publique ; interface servie telle quelle, sans construction : `web/index.html:11` | rien n’est injecté dans le code servi |
| SEC-SECRETS-003 | CRITICAL | PASS | `.gitignore:4` ; annexe B.2, `/.env` sur l’instance locale : 404 ; `server/http/server.js:55` | essai `test/hub.test.js:127` ; `.env.example:41` sans valeur |
| SEC-SECRETS-004 | HIGH | PASS | clés maîtresses en secrets Docker, hors du volume : `compose.yml:24` ; copie du volume retirée : `server/vault.js:29` | essai `test/unit.test.js:1348` ; clés des services dans le coffre du Hub, jamais dans un fichier |
| SEC-SECRETS-005 | HIGH | FAIL | une connexion IA par fournisseur, clés dans Clés & API | clés restreintes et budgétées chez chaque fournisseur : action H6 |
| SEC-SECRETS-006 | HIGH | FAIL | procédure de rotation par secret ci-dessous, sans interruption autre qu’un redémarrage : `server/vault.js:95`, `socle/src/comptes.js:109`, `server/triggers.js:142` | rotation des clés vues pendant le développement : action H5 |
| SEC-SECRETS-007 | HIGH | PASS | clés maîtresses de 32 octets aléatoires : `install.sh:99` ; format vérifié : `server/config.js:16` | aucun repli de secret par défaut, valeurs d’exemple vides |
| SEC-SECRETS-008 | MEDIUM | PASS | `server/config.js:11` ; mode HTTP dégradé affiché en permanence : `socle/web/compte.js:741` | aucun compte de démonstration hors de la vitrine locale (outils/) |
| SEC-AUTH-001 | CRITICAL | PASS | voir REQ-CRYPT-001 |  |
| SEC-AUTH-002 | MEDIUM | PASS | voir REQ-CRYPT-004 |  |
| SEC-AUTH-003 | CRITICAL | PASS | voir REQ-AUTH-010 |  |
| SEC-AUTH-004 | MEDIUM | PASS | voir REQ-AUTH-011 |  |
| SEC-AUTH-005 | CRITICAL | PASS | voir REQ-AUTH-006 ; lien depuis l’adresse publique : `socle/src/portail.js:49` |  |
| SEC-AUTH-006 | MEDIUM | PASS | confirmation sur la nouvelle adresse et avis à l’ancienne : `socle/src/comptes.js:955` | essai `socle/test/courriel.test.js:122` |
| SEC-AUTH-007 | HIGH | PASS | TOTP et clés pour tous, second facteur imposé aux administrateurs : `socle/src/comptes.js:163` | codes de secours toujours émis |
| SEC-AUTH-008 | HIGH | N/A | aucune connexion par fournisseur externe : `grep -rniE "oauth\|openid\|id_token\|redirect_uri" socle/src server` → 0 ligne |  |
| SEC-AUTH-009 | HIGH | PASS | les liens reçus par courriel demandent un geste : `socle/web/compte.js:434` ; uniques et courts : `socle/src/comptes.js:37` | aucune connexion sans mot de passe par courriel |
| SEC-AUTH-010 | CRITICAL | PASS | chaque route passe par `server/http/server.js:82` | essai de balayage des rôles |
| SEC-AUTH-011 | HIGH | PASS | `socle/src/http.js:163` ; session illisible = pas de session : `socle/src/comptes.js:279` | aucun chemin d’exception n’ouvre l’accès |
| SEC-SESS-001 | CRITICAL | PASS | voir REQ-SESS-001 |  |
| SEC-SESS-002 | HIGH | PASS | `grep -rn "localStorage" web socle/web` → thème et préférences d’affichage seulement | aucun jeton dans le navigateur |
| SEC-SESS-003 | HIGH | PASS | 256 bits : `socle/src/comptes.js:259` | renouvelé à chaque changement de niveau |
| SEC-SESS-004 | HIGH | PASS | voir REQ-SESS-003, REQ-SESS-004 et REQ-SESS-006 |  |
| SEC-SESS-005 | CRITICAL | N/A | aucun JWT : `grep -rniE "jwt\|jsonwebtoken\|jose" server web socle` → 0 ligne |  |
| SEC-SESS-006 | MEDIUM | N/A | aucun jeton de rafraîchissement : sessions serveur (voir SEC-SESS-005) |  |
| SEC-SESS-007 | MEDIUM | PASS | voir REQ-SESS-005 | destinations internes, comptes des services, facteurs, rôles |
| SEC-AUTHZ-001 | CRITICAL | PASS | les objets propres à un compte sont filtrés dans la requête : conversations `server/ai/agent.js:1908`, sessions et facteurs dans le socle ; les autres objets (services, workflows, clés) appartiennent à l’installation et se protègent par rôle | essais `test/unit.test.js:446` et balayage des rôles ; objet d’un autre → 404 |
| SEC-AUTHZ-002 | CRITICAL | PASS | rôle lu en base à chaque requête : `server/http/server.js:27` ; routes d’administrateur déclarées : `grep -c "role: 'admin'" server/http/api.js` | balayage : membre sur route d’administrateur → 403 ; action destructive d’un service réservée aux administrateurs |
| SEC-AUTHZ-003 | HIGH | PASS | schémas stricts, champ inconnu refusé : `socle/src/schema.js:69` ; aucun rôle ni propriétaire dans un corps | essai `test/hub.test.js:115` (role:admin refusé) |
| SEC-AUTHZ-004 | HIGH | PASS | route inconnue → 404, chemin sans schéma → pas de démarrage ; seules routes publiques : état, webhooks signés et portail du socle | inventaire ci-dessous |
| SEC-AUTHZ-005 | CRITICAL | N/A | aucune organisation ni espace partagé : une installation, des comptes à rôles (voir SEC-AUTHZ-001) |  |
| SEC-AUTHZ-006 | LOW | PASS | identifiants aléatoires de 72 bits : `server/util/common.js:13` | webhooks : 72 bits d’adresse et secret de 192 bits |
| SEC-AUTHZ-007 | HIGH | PASS | quotas par compte : `server/quotas.js:8` ; plafond global de l’IA : `server/ai/gateway.js:203` ; approbation humaine avant une action destructive : `server/workflows/store.js:238` avant elle» | essai `test/hub.test.js:262` |
| SEC-AUTHZ-008 | MEDIUM | PASS | aucune fonction cachée côté client : chaque bouton appelle une route contrôlée côté serveur ; les boutons d’administrateur sont masqués aux autres, et refusés par le serveur | balayage des rôles |
| SEC-INJ-001 | CRITICAL | PASS | requêtes préparées ; annexe B.3 → 0 SQL concaténé ; fragments SQL constants seulement (`server/audit.js:23`) ; LIKE échappé | essai `test/unit.test.js:1532` ne touche pas « axb »» |
| SEC-INJ-002 | HIGH | N/A | aucun ORM : node:sqlite, requêtes préparées seulement |  |
| SEC-INJ-003 | HIGH | N/A | aucune base documentaire : SQLite seulement |  |
| SEC-INJ-004 | CRITICAL | PASS | `server/docker.js:17` sans shell, arguments en tableau ; environnement réduit : `server/docker.js:10` | essai `test/unit.test.js:1260` |
| SEC-INJ-005 | HIGH | PASS | registre local : `server/registry.js:43` ; fichiers servis par `socle/src/http.js:176` ; logos sous un nom assaini : `server/logos.js:100` | essai `test/registry.test.js:103` |
| SEC-INJ-006 | HIGH | PASS | gabarits {{ … }} : chemin + filtres d’une liste blanche, aucun eval : `server/manifest/template.js:1` ; nœud Script JS retiré | essai `test/unit.test.js:1289` |
| SEC-INJ-007 | HIGH | N/A | aucun analyseur XML : `grep -rniE "xml2js\|sax\|libxml\|fast-xml\|DOMParser" server socle/src` → 0 ligne |  |
| SEC-INJ-008 | HIGH | PASS | JSON seulement ; clés de prototype refusées : `socle/src/schema.js:6` | aucune désérialisation d’objets ni fusion récursive d’un corps |
| SEC-XSS-001 | CRITICAL | PASS | annexe B.3 : `innerHTML` seulement dans `socle/web/gabarit.js:115` — du balisage écrit dans le code, les valeurs posées en nœuds texte ou attributs | essais `socle/test/gabarit.test.js:22` |
| SEC-XSS-002 | HIGH | PASS | réponses de l’assistant rendues en nœuds DOM, sans lien ni HTML : `web/app.js:1202` | gras et code seulement |
| SEC-XSS-003 | HIGH | PASS | aucun eval, setTimeout chaîne ni affectation de location depuis une donnée ; le lien assistant?q= pré-remplit sans envoyer : `web/app.js:104` | adresses d’attributs vérifiées : `socle/web/gabarit.js:132` |
| SEC-XSS-004 | HIGH | PASS | voir REQ-WEB-002 |  |
| SEC-XSS-005 | MEDIUM | PASS | seuls échanges : le module audio de la page (AudioWorklet) et le Worker de preuve de travail, de même origine | aucune écoute de window message, aucune iframe |
| SEC-XSS-006 | MEDIUM | PASS | aucune carte de source servie ; erreurs réduites à un message : `socle/src/http.js:163` | journaux d’un conteneur et journal d’audit réservés aux administrateurs |
| SEC-XSS-007 | MEDIUM | N/A | aucune redirection pilotée par paramètre : `grep -rnE "searchParams.get\(.(next\|redirect)\|location\.href *=" server web socle` → 0 ligne |  |
| SEC-XSS-008 | MEDIUM | PASS | aucun script tiers : tout est servi par le Hub (web/, socle/web/) | CSP script-src 'self' et nonce |
| SEC-HDR-001 | HIGH | FAIL | voir REQ-WEB-001 | action H1 |
| SEC-HDR-002 | HIGH | PASS | voir REQ-WEB-002 |  |
| SEC-HDR-003 | MEDIUM | PASS | `socle/src/http.js:79` ; Referrer-Policy no-referrer ; X-Frame-Options DENY ; `server/http/server.js:12` | micro permis à la page seule (dictée vocale) |
| SEC-HDR-004 | LOW | PASS | `curl -sI /` : ni Server ni X-Powered-By |  |
| SEC-HDR-005 | MEDIUM | PASS | no-store sur l’API et les pages : `socle/src/http.js:148` | fichiers du socle en cache public d’une heure ; logos en cache privé |
| SEC-HDR-006 | CRITICAL | PASS | voir REQ-WEB-004 |  |
| SEC-HDR-007 | HIGH | PASS | voir REQ-SESS-001 |  |
| SEC-CSRF-001 | HIGH | PASS | SameSite=Strict + origine + jeton : `socle/src/portail.js:86` | essai `test/hub.test.js:95` |
| SEC-CSRF-002 | MEDIUM | PASS | `socle/src/http.js:120` | 415 sur tout autre type |
| SEC-CSRF-003 | MEDIUM | PASS | aucune écriture sur GET : balayage des routes (GET permis à la lecture seule, sans effet) | lecture de sondes et essais sont des POST |
| SEC-CSRF-004 | CRITICAL | PASS | `server/sortie.js:192` : http(s) seulement, adresse résolue puis épinglée (`server/sortie.js:159`), métadonnées et lien local toujours refusés, réseau privé sur liste (`server/destinations.js:11`), redirections revérifiées, délai et taille bornés | essais `test/sortie.test.js:57` et `test/hub.test.js:1569` |
| SEC-CSRF-005 | HIGH | PASS | entrants : HMAC du corps brut ou jeton, jamais sans preuve `server/triggers.js:172` ; sortants : par l’enveloppe anti-SSRF | essai `test/unit.test.js:1292` |
| SEC-CSRF-006 | MEDIUM | N/A | aucune redirection : voir SEC-XSS-007 |  |
| SEC-API-001 | HIGH | PASS | voir REQ-WEB-006 |  |
| SEC-API-002 | HIGH | PASS | global par adresse : `server/http/server.js:40` ; par compte sur ce qui coûte : `server/http/api.js:40` ; connexion : limiteur du socle | essai `test/unit.test.js:1304` |
| SEC-API-003 | MEDIUM | PASS | listes bornées par schéma : `server/http/schemas.js:104` ; historique des sondes borné : `server/http/api.js:224` ; exécutions : 200 par workflow |  |
| SEC-API-004 | HIGH | PASS | vues publiques sans secrets : `server/services.js:329` ; paramètres secrets masqués ; sorties d’exécution masquées : `server/workflows/engine.js:203` | journal du Hub réservé aux administrateurs, retiré de la vue d’ensemble pour les autres |
| SEC-API-005 | MEDIUM | PASS | 405 avec Allow : `server/http/server.js:64` ; TRACE et OPTIONS → 405 ; aucune page de documentation d’API |  |
| SEC-API-006 | HIGH | N/A | aucun GraphQL : `grep -rniE "graphql\|apollo" server web socle` → 0 ligne |  |
| SEC-API-007 | MEDIUM | PASS | un seul formateur d’erreurs : `socle/src/http.js:157` ; transactions pour les écritures multiples : `server/db/index.js:32` |  |
| SEC-API-008 | MEDIUM | PASS | webhooks dédoublonnés par identifiant de livraison, posé avant l’effet : `server/triggers.js:188` ; un plan de l’assistant ne s’exécute qu’une fois : `server/ai/agent.js:1777` | essai `test/hub.test.js:303` ; aucune opération monétaire |
| SEC-API-009 | HIGH | PASS | pas de RPC : chaque route HTTP vérifie session, rôle et schéma (voir SEC-AUTH-010) |  |
| SEC-API-010 | MEDIUM | PASS | `socle/src/http.js:126` ; 1 Mio par défaut, 2 Mio pour un manifeste, 12 Mio pour l’audio | essai : corps de 2 Mio → 413 |
| SEC-DB-001 | CRITICAL | PASS | voir REQ-DATA-001 |  |
| SEC-DB-002 | HIGH | N/A | SQLite embarqué sans rôle ni identifiant : `server/db/index.js:12` |  |
| SEC-DB-003 | HIGH | FAIL | aucun trafic réseau vers la base ; secrets scellés ; sauvegardes chiffrées | chiffrement du disque de l’hôte : action H7 |
| SEC-DB-004 | MEDIUM | PASS | clés d’API, secrets des services, paramètres secrets des nœuds et secrets de webhook scellés AES-256-GCM : `server/vault.js:53`, `server/triggers.js:19` ; TOTP scellés par le socle | essai `test/hub.test.js:311` |
| SEC-DB-005 | CRITICAL | PASS | voir SEC-INJ-001 |  |
| SEC-DB-006 | HIGH | FAIL | voir REQ-DATA-003 | action H8 |
| SEC-DB-007 | MEDIUM | PASS | essais et vitrine sur données fabriquées ; aucun compte par défaut : jeton d’installation exigé (`socle/src/comptes.js:219`) |  |
| SEC-DB-008 | CRITICAL | N/A | le navigateur ne parle jamais à la base : SQLite côté serveur seulement |  |
| SEC-DB-009 | LOW | PASS | `server/db/index.js:15` | un seul processus, pas de pool |
| SEC-DB-010 | LOW | PASS | journal chaîné des actions d’administration, sauvegarde comprise : `server/cli.js:46` ; export de compte tracé par le socle | copie sur la sortie standard, hors de portée du Hub |
| SEC-FILE-001 | HIGH | PASS | logos : type par les octets (`server/logos.js:35`), puis décodés et réécrits : `server/image.js:123` | essai `test/unit.test.js:984` |
| SEC-FILE-002 | MEDIUM | PASS | 512 px au plus avant décodage : `server/image.js:10` ; décompression bornée : `server/image.js:57` ; 300 Ko par image | bombe et image géante refusées à l’essai |
| SEC-FILE-003 | HIGH | PASS | logos hors des fichiers servis, sous un nom dérivé de l’identifiant du service : `server/logos.js:100` | aucun nom fourni par un tiers |
| SEC-FILE-004 | HIGH | PASS | logos servis en pièce jointe, CSP « default-src 'none' », nosniff, toujours image/png : `server/http/api.js:399` | SVG refusé ; même origine, mais rien d’exécutable ne peut y être servi |
| SEC-FILE-005 | CRITICAL | PASS | logos derrière une session d’administrateur : `server/http/api.js:401` | balayage des rôles |
| SEC-FILE-006 | MEDIUM | N/A | aucun fichier déposé par un compte n’est redistribué à un autre : l’audio part à VOX sans être stocké, les logos viennent des sites des services |  |
| SEC-FILE-007 | LOW | PASS | voir SEC-FILE-001 : seuls les pixels sont réécrits, aucun bloc annexe |  |
| SEC-FILE-008 | HIGH | PASS | logos par l’enveloppe anti-SSRF en mode public seul : `server/logos.js:82`, puis la même validation qu’un dépôt |  |
| SEC-PAY-001 | CRITICAL | N/A | `grep -rniE "stripe\|paypal\|checkout\|invoice\|payout\|refund" server web socle/src` → 0 ligne : aucun paiement (la page Paiements des versions 0.5 a été retirée, `server/db/migrations/007_retrait_paiements.sql:3`) |  |
| SEC-PAY-002 | CRITICAL | N/A | `grep -rniE "stripe\|paypal\|checkout\|invoice\|payout\|refund" server web socle/src` → 0 ligne : aucun paiement (la page Paiements des versions 0.5 a été retirée, `server/db/migrations/007_retrait_paiements.sql:3`) ; webhooks génériques signés : voir SEC-CSRF-005 |  |
| SEC-PAY-003 | HIGH | N/A | `grep -rniE "stripe\|paypal\|checkout\|invoice\|payout\|refund" server web socle/src` → 0 ligne : aucun paiement (la page Paiements des versions 0.5 a été retirée, `server/db/migrations/007_retrait_paiements.sql:3`) ; aucun abonnement |  |
| SEC-PAY-004 | HIGH | N/A | `grep -rniE "stripe\|paypal\|checkout\|invoice\|payout\|refund" server web socle/src` → 0 ligne : aucun paiement (la page Paiements des versions 0.5 a été retirée, `server/db/migrations/007_retrait_paiements.sql:3`) |  |
| SEC-PAY-005 | HIGH | N/A | `grep -rniE "stripe\|paypal\|checkout\|invoice\|payout\|refund" server web socle/src` → 0 ligne : aucun paiement (la page Paiements des versions 0.5 a été retirée, `server/db/migrations/007_retrait_paiements.sql:3`) |  |
| SEC-PAY-006 | HIGH | PASS | courriels du socle limités : `socle/src/notifications.js:79` | le Hub n’envoie aucun courriel lui-même |
| SEC-PAY-007 | MEDIUM | FAIL | le domaine d’expédition est celui du relais de l’exploitant | SPF, DKIM et DMARC à publier avec le relais : action H2 |
| SEC-PAY-008 | MEDIUM | PASS | aucun mot de passe dans un courriel ; liens uniques, hachés, courts (`socle/src/comptes.js:37`) |  |
| SEC-NEXT-001 | CRITICAL | N/A | Node sans cadriciel : `package.json:5`, aucune dépendance ; `grep -rniE "next/\|nextjs\|use server" server web socle` → 0 ligne |  |
| SEC-NEXT-002 | CRITICAL | N/A | Node sans cadriciel : `package.json:5`, aucune dépendance ; `grep -rniE "next/\|nextjs\|use server" server web socle` → 0 ligne |  |
| SEC-NEXT-003 | HIGH | N/A | Node sans cadriciel : `package.json:5`, aucune dépendance ; `grep -rniE "next/\|nextjs\|use server" server web socle` → 0 ligne |  |
| SEC-NEXT-004 | CRITICAL | N/A | Node sans cadriciel : `package.json:5`, aucune dépendance ; `grep -rniE "next/\|nextjs\|use server" server web socle` → 0 ligne |  |
| SEC-NEXT-005 | HIGH | N/A | Node sans cadriciel : `package.json:5`, aucune dépendance ; `grep -rniE "next/\|nextjs\|use server" server web socle` → 0 ligne |  |
| SEC-NEXT-006 | HIGH | N/A | Node sans cadriciel : `package.json:5`, aucune dépendance ; `grep -rniE "next/\|nextjs\|use server" server web socle` → 0 ligne |  |
| SEC-NEXT-007 | HIGH | N/A | Node sans cadriciel : `package.json:5`, aucune dépendance ; `grep -rniE "next/\|nextjs\|use server" server web socle` → 0 ligne |  |
| SEC-NEXT-008 | MEDIUM | N/A | Node sans cadriciel : `package.json:5`, aucune dépendance ; `grep -rniE "next/\|nextjs\|use server" server web socle` → 0 ligne ; aucun déploiement Vercel |  |
| SEC-NEXT-009 | MEDIUM | N/A | Node sans cadriciel : `package.json:5`, aucune dépendance ; `grep -rniE "next/\|nextjs\|use server" server web socle` → 0 ligne ; aucune bibliothèque de cache client |  |
| SEC-BAAS-001 | CRITICAL | N/A | `grep -rniE "supabase\|firebase\|firestore\|postgrest" server web socle` → 0 ligne ; base SQLite embarquée : `server/db/index.js:12` |  |
| SEC-BAAS-002 | CRITICAL | N/A | `grep -rniE "supabase\|firebase\|firestore\|postgrest" server web socle` → 0 ligne ; base SQLite embarquée : `server/db/index.js:12` |  |
| SEC-BAAS-003 | CRITICAL | N/A | `grep -rniE "supabase\|firebase\|firestore\|postgrest" server web socle` → 0 ligne ; base SQLite embarquée : `server/db/index.js:12` |  |
| SEC-BAAS-004 | HIGH | N/A | `grep -rniE "supabase\|firebase\|firestore\|postgrest" server web socle` → 0 ligne ; base SQLite embarquée : `server/db/index.js:12` |  |
| SEC-BAAS-005 | CRITICAL | N/A | `grep -rniE "supabase\|firebase\|firestore\|postgrest" server web socle` → 0 ligne ; base SQLite embarquée : `server/db/index.js:12` |  |
| SEC-BAAS-006 | HIGH | N/A | `grep -rniE "supabase\|firebase\|firestore\|postgrest" server web socle` → 0 ligne ; base SQLite embarquée : `server/db/index.js:12` |  |
| SEC-BAAS-007 | MEDIUM | N/A | `grep -rniE "supabase\|firebase\|firestore\|postgrest" server web socle` → 0 ligne ; base SQLite embarquée : `server/db/index.js:12` |  |
| SEC-BAAS-008 | CRITICAL | N/A | `grep -rniE "supabase\|firebase\|firestore\|postgrest" server web socle` → 0 ligne ; base SQLite embarquée : `server/db/index.js:12` |  |
| SEC-BAAS-009 | CRITICAL | N/A | `grep -rniE "supabase\|firebase\|firestore\|postgrest" server web socle` → 0 ligne ; base SQLite embarquée : `server/db/index.js:12` |  |
| SEC-BAAS-010 | HIGH | N/A | `grep -rniE "supabase\|firebase\|firestore\|postgrest" server web socle` → 0 ligne ; base SQLite embarquée : `server/db/index.js:12` |  |
| SEC-BAAS-011 | HIGH | N/A | `grep -rniE "supabase\|firebase\|firestore\|postgrest" server web socle` → 0 ligne ; base SQLite embarquée : `server/db/index.js:12` |  |
| SEC-BE-001 | MEDIUM | PASS | en-têtes posés avant toute route, erreurs comprises : `server/http/server.js:50` | pas d’Express : équivalent explicite |
| SEC-BE-002 | MEDIUM | PASS | corps bornés ; routage strict (404, 405) ; relais de confiance explicites : `socle/src/http.js:14` | délais du serveur : `server/main.js:172` |
| SEC-BE-003 | HIGH | PASS | voir SEC-INJ-004, SEC-INJ-006 et SEC-INJ-008 ; aucun import dynamique d’un chemin fourni |  |
| SEC-BE-004 | HIGH | PASS | aucune dépendance d’exécution ni de développement : `.github/workflows/verification.yml:37` | rien à auditer ; l’image est criblée (SEC-TEST-003) |
| SEC-BE-005 | CRITICAL | N/A | aucun Django : service Node |  |
| SEC-BE-006 | HIGH | N/A | aucun Flask ni FastAPI : service Node |  |
| SEC-BE-007 | HIGH | N/A | aucun code Python servi |  |
| SEC-BE-008 | HIGH | N/A | aucun PHP |  |
| SEC-BE-009 | MEDIUM | PASS | `Dockerfile:48` ; racine en lecture seule, capacités retirées : `compose.yml:40`, `compose.yml:42` ; tini en PID 1 | Docker piloté par un proxy de socket filtrant, jamais le socket en direct |
| SEC-BE-010 | MEDIUM | PASS | `socle/src/http.js:157` ; état public réduit à « vivant » : `server/http/api.js:55` | démarrage refusé sur configuration fausse ou route sans schéma |
| SEC-WP-001 | CRITICAL | N/A | application Node écrite ici : `grep -rniwE "wordpress\|wp-admin\|wp-content\|bubble\|webflow" server web socle` → 0 ligne |  |
| SEC-WP-002 | HIGH | N/A | application Node écrite ici : `grep -rniwE "wordpress\|wp-admin\|wp-content\|bubble\|webflow" server web socle` → 0 ligne |  |
| SEC-WP-003 | HIGH | N/A | application Node écrite ici : `grep -rniwE "wordpress\|wp-admin\|wp-content\|bubble\|webflow" server web socle` → 0 ligne |  |
| SEC-WP-004 | MEDIUM | N/A | application Node écrite ici : `grep -rniwE "wordpress\|wp-admin\|wp-content\|bubble\|webflow" server web socle` → 0 ligne |  |
| SEC-WP-005 | MEDIUM | N/A | application Node écrite ici : `grep -rniwE "wordpress\|wp-admin\|wp-content\|bubble\|webflow" server web socle` → 0 ligne |  |
| SEC-WP-006 | CRITICAL | N/A | application Node écrite ici : `grep -rniwE "wordpress\|wp-admin\|wp-content\|bubble\|webflow" server web socle` → 0 ligne |  |
| SEC-WP-007 | HIGH | N/A | application Node écrite ici : `grep -rniwE "wordpress\|wp-admin\|wp-content\|bubble\|webflow" server web socle` → 0 ligne |  |
| SEC-WP-008 | MEDIUM | N/A | application Node écrite ici : `grep -rniwE "wordpress\|wp-admin\|wp-content\|bubble\|webflow" server web socle` → 0 ligne |  |
| SEC-INFRA-001 | HIGH | FAIL | voir REQ-WEB-001 | action H1 |
| SEC-INFRA-002 | MEDIUM | FAIL | aucun domaine dans le dépôt | DNS, CAA et verrou du registraire du domaine éventuel : action H13 |
| SEC-INFRA-003 | HIGH | FAIL | hôte de l’exploitant ; le Hub n’écoute que sur 127.0.0.1 : `compose.yml:26` | pare-feu, SSH par clé, mises à jour : action H9 |
| SEC-INFRA-004 | MEDIUM | FAIL | `Dockerfile:5` ; `Dockerfile:48` ; `compose.yml:40` ; `compose.yml:42` ; `compose.yml:43` ; crible en CI : `.github/workflows/verification.yml:133` | crible exécuté (Actions, H3 ; Trivy au déploiement, H14) |
| SEC-INFRA-005 | CRITICAL | N/A | aucun stockage objet : `grep -rniE "\bs3\b\|aws-sdk\|@google-cloud\|azure\|storage\.googleapis\|putObject\|getObject" server socle/src web` → 0 ligne ; `grep -rnw bucket server socle/src web` → 2 lignes, une variable de regroupement des mesures dans le temps (`server/probes.js:89`) |  |
| SEC-INFRA-006 | HIGH | N/A | aucun nuage : service auto-hébergé, aucune clé IAM |  |
| SEC-INFRA-007 | HIGH | FAIL | permissions minimales, actions épinglées, aucun secret exposé aux demandes de fusion | protection de branche et revue requise : action H3 |
| SEC-INFRA-008 | MEDIUM | FAIL | image construite sur la machine par install.sh depuis les sources ; nomenclature en CI | la CI tourne sur les Actions (H3) |
| SEC-INFRA-009 | MEDIUM | N/A | aucune infrastructure décrite en code : `find . -name "*.tf" -o -name "Pulumi.yaml"` → 0 fichier |  |
| SEC-DEP-001 | HIGH | PASS | aucune dépendance npm, donc aucun verrou à tenir ; image de base épinglée par empreinte : `Dockerfile:5` | paquets Alpine de l’image passés au crible et décrits par la nomenclature |
| SEC-DEP-002 | HIGH | FAIL | crible de l’image chaque lundi : `.github/workflows/verification.yml:14` | Actions et alertes Dependabot : action H3 |
| SEC-DEP-003 | MEDIUM | PASS | aucune dépendance ; le socle est embarqué et contrôlé par ses empreintes | essai CI `.github/workflows/verification.yml:36` |
| SEC-DEP-004 | MEDIUM | PASS | actions épinglées par commit (`.github/workflows/verification.yml:23`) ; mises à jour proposées, jamais appliquées seules : `.github/dependabot.yml:8` |  |
| SEC-DEP-005 | MEDIUM | N/A | aucun paquet npm installé, donc aucun script d’installation exécuté |  |
| SEC-DEP-006 | LOW | FAIL | `.github/workflows/verification.yml:141` | produite par la CI (H3) |
| SEC-DEP-007 | MEDIUM | PASS | voir SEC-XSS-008 |  |
| SEC-DEP-008 | LOW | FAIL | crible hebdomadaire de l’image en CI | abonnement aux avis GitHub : action H3 |
| SEC-LLM-001 | CRITICAL | PASS | clés lues côté serveur seulement : `server/ai/gateway.js:48` | le navigateur ne voit que « clé posée » |
| SEC-LLM-002 | CRITICAL | PASS | session ou jeton exigé ; débit et quota par compte (`server/http/api.js:40`) ; jetons plafonnés par appel (`server/ai/gateway.js:240`) ; plafond global sur 24 h (`server/ai/gateway.js:203`) | essai `test/unit.test.js:1326` ; plafond chez chaque fournisseur : action H6 |
| SEC-LLM-003 | HIGH | PASS | données cloisonnées : `server/ai/agent.js:274` ; aucune décision de sécurité prise par le modèle : chaque étape repassée par le serveur ; un message ne part que vers un canal de Clés & API | essai `test/hub.test.js:870` (adresse choisie par le modèle refusée) |
| SEC-LLM-004 | HIGH | PASS | réponses rendues en nœuds DOM sans HTML (voir SEC-XSS-002) ; plans validés par le serveur, jamais exécutés tels quels ni passés à SQL |  |
| SEC-LLM-005 | CRITICAL | PASS | outils bornés et revus ; exécution d’un plan réservée aux administrateurs ; en Autonome, rien qui sorte, coûte ou change un service sans clic : `server/ai/agent.js:1224` ; un message ne part sans clic que pour un administrateur | essais `test/hub.test.js:896` et balayage des rôles |
| SEC-LLM-006 | HIGH | PASS | une conversation par compte : `server/ai/agent.js:54` ; mémoire commune réservée aux administrateurs : `server/ai/agent.js:64` ; aucune valeur de secret dans le contexte, seulement des références $vars | essais `test/unit.test.js:1556` |
| SEC-LLM-007 | MEDIUM | PASS | assistant réservé aux comptes invités, cadré sur la configuration du Hub (consigne système), questions gardées 90 jours pour enquête ; coût borné (SEC-LLM-002) | pas de service public |
| SEC-LLM-008 | LOW | PASS | modèles choisis dans la liste renvoyée par le fournisseur, fixés par connexion ; aucune base vectorielle dans le Hub | SYNAPSE a son propre audit |
| SEC-LOG-001 | MEDIUM | PASS | voir REQ-DATA-004 ; identifiant de requête : `socle/src/requete.js:12` |  |
| SEC-LOG-002 | HIGH | PASS | `socle/src/journal.js:10` ; `server/util/common.js:37` | journal réservé aux administrateurs, un an |
| SEC-LOG-003 | MEDIUM | FAIL | sortie standard conservée par Docker, hors de portée du service : `compose.yml:44` | collecteur central hors hôte : action H11 |
| SEC-LOG-004 | MEDIUM | PASS | vigie du socle (échecs, refus, limites, connexion d’un administrateur) ; refus d’origine et de jeton anti-CSRF journalisés : `socle/src/portail.js:97` ; plafond de l’IA atteint | courriel (H2) pour sortir de l’application |
| SEC-LOG-005 | LOW | FAIL | santé du conteneur : `Dockerfile:51` ; services surveillés par le Hub | surveillance externe : action H10 |
| SEC-LOG-006 | MEDIUM | PASS | runbook ci-dessous |  |
| SEC-LOG-007 | HIGH | PASS | fermeture globale des sessions : `socle/src/portail.js:385` ; jetons d’accès révocables : `server/http/api.js:385` ; rotation de chaque secret : `server/vault.js:95`, `socle/src/comptes.js:109` ; coupure d’urgence de l’IA et des workflows, par l’interface ou la ligne de commande : `server/coupure.js:15`, `server/cli.js:48` | essais `test/hub.test.js:345`, `test/unit.test.js:1363`, `socle/test/rotation.test.js:14` ; runbook ci-dessous |
| SEC-PRIV-001 | MEDIUM | PASS | `web/confidentialite.txt:7` avec durées ; purges : `server/retention.js:5` |  |
| SEC-PRIV-002 | MEDIUM | PASS | un cookie de session indispensable, documenté ; aucun traceur (`web/confidentialite.txt:72`) |  |
| SEC-PRIV-003 | MEDIUM | PASS | `web/confidentialite.txt:51` nomme chaque destinataire ; lien depuis la page Sécurité : `web/app.js:248` | essai `test/hub.test.js:139` |
| SEC-PRIV-004 | MEDIUM | PASS | export, questions à l’assistant comprises : `socle/src/portail.js:328`, `server/main.js:86` ; effacement en libre-service sous renfort, identifiant retapé : `socle/src/comptes.js:840` ; questions et quotas du compte effacés avec lui : `server/main.js:82` | essai `test/hub.test.js:1725` ; questions des comptes restants effacées à 90 jours |
| SEC-PRIV-005 | HIGH | FAIL | voir REQ-DATA-002 | action H7 |
| SEC-PRIV-006 | LOW | FAIL | destinataires nommés dans `web/confidentialite.txt:57` | conditions de traitement du fournisseur d’IA choisi : action H15 |
| SEC-PRIV-007 | MEDIUM | PASS | runbook : notification sous 72 heures |  |
| SEC-PRIV-008 | LOW | PASS | `web/confidentialite.txt:93` | aucune catégorie particulière de données |
| SEC-TEST-001 | MEDIUM | FAIL | `.github/workflows/verification.yml:114` | Actions : H3 |
| SEC-TEST-002 | HIGH | FAIL | voir REQ-CI-001 | actions H3, H4 |
| SEC-TEST-003 | HIGH | FAIL | image : `.github/workflows/verification.yml:133` | actions H3, H14 |
| SEC-TEST-004 | MEDIUM | FAIL | aucun passage DAST encore | ZAP en mode « baseline » contre la VM d’essai : action H14 |
| SEC-TEST-005 | LOW | FAIL | voir REQ-WEB-001 | notation après HTTPS : action H1 |
| SEC-TEST-006 | HIGH | PASS | voir REQ-CI-006 |  |
| SEC-TEST-007 | LOW | PASS | sondage manuel mené le jour de cet audit : identifiants devinés, champs inconnus, rôles, corps géants, fichiers cachés, adresses internes, webhooks sans preuve, images piégées, injection dans ce que lit l’assistant — chacun devenu un essai | annexe B ci-dessous |
| SEC-TEST-008 | LOW | N/A | ni argent, ni santé, ni large public : service auto-hébergé pour quelques comptes invités ; `grep -rniE "stripe\|paypal\|checkout\|invoice\|payout\|refund" server web socle/src` → 0 ligne : aucun paiement (la page Paiements des versions 0.5 a été retirée, `server/db/migrations/007_retrait_paiements.sql:3`) |  |

## Not applicable
| ID | Why, with proof |
|---|---|
| REQ-CRYPT-003 | bcrypt absent : `grep -rni bcrypt socle/src server` → 0 ligne ; Argon2id seul |
| SEC-AUTH-008 | aucune connexion par fournisseur externe : `grep -rniE "oauth\|openid\|id_token\|redirect_uri" socle/src server` → 0 ligne |
| SEC-SESS-005 | aucun JWT : `grep -rniE "jwt\|jsonwebtoken\|jose" server web socle` → 0 ligne |
| SEC-SESS-006 | aucun jeton de rafraîchissement : sessions serveur (voir SEC-SESS-005) |
| SEC-AUTHZ-005 | aucune organisation ni espace partagé : une installation, des comptes à rôles (voir SEC-AUTHZ-001) |
| SEC-INJ-002 | aucun ORM : node:sqlite, requêtes préparées seulement |
| SEC-INJ-003 | aucune base documentaire : SQLite seulement |
| SEC-INJ-007 | aucun analyseur XML : `grep -rniE "xml2js\|sax\|libxml\|fast-xml\|DOMParser" server socle/src` → 0 ligne |
| SEC-XSS-007 | aucune redirection pilotée par paramètre : `grep -rnE "searchParams.get\(.(next\|redirect)\|location\.href *=" server web socle` → 0 ligne |
| SEC-CSRF-006 | aucune redirection : voir SEC-XSS-007 |
| SEC-API-006 | aucun GraphQL : `grep -rniE "graphql\|apollo" server web socle` → 0 ligne |
| SEC-DB-002 | SQLite embarqué sans rôle ni identifiant : `server/db/index.js:12` |
| SEC-DB-008 | le navigateur ne parle jamais à la base : SQLite côté serveur seulement |
| SEC-FILE-006 | aucun fichier déposé par un compte n’est redistribué à un autre : l’audio part à VOX sans être stocké, les logos viennent des sites des services |
| SEC-PAY-001 | `grep -rniE "stripe\|paypal\|checkout\|invoice\|payout\|refund" server web socle/src` → 0 ligne : aucun paiement (la page Paiements des versions 0.5 a été retirée, `server/db/migrations/007_retrait_paiements.sql:3`) |
| SEC-PAY-002 | `grep -rniE "stripe\|paypal\|checkout\|invoice\|payout\|refund" server web socle/src` → 0 ligne : aucun paiement (la page Paiements des versions 0.5 a été retirée, `server/db/migrations/007_retrait_paiements.sql:3`) ; webhooks génériques signés : voir SEC-CSRF-005 |
| SEC-PAY-003 | `grep -rniE "stripe\|paypal\|checkout\|invoice\|payout\|refund" server web socle/src` → 0 ligne : aucun paiement (la page Paiements des versions 0.5 a été retirée, `server/db/migrations/007_retrait_paiements.sql:3`) ; aucun abonnement |
| SEC-PAY-004 | `grep -rniE "stripe\|paypal\|checkout\|invoice\|payout\|refund" server web socle/src` → 0 ligne : aucun paiement (la page Paiements des versions 0.5 a été retirée, `server/db/migrations/007_retrait_paiements.sql:3`) |
| SEC-PAY-005 | `grep -rniE "stripe\|paypal\|checkout\|invoice\|payout\|refund" server web socle/src` → 0 ligne : aucun paiement (la page Paiements des versions 0.5 a été retirée, `server/db/migrations/007_retrait_paiements.sql:3`) |
| SEC-NEXT-001 | Node sans cadriciel : `package.json:5`, aucune dépendance ; `grep -rniE "next/\|nextjs\|use server" server web socle` → 0 ligne |
| SEC-NEXT-002 | Node sans cadriciel : `package.json:5`, aucune dépendance ; `grep -rniE "next/\|nextjs\|use server" server web socle` → 0 ligne |
| SEC-NEXT-003 | Node sans cadriciel : `package.json:5`, aucune dépendance ; `grep -rniE "next/\|nextjs\|use server" server web socle` → 0 ligne |
| SEC-NEXT-004 | Node sans cadriciel : `package.json:5`, aucune dépendance ; `grep -rniE "next/\|nextjs\|use server" server web socle` → 0 ligne |
| SEC-NEXT-005 | Node sans cadriciel : `package.json:5`, aucune dépendance ; `grep -rniE "next/\|nextjs\|use server" server web socle` → 0 ligne |
| SEC-NEXT-006 | Node sans cadriciel : `package.json:5`, aucune dépendance ; `grep -rniE "next/\|nextjs\|use server" server web socle` → 0 ligne |
| SEC-NEXT-007 | Node sans cadriciel : `package.json:5`, aucune dépendance ; `grep -rniE "next/\|nextjs\|use server" server web socle` → 0 ligne |
| SEC-NEXT-008 | Node sans cadriciel : `package.json:5`, aucune dépendance ; `grep -rniE "next/\|nextjs\|use server" server web socle` → 0 ligne ; aucun déploiement Vercel |
| SEC-NEXT-009 | Node sans cadriciel : `package.json:5`, aucune dépendance ; `grep -rniE "next/\|nextjs\|use server" server web socle` → 0 ligne ; aucune bibliothèque de cache client |
| SEC-BAAS-001 | `grep -rniE "supabase\|firebase\|firestore\|postgrest" server web socle` → 0 ligne ; base SQLite embarquée : `server/db/index.js:12` |
| SEC-BAAS-002 | `grep -rniE "supabase\|firebase\|firestore\|postgrest" server web socle` → 0 ligne ; base SQLite embarquée : `server/db/index.js:12` |
| SEC-BAAS-003 | `grep -rniE "supabase\|firebase\|firestore\|postgrest" server web socle` → 0 ligne ; base SQLite embarquée : `server/db/index.js:12` |
| SEC-BAAS-004 | `grep -rniE "supabase\|firebase\|firestore\|postgrest" server web socle` → 0 ligne ; base SQLite embarquée : `server/db/index.js:12` |
| SEC-BAAS-005 | `grep -rniE "supabase\|firebase\|firestore\|postgrest" server web socle` → 0 ligne ; base SQLite embarquée : `server/db/index.js:12` |
| SEC-BAAS-006 | `grep -rniE "supabase\|firebase\|firestore\|postgrest" server web socle` → 0 ligne ; base SQLite embarquée : `server/db/index.js:12` |
| SEC-BAAS-007 | `grep -rniE "supabase\|firebase\|firestore\|postgrest" server web socle` → 0 ligne ; base SQLite embarquée : `server/db/index.js:12` |
| SEC-BAAS-008 | `grep -rniE "supabase\|firebase\|firestore\|postgrest" server web socle` → 0 ligne ; base SQLite embarquée : `server/db/index.js:12` |
| SEC-BAAS-009 | `grep -rniE "supabase\|firebase\|firestore\|postgrest" server web socle` → 0 ligne ; base SQLite embarquée : `server/db/index.js:12` |
| SEC-BAAS-010 | `grep -rniE "supabase\|firebase\|firestore\|postgrest" server web socle` → 0 ligne ; base SQLite embarquée : `server/db/index.js:12` |
| SEC-BAAS-011 | `grep -rniE "supabase\|firebase\|firestore\|postgrest" server web socle` → 0 ligne ; base SQLite embarquée : `server/db/index.js:12` |
| SEC-BE-005 | aucun Django : service Node |
| SEC-BE-006 | aucun Flask ni FastAPI : service Node |
| SEC-BE-007 | aucun code Python servi |
| SEC-BE-008 | aucun PHP |
| SEC-WP-001 | application Node écrite ici : `grep -rniwE "wordpress\|wp-admin\|wp-content\|bubble\|webflow" server web socle` → 0 ligne |
| SEC-WP-002 | application Node écrite ici : `grep -rniwE "wordpress\|wp-admin\|wp-content\|bubble\|webflow" server web socle` → 0 ligne |
| SEC-WP-003 | application Node écrite ici : `grep -rniwE "wordpress\|wp-admin\|wp-content\|bubble\|webflow" server web socle` → 0 ligne |
| SEC-WP-004 | application Node écrite ici : `grep -rniwE "wordpress\|wp-admin\|wp-content\|bubble\|webflow" server web socle` → 0 ligne |
| SEC-WP-005 | application Node écrite ici : `grep -rniwE "wordpress\|wp-admin\|wp-content\|bubble\|webflow" server web socle` → 0 ligne |
| SEC-WP-006 | application Node écrite ici : `grep -rniwE "wordpress\|wp-admin\|wp-content\|bubble\|webflow" server web socle` → 0 ligne |
| SEC-WP-007 | application Node écrite ici : `grep -rniwE "wordpress\|wp-admin\|wp-content\|bubble\|webflow" server web socle` → 0 ligne |
| SEC-WP-008 | application Node écrite ici : `grep -rniwE "wordpress\|wp-admin\|wp-content\|bubble\|webflow" server web socle` → 0 ligne |
| SEC-INFRA-005 | aucun stockage objet : `grep -rniE "\bs3\b\|aws-sdk\|@google-cloud\|azure\|storage\.googleapis\|putObject\|getObject" server socle/src web` → 0 ligne ; `grep -rnw bucket server socle/src web` → 2 lignes, une variable de regroupement des mesures dans le temps (`server/probes.js:89`) |
| SEC-INFRA-006 | aucun nuage : service auto-hébergé, aucune clé IAM |
| SEC-INFRA-009 | aucune infrastructure décrite en code : `find . -name "*.tf" -o -name "Pulumi.yaml"` → 0 fichier |
| SEC-DEP-005 | aucun paquet npm installé, donc aucun script d’installation exécuté |
| SEC-TEST-008 | ni argent, ni santé, ni large public : service auto-hébergé pour quelques comptes invités ; `grep -rniE "stripe\|paypal\|checkout\|invoice\|payout\|refund" server web socle/src` → 0 ligne : aucun paiement (la page Paiements des versions 0.5 a été retirée, `server/db/migrations/007_retrait_paiements.sql:3`) |

## Anonymity (REQ-ANON-001 to -010)
Arbre de travail : 0 occurrence de la liste d'anonymat. Les motifs de l'annexe B.1 y relèvent 31 lignes dans 16 fichiers, toutes des valeurs d'exemple, des vecteurs d'essai du classement anti-SSRF, des chemins d'API génériques ou des noms de produits pris en charge ; chacune est justifiée dans le rapport hors dépôt. Cette remise a retiré de l'arbre 35 lignes dans 15 fichiers qui portaient un terme de la liste (chemins de l'hôte, adresses et noms du réseau privé, références à l'infrastructure personnelle) et 2 fichiers de consignes d'outil. Auteur et validateur : une seule identité, tous les commits en UTC, aucune mention d'outil. Exposition résiduelle : ces termes restent dans le premier commit de l'historique local, jamais publié → H12. Détail, options et commandes dans le rapport d'anonymat hors dépôt.

## Human actions required
Ce qu'aucun agent ne peut faire à la place de l'exploitant. Cette liste bloque la mise en production tant qu'elle n'est pas vide.

| # | Action | Contrôles | Étapes |
|---|---|---|---|
| H1 | Servir le Hub en HTTPS | REQ-WEB-001, SEC-HDR-001, SEC-INFRA-001, SEC-TEST-005 | Relais TLS devant le port 8100 (lié à 127.0.0.1) ou certificat de l'autorité locale ; déclarer l'adresse du relais dans `SOCLE_PROXYS` ; `SOCLE_HTTP_DEGRADE` absent ou à 0 ; `HUB_PUBLIC_URL` en https:// ; vérifier `curl -sI https://<hub>/ \| grep -i strict-transport-security` ; noter le résultat de testssl.sh. |
| H2 | Relais SMTP et adresses d'alerte | REQ-AUTH-014, SEC-PAY-007 | Variables `SOCLE_SMTP_*` dans `.env` (relais, port, chiffrement, identifiants, expéditeur) ; publier SPF, DKIM et DMARC pour le domaine d'expédition ; chaque administrateur ajoute puis confirme son adresse dans Sécurité → Alertes par courriel. |
| H3 | GitHub | REQ-CI-001…005, GOV-003, GOV-005, SEC-INFRA-007/008, SEC-TEST-001…003, SEC-DEP-002/006/008 | Rétablir la facturation pour réactiver les Actions ; Settings → Branches : protéger `main` (pas de poussée forcée, contrôles requis : essais, secrets, identite, anonymat, analyse, image) ; Code security : Dependabot alerts, secret scanning et push protection, private vulnerability reporting ; 2FA sur le compte et sur chaque console de fournisseur. |
| H4 | Liste d'anonymat | REQ-ANON-003, REQ-CI-004, REQ-CI-001 | Sur le poste : `brew install gitleaks exiftool` ; `~/.config/git/denylist.txt`, un terme par ligne (`=` en tête : casse exacte) ; le crochet fourni hors dépôt (`anonymat-hook.sh`) copié en `~/.config/git/hooks/pre-commit`, rendu exécutable, lié en `commit-msg`, puis `git config --global core.hooksPath ~/.config/git/hooks` ; dans ce dépôt, `.git/info/anonymat-exceptions` (jamais committé) écarte les noms de produits que le Hub prend en charge, donnés par le rapport hors dépôt. Sur GitHub : secret de dépôt `LISTE_ANONYMAT` = la liste moins ces exceptions. Vérifier : un commit d'essai portant un terme est refusé par le crochet, puis par la vérification. |
| H5 | Brûler les clés vues pendant le développement | SEC-SECRETS-006 | Chez chaque fournisseur dont une clé a été posée dans le Hub de la VM d'essai (IA, ElevenLabs, Telegram), révoquer et émettre une clé neuve ; la coller dans Clés & API (renfort demandé) ; vérifier avec « Tester ». Sur la VM, tourner aussi HUB_CLE et SOCLE_CLE une fois (README, « Tourner une clé » ; déjà exercé hors de la VM par `outils/exercice-rotation.mjs`). |
| H6 | Clés par environnement, budgets | REQ-CFG-003, SEC-SECRETS-005, GOV-004, SEC-LLM-002 | Une clé par fournisseur pour la VM d'essai, une autre pour la production, chacune avec un plafond mensuel et une alerte de facturation ; régler `HUB_IA_APPELS_JOUR` et `HUB_IA_JETONS_JOUR` sous ce plafond. |
| H7 | Chiffrement des disques | REQ-DATA-002, SEC-DB-003, SEC-PRIV-005 | LUKS (ou chiffrement du stockage de l'hyperviseur) sur l'hôte qui porte le volume `hub-data` et `/opt/hub/secrets`. |
| H8 | Sauvegardes et exercices | REQ-DATA-003, SEC-DB-006, REQ-DATA-005 | Paire RSA 3072 bits créée hors de l'hôte, clé publique dans `/opt/hub/secrets/sauvegarde.pub` (README, « Sauvegardes ») ; cron quotidien `docker exec hub node server/cli.js sauvegarde > hub-$(date -u +%F).sauv` ; copie hors hôte, trente jours ; restauration réelle sur une autre machine, datée ici ; dérouler une fois le runbook ci-dessous. |
| H9 | Hôtes | SEC-INFRA-003 | Pare-feu (seuls les ports publiés), SSH par clé sans root, mises à jour de sécurité automatiques, fail2ban. |
| H10 | Disponibilité vue de l'extérieur | SEC-LOG-005 | Une sonde externe sur `/api/status`, ou décision écrite : service de réseau local seulement, sondes internes suffisantes. |
| H11 | Journaux centralisés | SEC-LOG-003 | Transférer les journaux du conteneur (dont les lignes `"journal":"hub-audit"`) vers un collecteur hors de l'hôte : pilote de journalisation Docker ou agent. |
| H12 | Premier commit local | REQ-ANON-002, REQ-ANON-004 | L'historique n'a jamais été publié et ne doit pas l'être tel quel. Avant toute publication, recréer le dépôt depuis l'arbre propre (commandes dans le rapport d'anonymat hors dépôt), puis régénérer SECURITY.md et NO-VIBE.md, qui citent des empreintes et des comptes de cet historique. |
| H13 | Domaine | REQ-ANON-009, SEC-INFRA-002 | Si le Hub reçoit un nom public : protection WHOIS, verrou du registraire, 2FA, enregistrement CAA, suppression des enregistrements orphelins. |
| H14 | Crible au déploiement | SEC-INFRA-004, SEC-TEST-003, SEC-TEST-004 | Sur la VM : `trivy image hub:local` sans CRITICAL ni HIGH corrigeable ; `zap-baseline.py -t http://<vm>:8100` ; résultats notés ici. |
| H15 | Transferts hors UE | SEC-PRIV-006 | Accepter les conditions de traitement de chaque fournisseur d'IA ou de voix utilisé, ou s'en tenir à Ollama et à Mistral ; la notice de confidentialité les nomme. |
| H16 | Clés maîtresses | REQ-DATA-003, SEC-DB-006 | Copier `/opt/hub/secrets` (hub_cle, socle_cle) hors ligne, à part des sauvegardes de la base : sans elles, une sauvegarde restaurée ne déchiffre ni les clés d'API ni les secrets TOTP. |
| H17 | Passer à la 0.12.1 | SEC-AUTHZ-002, SEC-LLM-001, SEC-LLM-005 | Relancer `sudo ./install.sh` : il crée `secrets/pont_jeton` et `secrets/pont_jeton_outil`, et le réseau `hub_outils` (le pont n'est plus joignable des services). Ne nommer dans `HUB_IA_SERVICES_OUTILS` que les services de confiance qui doivent parler à Claude Code ou Codex. |

Orthographe du pseudonyme : le manuel nomme l'identité « Codex64 » ; les commits, la licence et le compte GitHub portent la forme du compte, identique dans tout l'historique. Changer maintenant créerait une seconde identité dans le journal git ; à trancher par l'exploitant.

## Secrets inventory
| Secret | Where it lives | Scope | Rotation procedure | Last rotated |
|---|---|---|---|---|
| HUB_CLE (tirée par install.sh) | secret Docker `/opt/hub/secrets/hub_cle` (0400), hors du volume | scelle le coffre du Hub (clés d'API, variables, réglages des services, paramètres secrets des workflows, secrets de webhook) | README « Tourner une clé » : l'actuelle dans `hub_cle_ancienne`, une neuve dans `hub_cle`, redémarrer (tout est rescellé en une transaction, journal `coffre.tourné`), vider `hub_cle_ancienne`, redémarrer ; en cas de fuite, tourner aussi chaque clé du coffre | création à l'installation ; procédure exercée le 2026-09-29 (`outils/exercice-rotation.mjs`) |
| SOCLE_CLE (tirée par install.sh) | secret Docker `/opt/hub/secrets/socle_cle` (0400) | scelle les secrets TOTP des comptes du Hub | même geste avec `socle_cle_ancienne` : les TOTP sont rescellés, personne ne réinscrit rien, les codes de secours restent valables | création à l'installation ; procédure exercée le 2026-09-29 (`outils/exercice-rotation.mjs`) |
| SOCLE_POIVRE (tiré par l'exploitant, s'il en pose un) | non posé par défaut | poivre HMAC des mots de passe | le nouveau dans `SOCLE_POIVRE`, l'ancien dans `SOCLE_POIVRE_ANCIEN` : chaque mot de passe passe au nouveau à la connexion suivante | — |
| Clé privée des sauvegardes (tirée par l'exploitant, `openssl genpkey`) | hors de l'hôte, jamais sur la machine du Hub | relit les sauvegardes | nouvelle paire, remplacer `sauvegarde.pub`, garder l'ancienne privée tant que ses sauvegardes sont conservées | à créer (H8) |
| Jetons d'accès `hubj_` (tirés par le Hub) | empreinte SHA-256 en base | questions à l'assistant | `docker exec hub node server/cli.js jeton <nom>` (révoque et réémet) ou Réglages → Jetons | à la création |
| Jetons Hub → service (HUB_TOKEN de chaque service, tirés par le Hub) | coffre du Hub, variable du conteneur du service | API de gestion du service | Service → Réglages → régénérer, puis Redéployer | à l'installation du service |
| Clés d'IA (émises par Anthropic, OpenAI, Google, Moonshot, Mistral, OpenRouter) | coffre du Hub | assistant et nœuds IA | révoquer chez le fournisseur, coller la neuve dans Clés & API, « Tester » | à faire (H5) |
| Clés et jetons de voix et de messagerie (émis par ElevenLabs, Telegram, Discord, Slack, ntfy, Gotify, Pushover) | coffre du Hub | voix et messages | révoquer chez le fournisseur ou recréer le webhook, coller, « Tester » | à faire (H5) |
| Clés d'infrastructure (émises par Cloudflare, OVH, GitHub, GitLab, Proxmox, UniFi, Home Assistant, Grafana, Nextcloud) | coffre du Hub, si posées | nœuds et services qui les utilisent | jeton neuf aux droits minimaux chez l'émetteur, coller, « Tester » | à la pose |
| Secrets de webhook (tirés par le Hub) | table `subscriptions`, scellés par HUB_CLE | preuve HMAC ou jeton des déclencheurs | éditeur → nœud Webhook → « Nouveau secret » (montré une fois), puis le poser chez l'expéditeur ; un service abonné est réabonné seul | à la création |
| SOCLE_SMTP_MOTDEPASSE (émis par le fournisseur de courriel) | `.env` (0600) | relais des alertes | changer chez le fournisseur de courriel, `.env`, redémarrer | à la mise en service (H2) |
| SOCLE_JETON_INSTALLATION (tiré par le socle) | tiré au premier démarrage, journaux du conteneur | création du premier compte, puis inutile | aucun : invalide dès qu'un compte existe | — |

## Incident runbook
Détecter : alertes « vigie » et « dépense » dans la page Sécurité des administrateurs (et par courriel, H2) ; `docker logs hub | grep '"journal":"hub-audit"'` ; refus : `docker logs hub | grep '"resultat":"refus"'`.

```bash
# 1. Fermer toutes les sessions sauf la sienne (renfort demandé)
curl -X POST -H 'Content-Type: application/json' -H "X-CSRF: $CSRF" -b "$COOKIE" https://<hub>/api/compte/admin/sessions/fermer-tout -d '{}'
# 2. Révoquer les jetons d'accès des programmes
curl -H "X-CSRF: $CSRF" -b "$COOKIE" https://<hub>/api/jetons
curl -X DELETE -H "X-CSRF: $CSRF" -b "$COOKIE" https://<hub>/api/jetons/<id>
# 3. Mettre hors ligne ce qui est compromis (Réglages → Coupure d'urgence, ou sur la machine)
docker exec hub node server/cli.js coupure ia oui
docker exec hub node server/cli.js coupure workflows oui
# 4. Tourner les secrets touchés : voir « Secrets inventory »
# 5. Forcer un nouveau mot de passe : Comptes → compte → « Réinitialiser » (le second facteur reste exigé)
# 6. Restaurer, depuis la machine qui garde la clé privée
node server/cli.js restaurer hub-sauvegarde.pem hub.db < hub-AAAA-MM-JJ.sauv
docker compose -p hub stop hub && docker run --rm -v hub_hub-data:/data -v "$PWD":/b busybox sh -c 'cp /b/hub.db /data/hub.db && rm -f /data/hub.db-wal /data/hub.db-shm && chown 1000:1000 /data/hub.db && chmod 600 /data/hub.db' && docker compose -p hub start hub
#    Base sauvegardée avant une rotation : poser la clé d'alors dans secrets/hub_cle_ancienne (et socle_cle_ancienne) avant de démarrer
# 7. Vérifier la chaîne du journal : Journal → « chaîne intacte », et Comptes → Journal de sécurité
```
Qui : l'exploitant de l'instance tient chaque étape ; supports des fournisseurs pour révoquer une clé : console de chaque fournisseur d'IA ou de voix (page API Keys), @BotFather (`/revoke`) pour Telegram, réglages du salon pour un webhook Discord ou Slack, support.github.com pour le dépôt. Communiquer : prévenir les comptes concernés ; si des données personnelles ont pu être lues, notifier l'autorité de contrôle sous 72 heures à compter de la découverte (heure de découverte, nature, comptes touchés, mesures prises), et les personnes si le risque est élevé. Revue après incident : cause, chronologie, contrôle qui a manqué, correctif et essai de non-régression.

## Inventory
Routes publiques : `GET /api/status` (`{ok:true}` seulement), `GET /.well-known/security.txt`, `GET /confidentialite.txt`, `GET /api/compte/etat`, cérémonies de connexion et d'installation du socle (`/api/compte/connexion*`, `/api/compte/installation`, `/api/compte/jeton*`, `/api/compte/courriel/verifier`, `/api/compte/pas-moi/lien`, `/api/compte/deconnexion`), webhooks des workflows (`/hook/<id>`, preuve HMAC ou jeton obligatoire), fichiers de `web/` et `socle/web/` (tout segment commençant par un point → 404). Jeton d'accès : `/api/agent/*` (questions seulement). Session, par rôle déclaré sur chaque route : lecture, membre, administrateur ; la table complète est produite par l'essai de balayage des routes, 107 routes propres au Hub en plus de celles du socle.

Données : `hub.db` (comptes, sessions, jetons hachés, journal chaîné, services, workflows et exécutions, conversations de l'assistant par compte, quotas, usages de l'IA, secrets scellés — sensibilité : personnelle), logos ré-encodés ; volume `hub-data`, dossier 0700, base 0600 ; clés maîtresses hors volume.

Tiers : fournisseurs d'IA et de voix choisis par l'exploitant, messageries (Telegram, Discord, Slack, ntfy, Gotify, Pushover), GitHub (catalogue), sites des services connus (icônes), relais SMTP de l'exploitant ; toute sortie passe par la liste des destinations autorisées et le classement anti-SSRF.


## Appendix B sweep
Relancé à chaque génération de ce fichier (bash, LC_ALL=C.UTF-8) ; un résultat différent de celui qui a été relu arrête la génération. B.5 est dans NO-VIBE.md.

| # | Commande | Résultat | Justification |
|---|---|---|---|
| B.1.1 | `git log --all --format='%an <%ae>' \| sort -u` | `CodexX64 <CodexX64@users.noreply.github.com>` | le pseudonyme seul |
| B.1.2 | `git log --all --format='%cn <%ce>' \| sort -u` | `CodexX64 <CodexX64@users.noreply.github.com>` | le pseudonyme seul |
| B.1.3 | `git log --all --format='%B' \| rg -in 'co-authored-by\|generated (by\|with)\|assistant\|as an ai'` | 5 lignes | « assistant » est le nom d’une fonction du Hub, dans cinq messages ; aucune attribution |
| B.1.4 | `find . -path ./node_modules -prune -o \( -name .ai -o -name .cursor -o -name .aider -o -name .continue -o -name .windsurfrules \) -print` | 0 ligne |  |
| B.1.5 | `find . -path ./node_modules -prune -o -regextype posix-extended -regex '.*/(CLAUDE\|AGENTS?\|PROMPTS?\|GEMINI)\.md' -print` | 0 ligne | les deux fichiers de consignes du premier commit sont retirés de l’arbre (H12) |
| B.1.6 | `rg -n 'copilot-instructions' . -g '!SECURITY.md' -g '!NO-VIBE.md'` | 0 ligne |  |
| B.1.7 | `git grep -nIiE` avec le motif « chemins et réseaux personnels » de l’annexe B.1, hors des deux fichiers de conformité (texte exact dans le rapport hors dépôt : il contient des termes de la liste) | 24 lignes | valeurs d’exemple (domaine par défaut, plages de documentation, texte d’aide), vecteurs d’essai du classement anti-SSRF, chemins d’API génériques ; détail ligne à ligne dans le rapport hors dépôt |
| B.1.8 | `git log --all -p` filtré par le motif « infrastructure personnelle » de l’annexe B.1, compté (texte exact dans le rapport hors dépôt) | `71` | ajouts du premier commit local et leurs retraits (H12) ; ailleurs, un mot français qui contient le motif, des valeurs d’exemple et le nom d’un produit pris en charge |
| B.1.9 | `git log --all --format='%aI' \| rg -v '\+00:00' \| wc -l` | `0` | tous les commits en UTC |
| B.1.10 | `git log --all --format='%cI' \| rg -v '\+00:00' \| wc -l` | `0` |  |
| B.1.11 | `git log --all --name-only --format= \| sort -u \| rg -i '\.(png\|jpe?g\|pdf\|mp4\|gif\|webp\|ico)$'` | 0 ligne | aucun binaire dans tout l’historique : exiftool n’a rien à lire |
| B.2.1 | `gitleaks git --no-banner --redact . 2>&1 \| tail -1` | `no leaks found` | sept valeurs d’essai de l’historique relevées une à une dans `.gitleaksignore` |
| B.2.2 | `gitleaks dir --no-banner --redact . 2>&1 \| tail -1` | `no leaks found` | valeurs d’essai marquées `gitleaks:allow` ligne par ligne |
| B.2.3 | `git grep -nIiE '(api[_-]?key\|secret\|token\|password\|bearer)\s*[=:]\s*["'"'"'][^"'"'"']{8,}' -- . ':!SECURITY.md' ':!NO-VIBE.md'` | 37 lignes | valeurs de démonstration de la vitrine, valeurs d’essai (dont le secret TOTP d’exemple publié partout), noms de champs ; aucune vraie clé |
| B.2.4 | `git grep -nI -e '-----BEGIN (RSA\|EC\|OPENSSH\|PGP) PRIVATE' -- . ':!SECURITY.md' ':!NO-VIBE.md'` | 0 ligne |  |
| B.2.5 | `rg -ni 'sk_live\|service_role\|xox[baprs]-\|-----BEGIN' web socle/web` | 0 ligne | aucune étape de construction : le navigateur reçoit web/ et socle/web tels quels |
| B.2.6 | `curl -s -o /dev/null -w '%{http_code}' http://localhost:8190/.env` | `404` | instance locale ; tout segment caché répond 404 |
| B.3.1 | `rg -n 'dangerouslySetInnerHTML\|innerHTML *=\|outerHTML *=\|document\.write' . -g '!SECURITY.md' -g '!NO-VIBE.md'` | 2 lignes | le gabarit du socle : balisage écrit dans le code, valeurs posées en nœuds texte ou attributs (SEC-XSS-001) |
| B.3.2 | `rg -n 'eval\(\|new Function\(\|execSync\|child_process\|os\.system\|subprocess.*shell=True' . -g '!SECURITY.md' -g '!NO-VIBE.md'` | 10 lignes | essais et banc SMTP du socle ; un essai qui vérifie qu’un filtre « eval » est refusé ; docker.js lance docker, l’exercice de rotation lance le Hub, sans shell, arguments en tableau |
| B.3.3 | `rg -n '[^.]\bexec\(' . -g '!SECURITY.md' -g '!NO-VIBE.md' \| rg -v '\.exec\('` | 0 ligne |  |
| B.3.4 | `rg -n 'f"SELECT\|"SELECT .*" *\+\|\$\{.*\} *FROM\|\.raw\(\|query\(.*\+ *req\.' . -g '!SECURITY.md' -g '!NO-VIBE.md'` | 0 ligne | requêtes préparées seulement |
| B.3.5 | `rg -n 'Math\.random\|uuidv1\|new Random\(\)' . -g '!SECURITY.md' -g '!NO-VIBE.md'` | 7 lignes | délais et étalement des sondes, identifiants d’affichage, animation de l’orbe vocale, port d’un essai ; aucune valeur de sécurité |
| B.3.6 | `rg -n 'verify *= *False\|rejectUnauthorized: *false\|InsecureSkipVerify' . -g '!SECURITY.md' -g '!NO-VIBE.md'` | 0 ligne |  |
| B.3.7 | `rg -n 'jwt\.decode\(\|algorithms: *\[.*none\|verify: *false' . -g '!SECURITY.md' -g '!NO-VIBE.md'` | 0 ligne |  |
| B.4.1 | `curl -sI http://localhost:8190/ \| rg -i 'content-security\|x-content-type\|referrer-policy\|permissions-policy\|x-frame\|cross-origin' \| wc -l` | `7` | CSP à nonce sans joker, nosniff, no-referrer, DENY, COOP et CORP same-origin, Permissions-Policy ; HSTS dès que la requête est chiffrée (H1) |
| B.4.2 | `curl -sI http://localhost:8190/ \| rg -i '^(server\|x-powered-by\|x-aspnet\|x-generator)'` | 0 ligne |  |
| B.4.3 | `curl -sI -H 'Origin: https://evil.example' http://localhost:8190/api/status \| rg -i access-control` | 0 ligne | aucun CORS : même origine seulement |
| B.4.4 | `curl -sI 'http://localhost:8190/login?next=https://evil.example' \| rg -i '^location'` | 0 ligne | aucune redirection pilotée par paramètre |
| B.4.5 | `curl -s -o /dev/null -w '%{http_code}' http://localhost:8190/.git/config` | `404` |  |
| B.4.6 | `for i in $(seq 1 30); do curl -s -o /dev/null -w '%{http_code} ' -X POST http://localhost:8190/api/compte/connexion -H 'Content-Type: application/json' -H 'Origin: http://localhost:8190' -d '{"identifiant":"quelquun","motDePasse":"mauvais mot de passe"}'; done` | `401 401 401 428 428 428 428 428 428 428 428 428 428 428 428 428 428 428 428 428 428 428 428 428 428 428 428 428 428 428` | trois échecs, puis preuve de travail exigée (428) ; 429 et verrouillage au-delà |

Suivi du 2026-10-25 (0.14.1 → 0.14.2) : mise en page, constat d'usage — un trou sous « État du Hub » et sous la colonne de gauche de la vue d'ensemble, des écarts entre cartes différents d'une page à l'autre. Socle 8f9cf13 embarqué : un seul écart entre cartes (`--ecart`, 16 px, 12 px en Console et sur petit écran), deux colonnes finissant à la même ligne, et un contrôle de mise en page qui relève tout écart différent et toute colonne inégale. Le Hub prend cet écart partout (`web/app.css`) ; « État du Hub » occupe la hauteur de sa rangée ; les zones Cloudflare à ajouter deviennent des lignes (un nom de domaine long ne déborde plus de sa carte) ; une connexion d'IA et une alerte s'écrivent d'une pièce. Le parcours du navigateur suit les onglets de la page Thème et passe par la page IA. Interface seulement : aucune route, aucun contrôle ne change de statut. Essais : 217 du Hub, 77 du socle ; parcours du navigateur dans les quatre gammes (SOMA, Console, Exploitation, Lavande) : 289 écrans × largeurs chacune, 0 défaut, 0 erreur de console.

Suivi du 2026-10-25 (0.14.2 → 0.14.3) : socle 6f2c864 embarqué — la note d'en-tête d'une carte n'hérite plus de l'encadré `.note` (en-têtes de même hauteur), les pages Sécurité et Comptes du socle posent leurs cartes l'une sous l'autre (plus de carte étirée à vide à côté d'une longue), et le contrôle de mise en page ne compare plus une carte qui finit sa transition de survol, l'en-tête de page ni un sélecteur de vues. Un essai de la passerelle IA échouait une fois sur seize (son jeton faux pouvait égaler le vrai) : corrigé. Interface et essais seulement : aucune route, aucun contrôle ne change de statut. Essais : 217 du Hub, 77 du socle ; parcours du navigateur dans les quatre gammes (SOMA, Console, Exploitation, Lavande) : 289 écrans × largeurs chacune, 0 défaut, 0 erreur de console.

Suivi du 2026-10-25 (0.14.3 → 0.14.4) : constat d'usage — des versions poussées sur GitHub n'apparaissaient pas au catalogue après « Actualiser ». Le CDN de raw.githubusercontent garde la copie d'une branche jusqu'à cinq minutes et ignore le paramètre d'adresse que le Hub ajoutait pour le contourner (vérifié : réponse « HIT » sur une adresse jamais demandée). Le Hub lit désormais le commit au bout de la branche par le protocole git en HTTP (`github.com/<dépôt>.git/info/refs`, sans quota d'API, `server/registry.js:96`) et chaque fichier du dépôt à ce commit : le manifeste et le Compose d'une mise à jour viennent du même commit. Une sortie de plus, vers github.com, par le même contrôle de sortie que les autres (https, adresse publique, taille et délai bornés) ; si l'annonce est illisible, la lecture par la branche d'avant reste. Aucune route, aucun contrôle ne change de statut. Essais : 218 du Hub (dont la lecture au commit, branche et étiquette annotée), 77 du socle.

Suivi du 2026-10-30 (0.15.0) : assistant de configuration et nouveautés (socle 0a938a9). La première installation passe par l'assistant, obligatoire : Hub répond 428 à toute route du service tant qu'un administrateur ne l'a pas terminé ; après une mise à jour, seuls les réglages nouveaux sont demandés. Réglages de l'assistant : catalogue des extensions, adresse vue des services, plafonds de l'IA ; nouveau logo (onglet, barre, porte), plus ceux communs du socle. Chaque valeur est validée par la configuration même du service (lireConfig, contrôles croisés) ; un secret est scellé dans reglages.json (0600) sous la clé maîtresse, jamais rendu ; l'environnement l'emporte toujours. Routes /api/compte/reglages : administrateur, origine et anti-CSRF, renfort hors première configuration, journal reglages.poses sans valeur. Processus superviseur : relance du service quand un réglage change, signal d'arrêt transmis. Fenêtre « Quoi de neuf » (nouveautes.json, une fois par compte et par version). README : logo, affiche, captures, première configuration ; médias sans métadonnées. Aucun contrôle ne change de statut. Essais et parcours du navigateur repassés.

## Suivi du 2026-11-01 (0.15.1) : image et vérification sous l'organisation Nesaris

Aucun contrôle ne change de statut ; aucun changement de comportement du service.

- image de base Node 24.22.1, épinglée par empreinte : la 24.21.0 portait une faille critique exploitée (CVE-2026-111497) et plusieurs failles hautes ; paquets du système mis à jour à la construction ; npm, npx, corepack et yarn retirés des étapes d'exécution (aucune dépendance npm à l'exécution) ;
- vérification continue : gitleaks 8.30.1 en ligne de commande, archive contrôlée par son empreinte SHA-256, sur tout l'historique (l'action exigeait une licence sur un dépôt d'organisation) ; heure UTC acceptée sous ses deux écritures par git (« +00:00 » et « Z ») ; termes d'anonymat possibles en mot entier (« ~ ») ; liste d'anonymat posée au niveau de l'organisation Nesaris ; essais sous Node 24.22.1 ;
- images publiées sous ghcr.io/nesaris.

Contrôles rejoués avant livraison : gitleaks sur tout l'historique (aucune fuite), identité et fuseau des nouveaux commits (CodexX64, UTC, aucune mention d'outil), liste d'anonymat sur l'arbre et les nouveaux commits (aucune correspondance).

## Suivi du 2026-11-02 (0.15.2) : réglages détectés par l’assistant (socle 9f1d3f8)

Aucun contrôle ne change de statut. L’assistant (administrateur seulement, `GET /api/compte/reglages`) propose deux valeurs sans jamais les poser : le relais de confiance, reconnu à une requête qui porte un en-tête de transfert (X-Forwarded-For, X-Forwarded-Proto, Forwarded, Via) et vient d’une adresse privée — la plage Docker 172.16.0.0/12 pour un relais en conteneur, sinon son adresse seule ; une adresse publique n’est jamais proposée (`socle/src/http.js`, relaisVu) ; et l’adresse publique, prise par le navigateur sur l’adresse ouverte, seulement pour un nom (ni adresse IP ni localhost). Une valeur déjà posée n’est jamais remplacée ; la proposition passe par la même validation que toute saisie et l’administrateur la confirme. Essais : 218 du Hub, 93 du socle (dont relais proposé, jamais posé, et filtre des adresses publiques).
