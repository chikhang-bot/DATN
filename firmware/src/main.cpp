#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <time.h>

#include "device_config.h"
#include "meter_data.h"
#include "mts5.h"
#include "pm3c92.h"
#include "rs485_bus.h"
#include "secrets.h"

Rs485Bus rs485(2);
Pm3c92 pm3c(rs485);
Mts5 mts5(rs485);
Preferences prefs;
Pm3cReading pm3Reading;
Mts5Reading mtsReading;

uint32_t lastTelemetryAt = 0;
uint32_t lastPollAt = 0;
uint32_t lastWifiAttemptAt = 0;
String activePollId;

const char* stateName(BreakerState state) {
  switch (state) {
    case BreakerState::OPEN: return "OPEN";
    case BreakerState::CLOSED: return "CLOSED";
    case BreakerState::TRIPPED: return "TRIPPED";
    default: return "UNKNOWN";
  }
}

BreakerState stateFromName(const String& value) {
  if (value == "OPEN") return BreakerState::OPEN;
  if (value == "CLOSED") return BreakerState::CLOSED;
  if (value == "TRIPPED") return BreakerState::TRIPPED;
  return BreakerState::UNKNOWN;
}

bool timeIsValid() {
  return time(nullptr) > 1704067200;  // 2024-01-01 UTC
}

uint64_t epochMillis() {
  return static_cast<uint64_t>(time(nullptr)) * 1000ULL;
}

String randomId() {
  char value[40];
  snprintf(value, sizeof(value), "%08lx%08lx%08lx", esp_random(), esp_random(), esp_random());
  return String(value);
}

bool tlsConfigured() {
  return strstr(ROOT_CA_CERT, "PASTE_ROOT_CA") == nullptr;
}

float average3(float a, float b, float c) {
  float total = 0.0F;
  uint8_t count = 0;
  if (isfinite(a)) { total += a; count += 1; }
  if (isfinite(b)) { total += b; count += 1; }
  if (isfinite(c)) { total += c; count += 1; }
  return count == 0 ? NAN : total / count;
}

void configureHttp(HTTPClient& http, WiFiClientSecure& client, const String& path) {
  client.setCACert(ROOT_CA_CERT);
  client.setTimeout(HTTP_TIMEOUT_MS / 1000);
  http.setConnectTimeout(HTTP_TIMEOUT_MS);
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.begin(client, String(SMART_CB_API_BASE) + path);
  http.addHeader("Accept", "application/json");
  http.addHeader("X-Device-Id", SMART_CB_DEVICE_ID);
  http.addHeader("X-Device-Key", SMART_CB_DEVICE_KEY);
}

bool postJson(const String& path, const String& payload, int& status, String& response) {
  if (WiFi.status() != WL_CONNECTED || !tlsConfigured()) return false;
  WiFiClientSecure client;
  HTTPClient http;
  configureHttp(http, client, path);
  http.addHeader("Content-Type", "application/json");
  status = http.POST(payload);
  response = status > 0 ? http.getString() : "";
  http.end();
  return status > 0;
}

void readDevices() {
  const bool pm3Ok = pm3c.read(pm3Reading);
  const bool mtsOk = mts5.read(mtsReading);
  Serial.printf(
    "PM3=%s MTS5=%s status=%s raw=0x%04X Va=%.1f V Ia=%.3f A P=%.3f kW\n",
    pm3Ok ? "OK" : "FAIL", mtsOk ? "OK" : "FAIL",
    stateName(mtsReading.breakerState), mtsReading.statusRaw,
    pm3Reading.va, pm3Reading.ia, pm3Reading.pTotalKw);
}

void addFinite(JsonDocument& doc, const char* key, float value) {
  if (isfinite(value)) doc[key] = value;
  else doc[key] = nullptr;
}

