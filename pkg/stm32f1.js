// stm32f1.js — ergonomic rp2040js/avr8js-style wrapper over the low-level
// pkg/emulator.js WASM bridge.
//
// This is a THIN layer: it adds no emulation logic and no hot-path overhead.
// Every method delegates to the underlying emulator (native Rust CPU + Rust
// peripherals run inside run()/step(); this class only translates calls at the
// API boundary).
//
// Transaction-level virtual-peripheral events (SPI/I2C/USART) are drained from
// the core once per execute()/step() and dispatched to per-bus callbacks
// (onTransfer / onStart / onWrite / onRead / onStop / onData). This is the
// Wokwi-style model: your JS "virtual device" reacts to bus transactions and
// injects bytes back via spi.injectMiso() / i2c.injectRx() / usart.send().
//
// Usage (Node or browser):
//   import { STM32F1 } from './stm32f1.js';
//   const mcu = await STM32F1.fromELF(fs.readFileSync('./firmware.elf'));
//   mcu.gpio.pin('A', 5).on('change', (high) => console.log('PA5', high));
//   mcu.usart2.onData = (b) => process.stdout.write(String.fromCharCode(b));
//   mcu.spi1.onTransfer = (ch, tx, rx) => console.log('SPI1', tx, rx);
//   mcu.i2c1.onStart = (addr) => console.log('I2C1 start', addr);
//   mcu.execute(100_000);

import { createEmulator, parseElf, parseIntelHex, parseSymbolMap } from './emulator.js';

/** STM32F1 USART data-register addresses (a byte written here = one TX byte). */
const USART_DR = { 1: 0x40013804, 2: 0x40004404, 3: 0x40004804 };
/** GPIO port letter -> internal index (A=0 .. G=6), matching gpioReadOutput(). */
const PORT_INDEX = { A: 0, B: 1, C: 2, D: 3, E: 4, F: 5, G: 6 };
/** ADC channel -> GPIO pin for target-voltage injection (mirrors adc.rs channel_pin). */
const ADC_CHANNEL_PIN = { 8: [1, 0], 9: [1, 1] };
for (let ch = 0; ch <= 7; ch++) ADC_CHANNEL_PIN[ch] = [0, ch];
for (let ch = 10; ch <= 15; ch++) ADC_CHANNEL_PIN[ch] = [2, ch - 10];
/** VREF for ADC millivolt <-> 12-bit code conversion (VDDA = 3.3 V nominal). */
const ADC_VREF_MV = 3300;
/** TIM number -> base address (RM0008; mirrors tim.rs timer_base). */
const TIM_BASE = {
    1: 0x40012C00, 2: 0x40000000, 3: 0x40000400, 4: 0x40000800,
    5: 0x40000C00, 6: 0x40001000, 7: 0x40001400,
};
/** RCC_CFGR for the APB prescaler (timer-clock x2 rule). */
const RCC_CFGR = 0x40021004;

/**
 * A single GPIO pin. Subscribe to output-level changes, read the level, or drive
 * an external input (e.g. a button) into the pin.
 */
export class GPIOPin {
    /** @param {STM32F1} mcu @param {string} port 'A'..'G' @param {number} pin 0..15 */
    constructor(mcu, port, pin) {
        this._mcu = mcu;
        this.port = port;
        this.pin = pin;
    }

    /**
     * Subscribe to output-level changes.
     * @param {'change'} event
     * @param {(high: boolean) => void} cb
     * @returns {() => void} unsubscribe
     */
    on(event, cb) {
        if (event !== 'change') return () => {};
        const key = PORT_INDEX[this.port] + ':' + this.pin;
        let set = this._mcu._pinListeners.get(key);
        if (!set) { set = new Set(); this._mcu._pinListeners.set(key, set); }
        set.add(cb);
        return () => set.delete(cb);
    }

