#include "pm3c92.h"

#include <cstring>

#include "device_config.h"

uint32_t Pm3c92::makeU32(uint16_t highWord, uint16_t lowWord) {
  return (static_cast<uint32_t>(highWord) << 16) | lowWord;
}

float Pm3c92::makeFloat(uint16_t highWord, uint16_t lowWord) {
  const uint32_t raw = makeU32(highWord, lowWord);
  float value = NAN;
  memcpy(&value, &raw, sizeof(value));
  return value;
}

bool Pm3c92::read(Pm3cReading& value) {
  value = Pm3cReading{};
  uint16_t r[53]{};
  if (!bus_.readRegisters(PM3C_SERIAL_CONFIG, PM3C_SLAVE_ID, 0x04, 0, 53, r)) return false;

  value.va = makeU32(r[0], r[1]) / 10.0F;
  value.vb = makeU32(r[2], r[3]) / 10.0F;
  value.vc = makeU32(r[4], r[5]) / 10.0F;
  value.vab = makeU32(r[6], r[7]) / 10.0F;
  value.vbc = makeU32(r[8], r[9]) / 10.0F;
  value.vca = makeU32(r[10], r[11]) / 10.0F;
  value.ia = makeU32(r[12], r[13]) / 1000.0F;
  value.ib = makeU32(r[14], r[15]) / 1000.0F;
  value.ic = makeU32(r[16], r[17]) / 1000.0F;
  value.paKw = makeU32(r[18], r[19]) / 1000.0F;
  value.pbKw = makeU32(r[20], r[21]) / 1000.0F;
  value.pcKw = makeU32(r[22], r[23]) / 1000.0F;
  value.pTotalKw = makeU32(r[24], r[25]) / 1000.0F;
  value.qaKvar = makeU32(r[26], r[27]) / 1000.0F;
  value.qbKvar = makeU32(r[28], r[29]) / 1000.0F;
  value.qcKvar = makeU32(r[30], r[31]) / 1000.0F;
  value.qTotalKvar = makeU32(r[32], r[33]) / 1000.0F;
  value.saKva = makeU32(r[34], r[35]) / 1000.0F;
  value.sbKva = makeU32(r[36], r[37]) / 1000.0F;
  value.scKva = makeU32(r[38], r[39]) / 1000.0F;
  value.sTotalKva = makeU32(r[40], r[41]) / 1000.0F;
  value.pfA = r[42] / 1000.0F;
  value.pfB = r[43] / 1000.0F;
  value.pfC = r[44] / 1000.0F;
  value.frequency = r[52] / 1000.0F;
  value.ok = true;

  uint16_t energy[2]{};
  if (bus_.readRegisters(PM3C_SERIAL_CONFIG, PM3C_SLAVE_ID, 0x04, 116, 2, energy)) {
    const float kwh = makeFloat(energy[0], energy[1]);
    if (isfinite(kwh)) {
      value.energyKwh = kwh;
      value.energyOk = true;
    }
  }
  return true;
}
