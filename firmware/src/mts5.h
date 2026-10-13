#pragma once

#include "meter_data.h"
#include "rs485_bus.h"

class Mts5 {
 public:
  explicit Mts5(Rs485Bus& bus) : bus_(bus) {}
  bool read(Mts5Reading& reading);
  bool readStatus(uint16_t& rawStatus, BreakerState& state);
  bool commandOpen();
  bool commandClose();

 private:
  Rs485Bus& bus_;
  static uint32_t makeU32(uint16_t highWord, uint16_t lowWord);
  static int32_t makeS32(uint16_t highWord, uint16_t lowWord);
  static BreakerState decodeStatus(uint16_t rawStatus);
};
