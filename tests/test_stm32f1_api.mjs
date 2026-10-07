// stm32f1.js wrapper test: validates the ergonomic API over emulator.js,
// including the Wokwi-style virtual-peripheral event queue (USART/SPI/I2C
// transaction events drained from the core once per batch).
//
// Key checks:
//  - gpio.pin().read() returns a 0/1 level
//  - usart1.onData captures USART1 TX ("WS2812=ok") via the core event queue
//    (the firmware prints on Serial1 = USART1)
//  - spi1.onTransfer fires for the SPI1 DMA-to-DR transfers that drive the strip
import { readFileSync } from 'fs';
import { STM32F1 } from '../pkg/stm32f1.js';

const ELF = 'site/arduino_ws2812.elf';
const MAX = 100000000;
const CHUNK = 5000000;

let passed = 0, failed = 0;
const ok = (cond, name) => { if (cond) { passed++; } else { failed++; console.log(`FAIL: ${name}`); } };

const mcu = await STM32F1.fromELF(readFileSync(ELF));

// Ergonomic surface present
ok(mcu.gpio && typeof mcu.gpio.pin === 'function', 'gpio.pin() exists');
ok(mcu.usart1 && mcu.usart2 && mcu.usart3, 'usart1/2/3 exist');
ok(mcu.spi1 && mcu.spi2 && mcu.i2c1, 'spi1/2 and i2c1 exist');
const pa5 = mcu.gpio.pin('A', 5);
ok(typeof pa5.read() === 'number', 'gpio.pin().read() returns a level');

// Per-pin change subscription returns an unsubscribe fn
const unsub = pa5.on('change', () => {});
ok(typeof unsub === 'function', 'gpio.pin().on("change") returns unsubscribe');
unsub();

// Capture USART1 TX (firmware prints "WS2812=ok" on Serial1 = USART1)
let tx = [];
mcu.usart1.onData = (b) => tx.push(b);

// Capture SPI1 transactions (firmware drives the WS2812 strip over SPI1)
let spiTx = [], spiCount = 0;
mcu.spi1.onTransfer = (ch, t, r) => { spiCount++; spiTx.push(...t); };

const t0 = Date.now();
let done = 0, captured = false;
while (done < MAX) {
    const n = Math.min(CHUNK, MAX - done);
    const r = await mcu.execute(n);
    done += n;
    const s = new TextDecoder().decode(Uint8Array.from(tx));
    if (s.includes('WS2812=ok')) { captured = true; break; }
    if (r.stopped) break;
}
const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
const txStr = new TextDecoder().decode(Uint8Array.from(tx));

ok(captured, `usart1.onData captured "WS2812=ok" (got: ${JSON.stringify(txStr.slice(0, 60))})`);
ok(spiCount > 0, `spi1.onTransfer fired (${spiCount} transfers, ${spiTx.length} tx bytes)`);

// USB IN completion -> onUsbIn dispatch (registers driven directly; the
// ws2812 firmware never touches USB so manual arming is undisturbed)
let usbIn = null;
mcu.onUsbIn = (ep, data) => { usbIn = [ep, data]; };
const U = 0x40005C00, PMA = 0x40006000;
mcu._emu.periphWrite(U + 0x40, 4, 0x8000); // CNTR: CTRM
mcu._emu.periphWrite(U + 0x00, 4, 0x3200); // EP0 control + RX VALID
mcu._emu.periphWrite(U + 0x50, 4, 0);      // BTABLE = 0
mcu._emu.periphWrite(PMA + 0, 2, 0x30);    // ADDR0_TX (DESC0)
mcu._emu.periphWrite(PMA + 4, 2, 4);       // COUNT0_TX = 4
mcu._emu.periphWrite(PMA + 8, 2, 0x20);    // ADDR0_RX (DESC1)
ok(mcu._emu.usbInjectSetup([1, 2, 3, 4, 5, 6, 7, 8]) === true, 'usbInjectSetup accepted');
mcu._emu.periphWrite(U + 0x00, 4, 0x3200); // clear CTR_RX
// TX buffer at PMA word 0x30 -> APB bytes 96/97/100/101 (4-byte spread)
for (let i = 0; i < 4; i++) mcu._emu.periphWrite(PMA + 96 + (i >> 1) * 4 + (i & 1), 1, 0xA0 + i);
mcu._emu.periphWrite(PMA + 4, 2, 4);
mcu._emu.periphWrite(U + 0x00, 4, 0x0030); // STAT_TX DISABLED -> VALID: IN fires
mcu.step(5000);
ok(usbIn && usbIn[0] === 0 && usbIn[1].join(',') === '160,161,162,163',
    'onUsbIn dispatched with PMA buffer bytes');

