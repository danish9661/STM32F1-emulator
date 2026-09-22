# Handover — STM32 Bluepill WASM Emulator (`danish9661/STM32F1-emulator`)

> Read this file first, then `AGENTS.md`. This file is the session handover:
> repo state, what just landed, what is left, and the exact todo list to load.
> Facts below were verified against the tree at write time (HEAD `c538a18`
> + staged-but-uncommitted audit sweep, see §2).

---

## 1. What this repo is (30-second version)

Full-system emulation of an **STM32F103C8 (Blue Pill)** running **real,
unmodified Arduino/STM32duino firmware**, in **one WASM module**
(`pkg/stm32_bluepill_wasm_bg.wasm`):

1. **Native Rust CPU** (`src/cpu/`) — ARM Cortex-M3 Thumb-2 interpreter +
   guest RAM (`FlatMemory`). Zero JS crossings per instruction. Unicorn TCG
   was the CPU before 2026-09 and is **deleted** (see `docs/PATH_B.md`).
   Unicorn survives ONLY as the test-time differential-fuzz oracle
   (`tests/fuzz_diff.py`, CI pins `unicorn==2.1.4`) plus historical notes.
2. **Rust peripherals** — GPIO, USART, TIM, SPI, I2C, DMA, RTC, CRC, CAN,
   NVIC, EXTI, ADC, DAC, FLASH, PWR, BKP, IWDG, WWDG, FSMC, SDIO, USB FS,
   USB OTG_FS (F105), DWT/ITM, SWD/JTAG debug slice. Two maps agree on real
   F103 addresses: builtin hardcoded table + `from_svd()` (ships
   `svd/STM32F105xx.svd`; SVDs missing core blocks get NVIC/SysTick/SCB
   auto-registered at fixed `0xE000Exxx`).
3. **JS orchestration** (`pkg/emulator.js`, `pkg/cli.mjs`, `site/worker.js`,
   `site/index.html`) — per batch (`DEFAULT_MAX_BATCH` 20000):
   `rustcpu_dma_pump()` → `rustcpu_run(batch)` (exact count back) →
   `step_batch(count)` (peripheral tick, once per batch, instruction-delta)
   → `rustcpu_dma_pump()` → `rustcpu_dispatch()` (≤64 IRQs via `intr_next`).

Performance: **~70M IPS headless** (200M in ~2.9s) with full MPU enforcement
live. Do NOT attempt interpreter "optimizations" without a cpu-prof win:
the model is interpreter-bound (~97% in wasm `rustcpu_run`); prior
micro-opt attempts cost ~30% (see `AGENTS.md` "Performance" + `docs/CPU.md`).

---

## 2. HEAD state (staged sweep, NOT committed — house rule)

- Branch: `master`, HEAD `c538a18` (2026-09-14). Working tree: **staged but
  uncommitted** (`git add -A` done, no commit — user approval required).
  Staged set (14 files):
  - `AGENTS.md` (label + count refresh)
  - `docs/PERIPHERALS.md` + `site/docs-src/PERIPHERALS.md` (IWDG/WWDG/NVIC/ADC rows)
  - `pkg/stm32_bluepill_wasm_bg.wasm` + `site/stm32_bluepill_wasm_bg.wasm`
    + `site/stm32_bluepill_wasm.js` (pinned rebuild, see §3)
  - `src/lib.rs` (`clear_current_interrupt` now clears IABR too)
  - `src/peripherals/iwdg.rs` (tick + rebase arms)
  - `src/peripherals/wwdg.rs` (tick + rebase arms)
  - `src/peripherals/adc.rs` (rebase aborts in-flight conversions)
  - `src/peripherals/mod.rs` (`name_has_tick` += IWDG/WWDG)
  - `src/peripherals/nvic.rs` (`last_popped_clear_take`)
  - `tests/test_all.mjs` (736 → **764**, +28 asserts)
  - `HANDOFF_NEXT_AGENT.md` (this file — rewritten this session)
- Last committed: `c538a18` "Cleanup + bugfix sweep: drop Unicorn
  leftovers, GPIO IDR fast path"; before that `d30cc54` (board hardware in
  WASM: NRST/BOOT0/USR/LED + TXE-keep + TIM ARR/NVIC fixes), `1093d33` (CI
  publish-workflow version-bump tolerance), `1782d45` (SWD/JTAG debug slice
  + GDB Z2/Z3/Z4, release 3.1.0).
- Release: `package.json` **3.1.0** (`stm32f1-emu` on npm). `CHANGELOG.md`
  top entry is `[3.1.0]`. Do NOT bump versions unless the user asks.
