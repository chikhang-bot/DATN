import {
  authenticateDevice,
  cleanText,
  createInitialAdmin,
  getCurrentUser,
  login,
  logout,
  requireUser,
} from "./auth";
import { randomId, randomToken, sha256 } from "./crypto";
import { ApiError, assertSameOrigin, json, methodNotAllowed, parsePositiveInt, readJson } from "./http";
import type { BreakerState, CommandAction, CommandRow, DeviceRow, Env, Role } from "./types";

const BREAKER_STATES = new Set<BreakerState>(["OPEN", "CLOSED", "TRIPPED", "UNKNOWN"]);
const COMMAND_ACTIONS = new Set<CommandAction>(["OPEN", "CLOSE"]);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
      if (request.method === "OPTIONS") return new Response(null, { status: 204 });
      return await routeApi(request, env, url);
    } catch (error) {
      if (error instanceof ApiError) {
        return json({ error: { code: error.code, message: error.message, details: error.details } }, error.status);
      }
      console.error("Unhandled API error", error);
      return json({ error: { code: "INTERNAL_ERROR", message: "Máy chủ gặp lỗi không mong muốn" } }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function routeApi(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;

  if (path === "/api/health") {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    return json({ ok: true, service: env.APP_NAME ?? "Smart CB", time: Date.now() });
  }

  if (path === "/api/auth/status") {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    const result = await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>();
    return json({ initialized: (result?.count ?? 0) > 0, user: await getCurrentUser(request, env) });
  }

  if (path === "/api/auth/setup") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    assertSameOrigin(request);
    const user = await createInitialAdmin(env, await readJson(request));
    return json({ user }, 201);
  }

  if (path === "/api/auth/login") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    assertSameOrigin(request);
    const result = await login(request, env, await readJson(request));
    return json({ user: result.user }, 200, { "Set-Cookie": result.cookie });
  }

  if (path === "/api/auth/logout") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    assertSameOrigin(request);
    return json({ ok: true }, 200, { "Set-Cookie": await logout(request, env) });
  }

  if (path === "/api/auth/me") {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    return json({ user: await requireUser(request, env) });
  }

  if (path.startsWith("/api/device/")) return routeDeviceApi(request, env, url);

  if (path === "/api/dashboard") {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    await requireUser(request, env);
    return dashboardResponse(env);
  }

  if (path === "/api/devices") {
    if (request.method === "GET") {
      await requireUser(request, env);
      const offlineAfter = Number(env.DEVICE_OFFLINE_SECONDS ?? 10) * 1000;
      const rows = await env.DB.prepare(
        `SELECT d.*,
          (SELECT voltage FROM telemetry t WHERE t.device_id = d.id ORDER BY sampled_at DESC LIMIT 1) AS voltage,
          (SELECT current FROM telemetry t WHERE t.device_id = d.id ORDER BY sampled_at DESC LIMIT 1) AS current,
          (SELECT active_power FROM telemetry t WHERE t.device_id = d.id ORDER BY sampled_at DESC LIMIT 1) AS active_power,
          (SELECT energy_kwh FROM telemetry t WHERE t.device_id = d.id ORDER BY sampled_at DESC LIMIT 1) AS energy_kwh,
          (SELECT pm3_connected FROM telemetry t WHERE t.device_id = d.id ORDER BY sampled_at DESC LIMIT 1) AS pm3_connected,
          (SELECT mts5_connected FROM telemetry t WHERE t.device_id = d.id ORDER BY sampled_at DESC LIMIT 1) AS mts5_connected,
          (SELECT mts5_status_raw FROM telemetry t WHERE t.device_id = d.id ORDER BY sampled_at DESC LIMIT 1) AS mts5_status_raw
         FROM devices d ORDER BY d.created_at`,
      ).all<DeviceRow & Record<string, unknown>>();
      return json({
        devices: rows.results.map((row) => ({
          ...row,
          online: row.last_seen_at !== null && Date.now() - row.last_seen_at <= offlineAfter,
        })),
      });
    }
    if (request.method === "POST") {
      assertSameOrigin(request);
      const user = await requireUser(request, env, ["ADMIN"]);
      const body = await readJson<{ name?: string; location?: string }>(request);
      const name = cleanText(body.name, "Tên thiết bị", 2, 80);
      const location = typeof body.location === "string" ? body.location.trim().slice(0, 160) : "";
      const id = randomId("dev");
      const apiKey = randomToken(32);
      const now = Date.now();
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO devices (id, name, location, api_key_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).bind(id, name, location, await sha256(apiKey), now, now),
        audit(env, "USER", user.id, "DEVICE_CREATED", "DEVICE", id, { name, location }, now),
      ]);
      return json({ device: { id, name, location }, apiKey }, 201);
    }
    return methodNotAllowed(["GET", "POST"]);
  }

  const telemetryMatch = path.match(/^\/api\/devices\/([^/]+)\/telemetry$/);
  if (telemetryMatch) {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    await requireUser(request, env);
    const deviceId = decodeURIComponent(telemetryMatch[1]!);
    await requireDeviceExists(env, deviceId);
    const limit = parsePositiveInt(url.searchParams.get("limit"), 120, 500);
    const before = Number(url.searchParams.get("before") ?? Date.now());
    const rows = await env.DB.prepare(
      `SELECT id, voltage, current, active_power, energy_kwh, frequency, power_factor,
              temperature, breaker_state, sampled_at, received_at,
              voltage_a, voltage_b, voltage_c, voltage_ab, voltage_bc, voltage_ca,
              current_a, current_b, current_c, neutral_current,
              active_power_a, active_power_b, active_power_c,
              reactive_power, reactive_power_a, reactive_power_b, reactive_power_c,
              apparent_power, apparent_power_a, apparent_power_b, apparent_power_c,
              power_factor_a, power_factor_b, power_factor_c, phase_sequence,
              mts5_status_raw, pm3_connected, mts5_connected, remote_control_enabled
       FROM telemetry WHERE device_id = ? AND sampled_at < ? ORDER BY sampled_at DESC LIMIT ?`,
    ).bind(deviceId, Number.isFinite(before) ? before : Date.now(), limit).all();
    return json({ telemetry: rows.results });
  }

  const commandsMatch = path.match(/^\/api\/devices\/([^/]+)\/commands$/);
  if (commandsMatch) {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    await requireUser(request, env);
    const deviceId = decodeURIComponent(commandsMatch[1]!);
    await requireDeviceExists(env, deviceId);
    const limit = parsePositiveInt(url.searchParams.get("limit"), 50, 200);
    const rows = await env.DB.prepare(
      `SELECT c.id, c.action, c.status, c.requested_at, c.expires_at, c.claimed_at,
              c.completed_at, c.result_message, c.resulting_breaker_state,
              u.display_name AS requested_by_name
       FROM commands c JOIN users u ON u.id = c.requested_by
       WHERE c.device_id = ? ORDER BY c.requested_at DESC LIMIT ?`,
    ).bind(deviceId, limit).all();
    return json({ commands: rows.results });
  }

  if (path === "/api/commands") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    assertSameOrigin(request);
    const user = await requireUser(request, env, ["ADMIN", "OPERATOR"]);
    const body = await readJson<{ deviceId?: string; action?: string; expiresInSeconds?: number }>(request);
    const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";
    const action = body.action as CommandAction;
    if (!COMMAND_ACTIONS.has(action)) throw new ApiError(400, "Lệnh phải là OPEN hoặc CLOSE", "VALIDATION_ERROR");
    const device = await requireDeviceExists(env, deviceId);
    if (device.is_active !== 1) throw new ApiError(409, "Thiết bị đang bị vô hiệu hóa", "DEVICE_INACTIVE");
    if (device.remote_control_enabled !== 1) {
      throw new ApiError(409, "ESP32 đang khóa điều khiển từ xa hoặc chưa cấu hình trạng thái MTS5", "REMOTE_CONTROL_LOCKED");
    }
    if (device.mts5_connected !== 1) {
      throw new ApiError(409, "Không có kết nối Modbus tới MTS5", "MTS5_OFFLINE");
    }
    if (device.breaker_state === "UNKNOWN") {
      throw new ApiError(409, "Không xác định được trạng thái CB từ register 515", "BREAKER_STATE_UNKNOWN");
    }
    const offlineAfter = Number(env.DEVICE_OFFLINE_SECONDS ?? 10) * 1000;
    if (device.last_seen_at === null || Date.now() - device.last_seen_at > offlineAfter) {
      throw new ApiError(409, "ESP32 đang offline", "DEVICE_OFFLINE");
    }
    if ((action === "OPEN" && device.breaker_state === "OPEN") || (action === "CLOSE" && device.breaker_state === "CLOSED")) {
      throw new ApiError(409, `CB đã ở trạng thái ${device.breaker_state}`, "ALREADY_IN_STATE");
    }
    const now = Date.now();
    await env.DB.prepare("UPDATE commands SET status = 'EXPIRED', completed_at = ? WHERE device_id = ? AND status = 'PENDING' AND expires_at <= ?")
      .bind(now, deviceId, now).run();
    const active = await env.DB.prepare(
      "SELECT id, action, status, expires_at FROM commands WHERE device_id = ? AND status IN ('PENDING', 'CLAIMED') LIMIT 1",
    ).bind(deviceId).first();
    if (active) throw new ApiError(409, "Thiết bị đang có một lệnh chưa hoàn tất", "COMMAND_IN_PROGRESS", active);
    const defaultTtl = Number(env.COMMAND_TTL_SECONDS ?? 30);
    const ttl = clamp(Number(body.expiresInSeconds ?? defaultTtl), 5, 300);
    const commandId = randomId("cmd");
    const expiresAt = now + ttl * 1000;
    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO commands (id, device_id, action, requested_by, requested_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).bind(commandId, deviceId, action, user.id, now, expiresAt),
        audit(env, "USER", user.id, "COMMAND_CREATED", "COMMAND", commandId, { deviceId, action, expiresAt }, now),
      ]);
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        throw new ApiError(409, "Một lệnh khác vừa được tạo cho thiết bị", "COMMAND_IN_PROGRESS");
      }
      throw error;
    }
    return json({ command: { id: commandId, deviceId, action, status: "PENDING", requestedAt: now, expiresAt } }, 201);
  }

  if (path === "/api/users") {
    if (request.method === "GET") {
      await requireUser(request, env, ["ADMIN"]);
      const rows = await env.DB.prepare(
        "SELECT id, email, display_name, role, is_active, created_at, last_login_at FROM users ORDER BY created_at",
      ).all();
      return json({ users: rows.results });
    }
    if (request.method === "POST") {
      assertSameOrigin(request);
      const admin = await requireUser(request, env, ["ADMIN"]);
      const body = await readJson<{ email?: string; displayName?: string; password?: string; role?: Role }>(request);
      const role = body.role;
      if (!role || !["ADMIN", "OPERATOR", "VIEWER"].includes(role)) {
        throw new ApiError(400, "Vai trò không hợp lệ", "VALIDATION_ERROR");
      }
      return createUser(env, admin.id, body.email, body.displayName, body.password, role);
    }
    return methodNotAllowed(["GET", "POST"]);
  }

  return json({ error: { code: "NOT_FOUND", message: "Không tìm thấy API" } }, 404);
}