void sendTelemetry() {
  if (!timeIsValid()) return;
  JsonDocument doc;
  doc["sampledAt"] = epochMillis();
  doc["firmwareVersion"] = FIRMWARE_VERSION;
  doc["breakerState"] = stateName(mtsReading.breakerState);
  doc["pm3Connected"] = pm3Reading.ok;
  doc["mts5Connected"] = mtsReading.statusOk || mtsReading.electricalOk;
  doc["remoteControlEnabled"] = ENABLE_REMOTE_CONTROL && MTS5_STATUS_MAPPING_CONFIGURED;
  if (mtsReading.statusOk) doc["mts5StatusRaw"] = mtsReading.statusRaw;
  else doc["mts5StatusRaw"] = nullptr;
  if (mtsReading.phaseSequence != 0xFFFF) doc["phaseSequence"] = mtsReading.phaseSequence;
  else doc["phaseSequence"] = nullptr;

  addFinite(doc, "voltage", average3(pm3Reading.va, pm3Reading.vb, pm3Reading.vc));
  addFinite(doc, "current", average3(pm3Reading.ia, pm3Reading.ib, pm3Reading.ic));
  addFinite(doc, "activePower", pm3Reading.pTotalKw * 1000.0F);
  addFinite(doc, "energyKwh", pm3Reading.energyKwh);
  addFinite(doc, "frequency", pm3Reading.frequency);
  addFinite(doc, "powerFactor", average3(pm3Reading.pfA, pm3Reading.pfB, pm3Reading.pfC));
  addFinite(doc, "voltageA", pm3Reading.va);
  addFinite(doc, "voltageB", pm3Reading.vb);
  addFinite(doc, "voltageC", pm3Reading.vc);
  addFinite(doc, "voltageAB", pm3Reading.vab);
  addFinite(doc, "voltageBC", pm3Reading.vbc);
  addFinite(doc, "voltageCA", pm3Reading.vca);
  addFinite(doc, "currentA", pm3Reading.ia);
  addFinite(doc, "currentB", pm3Reading.ib);
  addFinite(doc, "currentC", pm3Reading.ic);
  addFinite(doc, "neutralCurrent", mtsReading.neutralCurrent);
  addFinite(doc, "activePowerA", pm3Reading.paKw * 1000.0F);
  addFinite(doc, "activePowerB", pm3Reading.pbKw * 1000.0F);
  addFinite(doc, "activePowerC", pm3Reading.pcKw * 1000.0F);
  addFinite(doc, "reactivePower", pm3Reading.qTotalKvar * 1000.0F);
  addFinite(doc, "reactivePowerA", pm3Reading.qaKvar * 1000.0F);
  addFinite(doc, "reactivePowerB", pm3Reading.qbKvar * 1000.0F);
  addFinite(doc, "reactivePowerC", pm3Reading.qcKvar * 1000.0F);
  addFinite(doc, "apparentPower", pm3Reading.sTotalKva * 1000.0F);
  addFinite(doc, "apparentPowerA", pm3Reading.saKva * 1000.0F);
  addFinite(doc, "apparentPowerB", pm3Reading.sbKva * 1000.0F);
  addFinite(doc, "apparentPowerC", pm3Reading.scKva * 1000.0F);
  addFinite(doc, "powerFactorA", pm3Reading.pfA);
  addFinite(doc, "powerFactorB", pm3Reading.pfB);
  addFinite(doc, "powerFactorC", pm3Reading.pfC);

  String payload;
  serializeJson(doc, payload);
  int status = 0;
  String response;
  if (!postJson("/api/device/telemetry", payload, status, response) || status != 202) {
    Serial.printf("Telemetry upload failed: HTTP %d\n", status);
  }
}

void persistResult(const String& commandId, const String& pollId,
                   const char* status, BreakerState state, const String& message) {
  prefs.putString("phase", "RESULT");
  prefs.putString("cmd", commandId);
  prefs.putString("poll", pollId);
  prefs.putString("result", status);
  prefs.putString("state", stateName(state));
  prefs.putString("message", message);
}

void clearPendingCommand() {
  prefs.remove("phase");
  prefs.remove("cmd");
  prefs.remove("poll");
  prefs.remove("action");
  prefs.remove("result");
  prefs.remove("state");
  prefs.remove("message");
}

void sendPersistedResult() {
  if (prefs.getString("phase") != "RESULT") return;
  JsonDocument doc;
  doc["commandId"] = prefs.getString("cmd");
  doc["pollId"] = prefs.getString("poll");
  doc["status"] = prefs.getString("result");
  doc["breakerState"] = prefs.getString("state", "UNKNOWN");
  doc["message"] = prefs.getString("message");
  String payload;
  serializeJson(doc, payload);
  int status = 0;
  String response;
  if (postJson("/api/device/commands/result", payload, status, response) && status >= 200 && status < 300) {
    clearPendingCommand();
    activePollId = "";
    Serial.println("Command result acknowledged");
  } else {
    Serial.printf("Result upload failed: HTTP %d\n", status);
  }
}

