-- Quotas du jour par compte (ou par jeton d'accès) pour ce qui coûte :
-- questions à l'assistant, voix, essais d'IA, lancements de workflows.
CREATE TABLE IF NOT EXISTS quotas (
  cle TEXT NOT NULL,
  jour TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (cle, jour)
);

-- Le plafond quotidien de l'IA relit les 24 dernières heures à chaque appel.
CREATE INDEX IF NOT EXISTS ai_usage_ts ON ai_usage(ts);