- Gate status at handover (all green, re-verified this session):
  `tests/test_all.mjs` **764/764**, `tests/canary.mjs` 39/39,
  200M CLI 39/39 (~2.90s), `test_emulator_js.mjs` 3/3,
  `test_gdbstub.mjs` 35/35, `test_bootloader.mjs` 45/45,
  `test_board_buttons.mjs` 19/19, `test_coremark.mjs` 5/5,
  `test_chips.mjs` 16/16, `test_ws_bridge.mjs` 11/11,
  `test_dfu.mjs` 51/51, `test_otg.mjs` 120/120, `test_otg_host.mjs` 5/5,
  `test_otg_cdc.mjs` 23/23, `test_usb_cdc.mjs` 22/22,
  `test_usb_serial.mjs` 11/11, browser `test_browser_site.mjs` 8/8 +
  `test_browser_demos.mjs` 34/34. `cargo test --release --lib` 80/80.
  Census 16-bit 0 gaps, 32-bit gate exit 0; fuzz seeds 1+4 × 200 cases,
  0 divergences. (Full CI list: `.github/workflows/test.yml`.)

---

## 3. Toolchain — pinned, must match CI

- `rustc 1.97.1`, `wasm-pack 0.14.0`, `wasm-bindgen-cli 0.2.126`,
  **binaryen `version_132`** at `~/.local/binaryen/binaryen-version_132/bin/`
  (**persistent — NEVER `/tmp`**: the box wipes `/tmp`, wasm-pack then
  silently falls back to cached wasm-opt 117 → red CI; this bit us for
  3 commits on 2026-09-11/12).
- Build (exact):
  `PATH=~/.local/binaryen/binaryen-version_132/bin:$PATH RUSTFLAGS="--remap-path-prefix=$HOME=/build" wasm-pack build --target web`
  then `cp pkg/stm32_bluepill_wasm_bg.wasm pkg/stm32_bluepill_wasm.js site/`
  + `cp pkg/emulator.js site/emulator.js`. Verify the build prints
  `found wasm-opt at ...version_132...`. (This session's rebuild printed
  `found wasm-opt at ".../binaryen-version_132/bin/wasm-opt"` — good.)
- The `--remap-path-prefix` neutralizes `$HOME` in panic-location strings
  baked into the wasm data section — without it, CI's CODE-section
  byte-exact guard fails across machines. CI pins the same toolchain and
  compares all three `pkg/`↔`site/` artifacts.
- `node 22`, local `capstone 6.0.0` (mutated 5.0.9→6.0.0 install; CI pins
  stock `capstone==5.0.9` — census gates pass on both),
  `unicorn==2.1.4` (fuzz oracle only), arduino-cli at
  `/home/danish1075/bin/arduino-cli` (STM32duino core 2.12.0), xpack gcc
  14.2.1 / gdb 15 in the Arduino toolchain dir, Playwright Chromium (run
  browser tests with `TMPDIR=~/.tmp-pw` — `/tmp` contention breaks launches
  on this box; CI runners are unaffected).
- **Staging rule (CI incident 2026-08-09):** always `git add -A` — stage
  `pkg/` + `site/` together. Local trees mask a stale-artifact split;
  fresh checkouts don't. Do NOT commit unless the user says so.

---

## 4. How to run / test (see `AGENTS.md` "To Run / Rebuild")

```bash
cargo check --tests
node tests/test_all.mjs              # 764 unit tests
node tests/canary.mjs                # 39/39 firmware checks (~25s at 100M)
echo -n "AB" | node pkg/cli.mjs --config=tests/arduino_periph_test/config.yaml --max=200000000  # 200M 39/39 ~3s
node tests/test_emulator_js.mjs      # 3 browser-loop checks
node tests/test_board_buttons.mjs    # 19 board-hardware checks (NRST/BOOT0/boardInfo)
node tests/test_gdbstub.mjs          # 35 RSP checks (Z0 + Z2/Z3/Z4 watchpoints)
node tests/test_bootloader.mjs       # 45 AN3155 checks
node tests/test_coremark.mjs         # 5 known-answer CPU checks
node tests/test_otg.mjs test_otg_host.mjs test_otg_cdc.mjs test_dfu.mjs test_usb_cdc.mjs test_usb_serial.mjs
cargo test --release --lib cpu::census && python3 tests/census_16.py && python3 tests/census_32.py && python3 tests/fuzz_diff.py --cases 200 --seed 1
TMPDIR=~/.tmp-pw npx playwright test tests/test_browser_site.mjs tests/test_browser_demos.mjs --reporter=line --timeout=300000
node site/sync-docs.mjs && git diff --exit-code -- site/docs-src site/docs.json  # docs freshness guard (after sync: diff --cached)
```

Firmware rebuild (wipes `build/`, restore images after — exact commands in
`AGENTS.md`): arduino-cli compile per-FQBN into `tests/arduino_<name>/build`,
ship ELFs via `site/*.elf` (force-add, `*.elf` is gitignored).
Docs: edit `docs/*.md` source, run `node site/sync-docs.mjs`, commit mirrors.

