-- Des dossiers pour ranger les workflows : « MapMyLAN / Alertes ».
-- Le chemin vit sur le workflow ; la table garde aussi les dossiers vides,
-- créés à la main avant d'y mettre quoi que ce soit.
ALTER TABLE workflows ADD COLUMN dossier TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS workflow_dossiers (
  chemin TEXT PRIMARY KEY,
  created INTEGER NOT NULL
);
