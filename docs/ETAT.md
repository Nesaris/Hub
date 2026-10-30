# État du Hub — version 0.7.0 (1er octobre 2026)

## Vérifié

| Vérification | Résultat |
| --- | --- |
| `npm test` | 157 essais du Hub et les essais du socle embarqué : unitaires, registre GitHub simulé, balayage des routes par rôle, et parcours complet contre de faux services docker-control, SYNAPSE, Ollama, Telegram et fournisseurs d'IA |
| Interface | Parcours complet dans Chromium (`outils/parcours-navigateur.mjs`) : installation par clé d'accès virtuelle, chaque page et les principaux dialogues à sept largeurs de 360 à 1920 px, sans chevauchement ni erreur de console |
| Sécurité | Les 258 contrôles du manuel Codex64 relus un à un : `SECURITY.md` |
| Installation Compose | Faite par le Hub lui-même, lancé dans un conteneur avec le socket Docker : installation, action, sonde, journaux, puis retrait avec volumes |
| `docker compose config` | Le `compose.yml` fourni est valide |
| Déploiement réel | Versions 0.5 installées sur une VM Debian 13 : image construite, proxy de socket épinglé par empreinte et fonctionnel, `docker version` répondu à travers le proxy. Ni la 0.6.0 ni la 0.7.0 n'y sont encore passées. |

**Pas vérifié** :

- Les appels aux vraies API Claude, OpenAI, Gemini et Kimi : les formats suivent leur documentation publique, mais aucune clé n'a servi aux tests.

## Fonctionnel (lots 1 à 4 du cahier des charges, lot 5 en partie)

**Socle**

- Comptes (socle commun) : mot de passe Argon2id, TOTP configuré par QR code généré sur place, clés d'accès WebAuthn, codes de secours ; un administrateur tient deux facteurs dont une clé d'accès. Premier compte créé avec un jeton d'installation.
- Sessions (socle commun) : cookies HttpOnly SameSite=Strict, CSRF sur toutes les écritures, renfort pour les actions sensibles, révocation depuis Compte → Sécurité, rôles admin, membre et lecture.
- Protections : limitation des tentatives, en-têtes de sécurité (CSP, X-Frame-Options…).
- Requêtes sortantes : une seule enveloppe pour tout le Hub (workflows, sondes, IA, registres, logos). http(s) seulement, adresse résolue puis contrôlée puis épinglée, redirections revérifiées, taille et délai bornés. Métadonnées de nuage et lien local toujours refusés ; réseau privé seulement vers un service connecté, une IA, un réglage d'exploitation ou une entrée de Réglages → Destinations internes ; un site public en https.
- Coffre AES-256-GCM, clé maîtresse en secret Docker hors du volume : secrets des services, des nœuds, des connexions IA, des variables et des webhooks. Les clés maîtresses se tournent au redémarrage, sans réinscription (README, « Tourner une clé »).
- Coupure d'urgence : l'IA ou les workflows hors ligne tout de suite, depuis Réglages ou la ligne de commande.
- Sauvegarde chiffrée de la base pour une clé publique RSA, relue seulement sur une autre machine (README, « Sauvegardes »).
- Journal d'audit chaîné par hachés, avec vérification.
- Thème : deux gammes du socle, SOMA et Console, choisies dans la page Thème, une pour tout ou une par service (le Hub compris), transmises par `{{hub.theme}}` ; un service qui la lit est redéployé quand sa gamme change.
- SQLite en WAL, migrations versionnées.

**Catalogue**

- Registres : compte GitHub entier (`github-user:`, chaque dépôt avec un `hub.json`), dépôt GitHub, URL ou dossier local, avec vérification sha256 facultative.
- Validateur JSON Schema maison.
- Import de manifeste.

**Services**

- Installation Compose : variables, secrets générés, `postInstall`, retour arrière en cas d'échec. Les images déjà présentes sur la machine ne sont pas retéléchargées (`docker compose pull --policy missing` tire quand même : le Hub interroge le démon image par image).
- Permissions : `privileged` et le socket Docker toujours refusés ; réseau de la machine et capacités seulement s'ils sont déclarés dans le manifeste et validés à l'installation, avec la liste des conséquences à l'écran.
- Connexion distante, avec test préalable et aide de configuration.
- Test de santé toutes les 30 s, journaux, réglages, retrait (volumes en option).

**Capacités**

- Blocage si une capacité requise manque, avec la liste des extensions qui la fournissent.
- Liens automatiques visibles comme workflows : `autoWorkflows`, et liens « dépendance » pour les capacités requises.

**Exécution des manifestes**

- Gabarits `{{ }}` sans `eval`, filtres, JSONPath.
- Authentification bearer ou en-tête ; requêtes limitées à l'hôte enregistré de l'instance.
- Options dynamiques (`optionsFrom`).

**Déclencheurs**

- Webhooks signés HMAC (ou jeton) : libres, et abonnements de service avec désabonnement ; limitation de débit, livraisons dédoublonnées ; le secret est montré une seule fois, à sa création, et se remplace depuis l'éditeur.
- Interrogation avec déduplication et curseur persistés.
- SSE et WebSocket avec reconnexion.
- Cron, intervalle, seuil de sonde (durée, retour à la normale), fin de workflow, événements du Hub.

**Sondes**

- Planification avec décalage aléatoire, niveaux warn et crit, séries par étiquettes, agrégats, rétention, page avec graphique.

**Moteur de workflows**

- Exécutions persistées et reprises au redémarrage ; branches, sorties nommées, fusion.
- Relances, délais, « en cas d'erreur » (arrêter, continuer ou sortie erreur).
- Attente longue ; validation humaine avec expiration.
- Compteur glissant, déduplication, limite de débit, sous-workflows, arrêt.
- Mode test (les actions destructives y sont simulées), rejeu depuis un nœud.
- Versions et restauration, export et import, secrets masqués.