async function routeDeviceApi(request: Request, env: Env, url: URL): Promise<Response> {
  const device = await authenticateDevice(request, env);
  const now = Date.now();

  if (url.pathname === "/api/device/telemetry") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const body = await readJson<Record<string, unknown>>(request, 8_192);
    const state = parseBreakerState(body.breakerState);
    const sampledAt = finiteNumber(body.sampledAt, now, now - 24 * 60 * 60 * 1000, now + 60_000);
    const firmwareVersion = typeof body.firmwareVersion === "string" ? body.firmwareVersion.slice(0, 80) : null;
    const numericKeys = [
      "voltage", "current", "activePower", "energyKwh", "frequency", "powerFactor", "temperature",
      "voltageA", "voltageB", "voltageC", "voltageAB", "voltageBC", "voltageCA",
      "currentA", "currentB", "currentC", "neutralCurrent",
      "activePowerA", "activePowerB", "activePowerC",
      "reactivePower", "reactivePowerA", "reactivePowerB", "reactivePowerC",
      "apparentPower", "apparentPowerA", "apparentPowerB", "apparentPowerC",
      "powerFactorA", "powerFactorB", "powerFactorC",
    ] as const;
    const values = numericKeys.map((key) => optionalFiniteNumber(body[key], key));
    const phaseSequence = optionalInteger(body.phaseSequence, "phaseSequence", 0, 65_535);
    const mts5StatusRaw = optionalInteger(body.mts5StatusRaw, "mts5StatusRaw", 0, 65_535);
    const pm3Connected = optionalBoolean(body.pm3Connected, "pm3Connected");
    const mts5Connected = optionalBoolean(body.mts5Connected, "mts5Connected");
    const remoteControlEnabled = optionalBoolean(body.remoteControlEnabled, "remoteControlEnabled");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO telemetry
         (device_id, voltage, current, active_power, energy_kwh, frequency, power_factor, temperature,
          voltage_a, voltage_b, voltage_c, voltage_ab, voltage_bc, voltage_ca,
          current_a, current_b, current_c, neutral_current,
          active_power_a, active_power_b, active_power_c,
          reactive_power, reactive_power_a, reactive_power_b, reactive_power_c,
          apparent_power, apparent_power_a, apparent_power_b, apparent_power_c,
          power_factor_a, power_factor_b, power_factor_c, phase_sequence, mts5_status_raw,
          pm3_connected, mts5_connected, remote_control_enabled,
          breaker_state, sampled_at, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        device.id, ...values, phaseSequence, mts5StatusRaw, pm3Connected, mts5Connected,
        remoteControlEnabled, state, sampledAt, now,
      ),
      env.DB.prepare(
        `UPDATE devices SET breaker_state = ?, firmware_version = COALESCE(?, firmware_version),
         last_seen_at = ?, updated_at = ? WHERE id = ?`,
      ).bind(state, firmwareVersion, now, now, device.id),
    ]);
    return json({ accepted: true, serverTime: now }, 202);
  }

  if (url.pathname === "/api/device/commands/next") {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    const pollId = url.searchParams.get("pollId")?.trim() ?? "";
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(pollId)) {
      throw new ApiError(400, "pollId không hợp lệ", "INVALID_POLL_ID");
    }
    await env.DB.prepare(
      "UPDATE commands SET status = 'EXPIRED', completed_at = ? WHERE device_id = ? AND status = 'PENDING' AND expires_at <= ?",
    ).bind(now, device.id, now).run();

    let command = await env.DB.prepare(
      `SELECT id, device_id, action, status, requested_by, requested_at, expires_at,
              claimed_at, claim_token, completed_at, result_message, resulting_breaker_state
       FROM commands WHERE device_id = ? AND status = 'CLAIMED' AND claim_token = ? LIMIT 1`,
    ).bind(device.id, pollId).first<CommandRow>();

    if (!command) {
      command = await env.DB.prepare(
        `UPDATE commands SET status = 'CLAIMED', claimed_at = ?, claim_token = ?
         WHERE id = (
           SELECT id FROM commands
           WHERE device_id = ? AND status = 'PENDING' AND expires_at > ?
           ORDER BY requested_at ASC LIMIT 1
         ) AND status = 'PENDING'
         RETURNING id, device_id, action, status, requested_by, requested_at, expires_at,
                   claimed_at, claim_token, completed_at, result_message, resulting_breaker_state`,
      ).bind(now, pollId, device.id, now).first<CommandRow>();
    }

    await env.DB.prepare("UPDATE devices SET last_seen_at = ?, updated_at = ? WHERE id = ?")
      .bind(now, now, device.id).run();
    if (!command) return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    return json({
      command: {
        commandId: command.id,
        deviceId: command.device_id,
        action: command.action,
        issuedAt: command.requested_at,
        expiresAt: command.expires_at,
        pollId: command.claim_token,
      },
      serverTime: now,
    });
  }

  if (url.pathname === "/api/device/commands/result") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const body = await readJson<{ commandId?: string; pollId?: string; status?: string; breakerState?: string; message?: string }>(request);
    const commandId = typeof body.commandId === "string" ? body.commandId : "";
    const pollId = typeof body.pollId === "string" ? body.pollId : "";
    const status = body.status;
    if (!commandId || !pollId || (status !== "SUCCEEDED" && status !== "FAILED")) {
      throw new ApiError(400, "Kết quả lệnh không hợp lệ", "VALIDATION_ERROR");
    }
    const state = parseBreakerState(body.breakerState);
    const message = typeof body.message === "string" ? body.message.trim().slice(0, 500) : "";
    const result = await env.DB.prepare(
      `UPDATE commands SET status = ?, completed_at = ?, result_message = ?, resulting_breaker_state = ?
       WHERE id = ? AND device_id = ? AND status = 'CLAIMED' AND claim_token = ?
       RETURNING id`,
    ).bind(status, now, message, state, commandId, device.id, pollId).first<{ id: string }>();

    if (!result) {
      const existing = await env.DB.prepare(
        "SELECT status, claim_token FROM commands WHERE id = ? AND device_id = ?",
      ).bind(commandId, device.id).first<{ status: string; claim_token: string | null }>();
      if (existing && ["SUCCEEDED", "FAILED"].includes(existing.status) && existing.claim_token === pollId) {
        return json({ accepted: true, duplicate: true });
      }
      throw new ApiError(409, "Lệnh không còn ở trạng thái có thể cập nhật", "COMMAND_STATE_CONFLICT");
    }
    await env.DB.batch([
      env.DB.prepare("UPDATE devices SET breaker_state = ?, last_seen_at = ?, updated_at = ? WHERE id = ?")
        .bind(state, now, now, device.id),
      audit(env, "DEVICE", device.id, "COMMAND_COMPLETED", "COMMAND", commandId, { status, state, message }, now),
    ]);
    return json({ accepted: true });
  }

  return json({ error: { code: "NOT_FOUND", message: "Không tìm thấy API thiết bị" } }, 404);
}

