-- Une version d'image choisie à la main (retour en arrière, essai) n'est plus
-- remplacée par celle du catalogue à la mise à jour suivante.
ALTER TABLE instances ADD COLUMN image_epinglee INTEGER NOT NULL DEFAULT 0;
