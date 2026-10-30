# Code quality record — Hub

Method: Project Baseline Requirements & Security Manual, Part III (chapters 37-49)
Reviewed: 2026-09-29   ·   Owner: Codex64

## Behaviour freeze
Point de départ de la passe : `b18c76d`, juste après la phase de sécurité. Ensemble de référence : 199 essais (149 du Hub, ceux du socle embarqué), tous verts avant la passe, tous verts après, identiques un à un ; l’essai de reprise des comptes 0.5, ajouté ensuite, porte la suite à 200 ; le socle df0b6be (effacement de son propre compte, sauvegarde chiffrée) et l’essai d’effacement des questions d’un compte la portent à 203 (151 du Hub, 52 du socle), toujours verte. Aucun essai de caractérisation n’a été nécessaire : les parcours d’intégration couvrent déjà chaque route, par rôle, contre de vrais serveurs HTTP simulés.

Diff de l’API publique sur la passe : vide. `git diff b18c76d..c0cfaf8 -- server web socle`, lignes de code hors commentaires et lignes vides → 0 ; la passe n’a touché le code que par ses commentaires et une ligne vide.

Démarrage et parcours de bout en bout : `outils/parcours-navigateur.mjs` (installation par clé d’accès virtuelle, chaque page et les principaux dialogues à sept largeurs, 0 chevauchement, 0 erreur de console) ; `outils/exercice-rotation.mjs` (20 vérifications sur une instance lancée comme en production).

Changements de comportement voulus pendant la phase de sécurité, chacun étant le correctif (détail dans SECURITY.md) :

| Avant | Après | Raison |
|---|---|---|
| `/api/status` donnait version et état à tout le monde | `{ ok: true }` pour un appelant anonyme | SEC-HDR-004 |
| webhooks réglés sur « aucune vérification » | preuve HMAC ou jeton obligatoire | SEC-CSRF-005, SEC-API-008 |
| secret d’un webhook lisible par tout compte, en clair en base | scellé, montré une seule fois à sa création, remplaçable | REQ-CFG-002, SEC-DB-004 |
| nœud « Script JS » dans le processus du Hub | retiré, un graphe qui le porte est invalide | SEC-INJ-006 |
| requêtes sortantes vers toute adresse | liste des destinations internes, métadonnées de nuage refusées | REQ-WEB-005, SEC-CSRF-004 |
| un membre envoyait un message sans clic | un message sans clic seulement pour un administrateur | SEC-LLM-005 |
| historique de l’assistant commun à tous les comptes | une conversation par compte | SEC-AUTHZ-001 |
| une clé maîtresse différente passait inaperçue | le démarrage s’arrête ; rotation par le fichier `_ancienne` | REQ-CFG-005 |
| — | coupure d’urgence de l’IA et des workflows (503) | SEC-LOG-007 |

## Layer status
| Chapter | Subject | Status | What changed |
|---|---|---|---|
| 39 | Comment layer | DONE | densité moyenne 10 %, groupée autour des passages délicats ; les fichiers au-dessus de 25 % relus un à un (`server/ai/memoire.js`, `server/workflows/rangement.js`, `server/cli.js`, `server/config.js`) : des raisons et des contraintes, plus un mode d’emploi en tête de la ligne de commande ; deux commentaires réécrits dans la mémoire de l’assistant (un aparté d’historique devenu l’intention, une phrase qui citait une demande) ; aucune bannière, aucune narration, aucune excuse |
| 40 | Naming and vocabulary | DONE | aucun suffixe Manager/Handler/Provider ; noms génériques limités à `res` et `data` en portée courte ; deux vocabulaires assumés : le noyau d’origine en anglais (`Triggers`, `Engine`, `Registry`, `Vault`), tout ce qui est venu ensuite en français ; rien renommé, voir « Choix non faits » |
| 41 | Formatting, layout and whitespace | DONE | aucun formateur dans le dépôt, aucun introduit ; 2 espaces, apostrophes simples, points-virgules, lignes longues tolérées dans les gabarits déclaratifs de l’interface ; `git diff --check` depuis l’arbre vide : propre (une ligne vide de trop en fin de fichier corrigée) ; aucun caractère invisible |
| 42 | Gratuitous abstraction | DONE | aucune interface à une implémentation, aucune fabrique ; les modules ajoutés par la phase de sécurité ont chacun plusieurs appelants (`sortir` : 10 modules, `Quotas` : l’assistant, la voix et les lancements, `exigerOuvert` : l’IA, le moteur, les déclencheurs) |
| 43 | Defensive noise | DONE | 337 `catch` relus, tous autour d’une opération précise, classés ci-dessous ; aucun message vague, aucune journalisation d’entrée ou de sortie de fonction |
| 44 | Control flow and idiom | DONE | retours anticipés ; quatre boucles indexées, toutes voulues : un calcul de point fixe borné (`server/workflows/store.js`) et le traitement d’échantillons audio (`web/voix.js`, `web/voix-capture.js`) |
| 45 | Types, signatures and data shapes | DONE | JavaScript sans TypeScript ; un contrat par route : `HttpError(status, message, details)` levée au plus près, formatée une seule fois par le serveur |
| 46 | Dependencies, configuration, fitting the repository | DONE | aucune dépendance d’exécution ni de développement ; chaque variable de `.env.example` a un lecteur ; chaque clé de `server/config.js` est lue (`secureCookies` pour refuser une variable retirée) ; aucun import inutilisé (analyse des liaisons importées) |
| 47 | Tests | DONE | une recherche sans usage et son assertion vide retirées ; la politique d’autorisation écrite dans l’essai de balayage ; cinq cassures volontaires, chacune détectée (ci-dessous) |
| 48 | Documentation, furniture and version control | DONE | README : ce que fait vraiment le mode Validation ; `docs/ETAT.md` remis à l’état de la 0.6.0 ; `.gitignore`, `LICENSE`, `Dockerfile` et la vérification CI (`npm test`) contrôlés ; un sujet par commit, sans mention d’outil |

