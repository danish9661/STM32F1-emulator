# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased] — ADC/TIM observation hardening (hook-contract work)

### Fixed
- `AdcDone` event for ADC3 reported `adc=13` (the DMA stream id: ADC3 ->
  DMA2 ch5); it now reports the ADC number (`adc=3`), matching the
  documented `onAdcDone(adc, chan)` contract (`src/peripherals/adc.rs`
  `adc_num()`). ADC1/ADC2 numbering is unchanged.
- Single-byte I2C master-RX (`Wire.requestFrom(addr, 1)`, RM0008 N=1: NACK +
  STOP right after ADDR) returned a stale `0x00` and emitted no `I2cRead`
  event: the STOP handler parks the transfer in Idle with the byte held in
  RXNE before the firmware's DR read, skipping the queue/event arm, and the
  address-phase preload never consulted the inject queue (shifting pre-queued
  multi-byte reads by one as well). The DR-read tail now consults
  `i2c_take_rx` (falling back to the preloaded byte) and emits `I2cRead`,
  and the preload prefers the queued byte (`src/peripherals/i2c.rs`).
- Multi-byte I2C master-RX (`Wire.requestFrom(addr, 14)`, HAL
  `I2C_MasterReceive_BTF` tail) stalled with 2 bytes remaining and timed
  out, so `requestFrom` returned 0 (all `read()` -1) although read events
  flowed: the RXNE loop ends at count==3 with BUF off and counts 4/3/2
  complete purely through BTF, which the model never set in master-RX. The
  pipeline reload now arms BTF once <=3 bytes remain queued, and the
  ADDR-clear arms it for short host-served reads (N==1 excluded via ACK==0).
  The STOP tail also serves drain-style reads (HAL reads twice after STOP
  with no further clocks) with exactly one `I2cRead` per byte, and an
  N=1 tail no longer double-consumes a prefilled queue
  (`src/peripherals/i2c.rs` `rx_reload`, `src/system.rs` `i2c_rx_len`).
- JS-only I2C slaves (no engine-internal device at the address) NACKed even
  the address phase (AF), so purely virtual sensors could serve nothing. A
  non-empty inject queue is now a virtual host's claim: the address ACKs
  (ADDR like a real slave), read data comes from the queue (`0xFF` when
  momentarily dry), and master-TX bytes surface as `I2cWrite`. An empty
  queue still NACKs, preserving bus-scan and HAL error semantics
  (`src/peripherals/i2c.rs` virtual-claim arm; unread held bytes return to
  the queue front on START/STOP so back-to-back transfers stay FIFO-exact).
- JS-only I2C slaves starved across transfers: the claim was gated purely
  on queue depth at the address phase, so once a host drained its queue the
  next transfer NACKed, `onWrite` never fired, and the host could never
  re-arm -- pointer write + repeated START + `requestFrom(addr, 1)` returned
  `0x00` with zero `I2cRead` while longer bursts from the same session
  looked exact. The first queue-backed claim now registers the address
  (`virtual_addr`, sticky across START/STOP and drains, cleared only by SW
  reset / PE disable): a registered address keeps ACKing while dry, and only
  a never-served address NACKs. Like silicon -- a real slave does not
  un-address itself over an empty TX buffer (`src/peripherals/i2c.rs`).

### Added
- `i2c_clear_rx(channel)` wasm export (`src/lib.rs`, `src/system.rs`
  `i2c_clear_rx`, `pkg/emulator.js` `i2cClearRx` + `.d.ts`, `pkg/stm32f1.js`
  `I2C.clearRx()` + `.d.ts`): drop all queued injected RX bytes on an I2C
  channel. Reactive runners `clearRx()` then `injectRx(fresh)` at read-START
  (the pointer is already drained into the model by then), so stale
  leftovers from previous transactions never poison the front and every
  transaction is exact regardless of execute-batch timing. An empty queue
  still NACKs the address phase; in-flight DR-held bytes are untouched.
- `tim_chan_pin(timer, channel)` wasm export (`src/lib.rs`,
  `src/peripherals/mod.rs`, `pkg/emulator.js` + `.d.ts`): PWM output pin
  for a timer channel as packed `(port << 4 | pin)` with the live AFIO
  remap applied, or -1 when the timer/channel has no output pin. Read-only;
  no model state is touched.
- `TIM.pin(ch)` on the `STM32F1` wrapper (`pkg/stm32f1.js` + `.d.ts`):
  `{ port: 'A'..'D', pin }` for the channel, or `null`. For wiring PWM
  outputs (servo/LED/buzzer) to the right board pin without duplicating
  the remap table.
