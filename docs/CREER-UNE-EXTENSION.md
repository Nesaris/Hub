# Rendre un service installable par le Hub

Un service devient une extension quand son dépôt contient :

1. `hub.json` à la racine, conforme à `hub-extension.schema.json`. Le plus simple est de partir de `exemple-docker-control.hub.json` (service installé par le Hub) ou de `exemple-ollama.hub.json` (service qui tourne ailleurs), puis de le valider contre le schéma.
2. `deploy/compose.hub.yml`, seulement si le service peut être installé sur la machine du Hub.

Rien d'autre à faire : le registre par défaut, `github-user:CodexX64`, parcourt les dépôts publics du compte (hors forks et archives) et retient ceux qui ont un `hub.json` à la racine de leur branche par défaut. Le catalogue se met à jour avec **Extensions → Actualiser**.

Autres sources possibles dans **Extensions → Registres** :

| Source | Usage |
| --- | --- |
| `github-user:compte` | Tous les dépôts d'un compte. Limite de l'API GitHub : 60 requêtes par heure sans jeton. |
| `github:compte/dépôt@branche` | Un seul dépôt : son `index.json` s'il existe (plusieurs extensions, empreintes sha256), sinon son `hub.json`. |
| `https://…/index.json` | Un index hébergé ailleurs. |
| `dir:/chemin` | Un dossier local, pour tester. |

## Deux façons de l'ajouter au Hub

| Mode | Quand | Ce que fait le Hub |
| --- | --- | --- |
| Installé ici (`install.type: "compose"`) | Le service tourne en conteneur sur la machine du Hub. | Il télécharge le Compose, remplace les variables, génère les secrets, lance `docker compose up`, attend le test de santé et exécute `postInstall`. |
| Distant (`install.remote.supported: true`) | Le service tourne sur une autre machine : Ollama sur un PC avec GPU, docker-control sur un autre nœud… | Il demande l'adresse et, si besoin, le jeton. Il teste la santé et enregistre l'instance. Aucun conteneur n'est créé. |
| Externe (`install.type: "external"`) | Logiciel tiers sans Compose fourni (Ollama). | Même parcours que le mode distant. |

L'API est toujours appelée via `{{service.url}}`, avec le jeton `{{service.token}}` :

- en mode installé, c'est la clé `api.auth.localToken` (générée par le Hub) ;
- en mode distant, c'est la clé `api.auth.remoteToken` (collée par l'utilisateur).

## Variables du Compose

| Variable | Valeur |
| --- | --- |
| `{{service.host}}` | Nom du conteneur, `hub-<instance>`. C'est aussi son nom sur le réseau du Hub. |
| `{{port.<nom>}}` | Port conteneur déclaré dans `install.ports`. |
| `{{hostport.<nom>}}` | `127.0.0.1:81xy`, si le port doit être publié sur l'hôte. |
| `{{volume.<nom>}}` | `hub-<instance>-<nom>`. |
| `{{config.<CLE>}}` | Valeur de configuration. Les secrets sont générés par le Hub. |
| `{{hub.network}}` | Réseau Docker partagé (`hub_net`), à déclarer `external: true`. |
| `{{hub.tz}}` | Fuseau de l'utilisateur (donné par son navigateur), `UTC` à défaut. À passer en `TZ`. |
| `{{hub.theme}}` | Gamme de l'interface choisie pour ce service dans la page Thème (`soma` ou `console`) : la gamme commune, ou celle choisie pour lui. À passer en `SOCLE_THEME` : quand elle change, le Hub redéploie chaque service dont la pile pose `SOCLE_THEME`. Un service qui ne la lit pas garde son apparence. |

Le conteneur doit rejoindre `{{hub.network}}` et porter `container_name: {{service.host}}`.

`minHubVersion` est vérifié à chaque installation et mise à jour : un Hub plus ancien refuse le service et dit lequel il demande. Une extension qui lit `{{hub.theme}}` demande au moins la 0.7.0.

