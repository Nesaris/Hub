-- La page Paiements est retirée : ses tables partent avec elle. Sans effet
-- sur une installation qui ne les a jamais eues.
DROP TABLE IF EXISTS releves;
DROP TABLE IF EXISTS depenses;
DROP TABLE IF EXISTS rattachements;
DROP TABLE IF EXISTS cartes;
DROP TABLE IF EXISTS modeles_cartes;