async function dashboardResponse(env: Env): Promise<Response> {
  const now = Date.now();
  const offlineAfter = Number(env.DEVICE_OFFLINE_SECONDS ?? 10) * 1000;
  const [devices, activeCommands, recentCommands] = await Promise.all([
    env.DB.prepare(
      `SELECT d.id, d.name, d.location, d.breaker_state, d.firmware_version, d.last_seen_at,
              t.voltage, t.current, t.active_power, t.energy_kwh, t.frequency,
              t.power_factor, t.temperature, t.sampled_at,
              t.voltage_a, t.voltage_b, t.voltage_c, t.voltage_ab, t.voltage_bc, t.voltage_ca,
              t.current_a, t.current_b, t.current_c, t.neutral_current,
              t.active_power_a, t.active_power_b, t.active_power_c,
              t.reactive_power, t.reactive_power_a, t.reactive_power_b, t.reactive_power_c,
              t.apparent_power, t.apparent_power_a, t.apparent_power_b, t.apparent_power_c,
              t.power_factor_a, t.power_factor_b, t.power_factor_c, t.phase_sequence,
              t.mts5_status_raw, t.pm3_connected, t.mts5_connected, t.remote_control_enabled
       FROM devices d
       LEFT JOIN telemetry t ON t.id = (
         SELECT id FROM telemetry WHERE device_id = d.id ORDER BY sampled_at DESC LIMIT 1
       )
       WHERE d.is_active = 1 ORDER BY d.name`,
    ).all<Record<string, unknown>>(),
    env.DB.prepare(
      "SELECT id, device_id, action, status, requested_at, expires_at FROM commands WHERE status IN ('PENDING', 'CLAIMED')",
    ).all(),
    env.DB.prepare(
      `SELECT c.id, c.device_id, d.name AS device_name, c.action, c.status, c.requested_at,
              c.completed_at, c.result_message, u.display_name AS requested_by_name
       FROM commands c JOIN devices d ON d.id = c.device_id JOIN users u ON u.id = c.requested_by
       ORDER BY c.requested_at DESC LIMIT 20`,
    ).all(),
  ]);
  return json({
    serverTime: now,
    devices: devices.results.map((device) => ({
      ...device,
      online: typeof device.last_seen_at === "number" && now - device.last_seen_at <= offlineAfter,
    })),
    activeCommands: activeCommands.results,
    recentCommands: recentCommands.results,
  });
}

