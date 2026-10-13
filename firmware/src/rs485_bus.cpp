#include "rs485_bus.h"

#include "device_config.h"

Rs485Bus::Rs485Bus(uint8_t uartNumber) : serial_(uartNumber) {}

void Rs485Bus::begin() {
  pinMode(RS485_DE_PIN, OUTPUT);
  pinMode(RS485_RE_PIN, OUTPUT);
  setTransmit(false);
}

void Rs485Bus::configure(uint32_t serialConfig) {
  if (activeConfig_ == serialConfig) return;
  if (activeConfig_ != 0) serial_.end();
  delay(3);
  serial_.begin(RS485_BAUD, serialConfig, RS485_RX_PIN, RS485_TX_PIN);
  activeConfig_ = serialConfig;
  delay(5);
  clearInput();
}

void Rs485Bus::setTransmit(bool enabled) {
  digitalWrite(RS485_RE_PIN, enabled ? HIGH : LOW);
  digitalWrite(RS485_DE_PIN, enabled ? HIGH : LOW);
}

void Rs485Bus::clearInput() {
  while (serial_.available()) serial_.read();
}

uint16_t Rs485Bus::crc16(const uint8_t* data, size_t length) {
  uint16_t crc = 0xFFFF;
  for (size_t position = 0; position < length; position += 1) {
    crc ^= data[position];
    for (uint8_t bit = 0; bit < 8; bit += 1) {
      if ((crc & 0x0001) != 0) crc = (crc >> 1) ^ 0xA001;
      else crc >>= 1;
    }
  }
  return crc;
}

bool Rs485Bus::exchange(const uint8_t* request, size_t requestLength,
                        uint8_t* response, size_t expectedLength,
                        uint8_t functionCode, uint8_t slaveId) {
  lastException_ = 0;
  clearInput();
  setTransmit(true);
  delayMicroseconds(100);
  serial_.write(request, requestLength);
  serial_.flush();
  delayMicroseconds(250);
  setTransmit(false);

  size_t received = 0;
  const uint32_t startedAt = millis();
  while (millis() - startedAt < MODBUS_TIMEOUT_MS) {
    while (serial_.available() && received < expectedLength) {
      response[received++] = static_cast<uint8_t>(serial_.read());
    }
    if (received >= 5 && response[1] == static_cast<uint8_t>(functionCode | 0x80)) break;
    if (received >= expectedLength) break;
    delay(1);
  }

  if (received >= 5 && response[1] == static_cast<uint8_t>(functionCode | 0x80)) {
    lastException_ = response[2];
    Serial.printf("Modbus exception ID=%u FC=0x%02X code=0x%02X\n", slaveId, functionCode, lastException_);
    return false;
  }
  if (received != expectedLength) {
    Serial.printf("Modbus short/timeout ID=%u FC=0x%02X bytes=%u/%u\n",
                  slaveId, functionCode, static_cast<unsigned>(received),
                  static_cast<unsigned>(expectedLength));
    return false;
  }
  if (response[0] != slaveId || response[1] != functionCode) return false;
  const uint16_t receivedCrc = response[received - 2] |
    (static_cast<uint16_t>(response[received - 1]) << 8);
  return receivedCrc == crc16(response, received - 2);
}

bool Rs485Bus::readRegisters(uint32_t serialConfig, uint8_t slaveId,
                             uint8_t functionCode, uint16_t startAddress,
                             uint16_t quantity, uint16_t* registers) {
  if (registers == nullptr || quantity == 0 || quantity > 60 ||
      (functionCode != 0x03 && functionCode != 0x04)) return false;
  configure(serialConfig);
  uint8_t request[8] = {
    slaveId, functionCode, highByte(startAddress), lowByte(startAddress),
    highByte(quantity), lowByte(quantity), 0, 0,
  };
  const uint16_t crc = crc16(request, 6);
  request[6] = lowByte(crc);
  request[7] = highByte(crc);
  const size_t expectedLength = 5 + quantity * 2;
  uint8_t response[125]{};
  if (!exchange(request, sizeof(request), response, expectedLength, functionCode, slaveId)) return false;
  if (response[2] != quantity * 2) return false;
  for (uint16_t i = 0; i < quantity; i += 1) {
    registers[i] = (static_cast<uint16_t>(response[3 + i * 2]) << 8) |
      response[4 + i * 2];
  }
  return true;
}

bool Rs485Bus::writeSingleRegister(uint32_t serialConfig, uint8_t slaveId,
                                   uint16_t address, uint16_t value) {
  configure(serialConfig);
  uint8_t request[8] = {
    slaveId, 0x06, highByte(address), lowByte(address),
    highByte(value), lowByte(value), 0, 0,
  };
  const uint16_t crc = crc16(request, 6);
  request[6] = lowByte(crc);
  request[7] = highByte(crc);
  uint8_t response[8]{};
  if (!exchange(request, sizeof(request), response, sizeof(response), 0x06, slaveId)) return false;
  for (size_t i = 0; i < 6; i += 1) {
    if (response[i] != request[i]) return false;
  }
  return true;
}
