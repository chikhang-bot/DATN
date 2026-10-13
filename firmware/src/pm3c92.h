#pragma once

#include "meter_data.h"
#include "rs485_bus.h"

class Pm3c92 {
 public:
  explicit Pm3c92(Rs485Bus& bus) : bus_(bus) {}
  bool read(Pm3cReading& reading);

 private:
  Rs485Bus& bus_;
  static uint32_t makeU32(uint16_t highWord, uint16_t lowWord);
  static float makeFloat(uint16_t highWord, uint16_t lowWord);
};