async function requireDeviceExists(
  env: Env,
  deviceId: string,
): Promise<DeviceRow & { is_active: number; remote_control_enabled: number | null; mts5_connected: number | null }> {
  const row = await env.DB.prepare(
    `SELECT id, name, location, breaker_state, firmware_version, last_seen_at, created_at, is_active,
      (SELECT remote_control_enabled FROM telemetry WHERE device_id = devices.id ORDER BY sampled_at DESC LIMIT 1) AS remote_control_enabled,
      (SELECT mts5_connected FROM telemetry WHERE device_id = devices.id ORDER BY sampled_at DESC LIMIT 1) AS mts5_connected
     FROM devices WHERE id = ?`,
  ).bind(deviceId).first<DeviceRow & { is_active: number; remote_control_enabled: number | null; mts5_connected: number | null }>();
  if (!row) throw new ApiError(404, "Không tìm thấy thiết bị", "DEVICE_NOT_FOUND");
  return row;
}

async function createUser(
  env: Env,
  adminId: string,
  rawEmail: unknown,
  rawName: unknown,
  rawPassword: unknown,
  role: Role,
): Promise<Response> {
  if (typeof rawEmail !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail.trim())) {
    throw new ApiError(400, "Email không hợp lệ", "VALIDATION_ERROR");
  }
  if (typeof rawPassword !== "string" || rawPassword.length < 10 || rawPassword.length > 128) {
    throw new ApiError(400, "Mật khẩu phải dài từ 10 đến 128 ký tự", "VALIDATION_ERROR");
  }
  const { hashPassword } = await import("./crypto");
  const email = rawEmail.trim().toLowerCase();
  const displayName = cleanText(rawName, "Tên hiển thị", 2, 80);
  const passwordData = await hashPassword(rawPassword);
  const userId = randomId("usr");
  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users
         (id, email, display_name, role, password_hash, password_salt, password_iterations, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(userId, email, displayName, role, passwordData.hash, passwordData.salt, passwordData.iterations, now, now),
      audit(env, "USER", adminId, "USER_CREATED", "USER", userId, { email, role }, now),
    ]);
  } catch (error) {
    if (String(error).includes("UNIQUE")) throw new ApiError(409, "Email đã tồn tại", "EMAIL_EXISTS");
    throw error;
  }
  return json({ user: { id: userId, email, displayName, role } }, 201);
}