    /** Current driven output level (0 / 1). */
    read() { return this._mcu._emu.gpioReadOutput(PORT_INDEX[this.port], this.pin) ? 1 : 0; }
    /** Current input level (0 / 1). */
    readInput() { return this._mcu._emu.gpioReadInput(PORT_INDEX[this.port], this.pin) ? 1 : 0; }
    /** Drive an external input into this pin (e.g. button press). */
    setInput(high) { this._mcu._emu.gpioSetInput(PORT_INDEX[this.port], this.pin, high ? 1 : 0); }
    /** Set the pin to an analog value (0..4095). */
    setAnalog(val) { this._mcu._emu.gpioSetAnalog(PORT_INDEX[this.port], this.pin, val); }
}

/** GPIO port accessor. */
export class GPIO {
    /** @param {STM32F1} mcu */
    constructor(mcu) { this._mcu = mcu; }
    /**
     * @param {string|number} port 'A' or 0, etc.
     * @param {number} pin
     * @returns {GPIOPin}
     */
    pin(port, pin) {
        const p = typeof port === 'string' ? port.toUpperCase() : String.fromCharCode(65 + (port | 0));
        return new GPIOPin(this._mcu, p, pin | 0);
    }
}

/**
 * A USART. `onData` fires for every byte the MCU transmits (TX, via the core
 * event queue); `send()` injects bytes into the MCU's RX (host -> MCU serial
 * input) on this exact USART.
 */
export class USART {
    /** @param {STM32F1} mcu @param {1|2|3} n */
    constructor(mcu, n) {
        this._mcu = mcu;
        this.n = n;
        /** @type {((byte: number) => void) | null} */
        this.onData = null;
        /** @type {number[]} accumulated TX bytes (this USART only) */
        this._buf = [];
    }
    /** Host -> MCU serial input on this USART. */
    send(data) {
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        for (const b of bytes) this._mcu._emu.uartRxAddr(USART_DR[this.n], b & 0xFF);
    }
    /** Accumulated TX output for this USART. */
    get output() { return String.fromCharCode(...this._buf); }
    /** @internal called by the event drainer on TX. */
    _tx(byte) { this._buf.push(byte); if (this.onData) this.onData(byte); }
}

/**
 * A SPI bus. `onTransfer(ch, tx, rx)` fires for every DR write (a byte/word
 * transaction). `injectMiso(bytes)` queues MISO bytes the MCU will read (virtual
 * device -> MCU), overriding the attached SPI peripheral.
 */
export class SPI {
    /** @param {STM32F1} mcu @param {number} ch 1..6 */
    constructor(mcu, ch) {
        this._mcu = mcu;
        this.ch = ch;
        /** @type {((channel:number, tx:number[], rx:number[]) => void) | null} */
        this.onTransfer = null;
    }
    /** Queue MISO bytes the MCU reads on this bus (virtual device -> MCU). */
    injectMiso(bytes) { this._mcu._emu.spiInjectMiso(this.ch, Uint8Array.from(bytes)); }
    /** @internal */
    _transfer(tx, rx) { if (this.onTransfer) this.onTransfer(this.ch, tx, rx); }
}

/**
 * An I2C bus. `onStart(addr)` / `onWrite(byte)` / `onRead()` / `onStop()` fire on
 * the transaction edges. `injectRx(bytes)` queues RX bytes the MCU reads during
 * master-receiver transactions (virtual device -> MCU).
 */
export class I2C {
    /** @param {STM32F1} mcu @param {number} ch 1..3 */
    constructor(mcu, ch) {
        this._mcu = mcu;
        this.ch = ch;
        this.onStart = null;
        this.onWrite = null;
        this.onRead = null;
        this.onStop = null;
    }
    /** Queue RX bytes the MCU reads during master-receiver transactions. */
    injectRx(bytes) { this._mcu._emu.i2cInjectRx(this.ch, Uint8Array.from(bytes)); }
    /** @internal */
    _start(addr) { if (this.onStart) this.onStart(addr); }
    /** @internal */
    _write(byte) { if (this.onWrite) this.onWrite(byte); }
    /** @internal */
    _read() { if (this.onRead) this.onRead(); }
    /** @internal */
    _stop() { if (this.onStop) this.onStop(); }
}

