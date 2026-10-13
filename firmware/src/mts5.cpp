#include "mts5.h"

#include "device_config.h"

uint32_t Mts5::makeU32(uint16_t highWord, uint16_t lowWord) {
  return (static_cast<uint32_t>(highWord) << 16) | lowWord;
}

int32_t Mts5::makeS32(uint16_t highWord, uint16_t lowWord) {
  return static_cast<int32_t>(makeU32(highWord, lowWord));
}

BreakerState Mts5::decodeStatus(uint16_t rawStatus) {
  if (!MTS5_STATUS_MAPPING_CONFIGURED) return BreakerState::UNKNOWN;
  const uint16_t status = rawStatus & MTS5_STATUS_MASK;
  if (status == MTS5_STATUS_TRIPPED_VALUE) return BreakerState::TRIPPED;
  if (status == MTS5_STATUS_CLOSED_VALUE) return BreakerState::CLOSED;
  if (status == MTS5_STATUS_OPEN_VALUE) return BreakerState::OPEN;
  return BreakerState::UNKNOWN;
}

bool Mts5::readStatus(uint16_t& rawStatus, BreakerState& state) {
  if (!bus_.readRegisters(MTS5_SERIAL_CONFIG, MTS5_SLAVE_ID, 0x03,
                          MTS5_REG_STATUS, 1, &rawStatus)) {
    state = BreakerState::UNKNOWN;
    return false;
  }
  state = decodeStatus(rawStatus);
  return true;
}

bool Mts5::read(Mts5Reading& value) {
  value = Mts5Reading{};
  value.statusOk = readStatus(value.statusRaw, value.breakerState);

  uint16_t first[11]{};
  uint16_t second[22]{};
  if (!bus_.readRegisters(MTS5_SERIAL_CONFIG, MTS5_SLAVE_ID, 0x03, 256, 11, first) ||
      !bus_.readRegisters(MTS5_SERIAL_CONFIG, MTS5_SLAVE_ID, 0x03, 281, 22, second)) {
    return value.statusOk;
  }

  value.va = first[0] * 0.01F;
  value.vb = first[1] * 0.01F;
  value.vc = first[2] * 0.01F;
  value.ia = makeU32(first[3], first[4]) * 0.01F;
  value.ib = makeU32(first[5], first[6]) * 0.01F;
  value.ic = makeU32(first[7], first[8]) * 0.01F;
  value.neutralCurrent = makeU32(first[9], first[10]) * 0.01F;
  value.pTotalKw = makeS32(second[0], second[1]) * 0.01F;
  value.qTotalKvar = makeS32(second[8], second[9]) * 0.01F;
  value.pfTotal = second[16] * 0.001F;
  value.frequency = second[20] * 0.01F;
  value.phaseSequence = second[21];

  uint16_t energy[2]{};
  if (bus_.readRegisters(MTS5_SERIAL_CONFIG, MTS5_SLAVE_ID, 0x03, 770, 2, energy)) {
    value.energyKwh = makeU32(energy[0], energy[1]) * 0.01F;
  }
  value.electricalOk = true;
  return true;
}

bool Mts5::commandOpen() {
  return ENABLE_REMOTE_CONTROL && bus_.writeSingleRegister(
    MTS5_SERIAL_CONFIG, MTS5_SLAVE_ID, MTS5_REG_OPEN, MTS5_COMMAND_EXECUTE);
}

bool Mts5::commandClose() {
  return ENABLE_REMOTE_CONTROL && bus_.writeSingleRegister(
    MTS5_SERIAL_CONFIG, MTS5_SLAVE_ID, MTS5_REG_CLOSE, MTS5_COMMAND_EXECUTE);
}