---

## 5. What just landed (this session — staged, uncommitted)

All items below are staged via `git add -A` (§2 file list). Each was
proven with a failing-then-passing test, not just code inspection.

### 5a. AGENTS.md label + count refresh

- `§46` header `[this sprint, UNCOMMITTED]` → `[committed]` (shipped in
  `1782d45`, release 3.1.0 — the old handover already flagged this as
  stale).
- Header `Last updated: 2026-09-12` → `2026-09-15`, `719` → `736` unit
  tests (pre-sweep value; the sweep itself raised it to 764 — see §5g).
- `Test suite` block `354/354` → `736/736` with the current peripheral
  list (I2C slave/10-bit/PEC, USB FS + OTG_FS, ITM, SWD/JTAG, HD/CL).
- `Immediate` gate `(372)` → `(736)`.
- Known stale spots NOT touched (out of scope, still stale): `about.html`
  `719/719` stat (site page, needs a page-edit decision), `docs/` history
  numbers inside old sprint sections (intentionally frozen), `§24`
  probe-battery counts. Next agent: fix `site/about.html` only if touching
  the page anyway.

### 5b. IWDG/WWDG free-run tick arms (real bug, fixed)

- **Symptom**: a started IWDG never fired from `step_batch` ticks alone.
  Proven headless pre-fix: `KR=0x5555, PR=0 (/4), RLR=1, KR=0xCCCC start,
  KR=0xAAAA refresh` + `step_batch(100000)` → `is_watchdog_reset_requested()
  == false`; one `periph_read(PR)` pump → `true`. Same class for WWDG
  (lazy `decrement_counter` on register access only).
- **Root cause**: `Iwdg`/`Wwdg` had NO `tick()` arm and were absent from
  `name_has_tick()`, so `System::tick()` never visited them. Only guest
  register touches pumped the counter — silicon runs both free (LSI /
  PCLK1 clocks).
- **Fix** (`src/peripherals/iwdg.rs`, `wwdg.rs`, `mod.rs`):
  - `Iwdg::tick()` → `decrement_counter(sys)`; `rebase_clock(now)` →
    `last_tick = sr_tick = now` (NRST count-zero without a catch-up
    burst — same class as the TIM wedge in `d30cc54`).
  - `Wwdg::tick()` → `decrement_counter(sys)`; `rebase_clock(now)` →
    `last_tick = now; initialized = false` (re-arm the first-touch
    baseline too).
  - `name_has_tick()` += `IWDG` + `WWDG` so both maps (builtin + SVD)
    tick them.
- **Tests** (`tests/test_all.mjs` MCO/WDGOPT group rewritten, +4 asserts
  → the old block needed a register-access pump between batches and now
  fails without the fix — verified: 735/736 with new tests on old wasm):
  - `step_batch(1000)` returns `1` (watchdog-stop status) on the HW-mode
    fuse; flag already consumed (take-on-read — see §7 lesson).
  - Re-armed fuse fires on `step_batch` ticks alone with zero register
    touches + `drain_events()` carries `13 (WdogReset{1})`.
  - KR-started (`0xCCCC`) fuse fires on `step_batch`-only ticks.
- **Perf**: 200M run 2.90s post-fix (baseline ~2.85s + shared-box noise;
  two extra tick arms are unmeasurable — both early-return unless
  started).

### 5c. ADC rebase aborts in-flight conversions (latent glitch, fixed)

- **Audit**: `Adc.conv/jconv.end_at` anchors to `instruction_count()` at
  trigger time; `board_nrst()` zeroes the count without touching them. A
  CONT-mode conversion started pre-reset completed instantly post-reset
  off the stale `end_at` (proven by code path; silicon resets the ADC).
- **Fix** (`src/peripherals/adc.rs`): `rebase_clock()` clears
  `conv/jconv` + `disc_next` (matches the existing CR2-ADON-off abort
  path one function below it).
- **Tests** (+6 asserts in the ADC group): long-window (SMP=239.5)
  CONT conversion → `board_nrst()` → `step_batch(1000)` → no EOC, no
  `AdcDone` event; fresh SWSTART post-reset → EOC + exact DR; injected
  path (`JSWSTART` → NRST → no JEOC).

### 5d. DMA absorb_buf NRST regression test

- `board_nrst()` already cleared `pending_dma` + `absorb_buf` (`src/lib.rs`
  from `c538a18`); what was missing was the regression test.
- **Test** (+4 asserts in the DMA-pump group): queue a USART1-RX CH5
  periph→mem transfer, `board_nrst()` before the pump, assert
  `dma_get_pending_count() == 0`, `dma_pump_all().length == 0`, and no
  stale CH5 TCIF after 3 ticks. Verified the setup queues exactly one
  plan pre-reset (`plan0 len 8`, op1 absorb) and zero post-reset.