`catch` restants, par raison :

| Raison | Nombre | Où |
|---|---|---|
| valeur de repli explicite (donnée externe illisible, objet disparu, service absent) | 95 | `outils/`, `server/ai/agent.js`, `server/ai/cerveau.js`, `server/ai/gateway.js`, `server/ai/widgets.js`, `server/capabilities.js`, `server/destinations.js`, `server/docker.js` et 20 autres |
| montrée à l’écran, avec sa cause | 75 | `socle/`, `web/app.js`, `web/editor.js`, `web/lib.js`, `web/voix.js` |
| journalisée, ou portée dans l’état du service | 57 | `server/ai/agent.js`, `server/ai/cerveau.js`, `server/ai/gateway.js`, `server/ai/journal.js`, `server/ai/memoire.js`, `server/capabilities.js`, `server/http/api.js`, `server/http/server.js` et 8 autres |
| sans effet voulu, la raison écrite dans le bloc | 49 | `server/ai/agent.js`, `server/ai/gateway.js`, `server/destinations.js`, `server/docker.js`, `server/logos.js`, `server/main.js`, `server/manifest/template.js`, `server/runtime.js` et 9 autres |
| relevée, traduite en erreur du domaine (HttpError, ErreurHttp) ou transmise | 44 | `server/ai/agent.js`, `server/ai/gateway.js`, `server/cli.js`, `server/db/index.js`, `server/destinations.js`, `server/docker.js`, `server/http/api.js`, `server/image.js` et 9 autres |
| tâche d’arrière-plan facultative : son échec n’a rien à montrer, l’action suivante le montre | 13 | `socle/`, `web/app.js`, `web/editor.js`, `web/lib.js` |
| rapportée dans le résultat de l’étape | 4 | `server/ai/agent.js`, `server/http/api.js` |

## Tests
Cassures volontaires (REQ-CODE-005) : chacune posée seule, l’essai lancé, le fichier rétabli.

| Cassure | Fichier | Essai qui échoue |
|---|---|---|
| une adresse du réseau privé passe pour publique | `server/sortie.js` | trois essais de `test/sortie.test.js`, dont « classement des adresses » |
| un webhook libre entre sans signature | `server/triggers.js` | « webhook libre signé » |
| une route d’administration ouverte aux membres | `server/http/api.js` | « autorisation : chaque route balayée… » — non détectée au premier essai : le balayage relisait les rôles dans le routeur ; la liste des routes d’administration est maintenant écrite dans l’essai |
| la coupure d’urgence ne coupe plus rien | `server/coupure.js` | « coupure d’urgence : workflows et IA hors ligne… » |
| la rotation de SOCLE_CLE ne rescelle pas les TOTP | `socle/src/comptes.js` | « rotation de SOCLE_CLE… » |

