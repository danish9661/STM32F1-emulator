# Usage — CLI, Library, Browser, Development

## Install

```bash
npm install stm32f1-emu
```

The package ships everything as WASM: the native Rust CPU core plus all
peripherals live in `stm32_bluepill_wasm_bg.wasm` (no external binaries).
It works in **Node** and in the **browser** (ES modules).

## Library API (browser / Node)

```js
import { createEmulator } from "stm32f1-emu";

const emu = await createEmulator({
  firmware,            // Uint8Array of firmware (ELF, HEX, or raw BIN)
  flash_size: 0x10000, // Flash region size (64KB default)
  ram_size: 0x5000,    // SRAM size (20KB default)
  vector_table: 0x08000000, // Vector table base
  chip: 'stm32f103c8', // 'stm32f103c8' = builtin hardcoded map (default),
                       // or { name, svd } for any F1-family chip from an SVD
                       // (e.g. { name:'STM32F105', svd: svdXml } adds CAN2)
  svd: null,           // SVD XML string (optional; overrides the builtin map)
  js_peripherals: [],  // rp2040js-style custom peripherals, see below
  uart_addr: 0x40013800,    // USART used by uartRx()
  batch_size: 20000,   // fixed batch size; omit for adaptive 20K/50K (pkg/emulator.js:217)
  verbose: false,
  ext_devices: {},     // see below
});

emu.step(maxInst);          // run ≤ maxInst instructions (loop this in your rAF)
emu.tick();                 // tick peripherals once (called inside step)
emu.setPc(pc); emu.getPc(); emu.getSp(); emu.getRegisters();
emu.resolveSymbol(addr);    // 'main+0x1e' style, needs symbols from ELF/map
emu.setSymbols(list);       // [{name, addr}] from .elf or .map
emu.getUartOutput();        // everything the firmware ever printed
emu.uartRx(byte); emu.uartRxBytes(bytes); emu.rxPending();
emu.dmaPending();        // true while a DMA transfer is queued (UART gate: hold bytes back while busy)
emu.dmaIsr(1);           // DMA1 ISR flags word (TCIF/HTIF/TEIF/GIF per channel nibble)
emu.dmaGetCcr(1, ch); emu.dmaGetNdtr(1, ch); emu.dmaGetPar(1, ch); emu.dmaGetMar(1, ch); // channel regs (ch 1-based)
emu.dmaSetChannel(1, ch, { ccr, ndtr, par, mar }); // program a channel (CCR write of EN=1 queues it)
emu.dmaClearFlags(1, mask); // IFCR write-1-clears
emu.dmaQueueCount(); emu.dmaQueuePeek(); // raw queue depth + descriptors (peek CONSUMES the queue)
emu.dmaPump();           // one manual DMA pump (normally automatic per batch)
emu.dmaTakeAbsorbed(off, len); // periph→mem bytes from the last pump
emu.dmaCompleteMany(bits); // signal stream completion (TC IRQs when TCIE armed)
emu.getBatchSize(); emu.getInstCount(); // configured batch size (default 20000) + cumulative instruction counter (exact run accounting)
emu.irqPending(); emu.irqNext(); emu.irqReturn(); emu.irqFinish(irq); // raw IRQ take/return (every irqNext pairs with a return)
emu.rccSysclkHz(); emu.rccClocksHz(); emu.rccMcoHz(); emu.rccFailHse(); // clock tree + HSE failure
emu.pwrSetSupplyMv(mv);  // PVD rail in mV (default 3300); returns PVDO (below-threshold)
emu.i2cOledWrites('I2C1', 0x3C); // OLED byte-write counter (display traffic probe)
emu.canInjectMessage(addr, tir, tdtr, tdlr, tdhr);
emu.usbInjectSetup(bytes8); emu.usbInjectOut(ep, bytes); // host -> device (SETUP/OUT); IN completions arrive as UsbIn events via drainEvents()
emu.i2cInjectStart(ch, addr7, isRead); emu.i2cInjectWrite(ch, byte); // host addresses this MCU as an I2C slave (false = NACK when busy/unmatched/unready)
emu.i2cInjectRead(ch);     // returns byte, or -1 while the slave TX DR is empty (stretch)
emu.i2cInjectStop(ch);
emu.i2cInjectAlert(ch);   // SMBus: peer pulled SMBA low -> SR1 SMBALERT + ER IRQ (ITERREN)
emu.gpioReadOutput(port, pin); emu.gpioReadInput(port, pin); emu.gpioSetInput(...);
emu.gpioSetSlew(n);         // output slew delay in instructions (0 = instant) — IDR readback shows the old level until the transition settles
emu.pwmDuty(timerAddr, channel);    // duty 0-100, e.g. (0x40000000, 0) = TIM2 CH1
emu.setSimAdc(value);      // ADC conversion result firmware will read (conversion timing is real)
emu.adcSetInternal(ch, v); // drive temp/VREFINT/VBAT (ch 16/17/18); 65535 clears to nominal
emu.pwrMode();             // live power state: 0=RUN, 1=SLEEP, 2=STOP, 3=STANDBY (WFI-tracked)
emu.gpioSetAnalog(port, pin, level); // wire a 12-bit analog voltage onto a GPIO pin: ADC channels mapped to that pin sample it via an RC sample-and-hold instead of the sim value; level 0xFFFF disconnects
emu.adcSetRcTau(cycles);   // RC sample-and-hold time constant in ADC cycles (1 instr = 1 cycle), default 12
emu.setTouch(periphAddr, x, y, pressure);  // ADS7846 touch injection
emu.addJsPeripheral(base, size, read, write); // rp2040js-style custom peripheral on the bus
emu.periphRead(addr, width); emu.periphWrite(addr, width, value); // raw register access
emu.memRead32(addr);       // read emulated RAM/Flash word (e.g. firmware flags)
emu.onPeriphWrite(fn);     // tap every peripheral write: fn(addr, width, value) — page-side drivers (7-seg shift registers, CS tracking) watch buses like real hardware
emu.i2cOledFb('I2C1', 0x3C); // 128×64 monochrome framebuffer readback from an i2c_oled device (byte = 8 vertical pixels)
emu.lcdFb('SPI1');         // 128×64 byte-per-pixel framebuffer readback from an lcd device
```