- `_emu: BluepillEmulator` on the `STM32F1` wrapper (`pkg/stm32f1.d.ts`):
  the documented low-level escape hatch (takeFault / memRead32 /
  periphRead / irqNext / dmaPump / rccClocksHz / swd* / ...) was reachable
  at runtime and in the API docs but missing from the types, so TypeScript
  users could neither discover nor touch it. Mutable (`_reload`
  reassigns it); type was already imported.

### Tests
- `tests/test_all.mjs`: ADC3 `AdcDone` triple carries `adc=3, chan=1`;
  `tim_chan_pin` defaults (TIM1..4), basic-timer/OOB/unknown `-1`, and
  live TIM3 full-remap PA6 -> PC6 -> restore.
- `tests/test_stm32f1_api.mjs` 23 -> 39: TIM all-channel duty, TIM3 50 Hz
  servo shape (freq + 7% pulse), `TIM.pin()` incl. null cases, ADC2/ADC3
  inject end-to-end (shared pin wire, `onAdcDone` numbers).
- `tests/test_i2c_single_byte.mjs` 7/7 -> 93/93 (new, wired into CI):
  1-byte master-RX returns the queued byte + exactly one `I2cRead`
  (pre-queued and late onStart-style injects), 2-byte control byte-exact
  with two `I2cRead`s; plus the HAL-IT EV dispatch for N=2 (POS) and N=14
  (BTF tail) — byte-exact with exact `I2cRead` counts both with an ACK-sink
  device and purely JS-served — back-to-back 1-then-14 on one shared
  prefill, AF-NACK preservation for unclaimed addresses, and `clearRx`:
  32 stale + clear + 2 fresh reads exact (stale front proven to poison
  without the clear), cleared queue NACKs, facade (`i2cClearRx` /
  `I2C.clearRx`) drives the same queue.
- `tests/test_i2c_single_byte.mjs` 93 -> 94: the cleared-queue assertion
  now encodes the sticky host registration (registered address still ACKs
  after clear; a never-registered address still NACKs, which is where the
  bus-scan rationale lives now).
- `tests/test_i2c_js_slave.mjs` 17/17 (new, wired into CI right after
  `test_i2c_single_byte`): pointer write + `endTransmission(false)` +
  repeated START + `requestFrom(0x68, 1|6)` over real HAL code against a
  purely JS-served slave (new `tests/arduino_i2c_js_slave` firmware, ELF
  shipped force-added at `site/arduino_i2c_js_slave.elf`) — READ1 returns
  the exact queued byte, READ6 is FIFO byte-exact, one `I2cRead` per
  requested byte; plus the register-level pin-down (registered address
  ACKs after a drained queue, per-address NACK preserved, SW reset drops
  the registration).

## [3.3.0] — 2026-10-05 — ADC + TIM wrapper classes, per-batch event ordering

### Added
- `ADC` wrapper class (`mcu.adc1..3`, also `mcu.adc[1..3]`):
  `setVoltage(ch, mV)` (0..3300 at VREF=3.3V) / `setCode(ch, code)` — ch 0-15
  route to the mapped GPIO pin analog wire (the exact source the converter
  samples, through the RC sample-and-hold), 16-18 use the internal override,
  higher channels fall back to the global sim value. Completion observed via
  the existing `onAdcDone`. Reference: `docs/STM32F1_API.md` ("ADC inject"),
  README, Guide §8.5.
- `TIM` wrapper class (`mcu.tim1..7`, also `mcu.tim[1..7]`): `duty(ch)`
  (0-100 from CCR/ARR) + `frequency()` (PSC/ARR + live RCC tree incl. the APB
  x2 rule), both 0 unless CR1 CEN. Reference: `docs/STM32F1_API.md`
  ("TIM / PWM observe"), README, Guide §8.5.
- Emulator batch introspection (`pkg/emulator.js` + `.d.ts`): `getBatchSize()`
  (configured batch size, default 20000) + `getInstCount()` (cumulative
  retired-instruction counter).

### Fixed
- GPIO/transfer event ordering (`stm32f1-emu.md` optional improvement):
  `STM32F1.execute()` now runs long runs as `getBatchSize()`-chunked `step()`s
  with the transfer-event drain after every batch, so each batch's GPIO pin
  changes land before that batch's transfer callbacks — a CS sampled inside
  `onTransfer` observes the level as of that transfer, not the end of the run.
  Transfer/edge counts are unchanged (proven bit-identical on both drain
  paths); `execute(0/neg)` keeps legacy run()-once semantics; the return shape
  (`{totalSteps, instCount, stopped}`) is unchanged.
