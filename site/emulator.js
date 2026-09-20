const DEFAULT_MAX_BATCH = 20000;
const LARGE_BATCH = 50000;

/**
 * Load the Rust peripheral WASM module.
 * - Node.js: import the wasm-pack glue directly (ESM wasm import works there)
 * - Browser: fetch + WebAssembly.instantiate (MIME-agnostic, works on GitHub Pages
 *   and any static host without strict module-MIME support)
 */
let periphPromise;
function getPeriph() {
    if (!periphPromise) {
        // The high-level glue loads the wasm itself: initSync(module) in Node,
        // or default() which fetches stm32_bluepill_wasm_bg.wasm relative to the
        // module URL in the browser (no static wasm import -> works on GitHub Pages).
        periphPromise = import('./stm32_bluepill_wasm.js').then(async (p) => {
            if (typeof process !== 'undefined' && process.versions?.node) {
                const { readFileSync } = await import('fs');
                p.initSync({ module: readFileSync(new URL('./stm32_bluepill_wasm_bg.wasm', import.meta.url)) });
            } else {
                await p.default();
            }
            return p;
        });
    }
    return periphPromise;
}

function parseHex(v) { return typeof v === 'number' ? v : parseInt(v, 16); }

/**
 * Parse an Intel HEX (ihex) text blob into a byte array.
 *
 * @param {string} text Intel HEX records (record types 00/01/02/04)
 * @returns {{data: Uint8Array, base: number}} Bytes + lowest address they belong to
 */
export function parseIntelHex(text) {
    let minAddr = Infinity, maxAddr = 0;
    let base = 0;
    const recs = [];
    for (const raw of String(text).split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line[0] !== ':') continue;
        const hex = line.slice(1);
        if (hex.length < 10) continue;
        const count = parseInt(hex.slice(0, 2), 16);
        const addr = parseInt(hex.slice(2, 6), 16);
        const type = parseInt(hex.slice(6, 8), 16);
        if (hex.length < 8 + count * 2) continue;
        const data = new Uint8Array(count);
        for (let i = 0; i < count; i++) data[i] = parseInt(hex.slice(8 + i * 2, 10 + i * 2), 16);
        if (type === 0x04) base = ((data[0] << 8) | data[1]) << 16;
        else if (type === 0x02) base = ((data[0] << 8) | data[1]) << 4;
        else if (type === 0x00) recs.push([base + addr, data]);
        else if (type === 0x01) break;
    }
    if (!recs.length) return { data: new Uint8Array(0), base: 0 };
    for (const [a, d] of recs) {
        minAddr = Math.min(minAddr, a);
        maxAddr = Math.max(maxAddr, a + d.length);
    }
    const out = new Uint8Array(maxAddr - minAddr);
    for (const [a, d] of recs) out.set(d, a - minAddr);
    return { data: out, base: minAddr };
}

/**
 * Parse a GNU ld linker map file into symbol entries.
 *
 * @param {string} text GNU ld .map output
 * @returns {Array<{name: string, addr: number}>}
 */
export function parseSymbolMap(text) {
    const syms = [];
    const re = /^\s*0x([0-9a-fA-F]{8,16})\s+([A-Za-z_.$][\w.$]*)(?:\s*=|\s*$)/gm;
    let m;
    while ((m = re.exec(text)) !== null) {
        if (m[2] === '.') continue; // ld location counter, not a real symbol
        syms.push({ name: m[2], addr: parseInt(m[1], 16) });
    }
    return syms;
}

/**
 * Parse an ELF32 executable (ARM, little-endian) into loadable regions + symbols.
 *
 * @param {Uint8Array|ArrayBuffer} buffer ELF file bytes
 * @returns {{regions: Array<{start: number, data: Uint8Array}>, symbols: Array<{name: string, addr: number}>}}
 */
export function parseElf(buffer) {
    const b = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
    if (b.length < 52 || b[0] !== 0x7F || b[1] !== 0x45 || b[2] !== 0x4C || b[3] !== 0x46) {
        throw new Error('Not an ELF file');
    }
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const u32 = (off) => dv.getUint32(off, true);
    const u16 = (off) => dv.getUint16(off, true);
    const e_phoff = u32(28), e_phentsize = u16(42), e_phnum = u16(44);
    const regions = [];
    for (let i = 0; i < e_phnum; i++) {
        const off = e_phoff + i * e_phentsize;
        if (off + 32 > b.length) break;
        const p_type = u32(off), p_offset = u32(off + 4), p_vaddr = u32(off + 8), p_paddr = u32(off + 12), p_filesz = u32(off + 16);
        if (p_type !== 1 || p_filesz === 0) continue;
        const data = b.slice(p_offset, p_offset + p_filesz);
        regions.push({ start: p_vaddr >>> 0, data });
        // The firmware startup copies .data from its load (LMA) address; the
        // emulator must provide that copy too, not just the VMA.
        if (p_paddr !== p_vaddr) {
            regions.push({ start: p_paddr >>> 0, data });
        }
    }
    const e_shoff = u32(32), e_shentsize = u16(46), e_shnum = u16(48);
    const sections = [];
    for (let i = 0; i < e_shnum; i++) {
        const off = e_shoff + i * e_shentsize;
        if (off + 40 > b.length) break;
        sections.push({ type: u32(off + 4), offset: u32(off + 16), size: u32(off + 20), link: u32(off + 24) });
    }
    const symbols = [];
    for (const sh of sections) {
        if (sh.type !== 2 || sh.size === 0) continue; // SHT_SYMTAB
        const strOff = sections[sh.link] ? sections[sh.link].offset : 0;
        const count = Math.min(Math.floor(sh.size / 16), Math.floor((b.length - sh.offset) / 16));
        for (let i = 0; i < count; i++) {
            const o = sh.offset + i * 16;
            const st_name = u32(o), st_value = u32(o + 4), st_info = b[o + 12];
            if (st_value === 0 || st_name === 0) continue;
            const type = st_info & 0xF;
            if (type !== 1 && type !== 2) continue; // OBJECT or FUNC
            let name = '';
            let p = strOff + st_name;
            while (p < b.length && b[p] !== 0) name += String.fromCharCode(b[p++]);
            if (name) symbols.push({ name, addr: st_value >>> 0 });
        }
    }
    return { regions, symbols };
}

