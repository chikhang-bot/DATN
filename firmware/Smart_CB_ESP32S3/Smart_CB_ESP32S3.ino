/*
  SMART CB - ESP32-S3 (CHỈ 1 FILE)

  Phần cứng:
    ESP32-S3 <-> MAX485 <-> MTS5(LE) địa chỉ 1 + PM3C-92 địa chỉ 2

  Nối MAX485:
    RO  -> GPIO 38
    /RE -> GPIO 35
    DE  -> GPIO 37
    DI  -> GPIO 36

  Chuẩn truyền:
    MTS5:    9600, 8E1, Modbus RTU FC03/FC06
    PM3C-92: 9600, 8N1, Modbus RTU FC04

  Trước khi nạp:
    1. Arduino IDE > Boards Manager: cài "esp32 by Espressif Systems".
    2. Library Manager: cài "ArduinoJson" phiên bản 7.x.
    3. Chọn board "ESP32S3 Dev Module" và đúng cổng COM.
    4. Sửa WIFI_SSID, WIFI_PASSWORD, API URL, DEVICE ID/KEY ở dưới.
    5. Dán Root CA của tên miền Worker vào ROOT_CA_CERT.

  AN TOÀN:
    - ENABLE_REMOTE_CONTROL mặc định false nên ESP chưa thể OPEN/CLOSE CB.
    - Phải đo và khai báo đúng mapping thanh ghi 515 của MTS5 trước khi bật.
    - Chỉ thử đóng/cắt trên mô hình an toàn, do người có chuyên môn thực hiện.
*/

#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <cstring>
#include <time.h>

// ========================= 1. CẤU HÌNH CẦN SỬA =========================

const char WIFI_SSID[] = "TEN_WIFI";
const char WIFI_PASSWORD[] = "MAT_KHAU_WIFI";

// Không đặt dấu / ở cuối URL. Ví dụ: https://smart-cb.example.workers.dev
const char SMART_CB_API_BASE[] = "https://your-worker.workers.dev";
const char SMART_CB_DEVICE_ID[] = "dev_replace_me";
const char SMART_CB_DEVICE_KEY[] = "replace-with-device-key";

// Dán chứng chỉ Root CA dạng PEM của tên miền Worker vào đây.
static const char ROOT_CA_CERT[] PROGMEM = R"EOF(
-----BEGIN CERTIFICATE-----
PASTE_ROOT_CA_CERTIFICATE_HERE
-----END CERTIFICATE-----
)EOF";

// Chỉ đổi thành true SAU KHI đã cấu hình đúng mapping trạng thái bên dưới.
constexpr bool ENABLE_REMOTE_CONTROL = false;
constexpr bool MTS5_STATUS_MAPPING_CONFIGURED = false;

// Dùng lệnh STATUS trong Serial Monitor để đo các giá trị thật của register 515.
constexpr uint16_t MTS5_STATUS_MASK = 0xFFFF;
constexpr uint16_t MTS5_STATUS_OPEN_VALUE = 0x0000;     // Thay bằng giá trị thật
constexpr uint16_t MTS5_STATUS_CLOSED_VALUE = 0x0001;   // Thay bằng giá trị thật
constexpr uint16_t MTS5_STATUS_TRIPPED_VALUE = 0x0002;  // Thay bằng giá trị thật

// ========================= 2. CẤU HÌNH PHẦN CỨNG ========================

constexpr uint8_t RS485_RX_PIN = 38;  // MAX485 RO
constexpr uint8_t RS485_RE_PIN = 35;  // MAX485 /RE
constexpr uint8_t RS485_DE_PIN = 37;  // MAX485 DE
constexpr uint8_t RS485_TX_PIN = 36;  // MAX485 DI
constexpr uint32_t RS485_BAUD = 9600;

constexpr uint8_t MTS5_SLAVE_ID = 1;
constexpr uint32_t MTS5_SERIAL_CONFIG = SERIAL_8E1;
constexpr uint8_t PM3C_SLAVE_ID = 2;
constexpr uint32_t PM3C_SERIAL_CONFIG = SERIAL_8N1;

constexpr uint32_t POLL_INTERVAL_MS = 2000;
constexpr uint32_t TELEMETRY_INTERVAL_MS = 2000;
constexpr uint32_t WIFI_RETRY_INTERVAL_MS = 5000;
constexpr uint32_t HTTP_TIMEOUT_MS = 8000;
constexpr uint32_t MODBUS_TIMEOUT_MS = 550;
constexpr uint32_t MTS5_ACTUATION_TIMEOUT_MS = 4000;