### 5e. NVIC regression tests + IABR-leak fix (real bug, fixed)

- **Tests** (NVIC group, fresh-`reset()` blocks with `set_intr_masks(0,0)`):
  - ICPR `0x180` clears an ISPR-pended EXTI0 (`has_pending` true→false).
  - `0x280` write leaves ISPR + pending + IABR untouched (RESERVED
    no-op — the exact `c538a18` mis-alias regression).
  - Return clears IABR (`dispatch → clear_current_interrupt → IABR bit
    0`, then waiter IRQ 7 delivers — proves the waiter was never
    starved AND the active bit doesn't leak).
- **Real bug found while writing them**: `clear_current_interrupt()` (the
  raw wasm export used by every JS test/driver return path) popped the
  active-priority stack but never cleared the IABR active bit —
  `get_next_pending_intr` sets it on dispatch, and only the native
  `exception_return` cleared it. Firmware reading IABR saw
  phantom-active IRQs forever. Fix: new `Nvic::last_popped_clear_take()`
  (takes the fairness-slot hint) + `clear_current_interrupt()` clears
  that entry's bit before popping (comment cites the native path).
- **Fairness-hint semantics learned the hard way** (see §7): the hint is
  consumed on return, so a *re-pended hot IRQ after a clean return
  correctly refires at higher priority* — the first draft asserting
  yield-to-waiter-across-a-return failed with `got 6` (correct silicon
  behavior, wrong test). The committed test asserts the documented path:
  return (IABR clears) → waiter delivers.

### 5f. TIM ARR + GPIO mask + USART TXEIE characterization

- **TIM ARR reset** (+1): fresh `init()` → `TIM2+0x2C == 0xFFFF` (pins the
  `d30cc54` `0xFFFF_FFFF` wedge fix at the register level).
- **GPIO callback-mask invariant** (+2): `gpio_set_input(1,7,...)` on a
  fresh pin then IDR readback honors the driver (pins the
  `set_input_pin_raw` mask regression that failed 3/736 mid-`c538a18`;
  first draft used the wrong base `0x40011400` — GPIOB is `0x40010C00` —
  and failed, which itself proves the test is load-bearing).
- **USART TXEIE arm** (+3): `UE|TE|TXEIE` + ISER37 + one `step_batch` →
  TXE held + IRQ37 pends (the anti-regression for the wrong-removal
  incident that wedged every boot; comment quotes it verbatim so nobody
  removes the arm again).

### 5g. Counts: 736 → 764 (+28, all green)

`test_all.mjs` 736/736 at session start → **764/764** at handover
(IWDG +4, ADC +6, DMA +4, NVIC +8 incl. the IABR asserts, TIM +1, GPIO
+2, USART +3, minus test-only refactors). `cargo test --release --lib`
80/80. `docs/PERIPHERALS.md` IWDG/WWDG/NVIC/ADC rows updated + mirrored
via `site/sync-docs.mjs` (freshness guard: `git diff --exit-code` on the
mirrors shows only the intended PERIPHERALS delta).

### 5h. Fuzz / census / full gate / perf (all green, evidence)

- `cargo test --release --lib cpu::census` 2/2; `census_16.py` "0 gaps,
  0 over-accepts"; `census_32.py` exit 0 (6 gap samples in 1
  first-halfword, 0 families over threshold — same shape as committed
  gates); `fuzz_diff.py --cases 200 --seed 1` 0 divergences (17
  expected-unmapped skips); `--seed 4` 0 divergences (11 skips).
- Canary 39/39; 200M CLI 39/39 (2.90s — inside the 2.85s ±30% band);
  emulator.js 3/3; coremark 5/5; chips 16/16; gdbstub 35/35;
  bootloader 45/45; board_buttons 19/19; otg 120/120 + host 5/5 + cdc
  23/23; dfu 51/51; usb_cdc 22/22; usb_serial 11/11; ws_bridge 11/11;
  all 17 event/format/esm/bus-tap/spec/i2c/dma suites green; all 17
  demo/board suites green (ws2812 2/2 … board_showcase 12/12);
  browser site 8/8 + demos 34/34 (headed, `TMPDIR=~/.tmp-pw`).
- Perf verdict: **no regression, no win to land** — 200M measured
  4.13s/5.24s under load early in the session, 2.90s quiet at the end;
  the model stays interpreter-bound. The two new tick arms + one ADC
  rebase + one NVIC take are cold-path-only.

---

## 6. Open / watch items (things a fresh agent should know)

1. **Staged-but-uncommitted sweep.** `git status --short` shows `M/A`
   staged entries (§2). House rule: do NOT commit without explicit user
   approval. Next step is either (a) commit on user request, or
   (b) keep building on top (remember `git add -A` again — the wasm +
   `site/` mirrors must never split).
