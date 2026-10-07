// I2C JS-only virtual slave: pointer write + repeated START + read-N.
//
// Regression: the virtual-claim path was gated purely on the inject queue
// being non-empty AT THE ADDRESS PHASE. Once a host drained its queue, the
// next address phase NACKed (AF), onWrite never fired, the host never
// re-armed, and a read returned 0x00 with zero I2cRead events. Symptom seen
// in the browser: pointer write + endTransmission(false) +
// requestFrom(addr, 1) -> 0x00 always, while a longer burst from the same
// session happened to be byte-exact because it consumed the pre-armed region.
//
// No engine-internal slave exists at 0x68 here; the device is JS-only via
// onStart/onWrite/onRead + injectRx, like the page's I2C slave card and the
// MPU6050 virtual sensor.
//
// Two levels:
//   A. Register level (exact timing) - pins the behaviour change: an address
//      the host has registered keeps ACKing after the queue drains, an
//      unregistered one still NACKs (bus-scan/AF semantics preserved), and a
//      peripheral SW reset drops the registration.
//   B. Firmware level (arduino_i2c_js_slave.elf) - pointer write +
//      endTransmission(false) + requestFrom(0x68, 1|6) over real HAL code,
//      asserting the exact bytes and one I2cRead per queue-sourced byte.
import { readFileSync } from 'fs';
import { createEmulator } from '../pkg/emulator.js';
import { STM32F1 } from '../pkg/stm32f1.js';

const ELF = 'site/arduino_i2c_js_slave.elf';
const I2C1 = 0x40005400;
const CH = 1;
const ADDR = 0x68;
const R = { CR1: 0x00, DR: 0x10, SR1: 0x14, SR2: 0x18 };
const PE = 1, ACK = 1 << 10, START = 1 << 8, STOP = 1 << 9;
const ADDRF = 1 << 1, AF = 1 << 10;

let passed = 0, failed = 0;
const ok = (cond, name, extra = '') => {
    if (cond) passed++;
    else { failed++; console.log(`FAIL: ${name}${extra ? ` -- ${extra}` : ''}`); }
};

const fresh = () => createEmulator({ firmware: readFileSync(ELF) });
const rd = (emu, r) => emu.periphRead(I2C1 + r, 4);
const wr = (emu, r, v) => emu.periphWrite(I2C1 + r, 4, v);

/** START + address byte; reads SR1 then SR2 (clears ADDR), then STOP. */
function transfer(emu, addr7, { read = false } = {}) {
    wr(emu, R.CR1, PE | ACK | START);
    wr(emu, R.DR, (addr7 << 1) | (read ? 1 : 0));
    const sr1 = rd(emu, R.SR1);
    rd(emu, R.SR2);
    wr(emu, R.CR1, PE | STOP);
    return sr1;
}

// ── A1: cold start, empty queue — an unknown address must still NACK ──────
{
    const emu = await fresh();
    const sr1 = transfer(emu, ADDR);
    ok((sr1 & AF) !== 0, 'A1 unregistered address NACKs on an empty queue (AF)',
        `sr1=0x${sr1.toString(16)}`);
    ok((sr1 & ADDRF) === 0, 'A1 unregistered address does not set ADDR');
    emu.close();
}

// ── A2: registered address keeps ACKing after the queue drains (THE FIX) ───
{
    const emu = await fresh();
    emu.i2cInjectRx(CH, [0xAA]);
    const first = transfer(emu, ADDR);
    ok((first & ADDRF) !== 0, 'A2 first transfer ACKs and sets ADDR',
        `sr1=0x${first.toString(16)}`);

    emu.i2cClearRx(CH); // host drained its queue
    const second = transfer(emu, ADDR);
    ok((second & AF) === 0, 'A2 after drain the address phase still ACKs (no AF)',
        `sr1=0x${second.toString(16)}`);
    ok((second & ADDRF) !== 0, 'A2 after drain the address phase still sets ADDR',
        `sr1=0x${second.toString(16)}`);
    emu.close();
}

// ── A3: registration is per-address, not per-channel ─────────────────────
{
    const emu = await fresh();
    emu.i2cInjectRx(CH, [0xAA]);
    transfer(emu, ADDR);
    emu.i2cClearRx(CH);
    const other = transfer(emu, 0x50);
    ok((other & AF) !== 0, 'A3 a never-registered address still NACKs (AF)',
        `sr1=0x${other.toString(16)}`);
    emu.close();
}