constexpr float SAFE_CLOSE_MIN_PHASE_VOLTAGE = 198.0F;
constexpr float SAFE_CLOSE_MAX_PHASE_VOLTAGE = 242.0F;

constexpr uint16_t MTS5_REG_CLOSE = 2304;
constexpr uint16_t MTS5_REG_OPEN = 2305;
constexpr uint16_t MTS5_COMMAND_EXECUTE = 0x00AA;
constexpr uint16_t MTS5_REG_STATUS = 515;
constexpr char FIRMWARE_VERSION[] = "smart-cb-one-file-2.0.0";

// ========================== 3. KIỂU DỮ LIỆU ============================

enum class BreakerState { OPEN, CLOSED, TRIPPED, UNKNOWN };

struct Pm3cReading {
  bool ok = false, energyOk = false;
  float va = NAN, vb = NAN, vc = NAN;
  float vab = NAN, vbc = NAN, vca = NAN;
  float ia = NAN, ib = NAN, ic = NAN;
  float paKw = NAN, pbKw = NAN, pcKw = NAN, pTotalKw = NAN;
  float qaKvar = NAN, qbKvar = NAN, qcKvar = NAN, qTotalKvar = NAN;
  float saKva = NAN, sbKva = NAN, scKva = NAN, sTotalKva = NAN;
  float pfA = NAN, pfB = NAN, pfC = NAN;
  float frequency = NAN, energyKwh = NAN;
};

struct Mts5Reading {
  bool electricalOk = false, statusOk = false;
  uint16_t statusRaw = 0;
  BreakerState breakerState = BreakerState::UNKNOWN;
  float va = NAN, vb = NAN, vc = NAN;
  float ia = NAN, ib = NAN, ic = NAN, neutralCurrent = NAN;
  float pTotalKw = NAN, qTotalKvar = NAN, pfTotal = NAN;
  float frequency = NAN, energyKwh = NAN;
  uint16_t phaseSequence = 0xFFFF;
};

// ============================ 4. MODBUS RTU ============================

class Rs485Bus {
 public:
  explicit Rs485Bus(uint8_t uartNumber) : serial_(uartNumber) {}

  void begin() {
    pinMode(RS485_DE_PIN, OUTPUT);
    pinMode(RS485_RE_PIN, OUTPUT);
    setTransmit(false);
  }

  bool readRegisters(uint32_t config, uint8_t id, uint8_t function,
                     uint16_t address, uint16_t quantity, uint16_t* registers) {
    if (!registers || quantity == 0 || quantity > 60 ||
        (function != 0x03 && function != 0x04)) return false;
    configure(config);
    uint8_t request[8] = {id, function, highByte(address), lowByte(address),
                          highByte(quantity), lowByte(quantity), 0, 0};
    const uint16_t crc = crc16(request, 6);
    request[6] = lowByte(crc);
    request[7] = highByte(crc);
    const size_t expected = 5 + quantity * 2;
    uint8_t response[125]{};
    if (!exchange(request, sizeof(request), response, expected, function, id)) return false;
    if (response[2] != quantity * 2) return false;
    for (uint16_t i = 0; i < quantity; ++i) {
      registers[i] = (uint16_t(response[3 + i * 2]) << 8) | response[4 + i * 2];
    }
    return true;
  }

  bool writeSingleRegister(uint32_t config, uint8_t id,
                           uint16_t address, uint16_t value) {
    configure(config);
    uint8_t request[8] = {id, 0x06, highByte(address), lowByte(address),
                          highByte(value), lowByte(value), 0, 0};
    const uint16_t crc = crc16(request, 6);
    request[6] = lowByte(crc);
    request[7] = highByte(crc);
    uint8_t response[8]{};
    if (!exchange(request, 8, response, 8, 0x06, id)) return false;
    for (size_t i = 0; i < 6; ++i) if (response[i] != request[i]) return false;
    return true;
  }

 private:
  HardwareSerial serial_;
  uint32_t activeConfig_ = 0;

