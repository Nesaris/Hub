-- Les variables se rangent par service : la saisie se fait par fiche
-- (Telegram, Cloudflare…) plutôt que clé par clé, et l'assistant peut citer
-- les noms d'un service sans jamais en voir les valeurs.
ALTER TABLE variables ADD COLUMN service TEXT;
ALTER TABLE variables ADD COLUMN label TEXT;
