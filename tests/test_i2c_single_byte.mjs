// I2C master-RX regression tests: single-byte (RM0008 N=1) + multi-byte
// HAL-IT tail (N=2 POS, N=14 BTF) + JS-only (virtual-claim) slaves.
//
// Proven live with an Arduino MPU6050 session on I2C1 (slave served purely
// from JS via onStart/onWrite/onRead + injectRx prefill):
//  (a) single-byte `Wire.requestFrom(0x68, 1)` returned stale 0x00 with no
//      `I2cRead`: the STOP-after-ADDR parks the transfer Idle with the byte
//      in RXNE before the firmware DR read, skipping the queue/event arm;
//  (b) the 14-byte `requestFrom(0x68, 14)` burst that follows delivered ZERO
//      bytes (all `read()` -1) although read events flowed: the RXNE loop
//      ends at count==3 with BUF off and counts 4/3/2 complete purely
//      through BTF (HAL `I2C_MasterReceive_BTF`), which the model never set
//      in master-RX — the transfer stalled at 2 remaining and twi.c timed
//      out, so `requestFrom` returned 0 (all-or-nothing).
//  (c) with no engine-internal slave at the address, even the address phase
//      NACKs (AF): a non-empty inject queue is now a virtual host's claim and
//      ACKs (ADDR like a real slave; TX bytes surface as I2cWrite), while an
//      empty queue still NACKs (bus-scan/error semantics preserved).
//
// Covers: N=1 pre-queued + late-inject, N=2 control, N=14 HAL-tail with an
// ACK-sink device AND purely JS-served (byte-exact + exact I2cRead counts),
// back-to-back 1-then-14 on one shared prefill (STOP-tail drain + START
// push-back FIFO), and NACK preservation for unclaimed addresses.
import { readFileSync } from 'fs';
import * as periph from '../pkg/stm32_bluepill_wasm.js';
periph.initSync({ module: readFileSync(new URL('../pkg/stm32_bluepill_wasm_bg.wasm', import.meta.url)) });

const { init, periph_read, periph_write, add_i2c_eeprom, reset_ext_devices,
        drain_events, i2c_inject_rx, i2c_clear_rx, rustcpu_init } = periph;

let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) passed++; else { failed++; console.error(`FAIL: ${msg}`); } }
function assert_eq(a, b, msg) { if (a === b) passed++; else { failed++; console.error(`FAIL: ${msg}: expected ${b}, got ${a}`); } }
function group(name) { console.log(`\n=== ${name} ===`); }

const I2C1 = 0x40005400;
const CR1 = I2C1 + 0x00;
const CR2 = I2C1 + 0x04;
const DR  = I2C1 + 0x10;
const SR1 = I2C1 + 0x14;
const SR2 = I2C1 + 0x18;
const SB = 1, ADDR = 1 << 1, BTF = 1 << 2, RXNE = 1 << 6, AF = 1 << 10;

// Flat-event walker -> list of [disc, ...payload] (disc lengths per lib.rs).
function decode(flat) {
  const evs = [];
  let i = 0;
  while (i < flat.length) {
    const d = flat[i];
    let len;
    switch (d) {
      case 1: len = 4 + flat[i + 2] + flat[i + 3]; break;
      case 2: case 3: case 6: len = 3; break;
      case 4: case 5: case 7: case 9: case 11: case 12: case 13: len = 2; break;
      case 8: case 10: case 16: case 19: case 22: len = 3; break;
      case 14: case 15: len = 12; break;
      case 17: len = 6; break;
      case 21: len = 4; break;
      case 18: len = 3 + flat[i + 2]; break;
      case 20: len = 5 + flat[i + 4]; break;
      default: throw new Error(`unknown event disc ${d} at ${i}`);
    }
    evs.push(Array.from(flat.slice(i, i + len)));
    i += len;
  }
  return evs;
}

