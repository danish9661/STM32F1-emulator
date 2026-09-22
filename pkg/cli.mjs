#!/usr/bin/env node
import { readFileSync } from 'fs';
import path from 'path';
import * as yaml from 'js-yaml';
import { parseIntelHex, parseSymbolMap, parseElf } from './emulator.js';
import * as periph from './stm32_bluepill_wasm.js';
const { process_batch, dma_get_pending_count,
is_watchdog_reset_requested, add_spi_flash, add_i2c_eeprom, add_touchscreen, add_sd_card,
add_lcd, add_i2c_oled, reset_ext_devices, register_js_peripheral, can_inject_message, raise_fault,
init, init_svd, get_uart_output, uart_rx_byte, uart_rx_pending,
rustcpu_init, rustcpu_load, rustcpu_run, rustcpu_fault, rustcpu_fault_clear, rustcpu_dispatch,
rustcpu_regs, rustcpu_set_pc, rustcpu_mem_read, rustcpu_mem_write, rustcpu_dma_pump, rustcpu_i2c_hook_fired } = periph;

periph.initSync({ module: readFileSync(new URL('./stm32_bluepill_wasm_bg.wasm', import.meta.url)) });

const parseHex = (v) => typeof v === 'number' ? v : parseInt(v, 16);

function loadFirmware(buf) {
    if (buf.length === 0) {
        throw new Error('Firmware file is empty (0 bytes)');
    }
    if (buf.length > 4 && buf[0] === 0x7F && buf[1] === 0x45 && buf[2] === 0x4C && buf[3] === 0x46) {
        const elf = parseElf(buf);
        if (!elf.regions || elf.regions.length === 0) {
            throw new Error('ELF file has no loadable segments — is this a valid ARM Thumb ELF?');
        }
        console.log(`Parsed ELF: ${elf.regions.length} load segments, ${elf.symbols.length} symbols`);
        return { data: new Uint8Array(0), base: null, regions: elf.regions, symbols: elf.symbols };
    }
    if (buf.length > 0 && buf[0] === 0x3A) {
        const parsed = parseIntelHex(new TextDecoder().decode(buf));
        if (parsed.data.length === 0) {
            throw new Error('Intel HEX parsed to 0 bytes — check the file format');
        }
        console.log(`Parsed Intel HEX: base=0x${parsed.base.toString(16)} (${parsed.data.length} bytes)`);
        return { data: parsed.data, base: parsed.base, regions: null, symbols: null };
    }
    console.warn(`Warning: unrecognized firmware format (first bytes: ${Array.from(buf.slice(0, 8)).map(b => '0x' + b.toString(16)).join(' ')}). Loading as raw binary at 0x08000000.`);
    return { data: buf, base: null, regions: null, symbols: null };
}

function makeResolver(symbols) {
    if (!symbols || !symbols.length) return null;
    const sorted = symbols.slice().sort((a, b) => a.addr - b.addr);
    return (addr) => {
        const a = addr & ~1;
        let lo = 0, hi = sorted.length - 1, best = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (sorted[mid].addr <= a) { best = mid; lo = mid + 1; } else hi = mid - 1;
        }
        if (best < 0) return null;
        const s = sorted[best];
        const off = a - s.addr;
        if (off > 0x20000) return null;
        return off > 0 ? `${s.name}+0x${off.toString(16)}` : s.name;
    };
}

