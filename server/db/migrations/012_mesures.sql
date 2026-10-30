-- Mesures de la Vue d'ensemble : une ligne par tranche de cinq minutes
-- (moyennes des relevés de la minute), trente et un jours (retention.js).
-- Débits en octets par seconde, processeur et mémoire de la machine en
-- pourcentage, mémoire des extensions en octets.
CREATE TABLE mesures (
  t INTEGER PRIMARY KEY,
  hote_rx REAL, hote_tx REAL, hote_cpu REAL, hote_mem REAL,
  ext_rx REAL, ext_tx REAL, cont_rx REAL, cont_tx REAL, ext_cpu REAL, ext_mem REAL,
  svc_total REAL, svc_ok REAL
);
-- La même tranche par extension (« Hub » et « Autres conteneurs » à part).
CREATE TABLE mesures_groupes (
  t INTEGER NOT NULL,
  groupe TEXT NOT NULL,
  rx REAL, tx REAL, cpu REAL, mem REAL,
  PRIMARY KEY (t, groupe)
);