function setup(sink = true) {
  reset_ext_devices();
  // ACK stand-in at the MPU6050 address; image byte 0 is 0x00 so a stale
  // preload (the bug) reads back 0x00 instead of the queued byte.
  // sink=false exercises the JS-only (virtual-claim) slave: no internal
  // device, the non-empty inject queue alone ACKs the address phase.
  if (sink) add_i2c_eeprom('I2C1', 0x68, new Uint8Array(256).fill(0x00));
  init();
  rustcpu_init(0x20005000, 0x08000001, 65536, 20480);
  periph_write(0x4002101C, 4, 1 << 21); // APB1ENR I2C1EN
  periph_write(CR1, 4, 1); // PE
  periph_write(CR2, 4, (1 << 9) | (1 << 10) | (1 << 8)); // HAL-IT: EVT+BUF+ERR
  drain_events(); // flush init-time events
}

function i2cReads(ch) {
  return decode(Array.from(drain_events())).filter(e => e[0] === 4 && e[1] === ch);
}

// ============================================================
// Test 1: single-byte master read, pre-queued byte (RM0008 N=1)
// ============================================================
group('I2C single-byte RX: pre-queued');
setup();
periph_write(CR1, 4, 1); // PE
i2c_inject_rx(1, Uint8Array.from([0xAB]));
periph_write(CR1, 4, 1 | (1 << 8)); // START -> SB
periph_write(DR, 4, 0xD1); // addr 0x68 + R
periph_read(SR1, 4); // arm ADDR clear
periph_write(CR1, 4, 1); // NACK programmed (ACK=0) before the byte
periph_read(SR2, 4); // clear ADDR -> Active{R}, RXNE
periph_write(CR1, 4, 1 | (1 << 9)); // STOP immediately after ADDR
const v1 = periph_read(DR, 4) & 0xFF;
const reads1 = i2cReads(1);
assert_eq(v1, 0xAB, 'single-byte DR returns the queued byte');
assert_eq(reads1.length, 1, 'single-byte emits exactly one I2cRead');

// ============================================================
// Test 2: single-byte master read, late inject (virtual-host
// onStart pattern: queue lands after the address-phase preload)
// ============================================================
group('I2C single-byte RX: late inject');
setup();
periph_write(CR1, 4, 1); // PE
periph_write(CR1, 4, 1 | (1 << 8)); // START
periph_write(DR, 4, 0xD1);
periph_read(SR1, 4);
periph_write(CR1, 4, 1); // NACK
periph_read(SR2, 4);
periph_write(CR1, 4, 1 | (1 << 9)); // STOP
i2c_inject_rx(1, Uint8Array.from([0x75])); // host answers I2cStart now
const v2 = periph_read(DR, 4) & 0xFF;
const reads2 = i2cReads(1);
assert_eq(v2, 0x75, 'late-injected single byte wins over the preload');
assert_eq(reads2.length, 1, 'late-inject emits exactly one I2cRead');

// ============================================================
// Test 3: two-byte control — queue consulted on every read branch
// ============================================================
group('I2C two-byte RX control');
setup();
periph_write(CR1, 4, 1 | (1 << 10)); // PE + ACK
i2c_inject_rx(1, Uint8Array.from([0x11, 0x22]));
periph_write(CR1, 4, 1 | (1 << 10) | (1 << 8)); // START
periph_write(DR, 4, 0xD1);
periph_read(SR1, 4);
periph_read(SR2, 4); // Active{R}, RXNE
const r1 = periph_read(DR, 4) & 0xFF;
const r2 = periph_read(DR, 4) & 0xFF;
periph_write(CR1, 4, 1 | (1 << 10) | (1 << 9)); // STOP
const reads3 = i2cReads(1);
assert_eq(r1, 0x11, 'two-byte first DR is the first queued byte (preload consults queue)');
assert_eq(r2, 0x22, 'two-byte second DR is the second queued byte');
assert_eq(reads3.length, 2, 'two-byte emits two I2cRead events');

// Master-TX phase: START, addr+W, ADDR-clear, bytes, STOP.
// Returns 'ack', or 'nack' (AF) when no device claims the address.
function txPhase(addr7, bytes) {
  const cr1 = periph_read(CR1, 4);
  periph_write(CR1, 4, cr1 | (1 << 10) | (1 << 8)); // ACK=1, START
  periph_write(DR, 4, (addr7 << 1) | 0);
  const s = periph_read(SR1, 4);
  if (s & AF) return 'nack';
  if (!(s & ADDR)) return 'noaddr';
  periph_read(SR1, 4); periph_read(SR2, 4); // clear ADDR
  for (const b of bytes) periph_write(DR, 4, b);
  periph_write(CR1, 4, periph_read(CR1, 4) | (1 << 9)); // STOP
  return 'ack';
}