2. `site/about.html` still says `719/719` (stat + two prose spots). It is
   a hand-written page, not a docs mirror — update it only when touching
   the page (deliberately left alone this session: no page edits).
3. `AGENTS.md` history sections keep their frozen numbers (354/372/… in
   old sprint notes) — intentional, do not "fix" them. Only the header +
   `Immediate` gate are live.
4. `board_nrst()` is a *half* reset by design (model state only; CPU/RAM
   reloaded by the driver). Full `init()` rebuilds everything but would
   switch F105→F103 maps — that is why NRST does not call it. The
   comments in `src/lib.rs` `board_nrst` + `pkg/emulator.js` `bootCpu`
   are load-bearing; read them before touching reset paths.
5. `site/board_pins.json` covers 4 chips (pill/cb/maple/nucleo); F103RC,
   F105, GD32 variants reuse the pill map on the page. Fine unless a new
   board needs distinct aliases.
6. `pkg/package.json` (wasm-pack output, gitignored) still carries the
   old Unicorn description string — build artifact, not source; ignore.
7. `tests/arduino_periph_test/build/` artifacts are gitignored; CI copies
   them from `site/*.elf` + `site/*.bin`. `canRxArmed` drifts on every
   firmware rebuild — all drivers resolve it from ELF symbols
   (`parseElf`); never hardcode it (past incident: 0x200000b8 became
   `canRxTries`, cost ~4s/run + browser 9→22 MIPS).
8. The NVIC fairness hint (`last_popped`) is now consumed by
   `clear_current_interrupt` (via `last_popped_clear_take`). Do not add a
   second consumer or re-clear per-return without re-reading §5e + §7:
   the native `exception_return` path does NOT touch the hint (it has
   the exact IRQ), and double-consumption would silently disable the
   TXE-drain alternation.

---

## 7. Hard-won lessons (do NOT re-learn these — new entries first)

- **`step_batch` return consumes the watchdog flag** (`src/lib.rs`:
  `step_batch` calls take-on-read `is_watchdog_reset_requested()` and
  returns 1). Asserting `is_watchdog_reset_requested() == true` AFTER a
  firing `step_batch` always fails — assert the return value, or drain
  first and re-fire. (Cost one red cycle in §5b.)
- **`has_pending_interrupt` reads live INTR_MASK statics.** On real
  driver paths the CPU syncs PRIMASK per batch; raw-wasm tests must call
  `set_intr_masks(0,0)` explicitly or pendings read false. (Cost one red
  cycle in §5e.)
- **`get_next_pending_interrupt` pushes an active-priority entry (HW
  nesting).** A take at prio 0 gates EVERY later take until its return —
  the NVIC test block needed a fresh `reset()` after the USART1 take or
  all later takes returned -255. Multi-take tests: reset between phases
  or return between takes. (Cost two red cycles in §5e.)
- **TXEIE+TXE arm must stay** (`src/peripherals/usart.rs`): STM32duino's
  first print uses `HAL_UART_Transmit_IT`, which stalls forever without
  the TXE IRQ. Removing the arm wedged EVERY firmware boot with zero
  UART (canary absent, emulator.js 1/3, ws2812 0 frames). The "storm"
  theory was wrong — the real post-NRST wedge was stale
  `last_tick≈200K` vs count-zero (fixed by `rebase_clocks`).
- **Borrow discipline in `rebase_clocks`**: hold NO RefCell across a
  `rebase_clock` call (raw-pointer-per-slot pattern). TIM→AFIO re-borrow
  panics otherwise. Comment in `src/peripherals/mod.rs` ~line 620.
- **`board_nrst` must not clear NATIVE** (bisect27): orphaning the CPU
  mid-session panics the next `rustcpu_run` and the wasm `expect`
  unwind wedges Node (hang, not error).
- **Trace symbols need whole-identifier regex** (`dfu_stage` vs
  `dfu_staged`, `dfu_trace` vs `dfu_trace_n` prefix collisions).
- **`periphRead` on SRAM returns bus zeros** — use `memRead32` for RAM
  (`canRxArmed` polling etc.). Flash guest stores drop
  (`write8_raw_unchecked`); DFU stages to RAM, never polls BSY.
- **`get_uart_output()` is take-on-read**; bootloader + firmware share
  the wire — assert head bytes, not exact buffers.
- **Batch-boundary timing**: peripherals tick in `step_batch()` between
  batches, never mid-batch. Async-style tests only (arm once, poll
  across batches). `svc` is the sole synchronous exception.
- **Worker messages interleave across `await createEmulator`** — defer
  pre-init attach/feed via the `pendingPreInit` queue pattern.