  void configure(uint32_t config) {
    if (activeConfig_ == config) return;
    if (activeConfig_ != 0) serial_.end();
    delay(3);
    serial_.begin(RS485_BAUD, config, RS485_RX_PIN, RS485_TX_PIN);
    activeConfig_ = config;
    delay(5);
    while (serial_.available()) serial_.read();
  }

  void setTransmit(bool enabled) {
    digitalWrite(RS485_RE_PIN, enabled ? HIGH : LOW);
    digitalWrite(RS485_DE_PIN, enabled ? HIGH : LOW);
  }

  static uint16_t crc16(const uint8_t* data, size_t length) {
    uint16_t crc = 0xFFFF;
    for (size_t p = 0; p < length; ++p) {
      crc ^= data[p];
      for (uint8_t bit = 0; bit < 8; ++bit)
        crc = (crc & 1) ? (crc >> 1) ^ 0xA001 : crc >> 1;
    }
    return crc;
  }

  bool exchange(const uint8_t* request, size_t requestLength, uint8_t* response,
                size_t expectedLength, uint8_t function, uint8_t id) {
    while (serial_.available()) serial_.read();
    setTransmit(true);
    delayMicroseconds(100);
    serial_.write(request, requestLength);
    serial_.flush();
    delayMicroseconds(250);
    setTransmit(false);

    size_t received = 0;
    const uint32_t started = millis();
    while (millis() - started < MODBUS_TIMEOUT_MS) {
      while (serial_.available() && received < expectedLength)
        response[received++] = uint8_t(serial_.read());
      if (received >= 5 && response[1] == uint8_t(function | 0x80)) break;
      if (received >= expectedLength) break;
      delay(1);
    }
    if (received >= 5 && response[1] == uint8_t(function | 0x80)) {
      Serial.printf("Modbus exception: ID=%u FC=0x%02X code=0x%02X\n",
                    id, function, response[2]);
      return false;
    }
    if (received != expectedLength) {
      Serial.printf("Modbus timeout: ID=%u bytes=%u/%u\n", id,
                    unsigned(received), unsigned(expectedLength));
      return false;
    }
    if (response[0] != id || response[1] != function) return false;
    const uint16_t gotCrc = response[received - 2] | (uint16_t(response[received - 1]) << 8);
    return gotCrc == crc16(response, received - 2);
  }
};

Rs485Bus rs485(2);  // UART2

uint32_t makeU32(uint16_t hi, uint16_t lo) {
  return (uint32_t(hi) << 16) | lo;
}

float makeFloat(uint16_t hi, uint16_t lo) {
  const uint32_t raw = makeU32(hi, lo);
  float value = NAN;
  memcpy(&value, &raw, sizeof(value));
  return value;
}

BreakerState decodeMts5Status(uint16_t raw) {
  if (!MTS5_STATUS_MAPPING_CONFIGURED) return BreakerState::UNKNOWN;
  const uint16_t status = raw & MTS5_STATUS_MASK;
  if (status == MTS5_STATUS_TRIPPED_VALUE) return BreakerState::TRIPPED;
  if (status == MTS5_STATUS_CLOSED_VALUE) return BreakerState::CLOSED;
  if (status == MTS5_STATUS_OPEN_VALUE) return BreakerState::OPEN;
  return BreakerState::UNKNOWN;
}

// ========================= 5. ĐỌC PM3C-92 =============================