/**
 * Create a full STM32F103C8 (Bluepill) emulator instance.
 *
 * @param {object} opts
 * @param {Uint8Array|string} opts.firmware     Firmware to load at flash base: raw binary
 *                                              (Uint8Array) or Intel HEX text (string,
 *                                              auto-detected if bytes start with ':')
 * @param {number}    [opts.flash_size=0x10000] Flash region size (64KB default)
 * @param {number}    [opts.ram_size=0x5000]    SRAM size (20KB default)
 * @param {number}    [opts.vector_table=0x08000000] Vector table base address
 * @param {string}    [opts.svd]                SVD XML string (optional; defaults to hardcoded F103C8 map)
 * @param {string|object} [opts.chip]           Chip selector (builtin map + sizes
 *                                              + DBGMCU IDCODE). Known names (flash/RAM/IDCODE):
 *                                              'stm32f103c8' (64K/20K, default),
 *                                              'stm32f103cb' / 'maple_mini' (128K/20K),
 *                                              'stm32f103rc' (256K/48K),
 *                                              'nucleo_f103rb' (128K/20K),
 *                                              'gd32f103c8' / 'gd32f103cb' / 'gd32f103rb'
 *                                              (64/128K/20K, IDCODE 0x2BA01477).
 *                                              Unknown names warn and behave like
 *                                              f103c8. Or { name, svd, flash?,
 *                                              ram?, idcode? } to build the map
 *                                              from an SVD (e.g. STM32F105 + CAN2).
 * @param {Array}     [opts.js_peripherals=[]]  rp2040js-style custom peripherals:
 *                                              [{ base, size, read(addr,size), write(addr,value,size) }]
 * @param {number}    [opts.uart_addr=0x40013800] USART used for uartRx()
 * @param {object}    [opts.ext_devices={}]     External devices (see below)
 * @param {boolean}   [opts.verbose=false]      Print init info to console
 *
  * ext_devices shape:
  *   { spi_flash: [{peripheral, jedec_id, data, cs?}],
  *     i2c_eeprom: [{peripheral, address, data}],
  *     sd_card:   [{peripheral, data}],
  *     i2c_oled:   [{peripheral, address, width, height}],
  *     lcd:        [{peripheral, cs}],
  *     touchscreen:[{peripheral, touch_detected_pin, cs}],
  *     software_spi:[{name, cs, clk, miso, mosi}],
  *     fsmc_bank: [{name, data}] }
 *
 * Page-side peripheral drivers (7-seg, buzzer, ...) are pure JS: subscribe with
 * emu.onPeriphWrite(...) to tap the peripheral bus like real hardware, and poll
 * gpioReadOutput/pwmDuty per frame. The WASM stays a faithful STM32 core plus
 * chip models that must respond on the bus (eeprom/flash/oled/lcd/touchscreen).
 *
 * @returns {Promise<BluepillEmulator>}
 */
/**
 * Builtin chip table: flash/RAM sizes + DBGMCU IDCODE + display label.
 * GD32F103 is register-identical at everything modeled, so no SVD is
 * needed — only sizes and the IDCODE differ (timing stays
 * instruction-based). Unknown names behave like stm32f103c8.
 */
export const CHIPS = {
    stm32f103c8: { flash: 0x10000, ram: 0x5000, idcode: 0x10016410, label: 'STM32F103C8' },
    stm32f103cb: { flash: 0x20000, ram: 0x5000, idcode: 0x10016410, label: 'STM32F103CB' },
    maple_mini:  { flash: 0x20000, ram: 0x5000, idcode: 0x10016410, label: 'Maple Mini (F103CB)' },
    nucleo_f103rb: { flash: 0x20000, ram: 0x5000, idcode: 0x10016410, label: 'Nucleo-F103RB' },
    stm32f103rc: { flash: 0x40000, ram: 0xC000, idcode: 0x10016410, label: 'STM32F103RC' },
    gd32f103c8:  { flash: 0x10000, ram: 0x5000, idcode: 0x2BA01477, label: 'GD32F103C8' },
    gd32f103cb:  { flash: 0x20000, ram: 0x5000, idcode: 0x2BA01477, label: 'GD32F103CB' },
    gd32f103rb:  { flash: 0x20000, ram: 0x5000, idcode: 0x2BA01477, label: 'GD32F103RB' },
};