- `STM32F1` reload/reset now also clears the accumulated per-USART TX buffers
  (previously pin listeners only), so no wrapper-level state survives a reset.

### Tests
- `tests/test_stm32f1_api.mjs` 23/23 (was 9): ADC inject end-to-end
  (1650 mV → DR=2048 + EOC + `onAdcDone`), TIM observe (duty 25 / live-tree
  9 kHz + `onTimUpdate`), reset-clears-buffers, per-step `instCount`.
- New `tests/test_stm32f1_ordering.mjs` 9/9 (wired into CI): register-driven
  CS-freshness with zero instructions retired, plus a firmware-driven
  differential (showcase LCD paint, CS PA8) — the per-batch path observes
  selected-CS mid-run where the legacy drain-once path saw only the end
  state, with transfer/edge counts bit-identical (16396 / 5).
- `tests/test_all.mjs` 772/772 (no model changes in this release).

## [3.2.0] — 2026-09-26 — DMA + clocks/power/debug JS surface, watchdog proofs, repo rename

### Added
- DMA channel surface (`pkg/emulator.js` + `pkg/stm32f1.js` `DMA` class):
  `dmaIsr/dmaGetCcr/dmaGetNdtr/dmaGetPar/dmaGetMar/dmaSetChannel/
  dmaClearFlags/dmaPending` (1-based channels, DMA1@0x40020000 7ch /
  DMA2@0x40020400 5ch — shared by the builtin map and both SVDs, so all
  8 chip variants + F105 work); raw queue/IRQ surface (`dmaQueueCount/
  dmaQueuePeek/dmaQueueAt/dmaPump/dmaTakeAbsorbed/dmaAbsorb/dmaPush/
  dmaComplete/dmaCompleteMany/irqPending/irqNext/irqReturn/irqFinish`);
  `mcu.dma1/dma2` (`mcu.dma[1..2]`) wrappers. Full reference in
  `docs/STM32F1_API.md` ("DMA", "Clocks, power, debug helpers"),
  `docs/USAGE.md` method list, README "DMA" section.
- Clocks/power/debug passthroughs (previously raw-wasm-only):
  `rccSysclkHz/rccClocksHz/rccMcoHz/rccFailHse/pwrSetSupplyMv/
  gpioSetSlew/i2cOledWrites` (+ `.d.ts`); GPIO wrapper ports D–G
  (HD/CL chips); `fsmc_bank` accepts `{ name, size }` blank images;
  `Emulator.d.ts`/`stm32f1.d.ts` cover all new methods (incl. the
  previously missing `sd_card`/`onUsbIn`/`onItmByte` types).

### Fixed
- DMA CCR IRQ bits decoded from 4/3/2 — correct per RM0008/SVD is
  1/2/3 (`TCIE`/`HTIE`/`TEIE`); the old code fired DMA IRQs on `DIR=1`
  and missed real `TCIE`.
- `usart_probe` config branch referenced undefined `PERIPH_ADDR`
  (`ReferenceError` on any config using it) — replaced with a
  USART-name/address map (`cli.mjs` + `bench_merged.mjs`).

### Tests
- `tests/test_all.mjs` 772/772: IWDG deep-sleep proof (fuse fires
  through STOP while TIM2 stays frozen), WWDG window rule (early
  refresh `T>W` requests reset + in-window/WDGA-off/`W=0` negatives),
  NVIC EOI pairings (every raw take now returns).
- Census 16-bit 0 gaps / 32-bit gate exit 0; fuzz seeds 1+4 × 200
  cases, 0 divergences.

### Changed
- Repo renamed `STM32-Bluepill-emu` → `STM32F1-emulator`
  (`github.com/danish9661/STM32F1-emulator`): all tracked references
  updated (package metadata, README badges/demo links, site webui
  meta/nav/footer, sitemap, CLI bug-report URL, gh-pages tests).
  `bluepill-emu` CLI alias kept; `npx` examples now use `stm32f1-emu`.

## [3.1.0] — 2026-09-12 — F105 USB OTG_FS device/host mode + Maple DFU bootloader + SWD/JTAG debug slice

