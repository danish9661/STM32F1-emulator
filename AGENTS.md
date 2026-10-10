# STM32 Bluepill WASM Emulation — Context File

## Project Overview
Full-system emulation of an STM32F103C8 (Bluepill) microcontroller running real Arduino firmware. One WASM module holds the whole machine:
1. **Native Rust CPU** (`src/cpu/`) — ARM Cortex-M3 Thumb-2 interpreter + guest RAM (`FlatMemory`), zero JS crossings per instruction
2. **Rust Peripherals** WASM (`pkg/stm32_bluepill_wasm_bg.wasm`) — GPIO, USART, TIM, SPI, I2C, DMA, RTC, CRC, CAN, NVIC, EXTI, ADC, DAC, FLASH, PWR, BKP, IWDG, WWDG, etc.
(Unicorn TCG was the CPU before 2026-09; see `docs/PATH_B.md`.)

> **Staging rule (CI incident 2026-08-09):** always `git add -A` or stage BOTH `pkg/` and `site/` together. Commit `7040bd0` staged only `site/` (fresh `pkg/emulator.js` stayed uncommitted at 100K batches) — CI's `cmp pkg/emulator.js site/emulator.js` guard failed on the next commit and caught it. Local working trees mask this; fresh checkouts don't.

> **SVD vs hardcoded layout (FIXED 2026-08-11):** both maps now agree on real STM32F103 addresses (DMA1@0x40020000, DMA2@0x40020400, CAN1@0x40006400) — the hardcoded `init()` board no longer puts DMA1 at 0x40006000, so real-address firmware passes under EITHER path. `from_svd()` also auto-registers the ARM core peripherals (NVIC/SysTick/SCB at their fixed 0xE000Exxx addresses) when an SVD omits them (STM32F105xx.svd has no SCB/SysTick — without the fallback, millis()/SysTick and PendSV silently break).

## Architecture & Emulation Loop
```
┌─────────────────────────── JS (pkg/cli.mjs) ─────────────────────────┐
│                                                                      │
│  EXACT instruction counting — rustcpu_run(batch) returns executed   │
│  instructions. No mem hooks: peripheral writes are recorded in-Rust │
│  for onPeriphWrite watchers; DMA pumps against Rust RAM, zero JS.   │
│                                                                      │
│  Loop (each iteration = 1 batch):                                    │
│    1. pump stdin → uart_rx_byte()                                    │
│    2. rustcpu_dma_pump()      ← plan build + exec against Rust RAM  │
│    3. rustcpu_run(maxBatch)   ← run one batch, exact count back     │
│    4. step_batch(count)       ← Rust ticks peripherals              │
│       - status==1 → watchdog reset requested → stop                 │
│    5. rustcpu_dma_pump()                                             │
│    6. rustcpu_dispatch()      ← up to 64 IRQs per batch (intr_next)  │
│    7. is_watchdog_reset_requested() check                           │
└──────────────────────────────────────────────────────────────────────┘
```