bool phaseVoltageSafe(float voltage) {
  return isfinite(voltage) && voltage >= SAFE_CLOSE_MIN_PHASE_VOLTAGE &&
    voltage <= SAFE_CLOSE_MAX_PHASE_VOLTAGE;
}

bool safetyAllows(const String& action, String& reason) {
  if (!ENABLE_REMOTE_CONTROL) {
    reason = "Remote control is disabled in device_config.h";
    return false;
  }
  if (!MTS5_STATUS_MAPPING_CONFIGURED) {
    reason = "MTS5 register 515 status mapping is not configured";
    return false;
  }
  uint16_t raw = 0;
  BreakerState state = BreakerState::UNKNOWN;
  if (!mts5.readStatus(raw, state) || state == BreakerState::UNKNOWN) {
    reason = "Cannot verify MTS5 breaker state";
    return false;
  }
  mtsReading.statusOk = true;
  mtsReading.statusRaw = raw;
  mtsReading.breakerState = state;
  if (action == "CLOSE") {
    if (state == BreakerState::TRIPPED) {
      reason = "Breaker is tripped; local inspection is required";
      return false;
    }
    if (!pm3c.read(pm3Reading) || !phaseVoltageSafe(pm3Reading.va) ||
        !phaseVoltageSafe(pm3Reading.vb) || !phaseVoltageSafe(pm3Reading.vc)) {
      reason = "One or more phase voltages are outside the safe closing range";
      return false;
    }
  }
  return true;
}

bool actuateAndVerify(const String& action, String& message) {
  if (!safetyAllows(action, message)) return false;
  const BreakerState target = action == "OPEN" ? BreakerState::OPEN : BreakerState::CLOSED;
  if (mtsReading.breakerState == target) {
    message = "Already in requested state";
    return true;
  }
  const bool accepted = action == "OPEN" ? mts5.commandOpen() : mts5.commandClose();
  if (!accepted) {
    message = "MTS5 did not acknowledge FC06 command";
    return false;
  }

  const uint32_t startedAt = millis();
  while (millis() - startedAt < MTS5_ACTUATION_TIMEOUT_MS) {
    delay(150);
    uint16_t raw = 0;
    BreakerState observed = BreakerState::UNKNOWN;
    if (mts5.readStatus(raw, observed)) {
      mtsReading.statusRaw = raw;
      mtsReading.breakerState = observed;
      if (observed == target) {
        message = "MTS5 state verified after FC06 command";
        return true;
      }
      if (observed == BreakerState::TRIPPED) {
        message = "Breaker reported TRIPPED during actuation";
        return false;
      }
    }
  }
  message = "Timed out waiting for MTS5 register 515 confirmation";
  return false;
}

void executeClaimedCommand(JsonObjectConst command, uint64_t serverTime) {
  const String commandId = command["commandId"] | "";
  const String deviceId = command["deviceId"] | "";
  const String action = command["action"] | "";
  const String pollId = command["pollId"] | "";
  const uint64_t expiresAt = command["expiresAt"] | 0ULL;
  if (commandId.isEmpty() || deviceId != SMART_CB_DEVICE_ID || pollId != activePollId ||
      (action != "OPEN" && action != "CLOSE")) {
    Serial.println("Rejected malformed or mismatched command");
    return;
  }

  prefs.putString("phase", "RECEIVED");
  prefs.putString("cmd", commandId);
  prefs.putString("poll", pollId);
  prefs.putString("action", action);
  if (!timeIsValid() || expiresAt <= serverTime || expiresAt <= epochMillis()) {
    uint16_t raw = 0;
    BreakerState state = BreakerState::UNKNOWN;
    mts5.readStatus(raw, state);
    persistResult(commandId, pollId, "FAILED", state, "Command expired before execution");
    return;
  }
  String message;
  const bool success = actuateAndVerify(action, message);
  persistResult(commandId, pollId, success ? "SUCCEEDED" : "FAILED",
                mtsReading.breakerState, message);
}