// ADC inject + TIM observe surface exists
ok(mcu.adc1 && mcu.adc2 && mcu.adc3, 'adc1/2/3 exist');
ok(mcu.tim1 && mcu.tim2 && mcu.tim3, 'tim1/2/3 exist');

// Reset clears everything, synchronously: accumulated USART TX buffers
// must not leak across the reload (multi-board lockstep contract).
ok(tx.length > 0, 'sanity: ws2812 run produced TX bytes before reset');
await mcu.reset();
ok(mcu.usart1._buf.length === 0, 'reset clears accumulated USART TX buffers');

// ADC inject end-to-end on the fresh emulator: hold PA0 (ADC1 ch0) at
// 1650 mV -> code 2048, convert via registers, read DR back.
const A1 = 0x40012400;
mcu._emu.periphWrite(0x40021018, 4, 1 << 9); // APB2ENR: ADC1EN
mcu._emu.adcSetRcTau(1); // settle instantly for exact readback
let adcDone = null;
mcu.onAdcDone = (adc, ch) => { adcDone = [adc, ch]; };
mcu.adc1.setVoltage(0, 1650);
mcu._emu.periphWrite(A1 + 0x08, 4, 1); // ADON
mcu._emu.periphWrite(A1 + 0x08, 4, 1 | (1 << 22)); // ADON + SWSTART
mcu.step(5000);
ok((mcu._emu.periphRead(A1, 4) & 2) === 2, 'ADC EOC after injected conversion');
ok((mcu._emu.periphRead(A1 + 0x4C, 4) & 0xFFF) === 2048, 'ADC DR matches injected 1650mV');
ok(adcDone && adcDone[0] === 1 && adcDone[1] === 0, 'onAdcDone fired for ADC1 ch0');

// TIM observe end-to-end: TIM2 at PSC=7/ARR=999/CCR1=250 on the default
// 8 MHz HSI tree -> 1 kHz at 25% duty; UIE arms the update event.
mcu._emu.periphWrite(0x4002101C, 4, 1 << 0); // APB1ENR: TIM2EN
const T2 = 0x40000000;
mcu._emu.periphWrite(T2 + 0x28, 4, 7); // PSC
mcu._emu.periphWrite(T2 + 0x2C, 4, 999); // ARR
mcu._emu.periphWrite(T2 + 0x34, 4, 250); // CCR1
mcu._emu.periphWrite(T2 + 0x18, 4, (0b110 << 4) | (1 << 3)); // OC1M=PWM1, OC1PE
mcu._emu.periphWrite(T2 + 0x20, 4, 1); // CCER: CC1E
mcu._emu.periphWrite(T2 + 0x0C, 4, 1); // DIER: UIE
mcu._emu.periphWrite(T2 + 0x00, 4, 1); // CR1: CEN
let timUpd = null;
mcu.onTimUpdate = (t) => { timUpd = t; };
mcu.step(20000);
ok(mcu.tim2.enabled() === true, 'tim2.enabled() reflects CEN');
ok(mcu.tim2.duty(0) === 25, 'tim2.duty(0) reads programmed 25%');
// NOTE: the ws2812 firmware brought up PLL 72 MHz with PPRE1=/2 while we were
// stepping, so the live TIM2 clock is 2x36 = 72 MHz (APB x2 rule):
// 72e6 / ((7+1) * (999+1)) = 9000 Hz. frequency() follows the LIVE tree.
const livePclk1 = mcu._emu.rccClocksHz()[2];
ok(livePclk1 === 36000000, `live PCLK1 is PLL/2 (${livePclk1})`);
ok(mcu.tim2.frequency() === 9000, 'tim2.frequency() derives 9kHz from live PSC/ARR/clocks');
ok(timUpd === 2, 'onTimUpdate fired for TIM2');
ok(mcu.tim3.enabled() === false && mcu.tim3.frequency() === 0 && mcu.tim3.duty(0) === 0,
    'stopped timer observes duty/frequency as 0');

// TIM all-channel duty: CCR2/3/4 + CCER enable -> duty(1..3).
mcu._emu.periphWrite(T2 + 0x38, 4, 500); // CCR2
mcu._emu.periphWrite(T2 + 0x3C, 4, 750); // CCR3
mcu._emu.periphWrite(T2 + 0x40, 4, 1000); // CCR4
mcu._emu.periphWrite(T2 + 0x20, 4, 0x1111); // CC1E..CC4E
mcu.step(20000);
ok(mcu.tim2.duty(1) === 50, 'tim2.duty(1) reads 50%');
ok(mcu.tim2.duty(2) === 75, 'tim2.duty(2) reads 75%');
ok(mcu.tim2.duty(3) === 100, 'tim2.duty(3) reads 100%');