### Added
- USB OTG_FS device model (`src/peripherals/otg.rs`, IRQ 67, F105 map
  only): Synopsys core registers, GRXSTSP status queue, EP0-3 FIFOs,
  three-level interrupt masking into IEPINT/OEPINT, suspend/resume,
  `otg_bus_reset` / `otg_detach` / `otg_inject_setup/out` (+JS + `.d.ts`)
- Bare-metal OTG CDC demo (`tests/otg_cdc/`, xpack-gcc + custom linker
  script, ships `site/otg_cdc.elf`): full host enumeration + EP1 bulk
  echo through real machine code (`tests/test_otg_cdc.mjs` 23/23)
- `tests/test_otg.mjs` 119/119 (core/reset/FIFO/IRQ/STALL/detach/PWRDWN/
  DAD-filter/host channels + attach-survives-CSFTRST); device + host
  wired into CI
- `otg_cdc` demo-page preset (F105 + EP1 echo, host-style retries +
  NAK-driven resends shared with the FS enumerator)
- USB OTG_FS host mode (`src/peripherals/otg.rs`): 8 channels
  (HCCHAR/HCSPLT/HCINT/HCINTMSK/HCTSIZ, CHENA-edge arming, CHDIS halt),
  HCFG/HFIR/HFNUM/HPTXSTS/HAINT/HAINTMSK/HPRT, RXFIFO + GRXSTSP shared
  with device mode, `HostTx`/`HostRx` events, `otg_host_feed_in` /
  `otg_host_attach` (+JS + `.d.ts`)
- Bare-metal OTG HCD demo (`tests/otg_host/`, xpack-gcc + custom linker
  script, ships `site/otg_host.elf`): control enumeration + bulk echo
  through real machine code (`tests/test_otg_host.mjs` 5/5, CI)
- `otg_host` demo-page preset (F105 + scripted virtual device +
  live HCD trace; worker defers pre-init attach/feed across the
  `await createEmulator` message interleave)
- Maple-style USB DFU bootloader demo (`tests/arduino_dfu/`, Arduino
  sketch on `maple_mini`, ships `site/arduino_dfu.elf`): EP0 DFU class
  (DNLOAD/UPLOAD/GETSTATUS/GETSTATE/CLRSTATUS/ABORT, SetAddressPointer,
  manifest) with real flash unlock/program sequence; downloads stage to
  a RAM buffer resolved from ELF symbols (guest flash stores drop) and
  verify byte-exact (`tests/test_dfu.mjs` 51/51, CI)
- `dfu` demo-page preset (Maple Mini + scripted host download of a
  .bin file or default pattern, live progress + manifest status)
- ARM SWD/JTAG debug-port slice (`src/peripherals/swd.rs`,
  transaction-level, no pin modeling): SWD DPv1 + MEM-AP (CSW/TAR/DRW,
  TAR auto-inc, RDBUFF) + DHCSR/DCRSR/DCRDR/DEMCR at real addresses
  (both maps, no bus window) + 4 data watchpoints (halt-after-access) +
  minimal JTAG TAP sharing the DP file (`swd_*`/`jtag*` exports + `.d.ts`;
  hot path is one mirror branch, 200M still ~2.8s)
- GDB RSP data watchpoints (Z2/Z3/Z4 → `T05watch:/rwatch:/awatch:`,
  `c` resumes a halt, `s` steps past one; `tests/test_gdbstub.mjs`
  17 → 35/35 incl. live strb/ldrb snippets, proven with real
  arm-none-eabi-gdb 15: Old 0 → New 170 stop after the store)

### Fixed
- CSFTRST preserves a physically attached device (silicon keeps the
  PHY): a pre-boot attach previously booted into an E0 "no device"
  spin with no recovery
- GDB RSP register numbers are hex (`Pf` = PC): a decimal parse silently
  dropped real-client `set $pc`; `G` (write-all-regs) implemented, any
  `Hc`/`Hg` selection accepted on the single thread

## [3.0.1] — 2026-09-11 — real-stack USB enumeration

### Fixed
- USB BTABLE stride was 8 APB bytes/endpoint, silicon is 16 (DESC0
  ADDR/CNT @ +0/+4, DESC1 @ +8/+12; `PMA_ACCESS = 2` spread data) —
  host-to-device packets landed where no firmware ever looks
- PMA window is 1024 B, model had 512 — buffers at PMA word ≥ 128
  (e.g. Arduino CDC-IN @ word 288) were silently dropped
- SETUP is always ACKed on F1, even while NAK (the ST stack never re-arms
  RX after status-IN); enumeration died right after SET_ADDRESS
