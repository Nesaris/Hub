-- Chaque compte a sa conversation avec l'assistant : ses questions et ses
-- plans ne sont ni montrés aux autres, ni envoyés au modèle pour eux.
ALTER TABLE agent_plans ADD COLUMN compte TEXT;
CREATE INDEX IF NOT EXISTS agent_plans_compte ON agent_plans(compte, created);
