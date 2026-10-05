// GPIO/transfer ordering proof (stm32f1-emu.md, GPIO-sync improvement).
//
// The wrapper drains virtual-peripheral (SPI/I2C/USART) events once per
// execute()/step() batch, AFTER that batch's GPIO pin changes (drained
// inside the core step). So a CS sampled inside `onTransfer` observes the
// level as of that transfer — not the end of the whole run.
//
// Part A proves the mechanism with register writes only (zero firmware
// instructions retired: step(0) drains without executing).
// Part B proves it on real firmware traffic (showcase: SPI1 LCD paint
// bursts gated by CS PA8, active-low) by differential: the new per-batch
// path must observe the selected level mid-run, while the legacy
// run-then-drain-once path (what execute() did before) sees only the
// end state — with IDENTICAL transfer/edge counts on both paths.
import { readFileSync } from 'fs';
import { STM32F1 } from '../pkg/stm32f1.js';

let passed = 0, failed = 0;
const ok = (cond, name) => { if (cond) { passed++; } else { failed++; console.log(`FAIL: ${name}`); } };

// ---- Part A: register-driven, no firmware progress ----
{
    const mcu = await STM32F1.fromELF(readFileSync('site/arduino_ws2812.elf'));
    const e = mcu._emu;
    const GPIOA = 0x40010800, SPI1 = 0x40013000;
    e.periphWrite(0x40021018, 4, (1 << 2) | (1 << 12)); // IOPAEN + SPI1EN
    const crl = e.periphRead(GPIOA, 4);
    e.periphWrite(GPIOA, 4, (crl & ~(0xF << 16)) | (0x3 << 16)); // PA4 push-pull out
    let mirror = null, fires = 0;
    mcu.gpio.pin('A', 4).on('change', (h) => { mirror = h ? 1 : 0; fires++; });
    const samples = [];
    mcu.spi1.onTransfer = (ch, tx) => samples.push([tx.slice(), mirror, mcu.gpio.pin('A', 4).read()]);
    e.periphWrite(GPIOA + 0x10, 4, 1 << 4); // BSRR: PA4 high
    e.periphWrite(SPI1 + 0x0C, 4, 0xAA); // SPI DR
    mcu.step(0); // drain only: retires nothing
    e.periphWrite(GPIOA + 0x10, 4, 1 << (4 + 16)); // BSRR: PA4 low
    e.periphWrite(SPI1 + 0x0C, 4, 0x55);
    mcu.step(0);
    ok(fires === 2, `two GPIO edge callbacks, no firmware (${fires})`);
    ok(samples.length === 2, `two SPI transfers (${samples.length})`);
    ok(samples[0][0][0] === 0xAA && samples[0][1] === 1 && samples[0][2] === 1,
        `transfer 1 observes fresh CS=1 (${JSON.stringify(samples[0])})`);
    ok(samples[1][0][0] === 0x55 && samples[1][1] === 0 && samples[1][2] === 0,
        `transfer 2 observes fresh CS=0 (${JSON.stringify(samples[1])})`);
    mcu.close();
}

// ---- Part B: firmware-driven differential (showcase LCD paint, CS = PA8) ----
{
    const fw = readFileSync('site/arduino_hw_showcase.elf');
    const mkShow = () => STM32F1.create({
        firmware: fw,
        ext_devices: {
            i2c_oled: [{ peripheral: 'I2C1', address: 0x3C, width: 128, height: 64 }],
            lcd: [{ peripheral: 'SPI1', cs: 'PA8' }],
        },
    });
    async function showcaseRun(mode) {
        const mcu = await mkShow();
        let fires = 0; const seen = new Set(); let txfers = 0;
        mcu.gpio.pin('A', 8).on('change', () => { fires++; });
        mcu.spi1.onTransfer = () => { txfers++; seen.add(mcu.gpio.pin('A', 8).read()); };
        if (mode === 'new') mcu.execute(150000000); // per-batch drains
        else { mcu._emu.run(150000000); mcu._drain_events(); } // legacy: drain once at end
        mcu.close();
        return { txfers, fires, seen: [...seen].sort() };
    }
    const t0 = Date.now();
    const n = await showcaseRun('new');
    const o = await showcaseRun('old');
    console.log(`showcase 2x150M: new=${JSON.stringify(n)} old=${JSON.stringify(o)} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    ok(n.txfers > 1000 && n.txfers === o.txfers,
        `transfer counts identical across drain paths (${n.txfers})`);
    ok(n.fires >= 2 && n.fires === o.fires,
        `GPIO edge counts identical across drain paths (${n.fires})`);
    ok(n.seen.includes(0), 'per-batch drains: transfers observe selected CS (0)');
    ok(o.seen.every((v) => n.seen.includes(v)), 'legacy path saw only a subset (end-state staleness)');
    ok(n.seen.length > o.seen.length, 'per-batch path observes CS states the legacy path missed');
}

console.log(`\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed === 0 ? 0 : 1);