- **Stale symbol addresses** (`uwTick` 0x20000098→0x20000090) — resolve
  ELF symbols fresh per build. PC-sampling aliases on small loops —
  verify with instCount deltas + UART.
- **Never hide build output** (`>/dev/null` concealed a failing gcc for
  ~10 cycles once). **`/tmp` wipes binaryen** (silent wasm-opt 117
  fallback → red CI). **`trace_n` must be `volatile`** (gcc -Os hides
  host-visible pushes in registers).

---

## 8. Suggested skills (call the Skill tool for these)

- `webapp-testing` — if you touch `site/index.html`, `site/worker.js`,
  or any browser preset: drive the page headless, screenshot the board
  SVG/LED widgets, assert terminal output (pattern:
  `TMPDIR=~/.tmp-pw npx playwright test …`).
- `playwright-interactive` — if a browser preset misbehaves live (DFU
  download flow, USB enumeration cards, WS2812 strip decode): attach
  interactively and step the run loop before editing drivers.
- `doc-coauthoring` — if you write or restructure user-facing docs
  (`docs/*.md` + `site/sync-docs.mjs` mirrors + `site/docs.json`):
  keep source/mirror/drift-guard consistent per the freshness rule.
- `frontend-design` — ONLY if restyling the demo page (hero, board SVG,
  cards). Do not restyle unprompted; the page is deliberately stable.
- `customize-opencode` — ONLY if editing opencode's own config
  (`.opencode/`, `~/.config/opencode/`). Never for repo code.
- `claude-handoff` — when ending a session: write the next handover the
  same way this file was written (state + evidence + todo list).

---

## 9. Opencode todo list (load with TodoWrite — exactly ONE in_progress)

> Status key: `pending` = not started, `in_progress` = active (exactly
> one), `completed` = done + verified, `cancelled` = dropped with reason.
> Mark `completed` only after the listed verification actually ran green.
> Current repo state: the §5 sweep is STAGED but UNCOMMITTED; every todo
> below starts `pending` except the recon one (re-run the fast subset —
> the tree changed since `c538a18`).

```json
[
  {
    "content": "Recon: read AGENTS.md header + §§42-46 + git log -5 + git status + run fast subset (test_all 764, canary)",
    "priority": "high",
    "status": "in_progress"
  },
  {
    "content": "Decide commit: sweep is staged-but-uncommitted (house rule: user approval) — commit on request or keep building with git add -A",
    "priority": "high",
    "status": "pending"
  },
  {
    "content": "IWDG deep-sleep proof: IWDG keeps running through STOP/STANDBY while TIM freezes (SLEEPDEEP + started fuse + step_batch, no register touches)",
    "priority": "medium",
    "status": "pending"
  },
  {
    "content": "WWDG window test: early-refresh (T > W) requests reset via CR write path — pin the window semantics, not just EWI/timeout",
    "priority": "medium",
    "status": "pending"
  },
  {
    "content": "NVIC EOI audit: every raw-wasm test path that takes an IRQ returns it (grep get_next_pending_interrupt without a paired clear_current_interrupt)",
    "priority": "medium",
    "status": "pending"
  },
  {
    "content": "about.html 719->764 refresh (only with a page edit; page is deliberately stable otherwise)",
    "priority": "low",
    "status": "pending"
  },
  {
    "content": "Fuzz canary re-run: fuzz_diff.py --cases 200 --seed 1/4 + census_16/32 gates (unicorn==2.1.4 oracle)",
    "priority": "high",
    "status": "pending"
  },
  {
    "content": "Full gate: 200M CLI 39/39 + emulator.js 3/3 + coremark/chips/otg/dfu/usb suites + browser site+demos",
    "priority": "high",
    "status": "pending"
  },
  {
    "content": "Perf check: A/B 200M timing vs 2.90s baseline; only land proven wins (interpreter-bound, ~97% in rustcpu_run)",
    "priority": "medium",
    "status": "pending"
  },
  {
    "content": "Docs sync + staging discipline: node site/sync-docs.mjs, cmp pkg/site artifacts, git add -A (never partial), no commit without user approval",
    "priority": "high",
    "status": "pending"
  },
  {
    "content": "Write next HANDOFF_NEXT_AGENT.md (state + evidence + fresh todo list, 500-600 lines)",
    "priority": "low",
    "status": "pending"
  }
]
```

### Todo notes (read before working each item)

- **Recon first.** `AGENTS.md` is ~740 lines and mostly historical — the
  load-bearing sections are the header rules (staging, SVD, toolchain),
  "Architecture & Emulation Loop", "Performance", "To Run / Rebuild",
  and §§42–46 + "Active Workarounds". Then `git log --oneline -5`,
  `git status --short` (expect the §2 staged set), and the fast subset
  (`test_all` 764, `canary`) to confirm the box is healthy before
  changing anything.
