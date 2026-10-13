#pragma once

#include <Arduino.h>

// Pin map taken from the two sketches supplied with the hardware.
constexpr uint8_t RS485_RX_PIN = 38;  // MAX485 RO
constexpr uint8_t RS485_RE_PIN = 35;  // MAX485 /RE
constexpr uint8_t RS485_DE_PIN = 37;  // MAX485 DE
constexpr uint8_t RS485_TX_PIN = 36;  // MAX485 DI
constexpr uint32_t RS485_BAUD = 9600;

// Both devices share the same bus but use different parity. The driver switches
// the ESP32 UART format before every transaction.
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

// MTS5 commands confirmed by the supplied sketch:
// FC06, OPEN register 2305, CLOSE register 2304, value 0x00AA.
constexpr bool ENABLE_REMOTE_CONTROL = false;
constexpr uint16_t MTS5_REG_CLOSE = 2304;
constexpr uint16_t MTS5_REG_OPEN = 2305;
constexpr uint16_t MTS5_COMMAND_EXECUTE = 0x00AA;
constexpr uint16_t MTS5_REG_STATUS = 515;

// Register 515 was only printed as RAW in the supplied sketch; its bit/value
// mapping was not defined. Capture OPEN, CLOSED and TRIPPED raw values from the
// Serial Monitor, then set the mask/values below and enable the mapping.
constexpr bool MTS5_STATUS_MAPPING_CONFIGURED = false;
constexpr uint16_t MTS5_STATUS_MASK = 0xFFFF;
constexpr uint16_t MTS5_STATUS_OPEN_VALUE = 0x0000;
constexpr uint16_t MTS5_STATUS_CLOSED_VALUE = 0x0001;
constexpr uint16_t MTS5_STATUS_TRIPPED_VALUE = 0x0002;

constexpr char FIRMWARE_VERSION[] = "smart-cb-2.0.0";