- SOF frames are bus activity: transfer-idle auto-suspend wedged
  enumeration (`dev_state` stuck SUSPENDED → SET_CONFIG CtlError);
  suspend is now FSUSP-forced only
- FRES release is not a bus reset (ISTR RESET means SE0 on the wire):
  the page enumerator now sends a real bus reset first (also fixes a
  pre-boot SETUP race that wedged enumeration permanently)
- CNTR FSUSP is bit 3, not bit 1 (bit 1 is PDWN) — model and tests
  shared the off-by-one, which masked PDWN gating entirely

### Added
- Real-stack USB proof: `tests/arduino_usb_serial/` (STM32duino USBSerial
  CDC-ACM) fully enumerates against a scripted host — descriptors,
  address, config, line coding/state, banner + bulk echo byte-exact
  (`tests/test_usb_serial.mjs`, 11/11, wired into CI)
- `usb_serial` demo-page preset (real Arduino stack, EP1-OUT/EP2-IN/EP3-CMD)
  with host-side enumeration retries, bus-reset flow, and stream-tail echo
  matching (the sketch echoes byte-by-byte); `usb_cdc` enumerator shared
- USB depth, no open gaps: isochronous no-STALL + HP-vector (19) CTR
  routing, DADDR hardware address filtering (optional `addr` on injects),
  PDWN macro gating, detach API (`usbDetach()`; reset reattaches),
  FNR RXDP follows attach state

## [3.0.0] — 2026-09-10 — multi-board demos, bench UI, protocol gaps

