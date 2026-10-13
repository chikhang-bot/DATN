export type Role = "ADMIN" | "OPERATOR" | "VIEWER";
export type BreakerState = "OPEN" | "CLOSED" | "TRIPPED" | "UNKNOWN";
export type CommandAction = "OPEN" | "CLOSE";
export type CommandStatus =
  | "PENDING"
  | "CLAIMED"
  | "SUCCEEDED"
  | "FAILED"
  | "EXPIRED"
  | "CANCELLED";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  SETUP_TOKEN: string;
  APP_NAME?: string;
  SESSION_TTL_HOURS?: string;
  COMMAND_TTL_SECONDS?: string;
  DEVICE_OFFLINE_SECONDS?: string;
}

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  role: Role;
  is_active: number;
}

export interface DeviceRow {
  id: string;
  name: string;
  location: string;
  breaker_state: BreakerState;
  firmware_version: string | null;
  last_seen_at: number | null;
  created_at: number;
}

export interface CommandRow {
  id: string;
  device_id: string;
  action: CommandAction;
  status: CommandStatus;
  requested_by: string;
  requested_at: number;
  expires_at: number;
  claimed_at: number | null;
  claim_token: string | null;
  completed_at: number | null;
  result_message: string | null;
  resulting_breaker_state: BreakerState | null;
}
