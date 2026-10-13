#pragma once

#include <Arduino.h>

class Rs485Bus {
 public:
  explicit Rs485Bus(uint8_t uartNumber);
  void begin();
  bool readRegisters(uint32_t serialConfig, uint8_t slaveId, uint8_t functionCode,
                     uint16_t startAddress, uint16_t quantity, uint16_t* registers);
  bool writeSingleRegister(uint32_t serialConfig, uint8_t slaveId,
                           uint16_t address, uint16_t value);
  uint8_t lastException() const { return lastException_; }

 private:
  HardwareSerial serial_;
  uint32_t activeConfig_ = 0;
  uint8_t lastException_ = 0;

  void configure(uint32_t serialConfig);
  void setTransmit(bool enabled);
  void clearInput();
  bool exchange(const uint8_t* request, size_t requestLength, uint8_t* response,
                size_t expectedLength, uint8_t functionCode, uint8_t slaveId);
  static uint16_t crc16(const uint8_t* data, size_t length);
};