/**
 * A DMA controller (DMA1: 7 channels, DMA2: 5 channels). Direct RM0008
 * channel access: CCR/CNDTR/CPAR/CMAR per 1-based channel number, ISR/IFCR
 * for completion flags. A CCR write with EN=1 queues the transfer; the
 * run/step loop pumps it with zero JS crossings (same as firmware DMA).
 */
export class DMA {
    /** @param {STM32F1} mcu @param {1|2} n controller number */
    constructor(mcu, n) {
        this._mcu = mcu;
        this.n = n;
    }
    /** Raw ISR flags word (TCIF/HTIF/TEIF/GIF per channel nibble). */
    isr() { return this._mcu._emu.dmaIsr(this.n); }
    /** Channel config word (CCR). */
    getCcr(ch) { return this._mcu._emu.dmaGetCcr(this.n, ch); }
    /** Remaining transfer count (CNDTR). */
    getNdtr(ch) { return this._mcu._emu.dmaGetNdtr(this.n, ch); }
    /** Peripheral address (CPAR). */
    getPar(ch) { return this._mcu._emu.dmaGetPar(this.n, ch); }
    /** Memory address (CMAR). */
    getMar(ch) { return this._mcu._emu.dmaGetMar(this.n, ch); }
    /** Program a channel ({ ccr, ndtr, par, mar }; CCR write of EN=1 starts it). */
    setChannel(ch, fields) { return this._mcu._emu.dmaSetChannel(this.n, ch, fields); }
    /** Clear ISR flags via IFCR (write-1-clears mask). */
    clearFlags(mask) { return this._mcu._emu.dmaClearFlags(this.n, mask); }
    /** True while a DMA transfer is queued anywhere in the core. */
    pending() { return this._mcu._emu.dmaPending(); }
}

/**
 * An ADC (ADC1: 12 channels incl. internal, ADC2/ADC3 similar). Injection
 * drives the target voltage the converter samples — the host side of
 * `analogRead`-style firmware: set a voltage, run the firmware, read DR.
 * Completion is observed via `mcu.onAdcDone(adc, chan)`.
 */
export class ADC {
    /** @param {STM32F1} mcu @param {1|2|3} n ADC number */
    constructor(mcu, n) {
        this._mcu = mcu;
        this.n = n;
    }
    /**
     * Drive a target voltage into a channel (millivolts, 0..3300 at VREF=3.3V).
     * Channels 0-15 route to the mapped GPIO pin analog wire (same source the
     * converter samples, through the RC sample-and-hold); 16-18 (temp/VREF/VBAT)
     * use the internal override; higher channels fall back to the global sim value.
     */
    setVoltage(ch, millivolts) {
        const code = Math.max(0, Math.min(4095, Math.round((millivolts / ADC_VREF_MV) * 4095)));
        return this.setCode(ch, code);
    }
    /** Drive a raw 12-bit code (0..4095) into a channel (same routing as setVoltage). */
    setCode(ch, code) {
        const c = ch | 0;
        code = Math.max(0, Math.min(4095, code | 0));
        if (ADC_CHANNEL_PIN[c]) {
            const [port, pin] = ADC_CHANNEL_PIN[c];
            this._mcu._emu.gpioSetAnalog(port, pin, code);
        } else if (c >= 16 && c <= 18) {
            this._mcu._emu.adcSetInternal(c, code);
        } else {
            this._mcu._emu.setSimAdc(code);
        }
    }
}

/**
 * A general-purpose timer (TIM1-7) for PWM/servo/LED/buzzer observation.
 * `duty(ch)` reads the model's CCR/ARR-derived duty (0-100); `frequency()`
 * derives the output rate from PSC/ARR and the RCC clock tree (APB x2 rule).
 * Both report 0 unless the counter runs (CR1 CEN) — a stopped timer has no output.
 */