bool readPm3c(Pm3cReading& v) {
  v = Pm3cReading{};
  uint16_t r[53]{};
  if (!rs485.readRegisters(PM3C_SERIAL_CONFIG, PM3C_SLAVE_ID, 0x04, 0, 53, r)) return false;
  v.va = makeU32(r[0], r[1]) / 10.0F;    v.vb = makeU32(r[2], r[3]) / 10.0F;
  v.vc = makeU32(r[4], r[5]) / 10.0F;    v.vab = makeU32(r[6], r[7]) / 10.0F;
  v.vbc = makeU32(r[8], r[9]) / 10.0F;   v.vca = makeU32(r[10], r[11]) / 10.0F;
  v.ia = makeU32(r[12], r[13]) / 1000.0F; v.ib = makeU32(r[14], r[15]) / 1000.0F;
  v.ic = makeU32(r[16], r[17]) / 1000.0F;
  v.paKw = makeU32(r[18], r[19]) / 1000.0F; v.pbKw = makeU32(r[20], r[21]) / 1000.0F;
  v.pcKw = makeU32(r[22], r[23]) / 1000.0F; v.pTotalKw = makeU32(r[24], r[25]) / 1000.0F;
  v.qaKvar = makeU32(r[26], r[27]) / 1000.0F; v.qbKvar = makeU32(r[28], r[29]) / 1000.0F;
  v.qcKvar = makeU32(r[30], r[31]) / 1000.0F; v.qTotalKvar = makeU32(r[32], r[33]) / 1000.0F;
  v.saKva = makeU32(r[34], r[35]) / 1000.0F; v.sbKva = makeU32(r[36], r[37]) / 1000.0F;
  v.scKva = makeU32(r[38], r[39]) / 1000.0F; v.sTotalKva = makeU32(r[40], r[41]) / 1000.0F;
  v.pfA = r[42] / 1000.0F; v.pfB = r[43] / 1000.0F; v.pfC = r[44] / 1000.0F;
  v.frequency = r[52] / 1000.0F;
  v.ok = true;
  uint16_t energy[2]{};
  if (rs485.readRegisters(PM3C_SERIAL_CONFIG, PM3C_SLAVE_ID, 0x04, 116, 2, energy)) {
    const float kwh = makeFloat(energy[0], energy[1]);
    if (isfinite(kwh)) { v.energyKwh = kwh; v.energyOk = true; }
  }
  return true;
}

// ============================ 6. MTS5 =================================

bool readMts5Status(uint16_t& raw, BreakerState& state) {
  if (!rs485.readRegisters(MTS5_SERIAL_CONFIG, MTS5_SLAVE_ID, 0x03,
                           MTS5_REG_STATUS, 1, &raw)) {
    state = BreakerState::UNKNOWN;
    return false;
  }
  state = decodeMts5Status(raw);
  return true;
}

bool readMts5(Mts5Reading& v) {
  v = Mts5Reading{};
  v.statusOk = readMts5Status(v.statusRaw, v.breakerState);
  uint16_t first[11]{}, second[22]{};
  if (!rs485.readRegisters(MTS5_SERIAL_CONFIG, MTS5_SLAVE_ID, 0x03, 256, 11, first) ||
      !rs485.readRegisters(MTS5_SERIAL_CONFIG, MTS5_SLAVE_ID, 0x03, 281, 22, second))
    return v.statusOk;
  v.va = first[0] * 0.01F; v.vb = first[1] * 0.01F; v.vc = first[2] * 0.01F;
  v.ia = makeU32(first[3], first[4]) * 0.01F;
  v.ib = makeU32(first[5], first[6]) * 0.01F;
  v.ic = makeU32(first[7], first[8]) * 0.01F;
  v.neutralCurrent = makeU32(first[9], first[10]) * 0.01F;
  v.pTotalKw = int32_t(makeU32(second[0], second[1])) * 0.01F;
  v.qTotalKvar = int32_t(makeU32(second[8], second[9])) * 0.01F;
  v.pfTotal = second[16] * 0.001F;
  v.frequency = second[20] * 0.01F;
  v.phaseSequence = second[21];
  uint16_t energy[2]{};
  if (rs485.readRegisters(MTS5_SERIAL_CONFIG, MTS5_SLAVE_ID, 0x03, 770, 2, energy))
    v.energyKwh = makeU32(energy[0], energy[1]) * 0.01F;
  v.electricalOk = true;
  return true;
}

bool mts5Open() {
  return ENABLE_REMOTE_CONTROL && rs485.writeSingleRegister(
    MTS5_SERIAL_CONFIG, MTS5_SLAVE_ID, MTS5_REG_OPEN, MTS5_COMMAND_EXECUTE);
}

bool mts5Close() {
  return ENABLE_REMOTE_CONTROL && rs485.writeSingleRegister(
    MTS5_SERIAL_CONFIG, MTS5_SLAVE_ID, MTS5_REG_CLOSE, MTS5_COMMAND_EXECUTE);
}

// ========================= 7. WEB/API VÀ ĐIỀU KHIỂN =====================

Preferences prefs;
Pm3cReading pm3;
Mts5Reading mts5;
uint32_t lastTelemetryAt = 0, lastPollAt = 0, lastWifiAttemptAt = 0;
String activePollId;

const char* stateName(BreakerState state) {
  switch (state) {
    case BreakerState::OPEN: return "OPEN";
    case BreakerState::CLOSED: return "CLOSED";
    case BreakerState::TRIPPED: return "TRIPPED";
    default: return "UNKNOWN";
  }
}