function audit(
  env: Env,
  actorType: "USER" | "DEVICE" | "SYSTEM",
  actorId: string | null,
  eventType: string,
  entityType: string,
  entityId: string,
  details: unknown,
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO audit_logs
     (actor_type, actor_id, event_type, entity_type, entity_id, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(actorType, actorId, eventType, entityType, entityId, JSON.stringify(details), now);
}

function parseBreakerState(value: unknown): BreakerState {
  if (typeof value !== "string" || !BREAKER_STATES.has(value as BreakerState)) {
    throw new ApiError(400, "Trạng thái CB không hợp lệ", "VALIDATION_ERROR");
  }
  return value as BreakerState;
}

function optionalFiniteNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ApiError(400, `${field} phải là số hữu hạn`, "VALIDATION_ERROR");
  }
  return value;
}

function optionalInteger(value: unknown, field: string, min: number, max: number): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ApiError(400, `${field} phải là số nguyên từ ${min} đến ${max}`, "VALIDATION_ERROR");
  }
  return value;
}

function optionalBoolean(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "boolean") {
    throw new ApiError(400, `${field} phải là true hoặc false`, "VALIDATION_ERROR");
  }
  return value ? 1 : 0;
}

function finiteNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) return fallback;
  return value;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.floor(value), min), max);
}