export class TIM {
    /** @param {STM32F1} mcu @param {number} n timer number 1..7 */
    constructor(mcu, n) {
        this._mcu = mcu;
        this.n = n;
        this.base = TIM_BASE[n];
    }
    /** True while the counter runs (CR1 CEN). */
    enabled() { return (this._mcu._emu.periphRead(this.base, 4) & 1) !== 0; }
    /** Output duty 0..100 for channel ch (0-based). 0 unless the timer runs. */
    duty(ch = 0) { return this.enabled() ? this._mcu._emu.pwmDuty(this.base, ch) : 0; }
    /** Output frequency in Hz from PSC/ARR and the clock tree. 0 unless the timer runs. */
    frequency() {
        if (!this.enabled()) return 0;
        const emu = this._mcu._emu;
        const psc = emu.periphRead(this.base + 0x28, 4) & 0xFFFF;
        const arr = emu.periphRead(this.base + 0x2C, 4) & 0xFFFF;
        const clocks = emu.rccClocksHz(); // [sysclk, hclk, pclk1, pclk2]
        const cfgr = emu.periphRead(RCC_CFGR, 4);
        const apb1 = this.n !== 1; // TIM1 is APB2; TIM2-7 are APB1
        const ppre = apb1 ? (cfgr >>> 8) & 7 : (cfgr >>> 11) & 7;
        const pclk = apb1 ? clocks[2] : clocks[3];
        // RM0008: when the APB prescaler is not /1, the timer clock is 2x PCLK.
        const timerClk = (ppre & 0x4) ? pclk * 2 : pclk;
        return Math.round(timerClk / ((psc + 1) * (arr + 1)));
    }
}

/**
 * High-level STM32F1 emulator. Wrap it around a firmware image and drive it like
 * rp2040js / avr8js.
 */
export class STM32F1 {
    /** @param {any} emu underlying emulator from createEmulator() @param {object} [opts] */
    constructor(emu, opts = {}) {
        this._emu = emu;
        this._opts = opts;
        /** @type {Map<string, Set<(high:boolean)=>void>>} */
        this._pinListeners = new Map();
        this.gpio = new GPIO(this);
        this.usart = { 1: new USART(this, 1), 2: new USART(this, 2), 3: new USART(this, 3) };
        this.usart1 = this.usart[1];
        this.usart2 = this.usart[2];
        this.usart3 = this.usart[3];
        this.spi = {};
        this.i2c = {};
        for (let ch = 1; ch <= 3; ch++) this.spi[ch] = new SPI(this, ch);
        for (let ch = 1; ch <= 3; ch++) this.i2c[ch] = new I2C(this, ch);
        this.spi1 = this.spi[1]; this.spi2 = this.spi[2]; this.spi3 = this.spi[3];
        this.i2c1 = this.i2c[1]; this.i2c2 = this.i2c[2]; this.i2c3 = this.i2c[3];
        this.dma = { 1: new DMA(this, 1), 2: new DMA(this, 2) };
        this.dma1 = this.dma[1]; this.dma2 = this.dma[2];
        this.adc = {};
        for (let n = 1; n <= 3; n++) this.adc[n] = new ADC(this, n);
        this.adc1 = this.adc[1]; this.adc2 = this.adc[2]; this.adc3 = this.adc[3];
        this.tim = {};
        for (let n = 1; n <= 7; n++) this.tim[n] = new TIM(this, n);
        this.tim1 = this.tim[1]; this.tim2 = this.tim[2]; this.tim3 = this.tim[3];
        this.tim4 = this.tim[4]; this.tim5 = this.tim[5]; this.tim6 = this.tim[6];
        this.tim7 = this.tim[7];
        /** EXTI line edge callback: onExtiEdge(line) */
        this.onExtiEdge = null;
        /** ADC conversion-complete callback: onAdcDone(adc, chan) */
        this.onAdcDone = null;
        /** TIM update (overflow) callback: onTimUpdate(tim) */
        this.onTimUpdate = null;
        /** DAC output write callback: onDacWrite(chan, value) */
        this.onDacWrite = null;
        /** CRC result callback: onCrcResult(value) */
        this.onCrcResult = null;
        /** RTC alarm callback: onRtcAlarm(alarm) */
        this.onRtcAlarm = null;
        /** Watchdog reset callback: onWdogReset(which) (1=IWDG, 2=WWDG) */
        this.onWdogReset = null;
        /** CAN transmit callback: onCanTx(can, id, len, data[8]) */
        this.onCanTx = null;
        /** CAN receive callback: onCanRx(can, id, len, data[8]) */
        this.onCanRx = null;
        /** TIM input-capture callback: onTimCapture(tim, ch, value) */
        this.onTimCapture = null;
        /** FSMC memory transaction callback: onFsmcAccess(bank, offset, write, size, value) */
        this.onFsmcAccess = null;
        /** USB IN completion callback: onUsbIn(ep, data[]) (device -> host) */
        this.onUsbIn = null;
        /** SMBus ALERT drive edge callback: onI2cAlert(channel, asserted) */
        this.onI2cAlert = null;
        /** OTG host OUT/SETUP completion: onHostTx(ch, ep, setup, data[]) */
        this.onHostTx = null;
        /** OTG host IN token request: onHostRx(ch, ep, len) */
        this.onHostRx = null;
        /** ITM stimulus port 0 byte: onItmByte(port, byte) (firmware printf) */
        this.onItmByte = null;
        this._pinUnsub = null;
        this._wire();
    }

