-- Jetons d'accès : un programme (un banc d'essai, un script) parle à
-- l'assistant sans compte humain ni second facteur. Seule l'empreinte est
-- gardée ; la portée limite ce qu'il ouvre.
CREATE TABLE IF NOT EXISTS jetons (
  id TEXT PRIMARY KEY,
  nom TEXT NOT NULL,
  prefixe TEXT NOT NULL,
  empreinte TEXT NOT NULL UNIQUE,
  portee TEXT NOT NULL,
  cree INTEGER NOT NULL,
  utilise INTEGER,
  revoque INTEGER
);
