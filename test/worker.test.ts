import type { D1Migration } from "@cloudflare/vitest-plugin";
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env as WorkerEnv } from "../src/types";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

const origin = "http://smart-cb.test";
let sessionCookie = "";
let deviceId = "";
let deviceKey = "";
let commandId = "";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

async function call(
  path: string,
  options: { method?: string; body?: unknown; cookie?: string; device?: boolean } = {},
): Promise<Response> {
  const headers = new Headers({ Accept: "application/json" });
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (options.cookie) headers.set("Cookie", options.cookie);
  if (options.method && options.method !== "GET") headers.set("Origin", origin);
  if (options.device) {
    headers.set("X-Device-Id", deviceId);
    headers.set("X-Device-Key", deviceKey);
  }
  const request = new Request(`${origin}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return worker.fetch(request, env);
}

describe("Smart CB lifecycle", () => {
  it("starts uninitialized and creates exactly one administrator", async () => {
    const status = await call("/api/auth/status");
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ initialized: false, user: null });

    const setup = await call("/api/auth/setup", {
      method: "POST",
      body: {
        setupToken: "test-setup-token-very-long",
        email: "admin@example.com",
        displayName: "Test Admin",
        password: "a-secure-test-password",
      },
    });
    expect(setup.status).toBe(201);

    const duplicate = await call("/api/auth/setup", {
      method: "POST",
      body: {
        setupToken: "test-setup-token-very-long",
        email: "other@example.com",
        displayName: "Other Admin",
        password: "a-secure-test-password",
      },
    });
    expect(duplicate.status).toBe(409);
  });

  it("logs in using an HttpOnly session cookie", async () => {
    const response = await call("/api/auth/login", {
      method: "POST",
      body: { email: "admin@example.com", password: "a-secure-test-password" },
    });
    expect(response.status).toBe(200);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    sessionCookie = setCookie.split(";")[0]!;
  });

  it("registers a device and returns its key once", async () => {
    const response = await call("/api/devices", {
      method: "POST",
      cookie: sessionCookie,
      body: { name: "Tủ điện thử nghiệm", location: "Lab" },
    });
    expect(response.status).toBe(201);
    const data = await response.json() as { device: { id: string }; apiKey: string };
    deviceId = data.device.id;
    deviceKey = data.apiKey;
    expect(deviceId).toMatch(/^dev_/);
    expect(deviceKey.length).toBeGreaterThan(32);
  });

  it("accepts device telemetry", async () => {
    const response = await call("/api/device/telemetry", {
      method: "POST",
      device: true,
      body: {
        voltage: 229.8,
        current: 3.42,
        activePower: 742,
        energyKwh: 18.2,
        frequency: 50.01,
        powerFactor: 0.95,
        voltageA: 229.8,
        voltageB: 230.1,
        voltageC: 229.6,
        currentA: 3.42,
        currentB: 3.21,
        currentC: 3.33,
        activePowerA: 250,
        activePowerB: 242,
        activePowerC: 250,
        reactivePower: 180,
        apparentPower: 780,
        powerFactorA: 0.95,
        powerFactorB: 0.94,
        powerFactorC: 0.96,
        phaseSequence: 0,
        mts5StatusRaw: 1,
        pm3Connected: true,
        mts5Connected: true,
        remoteControlEnabled: true,
        breakerState: "CLOSED",
        sampledAt: Date.now(),
        firmwareVersion: "test-1.0.0",
      },
    });
    expect(response.status).toBe(202);
  });

  it("creates, claims idempotently, and completes a command", async () => {
    const created = await call("/api/commands", {
      method: "POST",
      cookie: sessionCookie,
      body: { deviceId, action: "OPEN", expiresInSeconds: 30 },
    });
    expect(created.status).toBe(201);
    commandId = ((await created.json()) as { command: { id: string } }).command.id;

    const duplicateActive = await call("/api/commands", {
      method: "POST",
      cookie: sessionCookie,
      body: { deviceId, action: "OPEN", expiresInSeconds: 30 },
    });
    expect(duplicateActive.status).toBe(409);

    const firstClaim = await call("/api/device/commands/next?pollId=poll_test_0001", { device: true });
    expect(firstClaim.status).toBe(200);
    expect(await firstClaim.json()).toMatchObject({ command: { commandId, deviceId, action: "OPEN", pollId: "poll_test_0001" } });

    const retriedClaim = await call("/api/device/commands/next?pollId=poll_test_0001", { device: true });
    expect(retriedClaim.status).toBe(200);
    expect(await retriedClaim.json()).toMatchObject({ command: { commandId } });

    const otherPoll = await call("/api/device/commands/next?pollId=poll_test_0002", { device: true });
    expect(otherPoll.status).toBe(204);

    const completed = await call("/api/device/commands/result", {
      method: "POST",
      device: true,
      body: {
        commandId,
        pollId: "poll_test_0001",
        status: "SUCCEEDED",
        breakerState: "OPEN",
        message: "State verified",
      },
    });
    expect(completed.status).toBe(200);

    const duplicateResult = await call("/api/device/commands/result", {
      method: "POST",
      device: true,
      body: {
        commandId,
        pollId: "poll_test_0001",
        status: "SUCCEEDED",
        breakerState: "OPEN",
        message: "State verified",
      },
    });
    expect(duplicateResult.status).toBe(200);
    expect(await duplicateResult.json()).toMatchObject({ accepted: true, duplicate: true });
  });

  it("shows the latest telemetry and command in the dashboard", async () => {
    const response = await call("/api/dashboard", { cookie: sessionCookie });
    expect(response.status).toBe(200);
    const data = await response.json() as { devices: Array<Record<string, unknown>>; recentCommands: Array<Record<string, unknown>> };
    expect(data.devices[0]).toMatchObject({
      id: deviceId,
      breaker_state: "OPEN",
      voltage: 229.8,
      voltage_a: 229.8,
      pm3_connected: 1,
      mts5_connected: 1,
      mts5_status_raw: 1,
    });
    expect(data.recentCommands[0]).toMatchObject({ id: commandId, status: "SUCCEEDED" });
  });
});