### Custom JS peripherals (rp2040js-style)

The peripheral bus is a runtime registry (`src/bus.rs`, like rp2040js's `bus.ts`).
Peripherals can be added without touching Rust — a JS object with read/write
callbacks, called with the **absolute address** and access width:

```js
emu.addJsPeripheral(0x40007C00, 0x100,   // base, size
  (addr, size) => addr === 0x40007C00 ? 0xC0FFEE : 0,  // read(addr, size) -> number
  (addr, value, size) => { /* write(addr, value, size) */ });
```

Last registration wins on overlap, so a JS peripheral can shadow a built-in.
Registered peripherals live on the bus and are dropped by the next `createEmulator()`
(or `init()`/`init_svd()`). The CLI equivalent is a plugin module:

```bash
node pkg/cli.mjs firmware.elf --periph-plugin=./my_periph.mjs
# my_periph.mjs: export default [{ base, size, read(addr,size), write(addr,value,size) }]
```

Multi-chip: `chip: 'stm32f103c8'` uses the builtin hardcoded map; any F1-family
chip works from an SVD (`svd/STM32F105xx.svd` is shipped — adds CAN2@0x40006800).
Register-compatible variants need no SVD — pick a builtin name and get the
right flash/RAM sizes plus DBGMCU IDCODE (`tests/test_chips.mjs` asserts all):
`stm32f103cb`, `maple_mini` (F103CB 128K), `nucleo_f103rb` (128K),
`stm32f103rc` (256K/48K), `gd32f103c8/cb/rb` (IDCODE 0x2BA01477).
Timing stays instruction-budget based on every chip.
Board Arduino-pin aliases (`site/board_pins.json`, extracted from the
STM32duino variant files) label the page GPIO grid in Arduino numbering
(Nucleo D13 = PA5 LED, Maple D33 = PB1 LED, Pill D17 = PC13); the model
itself works in physical pins on every board.
Unsupported SVD peripherals (e.g. F105's ETH) are skipped, and the ARM core
peripherals (NVIC/SysTick/SCB) are auto-registered at their fixed addresses even
when the SVD omits them. F4/G0-class chips (MODER-style GPIO, different RCC)
need new peripheral modules — the bus/registry part is done.

### `ext_devices` — peripherals the STM32 talks to over SPI/I2C

```js
ext_devices: {
  spi_flash:   [{ peripheral, jedec_id, data, cs? }],            // e.g. {peripheral:0x40013000, jedec_id:0xEF4017, data:flashBuf}
  i2c_eeprom:  [{ peripheral, address, data }],                  // 7-bit address + backing Uint8Array (e.g. 64K)
  i2c_oled:    [{ peripheral, address, width, height }],         // e.g. SSD1306-style 128×64
  lcd:         [{ peripheral, cs }],                             // SPI TFT
  touchscreen: [{ peripheral, touch_detected_pin, cs }],         // ADS7846 (cs on the GPIO pin driving CS)
  software_spi:[{ name, cs, clk, miso, mosi }],                  // bit-banged SPI via GPIO transitions
  fsmc:        [{ name, data }],                                 // FSMC NOR/PSRAM: 'FSMC.BANK1..4' (NE1–4), 'FSMC.BANK5..6' (NAND), 'FSMC.BANK7' (PC Card); byte image
  sd_card:     [{ peripheral, data }],                           // SDHC card image (512 B sectors) for SDIO, e.g. {peripheral:'SDIO', data:sdBuf}
}
```

FSMC banks are read/written by the firmware at their memory windows (NE1–4 @ 0x6000_0000…,
NAND2/3 @ 0x7000_0000/0x8000_0000, PC Card @ 0x9000_0000) once the bank controller is
enabled (`BCR.MBKEN`; NOR writes also require `BCR.WREN`). Unmapped data accesses
(no bank backing or bank disabled) are raised as faults, and SVC/PendSV/hard-fault
handlers in firmware work normally (faults escalate to HardFault unless the SHCSR
enable bits are set via `SCB.SHCSR`).

### System-memory bootloader (AN3155 USART flow, no hardware)

```js
emu.bootloaderEnable(true);   // claim USART1 RX for the ROM responder
emu.uartRxAddr(0x40013800, 0x7F); // autobaud -> ACK
// ... GET / READ / GO / WRITE / ERASE frames (XOR checksums) ...
emu.bootloaderGoAddr();       // last GO target, or -1
emu.bootloaderEnable(false);  // hand USART1 back to the model
```

Answers the host flashing flow headlessly (autobaud, GET/version/ID
PID `0x0410`, READ/GO/WRITE/ERASE): flash and RAM operations land in the
real loaded image, so erase-write-verify cycles run in CI
(`tests/test_bootloader.mjs` 45/45). WRP is not enforced (ROM-privilege
model); GO records its address without retargeting the CPU.

### GPIO inputs, EXTI and page-side drivers
- `emu.gpioSetInput(port, pin, true|false)` sets an external input level; a level
  **change fires EXTI edges** just like a real push-button (IMR/RTSR/FTSR gated), so
  `attachInterrupt(pin, isr, RISING)` in firmware works with page-driven buttons.
- External peripherals stay on the JS side: register `emu.onPeriphWrite(fn)` and watch
  the bus (e.g. SPI1 DR while a CS pin is low) to decode shift-register chains, then
  render from `i2cOledFb`/`lcdFb` — the WASM core never knows about the widget.

## CLI (`pkg/cli.mjs`)

```bash
node pkg/cli.mjs <firmware> [options]
node pkg/cli.mjs --config=config.yaml <firmware>   # or --config=config.yaml with no position arg
```

Options:

| Flag | Meaning |
|---|---|
| `--config=<file>` | YAML config: registers (or SVD path), devices, memory regions, patches |
| `--max=<n>` | Run at most `n` instructions, then print `MAX_INST` summary and exit (e.g. `--max=200000000`). Default: run forever. |
| `--regs[=<file>]` | Dump register state to stdout/file and exit |
| `--uart=<file>` | Play a UART RX script file (bytes, fed via `uart_rx_byte`) |
| `--map=<file>` | Extra `.map` file for symbols (in addition to ELF symbols) |
| `--periph-plugin=<file.mjs>` | Register rp2040js-style JS peripherals: default export = `[{ base, size, read(addr,size), write(addr,value,size) }]` |
| env `FIRMWARE`, `MAX_INST` | Same as the position arg / `--max` |

The CLI prints machine-parseable lines: `[name] PASS/FAIL` per test check and a final
`SUMMARY pass=N fail=N` (see the firmware test below). Firmware can be **ELF** (symbols
auto-loaded), **HEX**, or **raw BIN**.

### config.yaml

```yaml
cpu:
  vector_table: 0x08000000
  svd: path/to/file.svd       # optional; any F1-family chip (e.g. svd/STM32F105xx.svd)
                              # default (no svd) = builtin STM32F103C8 hardcoded map
  chip: { svd: path }         # alternative to `svd` (rp2040js-style board object)
  use_hardcoded: true
regions:
  - start: 0x08000000
    size: 0x10000
    load: firmware.hex        # or bin/elf
devices:                      # same shape as library ext_devices
  spi_flash: [{ peripheral: 0x40013000, jedec_id: "0xEF4017", file: build/spi_flash.bin }]
  i2c_eeprom: [{ peripheral: 0x40005400, address: 0x51, file: build/eeprom.bin }]
patches:
  - addr: 0x08001BBC           # instruction-level patches (see workarounds)
```

### Firmware test (39 checks, the canary)

```bash
echo -n "AB" | node pkg/cli.mjs --config=tests/arduino_periph_test/config.yaml --max=200000000
node tests/canary.mjs          # same thing with --max=100000000, asserts 39/39, ~25s
```

- `A` (0x41) is reserved for the DMA RX test; `B` is the UART RX byte.
- CAN RX injection: cli polls the firmware's `canRxArmed` RAM global, then calls
  `can_inject_message(0x40006400, 0<<21, 2, 0xDEAD, 0)`. The firmware's filter bank 0 is
  ID-list mode → only STDID **0** matches — inject ID 0, not 0x123.
- **Batch-boundary timing**: peripherals tick only in `step_batch()` between `emu_start`
  batches — never mid-batch. Tests that read CNT/SR/IRQ flags after a `spin()` must be
  async-style (arm once, poll across batches). The one exception: `svc` fires
  synchronously inside a batch (the hook jumps straight to `SVC_Handler`), so a
  synchronous SVC check works in `setup()`.
- Use `--max=200000000` for the full run (50M stops mid-print, which is not a deadlock).

## Browser demo (`site/index.html:16`, `site/worker.js:1`, `site/_headers:1`)

```bash
python -m http.server -d site   # open http://localhost:8000  (site/ serves index.html)
# or: npx serve site -p 8000
```

The demo runs the periph39 firmware live. Dual-mode:

- **Worker path** (preferred, `site/worker.js:48`): `new Worker('./worker.js', {type:'module'})` (`site/index.html:449`) — emulation runs off-main-thread at ~60fps / 80ms budget (`site/worker.js:130`), posts `{frame, pins, uartOut, oledFb/lcdFb}` to main. Main thread only renders. ~8.6 MIPS headed.
- **Main-thread fallback** (`site/index.html:1034`): `requestAnimationFrame(runLoop)` when Worker unavailable — same `emu.step()` logic, same 8.6 MIPS (headed) / 4.5 MIPS (headless rAF throttled).
- **SAB ON/OFF** (`site/_headers:1`, `site/coi-serviceworker.js:1`, `site/index.html:300`): `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` → `crossOriginIsolated=true` → `SharedArrayBuffer` 32B + `Atomics.store/notify` (`site/worker.js:163`) + `queueMicrotask` loop vs `setTimeout 4ms` (`site/worker.js:220`). Badge shows `SAB ON` (green, 9.22 MIPS) vs `SAB OFF` (grey, 8.65 MIPS = +6.6%). GitHub Pages has no headers → `coi-serviceworker.js` polyfill injects them via ServiceWorker and reloads; both modes work.
- **OffscreenCanvas** (`site/worker.js:117`, `site/index.html:977`): main calls `canvas.transferControlToOffscreen()` and sends `[oledOff, lcdOff]` to worker (`site/worker.js:118`); worker renders `oledCtx`/`lcdCtx` directly (`site/worker.js:168`). If transfer not supported (Safari) worker sends framebuffers to main — no feature loss.
- **Adaptive batch** (`pkg/emulator.js:698`): `20K` when IRQ/DMA pending (≈1.1 ms latency), `50K` idle; override with `batch_size` (`pkg/emulator.js:217`) e.g. `{batch_size: 20000}` for fixed. `UI_THROTTLE 10` (`site/index.html:441`) decouples DOM — step every rAF, render every 10th frame (~6fps).

Full periph39 run: ~0.5 s wall headed (~40.7M in 8.97s pure = 8.6 MIPS; 4.5 MIPS headless).

## Development

```bash
cargo check                          # Rust sanity (fast)
wasm-pack build --target web         # rebuild pkg/stm32_bluepill_wasm_bg* (Rust → wasm)
node tests/test_all.mjs              # 236 unit tests
node tests/canary.mjs                # regression canary: 39/39 firmware checks, ~25s
node tests/bench.mjs                 # benchmarks
```

Firmware rebuild (Linux, arduino-cli installed locally):

```bash
/home/danish1075/bin/arduino-cli compile --fqbn STMicroelectronics:stm32:GenF1:pnum=BLUEPILL_F103C8 \
  --build-path tests/arduino_periph_test/build tests/arduino_periph_test
# NOTE: --build-path wipes eeprom.bin/spi_flash.bin — restore from site/ after compiling:
node -e "const fs=require('fs'); const e2=Buffer.alloc(65536); e2[0]=0x42; e2[1]=0x24;
fs.writeFileSync('tests/arduino_periph_test/build/eeprom2.bin', e2);
fs.writeFileSync('tests/arduino_periph_test/build/spi_flash2.bin', Buffer.alloc(65536));"
```

> **Staging rule**: always `git add -A` or stage BOTH `pkg/` and `site/` together —
> CI compares `pkg/emulator.js` against `site/emulator.js`. `site/sync-docs.mjs`
> copies fresh artifacts (`pkg/*.js`, `pkg/*.wasm`, `pkg/emulator.js`, `pkg/index.html`)
> into `site/`.

Disassembly for ISR debugging (Windows PowerShell):
`arm-none-eabi-objdump -d tests/arduino_periph_test/build/arduino_periph_test.ino.elf > isr.asm`

## Performance notes (`docs/ARCHITECTURE.md:201`)

- **Headless (Node CLI)**: **21.8 MIPS** — 50M in 2.29s (`pkg/cli.mjs:632` adaptive 20K/50K); **26.5 MIPS pure** (no IRQ/DMA batch overhead).
- **Browser (headed)**: **8.6 MIPS** (40.7M/8.97s); **4.5 MIPS** headless (rAF throttled). **SAB ON 9.22 vs OFF 8.65 = +6.6%** (`site/_headers:1`, `site/worker.js:163` SharedArrayBuffer + `site/worker.js:220` queueMicrotask).
- **Batch**: adaptive **20K** (IRQ/DMA pending, ≈1.1 ms latency) / **50K** idle (`pkg/emulator.js:698`); `batch_size` option overrides (`pkg/emulator.js:217`).
- **Pooling**: `REG_POOL 16` `regsRead`/`regsWrite` pooled (`pkg/emulator.js:228`) — 384 allocs/40M → once.
- **Worker + OffscreenCanvas + UI_THROTTLE 10** (`site/worker.js:1`, `site/index.html:441`): emulation off-main-thread, canvas in worker, DOM 6fps vs step 60fps — never starves throughput.
- RSS stable at ~150 MB regardless of instruction count (no leaks — stress-verified over ~2.5B instructions).