// Master-RX with the exact HAL_IT EV dispatch (stm32f1xx_hal_i2c.c:
// RXNE&&BUF&&!BTF -> I2C_MasterReceive_RXNE, BTF&&EVT -> BTF; BUF off at
// count==3, POS+NACK for N==2, NACK+STOP for N==1). Returns { bytes, stalled }
// where stalled==null means the transfer completed like silicon.
function rxHal(addr7, n) {
  const cr1 = periph_read(CR1, 4);
  periph_write(CR1, 4, cr1 | (1 << 10) | (1 << 8)); // ACK=1, START
  periph_write(DR, 4, (addr7 << 1) | 1);
  const s = periph_read(SR1, 4);
  if (s & AF) return { bytes: [], stalled: 'AF-nack' };
  if (!(s & ADDR)) return { bytes: [], stalled: 'no-addr' };
  let count = n;
  if (count === 1) {
    periph_write(CR1, 4, periph_read(CR1, 4) & ~(1 << 10)); // NACK
    periph_read(SR1, 4); periph_read(SR2, 4);
    periph_write(CR1, 4, periph_read(CR1, 4) | (1 << 9)); // STOP
  } else if (count === 2) {
    periph_write(CR1, 4, periph_read(CR1, 4) | (1 << 11)); // POS=1
    periph_read(SR1, 4); periph_read(SR2, 4);
    periph_write(CR1, 4, periph_read(CR1, 4) & ~(1 << 10)); // NACK
  } else {
    periph_read(SR1, 4); periph_read(SR2, 4); // ACK stays 1
  }
  const bytes = [];
  let iters = 0, stalled = null;
  const bufOn = () => (periph_read(CR2, 4) & (1 << 10)) !== 0;
  while (count > 0 && iters < 200) {
    iters++;
    const sr = periph_read(SR1, 4);
    const rxne = (sr & RXNE) !== 0, btf = (sr & BTF) !== 0;
    if (rxne && bufOn() && !btf) {
      bytes.push(periph_read(DR, 4) & 0xFF); count--;
      if (count === 3) periph_write(CR2, 4, periph_read(CR2, 4) & ~(1 << 10));
    } else if (btf) {
      if (count === 4) { periph_write(CR2, 4, periph_read(CR2, 4) & ~(1 << 10)); bytes.push(periph_read(DR, 4) & 0xFF); count--; }
      else if (count === 3) { periph_write(CR1, 4, periph_read(CR1, 4) & ~(1 << 10)); bytes.push(periph_read(DR, 4) & 0xFF); count--; }
      else if (count === 2) {
        periph_write(CR1, 4, periph_read(CR1, 4) | (1 << 9)); // STOP
        bytes.push(periph_read(DR, 4) & 0xFF); count--;
        bytes.push(periph_read(DR, 4) & 0xFF); count--;
      } else { bytes.push(periph_read(DR, 4) & 0xFF); count--; }
    } else { stalled = `count=${count} sr1=0x${sr.toString(16)}`; break; }
  }
  if (count > 0 && !stalled) stalled = `iter-cap count=${count}`;
  return { bytes, stalled };
}

function assertBytes(got, want, msg) {
  assert_eq(got.length, want.length, `${msg} (length)`);
  for (let i = 0; i < Math.min(got.length, want.length); i++) {
    assert_eq(got[i], want[i], `${msg} [${i}]`);
  }
}

const BURST14 = [0x40, 0x00, 0xf0, 0xb0, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99];

// ============================================================
// Test 4: 14-byte HAL-tail burst with ACK-sink device (live MPU6050 burst:
// pointer-write + N=14; pre-fix this stalled at 2 remaining -> twi.c
// timeout -> requestFrom returned 0 -> all read() -1)
// ============================================================
group('I2C 14-byte RX: HAL tail with sink');
setup(true);
assert_eq(txPhase(0x68, [0x3B]), 'ack', 'burst pointer-write ACKs');
i2c_inject_rx(1, Uint8Array.from(BURST14));
drain_events();
const r4 = rxHal(0x68, 14);
assert_eq(r4.stalled, null, '14-byte HAL transfer completes (no stall)');
assertBytes(r4.bytes, BURST14, '14-byte burst byte-exact');
assert_eq(i2cReads(1).length, 14, '14-byte burst emits fourteen I2cRead events');