void resumeInterruptedCommand() {
  if (prefs.getString("phase") != "RECEIVED") return;
  const String commandId = prefs.getString("cmd");
  const String pollId = prefs.getString("poll");
  const String action = prefs.getString("action");
  uint16_t raw = 0;
  BreakerState observed = BreakerState::UNKNOWN;
  mts5.readStatus(raw, observed);
  const BreakerState target = action == "OPEN" ? BreakerState::OPEN : BreakerState::CLOSED;
  if (observed == target) {
    persistResult(commandId, pollId, "SUCCEEDED", observed,
                  "Recovered after restart; target state verified without re-actuation");
  } else {
    persistResult(commandId, pollId, "FAILED", observed,
                  "Restart occurred during command; not re-actuated for safety");
  }
}

void pollCommand() {
  if (!timeIsValid() || prefs.getString("phase") == "RESULT") return;
  if (activePollId.isEmpty()) activePollId = randomId();
  WiFiClientSecure client;
  HTTPClient http;
  configureHttp(http, client, "/api/device/commands/next?pollId=" + activePollId);
  const int status = http.GET();
  const String response = status > 0 && status != 204 ? http.getString() : "";
  http.end();
  if (status <= 0) return;  // retry the same pollId after a transport failure
  if (status == 204) { activePollId = ""; return; }
  if (status != 200) {
    Serial.printf("Command poll failed: HTTP %d\n", status);
    return;
  }
  JsonDocument doc;
  if (deserializeJson(doc, response) != DeserializationError::Ok || !doc["command"].is<JsonObject>()) {
    Serial.println("Invalid command JSON");
    return;
  }
  executeClaimedCommand(doc["command"].as<JsonObjectConst>(), doc["serverTime"] | 0ULL);
}

void processSerialCommand() {
  if (!Serial.available()) return;
  String command = Serial.readStringUntil('\n');
  command.trim();
  command.toUpperCase();
  if (command == "READ") readDevices();
  else if (command == "STATUS") {
    uint16_t raw = 0;
    BreakerState state = BreakerState::UNKNOWN;
    const bool ok = mts5.readStatus(raw, state);
    Serial.printf("MTS5 status: %s RAW=%u HEX=0x%04X decoded=%s\n",
                  ok ? "OK" : "FAIL", raw, raw, stateName(state));
  } else if (command == "OPEN" || command == "CLOSE") {
    String message;
    const bool ok = actuateAndVerify(command, message);
    Serial.printf("%s: %s\n", ok ? "SUCCESS" : "REFUSED/FAILED", message.c_str());
  } else if (command == "HELP") {
    Serial.println("READ | STATUS | OPEN | CLOSE | HELP");
  }
}

void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  const uint32_t now = millis();
  if (now - lastWifiAttemptAt < WIFI_RETRY_INTERVAL_MS) return;
  lastWifiAttemptAt = now;
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.println("Connecting Wi-Fi...");
}

void setup() {
  Serial.begin(115200);
  Serial.setTimeout(100);
  delay(300);
  rs485.begin();
  prefs.begin("smart-cb", false);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  configTime(0, 0, "pool.ntp.org", "time.cloudflare.com");

  Serial.println("Smart CB 2.0 — MTS5 ID1/8E1 + PM3C-92 ID2/8N1");
  Serial.println("Type HELP in Serial Monitor (115200, Newline)");
  if (!ENABLE_REMOTE_CONTROL) Serial.println("SAFETY LOCK: ENABLE_REMOTE_CONTROL=false");
  if (!MTS5_STATUS_MAPPING_CONFIGURED) Serial.println("SAFETY LOCK: register 515 mapping is not configured");
  if (!tlsConfigured()) Serial.println("TLS LOCK: install the correct root CA certificate");
  readDevices();
  resumeInterruptedCommand();
}

void loop() {
  processSerialCommand();
  connectWifi();
  const uint32_t now = millis();
  if (now - lastTelemetryAt >= TELEMETRY_INTERVAL_MS) {
    lastTelemetryAt = now;
    readDevices();
    if (WiFi.status() == WL_CONNECTED) sendTelemetry();
  }
  if (WiFi.status() == WL_CONNECTED && prefs.getString("phase") == "RESULT") {
    sendPersistedResult();
  } else if (WiFi.status() == WL_CONNECTED && now - lastPollAt >= POLL_INTERVAL_MS) {
    lastPollAt = now;
    pollCommand();
  }
  delay(20);
}