- **Commit decision.** The sweep is `git add -A` staged with no commit
  (house rule from the old handover §12 + §3 staging rule). If the user
  says commit: verify `git diff --cached --stat` matches §2, re-run the
  fast subset once, then commit with a message in repo style (e.g.
  "Watchdog free-run + reset/clock audits + regression tests (764)").
  Never `git commit` unasked, never partial-stage (`pkg/` without
  `site/` breaks CI's byte-exact guard on fresh checkouts).
- **IWDG deep-sleep proof.** `System::tick()` keeps IWDG+RTC on the
  `tick()` path in deep sleep while everything else gets `tick_frozen()`
  — but no test proves the IWDG fuse survives STOP. Shape: start a short
  fuse, `SLEEPDEEP`, `step_batch` past the fuse with zero register
  touches, assert the watchdog-stop status; sibling TIM frozen (the
  existing Sleep group already proves TIM freeze — extend, don't
  duplicate).
- **WWDG window test.** Current coverage proves timeout + EWI; the
  window rule (CR refresh with `T > W` requests reset immediately) is
  implemented in the CR-write path (`wwdg.rs`) but has no dedicated
  pin. One assert: `CFR.W=max, CR=0xFF` then refresh with `T > W` →
  reset requested.
- **NVIC EOI audit.** `grep get_next_pending_interrupt tests/*.mjs`:
  every take outside the native dispatch loop must pair with a return
  (`clear_current_interrupt` / `finish_interrupt`), or the active-prio
  entry + IABR bit linger and gate later takes (the §5e -255 lesson).
  Fix strays by adding the missing return, not by resetting around them.
- **about.html.** Hand-written page (`719/719` stat + two prose counts).
  Update to 764 only alongside a real page change; do not churn the page
  for a number.
- **Fuzz/census.** Needs `unicorn==2.1.4` + capstone (CI: stock 5.0.9;
  this box: mutated 6.0.0 — gates pass on both). Seeds 1+4, 200 cases
  each; expect 0 real divergences (triage policy lives in
  `tests/fuzz_diff.py` header comments).
- **Full gate.** Order: unit → canary → 200M CLI → emulator.js →
  peripheral/demo suites (ws2812/rtc/servo/dac/i2c/can/stopwatch/pwm/
  slave/rtos/logger/usb×2/otg×3/dfu/coremark/chips/gdbstub/bootloader/
  board×4/hd_fsmc) → browser site+demos with `TMPDIR=~/.tmp-pw`.
  ~10–15 min wall time; run it once before any commit.
- **Perf.** The 200M baseline is now **~2.90s** (shared-box noise ±30% —
  re-run 2–3× before concluding anything). The profile is
  interpreter-bound; the only recent measurable win was the GPIO IDR
  path (~4ms/200K reads, invisible end-to-end). Land timing changes
  ONLY with A/B numbers + full gate green.
- **Docs/staging.** After any `src/` or `pkg/*.js` edit: rebuild pinned,
  `cp` artifacts to `site/`, `node site/sync-docs.mjs`, `cmp` the three
  artifacts, `git add -A`. Never commit without explicit user approval.

---

## 10. File map (where to edit)

- `src/cpu/` — interpreter (`thumb.rs` decoder, `mod.rs` run loop,
  `mem.rs` `FlatMemory`, `regs.rs`); tests `isa_tests.rs`,
  `core_tests.rs`, `census.rs`, `diffuzz.rs`, `smoke.rs`.
- `src/native.rs` — wasm boundary for the CPU (`rustcpu_*`,
  `swd_*` debug exports, write-tap). NATIVE is process-global,
  cleared on `init`/`reset`.
- `src/lib.rs` — all wasm exports (`board_*` ~lines 784–876,
  `init`/`init_svd`, `step`/`step_batch`/`process_batch`,
  `drain_events`, `*_inject_*`, `rcc_*`, `pwr_*`, bootloader,
  `raise_fault`; `clear_current_interrupt` now clears IABR too).
  Version bumps do NOT live here.
- `src/system.rs` — `WasmSystem` (bus+NVIC+DMA queues+events+MPU+SWD),
  `INSTRUCTION_COUNT`, watchdog flag, DMA plan build/exec.
- `src/peripherals/` — one file per peripheral + `mod.rs` (bus
  routing, `rebase_clocks`, `name_has_tick` now incl. IWDG/WWDG, fixed
  routes STIR/ACTRL/IDCODE/UID); `src/bus.rs` (sorted slots + binary
  search + tick indices); `src/interrupts.rs` (64-IRQ budget `intr_next`).
- `src/ext_devices/` — host-side device models (SPI flash, I2C
  EEPROM/OLED, LCD, touchscreen, FSMC NOR, SD card, displays).
- `pkg/emulator.js` — `createEmulator()` + run/step loop + `reset()`
  + `bootCpu()` + watchers/taps; `pkg/cli.mjs` — headless driver;
  `pkg/stm32f1.js` — ergonomic wrapper (`STM32F1`, events);
  `pkg/gdbstub.mjs` — RSP stub (Z0 BKPT + Z2/Z3/Z4 watchpoints);
  `pkg/ws-server.mjs` — headless+viewer bridge.
- `site/` — GitHub Pages root (mirrors `pkg/` artifacts + `worker.js`
  + `index.html` presets + `docs-src/` mirrors + `docs.json`).
- `tests/` — `test_all.mjs` (**764** asserts, the gate), `canary.mjs`,
  per-peripheral/demo suites, `test_board_buttons.mjs` (19),
  `test_gdbstub.mjs` (35), browser suites (`test_browser_*.mjs`,
  Playwright), `fuzz_diff.py` + `census_*.py`, `godb_live_session.sh`
  (dev-only, needs Arduino gdb).
- `svd/` — `STM32F103.svd`, `STM32F105xx.svd`. `docs/` — source docs;
  `site/docs-src/` — synced mirrors (never hand-edit).
- `.github/workflows/test.yml` — full CI gate (toolchain → build →
  artifact guard → firmware fixtures → every suite → browser →
  docs-freshness). `.github/workflows/publish.yml` — manual
  version-bump-tolerant publish.
- `AGENTS.md` — agent context (§46 label fixed this session; header +
  `Immediate` counts live, history frozen). `CHANGELOG.md` (top: 3.1.0),
  `README.md`, `package.json` (3.1.0 — bump only on user request).

---

## 11. Verification log (this session, for the record)

- `cargo check --tests` — clean (multiple runs, incl. after IWDG/WWDG/
  ADC/NVIC edits; one red cycle: `borrow()` vs `borrow_mut()` on the
  new `last_popped_clear_take` call — fixed, re-green).
- `node tests/test_all.mjs` — **764/764** (started 736/736; red cycles:
  new MCO/WDGOPT asserts on old wasm 735/736 — proved load-bearing;
  NVIC -255 takes ×3 — fixed with fresh resets + returns; GPIO base
  typo — fixed; fairness-across-return — rewritten to silicon truth).
- `node tests/canary.mjs` — 39/39.
- 200M CLI — 39/39 (4.13s/5.24s loaded, **2.90s** quiet — baseline).
- `test_emulator_js.mjs` 3/3, `cargo test --release --lib` 80/80,
  `test_gdbstub.mjs` 35/35, `test_bootloader.mjs` 45/45,
  `test_board_buttons.mjs` 19/19, `test_coremark.mjs` 5/5,
  `test_chips.mjs` 16/16, `test_ws_bridge.mjs` 11/11,
  `test_dfu.mjs` 51/51, `test_otg.mjs` 120/120, `test_otg_host.mjs` 5/5,
  `test_otg_cdc.mjs` 23/23, `test_usb_cdc.mjs` 22/22,
  `test_usb_serial.mjs` 11/11, all event/format/esm/bus-tap/spec/i2c/
  dma suites green, all 17 demo/board suites green.
- Browser (headed, `TMPDIR=~/.tmp-pw`): `test_browser_site.mjs` 8/8,
  `test_browser_demos.mjs` 34/34.
- Census: `cpu::census` 2/2, `census_16.py` 0 gaps / 0 over-accepts,
  `census_32.py` exit 0; fuzz seeds 1+4 × 200 cases, 0 divergences.
- Rebuild: pinned binaryen version_132 (`found wasm-opt at
  ...version_132...`), `--remap-path-prefix`, `cmp` JS artifacts OK,
  `node site/sync-docs.mjs` synced (only the intended PERIPHERALS
  delta), `git add -A` staged (§2 set). No commit (house rule).

---

## 12. Suggested next actions (if no other direction given)

1. Load the todo list in §9 into TodoWrite (exactly one `in_progress`).
2. Do the recon item first (fast subset green = healthy box; expect the
   §2 staged set in `git status`).
3. Ask the user about committing the staged sweep before building on it
   (house rule: no commits without explicit approval).
4. Work the audit/test todos in order — IWDG sleep proof and WWDG window
   are the two smallest genuine coverage gaps left by this sweep.
5. End with the full gate + docs sync + `git add -A` staged-but-
   uncommitted state, then ask the user before committing.
6. Rewrite this handover file for the session after you.

---

*Handover written 2026-09-15 from HEAD `c538a18` + staged audit sweep
(test_all 764/764, full gate green, §2 file list). No credentials, keys,
or personal data in this file — paths are local build/checkout locations
only. Counts quoted (764/39/35/19/…) are the staged gate values; re-run
the fast subset on a new box before trusting them under shared-box noise.*