// ============================================================
// Test 5: 14-byte HAL-tail burst, JS-only slave (no internal device:
// the prefilled queue alone claims the address)
// ============================================================
group('I2C 14-byte RX: HAL tail, JS-only slave');
setup(false);
i2c_inject_rx(1, Uint8Array.from(BURST14));
drain_events();
assert_eq(txPhase(0x68, [0x3B]), 'ack', 'virtual-claim pointer-write ACKs + I2cWrite');
const r5 = rxHal(0x68, 14);
assert_eq(r5.stalled, null, 'JS-only 14-byte HAL transfer completes');
assertBytes(r5.bytes, BURST14, 'JS-only burst byte-exact');
assert_eq(i2cReads(1).length, 14, 'JS-only burst emits fourteen I2cRead events');

// ============================================================
// Test 6: back-to-back 1-then-14 on one shared prefill (live session
// shape: WHOAMI then burst; the N=1 tail re-arm + START push-back keep
// the 15-byte FIFO exact across the transfers)
// ============================================================
group('I2C back-to-back 1-then-14, JS-only, shared prefill');
setup(false);
i2c_inject_rx(1, Uint8Array.from([0x68, ...BURST14]));
drain_events();
assert_eq(txPhase(0x68, [0x6B, 0x00]), 'ack', 'wake write ACKs on claimed queue');
drain_events();
assert_eq(txPhase(0x68, [0x75]), 'ack', 'whoami pointer-write ACKs');
const r6a = rxHal(0x68, 1);
assert_eq(r6a.stalled, null, 'WHOAMI completes');
assertBytes(r6a.bytes, [0x68], 'WHOAMI byte exact');
assert_eq(i2cReads(1).length, 1, 'WHOAMI emits exactly one I2cRead');
drain_events();
assert_eq(txPhase(0x68, [0x3B]), 'ack', 'burst pointer-write ACKs');
const r6b = rxHal(0x68, 14);
assert_eq(r6b.stalled, null, 'burst after WHOAMI completes');
assertBytes(r6b.bytes, BURST14, 'burst after WHOAMI byte-exact (no shift/loss)');
assert_eq(i2cReads(1).length, 14, 'burst emits fourteen I2cRead events');

// ============================================================
// Test 7: 2-byte HAL tail (POS + STOP + double DR read), both planes
// ============================================================
group('I2C two-byte RX: HAL tail (POS)');
for (const sink of [true, false]) {
  setup(sink);
  i2c_inject_rx(1, Uint8Array.from([0xAA, 0xBB]));
  drain_events();
  const r7 = rxHal(0x68, 2);
  assert_eq(r7.stalled, null, `2-byte HAL transfer completes (sink=${sink})`);
  assertBytes(r7.bytes, [0xAA, 0xBB], `2-byte HAL byte-exact (sink=${sink})`);
  assert_eq(i2cReads(1).length, 2, `2-byte HAL emits two I2cReads (sink=${sink})`);
}

// ============================================================
// Test 8: unclaimed address still NACKs (AF) in both directions —
// bus-scan and HAL error semantics are preserved by the virtual claim
// (see also test_i2c_busy)
// ============================================================
group('I2C unclaimed address NACKs');
setup(false);
assert_eq(txPhase(0x68, [0x00]), 'nack', 'unclaimed write NACKs with AF');
periph_write(CR1, 4, periph_read(CR1, 4) | (1 << 8)); // START
periph_write(DR, 4, (0x68 << 1) | 1);
assert_eq((periph_read(SR1, 4) & AF) !== 0, true, 'unclaimed read NACKs with AF');