Une extension renommée déclare celle qu'elle remplace : `"replaces": [{ "id": "ancien-id", "config": { "ANCIENNE_CLE": "NOUVELLE_CLE" } }]` (Hub 0.13.0 et plus, à poser aussi en `minHubVersion`). Un service installé depuis l'ancienne se voit proposer la nouvelle en mise à jour : même instance, mêmes réglages (les clés renommées gardent leur valeur), même clé maîtresse. S'il portait le nom de l'ancienne extension, il prend celui de la nouvelle : ses volumes sont copiés sous le nouveau nom (l'ancien reste intact), ses routes de Relay suivent avec leur mode, et un échec ramène tout comme avant. Le remplaçant doit venir du même registre que l'extension qu'il remplace, et ne peut pas demander de permission sensible de plus.

Le Hub refuse toujours `privileged: true` et le montage de `/var/run/docker.sock` : aucune déclaration ne les débloque. Si le service a besoin de Docker, déclare `permissions.dockerSocket: "proxy"`.

Deux réglages sont refusés **par défaut** et accordés seulement s'ils sont déclarés dans le manifeste et validés par l'utilisateur à l'installation :

| Déclaration | Effet |
| --- | --- |
| `permissions.hostNetwork: true` | autorise `network_mode: host` — nécessaire à un scanner ARP, par exemple |
| `permissions.capAdd: ["NET_RAW"]` | autorise ces capacités dans `cap_add`, et elles seules |

`ALL`, `SYS_ADMIN`, `SYS_MODULE`, `SYS_PTRACE`, `SYS_BOOT`, `SYS_RAWIO`, `DAC_READ_SEARCH` et `MKNOD` ne sont jamais accordées. L'écran d'installation affiche chaque permission demandée et ce qu'elle implique ; sans la case cochée, rien n'est installé.

Les images doivent être **publiées** : le Hub télécharge le Compose, pas le dépôt, donc `build:` ne fonctionne pas.

Utilise uniquement des volumes nommés : le Hub tourne lui-même en conteneur, donc un chemin de l'hôte ne désignerait pas le bon dossier.

## Déclencheurs, actions, sondes

**Déclencheurs**, selon le mode de livraison :

- **Webhook** : le Hub appelle `subscribe` avec `{{hub.webhookUrl}}` et `{{hub.webhookSecret}}`, puis vérifie la signature HMAC indiquée dans `signature`, obligatoire : un webhook non signé est refusé. Un en-tête `X-Hub-Delivery` (identifiant unique de l'envoi) évite qu'un envoi réessayé ou rejoué ne déclenche deux fois. `{{state.subscriptionId}}` reprend la valeur `select` de la réponse d'abonnement.
- **Interrogation** (`poll`) : le Hub appelle `request` tous les `interval`. Le premier passage ne sert qu'à mémoriser l'existant : seuls les éléments apparus ensuite déclenchent le workflow. La déduplication se fait par `dedupeKey`, et `cursor` est renvoyé dans `{{state.cursor}}`.
- **SSE ou WebSocket** : le Hub garde une connexion ouverte et se reconnecte automatiquement.

**Actions** :

- `risk: "destructive"` impose un nœud « Validation humaine » avant l'action. En mode test, l'action est simulée.
- Les paramètres absents sont pris dans la sortie du nœud précédent (`$json`) quand un champ porte le même nom, puis dans `default`.

**Sondes** :

- `kind` vaut `gauge`, `counter`, `state` ou `text`.
- `labels` produit une série par élément quand la réponse est une liste.
- `thresholds` (pour les nombres) et `states` (pour les états) fixent le niveau.

## Workflows automatiques

`autoWorkflows[].steps[].use` accepte :

- `trigger:<id>` et `action:<id>` : un élément du service lui-même ;
- `capability:<nom>` : l'action du service qui fournit la capacité, avec `capability` égal à ce nom ;
- `core:<nœud>` : un nœud intégré. `set-fields` est un raccourci vers `data.set`.

## Vérifier avant de publier

```bash
curl -fsSLO https://raw.githubusercontent.com/CodexX64/hub/main/docs/hub-extension.schema.json
npx --yes -p ajv-cli@5 -p ajv-formats ajv validate --spec=draft2020 --strict=false -c ajv-formats -s hub-extension.schema.json -d hub.json
```

`ajv-cli` ne lit que des fichiers locaux : le schéma se télécharge d'abord. La ligne `$schema` du manifeste est facultative, elle ne sert qu'aux éditeurs.

Pour tester sans publier, deux possibilités :

- ajouter `dir:/chemin/vers/un/registre` dans Extensions → Registres ;
- importer le manifeste dans Extensions → Registres. Un manifeste importé ne s'utilise qu'en mode distant.

## Gestion des comptes depuis le Hub (facultatif)

Un service peut laisser le Hub gérer ses comptes. Il le déclare dans `accounts`, et rien n'est deviné : le Hub n'appelle que ce qui est écrit là.

```json
"accounts": {
  "tokenKey": "ADMIN_TOKEN",
  "roles": ["admin", "operator", "viewer"],
  "adminRole": "admin",
  "fields": { "id": "$.id", "name": "$.username", "role": "$.role", "mfa": "$.mfaEnabled", "created": "$.createdAt", "lastSeen": "$.lastLogin" },
  "list":       { "method": "GET",    "path": "/api/users" },
  "create":     { "method": "POST",   "path": "/api/users", "body": { "username": "{{params.username}}", "password": "{{params.password}}", "role": "{{params.role}}" } },
  "update":     { "method": "PATCH",  "path": "/api/users/{{params.id}}", "body": { "role": "{{params.role}}" } },
  "password":   { "method": "POST",   "path": "/api/users/{{params.id}}/password", "body": { "password": "{{params.password}}" } },
  "requireMfa": { "method": "POST",   "path": "/api/users/{{params.id}}/mfa/exiger" },
  "remove":     { "method": "DELETE", "path": "/api/users/{{params.id}}" }
}
```

Trois règles :

- **Jeton distinct.** `tokenKey` désigne une clé de `config` de type `secret`, séparée du jeton de service. Le service reste libre de n'accorder ce pouvoir qu'à ce jeton-là, et de le révoquer seul.
- **Second facteur.** Le Hub exige un code TOTP à l'entrée de chaque service, valable cinq minutes et pour ce service uniquement.
- **Compte d'origine.** Le premier administrateur créé (le plus ancien `created` parmi les comptes portant `adminRole`) n'est jamais supprimable depuis le Hub : c'est par lui qu'on reprend la main.

Chaque création, modification, réinitialisation et suppression est écrite au journal d'audit du Hub.

Un service du socle les déclare ainsi : le Hub présente un jeton d'administration à lui seul (`SOCLE_JETON_ADMIN_HUB` dans le service), crée par **invitation** et réinitialise par **lien**. Aucun mot de passe ne passe par le Hub : la personne choisit le sien et ses facteurs.

```json
"accounts": {
  "tokenKey": "HUB_ADMIN_TOKEN",
  "roles": ["admin", "membre", "lecture"],
  "adminRole": "admin",
  "invitation": true,
  "fields": { "id": "$.id", "name": "$.identifiant", "role": "$.role", "mfa": "$.a2f", "created": "$.cree", "lastSeen": "$.derniere" },
  "list":   { "method": "GET",    "path": "/api/compte/hub/comptes" },
  "create": { "method": "POST",   "path": "/api/compte/hub/comptes", "body": { "identifiant": "{{params.username}}", "role": "{{params.role}}" } },
  "update": { "method": "PATCH",  "path": "/api/compte/hub/comptes/{{params.id}}", "body": { "role": "{{params.role}}" } },
  "reset":  { "method": "POST",   "path": "/api/compte/hub/comptes/{{params.id}}/reinit", "body": {} },
  "remove": { "method": "DELETE", "path": "/api/compte/hub/comptes/{{params.id}}" }
}
```

Le Hub joint à chaque appel l'opérateur (`X-Hub-Operateur`, repris au journal du service) et, pour les liens, l'adresse à laquelle il ouvre le service (`X-Hub-Adresse`).