// Servo shape: TIM3 at 50 Hz (PSC=1439/ARR=999 on the live 72 MHz timer
// clock) with a 1.5 ms pulse -> duty 7%.
const T3 = 0x40000400;
mcu._emu.periphWrite(0x4002101C, 4, mcu._emu.periphRead(0x4002101C, 4) | (1 << 1)); // +TIM3EN
mcu._emu.periphWrite(T3 + 0x28, 4, 1439); // PSC
mcu._emu.periphWrite(T3 + 0x2C, 4, 999); // ARR
mcu._emu.periphWrite(T3 + 0x34, 4, 75); // CCR1 = 1.5 ms pulse
mcu._emu.periphWrite(T3 + 0x20, 4, 1); // CCER: CC1E
mcu._emu.periphWrite(T3 + 0x00, 4, 1); // CR1: CEN
mcu.step(20000);
ok(mcu.tim3.enabled() === true, 'tim3.enabled() reflects CEN');
ok(mcu.tim3.frequency() === 50, 'tim3.frequency() reads 50Hz servo rate');
ok(mcu.tim3.duty(0) === 7, 'tim3.duty(0) reads 7% (1.5ms pulse)');

// TIM output-pin map (live AFIO remap; null when no output pin).
const p31 = mcu.tim3.pin(0);
ok(p31 && p31.port === 'A' && p31.pin === 6, 'tim3.pin(0) = PA6 default');
const p21 = mcu.tim2.pin(0);
ok(p21 && p21.port === 'A' && p21.pin === 0, 'tim2.pin(0) = PA0 default');
ok(mcu.tim6.pin(0) === null, 'tim6.pin(0) null (basic timer)');
ok(mcu.tim2.pin(4) === null, 'tim2.pin(4) null (channel out of range)');

// ADC2/ADC3 inject end-to-end. The pin wire is shared: every ADC sampling
// the pin sees the same voltage (proves ADC1..3 route identically).
mcu.adc2.setVoltage(0, 3300); // PA0 wire -> full scale
const A2 = 0x40012800;
mcu._emu.periphWrite(0x40021018, 4, mcu._emu.periphRead(0x40021018, 4) | (1 << 10)); // +ADC2EN
mcu._emu.periphWrite(A2 + 0x34, 4, 0); // ADC2 SQ1 = ch0
mcu._emu.periphWrite(A2 + 0x08, 4, 1 | (1 << 22)); // ADON + SWSTART
mcu.step(5000);
ok((mcu._emu.periphRead(A2, 4) & 2) === 2, 'ADC2 EOC on shared PA0 wire');
ok((mcu._emu.periphRead(A2 + 0x4C, 4) & 0xFFF) === 4095, 'ADC2 DR full-scale from shared wire');
ok(adcDone && adcDone[0] === 2 && adcDone[1] === 0, 'onAdcDone fired for ADC2 ch0');

// ADC3: completion number is the ADC (3), proven through the facade event.
const A3 = 0x40013C00;
mcu._emu.periphWrite(0x40021018, 4, mcu._emu.periphRead(0x40021018, 4) | (1 << 15)); // +ADC3EN
mcu.adc3.setVoltage(1, 2475); // PA1 -> code 3071
mcu._emu.periphWrite(A3 + 0x34, 4, 1); // ADC3 SQ1 = ch1
mcu._emu.periphWrite(A3 + 0x08, 4, 1 | (1 << 22)); // ADON + SWSTART
mcu.step(5000);
ok((mcu._emu.periphRead(A3, 4) & 2) === 2, 'ADC3 EOC');
ok((mcu._emu.periphRead(A3 + 0x4C, 4) & 0xFFF) === 3071, 'ADC3 DR matches injected 2475mV');
ok(adcDone && adcDone[0] === 3 && adcDone[1] === 1, 'onAdcDone fired for ADC3 ch1 (adc=3)');

// Cycle/instruction counter per step (sim-time edge stamps + pace accounting).
const rr = mcu.step(100);
ok(rr && typeof rr.instCount === 'number' && typeof rr.pc === 'number',
    'step() exposes pc + instruction counter');

console.log(`stm32f1 api: ${done} instructions in ${elapsed}s, usart1 bytes=${tx.length}, spi1 transfers=${spiCount}`);
console.log(`\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed === 0 ? 0 : 1);
