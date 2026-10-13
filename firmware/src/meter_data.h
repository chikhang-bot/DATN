#pragma once

#include <Arduino.h>

enum class BreakerState { OPEN, CLOSED, TRIPPED, UNKNOWN };

struct Pm3cReading {
  bool ok = false;
  bool energyOk = false;
  float va = NAN, vb = NAN, vc = NAN;
  float vab = NAN, vbc = NAN, vca = NAN;
  float ia = NAN, ib = NAN, ic = NAN;
  float paKw = NAN, pbKw = NAN, pcKw = NAN, pTotalKw = NAN;
  float qaKvar = NAN, qbKvar = NAN, qcKvar = NAN, qTotalKvar = NAN;
  float saKva = NAN, sbKva = NAN, scKva = NAN, sTotalKva = NAN;
  float pfA = NAN, pfB = NAN, pfC = NAN;
  float frequency = NAN;
  float energyKwh = NAN;
};

struct Mts5Reading {
  bool electricalOk = false;
  bool statusOk = false;
  uint16_t statusRaw = 0;
  BreakerState breakerState = BreakerState::UNKNOWN;
  float va = NAN, vb = NAN, vc = NAN;
  float ia = NAN, ib = NAN, ic = NAN, neutralCurrent = NAN;
  float pTotalKw = NAN, qTotalKvar = NAN, pfTotal = NAN;
  float frequency = NAN, energyKwh = NAN;
  uint16_t phaseSequence = 0xFFFF;
};