bool timeIsValid() { return time(nullptr) > 1704067200; }
uint64_t epochMillis() { return uint64_t(time(nullptr)) * 1000ULL; }

String randomId() {
  char value[40];
  snprintf(value, sizeof(value), "%08lx%08lx%08lx",
           (unsigned long)esp_random(), (unsigned long)esp_random(), (unsigned long)esp_random());
  return String(value);
}

bool tlsConfigured() { return strstr(ROOT_CA_CERT, "PASTE_ROOT_CA") == nullptr; }

float average3(float a, float b, float c) {
  float total = 0; uint8_t count = 0;
  if (isfinite(a)) { total += a; ++count; }
  if (isfinite(b)) { total += b; ++count; }
  if (isfinite(c)) { total += c; ++count; }
  return count ? total / count : NAN;
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
  const bool pmOk = readPm3c(pm3);
  const bool mtsOk = readMts5(mts5);
  Serial.printf("PM3=%s MTS5=%s state=%s raw=0x%04X Va=%.1fV Ia=%.3fA P=%.3fkW\n",
                pmOk ? "OK" : "FAIL", mtsOk ? "OK" : "FAIL",
                stateName(mts5.breakerState), mts5.statusRaw, pm3.va, pm3.ia, pm3.pTotalKw);
}

void addFinite(JsonDocument& doc, const char* key, float value) {
  if (isfinite(value)) doc[key] = value; else doc[key] = nullptr;
}

void sendTelemetry() {
  if (!timeIsValid()) return;
  JsonDocument doc;
  doc["sampledAt"] = epochMillis();
  doc["firmwareVersion"] = FIRMWARE_VERSION;
  doc["breakerState"] = stateName(mts5.breakerState);
  doc["pm3Connected"] = pm3.ok;
  doc["mts5Connected"] = mts5.statusOk || mts5.electricalOk;
  doc["remoteControlEnabled"] = ENABLE_REMOTE_CONTROL && MTS5_STATUS_MAPPING_CONFIGURED;
  if (mts5.statusOk) doc["mts5StatusRaw"] = mts5.statusRaw; else doc["mts5StatusRaw"] = nullptr;
  if (mts5.phaseSequence != 0xFFFF) doc["phaseSequence"] = mts5.phaseSequence;
  else doc["phaseSequence"] = nullptr;
  addFinite(doc, "voltage", average3(pm3.va, pm3.vb, pm3.vc));
  addFinite(doc, "current", average3(pm3.ia, pm3.ib, pm3.ic));
  addFinite(doc, "activePower", pm3.pTotalKw * 1000.0F);
  addFinite(doc, "energyKwh", pm3.energyKwh);
  addFinite(doc, "frequency", pm3.frequency);
  addFinite(doc, "powerFactor", average3(pm3.pfA, pm3.pfB, pm3.pfC));
  addFinite(doc, "voltageA", pm3.va); addFinite(doc, "voltageB", pm3.vb); addFinite(doc, "voltageC", pm3.vc);
  addFinite(doc, "voltageAB", pm3.vab); addFinite(doc, "voltageBC", pm3.vbc); addFinite(doc, "voltageCA", pm3.vca);
  addFinite(doc, "currentA", pm3.ia); addFinite(doc, "currentB", pm3.ib); addFinite(doc, "currentC", pm3.ic);
  addFinite(doc, "neutralCurrent", mts5.neutralCurrent);
  addFinite(doc, "activePowerA", pm3.paKw * 1000); addFinite(doc, "activePowerB", pm3.pbKw * 1000);
  addFinite(doc, "activePowerC", pm3.pcKw * 1000);
  addFinite(doc, "reactivePower", pm3.qTotalKvar * 1000); addFinite(doc, "reactivePowerA", pm3.qaKvar * 1000);
  addFinite(doc, "reactivePowerB", pm3.qbKvar * 1000); addFinite(doc, "reactivePowerC", pm3.qcKvar * 1000);
  addFinite(doc, "apparentPower", pm3.sTotalKva * 1000); addFinite(doc, "apparentPowerA", pm3.saKva * 1000);
  addFinite(doc, "apparentPowerB", pm3.sbKva * 1000); addFinite(doc, "apparentPowerC", pm3.scKva * 1000);
  addFinite(doc, "powerFactorA", pm3.pfA); addFinite(doc, "powerFactorB", pm3.pfB); addFinite(doc, "powerFactorC", pm3.pfC);
  String payload, response; serializeJson(doc, payload); int status = 0;
  if (!postJson("/api/device/telemetry", payload, status, response) || status != 202)
    Serial.printf("Telemetry upload failed: HTTP %d\n", status);
}

