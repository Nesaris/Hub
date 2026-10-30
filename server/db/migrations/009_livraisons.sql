-- Webhooks déjà reçus, par identifiant de livraison : un envoi rejoué ou
-- relancé par l'expéditeur ne déclenche pas une seconde fois.
CREATE TABLE IF NOT EXISTS livraisons (
  cle TEXT PRIMARY KEY,
  t INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS livraisons_t ON livraisons(t);