async function main() {
    await null;
    const args = process.argv.slice(2);

    if (args.includes('--help') || args.includes('-h')) {
        console.log(`
stm32f1-emu — STM32F1 Blue Pill emulator (native Rust CPU + Rust peripherals, WASM)

Usage:
  stm32f1-emu <firmware> [max_instructions] [options]
  stm32f1-emu --config=<path.yaml> [max_instructions] [options]

Firmware formats:
  .elf    ELF binary (symbols resolved automatically)
  .hex    Intel HEX
  .bin    Raw binary (loaded at 0x08000000)

Options:
  --config=<path>      Load YAML config file (can be repeated)
  --max=<N>            Max instructions to execute (default: 1000000, or env MAX_INST)
  --map=<file.map>     Load symbol map for PC → name resolution
  --uart=<addr>        UART peripheral address (default: 0x40013800, or env UART_ADDR)
  --regs               Dump registers every batch
  --verbose            Print peripheral read/write traces (very noisy)
  --periph-plugin=<m>  Load JS peripheral plugin (default export: [{base,size,read,write}])
  -h, --help           Show this help

Environment variables:
  FIRMWARE             Firmware path (alternative to positional arg)
  MAX_INST             Max instructions (alternative to --max)
  UART_ADDR            UART address (alternative to --uart)
  SHOW_REGS=1          Dump registers (alternative to --regs)

Examples:
  stm32f1-emu firmware.elf 200000000
  stm32f1-emu --config=tests/arduino_periph_test/config.yaml --max=200000000
  echo -n "AB" | stm32f1-emu firmware.elf --max=200000000
  stm32f1-emu firmware.bin --verbose --regs
`);
        process.exit(0);
    }
    const configPaths = args.filter(a => a.startsWith('--config=')).map(a => a.split('=')[1]);
    const posArgs = args.filter(a => !a.startsWith('--'));
    const maxInst = parseInt(
        args.find(a => a.startsWith('--max='))?.split('=')[1]
        || (configPaths.length > 0 ? posArgs[0] : posArgs[1])
        || process.env.MAX_INST || '1000000', 10);
    const showRegs = args.includes('--regs') || process.env.SHOW_REGS === '1';
    const verbose = args.includes('--verbose');
    const mapPath = args.find(a => a.startsWith('--map='))?.split('=')[1];
    const periphPlugin = args.find(a => a.startsWith('--periph-plugin='))?.split('=')[1];
    let uartAddr = parseInt(args.find(a => a.startsWith('--uart='))?.split('=')[1] || process.env.UART_ADDR || '0x40013800', 16);

    let config = {};
    if (configPaths.length > 0) {
        for (const cp of configPaths) {
            let raw;
            try {
                raw = yaml.load(readFileSync(cp, 'utf8'));
            } catch (e) {
                console.error(`Error: cannot read config file: ${cp}`);
                console.error(`  ${e.code === 'ENOENT' ? 'File not found' : e.message}`);
                process.exit(1);
            }
            if (!raw || typeof raw !== 'object') {
                console.error(`Error: config file is empty or invalid YAML: ${cp}`);
                process.exit(1);
            }
            const cfgDir = path.dirname(path.resolve(cp));
            if (raw.regions) raw.regions = raw.regions.map(r => ({ ...r, _dir: cfgDir }));
            if (raw.patches) raw.patches = raw.patches.map(p => ({ ...p, _dir: cfgDir }));
            raw._devices_dir = cfgDir;
            config = { ...config, ...raw, regions: [...(config.regions || []), ...(raw.regions || [])], patches: [...(config.patches || []), ...(raw.patches || [])] };
        }
        console.log(`Using config(s): ${configPaths.join(', ')}`);
    }

    let firmware;
    let fwBase = null;
    let fwRegions = null;
    let fwSymbols = null;
    let vector_table;
    let memRegions;

    if (config.regions) {
        memRegions = config.regions.map(r => ({ ...r, start: parseHex(r.start), size: parseHex(r.size) }));
        const romRegion = memRegions.find(r => r.load);
        if (!romRegion) {
            console.error('Error: config defines no region with a "load" file.');
            console.error('  Each region needs a "load" field pointing to the firmware binary/hex/elf.');
            console.error('  Example: regions: [{ start: 0x08000000, size: 0x10000, load: firmware.bin }]');
            process.exit(1);
        }
        vector_table = parseHex(config.cpu?.vector_table || romRegion.start);
        const romFile = path.resolve(romRegion._dir || config._devices_dir, romRegion.load);
        const fw = loadFirmware(readFileSync(romFile));
        firmware = fw.data;
        fwBase = fw.base;
        fwRegions = fw.regions;
        fwSymbols = fw.symbols;
        console.log(`Loading firmware: ${romFile} (${firmware.length} bytes)`);

        // Register external devices from config BEFORE init()
        reset_ext_devices();
        if (config.devices) {
            for (const [type, devs] of Object.entries(config.devices)) {
                for (const d of devs || []) {
                    if (type === 'i2c_eeprom') {
                        const data = d.file ? readFileSync(path.resolve(config._devices_dir, d.file)) : new Uint8Array(d.size || 0);
                        add_i2c_eeprom(d.peripheral, parseHex(d.addr), data);
                    } else if (type === 'spi_flash') {
                        const data = d.file ? readFileSync(path.resolve(config._devices_dir, d.file)) : new Uint8Array(d.size || 0);
                        add_spi_flash(d.peripheral, parseHex(d.jedec_id), data, d.cs || null);
                    } else if (type === 'sd_card') {
                        const data = d.file ? readFileSync(path.resolve(config._devices_dir, d.file)) : new Uint8Array(d.size || 0);
                        add_sd_card(d.peripheral, data);
                    } else if (type === 'usart_probe') {
                        // Legacy config key: USART probes are log-only taps in
                        // the model (no add_* export, no registration needed).
                        // Accept "USART1"/"USART2"/"0x40004400" here to select
                        // the stdin UART: hex digits parse as an address,
                        // otherwise map known USART names.
                        const m = String(d.peripheral || '').match(/[0-9a-fA-F]+/);
                        const asAddr = m ? parseInt(m[0], 16) : NaN;
                        if (Number.isFinite(asAddr) && asAddr >= 0x40000000) {
                            uartAddr = asAddr;
                        } else {
                            const USART_ADDRS = { USART1: 0x40013800, USART2: 0x40004400, USART3: 0x40004800, UART4: 0x40004C00, UART5: 0x40005000 };
                            uartAddr = USART_ADDRS[String(d.peripheral || '').toUpperCase()] || uartAddr;
                        }
                    } else if (type === 'touchscreen') {
                        add_touchscreen(d.peripheral, d.touch_detected_pin || null, d.cs || null);
                    } else if (type === 'lcd') {
                        add_lcd(d.peripheral, d.cs || null);
                    } else if (type === 'i2c_oled') {
                        add_i2c_oled(d.peripheral, parseInt(d.addr || '0x3C', 16), parseInt(d.width || '128', 10), parseInt(d.height || '64', 10));
                    }
                }
            }
        }

        // Board selection (rp2040js-style): 'stm32f103c8' = builtin hardcoded map;
        // cpu.svd (or cpu.chip = { svd: ... }) = any F1-family chip built from SVD.
        const chipSvd = typeof config.cpu?.chip === 'string' ? null : config.cpu?.chip?.svd;
        if (config.cpu?.use_hardcoded || (!config.cpu?.svd && !chipSvd)) {
            init();
        } else {
            const svdXml = chipSvd ?? readFileSync(path.resolve(config._devices_dir, config.cpu.svd), 'utf8');
            init_svd(svdXml);
        }

        // rp2040js-style custom peripherals from a JS plugin module:
        //   --periph-plugin=./my_periph.mjs   (default export: array of {base, size, read, write})
        if (periphPlugin) {
            const mod = await import(path.resolve(process.cwd(), periphPlugin));
            const list = mod.default ?? [];
            for (const jp of list) {
                register_js_peripheral(jp.base, jp.size, jp.read, jp.write);
                console.log(`Registered JS peripheral at 0x${jp.base.toString(16)} (${jp.size} bytes)`);
            }
        }

        if (config.patches) {
            for (const p of config.patches) {
                const start = BigInt(parseHex(p.start));
                const data = new Uint8Array(p.data);
                const romRegionStart = BigInt(romRegion.start);
                const relOff = Number(start - romRegionStart);
                if (relOff >= 0 && relOff + data.length <= firmware.length) {
                    data.forEach((b, i) => firmware[relOff + i] = b);
                    console.log(`Applied patch at 0x${start.toString(16)}: [${data.join(', ')}]`);
                }
            }
        }
    } else {
        const firmwarePath = posArgs[0] || process.env.FIRMWARE;
        if (!firmwarePath) {
            console.error('Error: no firmware file specified.');
            console.error('');
            console.error('Provide a firmware as the first argument, or use --config=<path>.');
            console.error('Run with --help for full usage information.');
            process.exit(1);
        }
        let fwBuf;
        try {
            fwBuf = readFileSync(firmwarePath);
        } catch (e) {
            console.error(`Error: cannot read firmware file: ${firmwarePath}`);
            console.error(`  ${e.code === 'ENOENT' ? 'File not found' : e.message}`);
            process.exit(1);
        }
        let fw;
        try {
            fw = loadFirmware(fwBuf);
        } catch (e) {
            console.error(`Error loading firmware: ${e.message}`);
            console.error(`  File: ${path.resolve(firmwarePath)}`);
            process.exit(1);
        }
        firmware = fw.data;
        fwBase = fw.base;
        fwRegions = fw.regions;
        fwSymbols = fw.symbols;
        console.log(`Loading firmware: ${firmwarePath} (${firmware.length} bytes)`);

        const fwDir = path.dirname(path.resolve(firmwarePath));
        reset_ext_devices();
        for (const fn of ['eeprom.bin', 'spi_flash.bin']) {
            try {
                const data = readFileSync(`${fwDir}/${fn}`);
                if (fn.startsWith('eeprom')) add_i2c_eeprom("I2C1", 0x50, data);
                else add_spi_flash("SPI1", 0xef4016, data, null);
                console.log(`Loaded ext device: ${fwDir}/${fn} (${data.length} bytes)`);
            } catch (_) {}
        }

        // Try SVD file, fall back to hardcoded
        const svdFallbackPaths = [
            path.resolve(fwDir, 'STM32F103.svd'),
            path.resolve(process.cwd(), 'STM32F103.svd'),
            path.resolve(process.cwd(), 'svd', 'STM32F103.svd'),
        ];
        let svdLoaded = false;
        for (const svdPath of svdFallbackPaths) {
            try {
                const svdXml = readFileSync(svdPath, 'utf8');
                init_svd(svdXml);
                console.log(`Using SVD: ${svdPath}`);
                svdLoaded = true;
                break;
            } catch (_) {}
        }
        if (!svdLoaded) {
            init();
        }
        vector_table = 0x08000000;
        memRegions = [
            { start: 0x08000000, size: 0x10000 },
            { start: 0x20000000, size: 0x5000 },
        ];
    }

    console.log(`Max instructions: ${maxInst}`);
        if (mapPath) {
            const { readFileSync: rfs } = await import('fs');
            fwSymbols = parseSymbolMap(rfs(path.resolve(mapPath), 'utf8'));
            console.log(`Loaded ${fwSymbols.length} symbols from map: ${mapPath}`);
        }
        const flashRegion = memRegions.find(r => vector_table >= r.start && vector_table < r.start + r.size) || memRegions[0];
        const ramRegion = memRegions.find(r => 0x20000000 >= r.start && 0x20000000 < r.start + r.size);
        const flashSize = flashRegion ? flashRegion.size : 0x10000;
        const ramSize = ramRegion ? ramRegion.size : 0x5000;

        // Vector table bytes straight from the loaded image (no backend needed).
        const vecAt = (off) => {
            if (fwRegions && fwRegions.length) {
                for (const r of fwRegions) {
                    const a = vector_table + off;
                    if (a >= r.start && a + 1 <= r.start + r.data.length) {
                        const o = a - r.start;
                        return r.data[o] | (r.data[o + 1] << 8) | (r.data[o + 2] << 16) | (r.data[o + 3] << 24);
                    }
                }
                return 0;
            }
            const base = fwBase != null ? fwBase : (flashRegion ? flashRegion.start : 0x08000000);
            const o = vector_table + off - base;
            if (!firmware || o < 0 || o + 4 > firmware.length) return 0;
            return firmware[o] | (firmware[o + 1] << 8) | (firmware[o + 2] << 16) | (firmware[o + 3] << 24);
        };
        const sp_init = vecAt(0) >>> 0;
        const pc_init = vecAt(4) >>> 0;
        if (sp_init === 0 || sp_init === 0xFFFFFFFF || pc_init === 0 || pc_init === 0xFFFFFFFF || (pc_init & 1) === 0) {
            console.error(`Error: invalid vector table at 0x${vector_table.toString(16)} (SP=0x${sp_init.toString(16)} PC=0x${pc_init.toString(16)})`);
            process.exit(1);
        }
        rustcpu_init(sp_init, pc_init, flashSize, ramSize);

        const loadOne = (start, data) => rustcpu_load(data, start >>> 0);
        if (fwRegions && fwRegions.length) {
            for (const r of fwRegions) loadOne(r.start, r.data);
        } else if (firmware && fwBase != null) {
            loadOne(fwBase, firmware);
        } else if (firmware) {
            const romStart = flashRegion ? flashRegion.start : 0x08000000;
            loadOne(romStart, firmware);
            if (romStart !== vector_table) loadOne(vector_table, firmware);
        }
        console.log(`SP=0x${sp_init.toString(16)} PC=0x${(pc_init | 1).toString(16)}`);

        const read32rc = (addr) => {
            const b = rustcpu_mem_read(addr >>> 0, 4);
            return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0, true);
        };
        const traceResolve = makeResolver(fwSymbols);
        const canArmedSym = fwSymbols?.find(s => s.name === 'canRxArmed');

        const stdinQueue = [];
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        process.stdin.on('data', (chunk) => { for (const b of chunk) stdinQueue.push(b); });
        process.stdin.resume();
        if (process.stdin.isTTY) process.on('SIGINT', () => { process.stdin.setRawMode(false); process.exit(0); });

        let instCount = 0, batchInstCount = 0, totalSteps = 0;
        let stopRequested = false, anyPending = false, canInjected = false;
        const startTime = Date.now();
        const maxBatch = parseInt(process.env.EMU_BATCH || '20000', 10);
        const SMALL_BATCH = 20000, LARGE_BATCH = 50000;
        while (!stopRequested) {
            const dmaBusy = dma_get_pending_count() > 0;
            while (stdinQueue.length > 0 && uart_rx_pending(uartAddr) === 0 && !dmaBusy) uart_rx_byte(uartAddr, stdinQueue.shift());
            // No hook-based poll detector on this path (no mem hooks by design);
            // keep the pending/DMA/RX adaptive sizes (fixed 20K/50K otherwise).
            const curBatch = process.env.EMU_BATCH ? maxBatch
                : ((anyPending || dmaBusy || uart_rx_pending(uartAddr) !== 0) ? SMALL_BATCH : LARGE_BATCH);
            rustcpu_dma_pump();
            const n = rustcpu_run(curBatch);
            const fault = rustcpu_fault();
            if (fault.length) {
                const [fpc, op1] = fault;
                const sym = traceResolve ? (traceResolve(fpc) || fpc.toString(16)) : fpc.toString(16);
                console.log(`FAULT @${sym} op=0x${op1.toString(16)} (CPU decode gap)`);
                if (traceResolve && fwSymbols?.length) {
                    raise_fault(3, fpc); // UNDEFINSTR; handler runs via dispatch below
                }
                rustcpu_set_pc((fpc + 2) | 1);
                rustcpu_fault_clear();
            }
            instCount += n;
            batchInstCount += n;
            if (batchInstCount > 0) {
                const status = process_batch(batchInstCount);
                batchInstCount = 0;
                if (status & 0x80000000) { stopRequested = true; break; }
                anyPending = (status & 0x40000000) !== 0;
            }
            rustcpu_dma_pump();
            rustcpu_dispatch();
            if (rustcpu_fault().length) {
                const [fpc] = rustcpu_fault();
                console.error(`Emulation error: handler fault at 0x${fpc.toString(16)}`);
                break;
            }
            // hi2c->Mode RAM patch: HAL I2C1 ISR needs Mode == 0x22 before DR read.
            if (rustcpu_i2c_hook_fired()) {
                try {
                    const hi2c1Ptr = read32rc(0x200002d8);
                    if (hi2c1Ptr && hi2c1Ptr !== 0xFFFFFFFF) rustcpu_mem_write((hi2c1Ptr + 0x3D) >>> 0, new Uint8Array([0x22]));
                } catch (_) {}
            }
            if (canArmedSym && !canInjected) {
                const armedBytes = rustcpu_mem_read(canArmedSym.addr >>> 0, 4);
                if (armedBytes && armedBytes[0] !== 0) {
                    canInjected = can_inject_message(0x40006400, 0 << 21, 2, 0xDEAD, 0);
                }
            }
            totalSteps++;
            try { if (stopRequested || is_watchdog_reset_requested()) break; } catch (e) { break; }
            if (instCount >= maxInst) break;
            await new Promise(r => setImmediate(r));
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        const regs = rustcpu_regs();
        const finalSp = regs[13], finalPc = regs[15];
        const uartOut = get_uart_output();
        if (uartOut) console.log(`\n=== UART Output ===\n${uartOut}`);
        try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch (_) {}
        console.log(`\nDone: ${totalSteps} steps, ${instCount} instructions in ${elapsed}s`);
        const resolve = makeResolver(fwSymbols);
        const pcName = resolve && resolve(finalPc);
        const spName = resolve && resolve(finalSp);
        console.log(`PC=0x${finalPc.toString(16)}${pcName ? `  → ${pcName}` : ''} SP=0x${finalSp.toString(16)}${spName ? `  → ${spName}` : ''}`);
        if (showRegs) {
            for (let i = 0; i <= 12; i++) {
                process.stdout.write(`R${i}=0x${regs[i].toString(16).padStart(8, '0')} `);
                if (i % 4 === 3) console.log();
            }
            console.log(`LR=0x${regs[14].toString(16).padStart(8, '0')}`);
            console.log(`xPSR=0x${regs[16].toString(16).padStart(8, '0')}`);
        }
}

main().catch(e => {
    console.error('');
    console.error('=== Fatal Error ===');
    console.error(`  Type: ${typeof e}`);
    console.error(`  Name: ${e?.name || '(none)'}`);
    console.error(`  Message: ${e?.message || '(none)'}`);
    if (e?.code) console.error(`  Code: ${e.code}`);
    if (e?.stack) console.error(`  Stack: ${e.stack.substring(0, 500)}`);
    console.error('');
    console.error('If this is a WASM crash, try re-building with: wasm-pack build --target web');
    console.error('For bugs, report at: https://github.com/danish9661/STM32F1-emulator/issues');
    process.exit(1);
});
