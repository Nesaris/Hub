CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  recovery TEXT NOT NULL DEFAULT '[]',
  created INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  mfa_ok INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  ip TEXT
);

CREATE TABLE audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);

CREATE TABLE catalog (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  version TEXT NOT NULL,
  manifest TEXT NOT NULL,
  origin TEXT NOT NULL,
  fetched INTEGER NOT NULL
);

CREATE TABLE instances (
  id TEXT PRIMARY KEY,
  ext_id TEXT NOT NULL,
  name TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL,
  url TEXT NOT NULL,
  stack INTEGER,
  config TEXT NOT NULL DEFAULT '{}',
  manifest TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',
  status_detail TEXT,
  providers TEXT NOT NULL DEFAULT '{}',
  created INTEGER NOT NULL
);

CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'Manuel',
  auto_key TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  graph TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);

CREATE TABLE workflow_versions (
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  graph TEXT NOT NULL,
  author TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (workflow_id, version)
);

CREATE TABLE executions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'live',
  trigger_node TEXT,
  trigger_data TEXT,
  state TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  started INTEGER NOT NULL,
  finished INTEGER
);
CREATE INDEX executions_wf ON executions(workflow_id, started DESC);

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  secret TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT '{}',
  created INTEGER NOT NULL
);

CREATE TABLE probe_samples (
  instance_id TEXT NOT NULL,
  probe_id TEXT NOT NULL,
  labels TEXT NOT NULL DEFAULT '',
  ts INTEGER NOT NULL,
  num REAL,
  txt TEXT,
  level TEXT NOT NULL DEFAULT 'ok'
);
CREATE INDEX probe_samples_idx ON probe_samples(instance_id, probe_id, labels, ts);

CREATE TABLE ai_connections (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT,
  instance_id TEXT,
  secret_ref TEXT,
  model TEXT,
  embed_model TEXT,
  roles TEXT NOT NULL DEFAULT '[]',
  position INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
);

CREATE TABLE ai_usage (
  ts INTEGER NOT NULL,
  connection_id TEXT NOT NULL,
  role TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated INTEGER NOT NULL
);

CREATE TABLE variables (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  secret INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE agent_plans (
  id TEXT PRIMARY KEY,
  request TEXT NOT NULL,
  plan TEXT NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  created INTEGER NOT NULL
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created INTEGER NOT NULL
);