### Added
- SPI TI frame format (CR2 FRF decoded; CPOL/CPHA don't-care, identical shift data)
- SMBus ALERT: SR1 SMBALERT via `i2c_inject_alert` (write-0-clears, ER IRQ
  via ITERREN) + CR1 ALERT drive edges as `I2cAlert` bus events
  (`onI2cAlert`, flat discriminant 19; `i2cInjectAlert` + `.d.ts`)
- USART: IrDA IREN/IRLP stored, smartcard SCEN/NACK/GTPR stored
- Docs as website (`site/doc.html` viewer + `site/sync-docs.mjs` + CI drift guard)
- Multi-board demo family: per-board rig SVG artwork (Blue Pill, GD32,
  Maple Mini, Nucleo-F103RB, F103RC, F105), chip-filtered preset menu
  (board-only demos hide on other chips, picking one auto-switches),
  UART input box follows the board's native Serial (USART2 on Nucleo/RC)
- 12 board firmwares (echo / 7-peripheral showcase / RTC clock × Blue Pill,
  Maple Mini, Nucleo-F103RB, Generic F103RC): LED_BUILTIN + board banner +
  native Serial port per target
- Bench UI remake (console/rig deck, LCD instruments, serial monitor),
  docs/viewer/about theme + mobile pass, SEO (sitemap, per-doc
  canonical/OG/JSON-LD, screenshots gallery, arch flowcharts)

### Fixed
- USART HDSEL half-duplex loopback was on the wrong CR3 bit (bit 2/IRLP
  instead of bit 3) — model, unit test AND firmware shared the off-by-one
  (same class as the RTC CRH swap); firmware rebuilt (39/39)
- Showcase font drew transposed (mirrored OLED/LCD text) — column-major rewrite
- LCD device ate pixel 0 (`0xFB` queued as arg) and stored post-wrap `0xFC`
  in `fb[0]` — framing rewrite (resync-safe, saturating cursor) + unit asserts
- 7-seg latch stuck at `0000`: CS-level gating can't work with batched
  drains (events flush before taps); decode now keys on the paint protocol
  (`0xFC` → next 4 bytes), verified live counting with SEC

## [2.1.0] — 2026-09-09 — chips, GDB stub, depth + demos

### Added
- Chip variants without SVD (`pkg/emulator.js` CHIPS table + `chipInfo()`):
  stm32f103cb, maple_mini, nucleo_f103rb, stm32f103rc (256K/48K),
  gd32f103c8/cb/rb (DBGMCU IDCODE 0x2BA01477); new `set_dbg_idcode`
  export + read-only `DBGMCU_IDCODE @ 0xE0042000`; board Arduino-pin
  aliases (`site/board_pins.json`) shown in the page GPIO grid;
  live chip readout in the stats bar; `docs/BOARDS.md` support matrix
- GDB RSP stub (`pkg/gdbstub.mjs`, `stm32f1-emu/gdb`): registers, memory,
  BKPT breakpoints (restore/step/reinsert dance), step/continue, target.xml
  over TCP (`target remote :1234`); `tests/test_gdbstub.mjs` 16/16
- I2C slave mode + host inject API (`i2cInjectStart/Write/Read/Stop`),
  10-bit addressing, `tests/arduino_i2c_slave` (Wire @ 0x42) + page host card
- USB FS depth: SOF engine, suspend/resume, double-buffered bulk,
  isochronous transfers; CDC-ACM demo + page USB host (live enumeration)
- TIM DMA burst (DCR/DMAR window) + PWM-wave demo; CAN TX IRQ edge trigger;
  SCB ACTRL store; ADC temp nominal fix (0x6EE)
- Demos: usb_cdc, pwm_wave, i2c_slave, mini_rtos (preemptive PendSV kernel),
  sd_logger (SDIO+ADC+RTC); page presets + browser coverage for all
- Dual-CAN demo (`tests/arduino_can_dual`, CAN1+CAN2 loopback on the F105
  SVD map) + preset + browser + CI
- GDB stub proven against real arm-none-eabi-gdb 15 (connect/break/
  continue/stepi/detach green; `tests/gdb_live_session.sh` dev-only):
  offset/length-aware `qXfer`, no `qXfer` advertisement (GDB 15 rejects
  minimal target.xml; its default ARM layout matches)
- Per-board demo firmware (`tests/arduino_board_demo`, one sketch × 4 FQBNs:
  Blue Pill / Maple Mini / Nucleo-F103RB / Generic F103RC, shipped ELFs +
  page presets setting chip+ELF together); DFU-layout offset-vector boot
  proven (`vector_table: 0x08005000`); self-contained offset test in
  `tests/test_chips.mjs`
- Emulator surface for debuggers: `memWriteBytes()`, `takeFault()`,
  `setReg()` (+ `rustcpu_set_reg` / `rustcpu_mem_write_raw` exports)

### Fixed
- SysTick rate: debt drain lost after the native cutover (re-pend exactly
  one per return) + phase loss (`trigger += ticks*period`); millis exact
- Nested F1/F9 returns unstacked from stale banks instead of live r13
  (phantom reboots under deep nesting); proven by 4-deep canary test
- Inline dispatch routes through the shared 64-IRQ budget; lazy paths
  re-sync live PRIMASK (no delivery into `noInterrupts` windows)
- USB CDC firmware CTR-preserve rule (multi-packet IN); C++-mangled
  `PendSV_Handler` never installed in the RTOS demo; TIM7 absent on C8
- Page worker inherited 64K/20K sizes instead of the chip table (wedged
  F103RC in the browser while headless passed); worker + main path both
  inherit sizes now

### Tests
- 537 unit + 49 CPU tests, 39/39 firmware, chip/offset-boot/gdb suites,
  browser 19/19 local; `docs/COVERAGE.md` (40 Full, USB rows closed)

## [2.0.0] — 2026-09-04 — native Rust CPU replaces Unicorn
- CPU backend is now the vendored pure-Rust ARMv7-M interpreter
  (`src/cpu/`): Unicorn binaries, mem hooks, `mrs`/`i2c_init` patches, the
  SVC mirror and the `--cpu`/`cpu`/`?cpu` options are gone (single backend)
- ~3.5x faster headless (periph39 200M: ~9.5s → ~2.7s, 72-75 MIPS),
  ~96 MIPS in headless Chromium; exact instruction accounting
### Breaking
- Unicorn removed: `unicorn_arm.cjs/.js` gone (~1.6MB), no `--cpu`/`cpu`/`?cpu`
  options, no `mrs`/`i2c_init` patches, no mem hooks, no SVC mirror
- `BluepillEmulator` drops `uc`, `Module`, `tick()`, `stepBatch()`,
  `hasPendingInterrupt()`, `getNextPendingInterrupt()`, `setIntrMasks()`;
  adds `dmaPending()`, `usbInjectSetup/Out()`, `memRead32()`, `batch_size` opt
  (types in `pkg/emulator.d.ts` rewritten to match)
- `tests/test_unicorn.cjs`, `test_svd_run.cjs` deleted; `test_esm.mjs` now
  smokes the ESM glue + native backend API; new `tests/test_bus_tap.mjs`
- New: `src/peripherals/dwt.rs` (DWT CYCCNT for `micros()`/I2C recovery),
  native firmware gallery + inline-IRQ/WFI/PSP core tests, bus-tap parity
  test (`tests/test_bus_tap.mjs`), in-page 7-seg decode test

## [1.4.0] — 2026-09-03

### Added
- MMC/eMMC identification path in SDIO: CMD1 SEND_OP_COND (no APP latch, busy-first R3 with sector-access bit), EXT_CSD register read via CMD8 (revision, card type, sector count from image), erase commands CMD32/33/35/36/38 (fill 0xFF); card mode latches on whichever OP_COND completes first so real SD-then-MMC probe order works
- Coverage audit (`docs/COVERAGE.md`): 67-block SVD census (38 Full, 1 Partial, 0 stubs)

### Tests
- 18 new MMC unit tests (372/372 total): CMD1 init without APP latch, pre-init CMD8 echo preserved, EXT_CSD exact bytes, shared CID/RCA/block path, erase + 0xFF read-back, no-card CMD1 timeout

## [1.3.0] — 2026-09-03

### Added
- USB FS device peripheral (`src/peripherals/usb.rs`): EP0-7R with hardware toggle semantics, CNTR masks, ISTR (W0C flags; CTR/DIR/EP_ID derived), DADDR, BTABLE, 512 B packet memory with byte-exact access, RESET on FRES release + IRQ20, SETUP/OUT injection (`usb_inject_setup/out`, NAK unless armed, DTOG sequencing), IN completion as `UsbIn` event (discriminant 18) + `onUsbIn` in `STM32F1` + `usbInjectSetup/Out` on the emulator
- RCC clock query API (`rcc_clocks()` trait method, `rcc_sysclk_hz()` export): decoded SYSCLK/HCLK/PCLK1/PCLK2 from CFGR (HSE assumed 8 MHz); timing stays instruction-budget based by decision
- PVD voltage detector (fixed-supply model → EXTI line 16) via new `exti_line_edge()` fan-out; BKP tamper pin (TPE/TPAL on PC13 → IRQ2, DR clear); RTC second/overflow IRQs + CRL flags
- Coverage audit (`docs/COVERAGE.md`): 67-block SVD census vs the emulator (38 Full, 1 Partial, 0 stubs)

### Fixed
- Mirrored RTC CRH bit order (code and test firmware both had ALRIE/SECIE swapped vs RM0008); CRH mask widened so OWIE is writable; test firmware fixed (`CRH = 2`, handler clears ALRF) and rebuilt
- BKP register map corrected to RM0008 (DR1-10 @ 0x04-0x28, RTCCR @ 0x2C, CR @ 0x30, CSR @ 0x34); stale RTCCR unit test fixed
- PVD PVDO bit made read-only

### Tests
- 77 new unit tests (354/354 total): WWDG EWI, PVD edges, RTC second/overflow + flags, RCC decode, tamper, USB end-to-end control + bulk flows

## [1.2.0] — 2026-09-03

### Added
- SDIO host peripheral (`src/peripherals/sdio.rs`): SDHC card model at 0x40018000, IRQ 49 — CMD0/2/3/6/7/8/9/12/13/16/17/18/24/25/55 + ACMD41 (busy-first init), 32-word FIFO, DATAEND/DBCKEND/CMDREND/CMDSENT/CTIMEOUT with MASK-gated IRQ, DCOUNT/FIFOCNT, DMA2 CH4 requests
- SD card ext device (`src/ext_devices/sd_card.rs`, `add_sd_card('SDIO', data)`): CID/CSD/OCR/RCA derived, CSD capacity from image size; `ext_devices.sd_card` in library + `sd_card:` (file/size) in CLI config

### Fixed
- DMA2 completion routing: completion streams/IRQ tables were sized 8 with local indices, so DMA1 CH4 and DMA2 CH4 both claimed stream 3 and DMA1's tick drained DMA2's bits (DMA2 ISR/CNDTR never completed). Streams are now global (DMA1 0-6, DMA2 7-11) with masked per-DMA takes; JS pump untouched

### Tests
- 41 new SDIO unit tests (277/277 total): init sequence, block R/W + read-back, IRQ49, DMA2 pump absorb of real image bytes + TCIF4/CNDTR clear, no-card timeouts, F103-SVD registration

## [1.1.0] — 2026-09-03

### Performance
- Poll-aware batch shrinking — 8+ consecutive reads of one peripheral address shrink the batch to 5K (batch-boundary flags land sooner), with backoff for external waits; ~4% on periph39 (`pkg/emulator.js`, `pkg/cli.mjs`, `POLL_SHRINK=0` disables)
- CAN-autopilot flag resolved from ELF symbols instead of a hardcoded address that went stale (`canRxArmed` moved; the stale address cost a 3M-iteration spin storm per run): emulator.js 200M 12.45s → 8.18s, browser 9.2 → 21.8 MIPS

### Added
- `dmaPending()` emulator accessor (mirrors the CLI `dmaBusy` UART gate)
- Browser speed benchmark (`tests/test_browser_speed.mjs`, wired into Playwright)
- Worker sends a GPIO snapshot per frame so the page grid renders on the worker path (previously dark); chip name in worker-ready log

### Fixed
- Browser CI suite: GPIO-grid test polls instead of fixed sleep; F105 chip test expects the worker log line
- `test_emulator_js.mjs` autopilot granularity 10M → 1M chunks

## [0.1.0] — 2026-08-22

### Added
- CLI `--help` flag with full usage documentation
- CLI `--verbose` mode for peripheral read/write tracing (debugging)
- Improved error messages for firmware load failures, config parse errors, and invalid vector tables
- CHANGELOG.md

### Fixed
- Better error diagnostics when firmware is missing, empty, or has wrong format
- Clearer messages for invalid SP/PC in vector table (wrong memory layout, non-Thumb ELF)

## [0.1.0-beta] — 2026-08-20

### Performance
- Bus::get temporal-locality cache — 99% hit rate on sequential peripheral access
- NVIC pending scan: iterate only set bits via `trailing_zeros` instead of scanning all 111 IRQs
- Trigger lookups (`exti_port_for_line`, `afio_remap_status`, etc.) converted from linear scan to cached `bus.get()`

### Added
- Pin-activity monitor on the Blue Pill board SVG — glows pins amber on level changes
- WS2812 LED strip demo (SPI1 DMA, 800kHz strip decode live in browser)
- 236 unit tests (from 224)
- 39/39 firmware checks (SVC + PendSV delivery)

### Fixed
- DMA ISR flag layout (off-by-one channel mapping)
- DMA direction inverted vs CMSIS (DIR bits mapped backwards)
- DMA pushes now fire JS write watchers (page decoders see DMA traffic)

## [0.1.0-alpha.3] — 2026-08-14

### Performance
- Closed-form timer advance — step_batch 1409ms → 11ms (124×)
- Batch register transport in IRQ dispatch — 17 crossings → 2 per IRQ
- Hookless instruction counting — 20% runtime reduction
- instCount as plain number (not BigInt) — 19% faster
- Batch size reduced 100K → 20K for lower interrupt latency

### Added
- Interrupt dispatch policy in Rust (src/interrupts.rs) — 64-IRQ budget, SVC frame mirror
- xPSR restore from stacked frame (required for cmp/beq across batch boundaries)
- Rust-side DMA pump with plan-based execution
- `finish_interrupt()` — single Rust crossing for ISR return

### Fixed
- xPSR restore dropped during frame-restore unification
- SysTick debt drain — multi-period elapsed delivered only one tick

## [0.1.0-alpha.2] — 2026-08-11

### Added
- Real GPIO electrical model (pull-up/down, floating, open-drain, slew)
- Real ADC conversion state machine (timing, channels, DMA, AWD)
- DAC→ADC loopback + ADC external triggers
- Full FSMC (7 NOR banks, NAND, PC-Card)
- Sleep state timing (SLEEPDEEP → frozen peripherals)
- Exceptions: SVC, PendSV, faults (BusFault, UsageFault, HardFault)
- reset_ext_devices() — prevents stale devices across emulator instances
- Multi-chip support: STM32F105xx SVD

### Fixed
- CAN MCR write mask (ABOM bit was silently dropped)
- DMA1 address corrected (0x40006000 → 0x40020000)
- Hardcoded peripheral table aligned with real STM32F103 addresses

## [0.1.0-alpha.1] — 2026-08-06

### Added
- Initial release: STM32F103C8 (Blue Pill) full-system emulation
- Unicorn ARM Cortex-M3 CPU (TCG JIT)
- Rust peripherals (GPIO, USART, TIM, SPI, I2C, DMA, RTC, CRC, CAN, NVIC, EXTI, ADC, DAC, etc.)
- WASM output for browser and Node.js
- Arduino firmware compatibility (24-peripheral test sketch, 37 checks)
- Intel HEX, ELF, and raw binary firmware loading
- SVD-based peripheral register map generation
- CLI with config YAML support
- Browser demo with interactive board SVG