// ── A4: single-byte master read returns the queued byte (reported symptom) ─
{
    const emu = await fresh();
    emu.i2cInjectRx(CH, [0xAA]);
    transfer(emu, ADDR);
    emu.i2cClearRx(CH);
    emu.i2cInjectRx(CH, [0x5C]);

    wr(emu, R.CR1, PE | ACK | START);
    wr(emu, R.DR, (ADDR << 1) | 1); // read address
    ok((rd(emu, R.SR1) & AF) === 0, 'A4 read address phase ACKs');
    rd(emu, R.SR2);
    wr(emu, R.CR1, PE | STOP);       // HAL NACKs + STOPs at ADDR when N==1
    const dr = rd(emu, R.DR);         // then drains the byte via RXNE
    ok(dr === 0x5c, 'A4 single-byte read returns the queued byte',
        `dr=0x${dr.toString(16)}`);
    emu.close();
}

// ── A5: a peripheral SW reset drops the registration ────────────────────
{
    const emu = await fresh();
    emu.i2cInjectRx(CH, [0xAA]);
    transfer(emu, ADDR);
    emu.i2cClearRx(CH);
    wr(emu, R.CR1, PE | (1 << 15)); // SW reset
    const sr1 = transfer(emu, ADDR);
    ok((sr1 & AF) !== 0, 'A5 SW reset clears the host registration (AF again)',
        `sr1=0x${sr1.toString(16)}`);
    emu.close();
}

// ── B: firmware level, real HAL, exact bytes + one I2cRead per byte ───────
// Host timing: events drain once per execute batch, so a host cannot react to
// onWrite and still serve the read of the same batch — the whole
// pointer-write + read transaction runs inside one batch. The host therefore
// pre-arms the payload for both cases up front, exactly as the page's slave
// card does. Distinct per-transfer bytes prove FIFO is preserved across the
// drained queue.
{
    const mcu = await STM32F1.fromELF(readFileSync(ELF));
    let reads = 0, writes = 0, starts = 0, stops = 0;
    mcu.i2c1.onStart = () => { starts++; };
    mcu.i2c1.onWrite = () => { writes++; };
    mcu.i2c1.onRead = () => { reads++; };
    mcu.i2c1.onStop = () => { stops++; };

    const p1 = [0xa0];                      // READ1 payload
    const p6 = [0xb0, 0xb1, 0xb2, 0xb3, 0xb4, 0xb5]; // READ6 payload
    // NOTE: a flat array of byte values. A nested array ([p1.concat(p6)])
    // collapses in Uint8Array.from to a single 0x00 -- the model then
    // faithfully serves that zero, which looks exactly like the original bug.
    mcu.i2c1.clearRx();
    mcu.i2c1.injectRx(p1.concat(p6));

    let out = '';
    for (let k = 0; k < 500; k++) {
        mcu.step(20_000);
        out += mcu.uartOutput;
        if (out.includes('DONE')) break;
    }

    const field = (name, key) => {
        const m = (out.match(new RegExp(`^${name} .*$`, 'm')) || [''])[0]
            .match(new RegExp(`${key}=(\\S+)`));
        return m ? m[1] : '';
    };
    const bytesOf = (name) =>
        (out.match(new RegExp(`^${name} .*?b=(.*)$`, 'm')) || [0, ''])[1]
            .trim().split(/\s+/).filter(Boolean).map((h) => parseInt(h, 16));
    const same = (got, want) => got.length === want.length && got.every((b, i) => b === want[i]);

    ok(field('READ1', 'n') === '1', 'B READ1 delivers exactly 1 byte', out);
    ok(same(bytesOf('READ1'), p1), 'B READ1 returns the queued byte',
        `got ${bytesOf('READ1').map((b) => b.toString(16))}`);
    ok(field('READ6', 'n') === '6', 'B READ6 delivers 6 bytes', out);
    ok(same(bytesOf('READ6'), p6), 'B READ6 bytes are the queued payload in FIFO order',
        `got ${bytesOf('READ6').map((b) => b.toString(16))}`);

    // First byte of each transfer is preloaded into DR at the address phase
    // (nothing clocked yet, so no event); the rest come from DR reads. READ1's
    // single byte takes the STOP-parked path (HAL NACKs + STOPs immediately at
    // ADDR when N==1, then drains RXNE) which emits one event per drained
    // byte, same as every other queue-sourced byte. So one event per
    // requested byte: 1 + 6 = 7.
    ok(reads === 7, 'B one I2cRead per requested byte (got 7)', `got ${reads}`);
    ok(writes === 2, 'B both pointer writes observed', `got ${writes}`);
    ok(starts >= 4, 'B address phases seen', `got ${starts}`);
    ok(stops >= 2, 'B STOPs seen', `got ${stops}`);

    console.log(`i2c js-slave: start=${starts} write=${writes} read=${reads} stop=${stops}`);
    console.log(`READ1 n=${field('READ1', 'n')} b=${bytesOf('READ1').map((b) => b.toString(16)).join(' ')}`);
    console.log(`READ6 n=${field('READ6', 'n')} b=${bytesOf('READ6').map((b) => b.toString(16)).join(' ')}`);
    mcu.close();
}

console.log(`\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed === 0 ? 0 : 1);
