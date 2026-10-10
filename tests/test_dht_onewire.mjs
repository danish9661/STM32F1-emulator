// DHT22 one-wire timing probe (STM32F1 engine-side).
//
// Real machine-code bit-bang firmware (`tests/arduino_dht_probe`, STM32duino
// Blue Pill, Adafruit-shaped: OUTPUT-LOW wake, INPUT_PULLUP release,
// pullTime delayMicroseconds(55), loop-count expectPulse, bit = HIGH wider
// than LOW, checksum verify) reads PB0 while this harness plays the DHT22
// sensor through the public facade only — the same calls the simulator
// runner uses: gpio.pin().setInput / periphRead(IDR) / execute() slices /
// usart1.onData. Proves the engine samples sub-100us one-wire slots and
// that firmware-observed timing is datasheet-coherent.
//
// Covers two engine-side DHT kills (both produced permanent `nan`):
//  - GPIO input pull-up (MODE=00 CNF=10) IDR read 0 forever, and push-pull
//    output readback following stale injected input instead of ODR
//    (`src/peripherals/gpio.rs` pin_level).
//  - DWT CYCCNT retiring (1+FLASH LATENCY)/instr while every other clock
//    (SysTick RVR, TIM, runner budgets) paces 1 instr/cycle: STM32duino
//    delayMicroseconds() spins on CYCCNT, so at 72MHz/WS2 it ran 3x fast,
//    collapsing the >=1ms wake pulse and the 55us pull-up wait below the
//    sensor's reaction time (`src/peripherals/dwt.rs` live_rate).
//
// Pass: first served wake decodes byte-exact (T=24.6 H=55.5, cks 0x23).
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { STM32F1 } from '../pkg/stm32f1.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ELF = join(root, 'site', 'arduino_dht_probe.elf');
const GPIOB = 0x40010c00, CRL = GPIOB, ODR = GPIOB + 0x0c;

let passed = 0, failed = 0;
const ok = (cond, name) => { if (cond) { passed++; } else { failed++; console.log(`FAIL: ${name}`); } };

const mcu = await STM32F1.fromELF(readFileSync(ELF));
const E = mcu._emu;
let serial = '';
mcu.usart1.onData = (b) => { serial += String.fromCharCode(b & 0xff); };
const step = (n) => mcu.execute(n);
const drive = (high) => mcu.gpio.pin('B', 0).setInput(!!high);

// Boot until the sketch announces itself; the instr/us scale is only valid
// after STM32duino's 72MHz PLL init.
drive(true); // idle pull-up present from reset
for (let i = 0; i < 200 && !serial.includes('DHT_READY'); i++) step(50_000);
ok(serial.includes('DHT_READY'), 'probe firmware booted (DHT_READY)');
const sysclk = Number(E.rccSysclkHz?.() || 0);
ok(sysclk === 72000000, `PLL at 72MHz (got ${sysclk})`);
const IPUS = sysclk / 1e6;
const FINE = Math.max(72, Math.round(10 * IPUS)); // ~10us slices
const waitUs = (us) => {
  let n = Math.round(us * IPUS);
  while (n > 0) { const c = Math.min(FINE, n); step(c); n -= c; }
};

// T=24.6 -> 0x00F6 ; H=55.5 -> 0x022B ; cks = 0x02+0x2B+0x00+0xF6 = 0x23.
const BYTES = [0x02, 0x2b, 0x00, 0xf6, 0x23];
const sendWaveform = () => {
  waitUs(30); // sensor reaction time after release
  drive(false); waitUs(80); // ACK low
  drive(true); waitUs(80); // ACK high
  for (const b of BYTES) {
    for (let i = 7; i >= 0; i--) {
      drive(false); waitUs(50);
      drive(true); waitUs(((b >> i) & 1) ? 70 : 28);
    }
  }
  drive(false); waitUs(50); // end frame
  drive(true); // release to idle HIGH
};

// Serve one wake cycle: coarse-wait for wake-LOW (any output mode + ODR 0;
// STM32duino uses 10MHz push-pull nibble 0x1), fine-wait for the INPUT_PULLUP
// release (nibble 0x8), then drive the scripted sensor waveform.
let verdict = null;
for (let iter = 0; iter < 3 && verdict === null; iter++) {
  let wake = false;
  for (let spent = 0; spent < 40_000_000; spent += 50_000) {
    step(50_000);
    if (((E.periphRead(CRL, 4) & 0xf) & 0x3) !== 0 && (E.periphRead(ODR, 4) & 1) === 0) { wake = true; break; }
  }
  if (!wake) break;
  let rel = false;
  for (let spent = 0; spent < 300_000; spent += FINE) {
    step(FINE);
    if ((E.periphRead(CRL, 4) & 0xf) === 0x8) { rel = true; break; }
  }
  if (!rel) continue;
  // Capture the serial mark BEFORE driving: the firmware reads in real
  // time and its verdict can print during the waveform's final steps.
  const before = serial.length;
  sendWaveform();
  for (let spent = 0; spent < 60_000_000; spent += 50_000) {
    step(50_000);
    const m = /DHT_(OK T:[0-9.\-]+ H:[0-9.\-]+|CKSUM|TIMEOUT)/.exec(serial.slice(before));
    if (m) { verdict = m[0]; break; }
  }
}
ok(verdict === 'DHT_OK T:24.60 H:55.50', `one-wire read byte-exact (got ${verdict})`);

console.log(`dht_onewire: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
