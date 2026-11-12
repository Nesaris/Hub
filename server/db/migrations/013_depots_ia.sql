-- Les dépôts d'un compte GitHub lu par le catalogue qui n'ont pas de
-- manifeste du Hub (hub.json). L'IA du Hub peut les rendre compatibles quand
-- leur licence le permet : ce qu'elle a vu, décidé et produit est gardé ici,
-- figé sur le commit lu. Rien n'est écrit dans le dépôt d'origine.
CREATE TABLE depots_ia (
  repo TEXT PRIMARY KEY,             -- propriétaire/nom, tel que GitHub l'écrit
  source TEXT NOT NULL,              -- le registre qui l'a trouvé (github-user:compte)
  ref TEXT NOT NULL,                 -- branche par défaut
  sha TEXT,                          -- commit lu à la dernière actualisation
  pousse INTEGER,                    -- dernière poussée annoncée par GitHub (ms)
  description TEXT NOT NULL DEFAULT '',
  etoiles INTEGER NOT NULL DEFAULT 0,
  licence TEXT,                      -- identifiant SPDX annoncé par GitHub, ou null
  etat TEXT NOT NULL DEFAULT 'nouveau', -- nouveau · refuse · adapte · echec · en-cours
  raison TEXT NOT NULL DEFAULT '',
  adapte_sha TEXT,                   -- commit sur lequel l'adaptation a été faite
  ext_id TEXT,                       -- l'extension produite
  detail TEXT NOT NULL DEFAULT '{}', -- licence lue, obligations, modèle, fichiers lus
  maj INTEGER NOT NULL
);
CREATE INDEX depots_ia_source ON depots_ia(source);
