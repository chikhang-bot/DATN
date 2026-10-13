PRAGMA foreign_keys = ON;

-- `devices` remains the authenticated ESP32-S3 gateway used by the API.
-- The tables below describe the physical Modbus nodes behind each gateway.
CREATE TABLE device_models (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  manufacturer TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE modbus_nodes (
  id TEXT PRIMARY KEY,
  gateway_device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  device_model_id TEXT NOT NULL REFERENCES device_models(id) ON DELETE RESTRICT,
  code TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  slave_id INTEGER NOT NULL CHECK (slave_id BETWEEN 1 AND 247),
  baud_rate INTEGER NOT NULL CHECK (baud_rate > 0),
  serial_config TEXT NOT NULL CHECK (serial_config IN ('8N1', '8E1', '8O1')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (gateway_device_id, code),
  UNIQUE (gateway_device_id, slave_id)
);

CREATE INDEX idx_modbus_nodes_gateway ON modbus_nodes(gateway_device_id, enabled);
CREATE INDEX idx_modbus_nodes_model ON modbus_nodes(device_model_id);

CREATE TABLE register_maps (
  id TEXT PRIMARY KEY,
  device_model_id TEXT NOT NULL REFERENCES device_models(id) ON DELETE CASCADE,
  code TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  function_code INTEGER NOT NULL CHECK (function_code IN (3, 4)),
  address INTEGER NOT NULL CHECK (address BETWEEN 0 AND 65535),
  register_count INTEGER NOT NULL CHECK (register_count BETWEEN 1 AND 60),
  data_type TEXT NOT NULL
    CHECK (data_type IN ('U16', 'S16', 'U32', 'S32', 'FLOAT32', 'BITFIELD')),
  word_order TEXT NOT NULL DEFAULT 'ABCD'
    CHECK (word_order IN ('ABCD', 'CDAB', 'BADC', 'DCBA')),
  scale REAL NOT NULL DEFAULT 1,
  offset_value REAL NOT NULL DEFAULT 0,
  unit TEXT NOT NULL DEFAULT '',
  poll_interval_ms INTEGER NOT NULL DEFAULT 2000 CHECK (poll_interval_ms >= 100),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  description TEXT NOT NULL DEFAULT '',
  UNIQUE (device_model_id, code)
);

CREATE INDEX idx_register_maps_model ON register_maps(device_model_id, enabled);

CREATE TABLE command_maps (
  id TEXT PRIMARY KEY,
  device_model_id TEXT NOT NULL REFERENCES device_models(id) ON DELETE CASCADE,
  code TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  function_code INTEGER NOT NULL CHECK (function_code IN (5, 6, 15, 16)),
  address INTEGER NOT NULL CHECK (address BETWEEN 0 AND 65535),
  write_value INTEGER NOT NULL CHECK (write_value BETWEEN 0 AND 65535),
  data_type TEXT NOT NULL DEFAULT 'U16' CHECK (data_type IN ('U16', 'S16', 'BITFIELD')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  description TEXT NOT NULL DEFAULT '',
  UNIQUE (device_model_id, code)
);

CREATE INDEX idx_command_maps_model ON command_maps(device_model_id, enabled);

-- Rules use normalized telemetry field names such as voltage_a, current_a,
-- frequency, temperature or breaker_state. register_map_id is optional so a
-- rule can also target a calculated metric stored in the wide telemetry table.
CREATE TABLE alarm_rules (
  id TEXT PRIMARY KEY,
  device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
  device_model_id TEXT REFERENCES device_models(id) ON DELETE CASCADE,
  register_map_id TEXT REFERENCES register_maps(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  metric_key TEXT NOT NULL COLLATE NOCASE,
  comparison_operator TEXT NOT NULL
    CHECK (comparison_operator IN ('GT', 'GTE', 'LT', 'LTE', 'EQ', 'NE', 'OUTSIDE')),
  threshold_value REAL NOT NULL,
  threshold_secondary REAL,
  severity TEXT NOT NULL CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
  cooldown_seconds INTEGER NOT NULL DEFAULT 60 CHECK (cooldown_seconds >= 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  description TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (comparison_operator != 'OUTSIDE' OR threshold_secondary IS NOT NULL)
);

CREATE INDEX idx_alarm_rules_metric ON alarm_rules(metric_key, enabled);
CREATE INDEX idx_alarm_rules_device ON alarm_rules(device_id, enabled);

CREATE TABLE alarm_events (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  modbus_node_id TEXT REFERENCES modbus_nodes(id) ON DELETE SET NULL,
  alarm_rule_id TEXT NOT NULL REFERENCES alarm_rules(id) ON DELETE RESTRICT,
  telemetry_id INTEGER REFERENCES telemetry(id) ON DELETE SET NULL,
  observed_value REAL,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'ACKNOWLEDGED', 'CLEARED')),
  triggered_at INTEGER NOT NULL,
  acknowledged_at INTEGER,
  acknowledged_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  cleared_at INTEGER,
  note TEXT NOT NULL DEFAULT ''
);

CREATE INDEX idx_alarm_events_device_time ON alarm_events(device_id, triggered_at DESC);
CREATE INDEX idx_alarm_events_status ON alarm_events(status, triggered_at DESC);
CREATE UNIQUE INDEX idx_alarm_events_one_open
  ON alarm_events(device_id, alarm_rule_id)
  WHERE status IN ('ACTIVE', 'ACKNOWLEDGED');

-- Catalog entries match the register addresses currently used by the firmware.
INSERT INTO device_models
  (id, code, name, manufacturer, description, created_at, updated_at)
VALUES
  ('model_mts5', 'MTS5', 'MTS5(LE)', '', 'Circuit breaker and electrical meter', unixepoch() * 1000, unixepoch() * 1000),
  ('model_pm3c92', 'PM3C92', 'PM3C-92', '', 'Three-phase power meter', unixepoch() * 1000, unixepoch() * 1000);

INSERT INTO register_maps
  (id, device_model_id, code, name, function_code, address, register_count, data_type, word_order, scale, unit)
VALUES
  ('reg_mts5_status', 'model_mts5', 'BREAKER_STATUS', 'Breaker status', 3, 515, 1, 'BITFIELD', 'ABCD', 1, ''),
  ('reg_mts5_voltage_a', 'model_mts5', 'VOLTAGE_A', 'Phase A voltage', 3, 256, 1, 'U16', 'ABCD', 0.01, 'V'),
  ('reg_mts5_voltage_b', 'model_mts5', 'VOLTAGE_B', 'Phase B voltage', 3, 257, 1, 'U16', 'ABCD', 0.01, 'V'),
  ('reg_mts5_voltage_c', 'model_mts5', 'VOLTAGE_C', 'Phase C voltage', 3, 258, 1, 'U16', 'ABCD', 0.01, 'V'),
  ('reg_mts5_current_a', 'model_mts5', 'CURRENT_A', 'Phase A current', 3, 259, 2, 'U32', 'ABCD', 0.01, 'A'),
  ('reg_mts5_current_b', 'model_mts5', 'CURRENT_B', 'Phase B current', 3, 261, 2, 'U32', 'ABCD', 0.01, 'A'),
  ('reg_mts5_current_c', 'model_mts5', 'CURRENT_C', 'Phase C current', 3, 263, 2, 'U32', 'ABCD', 0.01, 'A'),
  ('reg_mts5_neutral_current', 'model_mts5', 'NEUTRAL_CURRENT', 'Neutral current', 3, 265, 2, 'U32', 'ABCD', 0.01, 'A'),
  ('reg_mts5_active_power', 'model_mts5', 'ACTIVE_POWER', 'Total active power', 3, 281, 2, 'S32', 'ABCD', 0.01, 'kW'),
  ('reg_mts5_reactive_power', 'model_mts5', 'REACTIVE_POWER', 'Total reactive power', 3, 289, 2, 'S32', 'ABCD', 0.01, 'kvar'),
  ('reg_mts5_power_factor', 'model_mts5', 'POWER_FACTOR', 'Total power factor', 3, 297, 1, 'U16', 'ABCD', 0.001, ''),
  ('reg_mts5_frequency', 'model_mts5', 'FREQUENCY', 'Frequency', 3, 301, 1, 'U16', 'ABCD', 0.01, 'Hz'),
  ('reg_mts5_phase_sequence', 'model_mts5', 'PHASE_SEQUENCE', 'Phase sequence', 3, 302, 1, 'U16', 'ABCD', 1, ''),
  ('reg_mts5_energy', 'model_mts5', 'ENERGY_KWH', 'Energy', 3, 770, 2, 'U32', 'ABCD', 0.01, 'kWh'),
  ('reg_pm3_voltage_a', 'model_pm3c92', 'VOLTAGE_A', 'Phase A voltage', 4, 0, 2, 'U32', 'ABCD', 0.1, 'V'),
  ('reg_pm3_voltage_b', 'model_pm3c92', 'VOLTAGE_B', 'Phase B voltage', 4, 2, 2, 'U32', 'ABCD', 0.1, 'V'),
  ('reg_pm3_voltage_c', 'model_pm3c92', 'VOLTAGE_C', 'Phase C voltage', 4, 4, 2, 'U32', 'ABCD', 0.1, 'V'),
  ('reg_pm3_voltage_ab', 'model_pm3c92', 'VOLTAGE_AB', 'Line AB voltage', 4, 6, 2, 'U32', 'ABCD', 0.1, 'V'),
  ('reg_pm3_voltage_bc', 'model_pm3c92', 'VOLTAGE_BC', 'Line BC voltage', 4, 8, 2, 'U32', 'ABCD', 0.1, 'V'),
  ('reg_pm3_voltage_ca', 'model_pm3c92', 'VOLTAGE_CA', 'Line CA voltage', 4, 10, 2, 'U32', 'ABCD', 0.1, 'V'),
  ('reg_pm3_current_a', 'model_pm3c92', 'CURRENT_A', 'Phase A current', 4, 12, 2, 'U32', 'ABCD', 0.001, 'A'),
  ('reg_pm3_current_b', 'model_pm3c92', 'CURRENT_B', 'Phase B current', 4, 14, 2, 'U32', 'ABCD', 0.001, 'A'),
  ('reg_pm3_current_c', 'model_pm3c92', 'CURRENT_C', 'Phase C current', 4, 16, 2, 'U32', 'ABCD', 0.001, 'A'),
  ('reg_pm3_active_power_a', 'model_pm3c92', 'ACTIVE_POWER_A', 'Phase A active power', 4, 18, 2, 'U32', 'ABCD', 0.001, 'kW'),
  ('reg_pm3_active_power_b', 'model_pm3c92', 'ACTIVE_POWER_B', 'Phase B active power', 4, 20, 2, 'U32', 'ABCD', 0.001, 'kW'),
  ('reg_pm3_active_power_c', 'model_pm3c92', 'ACTIVE_POWER_C', 'Phase C active power', 4, 22, 2, 'U32', 'ABCD', 0.001, 'kW'),
  ('reg_pm3_active_power', 'model_pm3c92', 'ACTIVE_POWER', 'Total active power', 4, 24, 2, 'U32', 'ABCD', 0.001, 'kW'),
  ('reg_pm3_reactive_power', 'model_pm3c92', 'REACTIVE_POWER', 'Total reactive power', 4, 32, 2, 'U32', 'ABCD', 0.001, 'kvar'),
  ('reg_pm3_apparent_power', 'model_pm3c92', 'APPARENT_POWER', 'Total apparent power', 4, 40, 2, 'U32', 'ABCD', 0.001, 'kVA'),
  ('reg_pm3_power_factor_a', 'model_pm3c92', 'POWER_FACTOR_A', 'Phase A power factor', 4, 42, 1, 'U16', 'ABCD', 0.001, ''),
  ('reg_pm3_power_factor_b', 'model_pm3c92', 'POWER_FACTOR_B', 'Phase B power factor', 4, 43, 1, 'U16', 'ABCD', 0.001, ''),
  ('reg_pm3_power_factor_c', 'model_pm3c92', 'POWER_FACTOR_C', 'Phase C power factor', 4, 44, 1, 'U16', 'ABCD', 0.001, ''),
  ('reg_pm3_frequency', 'model_pm3c92', 'FREQUENCY', 'Frequency', 4, 52, 1, 'U16', 'ABCD', 0.001, 'Hz'),
  ('reg_pm3_energy', 'model_pm3c92', 'ENERGY_KWH', 'Energy', 4, 116, 2, 'FLOAT32', 'ABCD', 1, 'kWh');

INSERT INTO command_maps
  (id, device_model_id, code, name, function_code, address, write_value, description)
VALUES
  ('cmd_mts5_open', 'model_mts5', 'OPEN', 'Open breaker', 6, 2305, 170, 'Write 0x00AA to register 2305'),
  ('cmd_mts5_close', 'model_mts5', 'CLOSE', 'Close breaker', 6, 2304, 170, 'Write 0x00AA to register 2304');

-- Existing gateways receive the two physical nodes used by the current firmware.
INSERT INTO modbus_nodes
  (id, gateway_device_id, device_model_id, code, name, slave_id, baud_rate,
   serial_config, description, created_at, updated_at)
SELECT 'node_mts5_' || id, id, 'model_mts5', 'MTS5', 'MTS5(LE)', 1, 9600,
       '8E1', 'Circuit breaker on shared RS485 bus', created_at, updated_at
FROM devices;

INSERT INTO modbus_nodes
  (id, gateway_device_id, device_model_id, code, name, slave_id, baud_rate,
   serial_config, description, created_at, updated_at)
SELECT 'node_pm3_' || id, id, 'model_pm3c92', 'PM3C92', 'PM3C-92', 2, 9600,
       '8N1', 'Three-phase meter on shared RS485 bus', created_at, updated_at
FROM devices;
