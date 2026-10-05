# STM32 Bluepill Emulator

[![npm version](https://img.shields.io/npm/v/stm32f1-emu.svg?color=cb3837)](https://www.npmjs.com/package/stm32f1-emu)
[![npm downloads](https://img.shields.io/npm/dm/stm32f1-emu.svg)](https://www.npmjs.com/package/stm32f1-emu)
[![Live Demo](https://img.shields.io/badge/live%20demo-github%20pages-38bdf8)](https://danish9661.github.io/STM32F1-emulator/)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)

A full-system emulator for the **STM32F1 family** (STM32F103C8 "Blue Pill",
STM32F105, GD32F103, Maple Mini, Nucleo-F103RB, etc.)
that runs **real, unmodified Arduino / STM32Cube firmware** in Node.js or the browser.

**~70M instructions/sec** headless (`200M` in `~2.8s`, native Rust CPU + Rust peripherals in one WASM module with full MPU enforcement) and multi-MIPS in the browser demo loop. The interactive page loop stays frame-budgeted.

> **Project status: complete.** The emulator is feature-complete and stable —
> every peripheral in scope is modeled and proven (764 unit checks, 39/39
> real-firmware checks, GDB + SWD/JTAG debug, 8 chip variants, live browser
> demos). What remains intentionally unmodeled is listed under
> [Out of scope](docs/PERIPHERALS.md#out-of-scope-by-decision-not-by-omission);
> future work is maintenance only (toolchain pins, firmware rebuilds).

## Screenshots

Click any screenshot for the full gallery (live demo: https://danish9661.github.io/STM32F1-emulator/).

| Showcase (~73M IPS) | 39/39 firmware checks |
|---|---|
| [![Peripheral showcase running in the browser](https://danish9661.github.io/STM32F1-emulator/img/shot-showcase-sm.png)](https://danish9661.github.io/STM32F1-emulator/docs.html#screenshots) | [![39 of 39 firmware checks passing](https://danish9661.github.io/STM32F1-emulator/img/shot-periph37-sm.png)](https://danish9661.github.io/STM32F1-emulator/docs.html#screenshots) |

| Showcase widgets |
|---|
| [![OLED, LCD, 7-segment, RGB and GPIO grid live](https://danish9661.github.io/STM32F1-emulator/img/shot-showcase-widgets-sm.png)](https://danish9661.github.io/STM32F1-emulator/docs.html#screenshots) |

---

## Install

```bash
npm install stm32f1-emu
```

Requires **Node.js 18+** (ESM). In the browser, load via a `<script>` tag or bundler.

---

## Quick Start

### Node.js — High-Level API (recommended)

```js
import { STM32F1 } from 'stm32f1-emu';
import { readFileSync } from 'fs';

// Load an ELF, BIN, or Intel HEX
const mcu = await STM32F1.fromELF(readFileSync('firmware.elf'));

// Or from raw binary / Intel HEX text
// const mcu = await STM32F1.fromBin(readFileSync('firmware.bin'));
// const mcu = await STM32F1.fromHex(readFileSync('firmware.hex'), 'utf8');

// Subscribe to USART TX (MCU → host)
mcu.usart1.onData = (byte) => process.stdout.write(String.fromCharCode(byte));

// Subscribe to GPIO changes
mcu.gpio.pin('C', 13).on('change', (high) => {
  console.log('PC13 LED:', high ? 'ON' : 'OFF');
});

// Run 1 million instructions (auto-drains events after each batch)
const result = await mcu.execute(1_000_000);
console.log(result.instCount, 'instructions executed');

// Inject bytes into UART RX (host → MCU)
mcu.uartRx(0x41); // send 'A'

// Read UART output
console.log(mcu.uartOutput);

// Clean up
mcu.close();
```

### Node.js — Low-Level API

The low-level emulator is also available via the `./emulator` sub-export:

```js
import { createEmulator } from 'stm32f1-emu/emulator';
import { readFileSync } from 'fs';

const emu = await createEmulator({
  firmware: readFileSync('firmware.elf'),  // Uint8Array, string (HEX), or ArrayBuffer
});

const result = emu.run(10_000_000);  // run up to 10M instructions
console.log(result.instCount, 'instructions executed');

console.log(emu.getUartOutput());          // USART1 TX output
console.log(emu.gpioReadOutput(2, 13));    // PC13 level (port 2 = C)
emu.uartRxBytes([0x31, 0x32]);             // inject RX bytes
console.log(emu.getRegisters());           // { R0..R12, SP, LR, PC, xPSR }

emu.close();
```

### Browser

```html
<script type="module">
  import { STM32F1 } from 'stm32f1-emu';

  const mcu = await STM32F1.fromELF(
    await (await fetch('firmware.elf')).arrayBuffer()
  );

  mcu.usart1.onData = (b) => {
    document.getElementById('terminal').textContent += String.fromCharCode(b);
  };
  mcu.gpio.pin('C', 13).on('change', (high) => {
    document.getElementById('led').style.background = high ? '#f00' : '#300';
  });

  // Run 20K instructions per frame (~60 fps)
  function loop() {
    mcu.step(20_000);
    requestAnimationFrame(loop);
  }
  loop();
</script>
```

---

## STM32F1 Wrapper API

The high-level `STM32F1` class wraps the low-level emulator with a Wokwi-style
event-driven API. All bus transactions (SPI, I2C, USART, ADC, TIM, etc.) are
decoded into callbacks you subscribe to.

### Creating an Instance

```js
const mcu = await STM32F1.create({ firmware: buf, chip: 'stm32f103c8' });
const mcu = await STM32F1.fromELF(buf, opts?);
const mcu = await STM32F1.fromBin(buf, opts?);
const mcu = await STM32F1.fromHex(hexText, opts?);
```

| Option | Default | Description |
|---|---|---|
| `firmware` | empty | `Uint8Array`, `ArrayBuffer`, or Intel HEX string |
| `chip` | `'stm32f103c8'` | Chip ID or `{ name, svd }` for SVD-based layout |
| `svd` | `null` | SVD XML string (overrides `chip`) |
| `flash_size` | `0x10000` | Flash region size (bytes) |
| `ram_size` | `0x5000` | SRAM size (bytes) |
| `ext_devices` | `{}` | External devices (see below) |

**ext_devices:**

```js
{
  spi_flash:     [{ peripheral: 'SPI1', jedec_id: 0xEF4016, data: new Uint8Array(65536) }],
  i2c_eeprom:    [{ peripheral: 'I2C1', address: 0x50, data: new Uint8Array(1024) }],
  i2c_oled:      [{ peripheral: 'I2C1', address: 0x3C, width: 128, height: 64 }],
  lcd:           [{ peripheral: 'SPI1', cs: 'PA8' }],
  touchscreen:   [{ peripheral: 'SPI1', cs: 'PA1', touch_detected_pin: 'PC5' }],
  software_spi:  [{ name: 'FLASH', cs: 'PB12', clk: 'PB13', miso: 'PB14', mosi: 'PB15' }],
  fsmc_bank:     [{ name: 'FSMC.BANK1', data: new Uint8Array(65536) }],
  sd_card:       [{ peripheral: 'SDIO', data: new Uint8Array(1048576) }],
}
```

### Execution

| Method | Returns | Description |
|---|---|---|
| `execute(cycles)` | `{ instCount, stopped }` | Run N instructions + auto-drain events |
| `step(cycles)` | `{ pc, instCount, stopped }` | Single batch + auto-drain events |
| `stop()` | `void` | Request stop of a running `execute()` loop |
| `close()` | `void` | Unsubscribe listeners + tear down |
| `reset()` | `Promise<STM32F1>` | Recreate emulator from scratch (reloads firmware) |

### GPIO

```js
const pin = mcu.gpio.pin('A', 5);  // or mcu.gpio.pin(0, 5)
```

| Method | Returns | Description |
|---|---|---|
| `pin.on('change', cb)` | `() => void` | Subscribe to output-level changes; returns unsubscribe |
| `pin.read()` | `0 \| 1` | Driven output level |
| `pin.readInput()` | `0 \| 1` | Input level |
| `pin.setInput(high)` | `void` | Drive external input (e.g. button press) |
| `pin.setAnalog(val)` | `void` | Set analog value (0–4095) |

### USART

| Property / Method | Description |
|---|---|
| `mcu.usart1` / `usart2` / `usart3` | USART wrappers |
| `usart.onData = (byte) => {}` | TX callback (MCU → host) |
| `usart.send(string \| number[])` | Inject bytes into MCU RX |
| `usart.output` | Accumulated TX string (getter) |

### SPI

| Property / Method | Description |
|---|---|
| `mcu.spi1` – `mcu.spi6` | SPI wrappers |
| `spi.onTransfer = (ch, tx, rx) => {}` | DR write callback |
| `spi.injectMiso([0xFF, ...])` | Queue MISO bytes for next transfer |

### I2C

| Property / Method | Description |
|---|---|
| `mcu.i2c1` / `i2c2` / `i2c3` | I2C wrappers |
| `i2c.onStart = (addr) => {}` | Start condition callback |
| `i2c.onWrite = (byte) => {}` | Byte write callback |
| `i2c.onRead = () => {}` | Read request callback |
| `i2c.onStop = () => {}` | Stop condition callback |
| `i2c.injectRx([0x55, ...])` | Queue RX bytes for next read |

### ADC

| Property / Method | Description |
|---|---|
| `mcu.adc1` / `adc2` / `adc3` | ADC wrappers (`mcu.adc[1..3]` too) |
| `adc.setVoltage(ch, mV)` | Drive target voltage 0..3300 mV into channel `ch` (VREF=3.3V) |
| `adc.setCode(ch, code)` | Drive raw 12-bit code 0..4095 (same routing: pins 0-15, internal 16-18, sim fallback) |

### TIM

| Property / Method | Description |
|---|---|
| `mcu.tim1` … `mcu.tim7` | Timer wrappers (`mcu.tim[1..7]` too) |
| `tim.duty(ch)` | Output duty 0..100 for channel `ch` (0-based), 0 unless CR1 CEN |
| `tim.frequency()` | Output rate in Hz from PSC/ARR + live RCC tree, 0 unless CR1 CEN |
| `tim.enabled()` | True while the counter runs (CR1 CEN) |

### Virtual-Peripheral Events

These callbacks fire on specific hardware events:

| Callback | Signature | Description |
|---|---|---|
| `onExtiEdge` | `(line) => void` | EXTI external interrupt edge detected |
| `onAdcDone` | `(adc, chan) => void` | ADC conversion complete |
| `onTimUpdate` | `(tim) => void` | Timer overflow (update event) |
| `onTimCapture` | `(tim, ch, value) => void` | TIM input capture |
| `onDacWrite` | `(chan, value) => void` | DAC output written |
| `onCrcResult` | `(value) => void` | CRC calculation result read |
| `onRtcAlarm` | `(alarm) => void` | RTC alarm triggered |
| `onWdogReset` | `(which) => void` | Watchdog reset requested (1=IWDG, 2=WWDG) |
| `onCanTx` | `(can, id, len, data[8]) => void` | CAN message transmitted |
| `onCanRx` | `(can, id, len, data[8]) => void` | CAN message received |
| `onFsmcAccess` | `(bank, offset, write, size, value) => void` | FSMC bus transaction |
| `onUsbIn` | `(ep, data) => void` | USB IN completion (device → host) |
| `onI2cAlert` | `(channel, asserted) => void` | SMBus SMBA drive edge (firmware CR1 ALERT) |
| `onHostTx` | `(ch, ep, setup, data) => void` | OTG host OUT/SETUP completion (MCU → wire) |
| `onHostRx` | `(ch, ep, len) => void` | OTG host IN token (answer via `otgHostFeedIn`) |
| `onItmByte` | `(port, byte) => void` | ITM stimulus port 0 printf byte |

### Display Framebuffers

```js
const oledFb = mcu._emu.i2cOledFb('I2C1', 0x3C);  // Uint8Array (page-major)
const lcdFb  = mcu._emu.lcdFb('SPI1');              // Uint8Array (128×64, 1B/pixel)
```

### DMA

Direct RM0008 channel access — DMA1 @ `0x40020000` (7 ch) and DMA2 @
`0x40020400` (5 ch) on every chip (builtin map and both SVDs share these
bases, so one surface covers all 8 chip variants + F105):

```js
mcu._emu.write32(0x20001000, 0xDEADBEEF);
mcu.dma1.setChannel(1, {
  par: 0x20001000, mar: 0x20002000, ndtr: 8,
  ccr: (1 << 14) | (1 << 7) | (1 << 6) | (1 << 1) | 1, // M2M+MINC+PINC+TCIE+EN
});
await mcu.execute(50_000);
mcu.dma1.isr() & 0x2;   // TCIF1 set
```

| Method | Returns | Description |
|---|---|---|
| `mcu.dma1` / `mcu.dma2` | `DMA` | Controller wrappers (`mcu.dma[1..2]` too) |
| `dma.isr()` | `number` | Raw ISR word (TCIF at `(N-1)*4+1`) |
| `dma.getCcr/getNdtr/getPar/getMar(ch)` | `number` | CCR/CNDTR/CPAR/CMAR (ch 1-based) |
| `dma.setChannel(ch, { ccr, ndtr, par, mar })` | `void` | Program a channel (EN=1 in CCR queues it) |
| `dma.clearFlags(mask)` | `void` | IFCR write-1-clears |
| `dma.pending()` | `boolean` | True while any transfer is queued |

Low-level `emu.*` equivalents (`createEmulator` directly):
`dmaIsr/dmaGetCcr/dmaGetNdtr/dmaGetPar/dmaGetMar/dmaSetChannel/
dmaClearFlags/dmaPending`, plus the raw queue/IRQ surface
`dmaQueueCount/dmaQueuePeek/dmaQueueAt/dmaPump/dmaTakeAbsorbed/
dmaAbsorb/dmaPush/dmaComplete/dmaCompleteMany/irqPending/irqNext/
irqReturn/irqFinish`. Full reference: `docs/STM32F1_API.md` ("DMA",
"Clocks, power, debug helpers").

### Clocks, Power, Debug Helpers

Previously reachable only via raw wasm or `periphRead`/`periphWrite`,
now first-class `emu.*` methods:

```js
const emu = mcu._emu;
emu.rccSysclkHz();        // decoded SYSCLK, Hz
emu.rccClocksHz();        // [sysclk, hclk, pclk1, pclk2], Hz
emu.rccMcoHz();           // MCO pin output, Hz (0 = off)
emu.rccFailHse();         // fail HSE (CSS: CSSF + NMI + HSI fallback)
emu.pwrSetSupplyMv(2800); // PVD rail, mV; returns PVDO (below-threshold)
emu.gpioSetSlew(4);       // GPIO output slew, instructions
emu.i2cOledWrites('I2C1'); // OLED byte-write counter
```

### Symbol Resolution

```js
mcu.setSymbols(mapText);              // load GNU ld .map text
console.log(mcu.resolveSymbol(pc));   // e.g. "main+0x1e" or null
```

---

## Low-Level API

The `createEmulator()` function returns a `Promise<BluepillEmulator>`.

```js
import { createEmulator } from 'stm32f1-emu';

const emu = await createEmulator({
  firmware: readFileSync('firmware.elf'),
  flash_size: 0x10000,
  ram_size: 0x5000,
  vector_table: 0x08000000,
  chip: 'stm32f103c8',
  ext_devices: {},
  verbose: false,
});
```

### Execution

| Method | Returns | Description |
|---|---|---|
| `run(maxInstructions?)` | `{ totalSteps, instCount, stopped }` | Run up to N instructions (0 = forever) |
| `step(maxBatch?)` | `{ pc, instCount, stopped }` | Run one batch (default 20K instructions) |
| `stop()` | `void` | Request stop |
| `close()` | `void` | Release the emulator instance (no-op teardown) |

### Registers & Memory

| Method | Returns | Description |
|---|---|---|
| `getRegisters()` | `{ R0..R12, SP, LR, PC, xPSR }` | All ARM registers |
| `getPc()` | `number` | Current program counter |
| `getSp()` | `number` | Current stack pointer |
| `setPc(pc)` | `void` | Set PC (auto-ORs with 1 for Thumb) |
| `read32(addr)` | `number` | Read 32-bit word from any address |
| `write32(addr, val)` | `void` | Write 32-bit word to any address |

### UART

| Method | Description |
|---|---|
| `getUartOutput()` | Accumulated USART1 TX output (string) |
| `uartRx(byte)` | Inject one byte into USART1 RX |
| `uartRxBytes([...])` | Inject multiple bytes |
| `uartRxAddr(addr, byte)` | Inject into a specific USART by base address |
| `rxPending()` | Number of unread bytes in UART RX buffer |

### GPIO

| Method | Description |
|---|---|
| `gpioReadOutput(port, pin)` | Read driven output level (port: 0=A, 1=B, 2=C) |
| `gpioReadInput(port, pin)` | Read input level |
| `gpioSetInput(port, pin, value)` | Drive external input |
| `gpioSetAnalog(port, pin, level)` | Set analog value (0–4095) |

### ADC / PWM / CAN

| Method | Description |
|---|---|
| `setSimAdc(value)` | Set simulated ADC value |
| `pwmDuty(addr, channel?)` | PWM duty (0–100) of a timer channel |
| `canInjectMessage(addr, tir, tdtr, tdlr, tdhr)` | Inject CAN message |

### Peripheral Bus

| Method | Description |
|---|---|
| `periphRead(addr, width?)` | Raw peripheral register read |
| `periphWrite(addr, width, value)` | Raw peripheral register write |

### Bus Watchers / Events

| Method | Returns | Description |
|---|---|---|
| `onPeriphWrite(fn)` | `() => void` | Subscribe to ALL peripheral writes; returns unsubscribe |
| `onPinChange(fn)` | `() => void` | Subscribe to chip-driven GPIO changes; returns unsubscribe |
| `drainEvents()` | `number[]` | Drain virtual-peripheral transaction events (flat i32 array) |
| `takePinEvents()` | `number[]` | Drain buffered pin-change events |

### Virtual Device Injection

| Method | Description |
|---|---|
| `spiInjectMiso(channel, bytes)` | Queue MISO bytes for a SPI channel |
| `i2cInjectRx(channel, bytes)` | Queue RX bytes for an I2C channel |
| `i2cInjectStart(channel, addr, isRead)` | Host START addressing this MCU as slave (false = NACK) |
| `i2cInjectWrite(channel, byte)` | Host data byte to the slave (false = NACK when not ready) |
| `i2cInjectRead(channel)` | Host read from the slave (-1 while TX DR empty = stretch) |
| `i2cInjectStop(channel)` | Host STOP to the slave |
| `i2cInjectAlert(channel)` | SMBus: peer pulled SMBA low → SR1 SMBALERT + ER IRQ |
| `usbInjectSetup(bytes8)` / `usbInjectOut(ep, bytes)` | Host SETUP/OUT into endpoints (NAK unless armed) |
| `addJsPeripheral(base, size, read, write)` | Register a custom peripheral on the bus |

### Symbol Resolution

| Method | Description |
|---|---|
| `setSymbols(list)` | Set symbol table `[{name, addr}]` |
| `resolveSymbol(addr)` | Resolve address → symbol name (e.g. `"main+0x1e"`) |
| `getSymbolCount()` | Number of loaded symbols |

---

## CLI Usage

```bash
# Run a raw binary
npx stm32f1-emu firmware.bin [max_instructions]

# Run with config (YAML)
npx stm32f1-emu --config=config.yaml

# Options
--regs              # Dump CPU registers at exit
--uart=0x40013800   # UART base address for stdin RX injection
--map=firmware.map  # Load symbol map for PC resolution
--verbose           # Print SP/PC at boot
--max=200000000     # Max instructions (default: 100M)
```

**Config YAML example:**

```yaml
flash: 0x08000000
ram: 0x20000000
regions:
  - start: 0x08000000
    file: firmware.hex
ext_devices:
  spi_flash:
    - peripheral: SPI1
      jedec_id: 0xEF4016
      data: flash.bin
  i2c_eeprom:
    - peripheral: I2C1
      address: 0x50
      data: eeprom.bin
```

---

## Firmware Formats

| Format | Description | How to Load |
|---|---|---|
| `.bin` | Raw binary (vector table at 0x08000000) | CLI, library, demo site |
| `.hex` | Intel HEX (Arduino/STM32duino output) | Auto-detected (starts with `:`) |
| `.elf` | ELF32 executable (segments + symbols) | Auto-detected by magic bytes |
| `.map` | GNU ld linker map (not executable) | Pair with `--map` flag for symbol names |

---

## WebSocket Bridge (headless Node + browser viewer)

```bash
# Start the server (runs the emulation loop, streams events over WebSocket)
node node_modules/stm32f1-emu/pkg/ws-server.mjs firmware.elf --port=8080

# Open the viewer in a browser
# http://localhost:8080/ws-viewer.html
```

The viewer renders a UART terminal, GPIO grid (click to toggle inputs), event log,
and FPS counter. The server streams all virtual-peripheral events as JSON.

---

## Development

```bash
# Rebuild Rust peripherals → WASM (pinned binaryen 132 from ~/.local/binaryen — never /tmp, the box wipes it)
PATH=~/.local/binaryen/binaryen-version_132/bin:$PATH \
RUSTFLAGS="--remap-path-prefix=$HOME=/build" \
wasm-pack build --target web --out-dir pkg

# Run tests
node tests/test_all.mjs              # 764 unit asserts
node tests/canary.mjs                # 39/39 firmware checks (~25s)
node tests/test_emulator_js.mjs      # browser run-loop path (200M, 39/39)
node tests/test_chips.mjs            # chip variants (IDCODE per chip + GD32 boot)
node tests/test_stm32f1_api.mjs      # high-level wrapper API
node tests/test_gdbstub.mjs          # GDB remote stub (35 checks, incl. Z2/Z3/Z4 watchpoints)
npx playwright test                  # browser tests (needs local server + Chromium)

# Run firmware directly
node pkg/cli.mjs firmware.elf
echo -n "AB" | node pkg/cli.mjs --config=config.yaml --max=200000000
```

---

## Supported Peripherals

GPIO (A–E) with electrical model, USART1–3 + UART4/5 (+LIN, HDSEL loopback,
IrDA/smartcard registers), SPI1–2 (+CRC, TI frame format), I2C1–2
(master + slave mode, 10-bit, PEC, SMBus ALERT), TIM1–7
(PWM, input capture, external triggers, slave modes, DMA burst + requests, BDTR/break), ADC1–3
(real conversion timing, RC sample-and-hold, DAC→ADC loopback, external triggers, dual mode),
DAC1–2, DMA1 (7ch) + DMA2 (5ch), CAN1+CAN2 (RX injection + filters, TTCM), RTC (alarm),
CRC, NVIC (priority dispatch + 64-IRQ budget), SysTick, SCB (deep sleep, SHPR
routing, fault escalation, ACTRL), EXTI, AFIO (pin remap), BKP (tamper), PWR (PVD), FLASH (WRP),
IWDG + WWDG (reset semantics, EWI), FSMC (NOR/NAND/PC-Card + ECC), SDIO (SDHC/MMC, CMD engine, DMA2 CH4), USB FS device (SOF engine,
double-buffered bulk, isochronous, enumeration events), USB OTG_FS device + host (F105 map),
DWT cycle counter + ITM stimulus port, SWD/JTAG debug slice (DP/MEM-AP/DHCSR/watchpoints,
GDB Z0/Z2/Z3/Z4), DBG IDCODE per chip.

---

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgements

- STMicroelectronics — CMSIS-SVD device files in `svd/` and the RM0008
  reference manual the models were verified against.
- [STM32duino](https://github.com/stm32duino/Arduino_Core_STM32) — the
  Arduino core the `tests/arduino_*` firmware sketches build on.
- [CoreMark](https://github.com/eembc/coremark) (EEMBC) — upstream 1.0
  sources in `tests/arduino_coremark/`, used as a known-answer CPU check.
- [Capstone](https://www.capstone-engine.org/) and
  [Unicorn](https://www.unicorn-engine.org/) — test-time only oracles for
  the decoder census and differential fuzzing (Unicorn was the former
  emulation backend, long since deleted); neither ships in the package.
- The Rust/WASM toolchain: `wasm-pack`, `wasm-bindgen`, Binaryen
  (`wasm-opt`), and the xPack GNU Arm toolchain used for bare-metal demos.

