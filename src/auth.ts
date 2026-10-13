import { hashPassword, randomId, randomToken, safeEqual, sha256 } from "./crypto";
import { ApiError } from "./http";
import type { Env, Role, UserRow } from "./types";

const SESSION_COOKIE = "smart_cb_session";

interface SessionUserRow extends UserRow {
  session_id: string;
  expires_at: number;
}

export async function createInitialAdmin(
  env: Env,
  input: { setupToken?: string; email?: string; password?: string; displayName?: string },
): Promise<UserRow> {
  const existing = await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>();
  if ((existing?.count ?? 0) > 0) throw new ApiError(409, "Hệ thống đã được khởi tạo", "ALREADY_INITIALIZED");
  if (!env.SETUP_TOKEN || !input.setupToken || !safeEqual(input.setupToken, env.SETUP_TOKEN)) {
    throw new ApiError(403, "Mã khởi tạo không đúng", "INVALID_SETUP_TOKEN");
  }

  const email = normalizeEmail(input.email);
  const password = validatePassword(input.password);
  const displayName = cleanText(input.displayName, "Tên hiển thị", 2, 80);
  const createdAt = Date.now();
  const userId = randomId("usr");
  const passwordData = await hashPassword(password);

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users
         (id, email, display_name, role, password_hash, password_salt, password_iterations, is_bootstrap, created_at, updated_at)
         VALUES (?, ?, ?, 'ADMIN', ?, ?, ?, 1, ?, ?)`,
      ).bind(
        userId,
        email,
        displayName,
        passwordData.hash,
        passwordData.salt,
        passwordData.iterations,
        createdAt,
        createdAt,
      ),
      env.DB.prepare(
        `INSERT INTO audit_logs (actor_type, actor_id, event_type, entity_type, entity_id, created_at)
         VALUES ('USER', ?, 'SYSTEM_INITIALIZED', 'USER', ?, ?)`,
      ).bind(userId, userId, createdAt),
    ]);
  } catch (error) {
    if (String(error).includes("UNIQUE")) {
      throw new ApiError(409, "Hệ thống đã được khởi tạo", "ALREADY_INITIALIZED");
    }
    throw error;
  }

  return { id: userId, email, display_name: displayName, role: "ADMIN", is_active: 1 };
}

export async function login(
  request: Request,
  env: Env,
  input: { email?: string; password?: string },
): Promise<{ user: UserRow; cookie: string }> {
  const email = normalizeEmail(input.email);
  const password = input.password ?? "";
  const row = await env.DB.prepare(
    `SELECT id, email, display_name, role, is_active, password_hash, password_salt, password_iterations
     FROM users WHERE email = ? COLLATE NOCASE`,
  ).bind(email).first<UserRow & { password_hash: string; password_salt: string; password_iterations: number }>();

  if (!row || row.is_active !== 1) {
    await constantTimePasswordWork(password);
    throw new ApiError(401, "Email hoặc mật khẩu không đúng", "INVALID_CREDENTIALS");
  }

  const candidate = await hashPassword(password, row.password_salt, row.password_iterations);
  if (!safeEqual(candidate.hash, row.password_hash)) {
    throw new ApiError(401, "Email hoặc mật khẩu không đúng", "INVALID_CREDENTIALS");
  }

  const now = Date.now();
  const rawToken = randomToken(32);
  const sessionId = randomId("ses");
  const tokenHash = await sha256(rawToken);
  const ttlHours = clamp(Number(env.SESSION_TTL_HOURS ?? 24), 1, 168);
  const expiresAt = now + ttlHours * 60 * 60 * 1000;
  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  const ipHash = await sha256(ip);
  const userAgent = (request.headers.get("user-agent") ?? "").slice(0, 300);

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at, ip_hash, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(sessionId, row.id, tokenHash, expiresAt, now, now, ipHash, userAgent),
    env.DB.prepare("UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?").bind(now, now, row.id),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
  ]);

  const user: UserRow = {
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    role: row.role,
    is_active: row.is_active,
  };
  return { user, cookie: serializeSessionCookie(request, rawToken, expiresAt) };
}

export async function logout(request: Request, env: Env): Promise<string> {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  return clearSessionCookie(request);
}

export async function getCurrentUser(request: Request, env: Env): Promise<UserRow | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const now = Date.now();
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.display_name, u.role, u.is_active, s.id AS session_id, s.expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.is_active = 1`,
  ).bind(await sha256(token), now).first<SessionUserRow>();
  if (!row) return null;
  if (now % 60_000 < 5_000) {
    await env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").bind(now, row.session_id).run();
  }
  return { id: row.id, email: row.email, display_name: row.display_name, role: row.role, is_active: row.is_active };
}

export async function requireUser(request: Request, env: Env, roles?: Role[]): Promise<UserRow> {
  const user = await getCurrentUser(request, env);
  if (!user) throw new ApiError(401, "Vui lòng đăng nhập", "AUTH_REQUIRED");
  if (roles && !roles.includes(user.role)) throw new ApiError(403, "Bạn không có quyền thực hiện thao tác này", "FORBIDDEN");
  return user;
}

export async function authenticateDevice(
  request: Request,
  env: Env,
): Promise<{ id: string; name: string }> {
  const deviceId = request.headers.get("x-device-id")?.trim();
  const apiKey = request.headers.get("x-device-key")?.trim();
  if (!deviceId || !apiKey || apiKey.length < 32) {
    throw new ApiError(401, "Thiếu thông tin xác thực thiết bị", "DEVICE_AUTH_REQUIRED");
  }
  const device = await env.DB.prepare(
    "SELECT id, name, api_key_hash, is_active FROM devices WHERE id = ?",
  ).bind(deviceId).first<{ id: string; name: string; api_key_hash: string; is_active: number }>();
  const suppliedHash = await sha256(apiKey);
  if (!device || device.is_active !== 1 || !safeEqual(suppliedHash, device.api_key_hash)) {
    throw new ApiError(401, "Khóa thiết bị không hợp lệ", "INVALID_DEVICE_KEY");
  }
  return { id: device.id, name: device.name };
}

export function cleanText(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== "string") throw new ApiError(400, `${label} không hợp lệ`, "VALIDATION_ERROR");
  const cleaned = value.trim().replace(/\s+/g, " ");
  if (cleaned.length < min || cleaned.length > max) {
    throw new ApiError(400, `${label} phải dài từ ${min} đến ${max} ký tự`, "VALIDATION_ERROR");
  }
  return cleaned;
}

function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") throw new ApiError(400, "Email không hợp lệ", "VALIDATION_ERROR");
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError(400, "Email không hợp lệ", "VALIDATION_ERROR");
  }
  return email;
}

function validatePassword(value: unknown): string {
  if (typeof value !== "string" || value.length < 10 || value.length > 128) {
    throw new ApiError(400, "Mật khẩu phải dài từ 10 đến 128 ký tự", "VALIDATION_ERROR");
  }
  return value;
}

async function constantTimePasswordWork(password: string): Promise<void> {
  await hashPassword(password || "invalid-password", "00000000000000000000000000000000", 10_000);
}

function readCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function serializeSessionCookie(request: Request, value: string, expiresAt: number): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict${secure}; Expires=${new Date(expiresAt).toUTCString()}`;
}

function clearSessionCookie(request: Request): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=0`;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}