    /** Register the pin-change router on the current emulator. */
    _wire() {
        this._pinUnsub = this._emu.onPinChange((port, pin, level) => {
            const set = this._pinListeners.get(port + ':' + pin);
            if (set) for (const cb of set) cb(level === 1);
        });
    }

    /**
     * Decode the flat i32 event array from the core and dispatch to per-bus
     * callbacks. Called once per execute()/step() batch.
     * @internal
     */
    _drain_events() {
        const flat = this._emu.drainEvents();
        if (!flat || flat.length === 0) return;
        let i = 0;
        while (i + 1 < flat.length) {
            const type = flat[i++];
            if (type === 6) { // UartTx [usart, byte]
                const usart = flat[i++]; const byte = flat[i++];
                const u = this.usart[usart]; if (u) u._tx(byte);
            } else if (type === 1) { // SpiTransfer [channel, txLen, rxLen, tx..., rx...]
                const ch = flat[i++]; const txLen = flat[i++]; const rxLen = flat[i++];
                const tx = []; for (let k = 0; k < txLen; k++) tx.push(flat[i++] & 0xFF);
                const rx = []; for (let k = 0; k < rxLen; k++) rx.push(flat[i++] & 0xFF);
                const s = this.spi[ch]; if (s) s._transfer(tx, rx);
            } else if (type === 2) { // I2cStart [channel, addr]
                const ch = flat[i++]; const addr = flat[i++];
                const bus = this.i2c[ch]; if (bus) bus._start(addr);
            } else if (type === 3) { // I2cWrite [channel, byte]
                const ch = flat[i++]; const byte = flat[i++];
                const bus = this.i2c[ch]; if (bus) bus._write(byte);
            } else if (type === 4) { // I2cRead [channel]
                const ch = flat[i++];
                const bus = this.i2c[ch]; if (bus) bus._read();
            } else if (type === 5) { // I2cStop [channel]
                const ch = flat[i++];
                const bus = this.i2c[ch]; if (bus) bus._stop();
            } else if (type === 7) { // ExtiEdge [line]
                const line = flat[i++];
                if (this.onExtiEdge) this.onExtiEdge(line);
            } else if (type === 8) { // AdcDone [adc, chan]
                const adc = flat[i++]; const chan = flat[i++];
                if (this.onAdcDone) this.onAdcDone(adc, chan);
            } else if (type === 9) { // TimUpdate [tim]
                const tim = flat[i++];
                if (this.onTimUpdate) this.onTimUpdate(tim);
            } else if (type === 10) { // DacWrite [chan, value]
                const chan = flat[i++]; const value = flat[i++];
                if (this.onDacWrite) this.onDacWrite(chan, value);
            } else if (type === 11) { // CrcResult [value]
                const value = flat[i++];
                if (this.onCrcResult) this.onCrcResult(value);
            } else if (type === 12) { // RtcAlarm [alarm]
                const alarm = flat[i++];
                if (this.onRtcAlarm) this.onRtcAlarm(alarm);
            } else if (type === 13) { // WdogReset [which]
                const which = flat[i++];
                if (this.onWdogReset) this.onWdogReset(which);
            } else if (type === 14) { // CanTx [can, id, len, d0..d7]
                const can = flat[i++]; const id = flat[i++]; const len = flat[i++];
                const data = [];
                for (let k = 0; k < 8; k++) data.push(flat[i++] & 0xFF);
                if (this.onCanTx) this.onCanTx(can, id, len, data);
            } else if (type === 15) { // CanRx [can, id, len, d0..d7]
                const can = flat[i++]; const id = flat[i++]; const len = flat[i++];
                const data = [];
                for (let k = 0; k < 8; k++) data.push(flat[i++] & 0xFF);
                if (this.onCanRx) this.onCanRx(can, id, len, data);
            } else if (type === 16) { // TimCapture [tim, ch, value]
                const tim = flat[i++]; const ch = flat[i++]; const value = flat[i++];
                if (this.onTimCapture) this.onTimCapture(tim, ch, value);
            } else if (type === 17) { // FsmcAccess [bank, offset, write, size, value]
                const bank = flat[i++]; const offset = flat[i++]; const write = flat[i++] !== 0;
                const size = flat[i++]; const value = flat[i++];
                if (this.onFsmcAccess) this.onFsmcAccess(bank, offset, write, size, value);
            } else if (type === 18) { // UsbIn [ep, len, bytes...]
                const ep = flat[i++]; const len = flat[i++];
                const data = []; for (let k = 0; k < len; k++) data.push(flat[i++] & 0xFF);
                if (this.onUsbIn) this.onUsbIn(ep, data);
            } else if (type === 19) { // I2cAlert [channel, asserted]
                const ch = flat[i++]; const asserted = flat[i++] !== 0;
                if (this.onI2cAlert) this.onI2cAlert(ch, asserted);
            } else if (type === 20) { // HostTx [ch, ep, setup, len, bytes...]
                const ch = flat[i++]; const ep = flat[i++]; const setup = flat[i++] !== 0;
                const len = flat[i++];
                const data = []; for (let k = 0; k < len; k++) data.push(flat[i++] & 0xFF);
                if (this.onHostTx) this.onHostTx(ch, ep, setup, data);
            } else if (type === 21) { // HostRx [ch, ep, len]
                const ch = flat[i++]; const ep = flat[i++]; const len = flat[i++];
                if (this.onHostRx) this.onHostRx(ch, ep, len);
            } else if (type === 22) { // ItmByte [port, byte]
                const port = flat[i++]; const byte = flat[i++];
                if (this.onItmByte) this.onItmByte(port, byte);
            } else {
                console.warn('STM32F1: unknown event discriminant', type, 'at index', i - 1);
                break; // unknown length: stop to avoid desync
            }
        }
    }

