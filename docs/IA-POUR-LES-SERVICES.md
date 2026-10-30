# L'IA du Hub, pour les services

Un service installé par le Hub qui déclare `llm.chat` (dans `requires` ou
`accepts`) reçoit dans `{{provider.llm.chat.url}}` l'adresse de la
**passerelle IA du Hub** dès que le Hub a au moins une IA dans sa page IA.
Derrière cette adresse : **toutes** les IA du Hub — Ollama, les fournisseurs
par clé d'API (Claude, GPT, Gemini, Kimi, Mistral, OpenRouter…), Claude Code
et Codex par abonnement — sous deux formes que les clients savent déjà parler.

```
http://hub:8101/ia/<jeton du service>
```

Le port 8101 n'existe que sur le réseau interne de la pile (`hub_net`) : il
n'est publié nulle part. Le jeton est propre à chaque service, dérivé de son nom
par un secret du Hub ; il est dans le chemin parce qu'un client Ollama n'envoie
pas d'en-tête d'autorisation. Le service n'a rien à configurer.

## API Ollama

| Route | Ce qu'elle rend |
|---|---|
| `GET /api/tags` | Les modèles du Hub ouverts au service (voir « Noms » ; les outils par abonnement seulement s'il est nommé dans `HUB_IA_SERVICES_OUTILS`) ; `details.family` vaut `locale`, `cloud` ou `abonnement`, `details.connexion` le nom de la connexion |
| `POST /api/chat` | Comme Ollama : `stream` vrai par défaut (NDJSON), `format: "json"`, `options.num_predict`, `options.temperature` |
| `POST /api/generate` | Idem, avec `prompt` |
| `POST /api/embed`, `/api/embeddings` | Par la connexion « embeddings » du Hub |
| `GET /api/version` | Répond, pour les clients qui vérifient |
| `GET /api/ps`, `POST /api/show` | Transmis tels quels au premier Ollama du Hub |
| tout autre `/api/…` | 403 : tirer, pousser, créer, copier ou supprimer un modèle reste à l'administrateur du Hub |

## API OpenAI

| Route | Ce qu'elle rend |
|---|---|
| `GET /v1/models` | Les mêmes modèles |
| `POST /v1/chat/completions` | `stream` (SSE), `max_tokens`, `temperature`, `response_format: {type: "json_object"}` |

## Noms

- Les modèles d'Ollama gardent leur nom nu (`qwen3.8:9b`) : un service qui
  parlait à Ollama continue de marcher sans rien changer.
- Les autres se nomment `connexion/modèle` : `claude-code/sonnet`,
  `kimi/kimi-k2-0905-preview`. La connexion est son nom dans la page IA, en
  minuscules, tirets à la place des espaces. `connexion/modèle` est aussi
  accepté pour un modèle d'Ollama.
- Sans modèle : celui de la connexion « workflows » du Hub.

Pour choisir un niveau (petit modèle local / gros modèle en nuage), lire
`details.family` dans `/api/tags` : `locale` tourne sur la machine, `cloud` et
`abonnement` partent chez un fournisseur.

## Ce qui s'applique

- Le plafond quotidien de l'IA du Hub, la coupure d'urgence (Réglages) et la
  bascule entre connexions sont ceux du Hub.
- Chaque appel est compté au nom du service (`service:<nom>`) dans la
  consommation de la page IA.
- Par service : 60 appels par minute et 1 000 par jour au plus
  (`HUB_IA_SERVICE_APPELS_MINUTE`, `HUB_IA_SERVICE_APPELS_JOUR`) ; au-delà, 429 :
  un service ne peut pas épuiser seul le plafond de tous.
- Le lien « service → IA du Hub · modèle » apparaît dans Workflows ; le modèle
  se change dans les réglages du service, ou dans ce lien.
- L'assistant du Hub n'a aucune route vers la passerelle.

## Pour ESSAIM

ESSAIM déclare déjà `requires: llm.chat` et lit `{{provider.llm.chat.url}}`
dans `OLLAMA_URL` : installé par le Hub, il reçoit la passerelle sans changer
une ligne. Ce qui lui reste à faire de son côté :

1. `src/llm.js` : ne plus supposer qu'un modèle est local — lire
   `details.family` de `/api/tags` ; `niveauDeTaille` peut classer `cloud` et
   `abonnement` au niveau 2 (les gros modèles).
2. `src/modeles.js` : le champ `fournisseur` d'un modèle vaut
   `details.connexion` plutôt que « ollama » en dur.
3. Le contexte des autres services (MapMyLAN, NEXARC, VIGIE, ProxLab…) : le
   Hub sait déjà relier une capacité déclarée dans `accepts` à son fournisseur
   et en donner l'adresse (`{{provider.network.inventory.url}}`…), et le lien se
   voit dans Workflows. Ce qui n'existe pas encore, c'est l'autorisation : seul
   SYNAPSE reconnaît un jeton dérivé par le Hub (`jetonCerveau`). Pour les
   autres, la voie sûre est de passer par les actions des services via le Hub
   (workflows), pas d'appeler leur API en direct.
