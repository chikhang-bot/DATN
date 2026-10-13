PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ADMIN', 'OPERATOR', 'VIEWER')),
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL,
  is_bootstrap INTEGER NOT NULL DEFAULT 0 CHECK (is_bootstrap IN (0, 1)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE UNIQUE INDEX idx_users_single_bootstrap ON users(is_bootstrap) WHERE is_bootstrap = 1;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  ip_hash TEXT,
  user_agent TEXT
);

CREATE INDEX idx_sessions_token ON sessions(token_hash, expires_at);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  api_key_hash TEXT NOT NULL UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  breaker_state TEXT NOT NULL DEFAULT 'UNKNOWN'
    CHECK (breaker_state IN ('OPEN', 'CLOSED', 'TRIPPED', 'UNKNOWN')),
  firmware_version TEXT,
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  voltage REAL,
  current REAL,
  active_power REAL,
  energy_kwh REAL,
  frequency REAL,
  power_factor REAL,
  temperature REAL,
  breaker_state TEXT NOT NULL CHECK (breaker_state IN ('OPEN', 'CLOSED', 'TRIPPED', 'UNKNOWN')),
  sampled_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);

CREATE INDEX idx_telemetry_device_time ON telemetry(device_id, sampled_at DESC);

CREATE TABLE commands (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('OPEN', 'CLOSE')),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'CLAIMED', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED')),
  requested_by TEXT NOT NULL REFERENCES users(id),
  requested_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  claimed_at INTEGER,
  claim_token TEXT,
  completed_at INTEGER,
  result_message TEXT,
  resulting_breaker_state TEXT
    CHECK (resulting_breaker_state IS NULL OR resulting_breaker_state IN ('OPEN', 'CLOSED', 'TRIPPED', 'UNKNOWN'))
);

CREATE INDEX idx_commands_device_queue ON commands(device_id, status, requested_at);
CREATE INDEX idx_commands_device_history ON commands(device_id, requested_at DESC);
CREATE UNIQUE INDEX idx_commands_one_active_per_device
  ON commands(device_id) WHERE status IN ('PENDING', 'CLAIMED');

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('USER', 'DEVICE', 'SYSTEM')),
  actor_id TEXT,
  event_type TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  details_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_audit_created_at ON audit_logs(created_at DESC);