    /**
     * Create an emulator from options (passed straight to createEmulator).
     * @param {object} [opts]
     * @returns {Promise<STM32F1>}
     */
    static async create(opts = {}) {
        const emu = await createEmulator(opts);
        return new STM32F1(emu, opts);
    }
    /** @param {Uint8Array|ArrayBuffer} buf @param {object} [opts] */
    static fromELF(buf, opts = {}) { return STM32F1.create({ ...opts, firmware: buf }); }
    /** Raw binary is loaded at the flash base (0x08000000). @param {Uint8Array|ArrayBuffer} buf @param {object} [opts] */
    static fromBin(buf, opts = {}) { return STM32F1.create({ ...opts, firmware: buf }); }
    /** Intel HEX text. @param {string} text @param {object} [opts] */
    static fromHex(text, opts = {}) { return STM32F1.create({ ...opts, firmware: text }); }

    /** Load new firmware and reset. @param {Uint8Array|ArrayBuffer} buf */
    async loadELF(buf) { return this._reload({ ...this._opts, firmware: buf }); }
    /** @param {Uint8Array|ArrayBuffer} buf */
    async loadBin(buf) { return this._reload({ ...this._opts, firmware: buf }); }
    /** @param {string} text */
    async loadHex(text) { return this._reload({ ...this._opts, firmware: text }); }