Les faux services sont de vrais serveurs HTTP ; la seule couture est le transport de `sortir()`, à la frontière du réseau. Les essais portent sur les frontières et les chemins d’erreur : routes par rôle, corps géants, champs inconnus, fichiers cachés, adresses internes, webhooks sans preuve, livraisons rejouées, images piégées, quotas, fuseau horaire, rotation des clés.

## Repository style profile
Node 24, modules ES, aucune dépendance. Serveur : `Routeur` du socle, `node:sqlite` avec requêtes préparées, `crypto`. Interface : DOM construit par le gabarit `html` du socle et `poser`, jamais de balisage injecté avec une donnée. Vocabulaire : français pour le domaine et tout ce qui est récent, anglais pour le noyau d’origine. Erreurs : `HttpError(status, message, details)`, message écrit pour l’utilisateur ; le socle garde `ErreurHttp` et ne montre jamais le texte d’une erreur imprévue. Configuration : `lireConfig` sur un schéma, arrêt au démarrage à la première incohérence, secrets par `_FILE`. Journaux : `log.*` pour l’exploitation, `audit.write` pour qui a fait quoi (chaîné, copié sur la sortie standard). Frontières : `server/` (http, ai, workflows, manifest, auth, db), `web/`, `socle/` (commun embarqué, modifié dans son propre dépôt seulement), `test/`, `outils/`. Aides reprises plutôt que réécrites : `sortir`, `valider` et `avecSchemas`, `Debit`, `Vault.seal`/`open`, `audit.write`, `formulaire`, `confirmBox`, `pulse`.

## Detection sweep
Relancé à chaque génération de ce fichier (bash, LC_ALL=C.UTF-8) ; un résultat différent de celui qui a été relu arrête la génération. Annexe B.5 et contrôles des chapitres 41 à 48, sur tout le dépôt hors des deux fichiers de conformité.

