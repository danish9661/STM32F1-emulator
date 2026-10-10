# stm32f1-emu — hook spec (for emulator agent)

Our runner: `OpenHW-studio-frontend/src/worker/runners/stm32f1-runner.ts`.
Status: **no changes required** — this package is the reference implementation. This doc pins the contract so it is not regressed.

## What to keep stable (used live, green)

1. **I2C1 observation hooks** (per-bus, post-create, address-independent):
   `mcu.i2c1.onStart / onWrite / onRead / onStop` — plain settable properties observing all I2C1 traffic.
2. **SPI1 transfer tap**: `mcu.spi1.onTransfer(ch, tx[], rx[])` per DR-write, plus `mcu.spi1.injectMiso(resps[])` queuing MISO for the next clocks.
3. **GPIO**: `mcu.gpio.pin(port, n)` with `.read()` (fresh core-side level), `.setInput()`, `.setAnalog()`, and `on('change')` events.
4. **Package virtual devices**: `ext_devices: { i2c_oled, i2c_eeprom }` at create (`stm32f1-runner.ts:326-340`).
5. **UART**: `usart1/usart2.onData` + `.send()`.
6. **ADC + TIM classes**: `mcu.adc1..3` (`setVoltage(ch, mV)` / `setCode(ch, code)`)
   and `mcu.tim1..7` (`duty(ch)` / `frequency()` / `enabled()`) — same
   settable-property/observation shape as the buses above.

## Optional improvement (runner works around it today) — DONE 2026-10-05

GPIO `change` events used to dispatch after the `execute()` batch while
`onTransfer` fired during it — so CS sampled mid-transfer read stale
(runner pre-published core CS + dedups to compensate). Fixed without
the risky synchronous-per-instruction refactor: `STM32F1.execute()` now runs
the run as `getBatchSize()`-chunked `step()`s with the transfer-event drain
after every batch, so each batch's GPIO drain lands before that batch's
transfer callbacks (batch-granular consistency; sub-batch skew is inherent
to the batch architecture and unchanged). The degenerate `execute(0/neg)`
path keeps legacy run()-once semantics; return shape is unchanged
(`{totalSteps, instCount, stopped}`). Proven in
`tests/test_stm32f1_ordering.mjs` 9/9: register-driven CS-freshness at both
transfers with zero instructions retired, plus firmware-driven differential
(showcase LCD paint, CS PA8) — new path observes selected-CS mid-run where
the legacy path saw only the end state, with IDENTICAL transfer/edge counts
(16396 / 5) on both paths. The runner workaround stays compatible (dedup is
idempotent); counts are engine-untouched so the e2e numbers below still hold.

## Further gaps (same agent, P1 — full protocol audit 2026-10) — CLOSED 2026-10-05

Package classes are now DMA/GPIO/GPIOPin/I2C/SPI/STM32F1/USART **plus ADC and
TIM** (`pkg/stm32f1.js`, types in `pkg/stm32f1.d.ts`, docs in
`docs/STM32F1_API.md`, proofs in `tests/test_stm32f1_api.mjs` 23/23):

1. **ADC inject** (was P1): `mcu.adcN.setVoltage(ch, mV)` (0..3300, VREF=3.3V)
   / `setCode(ch, code)` — ch 0-15 route to the mapped GPIO pin analog wire
   (the exact source the converter samples, through the RC sample-and-hold),
   16-18 use the internal override, higher channels fall back to the global
   sim value. Proven end-to-end: injected 1650 mV converts to DR=2048 with
   EOC + `onAdcDone(1, 0)`.
2. **PWM/timer-out observe** (was P1): `mcu.timN.duty(ch)` (0-100, CCR/ARR) +
   `frequency()` (PSC/ARR + live RCC tree incl. the APB x2 rule), both 0
   unless CR1 CEN. Proven: programmed TIM2 reads back duty 25 / 9 kHz
   (live PLL tree) + `onTimUpdate`.

## Future-component guarantee (signal-level contract)

Same invariant as the Pico spec: after §1–2, any future component on GPIO /
I2C-RW / SPI-duplex / UART / ADC-in / PWM-out works with zero further engine
changes. I2C **read** is mandatory, not optional — every I2C sensor in the
registry (MPU6050, BMP180, ADXL345, DS1307, EEPROM, PCA9685) reads.
GPIO input readback follows RM0008 Table 20 — floating (CNF=01) reads the
wired driver else 0, pull-up/down (CNF=10, e.g. Arduino `INPUT_PULLUP`)
reads the driver else the ODR-selected pull, push-pull output IDR reads the
driven level — so bit-banged single-wire firmware (SoftwareSerial RX,
DHT22 DATA) samples real wire levels via IDR with no engine changes.

## Acceptance

- `tests/e2e/stm32-i2c.spec.js` ("Blue Pill" cells): OLED `vramFill` + LCD `Hello` — must stay green.
- `tests/e2e/stm32-spi.spec.js`: MAX7219 digits — green after runner-side ordering fix; engine changes must not alter transfer/edge counts (today: 10 transfers, 9 GPIO fires).
- Engine-side cover (this repo, OpenHW agent still runs the suites above):
  `tests/test_stm32f1_ordering.mjs` 9/9 pins the invariant on showcase
  traffic — per-batch drains observe mid-run CS states with transfer/edge
  counts bit-identical to the legacy drain-once path (16396 / 5). The only
  engine deltas since the 10/9 baseline are additive (new wrapper classes,
  `_buf` clear on reload, per-batch transfer drains, two trivial getters);
  no transfer/edge code path was touched.

## Cross-cutting constraints (sync/SAB — engine side of the contract)

Engines never touch SharedArrayBuffer: each engine runs as a plain
synchronous step function inside its board Worker, and only our
`arm-runner-base.ts` touches SAB (pin bitfields, barrier cells, STEP
collect). Two things the engine must still guarantee so multi-board
lockstep holds:

1. **Reset clears everything, synchronously** — cores, peripherals, pending
   events, and any `stopped`/fault flags. A sticky flag desyncs one board's
   lane forever while the others advance.
   Status 2026-10-05: cores/peripherals/pending events were already fresh via
   `createEmulator()`; `STM32F1._reload()` (all reset/load paths) now also
   clears the accumulated per-USART TX buffers alongside pin listeners, so no
   wrapper-level state survives a reset. Proven in `test_stm32f1_api.mjs`.
2. **Expose a cycle/instruction counter per step** — feeds sim-time edge
   stamps (replacing the runner's wall-clock approximation) and the
   skew/pace accounting. One counter serves both.
   Status 2026-10-05: no new API needed — `execute()` returns
   `{instCount, stopped}` and `step()` returns `{pc, instCount, stopped}`
   on every call (asserted in `test_stm32f1_api.mjs`).