void persistResult(const String& commandId, const String& pollId,
                   const char* result, BreakerState state, const String& message) {
  prefs.putString("phase", "RESULT"); prefs.putString("cmd", commandId);
  prefs.putString("poll", pollId); prefs.putString("result", result);
  prefs.putString("state", stateName(state)); prefs.putString("message", message);
}

void clearPendingCommand() {
  prefs.remove("phase"); prefs.remove("cmd"); prefs.remove("poll"); prefs.remove("action");
  prefs.remove("result"); prefs.remove("state"); prefs.remove("message");
}

void sendPersistedResult() {
  if (prefs.getString("phase") != "RESULT") return;
  JsonDocument doc;
  doc["commandId"] = prefs.getString("cmd"); doc["pollId"] = prefs.getString("poll");
  doc["status"] = prefs.getString("result"); doc["breakerState"] = prefs.getString("state", "UNKNOWN");
  doc["message"] = prefs.getString("message");
  String payload, response; serializeJson(doc, payload); int status = 0;
  if (postJson("/api/device/commands/result", payload, status, response) && status >= 200 && status < 300) {
    clearPendingCommand(); activePollId = ""; Serial.println("Command result acknowledged");
  } else Serial.printf("Result upload failed: HTTP %d\n", status);
}

bool safeVoltage(float v) {
  return isfinite(v) && v >= SAFE_CLOSE_MIN_PHASE_VOLTAGE && v <= SAFE_CLOSE_MAX_PHASE_VOLTAGE;
}

bool safetyAllows(const String& action, String& reason) {
  if (!ENABLE_REMOTE_CONTROL) { reason = "ENABLE_REMOTE_CONTROL=false"; return false; }
  if (!MTS5_STATUS_MAPPING_CONFIGURED) { reason = "Chua cau hinh mapping register 515"; return false; }
  uint16_t raw = 0; BreakerState state = BreakerState::UNKNOWN;
  if (!readMts5Status(raw, state) || state == BreakerState::UNKNOWN) {
    reason = "Khong xac minh duoc trang thai MTS5"; return false;
  }
  mts5.statusOk = true; mts5.statusRaw = raw; mts5.breakerState = state;
  if (action == "CLOSE") {
    if (state == BreakerState::TRIPPED) { reason = "CB dang TRIPPED, can kiem tra tai cho"; return false; }
    if (!readPm3c(pm3) || !safeVoltage(pm3.va) || !safeVoltage(pm3.vb) || !safeVoltage(pm3.vc)) {
      reason = "Dien ap pha nam ngoai nguong an toan"; return false;
    }
  }
  return true;
}

bool actuateAndVerify(const String& action, String& message) {
  if (!safetyAllows(action, message)) return false;
  const BreakerState target = action == "OPEN" ? BreakerState::OPEN : BreakerState::CLOSED;
  if (mts5.breakerState == target) { message = "Da o dung trang thai yeu cau"; return true; }
  const bool accepted = action == "OPEN" ? mts5Open() : mts5Close();
  if (!accepted) { message = "MTS5 khong xac nhan lenh FC06"; return false; }
  const uint32_t started = millis();
  while (millis() - started < MTS5_ACTUATION_TIMEOUT_MS) {
    delay(150); uint16_t raw = 0; BreakerState observed = BreakerState::UNKNOWN;
    if (readMts5Status(raw, observed)) {
      mts5.statusRaw = raw; mts5.breakerState = observed;
      if (observed == target) { message = "Da xac minh trang thai sau lenh"; return true; }
      if (observed == BreakerState::TRIPPED) { message = "CB bao TRIPPED khi thao tac"; return false; }
    }
  }
  message = "Het thoi gian cho xac nhan register 515";
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
    Serial.println("Rejected malformed/mismatched command"); return;
  }
  prefs.putString("phase", "RECEIVED"); prefs.putString("cmd", commandId);
  prefs.putString("poll", pollId); prefs.putString("action", action);
  if (!timeIsValid() || expiresAt <= serverTime || expiresAt <= epochMillis()) {
    uint16_t raw = 0; BreakerState state = BreakerState::UNKNOWN; readMts5Status(raw, state);
    persistResult(commandId, pollId, "FAILED", state, "Command expired before execution"); return;
  }
  String message; const bool ok = actuateAndVerify(action, message);
  persistResult(commandId, pollId, ok ? "SUCCEEDED" : "FAILED", mts5.breakerState, message);
}