    /** Recreate the underlying emulator with new opts (firmware reload + reset). */
    async _reload(opts) {
        this._pinUnsub?.(); this._pinUnsub = null;
        this._pinListeners.clear();
        // Reset clears everything, synchronously: drop the accumulated
        // per-USART TX buffers too, so post-reset output starts clean.
        for (const k of Object.keys(this.usart)) this.usart[k]._buf.length = 0;
        const emu = await createEmulator(opts);
        this._emu = emu;
        this._opts = opts;
        this._wire();
        return this;
    }

    /**
     * Run `cycles` instructions, draining virtual-peripheral events once per
     * batch. Each batch's GPIO pin changes (drained inside step()) are
     * delivered BEFORE that batch's bus-transfer events below — so a CS
     * sampled inside `onTransfer` observes the level as of that transfer,
     * not the end of the whole run. Transfer/edge counts are unchanged vs
     * a single `run()`: the same batches execute, only callback timing moves
     * earlier (per batch instead of post-run).
     * Resolves to { totalSteps, instCount, stopped }.
     * @param {number} cycles
     * @returns {{totalSteps:number, instCount:number, stopped:boolean}}
     */
    execute(cycles) {
        if (!(cycles > 0)) {
            // Degenerate path (0/negative/NaN): legacy run()-once semantics.
            const r = this._emu.run(cycles);
            this._drain_events();
            return r;
        }
        const chunk = this._emu.getBatchSize() || 20000;
        const startInst = this._emu.getInstCount();
        let totalSteps = 0, instCount = startInst, stopped = false;
        while (instCount - startInst < cycles && !stopped) {
            const r = this._emu.step(Math.min(chunk, cycles - (instCount - startInst)));
            totalSteps++;
            instCount = r.instCount;
            stopped = r.stopped;
            this._drain_events();
            if (stopped) break;
        }
        return { totalSteps, instCount, stopped };
    }
    /** Single batch step. @param {number} cycles */
    step(cycles) { const r = this._emu.step(cycles); this._drain_events(); return r; }
    /** Stop a running loop. */
    stop() { return this._emu.stop(); }
    /** Tear down: unsubscribe routers and close the emulator. */
    close() { this._pinUnsub?.(); return this._emu.close(); }

    /** Re-run from the reset vector (recreates the underlying emulator). */
    async reset() { return this._reload(this._opts); }

    /** Inject a byte into the MCU's UART RX (USART1 by default). */
    uartRx(byte) { return this._emu.uartRx(byte); }
    /** Accumulated USART1 TX output. */
    get uartOutput() { return this._emu.getUartOutput(); }

    /**
     * Subscribe to any peripheral-bus write (raw, like real hardware).
     * fn(addr, width, value). Useful for custom device tapping.
     * @param {(addr:number, width:number, value:number) => void} fn
     * @returns {() => void} unsubscribe
     */
    onPeriphWrite(fn) { return this._emu.onPeriphWrite(fn); }

    /** Load a symbol map (text) for PC -> symbol resolution. */
    setSymbols(symbolText) { return this._emu.setSymbols(parseSymbolMap(symbolText)); }
    /** Resolve a PC to a symbol name, or null. */
    resolveSymbol(pc) { return this._emu.resolveSymbol(pc); }

    /** Write a byte directly into the FSMC backing image (no peripheral side effects). */
    fsmcWriteByte(name, offset, value) { return this._emu.fsmcWriteByte(name, offset, value); }
    /** Read a byte directly from the FSMC backing image.  Returns -1 on error. */
    fsmcReadByte(name, offset) { return this._emu.fsmcReadByte(name, offset); }
}

export { parseElf, parseIntelHex, parseSymbolMap };
export default STM32F1;
