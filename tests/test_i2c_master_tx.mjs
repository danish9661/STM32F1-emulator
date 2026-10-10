// I2C multi-byte master-TX (slave-RX direction) byte capture.
//
// Regression guard for the RTC-SET shape: real firmware (RTClib
// `rtc.adjust()` on a DS1307) performs beginTransmission(0x68) + 8 data
// bytes (register pointer + 7 BCD time bytes) + endTransmission(). Reads
// can look perfect (they ride the inject queue + virtual-claim path) while
// a slave-RX defect silently drops the SET bytes, leaving the clock at its
// old time. This test pins the engine half of that contract at register
// level: every master-TX byte must surface as exactly one I2cWrite event,
// in order, on both the engine-internal-device path and the JS-only
// (virtual-claim) path. An address no host ever served must still NACK
// (bus-scan/AF semantics), so a bare write stays silent.
//
// No firmware needed: the transfer is driven through CR1/DR/SR1/SR2 exactly
// as the STM32duino Wire layer does (START, ADDR+W, TXE-polled DR writes,
// STOP).
import { readFileSync } from 'fs';
import * as periph from '../pkg/stm32_bluepill_wasm.js';
periph.initSync({ module: readFileSync(new URL('../pkg/stm32_bluepill_wasm_bg.wasm', import.meta.url)) });

const { init, periph_read, periph_write, drain_events, add_i2c_eeprom,
    reset_ext_devices, i2c_inject_rx, i2c_clear_rx, rustcpu_init } = periph;

let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) passed++; else { failed++; console.error(`FAIL: ${msg}`); } }
function assert_eq(a, b, msg) { if (a === b) passed++; else { failed++; console.error(`FAIL: ${msg}: expected ${b}, got ${a}`); } }
function group(name) { console.log(`\n=== ${name} ===`); }

const I2C1 = 0x40005400;
const CR1 = I2C1 + 0x00, DR = I2C1 + 0x10, SR1 = I2C1 + 0x14, SR2 = I2C1 + 0x18;
const PE = 1, ACK = 1 << 10, START = 1 << 8, STOP = 1 << 9;
const ADDRF = 1 << 1, TXE = 1 << 7, AF = 1 << 10;
const ADDR = 0x68;

// adjust(DateTime(2026,10,7,12,0,0)): reg 0 + sec/min/hr/dow/date/mon/yr BCD
const ADJUST = [0x00, 0x00, 0x00, 0x12, 0x04, 0x07, 0x10, 0x26];

function fresh() {
    init();
    rustcpu_init(0x20005000, 0x08000001, 65536, 20480);
    drain_events();
}

/** Flat-decode I2cStart/I2cWrite/I2cStop for channel 1. */
function takeI2c() {
    const flat = drain_events();
    const out = { starts: [], writes: [], stops: 0 };
    let i = 0;
    while (i < flat.length) {
        const t = flat[i++];
        if (t === 2) { const ch = flat[i++], a = flat[i++]; if (ch === 1) out.starts.push(a); }
        else if (t === 3) { const ch = flat[i++], b = flat[i++]; if (ch === 1) out.writes.push(b); }
        else if (t === 5) { const ch = flat[i++]; if (ch === 1) out.stops++; }
        else break;
    }
    return out;
}

/** START + addr(W) + N TXE-polled DR bytes + STOP. Returns the ADDR-phase SR1. */
function masterTx(addr7, bytes) {
    periph_write(CR1, 4, PE | ACK | START);
    periph_write(DR, 4, (addr7 << 1) | 0);
    const sr1 = periph_read(SR1, 4);
    periph_read(SR2, 4); // clear ADDR
    if (sr1 & AF) return sr1;
    for (const b of bytes) {
        let guard = 10000;
        while (!(periph_read(SR1, 4) & TXE) && guard-- > 0) { /* TXE poll */ }
        assert(guard > 0, `master-TX TXE liveness for byte 0x${b.toString(16)}`);
        periph_write(DR, 4, b);
    }
    periph_write(CR1, 4, PE | STOP);
    return sr1;
}

const same = (got, want) => got.length === want.length && got.every((b, i) => b === want[i]);

// ── A: sink-backed (the runner attaches an i2c_eeprom ACK-sink per owned
// address, so DS1307 traffic hits an engine-internal device) ──────────────
group('master-TX: sink-backed 8-byte SET');
reset_ext_devices();
add_i2c_eeprom('I2C1', ADDR, new Uint8Array(1024));
fresh();
{
    const sr1 = masterTx(ADDR, ADJUST);
    assert((sr1 & AF) === 0, 'A write address phase ACKs (no AF)');
    assert((sr1 & ADDRF) !== 0, 'A write address phase sets ADDR');
    const ev = takeI2c();
    assert_eq(ev.starts.length, 1, 'A one I2cStart');
    assert_eq(ev.starts[0], ADDR, 'A I2cStart carries the 7-bit address');
    assert(same(ev.writes, ADJUST), `A all 8 SET bytes surface in order (got ${ev.writes.map((b) => b.toString(16)).join(' ')})`);
    assert_eq(ev.stops, 1, 'A one I2cStop');
}

// ── B: virtual-claim (JS-only slave: registered by an earlier queue-backed
// transfer, queue now dry — the read-first-then-write sensor shape) ───────
group('master-TX: virtual-claim 8-byte SET');
reset_ext_devices();
fresh();
{
    i2c_inject_rx(1, [0xAA]);
    periph_write(CR1, 4, PE | ACK | START);
    periph_write(DR, 4, (ADDR << 1) | 1);
    assert((periph_read(SR1, 4) & ADDRF) !== 0, 'B registration read ACKs');
    periph_read(SR2, 4);
    periph_write(CR1, 4, PE | STOP);
    takeI2c();
    i2c_clear_rx(1); // host drained; registration (not queue) keeps the ACK

    const sr1 = masterTx(ADDR, ADJUST);
    assert((sr1 & AF) === 0, 'B write address phase ACKs while dry (registered)');
    const ev = takeI2c();
    assert(same(ev.writes, ADJUST), `B all 8 SET bytes surface in order (got ${ev.writes.map((b) => b.toString(16)).join(' ')})`);
    assert_eq(ev.stops, 1, 'B one I2cStop');
}

// ── C: bare address (never served, empty queue) still NACKs ──────────────
group('master-TX: unregistered address NACKs');
reset_ext_devices();
fresh();
{
    const sr1 = masterTx(0x50, ADJUST);
    assert((sr1 & AF) !== 0, 'C unknown address NACKs (AF)');
    const ev = takeI2c();
    assert_eq(ev.writes.length, 0, 'C NACKed transfer emits no I2cWrite');
}

console.log(`\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed === 0 ? 0 : 1);