**Nœuds intégrés**

- données (champs, regex, date, hash, clé-valeur) ;
- réseau (HTTP, port, DNS, Wake-on-LAN) ;
- sorties (ntfy, Discord, Slack, Telegram, webhook signé, journal) ;
- IA (conversation, résumé, classement avec sorties par catégorie, extraction JSON, embeddings).

**IA**

- Connexions : Ollama (URL ou instance du Hub, donc une autre machine possible), OpenAI, API compatibles OpenAI, Anthropic, Gemini et Kimi.
- Rôles, ordre de relais, test, liste des modèles, suivi de consommation.
- Agent : plan JSON vérifié, puis exécuté après validation. Trois niveaux d'autonomie.
- Protections de l'agent : les données sont encadrées par `<donnees>`, aucun secret n'est envoyé à l'IA, les outils inconnus sont écartés.

**Comptes des services**

- Page Utilisateurs : les services qui déclarent `accounts` dans leur manifeste, un par un.
- Entrée par second facteur, cinq minutes, par service ; jeton d'administration distinct du jeton de service, gardé dans le coffre.
- Lister, créer, changer un rôle, remplacer un mot de passe, exiger l'A2F, supprimer. Le compte administrateur d'origine est refusé à la suppression.
- Chaque action est journalisée.

**Secrets**

- Fiche par service (17 connus : Telegram, Cloudflare, Discord, ntfy, Gotify, Pushover, GitHub, GitLab, Proxmox, UniFi, Home Assistant, Grafana, Nextcloud, Twilio, OVH, Slack, SMTP) et mode personnalisé, depuis le bouton Secrets de l'assistant.
- Les valeurs sont scellées dans le coffre et ne ressortent jamais : ni la liste, ni le journal, ni l'assistant n'en voient une. L'assistant reçoit les NOMS des clés et les cite sous la forme `{{ $vars.NOM }}` ; le moteur remplace à l'exécution, une fois l'IA hors du coup.
- Un champ laissé vide ne perd pas ce qui était enregistré.

**Interface**

- Vue d'ensemble, extensions (catalogue, mes services, registres), workflows.
- Éditeur plein écran : palette avec recherche, glisser-déposer, zoom, ports nommés, suppression de liens, paramètres générés depuis les manifestes, exécutions en direct, onglet données, rejeu.
- Sondes, connexions, journal, réglages, assistant flottant. La question s'affiche dès l'envoi et reste visible si l'appel échoue ; « Nouvelle conversation » repart à vide sans rien supprimer, et sans traîner les échanges précédents dans le contexte du modèle. La réponse de l'assistant s'écrit à l'écran au fur et à mesure (Ollama, OpenAI et compatibles, Anthropic ; les autres répondent d'un bloc).
- Thème clair ou sombre, mises à jour en temps réel (SSE).
- Modales empilables : une fenêtre ouverte depuis une autre — le code du second facteur puis les comptes, une confirmation par-dessus une liste — ne fait plus disparaître celle qui l'a ouverte.
- Retour visuel sur les boutons qui appellent le serveur : roue pendant l'appel, puis coche ou croix, centrée dans le bouton.
- Le catalogue ne montre plus les extensions déjà installées ici ; celles qui acceptent une connexion distante y restent.
- Reprise du manifeste d'une instance depuis le catalogue, à la demande (bouton Manifeste). Les liens de capacité sont rejoués au passage, donc un `accepts` ajouté par une nouvelle version crée enfin son workflow automatique. Elle : les clés de configuration nouvelles que le Hub sait fabriquer lui-même sont semées au passage, les anciennes ne sont jamais retouchées.
- Redéploiement d'une pile installée ici (bouton Redéployer) : manifeste repris, Compose re-rendu, pile relancée, volumes intacts. C'est ce qui fait descendre une variable d'environnement ajoutée par une nouvelle version.

## À faire

1. **Claude Code et Codex** comme connexions IA (conteneur « agents » dédié) : non implémentés. En attendant, utilise les API Claude ou OpenAI.
2. **Mises à jour d'extensions** (nouveau tag → sauvegarde, pull, recreate, retour arrière) et **sauvegardes/restauration des volumes des services** : non implémentées (la base du Hub, elle, se sauvegarde). Le moteur de workflows n'a pas encore de nœud de sauvegarde.
3. **Routes Relay** : extension Relay (capacité `edge.routes`). Le Hub publie chaque service installé ici sous `<service>.<domaine de base>` avant son démarrage, et la page Connexions règle toutes les routes.
4. **Boucle sur les éléments** (diviser un tableau puis traiter chaque élément) : il n'y a ni nœud « Diviser » ni nœud « Agréger ». Contourne-le avec un sous-workflow.
5. **Nœuds absents** : SSH, mail (SMTP) et Matrix ne sont pas des nœuds intégrés. Passe par une extension (Poste pour le mail) ou par le nœud HTTP.
6. **Multi-nœuds Docker** (agent distant) : le Hub pilote uniquement le Docker de sa machine. Les autres machines se gèrent via les services distants (docker-control).
7. **Éditeur** : pas de sélection multiple, ni de copier-coller entre workflows, ni d'annuler/rétablir. La version enregistrée sert de point de retour.
8. **Assistant** : il n'enchaîne pas plusieurs appels d'outils de lecture. Il reçoit un instantané (services, sondes en alerte, workflows) et propose un plan en une fois.
9. **Mise en production** : les actions qui reviennent à l'exploitant (HTTPS, relais SMTP, réglages GitHub, sauvegardes hors de l'hôte…) sont listées dans `SECURITY.md`, « Human actions required ».