### Performance
- ~80M IPS real-world, native CPU (periph39 200M in ~2.5s; lighter firmware 118–140 headless; browser periph39 ~117–119 MIPS) WITH full MPU enforcement live on every access — the off-state fast path (plain-static `MPU_ON` mirror + cold-outlined slow/periph arms + raw fetch, see docs/CPU.md "Memory protection") holds the cost to ~5% over gates-compiled-out (2.6s). Lesson: ~1B gate evals/run make ANY per-access call shape cost ~30% in V8 (measured 2.6→3.9s across method-call, inlined-check, Cell-field, atomic-mirror and cold_path variants); only zero-call + small-hot-skeleton recovered it (3.9→2.8s). (Fusion rounds v1–v4 then cut dispatch: periph39 2.8s → 2.5s; see CHANGELOG.)
- **step_batch ticks once per batch, not per instruction** (`src/lib.rs`): all peripheral `tick()`s are instruction-delta based, so advancing INSTRUCTION_COUNT by `count` + one `sys.tick()` is equivalent but ~100K× cheaper — was ~55% of runtime (wasm-function[36]/[364] under `step_batch` in cpu-prof); **3.8× speedup** (21.2s → 5.6s for 100M). Requires per-batch tickers to process ALL accumulated ticks — `tim.rs advance()` had a `ticks.min(1000)` cap that dropped timer events (TIM2 IRQ never fired: CNT stuck at 12K of ARR=36K); removed.
- Peripheral access hooks are NOT a bottleneck anymore: measured 0.001 accesses/instruction (~27K per 50M instr) for the periph37 firmware
- `step_batch()` gave 3.15× speedup over per-instruction `step()`
- `has_tick` flag: 69% tick speedup; `tick_indices` Vec + `AtomicU32` DMA bitmask: minor gains
- **instCount as plain number, not BigInt** (cli.mjs + pkg/emulator.js): ~19% faster full run (48.3s → 39.1s); BigInt ops per instruction were measurable at 5M instr/sec. `maxInst` compare + `step_batch` arg are now numbers too. Same change in emulator.js lifted the browser demo from 3.8M → 5.0M Avg IPS (~30%)
- **Hookless instruction counting** (cli.mjs + pkg/emulator.js): the per-instruction JS codeHook (2 increments) cost ~20% of runtime — measured by running 200M with the hook removed (10.86s → 8.7–9.1s; ~18.5 → ~22M IPS). Since `emu_start(begin,0,0,maxBatch)` stops exactly at maxBatch, each batch is credited in full: exact for normal batches; a faulted batch (unmapped access, ~0.01% of batches — 1 in 9988 measured) is skipped (PC+2) and credited full anyway, overcounting <1 batch — invisible. Handler runs inside `processInterrupts` are not credited (instruction-delta peripherals self-correct; canary stays 39/39). This also settles the "single WASM module / C-level codeHook" idea: the JS boundary was the whole cost, and it's now gone without any rebuild
- **Closed-form timer advance** (2026-08-13): `tim.rs advance()` was the only remaining O(ticks) loop — it iterated every accumulated tick (3 active timers × 20K ticks × 4 channels ≈ 2.4B compare checks per 200M run = 14.5% of runtime, 1409ms of 9.7s). Rewritten to jump directly to event ticks (update wrap + CCx compare matches) with bit-identical event sets: final CNT, UIF/CCxIF/TRGO/IRQ pendings all match the per-tick code exactly (same tick_once body at event ticks; no-event ticks skipped — CNT is only observable at batch boundaries, events only pend into batch-boundary queues). Down/up/center-aligned modes preserved (down = cms==0 && dir==1; ccr==0-down-at-cnt==0 edge case: the wrap tick can't match_down, handled). step_batch: 1409ms → **11ms** (124×); 200M run 9.54s → **8.32s (~24M IPS)**; Unicorn TCG is now ~97.5% of runtime — the JS/Rust layer is exhausted. Verified: 236/236, canary 39/39, emulator.js 200M, formats 14/14, ESM 4/4, all bare ELFs A/B-tested vs old wasm (no regression; their ~22s is pre-existing workload behavior), browser CDP smoke live (22 frames rainbow).
- **Batch size 20K** (cli.mjs, pkg/emulator.js DEFAULT_MAX_BATCH, site/index.html runLoop): was 100K (legacy from the slow-tick era). Per-batch tick is now cheap, so 5× smaller batches cut IRQ/interrupt delivery latency (~5.4ms → ~1.1ms) at zero measurable cost — 200M run 10.86s vs 10.8s baseline; canary still 39/39. More batch crossings = better UART RX/TIM/EXTI response in the browser demo (live per-frame UART render)
- **Site runLoop**: batch ~4× `step(20000)` per rAF frame (80ms budget), one UI pass per frame; Speed stat divides real frame instructions, not a fixed 500K
- **Regression canary**: `node tests/canary.mjs` (or `node tests/canary.mjs <maxInstr>` default 100M) — runs firmware, asserts exit 0, no FAIL lines, SUMMARY pass=39 fail=0, ~25s. Faster than the full 200M run.

## Current Status (all work below is committed; see git log)

> Last updated: 2026-09-15. The emulator is **feature-complete and stable**:
> 764 unit tests, 39/39 firmware checks, ~80M IPS headless (~117–119 in Chromium; shared-box noise ±30%). Recent work:
> `--help`/`--verbose` CLI + better errors, comprehensive About page, **removed all
> `panic!` from user-input paths** (bad pin names / empty bus ranges now degrade
> gracefully instead of aborting the WASM module), and an audit document
> (`docs/AUDIT.md`) covering memory, security, overhead and performance.
### Test suite: `node tests/test_all.mjs`
**764/764 unit tests PASS** (GPIO incl. electrical model + pin events, USART, ADC incl. RC sample-and-hold / DAC loopback / external triggers / AWD IRQ, RCC incl. clock decode, SysTick, TIM, IWDG, WWDG EWI, NVIC, CRC, SPI, I2C incl. slave/10-bit/PEC, RTC incl. second/overflow + flags, PWR incl. PVD, FLASH, CAN, DMA, AFIO, EXTI, BKP incl. tamper, DAC, TIM6, RTC Alarm, UART RX, FSMC, SDIO incl. MMC, USB FS + OTG_FS, ITM, SWD/JTAG debug, deep-sleep gating, fault escalation, HD/CL superset).

### Firmware test — `tests/arduino_periph_test/` (24-peripheral Arduino sketch, 39 checks)
```
echo -n "AB" | node pkg/cli.mjs --config=tests/arduino_periph_test/config.yaml --max=200000000     # ~9s, 10000 steps
```
- **PASS (39/39)**: sync section (GPIO, USART TX, UART Loopback, RCC, FLASH, PWR, BKP, IWDG, WWDG, RTC, CRC, DAC, ADC, AFIO, EXTI reg, CAN, SPI Flash, I2C EEPROM, I2C OLED, touchscreen, LCD, I2C2 EEPROM, SPI2 Flash, USART2 Loopback, SVC) + async section (DMA TX/RX, UART RX, TIM2, EXTI0, EXTI1, EXTI13, CAN RX, SysTick, TIM3 PWM, TIM4, RTC Alarm IRQ, PendSV)
- **SVC + PendSV test**: `testSVC()` in setup() does `__asm volatile("svc #2")` (fires synchronously mid-batch via the JS INTR hook), sets SHPR3 (SVCall=0x40, PendSV=0x80), then pendSVC via ICSR PENDSVSET; PendSV fires at the next batch boundary.
- **CAN RX injection**: cli.mjs polls the firmware's `canRxArmed` RAM global (symbol from ELF), then calls `can_inject_message(0x40006400, 0<<21, 2, 0xDEAD, 0)`. Note the firmware's filter bank 0 is ID-list mode (FS1R=1, FM1R=0, F0=0) → only STDID **0** matches — inject ID 0, not 0x123. **Never hardcode the flag address**: 0x200000b8 silently became `canRxTries` after a rebuild — every non-CLI driver (test_emulator_js, test_browser*, page/worker autopilot) then injected a full 3M-iteration RF0R timeout late (~4s per 200M run, browser 9→22 MIPS after fix). All drivers now resolve `canRxArmed` from ELF symbols via `parseElf` at load (index.html passes it to worker as `canFlagAddr`; hex/bin keep the constant fallback).
- **Batch-boundary timing**: emulator ticks peripherals only in `step_batch()` between `emu_start` batches — never mid-batch. Any test that reads CNT/SR/IRQ flags after a `spin()` must be async-style (arm once, poll across batches), else it sees CNT=0. Exception: `svc` fires synchronously inside a batch.
- **Important**: 50M instr cap stops mid-print (not a deadlock); use `--max=200000000` for the full run. `A` (0x41) is reserved for the DMA RX test; `B` is the UART RX byte. `uart_rx_pending()` gate in cli.mjs prevents `A` from being consumed by the UART RX test.
- **USART TX test notes**: firmware test polls SR TXE up to 2M iterations. In emulator TXE re-asserts at batch boundaries, DRW per ISR run → ~1 byte / 100K-instr batch (not byte_time at 6250). Poll of 100K iters previously failed because the 22-byte drain needs ~2.2M instructions. Real HW at 115200: ~1.9ms drain, well under 2M-iteration budget.
- **I2C2/SPI2 devices**: `build/eeprom2.bin` (0x51, 64K) + `build/spi_flash2.bin` (JEDEC `0xEF4017`, CS PB12) — both must be re-created after an arduino-cli rebuild (build dir gets wiped):
  `node -e "const fs=require('fs'); const e2=Buffer.alloc(65536); e2[0]=0x42; e2[1]=0x24; fs.writeFileSync('tests/arduino_periph_test/build/eeprom2.bin', e2); fs.writeFileSync('tests/arduino_periph_test/build/spi_flash2.bin', Buffer.alloc(65536));"`

## What We Did — Current Sprint (committed)
### 0. rp2040js-style peripheral bus + custom JS peripherals + multi-chip (`src/bus.rs`, `src/peripherals/mod.rs`, `pkg/cli.mjs`, `pkg/emulator.js`, site/index.html)
- **Bus**: new `src/bus.rs` — runtime registry (rp2040js `bus.ts` equivalent): `Bus::register(start, end, tick, p)`, sorted slots + binary search (`get()`), tick bookkeeping rebuilt on every register. `Peripherals.peripherals`/`tick_indices` → `bus: RefCell<Bus>`; `PeripheralSlot` gained a `tick` flag. **Last registration wins on overlap** (custom peripherals can shadow built-ins).
- **JS peripherals**: `JsPeripheral` (impl `Peripheral`, holds `js_sys::Function`s) + wasm export `register_js_peripheral(base, size, read, write) -> bool` — callbacks get `(addr, size)` / `(addr, value, size)` with the ABSOLUTE address; requires init first; cleared by the next init (fresh bus). emulator.js: `emu.addJsPeripheral(...)` + `opts.js_peripherals`; cli.mjs: `--periph-plugin=<file.mjs>` (default export array of {base,size,read,write}).
- **Hardcoded table fixed to real F103 addresses**: DMA1 0x40006000 → **0x40020000**, +DMA2 0x40020400 (clock_enabled had the right gates already; `dma_request()` lookup updated) — the SVD-vs-hardcoded dual-map bug class is GONE; real-address firmware passes under either path. CAN MCR write mask corrected: 0x7F3F → 0x180FF (INRQ..TTCM 0-7, RESET 15, DBF 16 — ABOM bit 6 was silently dropped).
- **Multi-chip**: `from_svd()` now auto-registers the ARM core peripherals (NVIC/SysTick/SCB at fixed 0xE000Exxx addresses) when the SVD omits them — **STM32F105xx.svd has no SCB/SysTick**, so millis()/PendSV silently broke until the fallback (verified: browser periph37 on F105 = 39/39, CAN2@0x40006800 live). Unsupported SVD peripherals (ETH) skipped by name. Ship `svd/STM32F105xx.svd` (connectivity line, CAN2) + page chip selector (`chipSelect`: F103C8 builtin | F105 SVD).
- **Verified**: `tests/test_all.mjs` 224/224 (+9 JS-peripheral, +5 F105); canary 39/39; 200M 39/39 @ 9.67s; browser F103C8 39/39 + F105 39/39.
- **Docs**: ARCHITECTURE.md "The peripheral bus" (layer table), USAGE.md (chip/js_peripherals/plugin), AGENTS.md SVD-note rewritten.
### 1. Stale ext-device fix — `reset_ext_devices()` (`src/lib.rs`, `pkg/cli.mjs`, `pkg/emulator.js`) [commit f05a44d]
- **Symptom**: running arduino_periph_test in the page AFTER the showcase preset → 38/39 (touchscreen FAIL). Root cause: `add_*` calls append to module-level static lists — a second `init()` keeps the showcase's devices. The stale showcase LCD (SPI1 cs **PA8**) sits BEFORE the new run's touchscreen (cs PA1) in SPI1's device list; the fresh GPIO leaves PA8 low → stale LCD selected during the touchscreen test → `read()`=0 → `[Touchscreen] FAIL`. Direct-API re-init passed because it re-added the SAME devices (fresh list order), masking the bug.
- **Fix**: new `reset_ext_devices()` wasm export (clears spi_flashes, i2c_eeproms, usart_probes, lcds, touchscreens, displays, i2c_oleds, fsmc_nors + software SPI configs); called at the top of `createEmulator()` and both cli.mjs paths (before config/bare-firmware device registration, always before `init()`). Single-instance runs unaffected.
- **Verified**: `node tests/test_all.mjs` 224/224; canary 39/39; `--max=200000000` 39/39 in 9.56s; browser periph37-after-showcase 39/39 badge Done; headless CDP button press → `t=8s btn=1` heartbeat (earlier misses were the test clicking at y=-89 — button scrolled above the viewport; `scrollIntoView` first).
### 2. Real GPIO/electrical behaviour (`src/peripherals/gpio.rs`)
- **Pin-level electrical model** for IDR readback: input pull-up/down (CNF=01, ODR bit selects direction), floating input (external driver or 0), push-pull output readback (slew-aware), open-drain (low driven; high released → external pull or 0), external drivers (JS read callbacks) win over driven state, analog → 0.
- **Slew** (`GPIO_SLEW` + `gpio_set_slew(n)`): output transitions land in `pending_transitions` (pin, settle_at, old_level); IDR shows the old level until settle. Open-drain driven-low ignores external drivers (`driven_pin_level`).
- **ODR/BSRR/BRR write the full register** (input pins use ODR for pull selection — the old `output_mask` filter silently broke INPUT_PULLUP); output-mode side effects (device callbacks, EXTI) still only fire for output pins.
### 3. Sleep state timing (`src/system.rs`, `src/peripherals/scb.rs`, `src/peripherals/mod.rs`, `src/peripherals/tim.rs`)
- `SCR.SLEEPDEEP` (SCB 0xE000ED10 bit 2) → deep sleep: `system.tick()` calls `tick_frozen()` on every peripheral except RTC (0x40002800) + IWDG (0x40003000), and skips SysTick accrual.
- **New trait method `tick_frozen()`** (default no-op): instruction-delta peripherals advance their delta base WITHOUT processing state. TIM overrides it — without this, frozen timers CATCH UP on wake (a 200-tick sleep produced a +220 CNT jump).
- Wake is immediate: UART RX pends from JS at the next batch boundary.
### 4. Exceptions other than IRQs (SVC, PendSV, faults) (`src/peripherals/nvic.rs`, `src/peripherals/scb.rs`, `pkg/cli.mjs`, `pkg/emulator.js`)
- **Unicorn probe**: `svc` fires HOOK_INTR intno 2 (execution continues after svc if not redirected); `bx lr` to 0xFFFFFFF9 THROWS UC_ERR_FETCH_UNMAPPED (no hook); MODE_BIG → UC_ERR_ARCH (must use THUMB|LITTLE_ENDIAN). The old `intno === 8` INTR branch is dead code (kept intact).
- **SVC**: Rust builds the 32-byte frame AND the mirror (`intr_svc_enter` in `src/interrupts.rs`, depth-capped at 8, shared by cli.mjs + emulator.js) — written to the real stack AND mirrored in Rust — sets LR = EXC_RETURN (0xFFFFFFF9, or 0xFFFFFFFD when `CONTROL.SPSEL`), PC = SVCall vector (exception 11 → vector_table + 44). Return: the main-loop catch sees PC in 0xFFFFFFF0..0xFFFFFFFF with `intr_svc_depth() > 0` → pops the mirror via `intr_svc_leave()`.
- **PendSV**: `ICSR.PENDSVSET` (SCB write) → NVIC pending → dispatched by the normal `processInterrupts` path.
- **Faults**: unmapped faults are now REAL except the known Unicorn `bl` artifact at `HAL_NVIC_EnableIRQ` (resolved via ELF symbols; skip PC+2). `raise_fault(kind, addr)` (Rust export) sets CFSR (IBUSERR/PRECISERR/UNDEFINSTR), BFAR+BFARVALID, HFSR FORCED, and pends BusFault (-11)/UsageFault (-10) if the SHCSR enable bit is set, else **escalates to HardFault (-13)**.
- **System-handler priorities**: SCB SHPR1-3 writes route to the NVIC `sys_handler_priority[16]` (default 0x80; fixed: NMI 0, HardFault 0, MemManage 1, BusFault 2, UsageFault 3). SHCSR write mask fixed (`& 0xFFFF` dropped bit 18).
- **Fault dispatch caveat**: STM32duino's default fault handler is `while(1)` — a genuinely faulting firmware hangs the run (realistic; the artifact skip + symbol gating keeps periph39 clean). No symbol table (hex-only browser firmware) → legacy tolerant skip.
### 5. Real ADC conversion (`src/peripherals/adc.rs`)
- Full rewrite: conversion state machine with real timing (`Tconv = SMP + 12.5` cycles, 1 instr = 1 ADC cycle; SMP codes 0-7 → 14/20/26/41/54/68/84/252), per-sequence channels (SQ1-16 from SQR3/2/1, JSQ1-4), `end_at`-based completion in `tick()`, EOC per conversion unless EOCS (CR2 bit 10), STRT at sequence start, AWD vs HTR/LTR, CONT (bit 16) auto-restart, SWSTART (bit 22)/JSWSTART (bit 21), CAL/RSTCAL self-clear, ADC1→DMA1 ch1 / ADC2→DMA1 ch2 requests via the new `dma_request()` trait method.
- ADC unit test now waits `step_batch(14)` after SWSTART (was: instant EOC).
### 6. DAC→ADC loopback + ADC external triggers (`src/peripherals/dac.rs`, `src/peripherals/adc.rs`, `src/peripherals/tim.rs`, `src/peripherals/exti.rs`)
- **DAC wires its pins**: enabled DAC channels drive a 12-bit analog wire (DAC1→PA4/ch4, DAC2→PA5/ch5); `Peripherals::dac_output()` (trait method `dac_output`, default None) consulted by `Adc::channel_voltage()` with the source resolver: wired GPIO (manual) > DAC output > nominal internal > sim value.
- **External trigger machinery**: `adc_timer_trigger(sys, tim_base, ch)` (ch 4 = TRGO) + `adc_exti_trigger(sys, line)` trait methods, fanned out from `Peripherals` to every ADC (0x40012400/0x40012800). TIM emits TRGO on update when MMS=010 and CC triggers on compare matches; EXTI emits on lines 11/15 rising edges. ADC gates on EXTTRIG (CR2 bit 20) / JEXTTRIG (bit 15) and EXTSEL (bits 17-19) / JEXTSEL (bits 12-14) tables (TIM1_CC1..TIM1_TRGO, TIM2_CC2, TIM3_TRGO, TIM4_CC4; injected TIM1_CC4/TIM2_TRGO/TIM2_CC2/TIM3_CC4/TIM4_TRGO, EXTI15). New conversion only when idle.
- Timer: `base` address field added (from name, `timer_base()`); triggers fire inside `advance()`/`generate_update()` mid-batch — conversion `end_at` completes at the NEXT step_batch (conversion runs with the batch-boundary ticker: same semantics as SWSTART).
- **Fixes**: double-RefCell panic (GPIO write → EXTI → `channel_voltage` while `gpio.borrow_mut()` held) avoided by `gpio.try_borrow()` in `channel_voltage` (source is re-read at sample completion anyway); test bug (`EXTSEL=7 TIM1_TRGO` needs TIM1 CR2 MMS=010 → value 0x20 not 0x10).
### 7. Full FSMC (`src/peripherals/fsmc.rs`, `src/ext_devices/fsmc_nor.rs`)
- All 7 external-memory banks: NE1-4 @ 0x6000_0000/0x6400_0000/0x6800_0000/0x6C00_0000 (NOR), NAND2/3 @ 0x7000_0000/0x8000_0000, PC-Card @ 0x9000_0000. BCR1-4 @ 0xA000_0000.. (BTR/BWTR at +8/+10/+18), PCR/PMEM/PATT 2-4 at +0x60/+0x80/+0xA0 (+8 stride).
- NOR banks gate on BCR MBKEN (bit 0); NOR writes also need WREN (bit 1). NAND/PC always enabled. `read_sized`/`write_sized` assemble bytes per access width.
- Backing: `FsmcNor` ext device with a JS `Uint8Array` image; `add_fsmc_bank('FSMC.BANK1', data)` (must precede init()); ext_devices lookup in `find_mem_device` matches `fsmc_nors` by name (`FSMC.BANK1..7`).
### 8. IRQ delivery correctness (`pkg/cli.mjs`, `pkg/emulator.js`, `src/peripherals/nvic.rs`) [commits add9fe2, 9626233]
- **xPSR restore**: `processInterrupts` saved R0-R3,R12,LR,PC,xPSR but cli.mjs never wrote xPSR back (emulator.js's frame read-back did). A handler's emu_start clobbers APSR, so a cmp/beq pair split across a batch boundary (e.g. timer demo guard `cmp` @0x8000222, `beq` @0x8000224) evaluated with the HANDLER's flags: TIM2's ISR landing exactly there fell through a guard that should have skipped → the print body ran twice per second with a stale `now` + fresh `CNT` → every `t=Ns cnt=N+1` line duplicated. Fix: restore xPSR from the stacked frame before restoring PC. Since §9 both files restore from the frame (handler edits to the saved context are honored).
- **SysTick debt drain**: SysTick is delivered as `irq=-1` (const `SYSTICK: i32 = -1` in nvic.rs — exception #15 via `vector_table + 4*(16+irq)`), but both JS paths drained the re-pend debt with a dead `if (irq === 15)` check — `nvic_systick_take()` never ran, so a multi-period elapsed (large SysTick debt) delivered only ONE of the owed ticks.
- **Debt accounting**: wiring the drain to `irq === -1` alone double-delivered: `maybe_set_systick_intr_pending` sets the pending bit AND adds `ticks` to debt, then `systick_take()` re-pends the same tick again (~150 deliveries/6M vs 75 = 2× fast millis). Fixed in nvic.rs: the pending IRQ covers the FIRST tick, debt holds only the remainder (`ticks.saturating_sub(1)`, or full `ticks` when a SysTick was already pending); steady state = 1 delivery per period (75/6M ≈ 83 expected at 72000-instr 1ms).
### 9. Interrupt dispatch policy in Rust + CI (`src/interrupts.rs`, `pkg/cli.mjs`, `pkg/emulator.js`, `.github/workflows/test.yml`)
- **New `src/interrupts.rs`** (`IntrDispatch` state on `WasmSystem`): owns everything about interrupt delivery that isn't pure Unicorn transport — the per-batch 64-IRQ budget (`intr_next()`, reset inside `step`/`step_batch`, -255 when exhausted) and the SVC frame mirror (`intr_svc_enter` returns the 32-byte Cortex-M frame and pushes the mirror, depth-capped at 8; `intr_svc_leave` pops to `[r0,r1,r2,r3,r12,lr,pc,sp]`; `intr_svc_depth` guards the JS catch). Registers/vector fetch/handler `emu_start` stay in JS (Unicorn-bound — see NEXT_PHASE.md §2).
- **One dispatch implementation**: cli.mjs and emulator.js now use identical code — `intr_next()` loop (both had different loop shapes: cli capped at 64 with a for-loop, emulator drained all pending), SVC hook via `intr_svc_enter`, catch via `intr_svc_depth()/intr_svc_leave()`. Both also unified on **restore-from-stacked-frame** (was: cli restores from JS locals, emulator from frame read-back) — handler edits to the saved context are now honored in both, and the xPSR restore requirement is covered by the frame.
- **Batch register transport** (regsRead/regsWrite helpers, identical in cli.mjs + emulator.js, keep in sync): unicorn_arm exposes raw `uc_reg_read_batch`/`uc_reg_write_batch` without marshalling — the helpers allocate id/pointer/value arrays so an IRQ dispatch crosses the addon boundary 2× instead of ~17×. Dispatch measured at 1.3% of runtime (124ms of 9.29s for 6198 IRQs in 200M), so this is a correctness-adjacent micro-opt, not a speed lever. **Regression fixed in the same change**: e113a74's unification dropped the XPSR write that add9fe2 had added (restore-from-frame wrote R0-R3/R12/LR/PC/SP but not XPSR, despite the comment claiming it was required — the canary misses it because periph39 doesn't straddle a cmp/beq pair across a batch boundary like the timer demo does). Restore now writes XPSR from frame offset 0, and the intrHook intno-8 (bx lr EXC_RETURN pop) also restores XPSR (real hardware does).
- **CI** (`.github/workflows/test.yml`): `cmp` guard extended to all three `pkg`↔`site` artifacts (emulator.js, stm32_bluepill_wasm.js, stm32_bluepill_wasm_bg.wasm), stale "37/37" canary comment → 39/39, added the full 200M config run (`echo -n "AB" | node pkg/cli.mjs --config=... --max=200000000`) after the canary. **The wasm guard compares the CODE section byte-for-byte** (the 7040bd0 failure mode — stale/missing site artifact — still fails because the code differs). **Determinism root cause (2026-08-14)**: the data section embeds 81 panic-location file paths (`$CARGO_HOME/registry/src/index.crates.io-.../...`) — `/home/<user>` differs per machine (CI runner = `/home/runner`), shifting the data section (−320 B here) and one i32.const data-offset constant by the same amount → code sections "differed at byte 100" despite identical toolchains (rustc 1.97.1 / wasm-pack 0.14.0 / wasm-bindgen-cli 0.2.126 / wasm-opt 132 were all verified byte-identical; wasm-bindgen-cli version drift was a red herring). **Fix**: build with `RUSTFLAGS="--remap-path-prefix=$HOME=/build"` locally and `--remap-path-prefix=/home/runner=/build` in the workflow env → byte-identical artifacts on any machine (verified: local md5 == CI md5 `ab25282f...`, 1396229 bytes). The two JS artifacts stay byte-exact. CI pins `wasm-pack@0.14.0` + binaryen `version_132` (download+PATH step) so the wasm-opt step matches local builds; rustc@stable both sides.
- **Verified**: `tests/test_all.mjs` 224/224; canary 39/39; cli 200M 39/39 @ 9.64s; emulator.js (browser path, node smoke) 200M 39/39 incl. SVC/PendSV/EXTI/TIM — same run shape as the page's run loop.
### 10. Emulator.js path in CI + stale test fixes (`tests/test_emulator_js.mjs`, `tests/test_esm.mjs`, `tests/test_firmware_formats.mjs`, `.github/workflows/test.yml`)
- **New `tests/test_emulator_js.mjs`**: drives `createEmulator` + `run()` (the exact page code path, previously only manually verified) with the periph_test firmware + devices, UART RX "AB", CAN autopilot (chunked runs polling `canRxArmed` @ 0x200000b8 like site/index.html:537), asserts no FAIL + SUMMARY 39/39 — 200M in ~10s. Added to CI after the cli 200M step.
- **test_esm.mjs fixed**: pointed at the current wasm glue (`stm32_periph_wasm.js` → `stm32_bluepill_wasm.js`), made a real pass/fail with exit code (ESM glue loads + Unicorn boots a cortex-m instance).
- **test_firmware_formats.mjs fixed**: was committed-but-broken (needed a `comprehensive_test` ELF that no longer ships). Rewritten self-contained on the arduino_periph_test artifacts (hex + map committed, ELF copied by CI from site/) with cross-format consistency checks — hex SP == map _estack, hex/elf reset == map Reset_Handler, symbols present, garbage rejection — no hardcoded addresses (those drifted when the sketch/core changed).
- **CI**: added "Firmware format + ESM smoke tests" step + "Emulator.js path (browser run loop) 200M firmware run" step.
### Unit tests / firmware / misc
- `tests/test_all.mjs`: 189 → **224 PASS** (DAC→ADC loopback via DOR1/2, TIM1 TRGO/CC1 + EXTI11 external triggers, EXTI 11 → ADC without SWSTART, DMA pump exports `dma_absorb_periph`/`dma_push_periph`; AWD IRQ needs ISER enable: `can_fire` requires the IRQ enabled in the NVIC, real hardware semantics — pending without enable stays pending).
- Firmware: +SVC (synchronous, `svc #2` in setup()) +PendSV (ICSR-pended, fires next batch) → **39/39**; canary asserts 39.
- cli.mjs/emulator.js: SVC hook, EXC_RETURN pop, symbol-gated fault raise; emulator.js `faultSym` merged into the existing `resolveSymbol` path (`resolveSym` shared helper, `setSymbols` resets it).
- site/: synced (emulator.js + wasm + unicorn_arm.js), refreshed `arduino_periph_test.elf` (39 checks) + eeprom2/spi_flash2 images.
- docs/: PERIPHERALS.md (FSMC/ADC Full, GPIO electrical, sleep, exceptions, 224 tests, 39 checks), ARCHITECTURE.md (Exceptions/Sleep/GPIO/FSMC sections), USAGE.md (gpioSetSlew + fsmc ext_devices + 39), README links.
- 200M full run: 39/39 in **9.00s** (~22M IPS).

## Active Workarounds (temporary, remove or upstream later)
1. ~~**`mrs rX, msp` → `mov rX, sp`**~~ — **retired with Unicorn**: the native core decodes `mrs` directly.
2. ~~**i2c_init NVIC patch**~~ — **retired with Unicorn**: the core runs the real `bl HAL_NVIC_EnableIRQ` (proven unpatched by native I2C passing).
3. **hi2c->Mode patch**: the I2C model flags I2C1 DR writes with the R-bit (`WasmSystem.i2c_dr_hook`); the driver patches RAM `*(0x200002d8)+0x3D` to 0x22 pre-dispatch — HAL I2C1 ISR requires `hi2c->Mode == 0x22` (MASTER_RX) before reading DR
4. ~~**Interrupt frame restored from the stacked frame in JS**~~ — **retired with Unicorn**: stacking/return live in `Cpu::take_exception`/`exception_return` (xPSR included).
5. **64-IRQ budget in `intr_next()`** (src/interrupts.rs, reset by step/step_batch): prevents starvation when a high-priority IRQ re-pends itself — paired with the NVIC `last_popped` fairness, a hot IRQ (TXE) alternates with other pendings instead of consuming every slot (e.g. CAN TX IRQ37 prio16 vs I2C EV IRQ31 prio32)
6. **DMA**: the **whole pump lives in Rust** — `rustcpu_dma_pump()` builds the op plan and executes it against Rust RAM with zero JS crossings. Completion is signaled LAST (op 3) so TC IRQs fire only after data lands. ISR return is one Rust call: `finish_interrupt(irq)` = `clear_current_interrupt()` + SysTick debt drain (JS `nvic_systick_take` loop gone). Note: Vec<u8> returns arrive in JS as a plain number array, not Uint8Array (test_all joins bytes with String.fromCharCode)

## To Run / Rebuild
```bash
cargo check                          # Rust sanity (fast)
PATH=~/.local/binaryen/binaryen-version_132/bin:$PATH RUSTFLAGS="--remap-path-prefix=$HOME=/build" wasm-pack build --target web   # rebuild pkg (Rust → wasm) — MUST use pinned binaryen version_132 (wasm-opt) AND the path remap, else site/ sync breaks the CI guard. Keep binaryen OUT of /tmp (box wipes it; a missing dir silently falls back to wasm-pack's cached wasm-opt 117 — red CI for 3 commits 2026-09-11/12 — and VERIFY with `wasm-pack build`'s "found wasm-opt at ..." line). Persistent install: `~/.local/binaryen/` (curl version_132 x86_64-linux tarball).
# (the remap neutralizes $HOME in panic-location strings baked into the data section:
#  81 file paths like /home/<user>/.cargo/registry/src/... → the wasm byte-exact on
#  any machine — CI's runner ($HOME=/home/runner) gets the same flag in the workflow)
node tests/test_all.mjs              # 224 unit tests
node tests/canary.mjs                # regression canary: 39/39 firmware checks, ~25s
node tests/test_emulator_js.mjs      # browser run-loop path: 200M, 39/39 (~10s)
node tests/test_firmware_formats.mjs # hex/map/elf cross-format consistency
node tests/test_esm.mjs              # ESM glue + native backend API smoke
node tests/bench.mjs                 # benchmarks
node pkg/cli.mjs tests/arduino_periph_test/build/arduino_periph_test.ino.elf   # run firmware
echo -n "AB" | node pkg/cli.mjs --config=tests/arduino_periph_test/config.yaml --max=200000000
# rebuild firmware (Linux, arduino-cli installed locally):
/home/danish1075/bin/arduino-cli compile --fqbn STMicroelectronics:stm32:GenF1:pnum=BLUEPILL_F103C8 --build-path tests/arduino_periph_test/build tests/arduino_periph_test
# NOTE: --build-path wipes eeprom.bin/spi_flash.bin — restore from site/ after compile
# browser demo:
python -m http.server -d pkg   # then open localhost:8000
```

### Disassembly for ISR debugging (Windows PowerShell)
```
arm-none-eabi-objdump -d tests/arduino_periph_test/build/arduino_periph_test.ino.elf > isr.asm
# find HAL_I2C_EV_IRQHandler / HAL_I2C_Master_*_IT symbols
```

## Next Phase — What's Left

### Immediate (ALL PASS as of this sprint; re-check after any change)
1. **Verify nothing regressed** — rerun `tests/test_all.mjs` (764) + canary (`node tests/canary.mjs`, 39/39) after any edit to `src/` or `pkg/cli.mjs`

### Known issue (monitor only, mostly explained)
- Historical `Fatal: undefined Stack: undefined` at ~35M+ instructions — **identified (2026-08-11)**: that text is cli.mjs's own catch handler format (`console.error('Fatal:', e.name, e.message)` + `'Stack:', ...`, present since the initial commit), not any wasm/glue string — no "Fatal:" exists in unicorn_arm.cjs/.js, stm32_bluepill_wasm.js or the .wasm. So the incident was a JS promise rejection with a nameless value (bare string/undefined; wasm-bindgen panics throw `new Error(msg)` with name+message, so a REAL Rust/wasm panic would have printed differently). Current handler is hardened (`e?.name || '(no name)'`, `Type:` dump) so a re-occurrence is now diagnosable. Not reproduced across ~6B stress instructions (22 runs, 2026-08-13: 3×200M + 2×500M + 1×1B periph39 cli, canary, emulator.js 200M browser path, showcase/ws2812/echo/fade/flash/timer_uart/adc_uart ELFs 100–200M — all exit 0, zero `Fatal`/`(no name)` in output); monitor only.

### 12. Pin-activity monitor on the demo board (site/index.html) — onPinChange live demo
- The Blue Pill board SVG now glows pins amber for ~2s after the chip drives them to a NEW level (stroke #fbbf24 + glow circle at the pin tip), tooltips show cumulative per-pin toggle counts, and a caption under the PCB shows the running total ("N pin toggles — hover a glowing pin").
- Fed by the §11 onPinChange API (drained per batch in run()/step() + before each memWriteHook's write watchers): the PIN_ACTIVITY map + onPinActivity(port, pin) subscriber, registered once per initEmulator (fresh emulator = fresh watchers) and cleared on every firmware load.
- Generic: works with any firmware/preset, not just the showcase. Verified vs the showcase firmware (30 emulated s): PC13 LED 15, PA4 7-seg CS 15, PA8 LCD CS 15, PB14 buzzer 14, PB6 I2C1 SCL 39 toggles; PB13 button (input, JS-driven) and PA5 SPI SCK (AF) correctly silent — demonstrates the exact §11 semantics live.
- index.html only; pkg/ and wasm untouched (cmp guard trivially synced).
### 13. DMA correctness fixes + WS2812 strip demo (src/peripherals/dma.rs, tests/arduino_ws2812/, site/index.html) [current sprint]
- **DMA ISR flag layout was off by one channel**: `tick()` set completion at bit `(ch+1)*4` (0-based ch); real HW puts channel N flags at `(N-1)*4..(N-1)*4+3`, TCIF_N = `(N-1)*4+1`. CH4 completion lit bit 16 instead of 13; CH3 lit 12 instead of 9. The periph39 DMA TX/RX tests passed anyway because both transfers queue in the same loop call and their completion bits landed in one shared ISR read (RX's bit 20 satisfied TX's check) — the firmware even had `/* TCIF4 (emulator layout) */` comments. Fixed to `isr |= 1 << (ch*4+1)`; firmware's TCIF4 check → bit 13 (real HW).
- **DMA direction was inverted vs CMSIS**: `do_xfer` mapped DIR=1 → `DmaDir::Read` and treated it as periph→mem absorb (pump op1), so a CMSIS-correct mem→periph channel (DIR=1) silently ABSORBED from the peripheral address instead of pushing — the WS2812 firmware's SPI1 transfer "completed" (CNDTR=0, TCIF set) but zero bytes ever reached SPI1 DR, and the JS-side `dma_push_periph` read Unicorn memory at the *peripheral* address (op2 `t.src` was CPAR, not CMAR) → dropped by the processDma catch. periph39 tests used the inverted convention (RX with DIR=1, TX with DIR=0) and only checked flags. Fixed: DIR=1 → mem→periph (src=CMAR, push to CPAR), DIR=0 → periph→mem (absorb CPAR, write CMAR), M2M (CR bit 14) → CPAR→CMAR memcpy (per RM0008). Firmware updated to CMSIS-correct bits.
- **DMA pushes bypassed onPeriphWrite**: `dma_push_periph` writes the periph bus Rust→Rust, but page-side write watchers only fire from the Unicorn memWriteHook — page decoders never saw DMA traffic (7-seg demo used direct CPU writes, so it was never hit). processDma now feeds `writeWatchers` per pushed byte for op2 (exactly one call per byte, like real HW).
- **WS2812 demo** (`tests/arduino_ws2812/` + page preset): 800kHz strip over SPI1 at 2.25MHz (div32) + DMA1 CH3 fire-and-forget; each ws bit = 3 SPI bits (0b110=1, 0b100=0), GRB, 8 LEDs = 72 bytes/frame; rainbow `hue=(frame*9 + i*45)%360`; UART `WS2812=ok` + `frames=N` every 2s. Page: preset option + LED-strip card (`wsCard`, 8 `.ws-led` divs) decoded live via `onPeriphWrite(wsWatch)` — 24 ws-bits per LED, GRB, frame counter. **8-bit DMA transfers**: the first build used PSIZE_0|MSIZE_0 (16-bit) — real HW clocks 8 bits (DS=8) per 16-bit DR write, but the emulator's `data_size = max(psize,msize)*ndtr` pushed 144 bytes/frame (misaligned decode). Dropped to 8-bit (PSIZE/MSIZE=00) → 72 bytes exact.
 - **Verified**: 236/236; canary 39/39; cli 200M 39/39; emulator.js 200M 39/39; WS2812 Node smoke (5 runs): frame0 LED0 exact red, all 40 LED-color checks across first 5 frames exact, 84 frames decoded, UART count tracks; headless CDP page smoke: preset loads, 16-34 frames decoded live, rainbow colors on the DOM strip, ALL PASS.

### 14. Ergonomic `STM32F1` wrapper + Wokwi-style virtual-peripheral event queue (`pkg/stm32f1.js`, `src/system.rs`, `src/peripherals/{usart,spi,i2c}.rs`, `src/lib.rs`, `docs/STM32F1_API.md`) [committed]
- **Wokwi-style event queue**: `WasmSystem` now holds a `RefCell<Vec<VmEvent>>` (enum `VmEvent`: `SpiTransfer{channel,tx,rx}`, `I2cStart{channel,addr}`, `I2cWrite{channel,byte}`, `I2cRead{channel}`, `I2cStop{channel}`, `UartTx{usart,byte}`). Pushed in `usart.rs::write_dr` (UartTx), `spi.rs` DR write (SpiTransfer + optional MISO inject consume), `i2c.rs` (Start/Write/Read/Stop + optional RX inject). `drain_events()` (`src/lib.rs`) flattens to an `i32[]`; `emulator.js` exposes `drainEvents()` / `spiInjectMiso(ch,bytes)` / `i2cInjectRx(ch,bytes)` / `uartRxAddr(addr,byte)`.
- **Why**: `getUartOutput()` is USART1-only and USART DR writes do NOT fire `onPeriphWrite`, so per-USART TX (e.g. USART2) could not be observed. The event queue is the transaction-level model Wokwi virtual peripherals expect and captures ALL buses.
- **`pkg/stm32f1.js`**: `STM32F1` class + `GPIO`/`GPIOPin`/`USART`/`SPI`/`I2C` wrappers. `execute()`/`step()` auto-drain events and dispatch to `gpio.pin().on('change')`, `usartN.onData`, `spiN.onTransfer(ch,tx,rx)`, `i2cN.onStart/onWrite/onRead/onStop`; `usartN.send()`, `spiN.injectMiso()`, `i2cN.injectRx()` for host→MCU injection. Thin layer, no hot-path overhead.
- **Tests**: `tests/test_stm32f1_api.mjs` (7: USART1 TX + SPI1 transfers via ws2812 elf), `tests/test_i2c_events.mjs` (3: I2C1 Start/Write/Stop via periph_test + empty-data div-by-zero guard on spi_flash requires non-empty image). Both wired into `.github/workflows/test.yml`. `docs/STM32F1_API.md` written.
- **Rebuild note**: wasm rebuilt with pinned binaryen `version_132` (persistent `~/.local/binaryen/`, NEVER /tmp — wiped 2026-09-11, silent 117 fallback) + `RUSTFLAGS="--remap-path-prefix=$HOME=/build"`; `pkg/` and `site/` re-synced (CI byte-exact guard).

### 15. Extend virtual-peripheral event queue to EXTI / ADC / TIM (`src/system.rs`, `src/peripherals/{exti,adc,tim}.rs`, `src/lib.rs`, `pkg/stm32f1.js`) [committed]
- `VmEvent` gained `ExtiEdge{line}`, `AdcDone{adc,chan}`, `TimUpdate{tim}` (flat discriminants 7/8/9). Pushed in `exti.rs::gpio_pin_changed` (hardware edge), `adc.rs::advance_regular/advance_injected` (EOC/JEOC), `tim.rs::tick_once` + `generate_update` (UIF). Encoded in `src/lib.rs::drain_events`.
- `STM32F1` gained top-level callbacks `onExtiEdge(line)`, `onAdcDone(adc,chan)`, `onTimUpdate(tim)` (dispatched from `_drain_events`).
- Tests: `tests/test_extra_events.mjs` (TIM + ADC via periph_test; periph_test headless does NOT self-trigger EXTI edges, so EXTI is logged, not asserted there), `tests/test_exti_events.mjs` (deterministic: configure EXTI0/1 via the bus, drive PA0/PA1 high via `gpioSetInput` -> ExtiEdge{0,1}). Both wired into CI. `docs/STM32F1_API.md` updated.

### 16. More virtual-peripheral events: DAC/CRC/RTC/Watchdog/CAN (`src/system.rs`, `src/peripherals/{dac,crc,rtc,iwdg,wwdg,can}.rs`, `src/lib.rs`, `pkg/stm32f1.js`) [committed]
- `VmEvent` gained `DacWrite{chan,value}` (disc 10, dac.rs DHR write), `CrcResult{value}` (disc 11, crc.rs DR read), `RtcAlarm{alarm}` (disc 12, rtc.rs tick when alarm crossed), `WdogReset{which}` (disc 13, iwdg.rs/wwdg.rs reset request — which: 1=IWDG,2=WWDG), `CanTx{can,id,len,data[8]}` (disc 14, can.rs TX mailbox submit), `CanRx{can,id,len,data[8]}` (disc 15, can.rs inject_message). Encoded in `src/lib.rs::drain_events` (id = 11-bit STDID or 29-bit EXTID, len = DLC, data = 8 bytes).
- `STM32F1` gained top-level callbacks `onDacWrite/onCrcResult/onRtcAlarm/onWdogReset/onCanTx/onCanRx` (dispatched from `_drain_events`).
- Tests: `tests/test_more_events.mjs` (DAC/CRC/RTC fire naturally in periph_test; CAN RX/TX driven deterministically by configuring a pass-all filter + inject / submitting a mailbox). Wired into CI. `docs/STM32F1_API.md` updated.
- **Note**: F103 has no onboard comparator, and TIM input-capture wasn't modeled — now it is (see item 17).

### 17. Implement TIM input capture + FSMC transaction events (`src/peripherals/{tim,fsmc}.rs`, `src/system.rs`, `src/lib.rs`, `pkg/stm32f1.js`) [committed]
- **Real TIM input capture** (`tim.rs`): added `last_cap`/`cap_count`/`cap_inited` per channel + `sample_input_capture()` (called once per batch in `tick()`). When a channel's `CCMR CCxS != 0` (input mode) and an edge matching `CCxP`/`CCXNP` polarity occurs on its source pin (default `tim_chan_pin` mapping, no AFIO remap; `CCxS=10` -> partner pin), CNT is latched into `CCRx`, `CCxIF` set, IRQ pending if `CCxIE`, and a `TimCapture{tim,ch,value}` event (disc 16) is emitted. The output-compare block in `tick_once` now skips input-capture channels. Also hardened a latent `ARR=0xFFFF_FFFF` divide-by-zero in `advance()` (`self.arr + 1` wrap) — guard `arr != u32::MAX`.
- **FSMC transaction events** (`fsmc.rs`): `FsmcAccess{bank,offset,write,size,value}` (disc 17) pushed on every NOR/NAND/PC-Card data read/write in `read_sized`/`write_sized` (regardless of whether a backing ext_device image is attached).
- `STM32F1` gained `onTimCapture(tim,ch,value)` + `onFsmcAccess(bank,offset,write,size,value)`, dispatched from `_drain_events` (types 16/17).
- Tests: `tests/test_tim_capture.mjs` (deterministic: TIM2 CH1 input-capture on PA0, drive rising edge -> TimCapture{2,0}), `tests/test_fsmc_events.mjs` (deterministic: enable BANK1, read+write 0x60000000 -> FsmcAccess read+write). Both wired into CI. `docs/STM32F1_API.md` updated.
- **Verified**: 236/236 unit (incl. new TIM/FSMC paths), tim_capture 4/4, fsmc 8/8.

### 18. Wokwi virtual peripheral end-to-end + TIM AFIO remap (`src/peripherals/{tim,afio}.rs`, `pkg/stm32f1.js`, tests) [committed]
- **AFIO remap in `tim_chan_pin`**: `sample_input_capture` now reads the AFIO MAPR
  remap code via `sys.p.afio_remap_status(name)` and `tim_chan_pin(name, ch, remap)`
  returns the remapped pins for TIM2/TIM3/TIM4 (TIM2_REMAP bits[9:8], TIM3_REMAP
  bits[11:10], TIM4_REMAP bit12). Also fixed the buggy AFIO MAPR TIM bit shifts in
  `afio.rs` (`remap_status` had TIM1>>4/TIM2>>24/TIM3>>9/TIM4>>10 — now correct
  >>6/>>8/>>10/>>12; CAN>>22). `periph_remap()` is unused, so risk-free.
- **End-to-end Wokwi virtual peripheral**: `tests/test_fsmc_display.mjs` drives an
  FSMC-backed LCD model entirely through `onFsmcAccess` — the MCU writes LCD
  command/data over FSMC BANK1 (RS decoded from the address line) and a JS
  `FsmcLcd` class accumulates its command register + framebuffer. This is exactly
  the path real firmware takes (MC11 register writes = what compiled C emits).
- Tests: `tests/test_tim_remap.mjs` (TIM2_REMAP=01, CH2 -> PB3: a PA1 rising edge
  must NOT capture, a PB3 rising edge MUST capture -> exactly one TimCapture{2,1}),
  `tests/test_fsmc_display.mjs` (virtual LCD receives reset cmd + 3 pixels in order).
  Both wired into CI. `docs/STM32F1_API.md` updated (remap note).

### 19. WebSocket bridge: headless Node emulator + browser viewer (`pkg/ws-server.mjs`, `site/ws-viewer.html`) [committed]
- **`pkg/ws-server.mjs`**: Node HTTP static file server (`site/`) + WebSocket at
  `/ws`. Loads firmware via `createEmulator()`, runs `emu.step(20000)` at ~60fps
  (`setInterval`), drains `drainEvents()` + `takePinEvents()` (Array.from for
  correct JSON serialization), broadcasts as JSON to all connected clients. Receives
  `uart_rx`/`gpio_set`/`can_inject` commands from clients. Flags: `--port`, `--max`.
  Idle when no clients connected. Rebuild requires `npm install ws` (runtime dep).
- **`site/ws-viewer.html`**: Standalone browser page that auto-connects to the WS
  server. Decodes all 22 event types (SPI/I2C/USART/EXTI/ADC/TIM/DAC/CRC/RTC/
  WDG/CAN/FSMC/USB/Alert/host). Renders: UART terminal, GPIO pin grid (click to toggle input),
  event log, FPS/instruction counter. Reconnects on disconnect.
- **Usage**: `node pkg/ws-server.mjs <firmware.elf> [--port=8080]`, then open
  `http://localhost:8080/ws-viewer.html` in a browser.
- **Committed** as `224a65a`. `pkg/.gitignore` updated with `!ws-server.mjs`.

### 20. SDIO host + SDHC card image + DMA2 completion fix (`src/peripherals/sdio.rs`, `src/ext_devices/sd_card.rs`, `src/peripherals/dma.rs`, `src/system.rs`, `src/lib.rs`, `pkg/emulator.js`, `pkg/cli.mjs`, `tests/test_all.mjs`) [committed]
- **SDIO** @ 0x40018000, IRQ 49, SDHC-only (CCS=1): CMD0/2/3/6/7/8/9/12/13/16/17/18/24/25/55 + ACMD41 (busy-first power-up), 32-word FIFO window, DATAEND/DBCKEND/CMDREND/CMDSENT/CTIMEOUT + MASK-gated IRQ, DCOUNT/FIFOCNT. Commands complete synchronously on CPSMEN (all firmware timeouts generous); unknown CMDs get lenient R1; no card → CMDSENT/CTIMEOUT. `SdCard` ext device (`add_sd_card('SDIO', data)`): CID/CSD/OCR/RCA derived, CSD capacity from image size; `ext_devices.sd_card` + cli `sd_card:` config (file/size).
- **DMA2 completion was broken**: completion streams/IRQ tables were sized 8 with local channel indices, so DMA1 CH4 and DMA2 CH4 both claimed stream 3 and DMA1's tick drained DMA2's bits — DMA2 ISR/CNDTR never completed (nothing had driven DMA2 concurrently before, so it never showed). Streams are now GLOBAL (DMA1 ch0-6 → 0-6, DMA2 ch0-4 → 7-11): `do_xfer` maps by name, ticks take only their own bits (`dma_take_completions_masked`), tables siz 12, `dma_set_completed_many` loops 0..12. JS pump untouched (passes plan bits through). SDIO issues one `dma_request(11)` (DMA2 CH4) per transfer; TX finalizes when DLEN bytes land in the FIFO path, RX drains from the image — polled and DMA share one implementation.
- **Verified**: 277/277 unit (41 SDIO: init sequence, block R/W + read-back, IRQ49, DMA2 pump absorb of real image bytes + TCIF4/CNDTR clear, no-card timeouts, F103-SVD registration); full gate green (canary 39/39, cli + emulator.js 200M 39/39, all event/format/esm/ws/browser tests).

### 21. Coverage-audit leftovers: WWDG EWI (proven), PVD, RTC fix, tamper, RCC clocks, USB FS device (`src/peripherals/{wwdg,pwr,rtc,rcc,bkp,usb}.rs`, `src/peripherals/{mod,exti,gpio}.rs`, `src/system.rs`, `src/lib.rs`, `pkg/{emulator,stm32f1}.js`, `tests/test_all.mjs`, `tests/test_stm32f1_api.mjs`, `tests/arduino_periph_test/`, `docs/COVERAGE.md`) [committed]
- **Audit corrections first**: WWDG EWI was already implemented (added the missing test — 5 asserts green, no src change); TIM9–11 `timer_base()` entries were already present (audit claim wrong, compiler caught the duplicate). Real gaps fixed below.
- **PVD** (`pwr.rs`, EXTI line 16): fixed 3.3 V supply model — PVDO follows PVDE, edges fan out via new `Peripherals::exti_line_edge()` (same IMR/RTSR/FTSR gating as GPIO, no port check; shared `fire_line()` core) → PVD_IRQn (1). PVDO bit made read-only. Tested rising + falling + read-only (6 asserts).
- **RTC second/overflow + flag overhaul** (`rtc.rs`): fixed a mirrored CRH bit-order mistake (code AND test firmware both had ALRIE/SECIE swapped — RM0008: SECIE=0/ALRIE=1/OWIE=2, verified against the manual): alarm gate → bit 1, new per-second SECF + IRQ (SECIE), wrap OWF + IRQ (OWIE), CRL SECF/ALRF/OWF with write-0-clears, CRH mask widened to 0x07 (OWIE was unwritable). Firmware fixed (`CRH = 2`, handler clears ALRF) and rebuilt (arduino-cli; eeprom images restored; `canRxArmed` stable at 0x200000bc); canary still 39/39.
- **Tamper** (`bkp.rs`, `gpio.rs`): BKP remapped to the RM0008 layout (DR1-10 @ 0x04-0x28, RTCCR @ 0x2C, CR @ 0x30, CSR @ 0x34 — was DR[20] @ 0x04-0x50 with RTCCR/CR/CSR at 0x00/0x58/0x5C; caught the stale RTCCR unit test too). TPE/TPAL edge detection on PC13 input edges (new `bkp_tamper()` fan-out from `set_input_pin`; output-driven LED unaffected), event clears all DRs, TEF+TIF, TAMPER IRQ (2), W1C via CTEF/CTI. Tested active-high/low, silent-when-off (9 asserts).
- **RCC clocks** (`rcc.rs`): decoded SYSCLK/HCLK/PCLK1/PCLK2 from CFGR (SW/PLLSRC/PLLMUL/HPRE/PPRE, HSE assumed 8 MHz) via new `rcc_clocks()` trait method + `rcc_sysclk_hz()` export (72 MHz PLL×9 verified). Deliberately no timing rescale: 1 instr = 1 cycle keeps TIM/ADC exact, and rescaling SysTick/USART would 9× every delay loop and break all firmware instruction budgets.
- **USB FS device** (`usb.rs`, ~420 lines): EP0-7R with hardware toggle semantics, CNTR masks, ISTR (W0C flags; CTR/DIR/EP_ID derived from endpoint state), DADDR, BTABLE, 512 B PMA with byte-exact access (PMA window exempted from bus word-lane logic), RESET on FRES release + IRQ20, SETUP/OUT injection (NAK unless VALID, DTOG sequencing) via `usb_inject_setup/out`, IN completion drained as `UsbIn` (discriminant 18) + `onUsbIn` in `STM32F1` + `usbInjectSetup/Out` on the emulator. No SOF engine/suspend/wakeup/double-buffer. USB window sized 0x800 in both maps (registers + PMA). Tested end-to-end at register level incl. a full SETUP→descriptor-IN→bulk-OUT flow (~45 asserts) + `onUsbIn` dispatch.
- **Verified**: 354/354 unit; full gate green (canary 39/39, cli + emulator.js 200M 39/39, all 16 event/format/esm tests, ws_bridge, browser speed).

### 22. MPU fast path: recover the 30% enforcement cost (`src/system.rs`, `src/cpu/{mem,mod}.rs`, `src/peripherals/scb.rs`, `src/lib.rs`, `docs/CPU.md`)
- **Symptom**: after the nesting+MPU milestone the 200M run slowed 2.7s → 3.9s (~50 MIPS). A/B-isolated with a git worktree at 80bb77e (old wasm + old fw = 2.69s; new wasm + old fw = 3.86s) → 100% in the wasm sources, 0% firmware/machine-load. `node --cpu-prof` + `false &&` short-circuit builds proved the MPU gate calls were the entire delta (2.59s gated-out).
- **Dead ends (all measured, none recovered)**: struct-copy → field-level Cells (3.95→3.84s, copies weren't it); `#[inline(always)]` + `#[cold]` slow outlines (→3.50s); static flag mirror, atomic→plain load, `cold_path()` hints (→3.44s). Lesson: ~1B gate evals/run make ANY per-access call shape cost ~30% in V8 regardless of leanness.
- **Fix (3.44→2.82s, ~70 MIPS, full enforcement intact)**: zero-call fast path (plain-static `MPU_ON`, synced on init + MPU CTRL writes) + outline ALL cold arms (`mpu_check_*_slow`, periph byte arms, exec-fault construction) so hot skeletons stay JIT-inlinable + raw fetch (exec_allow = data-read predicate + XN ⇒ allowed fetch bytes are data-readable by construction; re-gating them re-checked a proven predicate twice per fetch). Residual ~5% over gates-compiled-out is the honest cost of real enforcement. Details in docs/CPU.md "Memory protection".
- **Verified**: `tests/test_all.mjs` 372/372 (incl. MPU paths), cargo cpu:: 16/16 + mpu 4/4, canary 39/39, cli 200M 39/39 @ 2.82s, emulator.js 200M 3/3, all 11 event/format/esm suites green. Pre-existing note: `cargo test --release --lib ext_devices::sd_card::block_rw_round_trip` fails at HEAD too (slice OOB, SDHC image size — untouched by this change, out of scope).

### 23. Sticky ORE wedged UART RX + IABR active-bit leak (`src/peripherals/{usart,nvic}.rs`, `src/cpu/mod.rs`, `tests/test_all.mjs`) [committed]
- **Symptom**: echo demo printed the first messages, then a long line (≥17 chars at once) killed UART RX permanently — only the 17th byte overflowed the 16-deep FIFO, but nothing ever echoed again. Isolated headless: 16/16 bursts healthy, 17/17 bursts 0/17 with zero recovery over +100M instr.
- **Root cause (real bug, HW-verified semantics)**: the model's ORE bit was set-on-overflow but never cleared. RM0008 clears ORE on an SR-read + DR-read sequence; with sticky ORE, HAL's error path dropped every later byte forever (firmware kept cycling — uwTick advanced — just starved). Fix: `sr_read_armed` flag (set by guest SR read, consumed by guest DR read which clears ORE). Post-fix bursts behave like real HW: first 16 echo, overrun bytes lost, UART recovers, follow-ups echo.
- **Companion fix**: `get_next_pending_intr` set IABR active bits on dispatch but the pop-only return never cleared them (phantom-active IRQs visible to firmware). `exception_return` now clears its own entry's bit via new `clear_active_bit()` (external IRQs only; SVC/NMI/HardFault have no IABR bit).
- **Verified**: `tests/test_all.mjs` 392/392 (+20 ORE assertions); burst24 headless 16/24 + recovery; canary 39/39; cli 200M 39/39 @ 2.92s (perf intact); emulator.js 3/3; stm32f1 + ws_bridge green.

### 24. CPU verification track 1: decoder census + probe battery (`src/cpu/{census,isa_tests,thumb}.rs`, `tests/census_16.py`, `tests/census_32.py`) [committed]
- **16-bit census**: `cpu::census` executes all 65,536 halfwords sterile (odd regs + odd-preloaded mem so valid indirect branches succeed; SVC/BKPT/UDF bucketed as traps) and diffs vs Capstone M-class → **0 gaps, 0 over-accepts** outside the reviewed ACCEPTED list (v8-M bxns/blxns, even-target bx/blx/add/mov-pc that fault like HW, UNPREDICTABLE IT-zero-mask hints, reserved-bit BX/BLX/CPS/PUSH/POP/STM variants). Gate: `cargo test --release --lib cpu::census && python3 tests/census_16.py` (exit 0).
- **32-bit census**: structured sample (every first halfword × 256 seconds) + per-family rules (correctly-faulting FPU/copro/DSP/MVE/v8-M/HVC/SMC/UDF.W, capstone-loose BL/op2 + sbfx-hw1, Rd==PC even-target, reserved SYSm, msb<lsb BFI, UNPREDICTABLE store/load-RtPC, STM-W0 noted) → **0 gap samples outside rules**. Over-direction informational only (compilers never emit reserved combos; mis-decodes are caught by probes, not census).
- **Probe battery** (`isa_tests.rs`, 22 tests, Capstone-locked encodings, exact regs/flags/mem asserts): T3 S-forms, T3 i-bit, MRS/MSR full SYSm, SBFX/UBFX/BFI/BFC, LDRD/STRD (+post-indexed), UDIV incl. div0, LDREX/STREX pair + fail case, TBB/TBH, BL, LDMDB/IB/DA, USAT-ASR, RBIT/CLZ, PLD/PLI vs LDR-pc-literal, DBG.
- **Real decoder bugs found & fixed**: MSR PRIMASK/CONTROL/APSR guard (`0x8800`→`0x8000`; old code fell into the branch decoder as a wild branch — silent mis-decode); STREX always-success (new single-global exclusive monitor + CLREX + clear on exception entry/return); LDMDB+W wrote start instead of end; LDM IB/DA keyed off P not U (both swapped); T3 Rn==PC always literal (reg/imm `[11:10]` heuristic broke negative literals); PLD/PLI forms NOP (reg/imm8/literal, incl. F9-signed-RtPC which has no LDRSB encoding); USAT-ASR (0xF3A0, previously SUB garbage); DBG hint NOP.
- **Verified**: cpu:: 34/34 (incl. 22 probes), census dumps + both gates green, test_all 392/392, canary 39/39, cli + emulator.js 200M 39/39 @ ~2.9s (perf intact), event/format/esm suites green.

### 25. Flag-lifecycle audit: the ORE bug class, systematically (`src/peripherals/{usart,spi,i2c,tim,adc}.rs`, `tests/test_all.mjs`) [committed]
- **Method**: for every status bit in the big-5 peripherals, verify BOTH the set-condition and the clear-condition exist and are tested. Bits the model sets-but-never-clears wedge firmware (ORE proved it); bits never set at all are benign (firmware reads 0; document).
- **USART**: ORE fixed last sprint (SR→DR sequence via `sr_read_armed`). TXE/RXNE/TC managed; IDLE/PE/FE/NE/LBD/CTS never set (no error injection; IDLE-line RX noted as future work, not a wedge risk).
- **SPI**: RXNE/TXE managed; OVR/MODF/BSY/CRCERR never set (transfers complete synchronously, so no overrun can occur) — benign, documented.
- **I2C — real bug found & fixed**: BTF was set when ITBUFEN cleared mid-transfer but cleared NOWHERE except full reset → stuck EV re-pends for the rest of the transfer (HAL clears ITBUFEN near every transfer end, so this fired constantly). Fix: clear BTF on DR read + DR write (transfer progress), matching RM0008. AF is set-on-NACK and clears on next START/reset (not W1C — benign: HAL never reuses AF state across transfers). OVR/BERR/ARLO/PECERR never set (benign).
- **TIM**: UIF/CCxIF set + W0C-cleared (`sr &= value`) ✓; TIF/COMIF/BIF/CCxOF never set (slave/motor features, out of scope) — benign.
- **ADC**: AWD/EOC/JEOC/JSTRT/STRT set + cleared (EOC on DR read, rest on SR write; SR uses direct-assign `= value & 0x3F`, equivalent to W0C for sane firmware); F103 has no OVR bit — N/A.
- **Recovery-test template** (new standard for error states): force the error, assert the flag, exercise the clear sequence, assert normal operation resumes. Added I2C-BTF block (7 asserts: SB→ADDR→Active→BTF set→DR-write clears→STOP clean→bus reusable; device on 0x51 so the later NACK-at-0x50 test still NACKs; `reset_ext_devices()` after to leave no residue).
- **Verified**: test_all 399/399; full gate + perf re-run at commit.

### 26. CoreMark known-answer check + UMLAL/SMLAL decoder fix (`tests/arduino_coremark/`, `tests/test_coremark.mjs`, `src/cpu/thumb.rs`, `pkg/emulator.js`) [committed]
- **Port**: upstream CoreMark 1.0 sources + Arduino sketch (Serial1 output, millis() timing, 200-iteration CI config; `main`→`coremark_main`, `ee_ptr_int` stays 32-bit for ARM). Rebuild: `arduino-cli compile --fqbn STMicroelectronics:stm32:GenF1:pnum=BLUEPILL_F103C8 --build-path tests/arduino_coremark/build tests/arduino_coremark`; ship `site/arduino_coremark.elf` (force-add) + CI copy step (build/ is ignored).
- **Real decoder bug found by it**: soft-float `__muldf3` uses UMLAL (hw1 `0xFBE0`), which faulted — our FB block only had UDIV/SDIV opcodes. Fixed: new op-`0xC` (SMLAL) + op-`0xE` (UMLAL) arms; arm-9 SMLAL fallback removed (plain op-9 is invalid); dead-wrong arm-13 (SDIV/SMLAL at DSP-only `0xFBDx`) now faults. Before the fix CoreMark wedged in `WWDG_IRQHandler`'s default spin (UNDEFINSTR→HardFault, CFSR-verified) — a good reminder that any decode gap lands in the default-handler spin, not a loud error.
- **Proof (three-way agreement)**: emulator @200 = native-x86 same-sources @200 = bit-identical (list/matrix/state/final); list/matrix/state also match the PUBLISHED 1.0 values (0xe714/0x1fd7/0x8e3a). Full 2000-iter emulator run matches published list/matrix/state too; seedcrc/final differ from the 1.0 publication on BOTH backends identically (upstream recipe drift, not emulation — differential proof dominates). CI asserts crclist/crcmatrix/crcstate/crcfinal + completion (~200M instr).
- **Drive-by fix**: `pkg/emulator.js` `symSorted` was never declared — the fault reporter itself crashed (`ReferenceError`) on any decode gap without symbols; declared + reset in `setSymbols`.
- **Verified**: test_coremark 5/5; cpu 35/35; census gates green; test_all 399/399; emulator.js + ws_bridge green.

### 27. Differential fuzz vs Unicorn oracle + 10 decoder fixes (`tests/fuzz_diff.py`, `src/cpu/diffuzz.rs`, `src/cpu/thumb.rs`, `src/cpu/isa_tests.rs`, `tests/census_*.py`) [this sprint]
- **Harness**: `gen_cases` samples census-'0' encodings (60/16-bit, constrained regs/flags, IT always 0 at setup — Unicorn miscounts stops with preset IT) → `/tmp/fuzz_cases.txt` → Rust worker (`diffuzz_exec`: installs snippet at 0x20002001, `run(1)`, FNV-1a over flash+RAM) vs Unicorn oracle (same image/code/regs, `ctl_flush_tb` per case — mem_write doesn't invalidate the TB cache). Compares r0-r12, SP/LR/PC(&~1), xPSR-NZCVQ, memhash, fault bit.
- **Triage policy** (all in `fuzz_diff.py`): unmapped branch targets / data addrs / flash stores → expected (ours returns-0/drops, oracle faults; PC legitimately differs so the whole case skips); capstone-MCLASS-rejected → expected (over-accept philosophy); DSP/UMAAL shapes (oracle advances-without-write, we fault) → expected; STREX (oracle INSN_INVALID without reservation) + Rn==Rt-writeback (UNPREDICTABLE, load-wins vs writeback-wins) → resample at generation; both-faulted → r15 skipped (fault-PC reporting differs); LDRD-pc target resolution; bx/blx even-target → expected (we fault like HW).
- **10 real decoder bugs found & fixed** (each oracle-isolated before fixing): SSAT/USAT shift = imm3:imm2 (`o2[14:12]:o2[7:6]`, not `o2[14:10]`), 16-form discriminator (`o2[15:12]==0 && o2[7:4]==0`), reserved `o2[5]` + ASR-#0 faults; flag-setting logicals (AND/BIC/ORR/ORN/EOR/TST/TEQ incl. MOV/MVN-imm/reg) now write C=shifter-carry (`nzc`); T3 Rn==PC is always the negative literal (`(pc+4)&!3-imm12`, stores UNDEFINED); EA/EB `o2[15]==1` reserved (shift is imm3:imm2, bit15 hardwired 0); long multiplies need `o2[7:4]==0` (else DSP/UMAAL space); SBFX/UBFX `lsb+w>32` UNPREDICTABLE; LDM writeback = START address for DA/DB loads (was base) + Rn-in-list+WB faults + P==U (SRS-space) faults; LDRD-into-PC interworks; BLX reserved-lowbits validated before LR write; STRD writeback-to-PC stands (no adv clobber); ADDW/SUBW-Rd==PC faults.
- **Bcc.W model (the subtle one)**: J1=`o2[11]`, J2=`o2[13]`, used DIRECTLY with no S inversion — unlike B.W (`NOT(J^S)`, J1=`o2[13]`/J2=`o2[11]`). Triple-verified (oracle + capstone + GCC firmware: F000:A880→+0xC0100, F416:8C8C→0x1ff9891c, F47F:A741→0x1ff81e86, firmware F040:80CA→0x80013d2). A prior "B.W-style inversion fix" broke firmware boot (differs exactly on S=0 forward wide conditionals); the bogus probe asserting it was rewritten with oracle-verified ±0x10 cases.
- **Census updates**: 16-bit ACCEPTED_GAPS += 14 blxns-shape ranges (bit2 set); 32-bit `accepted_gap` += WIDE_IMM_PC (movw/movt/addw/subw/adr Rd==PC), EA/EB-o2[15], DSP-long names (umaal/umlalbt…), sbfx/ubfx width, LDM-Rn-list-WB, pop-SP-list, LDRD-RnPC-WB + LDRD-pc-dest rules.
- **Verified**: fuzz 2700 cases (200/s1 + 500/s7 + 1000/s11 + 1000/s42) 0 divergences; cpu 42/42 (incl. 3 new probes: bcc_w_backward_s1, unpredictable_shapes_fault, fixed ldmdb_forms); census gates green; test_all 399; canary 39/39; cli + emulator.js 200M 39/39 @ ~2.9s (~69 MIPS, perf intact); coremark 5/5; all 16 event/unit suites; browser 4/4.
- ~~**Known backlog (single sub-threshold census sample, out of scope)**: E8DF LDREXB/STREXB shapes decode as STRD/LDRD on our side~~ — **closed next sprint (§29)**: proper LDREXB/H + STREXB/H decode with exact-address reservations.

### 28. Two more demo firmware: RTC clock + servo sweep (`tests/arduino_rtc_clock/`, `tests/arduino_servo/`, `site/index.html`) [this sprint]
- **`arduino_rtc_clock`**: register-level RTC (PRL=1M → 1 CNT/sec), preset 12:00:00, prints `HH:MM:SS  rtc=N` every tick + PC13 blink. **`arduino_servo`**: TIM3 CH1 (PA6) 50Hz PWM, 1–2ms pulse sweep 0→180°, prints `deg=`/`pulse=` + turn markers.
- Both use `Serial` (= USART1 → `getUartOutput`), no ext devices. Headless tests `tests/test_rtc_clock.mjs` (4: banner, ≥3 clock lines, starts 12:00:00, monotonic) + `tests/test_servo.mjs` (6: banner, ≥5 steps, starts 0, rising-or-180, pulse range, turn marker), both wired into `.github/workflows/test.yml`.
- Page: `rtc_clock` + `servo` preset options + loader branches (plain `initEmulator`, no devices); `tests/test_browser_demos.mjs` drives both presets live in Chromium (terminal shows `12:00:01` / `deg=10`).
- Ship `site/arduino_rtc_clock.elf` + `site/arduino_servo.elf` (force-add, `*.elf` is ignored); build dirs ignored in `.gitignore`. Rebuild: `arduino-cli compile --fqbn STMicroelectronics:stm32:GenF1:pnum=BLUEPILL_F103C8 --build-path tests/arduino_<name>/build tests/arduino_<name>`.
- **Verified**: rtc 4/4, servo 6/6, browser presets 2/2.

### 29. Track-2 fuzz + backlog + CI gates + 2 more demos [this sprint]
- **Track-2 differential fuzz** (multi-step, `tests/fuzz_diff.py` protocol v2 `ncode halfwords... steps`): IT+payload pairs (single-slot mask; predicated flag/C updates via `it_suppress`), LDREX/STREX word pairs (exclusive monitor across steps), 2-ALU chains (flag chaining with forced Rd→Rn, full-range regs), unaligned single-transfer bases (both sides byte-assemble identically, oracle-verified). Generator stays strict (mapped, no branches/PC) so any multi-step divergence is REAL, no triage.
- **Oracle quirks found & worked around** (all empirically pinned): joint count over an IT block overruns one halfword past a *skipped* payload (skipped insns advance PC without consuming a stop) → NOP pads + r15 skip for pairs; preset multi-slot ITSTATE mis-evaluates conds (cond3 INVERTED!) → single-slot only; preset single-slot is exact.
- **Real bugs found by track-2**: UDIV/SDIV Rd==PC adv-clobbered the quotient (now raw-write stands, oracle-verified); 16-bit mov/add-PC even-target needed the bx/blx triage rule.
- **Backlog**: LDREXB/H (`E8D0|Rn:(Rt<<12)|0xF4F`, size=`o2[4]`) + STREXB/H (`E8C0|Rn`, Rd=`o2[11:8]`, Rt=`o2[15:12]`) — shapes oracle-verified (capstone's entry is near-single-point); exact-address reservations (mixed-size pairs fail, matching oracle); previously mis-decoded as STRD/LDRD. NVIC STIR (`0xE000EF00`, WO, INTID 9 bits) routed in `Peripherals::read/write` so both maps get it without touching bus windows; tested via ISPR bit (deliverability gating noted).
- **Demos**: `arduino_dac_sine` (DAC1 CH1 16-pt sine → ADC1 CH4 loopback, tracks 155..3941) + `arduino_i2c_scan` (Wire probe, finds 0x3C+0x50) with headless tests (6/6, 4/4), page presets, browser presets (now 4/4), CI lines. Tests use `site/*.elf` directly (no build-dir copies in CI).
- **CI**: census gates (`capstone==6.0.0`, dump + both `.py`) + fuzz canary (200/seed1, `unicorn==2.1.4`) wired after unit tests.
- **Verified**: track-2 fuzz 2700 (200/s1 + 500/s7 + 1000/s11 + 1000/s42) 0 divs; cpu 43/43; census green; test_all 401/401; canary + 200M 39/39; coremark 5/5; all suites; browser demos 4/4.

### 30. Depth gaps closed + track-3 fuzz + CAN/stopwatch demos + version-proof CI [this sprint]
- **Peripheral depth** (each with unit tests in `tests/test_all.mjs`, docs in `docs/COVERAGE.md`): TIM BDTR/MOE/break/LOCK (MOE gates `pwm_duty`, BKIN PB12 clears MOE + BIF/BIE IRQ, AOE re-arms; DTG stored — no edge surface); ADC dual-simultaneous (DUALMOD=6 fans out, DR packs, lockstep force-complete); SPI CRC-8/16 (CRCNEXT phase + CRCERR); I2C PEC (CRC-8/SMBus + PECR + PECERR) + general-call ACK (GENCALL); USART LIN (SBK + LBD/LBDIE + FE, `uart_inject_break` export, EIE error IRQ); CAN TTCM timestamps (TXRQ/RX stamp TIME); FSMC NAND ECC accumulator (ECCR2/3, self-consistent); FLASH WRPRTERR (4KB blocks); GPIOE registered; RCC CSS (`rcc_fail_hse` → CSSF+NMI+HSI fallback, SWS-based clocks, STOP-exit HSI hook with `core_tests` wake test).
- **Fuzz track 3**: branch pairs (Bcond/B/CBZ/Bcc.W with NOP landing pads — cond evaluation now differential) + multi-slot IT (executed multi-slot verified exact on oracle; only preset is broken). Found: UDIV/SDIV-PC raw-write, F9-signed-RtPC genuine loads (not PLI), word-LDR-PC genuine (not PLD), T-form (o2[11:8]==0xE) loads, F9-register-RtPC hints, SBFX-family oracle gap (resample: Unicorn lacks the bitfield unit), T-form triage names, `.w`-suffix + `#0x` + alias triage robustness.
- **Demos**: `arduino_can_chat` (CAN1 LBKM loopback self-talk; needed a BTR LBKM mask fix — mask had stripped bit 30) + `arduino_stopwatch` (PB13 EXTI + TIM2, headless button-press test with the idle-high-first harness note). Headless 4/4 + 5/5, page presets, browser 6/6, CI lines; tests use `site/*.elf`.
- **CI reality check**: local capstone is a mutated 5.0.9→6.0.0 install (PyPI has no 6.0.0 final!) — stock 5.0.9 differs (UDF decode, sb/sl/fp/ip aliases, `msreq`/`mrseq`, `#0x` targets). Gates now pass on BOTH (alias normalization, msreq/mrseq/adr/UDF accepts, `#`-tolerant parse); CI pins stock `capstone==5.0.9` + `unicorn==2.1.4`. `docs/summary.md` left frozen (declares itself historical).
- **Verified**: track-3 fuzz 2700+1700 (all seeds incl. branch pairs) 0 divs; cpu 44/44; census green both versions; test_all 464/464; canary + 200M 39/39; coremark 5/5; all suites; browser 6/6 + page.

### 31. USB device depth + CDC serial demo + page USB host [this sprint]
- **USB depth** (`src/peripherals/usb.rs`, `src/peripherals/mod.rs`, `tests/test_all.mjs`): SOF engine (1 ms frames, FNR + RXDP, SOF/SUSP/WKUP IRQs, wakeup IRQ42, 3-frame auto-suspend, RESUME recovery), double-buffered bulk endpoints (DTOG-selected blocks, stay VALID across first fill); test_all 488/488.
- **CDC demo** (`tests/arduino_usb_cdc/`, `tests/test_usb_cdc.mjs` 22/22, CI line): register-level CDC-ACM (EP0 control + EP1 bulk echo). Real firmware bug found via the 2-packet config descriptor: EPnR RX-service writes cleared a pending TX CTR (write-0-clears) before the TX branch ran — helpers now write 1 to the opposite CTR (write-1-no-effect preserves it); rule documented in `docs/PERIPHERALS.md`.
- **Page USB host** (`site/index.html` + `site/worker.js`): `usb_cdc` preset + USB card (Enumerate button runs the full host sequence as a frame-driven state machine; EP1 echo box); worker `usbSetup`/`usbOut` cases + per-frame UsbIn forwarding (gated by `usbListen`, correct discriminant skipper incl. UartTx); `tests/test_browser_demos.mjs` now 7/7 (live enum + echo asserted).
- **Verified**: full gate green (test_all 488, canary 39/39, cli 200M 39/39, emulator.js 3/3, cpu 44, census both, fuzz canary, coremark 5/5, formats/esm/ws/bus-tap, all event/demo suites, browser 17+7).

### 32. TIM DMA burst + PWM wave demo + two SysTick rate fixes [this sprint]
- **TIM DMA burst** (`src/peripherals/tim.rs`, `tests/test_all.mjs` 497/497): DCR DBA/DBL window — each DMAR write routes through the normal write path into DBA+idx and wraps every DBL+1 transfers; DCR reprogram restarts; OOB/DMAR-alias stores only (no infinite recursion: routed offsets never re-enter the arm). 9 unit asserts (4-ch landing, wrap, single-repeat, restart).
- **Demo** (`tests/arduino_pwm_wave/`, `tests/test_pwm_wave.mjs` 6/6, CI line, page preset, browser 8/8): TIM3 CH1 PA6 PWM + DMA1 CH3 single-buffered bursts (CNDTR=1 re-armed per 100ms frame) stepping an 8-duty triangle; UART `duty=N ccr=N` with readback proving the burst landed. Browser needle uses single spaces (terminal spans collapse runs).
- **SysTick debt drain was dead after the native cutover** (`src/cpu/mod.rs::exception_return`): the old JS `finish_interrupt(-1)` `while take` drain never moved to Rust, so multi-period batches delivered 1 tick max (millis ~14× slow at 1M steps; 20K production batches were unaffected). Fix re-pends exactly ONE per return — whole-debt drains coalesce into the single pending bit and lose ticks (measured 2-of-3 at 216K).
- **SysTick phase loss** (`src/peripherals/nvic.rs`): `last_systick_trigger = n` discarded up to a batch of overshoot per tick (28% slow at 50K adaptive batches, 10% at 20K — the §8 "75/6M ≈ 83" baseline was measuring this bug). Now `+= ticks*period`. Raw `run()` uwTick 17→28/2M exact.
- **Debug discipline reminder**: a stale `uwTick` address (0x20000098 from a previous build; current 0x20000090) cost a long detour — resolve ELF symbols fresh per build (project rule); PC sampling aliases on small loops (verify with instCount deltas + UART).
- **Interrupt dispatch hardening** (same root cause hunt): exact-SysTick shifted alignment and exposed two latent issues — (a) lazy `dispatch_interrupts` (smoke) and `rustcpu_dispatch` (all production paths) consulted the INTR_MASK statics snapshotted at batch start, dispatching into `noInterrupts()` critical sections when a batch ended inside one — both now re-sync live PRIMASK first; (b) inline delivery bypassed the 64-IRQ budget entirely, so print-heavy slices (USART1 TX takes, hundreds per slice) starved the firmware. Inline now routes through `intr_next()` (shared cap, counts takes not polls). Verified the budget fix alone flips the inline run (CAN change stashed → still green).
- **Nested-return root cause FOUND + fixed** (`src/cpu/mod.rs::exception_return`, `src/cpu/core_tests.rs::deep_nesting_canaries_unwind_exactly`): returns unstacked from the `msp`/`psp` BANK variables, but in handler mode r13 IS the stack — after a nested return the bank still pointed at the consumed inner frame, so the outer return unstacked handler-pushed registers as a frame (garbage retpc → NOP-slide into unmapped space → phantom reboots with peripheral state intact, e.g. sticky SWIER failing later passes). F1 (nested) and F9 (thread-MSP) returns now unstack from live r13 (exactly what silicon does); only FD (PSP) uses the bank, which task switches retarget. Proven by 4-deep nesting with per-level canaries (exact order, intact registers, full unwind) — this was the §32 derailment all along, merely contained (not fixed) by the budget cap.
- **CAN TX IRQ edge-trigger** (separate, independently motivated): the level arm watched TSR bits 24-26, which are CODE/TME per CMSIS — TME0 is set at reset, so ANY TMEIE-enabled run re-pended CAN1_TX (IRQ19) on every later CAN event write. Now pends once on TXRQ-submit and on TMEIE-rising-with-completion-latched (W1C clears); 5 unit asserts incl. no-re-pend. (Investigation note: takes first attributed to a CAN storm were USART1 TX traffic — IRQ37 is USART1; verified the budget fix alone flips the inline run with the CAN change stashed.)
- **Verified**: test_all 502; pwm_wave 6/6; full gate re-run at commit.

### 33. CAN edge-trigger + gap sweep + I2C slave + mini-RTOS [this sprint]
- **CAN TX IRQ edge-trigger** (`src/peripherals/can.rs`, 5 unit asserts): covered in §32.
- **Gap sweep** (test_all 507/507): SCB ACTRL @ 0xE000E008 as RW store (mask 0x7, STIR-style routing so both maps get it; COVERAGE score now 40 Full); ADC temp sensor nominal 0x1F8 → 0x6EE (old value was 0.41V ≈ −63°C, comment claimed 25°C — V25 = 1.43V → 1774). TI frame format / SMBus ALERT / USB isochronous stay documented gaps (no consumer).
- **I2C slave mode** (`src/peripherals/i2c.rs`, `src/lib.rs`, `pkg/emulator.js`, 19 unit asserts → 526/526): `SlaveAddr`/`SlaveActive` states + host inject API (`i2c_inject_start/write/read/stop` → `i2cInject*`): OAR1/OAR2 + general-call match, ADDR/STOPF sequences (STOPF via SR1-read-arms-CR1-write), RXNE/TXE + EV IRQs, NACK/None stretch-equivalents (RXNE-unread, TXE-empty, ACK-cleared), no slave DMA, 10-bit still out. Demo `arduino_i2c_slave` (Wire @ 0x42, 11/11 headless) + page host card (worker cases + single-flight ack sequencer; `postMessage` can't clone op closures — send explicit fields) + browser live write/read + CI. HAL quirk noted: first slave-read serves nothing (priming transaction needed — identical on silicon, test does write-then-read).
- **Mini-RTOS demo** (`tests/arduino_mini_rtos/`, `tests/test_mini_rtos.mjs` 6/6, CI, preset, browser): hand-rolled 2-task preemptive kernel (PSP stacks, naked PendSV save/restore + `orr lr,#4` EXC_RETURN reshape + CONTROL.SPSEL, TIM4 1ms HardwareTimer tick, LDREX/STREX spinlock prints). Gap-free seqs prove context integrity; 200-tick cadence proves rate. Bugs found in the DEMO (not the model): C++-mangled `PendSV_Handler` never installed (vector hit the weak default spin — `extern "C"` required, incl. for asm-referenced globals); TIM7 doesn't exist on C8 (TIM4 instead). Model insight re-verified: pending bits coalesce intra-batch events (one delivery per batch per IRQ) — headless tests must use production-sized batches (20K), never 1M steps, for rate-accurate runs.
- **Verified**: full gate re-run at commit.

### 34. I2C 10-bit + SD logger + exception-policy tests + hygiene [this sprint]
- **I2C 10-bit** (`src/peripherals/i2c.rs`, 6 unit asserts → 532/532): OAR1 mask widened to ADDMODE+ADD[9:0], full-10-bit slave match (no 7-bit aliasing), master headers NACK (no 10-bit peers — correct, reserved range); inject addr widened u8→u16. COVERAGE I2C row closed.
- **SD data-logger demo** (`tests/arduino_sd_logger/`, `tests/test_sd_logger.mjs` 8/8, CI, preset, browser): register-level SDIO init + per-RTC-second ADC-temp sample, CMD24 log + CMD17 read-back verify (`log N rtc=R adc=A ok`); ADC shows live RC charging curve to nominal. Page preset ships a blank 1MiB SDHC image.
- **Exception-policy tests** (`src/cpu/core_tests.rs` 10/10): same-priority non-nesting (0x1234), priority-ordered dispatch, bad-EXC_RETURN faults, SysTick debt re-pend-once-per-return (pins the §32 fix natively). No Unicorn differential: the oracle runs generic ARM without M-profile stacking (cortex-m3 bring-up probed, dropped as binding-fragile) — noted in `fuzz_diff.py`.
- **Hygiene**: removed dead `stretch_until` (never assigned; transfer-level NACKs are the stretch model — doc paragraph removed too), AGENTS header date/counts refreshed, NVIC coalescing guidance in PERIPHERALS, `i2cInject*` in USAGE.
- **Verified**: full gate re-run at commit (browser local 15/15; 3 gh-pages tests need external network).

### 35. Nested-return root cause + ISO proof + maintenance audit [this sprint]
- **Derailment: TRUE root cause found in `exception_return`** (`src/cpu/mod.rs`): F1/F9 returns unstacked from the stale `msp`/`psp` bank variables, but in handler mode r13 IS the stack — after a nested return the bank still pointed at the consumed inner frame, so the next return unstacked handler-pushed registers as a frame (garbage retpc → NOP-slide through unmapped space → phantom reboots with peripheral state intact, e.g. sticky SWIER failing later passes). F1 (nested) and F9 (thread-MSP) now unstack from live r13 (exactly what silicon does); only FD (PSP) uses the bank, which task switches retarget. The §32 budget cap merely contained it (fewer nestings → rarer corruption). Proven by new `deep_nesting_canaries_unwind_exactly` (4 priority levels, per-level canaries, exact 0x13578642 order, full SP unwind). Hunt notes: the takes first blamed on a CAN storm were USART1 TX traffic (IRQ37 is USART1; CAN1_TX is IRQ19); several self-inflicted test bugs along the way (M-bit push/pop encodings, BEQ/BNE inversion, SWIER line-vs-bit, literal offsets, stale symbol addresses).
- **USB isochronous proven** (5 asserts → test_all 537/537): ISO OUT/IN move data exactly like bulk; TYPE stored, no SOF-gating. COVERAGE USB rows closed (no data-path gaps left).
- **Maintenance audit**: deps stay pinned deliberately (capstone 5.0.9 / unicorn 2.1.4 — oracle parity); CI already covers 4 suites this agent initially missed (`test_i2c_busy`, `test_dma_requests`, `test_dma_signals`, `test_slave_pwm_dma2` — all green, unaffected by I2C/CAN/TIM changes); browser-launch failures traced to /tmp contention on this box (TMPDIR workaround, CI runners unaffected); TI frame format / SMBus ALERT / USART IrDA-smartcard documented as no-consumer gaps (IrDA is pulse-shaping-invisible at register level).
- **Verified**: full gate re-run at commit.

### 36. Chip variants: GD32 toggle + board options [this sprint]
- **No SVD needed**: GD32F103 is register-identical at everything modeled, so
  variants are a chip table (`pkg/emulator.js` CHIPS: flash/RAM sizes +
  DBGMCU IDCODE), not a new map. New `set_dbg_idcode` export + minimal
  `DBG_IDCODE @ 0xE0042000` readout (Peripherals-level routing, STIR/ACTRL
  precedent; init() resets it to the F103 ID). Timing stays
  instruction-budget based on every chip (108 MHz changes nothing).
- **Chips**: stm32f103c8 (default, unchanged), stm32f103cb, maple_mini,
  nucleo_f103rb, stm32f103rc (256K/48K), gd32f103c8/cb/rb (IDCODE
  0x2BA01477). Page selector + main-thread size plumbing fixed to pass
  names through (was hardcoded to f103c8 sizes).
- **Tests**: `tests/test_chips.mjs` 9/9 (IDCODE per chip + GD32 UART echo
  round-trip), CI line, browser chip-option assertions. README refreshed
  (stale Unicorn-era numbers → 70M IPS, 537 tests, current depth).
- **Board pinouts**: `site/board_pins.json` (Arduino aliases extracted from
  STM32duino 2.12.0 variants: Nucleo D13=PA5/A0=PA0, Maple D33=PB1/button
  PB8, Pill D17=PC13) shown in the page GPIO grid; pin asserts in
  test_chips (15/15) + live browser alias check. Maple Mini shares the
  Pill variant except its own header map — verified, not assumed.
- **Per-board demo firmware** (`tests/arduino_board_demo/`, 8/8 headless,
  4 browser presets, CI): one sketch (LED_BUILTIN + board-name banner via
  ifdefs) compiled per FQBN (BLUEPILL_C8, MAPLEMINI_CB, NUCLEO_F103RB,
  GENERIC_F103RCTX) and booted on its chip; page presets set chip+ELF
  together. Caught a real bug: the worker hardcoded 64K/20K sizes,
  starving F103RC's 48K-RAM stack (browser wedged, headless passed) —
  worker now inherits sizes from the chip table like the main path.
- **Verified**: full gate re-run at commit (no behavior change for existing
  firmware: nothing addressed 0xE0042000 before; default IDCODE is the
  real F103 value).
- **Protocol/chip verification matrix** (one-off, not all in CI): the Bluepill-
  targeted periph39 firmware passes **39/39 on all six chips** (f103c8,
  gd32c8/cb, maple_mini, nucleo_f103rb, f103rc) — protocols are identical
  across variants by construction (same map; only sizes/IDCODE differ).
  Real arduino-cli firmware for other targets boots + echoes on its chip:
  MAPLEMINI_F103CB → USART1 echo OK; GENERIC_F103RCTX + NUCLEO_F103RB →
  USART2 echo OK (their `Serial` is USART2, `uart_addr` opt selects it).
  No GD32 Arduino core installed locally — GD32 runs identical F103
  binaries (the clone contract), covered by the GD32 boot+echo test.

### 37. GDB stub + boards docs/UI + npm 2.1.0 [this sprint]
- **GDB RSP stub** (`pkg/gdbstub.mjs`, `stm32f1-emu/gdb`, 16/16 via a Node
  RSP client): regs/mem/step/continue/BKPT/target.xml over TCP. Needed new
  surface: `memWriteBytes` (bypasses flash protection via new
  `rustcpu_mem_write_raw`), `takeFault` (execBatch snapshot), `setReg`
  (`rustcpu_set_reg`). Real bugs found by writing it: RSP reg numbers are
  decimal (not hex), Thumb breakpoint addrs need masking (not reject),
  flash writes are MPU-protected (BKPT patch needs the raw path).
- **Boards**: `docs/BOARDS.md` matrix (chips, IDCODEs, pinouts, verified
  runs incl. DFU-layout offset boot); page stats bar shows live chip
  (`label · ID … · flash/RAM`, IDCODE read from the model); F105 object
  carries its IDCODE too. `site/board_pins.json` ships in the package.
- **Release**: version 2.1.0, CHANGELOG entry, `files` + `exports` cover
  gdbstub/board data, `.d.ts` updated (CHIPS/chipInfo/i2cInject/mem/takeFault).
- **Verified**: full gate re-run at commit.

### 38. Website remake + docs pages + headed screenshot gate [this sprint]
- **Demo page**: hero strip (stats chips, CTA buttons), Docs/About nav,
  fixed a real pin-label overlap bug (left labels drew into the PCB;
  end-anchored + widened viewBox), stats-row wrap. All demo machinery
  untouched (deliberately no rewrite — regression risk for zero gain).
- **Docs pages** (`site/docs.html` hub + `docs-boards/debugging/api.html`,
  shared header/footer/nav): condensed from the markdown sources with
  links back (no content fork). `about.html` nav aligned.
- **Verification** (`tests/test_browser_site.mjs`, CI line): every static
  page loads headed with zero console/page errors + screenshots to
  `test-results/`; demo↔docs nav round-trip asserted. Found live: ws-viewer
  dials a missing server (allowlisted with comment), nav URL assertion.
- **Verified**: 8/8 headed (screenshots reviewed: hero, docs hub, boards,
  API, live blink 283M instr @ 47 MIPS with aliases in grid).

### 38. Dual-CAN demo + real GDB + deeper fuzz [this sprint]
- **CAN2/F105 demo** (`tests/arduino_can_dual/`, `tests/test_can_dual.mjs`
  5/5, CI, preset, browser): CAN1+CAN2 loopback self-talk on the F105 SVD
  map — the one modeled feature with zero demo coverage. Each CAN keeps
  its own filter bank in the model (silicon shares them; documented).
- **Real GDB vs the stub** (arm-none-eabi-gdb 15 from the Arduino toolchain,
  `tests/gdb_live_session.sh` dev-only): full session green (connect, regs
  with symbols, mem, break loop, continue→hit, stepi, detach). Found by a
  real client: `qXfer` exact-match broke on offset reads (now offset/length
  aware) and GDB 15 rejects minimal target.xml while its default ARM layout
  matches our 17-reg `g` exactly — so `qSupported` no longer advertises
  qXfer (endpoint still served). Test client 17/17.
- **Deeper fuzz**: 300 cases seeds 2+3, 0 divergences after triage. Seed 3
  found E842/F2F2 (STREX with Rt==PC, UNPREDICTABLE: oracle faults, we
  execute status-1): capstone mis-decodes it as `ttat`, defeating the
  mnemonic-based STREX resample — fixed with structural
  `skip_excl_rt_pc` (LDREX/STREX Rt==PC + STREX Rd==PC). 1100 cases total,
  0 real divergences.
- **Verified**: full gate re-run at commit.

### 39. Docs as website: markdown viewer + sync + freshness guard [this sprint]
- **Viewer** (`site/doc.html?f=*.md`, dependency-free): tables, code fences,
  nested image-links (README badges), cross-doc links rewritten to viewer
  routes, TOC + heading anchors, error state for bad names. `site/docs.html`
  is now a manifest-driven hub (zero drift by construction). Hand-written
  `docs-boards/debugging/api.html` deleted (superseded).
- **Sync** (`site/sync-docs.mjs`): mirrors the 16 user-facing markdown files
  into `site/docs-src/` + `site/docs.json` (Pages deploys only `site/`, so the
  viewer can't reach `../docs/` live). CI fails on drift
  (`node site/sync-docs.mjs && git diff --exit-code`), same discipline as
  the wasm byte-exact guard. Edit the `.md` source, run the sync, reload.
- **Verified**: 8/8 headed (viewer routes + error state + screenshots
  reviewed: hub, boards, API, tables, badges, no duplicate H1;
  CPU.md → PATH_B.md click-through with correct title).

### 40. Real-stack USB: BTABLE stride + PMA window + SETUP-always-ACK + SOF-activity + EP2-IN echo [this sprint]
- **BTABLE stride was 8, silicon is 16** (`src/peripherals/usb.rs`): ST's F1 HAL
  (`PCD_SET_EP_*` macros, `PMA_ACCESS = 2`) puts DESC0 ADDR/CNT @ +0/+4 and
  DESC1 @ +8/+12 per endpoint (single: TX=DESC0/RX=DESC1; DB: DTOG picks).
  Proven 4 ways (header macros, `USB_ActivateEndpoint` disasm, IRQ-handler
  read sites, live `PMA[8]=0x20` = app's EP0-RX address). Data buffers are PMA
  words with 4-byte APB spread. Unit-test pokes + `arduino_usb_cdc` demo
  firmware ported to the ST layout (it was written against the old one).
- **PMA window is 1024 B, model had 512** (`PMA_BYTES`, `0x400..0x800` range):
  Arduino CDC-IN buffer @ word 288 lands at window offset 576+ — silently
  dropped before. Bus maps already covered `0x40006000-0x40006400`.
- **SETUP always ACKed** (`deliver_rx`): F1 silicon accepts SETUP while NAK —
  the ST stack never re-arms RX after status-IN transfers (found by watching
  EP0R stick at RX-NAK after SET_ADDRESS kill enumeration).
- **SOF is bus activity** (`tick_usb`): auto-suspend on transfer-idle wedged
  enumeration (`dev_state` stuck SUSPENDED=4 → SET_CONFIG CtlErrors). An
  attached host's SOFs always reset the 3 ms timer; suspend is now
  FSUSP-forced only. Unit tests reworked (SOF-keeps-awake + FSUSP traffic
  semantics instead of idle-suspend).
- **Arduino CDC is EP1-OUT/EP2-IN/EP3-CMD** (not EP1-IN): read off the live
  config descriptor after chasing a phantom IN stall for hours. Test listens
  on EP2; banner + `Hi` echo verified byte-exact.
- **Verified**: `test_usb_serial.mjs` 11/11 (was 2/7), `test_usb_cdc.mjs` 22/22,
  `test_all.mjs` 590/590, wasm rebuilt pinned + `site/` synced.
- Debug discipline used: resolve ELF symbols fresh per build (a stale
  `uwTick` addr cost a detour in §32 too), `memRead32` for RAM
  (`periphRead` on SRAM returns bus zeros — burned an hour on phantom
  `dev_state=0`), check `drainEvents` discriminants before blaming the model.

### 41. USB gaps closed + FRES truth + serial page preset [this sprint]
- **CNTR FSUSP is bit 3, PDWN is bit 1** (`src/peripherals/usb.rs`): the
  old tests keyed FSUSP on bit 1 (silicon PDWN) — worked only because no
  PDWN gate existed. Fixed the bit in model + tests; PDWN now genuinely
  gates (no RX/TX/IRQs/SOF, FRES release under PDWN raises nothing).
- **Isochronous depth**: STALL writes dropped on ISO endpoints, CTR pends
  HP vector 19 (LP 20 keeps the rest; both funnel to one HAL handler).
- **DADDR filter**: optional `addr` on `usb_inject_setup/out` (absent =
  correctly-addressed host); wrong-address packets drop like silicon.
- **Detach**: new `usb_detach()` export (+`usbDetach()` JS, `.d.ts`) —
  tokens stop, IN never completes (VALID sticks), SOF freezes, FNR RXDP
  clears; `usb_bus_reset()` reattaches (also wakes suspend).
- **FRES release is NOT a bus reset** (ISTR RESET = SE0 on the wire):
  removed the pseudo-reset — pre-boot SETUPs raced it and wedged
  enumeration permanently (proven headless: inject-from-frame-0 never
  recovered). Page enumerator now sends a real bus reset first (new
  worker `usbReset` case + step -1 settle + step-0 reset fallback),
  retries SETUPs host-style, parses config `wTotalLength` (Arduino: 67B).
- **Page `usb_serial` preset** (`site/index.html`): real STM32duino
  firmware, EP2-IN echo mapping (`usbEchoEp`), stream-tail echo match
  (the sketch echoes byte-by-byte — exact per-packet match could never
  hit), banner-vs-echo disambiguation. Browser: usb_cdc + usb_serial
  green; `tests/test_browser_demos.mjs` covers the new preset.
- **Release**: CHANGELOG 3.0.1; `test_usb_serial.mjs` wired into CI.
- **Verified**: `test_all.mjs` 623/623, usb_cdc 22/22, usb_serial 11/11,
  stm32f1_api 9/9, wasm rebuilt pinned + `site/` synced.
- Remaining USB non-gaps (documented): F105 needs a whole second USB IP
  (Synopsys OTG_FS — different peripheral, like ETH: unmapped by design),
  ESOF never fires under an always-attached host, SOF-gating of ISO is
  firmware-managed (shared bulk mechanics suffice — proven by enumeration).

### 42. F105 USB OTG_FS device mode + bare-metal CDC proof [this sprint]
- **New `src/peripherals/otg.rs`** (~950 lines): Synopsys OTG_FS core
  registers, GRXSTSP status queue (SETUP/OUT received+completed, like
  silicon back-to-back), EP0-3 FIFOs at `0x50001000+EP*0x1000` (word
  access), three-level interrupt masking (DIEPMSK/DOEPMSK -> DAINT ->
  DAINTMSK -> IEPINT/OEPINT), suspend/resume (SDIS/RWUSIG/SGONAK/CGONAK),
  IRQ 67. One shared instance owns regs+FIFOs (SVD splits GLOBAL/HOST/
  DEVICE/PWRCLK — `from_svd` registers once, skips the rest). Host block
  inert (MMIS on touch); no-DMA regs read 0; TXFE never fires.
- **Key semantic vs the FS model**: ST stages DIEPTSIZ + EPENA *before*
  pushing FIFO data, so IN completes when pushed bytes reach XFRSIZ
  (zero-length when XFRSIZ == 0 with PKTCNT set) — not on the EPENA edge.
- **Bugs found by writing it** (all fixed + tested): DCFG has no EF bit
  (filter compares DAD directly); `name_has_tick` needed the OTG name or
  the SOF engine never ticks; test-side periph_write arg order.
- **Bare-metal proof** (`tests/otg_cdc/`, xpack-gcc 14.2.1 + custom
  linker script, ships `site/otg_cdc.elf`): register-level CDC-ACM
  (EP1-OUT/EP1-IN/EP3-CMD) enumerates + echoes through real machine code
  (`tests/test_otg_cdc.mjs` 23/23). Real debugs along the way: OUT data
  must be read on received (not completed) statuses or zeros clobber the
  buffer; multi-packet IN collapses to one completion (no continuation);
  SETUP bypasses the XFRSIZ-armed check.
- **Page `otg_cdc` preset** (F105 + EP1 echo): worker `otgSetup/otgOut/
  otgReset` cases, backend-aware sends, `wTotalLength`-parsed config.
  Page-driver hardening shared with the FS enumerator: bus-reset-first
  flow, per-stage NAK-driven + periodic resends, ack-gated OUT sends,
  stream-tail echo match. Browser: usb_cdc + usb_serial + otg_cdc green.
- **Verified**: `test_otg.mjs` 76/76, `test_otg_cdc.mjs` 23/23,
  `test_all.mjs` 623/623, usb_cdc 22/22, usb_serial 11/11, canary 39/39,
  wasm rebuilt pinned + `site/` synced.

### 43. F105 USB OTG_FS host mode + bare-metal HCD proof + RCC audit [this sprint]
- **New host model** (`src/peripherals/otg.rs`, ~+450 lines): 8 channels
  (HCCHAR/HCSPLT/HCINT/HCINTMSK/HCTSIZ, CHENA-edge arming, CHDIS halt
  with CHHLT + HCHALTED status), DFIFO0-3 shared windows (device EP n
  and host ch n share window n; each side completes only when itself
  armed), HCFG/HFIR/HFNUM/HPTXSTS/HAINT/HAINTMSK/HPRT (attach/detach/
  PPWR/PRST/PENA/PCDET edges), RXFIFO + GRXSTSP shared with device
  mode, SOF engine, `HostTx` (disc 20) / `HostRx` (disc 21) events,
  `otg_host_feed_in` / `otg_host_attach` (+JS + `.d.ts`). CSFTRST
  preserves `host_attached` (silicon keeps the PHY — a pre-boot attach
  otherwise boots into an E0 spin; proven by the page flow, unit
  assert added).
- **Bare-metal proof** (`tests/otg_host/`, xpack-gcc + link.ld +
  build.sh, ships `site/otg_host.elf` 7384B): register-level HCD
  (port reset, SETUP + IN + status OUT on ch0, bulk OUT ch1 / IN ch2,
  exact-path RAM `trace[]` 1..8). `tests/test_otg_host.mjs` 5/5
  (exact trace, byte-exact echo, HPRT set, HFNUM moves), CI line.
- **Real firmware races found by writing it** (all in the DEMO, model
  vindicated each time — verified by PC traces + raw-slot dumps):
  XFRC-first IN loops return 0 without draining (fix: drain-first);
  the feed's DONE status double-counts per-BCNT drains (fix: PKTSTS
  gate) and FIFO word padding over-counts short transfers (fix: n from
  HCTSIZ.XFRSIZ remaining); batch-boundary stale-register window
  (GINTSTS load pre-feed + XFRC check post-feed exits undrained —
  fix: complete-then-recheck, provably live since XFRC=1 implies
  post-feed); `trace_n` must be `volatile` (gcc -Os kept it in a
  register across the bulk block, hiding pushes 6..8 from the host).
  Debug discipline re-confirmed: NEVER hide build output (`>/dev/null`
  concealed a failing gcc for ~10 cycles — brace duplication shipped
  no binary change); read raw trace slots, not just `trace_n`.
- **Page `otg_host` preset** (F105 + scripted virtual device + live
  HCD trace in the USB card): worker `otgHostAttach`/`otgHostFeed`
  cases + HostTx/HostRx/trace forwarding, `pendingPreInit` deferral
  (worker messages interleave across `await createEmulator` — a
  load-time attach ran against null emu and was swallowed by
  try/catch). Browser: preset green end-to-end in ~1.3s
  (`test_browser_demos.mjs` +1).
- **RCC audit**: new `rcc_clocks_hz()` export (sys/hclk/pclk1/pclk2) +
  5 divider/multiplier vectors (72/36/18/9 prescaled, x2/x16 edges,
  HSE/2, max dividers 72M/140625/8789); decode deliberately timing-free
  (§21 no-rescale decision stands).
- **Release**: `package.json` 3.0.0 → 3.0.1 (the pending 3.0.1 sync;
  OTG stays under Unreleased); `npm publish --dry-run` clean
  (606.1kB, 20 files; no registry creds on this box — publish stays
  with the maintainer).
- **Verified**: `test_otg.mjs` 119/119, `test_otg_host.mjs` 5/5,
  `test_all.mjs` 629/629, wasm rebuilt pinned + `site/` synced;
  full gate re-run at commit.

### 44. Gap sweep: builtin-map HD/CL superset + 18 peripheral gaps [this sprint]
- **Map extension** (`src/peripherals/mod.rs`): UART4/5, TIM5, ADC3, CAN2,
  OTG_FS join the builtin F103 map (superset rule like DAC/FSMC/SDIO) +
  RCC clock-gate entries (dormant `clock_enabled`, as before). Verified:
  periph39 still 39/39 (new windows collide with nothing); 17 new unit
  asserts (UART4 event, TIM5 count/UIF, ADC3 convert, CAN2 mailbox, OTG
  attach/detach). Side catch: `tests/test_all.mjs` JS-peripheral scratch
  base moved `0x40006800` → `0x40008000` (CAN2 claimed it).
- **DMA circular + HTIF** (`dma.rs`): CNDTR latched at EN rising edge;
  CIRC completions set TCIF+HTIF, reload NDTR, keep EN (continuous).
- **Small batch**: GPIO LCKR sequence + nibble freeze; AFIO SWJ_CFG
  debug-pin reservation (PA13–15/PB3–4 per mode); 96-bit UID constant
  (Peripherals-routed, writes ignored); `rcc_mco_hz()` export (100/101/
  110/111 = SYSCLK/HSI/HSE/PLL/2); FLASH OBR USER settable + WDG_SW
  hardware-watchdog effect; PVD PLS thresholds vs `pwr_set_supply_mv`;
  standby (PDDS) wake gating (WKUP/RTC only) + WKUP/PA0→WUF fan-out;
  SPI NSS hardware output (SSOE); CAN silent + silent-loopback;
  TIM1 DTG dead-time narrowing; ADC discontinuous chunks + JAUTO (also
  fixed a real pre-existing bug: SQR1 length read [19:16] instead of
  [23:20], so multi-channel regular sequences always ran as length-1).
- **Medium batch**: ITM stimulus port 0 (`itm.rs`, `ItmByte` disc 22,
  TER+TCR gated, all JS tables + docs); SDSC byte addressing (HCS=0 →
  ARG/blocklen, CSD v1, CCS-clear OCR); USB ESOF on detach (mask-gated);
  TI/IrDA/smartcard/sync verified byte-identical (covered by
  construction) + transfer tests; PVD/PWR test rewrite to threshold
  semantics.
- **Docs**: per-board feature matrices updated (new rows Full, no Gap
  cells left); PERIPHERALS one-clause notes; `rcc_clocks_hz` +
  `pwr_set_supply_mv` + `rcc_mco_hz` exports.
- **Verified**: `test_all.mjs` 719/719, `test_otg.mjs` 120/120,
  canary + cli 200M 39/39, coremark 5/5, census + fuzz green, browser
  32 + 4 + 15 green. Out of scope kept: ST-Link/printer/GD32
  quirks/ETH (hardware/transports), IrDA/TI kept as verified-identical.
  (DFU left the list this sprint — see §45.)

### 45. Maple-style USB DFU bootloader [this sprint]
- **Firmware** (`tests/arduino_dfu/arduino_dfu.ino`, Arduino sketch on
  `maple_mini`, ships `site/arduino_dfu.elf` force-add): register-level
  FS USB device speaking DFU DNLOAD/UPLOAD/GETSTATUS/GETSTATE/CLRSTATUS/
  ABORT + SetAddressPointer + manifest, EP0 state machine ported from the
  proven CDC scaffolding (CTR write-1-no-effect discipline, rest-armed
  RX). wTransferSize 64, blocks 0=commands/manifest and ≥1=data at
  pointer+(N-1)*64. Downloads stage to a 2KB RAM buffer resolved from ELF
  symbols (guest flash stores drop in `FlatMemory::write8_raw_unchecked`
  — verified in `src/cpu/mem.rs`) while the real unlock/program/BSY
  sequence runs. MPU off by default so flash stores can't fault.
- **Real firmware bug found by writing it**: `flash_program`'s BSY poll
  spins forever — the model asserts BSY while PG is set but guest stores
  bypass the peripheral, so no completion ever clears it. Dropped the
  poll (PG set/clear retained); model untouched (BSY-while-PG is correct
  silicon behavior).
- **Test bug found by writing it**: `syms.find(includes('dfu_trace'))`
  matches `dfu_trace_n` first (shifted view: `[5,1,2,3,3]`) — whole-
  identifier regex now (`dfu_stage` vs `dfu_staged` had the same trap).
- **Page `dfu` preset** (Maple Mini + scripted host download of a .bin
  file or default 128B pattern, live progress + manifest status): worker
  needed NO changes (usbSetup/usbOut/UsbIn paths already exist); new
  `usbDfu` state machine duplicates the generic enum steps so the CDC
  path is untouched. Deferred worker `pendingPreInit` pattern re-verified
  unnecessary here (attach happens at firmware boot, feeds post-ready).
- **Verified**: `test_dfu.mjs` 51/51 (enum, states, 2 DNLOAD blocks with
  byte-exact staged readback, UPLOAD readback, manifest trace+state,
  error→ABORT recovery); browser preset green end-to-end (~5s); CI line
  added. Maple matrix DFU rows flipped to Full.

### 46. SWD/JTAG debug-port slice + GDB Z2/Z3/Z4 [committed]
- **Scope**: transaction-level DP host API, not pin modeling (GPIO is
  push-pull only; clocked SWDIO + turnaround would need electrical-model
  changes and ~1B wire events/run — evaluated, rejected).
- **New `src/peripherals/swd.rs`** (`SwdState` on `WasmSystem`): SWD DPv1
  (DPIDR `0x2BA01477`, CTRL/STAT ACKs + sticky W1C, SELECT, RDBUFF) +
  MEM-AP (CSW `0x23000052` SIZE/AddrInc, TAR auto-inc, DRW data port,
  BD0-3/CFG/BASE/IDR) + Cortex debug (DHCSR DBGKEY/C_HALT/C_STEP,
  synchronous DCRSR/DCRDR incl. MSP/PSP, DEMCR TRCENA + VC_HARDERR halt)
  routed from the SCB window 0xF0-0xFC on both maps (STIR/ACTRL/IDCODE
  precedent, no bus window) + 4 exact-range data watchpoints
  (halt-after-access, first-trip-wins latch) + minimal JTAG TAP (IDCODE
  `0x4BA00477`, BYPASS/DPACC/APACC/ABORT) sharing the DP file.
- **Hot path**: plain-static `DEBUG_HALT` (run loop) + `WATCH_ON`
  (guest read8/write8 only; fetches bypass via read16_raw) mirrors —
  200M still 2.84s (~70M IPS, cost unmeasurable).
- **Real bugs found by writing it**: watch length field contaminated by
  kind/valid bits on decode (len masked to 28 bits); CSW SIZE is
  bits[2:0] (not [3:1]); test-side `0x5008`-is-STR-not-STRB snippet bug
  (stored to r1+r0, off-watch — immediate `0x7008` used); RSP lengths
  are hex (`Maddr,C:` for 12 bytes).
- **GDB** (`pkg/gdbstub.mjs`): Z2/Z3/Z4 → slots, `T05watch:/rwatch:/
  awatch:` stop reasons, `c` resumes a halt, `s` steps past a halt.
  `tests/test_gdbstub.mjs` 17 → **35/35** (live strb/ldrb snippets).
- **Real-client bugs found by arm-none-eabi-gdb 15** (synthetic client
  missed them): RSP `p`/`P` numbers are HEX (`Pf`=PC — decimal parse
  silently dropped `set $pc`, trips then came from firmware's own
  writes); `G` (write-all) implemented, any `Hc`/`Hg` accepted. Proven:
  `watch *(char*)0x20000100` → Old 0 New 170, stop after the store
  with r0=0xAA/r1=addr, delete+continue → trailing BKPT SIGILL.
- **Docs**: GDB.md slice section, PERIPHERALS Debug row, all 6 board
  matrices Debug→Full + DWT row points at the slice; `site/` synced.
- **Verified**: cargo lib 80/80 (11 new swd), test_all **736/736**
  (+17 SWD; harness now inits the native backend for `swd_*`),
  canary 39/39, cli + emulator.js 200M 39/39, census + fuzz green,
  coremark/chips/otg/dfu/all event+demo suites green, browser 34 + 8.

### 47. Interpreter/memory speed sprint (this session; uncommitted review below)
- **Wide-access fast paths** (`src/cpu/mem.rs`): `read16/32`, `read16_raw`,
  `write16/32` re-ran the full gate set per byte; now one region resolve
  per access with exact per-byte slow fallbacks (MPU/watch armed,
  straddling/unmapped tails, `bad`-address parity preserved).
- **Devirtualized interpreter** (`src/cpu/mod.rs`, `src/cpu/thumb.rs`):
  `run`/`exec16`/`exec32`/exception paths take concrete `FlatMemory`
  (sole implementor) instead of `&mut dyn Memory`.
- **Micro-cuts**: `is_periph` one-compare reject below `0x40000000`,
  `get_unchecked` after proven containment.
- **Reverted, not shipped**: single-entry data-read cache (gen counter +
  denylist + ~40 invalidation sites) — same-process interleaved A/B
  (both binaries, alternating windows) measured it exactly neutral
  (0.96–1.02); N=1 polls never hit and fatter accessors regressed
  byte-heavy code up to 2x. Lessons in CHANGELOG; needs A/B proof to retry.
- **Measured**: all 40 `site/*.elf` ≥50 MIPS headless-facade (min 50 dfu,
  bulk 60-90, fsmc 107); six fresh arduino-cli sketches 54-82 headless and
  **62-108 in real Chromium** (worst spixfer 62). Browser speed test green
  (76/102 MIPS, no console errors).
- **Toolchain round (follow-up, same sprint)**: wasm-opt `-O3` via
  `[package.metadata.wasm-pack.profile.release]` (+4-12%, flows through
  the pinned toolchain so CI reproduces it byte-exact) and rustc
  `opt-level = 3` (was `"s"`, +3-16%, dfu +16%). Binary 1.27MB → 1.42MB
  pre-gzip. Post-toolchain: custom 62-82 headless / **72-115 in Chromium**,
  shipped 59-114 headless, periph39 speed test **111-112 in Chromium**.
  Full gates re-greened on the shipped binary; `pkg/`↔`site/` re-synced.
- **Verified**: test_all 797/797, canary 39/39, coremark 5/5,
  emulator.js 3/3, cpu 50/50, `pkg/`↔`site/` mirrors synced.
- **Fetch32 + dispatch reorder (follow-up, same sprint)**: run() fused the
  two halfword fetches into one `fetch32_raw` region resolve (exact
  fallback at edges/periph windows); exec16's 40-arm `if`-chain reordered
  by measured frequency (HI/BLX, Bcc, LDRlit, LDR first; SVC/UDF pinned
  before Bcc — the only order constraint, proven by exhaustive 65K-opcode
  simulation with 0 diffs). Clean interleaved A/B (15 reps, quartiles):
  oled +30%, compute +25%, showcase +31%, coremark +18%, dfu +13%,
  spixfer +8% — every quartile above 1.0. (An earlier +8–29% reading was
  confounded by leftover measurement counters in one binary; the clean
  re-run with counter-free binaries on both sides is the trustworthy one.
  Same-process interleaving + verified binary provenance are now the
  documented bar — see the box-load note below.)
- **Superoperators v1 (follow-up, same sprint)**: 4 fused 16-bit pairs
  (LDRlit+LDR, SUBreg+CMP-reg, CMP-imm+Bcc, LSL-imm+Bcc) via an `o2n`
  lookahead; shape-only guards inside the first arm (`it_n==0` fallback,
  DF00/DE00 trap exclusion); exec returns guest counts (0/1/2). Proof:
  5 native differential suites (~65K pair-cases, fused vs `fusion_off`,
  full-state compare) + census 0-gap both widths + fuzz seeds 1+4
  0 divergences. In-binary A/B (same wasm, on vs off): oled +14%,
  showcase +16%, coremark +5%, dfu +3%.
- **Superoperators v2 (follow-up, same sprint)**: 19 more pairs from a
  static Capstone pair census over all 44 shipped ELFs (branch-first
  pairs excluded — static adjacency isn't dynamic sequence); shared
  second-op tails + verbatim first-bodies. Fixed 3 real hazards with
  tests: mid-pair fault/halt interlock (swd watch tests caught it),
  `q != 0` on LSL-second checks (edge-fallback sentinel), fusion_off in
  fixed-step harnesses (run_snippet, diffuzz — pattern padding itself
  fuses, e.g. 0x2323). Proof: 19 new differential suites (~125K cases),
  lib 104/104, census + fuzz green. In-binary A/B (v1+v2 on vs off):
  oled +21%, showcase +22%, coremark +4%, dfu +1%, nothing regresses.
- **Superoperators v3 (follow-up, same sprint)**: 12 more pairs from a
  temporary execution-weighted census (hot loops, not cold code):
  (CMP-reg,Bcc), (LDR,BX), (LDRlit,CBZ), (PUSH,LDRlit), (POP,LSL),
  (HI-MOV,HI-MOV), (STR,HI-MOV), (ADD-hi,Bcc), (HI-MOV,ADDS),
  (ADDS,CBZ), (LDRB,HI-MOV), (EXTEND,Bcc). Hardened all branch tails
  (`fused_branch_done`: faulting BX retires 0 with pc2 record, op1
  advanced — the differential caught a post-fault r15 gap). Proof: 12
  new suites (~150K cases), lib 116/116, census + fuzz green. In-binary
  A/B: oled +20%, showcase +19%, coremark +18%, periph +23%, dfu +5%.
- **Superoperators v4 (follow-up, same sprint)**: tail sweep — (LDR,STR)
  (vindicated dynamically), (PUSH,HI-MOV), (PUSH,LDR), (STR-sp,LDR-sp);
  halfwords dropped on evidence (~2 static). No separate measurable
  delta (box noise) — kept on safety proof + pair weight. 40/40 fused,
  lib 120/120, all gates green.
- **Phase 0 attribution (100-MIPS floor)**: peripheral model single-digits
  (MEMFREE in-binary A/B: dfu +2%, coremark +4%, control ±2–8%); dfu
  dispatch ~20–25% via fusion response ⇒ decode-table alone caps ~+25%
  on dfu — Phase 2 mandatory, Phase 1 justified for periph-likes. Batch
  sweep: 20K≡100K, 500K breaks 2 checks ⇒ stepping ~0%, 20K stays.
- **Phase 1 decode table**: 40-arm chain → classify + 64KB table +
  br_table executor (bodies verbatim, no invalidation needed); top-5
  fast-path tags (65K-exhaustive proof) + unchecked load. A/B: oled
  +14%, showcase +13%, coremark +5–8%, dfu +7–8%, periph flat. lib
  121/121, census + fuzz green, all gates green.
- **32-bit push.w/pop.w hoists**: dfu is ~1/3 32-bit (dynamic census);
  shared `ldm_stm_body` + exact-shape hoists. Native per-op +7–8%;
  wasm firmware-level below box resolution — kept on per-op proof +
  safety with revert trigger. lib 123/123, all gates green.
- **fast_tag second wave**: 7 more hot first-ops (LSL/MOV/B/CBZ/PUSH/
  POP/STR) skipping the table load. Native per-op -2–20% (controls
  exactly 1.000); wasm below box resolution — same keep-standard as
  hoists, with revert trigger. Exhaustive 65K proof + all gates green.
- Box-load discipline learned the hard way: single-shot MIPS on a shared
  box swings ±40% (esbuild + headless-Chrome co-tenants here); only
  back-to-back A/B ratios and `.filter`-free medians are trustworthy —
  verify with `node /tmp/opencode/ab2.mjs`-style interleaving, never
  sequential before/after runs.



## Next Phase — Long-term Optimizations
1. ~~**Replace mem hooks with shared linear memory**~~ — **retired (moot)**: `uc_mem_map_ptr(mem, periph_range)` would remove the JS crossing, but peripheral access was measured at 0.001 accesses/instruction (~0.1% of runtime) — no measurable win available
2. ~~**DMA + interrupts fully in Rust**~~ — **LANDED**: `rustcpu_dma_pump()` + `rustcpu_dispatch()` run fully in Rust against Rust RAM (zero JS round-trips).
3. ~~**Pure-Rust Cortex-M core — "Path B" (deferred)**~~ — **LANDED (see `docs/PATH_B.md`)**: vendored interpreter in `src/cpu/`, 39/39 both backends pre-cutover, ~3.5x faster, Unicorn deleted.

## Files Most Relevant
- `src/peripherals/i2c.rs` — I2C state machine
- `src/lib.rs` — WASM API; new exports
- `pkg/cli.mjs` — main loop (stdin/DMA/run/tick/dispatch/CAN/watchdog), hi2c Mode patch, fault gate
- `src/peripherals/usart.rs` — TXE byte-time pacing, `rx_pending()`
- `src/ext_devices/spi_flash.rs`, `src/peripherals/spi.rs`, `src/ext_devices/touchscreen.rs` — touchscreen SPI reads (deferred_reply)
- `src/peripherals/gpio.rs` — electrical model (`pin_level()`), slew (`pending_transitions`), `read_pin_effective()`; `set_input_pin()` fires EXTI edges (page-driven button widgets → attachInterrupt works)
- `src/peripherals/scb.rs` — deep sleep, SHPR routing, `raise_fault()`
- `src/peripherals/fsmc.rs`, `src/ext_devices/fsmc_nor.rs` — FSMC banks + backing
- `src/peripherals/adc.rs` — real conversion state machine
- `tests/arduino_periph_test/` — the 24-peripheral firmware (39 checks incl. SVC/PendSV) + config
- `tests/arduino_hw_showcase/` — 7-device live demo firmware (OLED 0x3C, SPI LCD CS PA8, 7-seg 74HC595 via SPI1+PA4, RGB TIM2 PWM PA0-2, buzzer PB14, button PB13 EXTI13) — build `tests/arduino_hw_showcase/build/arduino_hw_showcase.ino.elf`; ship `site/arduino_hw_showcase.elf` (force-add)
- `site/index.html` — `showcase` preset (`newString`/`oldString`); 7-seg is a JS-side shift-register decode: `onPeriphWrite` watches SPI1 DR (0x4001300C) while PA4 CS is low (GPIOA ODR/BSRR/BRR tracking), latch 4 bytes → `segDigits`; OLED/LCD render from `emu.i2cOledFb('I2C1',0x3C)` / `emu.lcdFb('SPI1')`; button widget calls `emu.gpioSetInput(1,13,true/false)`
- `pkg/ws-server.mjs` — WebSocket bridge server (HTTP static + WS streaming + emulation loop)
- `site/ws-viewer.html` — browser WebSocket viewer (event decoder, UART terminal, GPIO grid)