// ============================================================
// Test 9: i2c_clear_rx — stale leftovers poison the front without
// a clear (append-only + return-to-front), so reactive runners
// clear-then-prefill at read-START for exact transactions.
// Shape: prefill 32 stale + clear + prefill 2 fresh -> reads exact;
// cleared queue NACKs (bus-scan intact); facade (emulator.js +
// STM32F1 I2C wrapper) delegates to the same export.
// ============================================================
group('I2C clearRx: stale poison without clear, exact with clear');
const STALE32 = Array.from({ length: 32 }, (_, i) => 0xA0 + (i & 0x1F));
// Without a clear the stale front wins (the hazard is real: first two
// reads come from the previous transaction's leftovers, not the fresh
// prefill appended behind them).
setup(false);
i2c_inject_rx(1, Uint8Array.from(STALE32));
i2c_inject_rx(1, Uint8Array.from([0xAA, 0xBB]));
drain_events();
const r9poison = rxHal(0x68, 2);
assert_eq(r9poison.stalled, null, 'poisoned transfer still completes');
assertBytes(r9poison.bytes, [0xA0, 0xA1], 'no clear: stale front poisons the read');
// Clear-then-prefill: the same stale history, cleared first, reads exact.
setup(false);
i2c_inject_rx(1, Uint8Array.from(STALE32));
i2c_clear_rx(1);
i2c_inject_rx(1, Uint8Array.from([0xAA, 0xBB]));
drain_events();
const r9exact = rxHal(0x68, 2);
assert_eq(r9exact.stalled, null, 'cleared transfer completes');
assertBytes(r9exact.bytes, [0xAA, 0xBB], 'clear + prefill: reads exact');
assert_eq(i2cReads(1).length, 2, 'clear + prefill emits two I2cReads');
// A cleared (empty) queue still NACKs the address phase -- unless this
// address already has a registered host. The transfer above (r9exact)
// registered 0x68, and the registration is sticky across START/STOP and
// queue drains (a real slave does not un-address itself when its TX buffer
// is momentarily empty; clearing only drops queued bytes, never the claim).
// So 0x68 still ACKs here; bus-scan NACK is preserved for addresses no host
// ever served (Test 8 above + the 0x50 probe below).
i2c_clear_rx(1);
assert_eq(txPhase(0x68, [0x00]), 'ack', 'cleared queue still ACKs a registered address');
assert_eq(txPhase(0x50, [0x00]), 'nack', 'cleared queue NACKs a never-registered address');

// Facade path: the runner's level (emulator.js i2cClearRx + STM32F1
// I2C.clearRx/injectRx) drives the same queue — prefill 32 stale,
// clear, prefill 2 fresh, 2-byte master-RX reads exact.
const { createEmulator } = await import('../pkg/emulator.js');
const { I2C } = await import('../pkg/stm32f1.js');
const emu = await createEmulator({ firmware: Uint8Array.from([0x00, 0x50, 0x00, 0x20, 0x01, 0x00, 0x00, 0x08]) });
emu.periphWrite(0x4002101C, 4, 1 << 21); // APB1ENR I2C1EN
emu.periphWrite(CR1, 4, 1); // PE
assert_eq(typeof emu.i2cClearRx, 'function', 'emulator facade exposes i2cClearRx');
const bus = new I2C({ _emu: emu }, 1);
bus.injectRx(STALE32);
bus.clearRx();
bus.injectRx([0xCC, 0xDD]);
emu.drainEvents();
emu.periphWrite(CR1, 4, 1 | (1 << 10)); // PE + ACK
emu.periphWrite(CR1, 4, 1 | (1 << 10) | (1 << 8)); // START
emu.periphWrite(DR, 4, (0x68 << 1) | 1);
assert_eq((emu.periphRead(SR1, 4) & ADDR) !== 0, true, 'facade: cleared+prefilled claim ACKs');
emu.periphRead(SR1, 4); emu.periphRead(SR2, 4);
const f1 = emu.periphRead(DR, 4) & 0xFF;
const f2 = emu.periphRead(DR, 4) & 0xFF;
emu.periphWrite(CR1, 4, emu.periphRead(CR1, 4) | (1 << 9)); // STOP
assert_eq(f1, 0xCC, 'facade: first byte is fresh (not stale)');
assert_eq(f2, 0xDD, 'facade: second byte is fresh (not stale)');

// ============================================================
// Summary
// ============================================================
console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed === 0) console.log('ALL TESTS PASSED');
else console.log('SOME TESTS FAILED');
process.exit(failed > 0 ? 1 : 0);