| # | Commande | Résultat | Justification |
|---|---|---|---|
| B.5.1 | `rg -n '^\s*(#\|//)\s*(Step \d\|Initialize\|Loop through\|Create (a\|an\|the)\|Return the\|Set the\|Get the\|Check if\|Now we\|First,\|Finally,)' . -g '!SECURITY.md' -g '!NO-VIBE.md'` | 0 ligne |  |
| B.5.2 | `rg -n '^\s*(//\|#\|\*)\s*(Étape \d\|Initialise\|On boucle\|Boucle sur\|Retourne (le\|la\|les\|l.)\|Crée (un\|une\|le\|la)\|Vérifie si\|Maintenant,\|D.abord,\|Enfin,)' . -g '!SECURITY.md' -g '!NO-VIBE.md'` | 0 ligne | la même recherche dans la langue du dépôt |
| B.5.3 | `rg -n '^\s*(#\|//)\s*[-=*_#]{10,}' . -g '!SECURITY.md' -g '!NO-VIBE.md'` | 0 ligne |  |
| B.5.4 | `rg -n 'simplified (implementation\|version)\|in a (real\|production) (system\|app)\|for (demo\|illustration) purposes\|this is just an example' . -g '!SECURITY.md' -g '!NO-VIBE.md'` | 0 ligne |  |
| B.5.5 | `rg -n --pcre2 '[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}\x{2B00}-\x{2BFF}]' . -g '!SECURITY.md' -g '!NO-VIBE.md' \| wc -l` | `50` | contenu du produit : les pictogrammes des messages que l’assistant envoie sur Telegram et affiche (réflexion, action en cours, réponse reçue, bilans, tuiles de chiffres), les marques de réussite et d’échec de l’installeur et du terminal d’installation, les essais qui les vérifient ; un commentaire n’en porte que pour citer ce contenu |
| B.5.6 | `rg -n '\b(def\|function\|func\|fn)\s+\w*(process\|handle\|manage\|perform\|execute\|do)_?\w*\s*\(' . -g '!SECURITY.md' -g '!NO-VIBE.md'` | 2 lignes | faux positifs : `domaineValide` et `dedoublonne`, mots français qui commencent par « do » ou « de » |
| B.5.7 | `rg -o '\b\w+(Manager\|Service\|Handler\|Provider\|Factory\|Helper\|Util\|Wrapper\|Processor\|Engine)\b' . -g '!SECURITY.md' -g '!NO-VIBE.md' \| cut -d: -f2- \| sort -u \| tr '\n' ' '` | `AudioWorkletProcessor`, `enService` | aucune classe à suffixe : le mot français « Service » dans des noms composés (`enService`, `adresseService`…) et l’API du navigateur `AudioWorkletProcessor` |
| B.5.8 | `find . -path ./node_modules -prune -o -type f -regextype posix-extended -regex '.*/(utils?\|helpers?\|common\|misc\|shared)\.(py\|ts\|js\|go\|rb\|java)' -print` | `./server/util/common.js` | gardé, voir « Choix non faits » |
| B.5.9 | `rg -n '\b(data\|result\|output\|temp\|tmp\|res\|ret\|val\|obj\|item)\b\s*=' . -g '!SECURITY.md' -g '!NO-VIBE.md' \| wc -l` | `56` | `res` pour la réponse HTTP et `data` pour une charge JSON de forme inconnue, dans des portées de quelques lignes ; aucun nom générique sur une donnée du domaine |
| B.5.10 | `rg -n 'catch\s*\(\s*(e\|err\|error)\s*\)\|catch\s*\{' . -g '!SECURITY.md' -g '!NO-VIBE.md' \| wc -l` | `218` | relus un à un avec les `.catch(` : 337 au total, par raison ci-dessous |
| B.5.11 | `rg -n 'An error occurred\|Something went wrong\|Unexpected error\|Une erreur est survenue\|Quelque chose s.est mal passé' . -g '!SECURITY.md' -g '!NO-VIBE.md'` | 0 ligne |  |
| B.5.12 | `rg -n -A2 'except .*:\s*$' . -g '!SECURITY.md' -g '!NO-VIBE.md' \| rg -n 'pass$\|return None$\|return False$'` | 0 ligne | aucun Python |
| B.5.13 | `rg -n 'logger\.(info\|debug)\(f?["\x27](Starting\|Entering\|Finished\|Exiting\|Called)' . -g '!SECURITY.md' -g '!NO-VIBE.md'` | 0 ligne |  |
| 41.2.1 | `rg -n --pcre2 '[\x{200B}-\x{200D}\x{FEFF}\x{00A0}\x{2028}\x{2029}]' . -g '!SECURITY.md' -g '!NO-VIBE.md'` | 0 ligne | aucun caractère invisible ; la ponctuation typographique française (« », ’, …) est celle de tout le dépôt |
| 45.1.1 | `rg -n ':\s*any\b\|as unknown as' . -g '!SECURITY.md' -g '!NO-VIBE.md'` | 0 ligne | JavaScript, sans TypeScript |
| 47.1.1 | `rg -n 'assert\.ok\(true\)\|toBeDefined\(\)\|assert\(true\)' . -g '!SECURITY.md' -g '!NO-VIBE.md'` | 0 ligne |  |
| 48.3.1 | `rg -n -i 'your-api-key-here\|TODO: implement\|FIXME: AI\|lorem ipsum\|example\.com/api' . -g '!SECURITY.md' -g '!NO-VIBE.md'` | 0 ligne |  |
| 48.3.2 | `rg -n -i 'placeholder' . -g '!SECURITY.md' -g '!NO-VIBE.md' \| wc -l` | `40` | attributs `placeholder` des champs de l’interface, et le champ `placeholder` des manifestes (texte d’aide, adresses de la plage de documentation) |
| 48.3.3 | `rg -n '\b(TODO\|FIXME\|XXX\|HACK)\b' . -g '!SECURITY.md' -g '!NO-VIBE.md'` | 0 ligne |  |
| 48.4.1 | `git log -n 200 --format='%B' \| rg -i 'co-authored-by\|generated with'` | 0 ligne |  |

## Report (chapter 49.6)
Comptes : 2 commentaires réécrits, 1 ligne vide de fin de fichier retirée, 0 abstraction repliée (aucune n’était gratuite), 1 assertion vide et 1 variable morte retirées d’un essai, 1 essai renforcé, 0 dépendance retirée (il n’y en a aucune), 2 documents remis à jour. Fichiers laissés tels quels : tous les autres — leur densité de commentaires, leurs noms et leur gestion d’erreurs relèvent du profil ci-dessus.

Défauts réels trouvés pendant la passe, corrigés dans leurs propres commits : l’essai d’autorisation ne fixait pas la politique elle-même (`0cb6cf4`) ; le README promettait qu’aucun plan ne partait sans clic, faux en mode Autonome et pour un message d’administrateur (`66841e9`) ; `docs/ETAT.md` décrivait la 0.3.1 (`66841e9`).