void resumeInterruptedCommand() {
  if (prefs.getString("phase") != "RECEIVED") return;
  const String commandId = prefs.getString("cmd"), pollId = prefs.getString("poll");
  const String action = prefs.getString("action");
  uint16_t raw = 0; BreakerState observed = BreakerState::UNKNOWN; readMts5Status(raw, observed);
  const BreakerState target = action == "OPEN" ? BreakerState::OPEN : BreakerState::CLOSED;
  if (observed == target)
    persistResult(commandId, pollId, "SUCCEEDED", observed, "Restarted; target state verified");
  else
    persistResult(commandId, pollId, "FAILED", observed, "Restarted during command; not re-actuated");
}

void pollCommand() {
  if (!timeIsValid() || prefs.getString("phase") == "RESULT" || !tlsConfigured()) return;
  if (activePollId.isEmpty()) activePollId = randomId();
  WiFiClientSecure client; HTTPClient http;
  configureHttp(http, client, "/api/device/commands/next?pollId=" + activePollId);
  const int status = http.GET();
  const String response = status > 0 && status != 204 ? http.getString() : "";
  http.end();
  if (status <= 0) return;
  if (status == 204) { activePollId = ""; return; }
  if (status != 200) { Serial.printf("Command poll failed: HTTP %d\n", status); return; }
  JsonDocument doc;
  if (deserializeJson(doc, response) != DeserializationError::Ok || !doc["command"].is<JsonObject>()) {
    Serial.println("Invalid command JSON"); return;
  }
  executeClaimedCommand(doc["command"].as<JsonObjectConst>(), doc["serverTime"] | 0ULL);
}

// ========================= 8. SERIAL VÀ WIFI ============================

void processSerialCommand() {
  if (!Serial.available()) return;
  String command = Serial.readStringUntil('\n'); command.trim(); command.toUpperCase();
  if (command == "READ") readDevices();
  else if (command == "STATUS") {
    uint16_t raw = 0; BreakerState state = BreakerState::UNKNOWN;
    const bool ok = readMts5Status(raw, state);
    Serial.printf("MTS5 status: %s RAW=%u HEX=0x%04X decoded=%s\n",
                  ok ? "OK" : "FAIL", raw, raw, stateName(state));
  } else if (command == "OPEN" || command == "CLOSE") {
    String message; const bool ok = actuateAndVerify(command, message);
    Serial.printf("%s: %s\n", ok ? "SUCCESS" : "REFUSED/FAILED", message.c_str());
  } else if (command == "HELP") Serial.println("READ | STATUS | OPEN | CLOSE | HELP");
}

void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  const uint32_t now = millis();
  if (now - lastWifiAttemptAt < WIFI_RETRY_INTERVAL_MS) return;
  lastWifiAttemptAt = now;
  WiFi.disconnect(); WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.println("Dang ket noi Wi-Fi...");
}

// ======================== 9. SETUP VÀ LOOP =============================

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

  Serial.println("Smart CB ESP32-S3 - one file");
  Serial.println("Serial Monitor: 115200 baud, Newline; go HELP de xem lenh");
  if (!ENABLE_REMOTE_CONTROL) Serial.println("SAFETY LOCK: ENABLE_REMOTE_CONTROL=false");
  if (!MTS5_STATUS_MAPPING_CONFIGURED) Serial.println("SAFETY LOCK: chua mapping register 515");
  if (!tlsConfigured()) Serial.println("TLS LOCK: chua dan Root CA certificate");
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
  if (WiFi.status() == WL_CONNECTED && prefs.getString("phase") == "RESULT")
    sendPersistedResult();
  else if (WiFi.status() == WL_CONNECTED && now - lastPollAt >= POLL_INTERVAL_MS) {
    lastPollAt = now;
    pollCommand();
  }
  delay(20);
}