/** Chip descriptor for a createEmulator `chip` name (default: f103c8). */
export function chipInfo(name) {
    return (typeof name === 'string' && CHIPS[name]) ? CHIPS[name] : CHIPS.stm32f103c8;
}
export async function createEmulator(opts = {}) {
    // Builtin chip table: flash/RAM sizes + DBGMCU IDCODE. GD32F103 is
    // register-identical at everything modeled, so no SVD is needed —
    // only sizes and the IDCODE differ (timing stays instruction-based).
    const chipEntry = (typeof opts.chip === 'string' && CHIPS[opts.chip]) ? CHIPS[opts.chip]
        : (typeof opts.chip === 'object' && opts.chip !== null ? opts.chip : null);
    const {
        firmware = new Uint8Array(0),
        flash_size = chipEntry?.flash ?? 0x10000,
        ram_size = chipEntry?.ram ?? 0x5000,
        vector_table = 0x08000000,
        svd = null,
        chip = 'stm32f103c8',
        js_peripherals = [],
        uart_addr = 0x40013800,
        ext_devices = {},
        verbose = false,
        batch_size = DEFAULT_MAX_BATCH,
    } = opts;
    const maxBatch = batch_size;

    const periph = await getPeriph();

    const { periph_read, periph_write, process_batch, dma_get_pending_count, is_watchdog_reset_requested,
    add_spi_flash, add_i2c_eeprom, add_touchscreen, add_lcd, add_i2c_oled, add_software_spi, reset_ext_devices,
    add_fsmc_bank, fsmc_write_byte, fsmc_read_byte,
    add_sd_card,
    register_js_peripheral,
    init, init_svd, get_uart_output, uart_rx_byte, uart_inject_break, uart_rx_pending, gpio_read_output,
    gpio_set_input, gpio_read_input,
    can_inject_message, adc_set_sim_value, gpio_set_analog, adc_set_rc_tau,
    touchscreen_set_touch, pwm_duty, raise_fault,
     i2c_oled_fb, lcd_fb, gpio_take_pin_events,     drain_events, spi_inject_miso, i2c_inject_rx, i2c_inject_start, i2c_inject_write, i2c_inject_read, i2c_inject_stop, i2c_inject_alert,     bootloader_enable, bootloader_go_addr, pwr_mode, pwr_estimate, adc_set_internal, usb_bus_reset, usb_detach, usb_inject_setup, usb_inject_out, otg_inject_setup, otg_inject_out, otg_bus_reset, otg_detach, otg_host_feed_in, otg_host_attach,
    board_info, board_boot0, board_boot0_get, board_nrst,
    rustcpu_init, rustcpu_load, rustcpu_run, rustcpu_fault, rustcpu_fault_clear, rustcpu_dispatch,
    rustcpu_regs, rustcpu_set_pc, rustcpu_set_reg, rustcpu_mem_read, rustcpu_mem_write, rustcpu_mem_write_raw, rustcpu_dma_pump, rustcpu_i2c_hook_fired,
    rustcpu_write_tap, rustcpu_take_writes, set_dbg_idcode,
    swd_dp_read, swd_dp_write, swd_ap_read, swd_ap_write,
    swd_add_watchpoint, swd_remove_watchpoint, swd_take_trip,
    swd_halted, swd_halt, swd_resume, swd_step, swd_reg_read, swd_reg_write,
    swd_jtag_reset, swd_jtag_ir, swd_jtag_idcode, swd_jtag_dp, swd_jtag_ap } = periph;

    // Register external devices BEFORE init()
    reset_ext_devices();
    for (const d of ext_devices.spi_flash || []) {
        add_spi_flash(d.peripheral, parseHex(d.jedec_id), d.data ?? new Uint8Array(0), d.cs ?? null);
    }
    for (const d of ext_devices.i2c_eeprom || []) {
        add_i2c_eeprom(d.peripheral, parseHex(d.address), d.data ?? new Uint8Array(0));
    }
    for (const d of ext_devices.i2c_oled || []) {
        add_i2c_oled(d.peripheral, parseHex(d.address ?? '0x3C'), parseHex(d.width ?? '128'), parseHex(d.height ?? '64'));
    }
    for (const d of ext_devices.lcd || []) {
        add_lcd(d.peripheral, d.cs ?? null);
    }
    for (const d of ext_devices.touchscreen || []) {
        add_touchscreen(d.peripheral, d.touch_detected_pin ?? null, d.cs ?? null);
    }
    for (const d of ext_devices.software_spi || []) {
        add_software_spi(d.name, d.cs ?? null, d.clk, d.miso, d.mosi);
    }
    for (const d of ext_devices.fsmc_bank || []) {
        add_fsmc_bank(d.name, d.data);
    }
    for (const d of ext_devices.sd_card || []) {
        add_sd_card(d.peripheral, d.data ?? new Uint8Array(0));
    }

    const chipSvd = (typeof chip === 'string') ? (svd ?? null) : (chip.svd ?? null);
    if (typeof chip === 'string' && !CHIPS[chip] && !chipSvd) {
        console.warn(`createEmulator: unknown chip "${chip}" (no SVD provided), using builtin STM32F103C8 map`);
    }
    if (chipSvd) {
        init_svd(chipSvd);
    } else {
        init();
    }
    // DBGMCU IDCODE for the selected chip (init() resets it to F103).
    set_dbg_idcode((chipEntry?.idcode ?? 0x10016410) >>> 0);

    // rp2040js-style custom peripherals: JS callbacks on the peripheral bus.
    for (const jp of js_peripherals || []) {
        register_js_peripheral(jp.base, jp.size, jp.read, jp.write);
    }

    const flash_addr = vector_table & ~0x1FFFF;
    if (firmware instanceof ArrayBuffer) firmware = new Uint8Array(firmware);
    let fwBytes = firmware;
    let fwAddr = flash_addr;
    let elfRegions = null;
    let symbolList = [];
    let symSorted = null;

    if (typeof firmware === 'string' || (firmware instanceof Uint8Array && firmware.length > 0 && firmware[0] === 0x3A)) {
        const text = typeof firmware === 'string' ? firmware : new TextDecoder().decode(firmware);
        const parsed = parseIntelHex(text);
        fwBytes = parsed.data;
        if (parsed.base >= flash_addr && parsed.base < flash_addr + flash_size) fwAddr = parsed.base;
    } else if (firmware instanceof Uint8Array && firmware.length > 4 &&
               firmware[0] === 0x7F && firmware[1] === 0x45 && firmware[2] === 0x4C && firmware[3] === 0x46) {
        const elf = parseElf(firmware);
        elfRegions = elf.regions;
        fwBytes = new Uint8Array(0);
        symbolList = elf.symbols;
        if (verbose) console.log(`ELF: ${elf.regions.length} load segments, ${elf.symbols.length} symbols`);
    }
    {
        // Backend inits BEFORE loading (load needs the CPU/RAM pair);
        // SP/PC come straight from the image bytes.
        const vecAt = (off) => {
            const a = vector_table + off;
            if (elfRegions) {
                for (const reg of elfRegions) {
                    if (a >= reg.start && a + 4 <= reg.start + reg.data.length) {
                        const o = a - reg.start;
                        return (reg.data[o] | (reg.data[o + 1] << 8) | (reg.data[o + 2] << 16) | (reg.data[o + 3] << 24)) >>> 0;
                    }
                }
                return 0;
            }
            const o = a - fwAddr;
            if (!fwBytes.length || o < 0 || o + 4 > fwBytes.length) return 0;
            return (fwBytes[o] | (fwBytes[o + 1] << 8) | (fwBytes[o + 2] << 16) | (fwBytes[o + 3] << 24)) >>> 0;
        };
        rustcpu_init(vecAt(0), vecAt(4), flash_size, ram_size);
        // An SP above the RAM window (e.g. a 48K-linked binary on a 20K
        // map) silently drops stack pushes and dies in startup with a
        // bogus LR — warn loudly instead of debugging blind.
        if (vecAt(0) > 0x20000000 + ram_size) {
            console.warn(`emulator: initial SP 0x${vecAt(0).toString(16)} is above RAM top 0x${(0x20000000 + ram_size).toString(16)} — pass a bigger ram_size (SVD-object chips default to 20K)`);
        }
    }

    if (elfRegions) {
        let wrote = 0;
        for (const reg of elfRegions) {
            const inFlash = reg.start >= flash_addr && reg.start < flash_addr + flash_size;
            const inRam = reg.start >= 0x20000000 && reg.start < 0x20000000 + ram_size;
            if (inFlash || inRam) {
                rustcpu_load(reg.data, reg.start >>> 0);
                wrote++;
            }
        }
        if (verbose) console.log(`ELF: ${wrote} load segments written`);
    }
    if (fwBytes.length > 0) rustcpu_load(fwBytes, fwAddr >>> 0);
    // Reloadable image (NRST path below): re-init CPU + reload bytes.
    const bootCpu = () => {
        const vecAt = (off) => {
            const a = vector_table + off;
            if (elfRegions) {
                for (const reg of elfRegions) {
                    if (a >= reg.start && a + 4 <= reg.start + reg.data.length) {
                        const o = a - reg.start;
                        return (reg.data[o] | (reg.data[o + 1] << 8) | (reg.data[o + 2] << 16) | (reg.data[o + 3] << 24)) >>> 0;
                    }
                }
                return 0;
            }
            const o = a - fwAddr;
            if (!fwBytes.length || o < 0 || o + 4 > fwBytes.length) return 0;
            return (fwBytes[o] | (fwBytes[o + 1] << 8) | (fwBytes[o + 2] << 16) | (fwBytes[o + 3] << 24)) >>> 0;
        };
        rustcpu_init(vecAt(0), vecAt(4), flash_size, ram_size);
        if (elfRegions) {
            for (const reg of elfRegions) {
                const inFlash = reg.start >= flash_addr && reg.start < flash_addr + flash_size;
                const inRam = reg.start >= 0x20000000 && reg.start < 0x20000000 + ram_size;
                if (inFlash || inRam) rustcpu_load(reg.data, reg.start >>> 0);
            }
        }
        if (fwBytes.length > 0) rustcpu_load(fwBytes, fwAddr >>> 0);
    };

    const read32 = (addr) => {
        const b = rustcpu_mem_read(addr >>> 0, 4);
        return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0, true);
    };
    const write32 = (addr, val) => {
        const b = new Uint8Array(4);
        new DataView(b.buffer).setUint32(0, val >>> 0, true);
        rustcpu_mem_write(addr >>> 0, b);
    };

    if (verbose) {
        const sp_init = read32(vector_table) >>> 0;
        const pc_init = read32(vector_table + 4) >>> 0;
        console.log(`SP=0x${sp_init.toString(16)} PC=0x${(pc_init | 1).toString(16)}`);
    }


    let stopRequested = false;
    let instCount = 0;
    let batchInstCount = 0;
    const writeWatchers = [];
    const pinWatchers = [];

    // Drain buffered GPIO pin-change events (flat [port, pin, level, ...]) into
    // the pin watchers, once per batch before the write tap is fed (so a CS-low
    // event is visible before that batch's DR writes). No JS callback ever runs
    // reentrantly inside Rust.
    const drainPinEvents = () => {
        if (!pinWatchers.length) return;
        const ev = gpio_take_pin_events();
        for (let i = 0; i + 2 < ev.length; i += 3) {
            const port = ev[i], pin = ev[i + 1], level = ev[i + 2];
            for (let wi = 0; wi < pinWatchers.length; wi++) {
                try { pinWatchers[wi](port, pin, level); } catch (e) {}
            }
        }
    };


    // ---- backend primitives: run()/step() bodies below are shared ----
    // Single backend (native Rust CPU): DMA pump + IRQ dispatch run fully
    // in Rust against Rust RAM; no JS crossings per instruction or access.
    const pumpDma = () => rustcpu_dma_pump();
    // Execute one CPU batch; returns exact executed instructions (incl.
    // handlers) for accounting.
    // Last CPU fault (pc, op), kept for debugger clients: execBatch clears
    // the live fault after skipping past it, so takeFault() lets a driver
    // (e.g. the GDB stub's BKPT handling) observe it exactly once.
    let lastFault = null;
    const execBatch = (n) => {
        const done = rustcpu_run(n);
        const fault = rustcpu_fault();
        if (fault.length) {
            const fpc = fault[0] >>> 0, op1 = fault[1] >>> 0;
            lastFault = [fpc, op1];
            const sym = resolveSym(fpc);
            if (verbose) console.log(`FAULT @${sym || ('0x' + fpc.toString(16))} op=0x${op1.toString(16)} (rust cpu decode gap)`);
            if (symbolList.length) raise_fault(3, fpc); // UNDEFINSTR; runs via dispatch
            rustcpu_set_pc((fpc + 2) | 1);
            rustcpu_fault_clear();
        }
        return done;
    };
    // Feed write watchers from the in-model write tap (per batch, after
    // pin events so CS-low precedes DR writes, as on the old hook path).
    const feedWriteTap = () => {
        if (!writeWatchers.length) return;
        const w = rustcpu_take_writes();
        for (let i = 0; i + 2 < w.length; i += 3) {
            const a = w[i], s = w[i + 1], v = w[i + 2];
            for (let wi = 0; wi < writeWatchers.length; wi++) {
                try { writeWatchers[wi](a, s, v); } catch (e) {}
            }
        }
    };
    const dispatchBatch = (anyPending) => {
        // hi2c->Mode RAM patch BEFORE dispatch (the ISR reads Mode).
        if (rustcpu_i2c_hook_fired()) {
            try {
                const p = read32(0x200002d8);
                if (p && p !== 0xFFFFFFFF) rustcpu_mem_write((p + 0x3D) >>> 0, new Uint8Array([0x22]));
            } catch (_) {}
        }
        if (anyPending) {
            rustcpu_dispatch();
            const hf = rustcpu_fault();
            if (hf.length) throw new Error(`rust CPU fault in IRQ handler at 0x${(hf[0] >>> 0).toString(16)}`);
        }
    };

    const resolveSym = (addr) => {
        if (!symbolList.length) return null;
        if (!symSorted) {
            symSorted = symbolList.slice().sort((a, b) => a.addr - b.addr);
        }
        const a = addr & ~1;
        let lo = 0, hi = symSorted.length - 1, best = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (symSorted[mid].addr <= a) { best = mid; lo = mid + 1; } else hi = mid - 1;
        }
        if (best < 0) return null;
        const s = symSorted[best];
        const off = a - s.addr;
        if (off > 0x20000) return null;
        return off > 0 ? `${s.name}+0x${off.toString(16)}` : s.name;
    };

    return {
        read32, write32,

        /** Run up to maxInstructions (0 = forever). Returns {totalSteps, instCount, stopped}. */
        run(maxInstructions = 0) {
            stopRequested = false;
            const startInst = instCount;
            let totalSteps = 0;
            let anyPending = false;
            // profiling
            let t_emu=0, t_batch=0, t_dma=0, t_irq=0, t_pin=0;
            const profile = typeof process !== 'undefined' && process.env.PROFILE;
            while (!stopRequested) {
                // Adaptive batch: small (20K) when IRQs/DMA pending for low latency,
                // large (50K) when idle for throughput. If user set batch_size
                // explicitly, respect it as fixed.
                const curBatch = (maxBatch !== DEFAULT_MAX_BATCH) ? maxBatch
                    : ((anyPending || dma_get_pending_count() !== 0) ? DEFAULT_MAX_BATCH : LARGE_BATCH);
                let t;
                if (profile) t=performance.now();
                pumpDma();
                if (profile) t_dma+=performance.now()-t;
                if (profile) t=performance.now();
                const credited = execBatch(curBatch);
                if (profile) t_emu+=performance.now()-t;
                instCount += credited;
                batchInstCount += credited;
                if (batchInstCount > 0) {
                    if (profile) t=performance.now();
                    const status = process_batch(batchInstCount);
                    if (profile) t_batch+=performance.now()-t;
                    batchInstCount = 0;
                    if (status & 0x80000000) { stopRequested = true; break; }
                    anyPending = (status & 0x40000000) !== 0;
                }
                if (profile) t=performance.now();
                pumpDma();
                if (profile) t_dma+=performance.now()-t;
                if (profile) t=performance.now();
                dispatchBatch(anyPending);
                if (profile) t_irq+=performance.now()-t;
                if (profile) t=performance.now();
                drainPinEvents();
                feedWriteTap();
                if (profile) t_pin+=performance.now()-t;
                totalSteps++;
                if (is_watchdog_reset_requested()) break;
                if (maxInstructions > 0 && instCount - startInst >= maxInstructions) break;
            }
            if (profile) {
                const total = t_emu+t_batch+t_dma+t_irq+t_pin;
                const done = instCount - startInst;
                console.error(`[profile] emu ${(t_emu/total*100).toFixed(1)}% batch ${(t_batch/total*100).toFixed(1)}% dma ${(t_dma/total*100).toFixed(1)}% irq ${(t_irq/total*100).toFixed(1)}% pin ${(t_pin/total*100).toFixed(1)}%  total ${total.toFixed(1)}ms for ${done} instr  MIPS ${(done/total/1000).toFixed(1)}`);
            }
            return {
                totalSteps,
                instCount,
                stopped: stopRequested || is_watchdog_reset_requested(),
            };
        },

        /** Run one batch and return after processing DMA/interrupts
         *  (worker.js / page runLoop land here). */
        step(count = maxBatch) {
            const n = count;
            pumpDma();
            const credited = execBatch(n);
            instCount += credited;
            batchInstCount += credited;
            let anyPending = false;
            if (batchInstCount > 0) {
                const status = process_batch(batchInstCount);
                batchInstCount = 0;
                if (status & 0x80000000) stopRequested = true;
                anyPending = (status & 0x40000000) !== 0;
            }
            pumpDma();
            dispatchBatch(anyPending);
            drainPinEvents();
            feedWriteTap();
            return {
                pc: rustcpu_regs()[15] >>> 0,
                instCount,
                stopped: stopRequested || is_watchdog_reset_requested(),
            };
        },

        stop() {
            stopRequested = true;
        },

        // ---- Board hardware: NRST / BOOT0 / LED identity ----
        // All three live in the WASM itself (`board_*` exports), so any
        // driver (page, worker, ws-server, GDB) calls the same path:
        // - `reset()` = NRST press: model state reset + CPU/RAM reloaded
        //   from the boot image, counters back to zero (like power-on, the
        //   page's old Reset which re-created the whole emulator).
        // - `setBoot0(high)` = strap the BOOT0 jumper; read back with
        //   `getBoot0()`. A reset with BOOT0 high claims the USART1
        //   bootloader path (AN3155 responder) instead of main flash.
        // - `boardInfo()` = wiring facts for the current `chip` opt:
        //   { led:{port,pin,name}, button:{port,pin,level,name}|null,
        //     boot0:true, nrst:true, crystalHz, maxSysclkMhz }.
        reset() {
            const tookBoot = board_nrst();
            bootCpu();
            instCount = 0;
            batchInstCount = 0;
            lastFault = null;
            stopRequested = false;
            // Drain the UART tap so pre-reset output (echo banner, prior
            // traffic) can't leak into the fresh boot's getUartOutput().
            try { get_uart_output(); } catch {}
            return tookBoot === 1;
        },
        setBoot0(high) { board_boot0(!!high); },
        getBoot0() { return board_boot0_get(); },
        boardInfo() {
            const chipIdx = { stm32f103c8: 0, stm32f103cb: 0, maple_mini: 1, nucleo_f103rb: 2, stm32f103rc: 3, stm32f105: 4, gd32f103c8: 5, gd32f103cb: 5, gd32f103rb: 5 }[(typeof chip === 'string') ? chip : ''] ?? 0;
            const v = board_info(chipIdx);
            const pname = (p) => p === 0 ? 'A' : p === 1 ? 'B' : 'C';
            return {
                led: { port: v[0], pin: v[1], name: `P${pname(v[0])}${v[1]}` },
                button: v[2] > 2 ? null : { port: v[2], pin: v[3], level: v[4] ? 'HIGH' : 'LOW', name: chipIdx === 1 ? 'BUT (PB8)' : 'B1 (PC13)' },
                boot0: !!v[5],
                nrst: !!v[6],
                crystalHz: v[7],
                maxSysclkMhz: v[8],
            };
        },

        getRegisters() {
            // rustcpu_regs(): [r0..r12, sp, lr, pc, xpsr, primask, control, ipsr]
            const r = rustcpu_regs();
            const regs = {};
            for (let i = 0; i <= 12; i++) regs[`R${i}`] = r[i] >>> 0;
            regs.SP = r[13] >>> 0;
            regs.LR = r[14] >>> 0;
            regs.PC = r[15] >>> 0;
            regs.xPSR = r[16] >>> 0;
            return regs;
        },

        getPc() { return rustcpu_regs()[15] >>> 0; },
        setReg(i, v) { rustcpu_set_reg(i >>> 0, v >>> 0); },
        getSp() { return rustcpu_regs()[13] >>> 0; },
        setPc(pc) { rustcpu_set_pc(pc | 1); },

        /** Set symbol table (from .elf or .map) for resolveSymbol(). */
        setSymbols(list) {
            symbolList = list || [];
            symSorted = null;
        },

        getSymbolCount() { return symbolList.length; },

        /**
         * Resolve an address to the nearest symbol at or below it (e.g. 'main+0x1e').
         * @returns {string|null}
         */
        resolveSymbol(addr) {
            return resolveSym(addr);
        },

        getUartOutput() { return get_uart_output(); },

        /** Inject a byte into the UART RX (default: USART1 @ 0x40013800). */
        uartRx(byte) { return uart_rx_byte(uart_addr, byte); },
        /** Inject a received byte into a specific USART (by base address). */
        uartRxAddr(addr, byte) { return uart_rx_byte(addr, byte); },
        /** Inject a LIN break into a USART (LBD in LIN mode, FE otherwise). */
        uartInjectBreak(addr) { return uart_inject_break(addr); },
        uartRxBytes(bytes) {
            let ok = false;
            for (const b of bytes) ok = uart_rx_byte(uart_addr, b) || ok;
            return ok;
        },

        /** Unread bytes still queued in the UART RX buffer (0 = empty). */
        rxPending() { return uart_rx_pending(uart_addr); },

        /** True while a DMA transfer is queued (mirror of cli.mjs dmaBusy gate:
         *  hold UART bytes back while DMA is busy so the DMA RX test, not the
         *  UART RX test, consumes the reserved byte). */
        dmaPending() { return dma_get_pending_count() > 0; },

        /** Read a 32-bit word from emulated memory (e.g. a RAM flag). */
        memRead32(addr) {
            return read32(addr) >>> 0;
        },

        /** Raw guest-memory write (bytes): bypasses flash protection and MPU
         *  checks like a hardware probe (GDB `M` packets, BKPT patching). */
        memWriteBytes(addr, bytes) {
            rustcpu_mem_write_raw(addr >>> 0, bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes));
        },

        /** Last CPU fault ([pc, op]) since the previous call, if any. */
        takeFault() {
            const f = lastFault;
            lastFault = null;
            return f;
        },

        // ---- ARM debug-port slice (SWD + JTAG-DP + watchpoints) ----
        /** True while the core is halted (DHCSR C_HALT / watchpoint / VC). */
        swdHalted() { return swd_halted(); },
        /** External halt request (sets C_DEBUGEN+C_HALT, like a probe). */
        swdHalt() { swd_halt(); },
        /** Debugger resume (clears C_HALT; C_DEBUGEN stays, like silicon). */
        swdResume() { swd_resume(); },
        /** Single-step the halted core once (returns 0/1 executed). */
        swdStep() { return swd_step(); },
        /** Install a data watchpoint (kind 1=write/Z2, 2=read/Z3, 3=access/Z4).
         *  Returns the slot (0-3) or -1 when full. */
        swdAddWatch(kind, addr, len) { return swd_add_watchpoint(kind >>> 0, addr >>> 0, len >>> 0); },
        /** Remove a data watchpoint by slot. */
        swdRemoveWatch(slot) { swd_remove_watchpoint(slot >>> 0); },
        /** Take the pending watch trip ([] clean, else [addr, dir 1=write/2=read]). */
        swdTakeTrip() { return swd_take_trip(); },
        /** SWD DP register read/write (addr 0x0 DPIDR, 0x4 CTRL/STAT, 0x8 SELECT, 0xC RDBUFF). */
        swdDpRead(addr) { return swd_dp_read(addr >>> 0); },
        swdDpWrite(addr, value) { swd_dp_write(addr >>> 0, value >>> 0); },
        /** MEM-AP register read/write (bank, reg); bank-0 reg 0xC (DRW) moves TAR-width data. */
        swdApRead(bank, reg) { return swd_ap_read(bank >>> 0, reg >>> 0); },
        swdApWrite(bank, reg, value) { swd_ap_write(bank >>> 0, reg >>> 0, value >>> 0); },
        /** DCRSR-style core register access (0-12, 13 SP, 14 LR, 15 PC, 16 xPSR, 17 MSP, 18 PSP). */
        swdRegRead(idx) { return swd_reg_read(idx >>> 0); },
        swdRegWrite(idx, value) { swd_reg_write(idx >>> 0, value >>> 0); },
        /** Minimal JTAG TAP sharing the DP (probe helper, no new tests). */
        jtagReset() { swd_jtag_reset(); },
        jtagIr(ir) { swd_jtag_ir(ir >>> 0); },
        jtagIdcode() { return swd_jtag_idcode(); },
        jtagDp(addr, rnw, wdata) { return swd_jtag_dp(addr >>> 0, !!rnw, wdata >>> 0); },
        jtagAp(bank, reg, rnw, wdata) { return swd_jtag_ap(bank >>> 0, reg >>> 0, !!rnw, wdata >>> 0); },

        canInjectMessage(addr, tir, tdtr, tdlr, tdhr) {
            return can_inject_message(addr, tir, tdtr, tdlr, tdhr);
        },

        gpioReadOutput(port, pin) { return gpio_read_output(port, pin); },
        gpioReadInput(port, pin) { return gpio_read_input(port, pin); },
        gpioSetInput(port, pin, value) { gpio_set_input(port, pin, value); },

        /** PWM duty (0-100) of a timer channel, e.g. pwmDuty(0x40000000, 0) = TIM2 CH1. */
        pwmDuty(addr, channel = 0) { return pwm_duty(addr, channel); },

        setSimAdc(value) { adc_set_sim_value(value); },
        /** Override internal ADC channel 16/17/18 (temp/VREF/VBAT); 65535 clears to nominal. */
        adcSetInternal(channel, value) { adc_set_internal(channel, value); },
        /** Live power state: 0=RUN, 1=SLEEP, 2=STOP, 3=STANDBY. */
        pwrMode() { return pwr_mode(); },
        /** Live current-draw estimate in µA (DS5319-typical, uncalibrated). */
        pwrEstimate() { return pwr_estimate(); },
        gpioSetAnalog(port, pin, level) { gpio_set_analog(port, pin, level); },
        adcSetRcTau(cycles) { adc_set_rc_tau(cycles); },
        setTouch(peripheral, x, y, pressure) { touchscreen_set_touch(peripheral, x, y, pressure); },

        /** Watch every peripheral register write: fn(addr, width, value). Returns unsubscribe. */
        onPeriphWrite(fn) {
            writeWatchers.push(fn);
            rustcpu_write_tap(true);
            return () => {
                const i = writeWatchers.indexOf(fn);
                if (i >= 0) writeWatchers.splice(i, 1);
                if (writeWatchers.length === 0) rustcpu_write_tap(false);
            };
        },

        /** Watch chip-driven GPIO level changes: fn(port, pin, level) (port 0=GPIOA, level 0/1).
         *  Fires when the chip drives an output pin to a NEW level (ODR/BSRR/BRR writes, or
         *  CRL/CRH writes re-driving ODR). Does NOT fire for gpioSetInput (JS→chip direction).
         *  Drained automatically each batch (and before write watchers at each hook). Returns unsubscribe. */
        onPinChange(fn) {
            pinWatchers.push(fn);
            return () => {
                const i = pinWatchers.indexOf(fn);
                if (i >= 0) pinWatchers.splice(i, 1);
            };
        },

        /** Drain buffered pin-change events directly (flat [port, pin, level, ...]). */
        takePinEvents() { return gpio_take_pin_events(); },

        /** Drain virtual-peripheral transaction events as a flat i32 array (see drain_events export). */
        drainEvents() { return drain_events(); },

        /** Queue injected MISO bytes for a SPI channel (virtual device -> MCU). */
        spiInjectMiso(channel, bytes) { spi_inject_miso(channel, bytes); },

        /** Queue injected RX bytes for an I2C channel (virtual device -> MCU). */
        i2cInjectRx(channel, bytes) { i2c_inject_rx(channel, bytes); },

        /** Host START + address this I2C peripheral as a slave. Returns false (NACK) when busy/disabled/unmatched. */
        i2cInjectStart(channel, addr, isRead) { return i2c_inject_start(channel, addr, !!isRead); },

        /** Host data byte to an addressed slave (master-write). Returns false (NACK) when not ready. */
        i2cInjectWrite(channel, byte) { return i2c_inject_write(channel, byte); },

        /** Host read from an addressed slave (master-read). Returns -1 when DR empty (stretch). */
        i2cInjectRead(channel) { return i2c_inject_read(channel); },

        /** Host STOP to an addressed slave. */
        i2cInjectStop(channel) { return i2c_inject_stop(channel); },

        /** SMBus ALERT input: peer pulled SMBA low → SR1 SMBALERT + error IRQ (ITERREN). */
        i2cInjectAlert(channel) { return i2c_inject_alert(channel); },

        /** Enable/disable the AN3155 bootloader responder (claims USART1 RX while on). */
        bootloaderEnable(on) { bootloader_enable(!!on); },

        /** Last GO target address issued to the bootloader, or -1 when none. */
        bootloaderGoAddr() { return bootloader_go_addr(); },

        /** Inject a USB SETUP packet (8 bytes) into EP0 (host -> device). addr selects hardware address filtering (omit = correctly addressed). Returns false when NAKed/filtered. */
        usbInjectSetup(bytes, addr) { return usb_inject_setup(bytes, addr); },

        /** Host-driven USB bus reset (SE0): address clears, endpoints reset, RESET IRQ. */
        usbBusReset() { return usb_bus_reset(); },
        /** Host disconnect (pull-up off): tokens stop, IN stalls, SOF freezes; next bus reset reattaches. */
        usbDetach() { return usb_detach(); },
        /** Inject a USB OUT packet into an endpoint (host -> device). addr selects hardware address filtering (omit = correctly addressed). Returns false when NAKed/filtered. */
        usbInjectOut(ep, bytes, addr) { return usb_inject_out(ep, bytes, addr); },
        /** Inject a USB OTG_FS SETUP packet (8 bytes) into EP0 (host -> device). addr selects DCFG.DAD filtering (omit = correctly addressed). Returns false when dropped. */
        otgInjectSetup(bytes, addr) { return otg_inject_setup(bytes, addr); },
        /** Inject a USB OTG_FS OUT packet into an endpoint (host -> device). addr selects DCFG.DAD filtering (omit = correctly addressed). Returns false when dropped. */
        otgInjectOut(ep, bytes, addr) { return otg_inject_out(ep, bytes, addr); },
        /** Host-driven OTG_FS bus reset (SE0): endpoints + FIFOs + address reset, USBRST + ENUMDNE. */
        otgBusReset() { return otg_bus_reset(); },
        /** Host disconnect on OTG_FS (pull-up off); next bus reset reattaches. */
        otgDetach() { return otg_detach(); },
        /** Answer a pending OTG_FS host IN token on ep (or STALL it). */
        otgHostFeedIn(ep, bytes, stall) { return otg_host_feed_in(ep, bytes, !!stall); },
        /** Virtual-device attach/detach on the OTG_FS host port. */
        otgHostAttach(present) { return otg_host_attach(!!present); },

        /** Current I2C OLED framebuffer, page-major (page*width + col), 1 byte per column. */
        i2cOledFb(peripheral, address = 0x3C) {
            const arr = i2c_oled_fb(peripheral, address);
            return arr && arr.length ? new Uint8Array(arr) : null;
        },

        /** Current SPI LCD framebuffer, 128x64 (y*128 + x), 1 byte per pixel. */
        lcdFb(peripheral) {
            const arr = lcd_fb(peripheral);
            return arr && arr.length ? new Uint8Array(arr) : null;
        },

        /** Low-level register access (width: 1, 2, or 4). */
        periphRead(addr, width = 4) { return periph_read(addr, width) >>> 0; },
        periphWrite(addr, width, value) { periph_write(addr, width, value); },

        /** Write a byte directly into an FSMC backing image (no bus side effects). */
        fsmcWriteByte(name, offset, value) { return fsmc_write_byte(name, offset, value); },
        /** Read a byte directly from an FSMC backing image. Returns -1 on error. */
        fsmcReadByte(name, offset) { return fsmc_read_byte(name, offset); },

        /**
         * Register an rp2040js-style custom peripheral on the bus.
         * read(addr, size) -> number; write(addr, value, size). Last registration
         * wins on overlap, so JS can shadow built-in peripherals.
         */
        addJsPeripheral(base, size, read, write) {
            return register_js_peripheral(base, size, read, write);
        },


        close() {
            // Nothing to tear down; model state resets on init().
        },
    };
}

export default createEmulator;