Choix non faits, et pourquoi :
- `server/util/common.js` garde son nom : soixante lignes de primitives transversales (journal d’exploitation, `HttpError`, identifiants, durées, comparaison à temps constant, masquage), présentes depuis la première version et importées par 28 modules. Les éclater déplacerait 28 imports sans changer une ligne de comportement ; le chapitre 46.9 demande de respecter ce qui existe.
- Les noms anglais du noyau d’origine restent : les franciser toucherait la moitié du serveur pour une uniformité que le manuel désigne lui-même comme une marque.
- Aucune couche de types : le dépôt est en JavaScript sans étape de construction.

Commits de la passe :
- `8b709db commentaires : la mémoire de l'assistant dit son intention, plus son histoire`
- `66841e9 docs : le README dit ce que fait vraiment le mode Validation ; état de la 0.6.0 à jour`
- `ce7b2b2 outils : exercice de rotation des clés maîtresses de bout en bout, sur une instance jetable lancée comme en production`
- `8b5f169 SECURITY.md : rotation exercée de bout en bout (REQ-CFG-005), émetteur de chaque secret`
- `9b15ecc essais : une recherche sans usage et son assertion vide retirées du test des noms en double`
- `0cb6cf4 essais : les routes d'administration écrites dans l'essai d'autorisation ; en relâcher une par erreur le fait échouer`
- `c0cfaf8 mise en forme : une ligne vide de trop en fin de fichier`

Commits suivants, hors de la passe (essais, socle, confidentialité, documentation) ; la suite est relancée après eux :
- `9d497b5 NO-VIBE.md : la relecture du code selon la partie III du manuel, avec ses mesures`
- `77b8883 essais : la reprise des comptes 0.5 couverte — empreinte scrypt relue puis réécrite, TOTP scellé, code d'appairage retiré`
- `7c0e6a2 docs : nombre d'essais à jour`
- `6a6be6d socle df0b6be : suppression de son propre compte sous renfort, refus d'origine et de jeton anti-CSRF journalisés, sauvegarde chiffrée pour une clé publique`
- `2ed5b14 confidentialité : les questions et les quotas d'un compte partent avec lui, l'export les lui rend`
- `e51b9e4 docs : nombre d'essais à jour`

## Verification (chapter 49)
- [x] Full suite passes and matches the baseline — 199 essais, les mêmes avant et après la passe ; 203 avec les essais ajoutés ensuite
- [x] Public API diff empty — lignes de code modifiées hors commentaires et lignes vides dans `server web socle` : 0
- [x] Characterisation tests deleted after use — aucun n’a été écrit
- [x] Read-aloud test passed — `server/ai/memoire.js`, seul fichier de code dont le texte a changé, relu de bout en bout
- [x] Blind-comparison test passed — ses commentaires ont la forme de ceux de `server/sortie.js` et `server/triggers.js`
- [x] Commit history: one concern per commit, repository style, no attribution trailers
- [x] REQ-CODE-001 to REQ-CODE-006 all PASS

## Suivi du 2026-10-19 (0.11.0 → 0.12.1)
Quatre commits de sécurité (pont des outils, passerelle IA des services, contrat) et la version, chacun d'un seul sujet, avec ses essais ; 211 essais verts. Surface publique : la passerelle répond désormais 403 à ce qu'elle ne relaie plus, et 429 au-delà du débit d'un service ; le pont exige le jeton du Hub. Aucun autre changement de comportement.

## Suivi du 2026-10-20 (0.12.1 → 0.13.0)
Une fonction ajoutée (une extension renommée proposée en mise à jour du service installé sous l'ancien nom), en commits d'un sujet : schéma et validateur, registre, routes de Relay, Docker, services, interface, documentation, version. Comportement existant inchangé : une extension sans `replaces` suit exactement le chemin d'avant ; la suite de 0.12.1 passe telle quelle (211 essais), plus 6 essais du remplacement (succès, échec et retour, refus avant tout arrêt, routes, borne du registre, schéma). Style du dépôt repris : noms français du domaine (`remplacantDe`, `remplacer`, `defaireRemplacement`, `renommerRoutes`), erreurs `HttpError` avec la cause en clair, commentaires qui disent une raison, aides existantes réutilisées (`publier`, `redeploy`, `configOf`, `sealFields`, `imagesEnService`).

## Suivi du 2026-10-23 (0.13.0 → 0.14.0)
Trois commits d'un sujet : socle embarqué, serveur (niveaux de gamme dans `theme.js`, `niveauGamme` dans `services.js`), page Thème. La page garde ses appels (`GET`/`PUT /api/theme`, même corps) ; l'état du formulaire ne garde que les choix propres (absent = suit le thème global). 217 essais verts.
