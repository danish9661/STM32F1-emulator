/* tslint:disable */
/* eslint-disable */

/**
 * Override an internal ADC channel (16=temp, 17=VREFINT, 18=VBAT) with a
 * 12-bit value; pass 65535 (u16::MAX) to clear back to nominal.
 */
export function adc_set_internal(channel: number, val: number): void;

/**
 * RC sample-and-hold time constant in ADC cycles (1 instr = 1 cycle).
 */
export function adc_set_rc_tau(cycles: number): void;

export function adc_set_sim_value(val: number): void;

/**
 * Add an FSMC NOR/PSRAM memory device backed by `data` (byte image).
 * `name` must be FSMC.BANK1..4 (NE1-4), FSMC.BANK5..6 (NAND), or FSMC.BANK7
 * (PC Card). Must be called before init().
 */
export function add_fsmc_bank(name: string, data: Uint8Array): void;

/**
 * Add an I2C EEPROM device. Must be called before init().
 */
export function add_i2c_eeprom(peripheral: string, address: number, data: Uint8Array): void;

/**
 * Add an I2C OLED display device (e.g. SSD1306). Must be called before init().
 */
export function add_i2c_oled(peripheral: string, address: number, width: number, height: number): void;

/**
 * Add an SPI LCD display device (e.g. ST7789, ILI9341). Must be called before init().
 */
export function add_lcd(peripheral: string, cs?: string | null): void;

/**
 * Add an SD card image for the SDIO peripheral (SDHC, 512 B sectors).
 * Must be called before init().
 */
export function add_sd_card(peripheral: string, data: Uint8Array): void;

/**
 * Register a software SPI device. Must be called before init().
 */
export function add_software_spi(name: string, cs: string | null | undefined, clk: string, miso: string, mosi: string): void;

/**
 * Add an SPI flash device. Must be called before init().
 */
export function add_spi_flash(peripheral: string, jedec_id: number, data: Uint8Array, cs?: string | null): void;

/**
 * Register a touchscreen device. Must be called before init().
 */
export function add_touchscreen(peripheral: string, touch_detected_pin?: string | null, cs?: string | null): void;

/**
 * Set the BOOT0 strap level (page BOOT0 jumper / host-driven probe).
 */
export function board_boot0(high: boolean): void;

/**
 * Read back the BOOT0 strap level.
 */
export function board_boot0_get(): boolean;

/**
 * Board identity block (BOOT/RST buttons + LED + clock note). One call
 * replaces per-board docs lookups for drivers: the model only knows
 * reset/boot *semantics* (BOOT0 held at reset → bootloader on USART1;
 * NRST → AIRCR SYSRESETREQ), but a widget layer needs the hardware
 * facts too (which LED lights, which user button exists per board).
 *
 * `chip`: 0=f103c8/cb pill, 1=maple_mini, 2=nucleo_f103rb,
 * 3=f103rc, 4=f105, 5=gd32 pills. Returns
 * [led_port, led_pin, btn_port, btn_pin, btn_level, boot_present,
 *  nrst_present, crystal_hz, max_sysclk_mhz]:
 * - LED: (port 0=A/1=B/2=C, pin) driven by firmware.
 * - BTN: user button (port, pin, active level); Maple BUT=PB8/LOW,
 *   Nucleo B1=PC13/HIGH, pills have NO user button (port = 0xFF).
 * - boot_present/nrst_present: every board in the table has both.
 * - crystal/fonts: 8 MHz HSE everywhere modeled; max SYSCLK 72 MHz
 *   (instruction-budget timing — see `rcc_clocks_hz`).
 */
export function board_info(chip: number): Uint32Array;

/**
 * NRST press: full model reset — INSTRUCTION_COUNT to zero (all
 * instruction-delta peripherals rebase; without this a post-reset tick
 * sees now=0 against stale last_tick≈200K and every peripheral tries to
 * "catch up" 200K ticks at once — the USART TXE storm wedged Node in
 * process_batch), model-wide NVIC/DMA/event state cleared, pins,
 * bootloader claim, debug mirrors.
 * NOTE: the *native CPU + guest RAM* live in the driver (emulator.js
 * recreates them via its own `reset()` path + firmware reload; this
 * export only resets the map-independent model state). Returns 1 when
 * the bootloader path is taken, else 0.
 */
export function board_nrst(): number;

/**
 * Enable/disable the system-memory bootloader responder (AN3155 USART
 * protocol on USART1). While enabled it claims USART1 RX and answers the
 * host flashing flow instead of the USART model.
 */
export function bootloader_enable(on: boolean): void;

/**
 * Last GO target address issued to the bootloader, or -1 when none.
 */
export function bootloader_go_addr(): number;

/**
 * Inject a CAN message into the CAN peripheral at the given address.
 * Returns true if the message was accepted (matched a filter and placed in a FIFO).
 */
export function can_inject_message(addr: number, tir: number, tdtr: number, tdlr: number, tdhr: number): boolean;

/**
 * Call after an ISR returns to pop the active priority stack AND clear
 * this entry's IABR active bit (set on dispatch). The old pop-only return
 * left the bit set forever (phantom-active IRQs); the native
 * `exception_return` path clears both, so this matches it.
 */
export function clear_current_interrupt(): void;

/**
 * DMA periph->mem pump: pop `size` bytes from the peripheral at `addr` via
 * the normal periph_read path (chunks <= 4, little-endian packed), so JS only
 * writes the result to RAM once per transfer instead of one crossing per chunk.
 */
export function dma_absorb_periph(addr: number, size: number): Uint8Array;

export function dma_get_all_pending(): Uint32Array;

export function dma_get_pending(index: number): Uint32Array;

export function dma_get_pending_count(): number;

/**
 * Rust-side DMA pump: pops ALL pending transfers, performs the peripheral
 * byte absorb/push internally (periph_read/periph_write chunked), and returns
 * a flat op plan for JS:
 *   [op, a, b, c] quadruples:
 *     op 0 = RAM memcpy (a=src, b=dst, c=size)          -> JS mem_read + mem_write
 *     op 1 = write absorbed bytes (a=dst, b=size, c=off) -> JS mem_write(dma_take_absorbed(off,size))
 *     op 2 = read RAM then push to periph (a=src, b=size, c=periAddr) -> JS mem_read + dma_push_periph
 *     op 3 = done (a=completed stream bits)             -> JS dma_set_completed_many(a)
 * The plan is built in queue order; absorbed bytes land in a side buffer
 * fetched with dma_take_absorbed(). Completion is signaled LAST so DMA IRQs
 * fire only after every RAM move has landed.
 */
export function dma_pump_all(): Uint32Array;

/**
 * DMA mem->periph pump: push `data` bytes into the peripheral at `addr` via
 * the normal periph_write path (chunks <= 4, little-endian unpacked), so JS
 * only reads RAM once per transfer instead of one crossing per chunk.
 */
export function dma_push_periph(addr: number, data: Uint8Array): void;

export function dma_set_completed(stream_idx: number, success: boolean): void;

export function dma_set_completed_many(bits: number): void;

/**
 * Fetch a slice of the bytes absorbed by the last dma_pump_all() (offset,
 * length) so JS can mem_write them into RAM. Clears the whole buffer.
 */
export function dma_take_absorbed(offset: number, len: number): Uint8Array;

/**
 * Drain virtual-peripheral transaction events as a flat i32 array.
 * Encoding (discriminant first):
 *   1 SpiTransfer  [1, channel, txLen, rxLen, tx bytes..., rx bytes...]
 *   2 I2cStart     [2, channel, addr]
 *   3 I2cWrite     [3, channel, byte]
 *   4 I2cRead      [4, channel]
 *   5 I2cStop      [5, channel]
 *   6 UartTx       [6, usart, byte]
 *   7 ExtiEdge     [7, line]
 *   8 AdcDone      [8, adc, chan]
 *   9 TimUpdate    [9, tim]
 *  10 DacWrite     [10, chan, value]
 *  11 CrcResult    [11, value]
 *  12 RtcAlarm     [12, alarm]
 *  13 WdogReset    [13, which]   (1=IWDG, 2=WWDG)
 *  14 CanTx        [14, can, id, len, d0..d7]
 *  15 CanRx        [15, can, id, len, d0..d7]
 *  16 TimCapture    [16, tim, ch, value]   (input-capture latch)
 *  17 FsmcAccess    [17, bank, offset, write, size, value]
 *  18 UsbIn         [18, ep, len, bytes...]   (device->host IN completion)
 *  19 I2cAlert      [19, channel, asserted] (SMBus SMBA drive edge)
 *  20 HostTx        [20, ch, ep, setup, len, bytes...] (host OUT/SETUP done)
 *  21 HostRx        [21, ch, ep, len]       (host IN token: feed an answer)
 *  22 ItmByte       [22, port, byte]        (ITM stimulus printf channel)
 */
export function drain_events(): Int32Array;

/**
 * Call after an ISR returns: pops the active priority stack, and for SysTick
 * (irq == -1) also drains any unconsumed 1ms debt ticks internally (re-pends
 * each), so JS needs no nvic_systick_take loop.
 */
export function finish_interrupt(irq: number): void;

/**
 * Read a byte from an FSMC backing image (bypasses the peripheral bus).
 * Returns the byte value (0..255) or -1 if the bank/offset is invalid.
 */
export function fsmc_read_byte(name: string, offset: number): number;

/**
 * Write a byte directly into an FSMC backing image (bypasses the peripheral
 * bus — no events, no side effects).  Returns true on success.
 * Use this from JS virtual peripherals to feed read-back data to the MCU.
 */
export function fsmc_write_byte(name: string, offset: number, value: number): boolean;

export function get_next_pending_interrupt(): number;

/**
 * Collect UART output since last call.
 */
export function get_uart_output(): string;

export function gpio_read_input(port: number, pin: number): boolean;

export function gpio_read_output(port: number, pin: number): boolean;

/**
 * Set an analog wire voltage on a GPIO pin (12-bit, 0xFFFF clears it).
 * ADC channels mapped to the pin then sample this voltage with an RC
 * sample-and-hold model instead of the injected simulation value.
 */
export function gpio_set_analog(port: number, pin: number, level: number): void;

export function gpio_set_input(port: number, pin: number, value: boolean): void;

/**
 * Set the GPIO output slew delay in instructions (0 = instant). Affects IDR
 * readback only; device callbacks stay instant.
 */
export function gpio_set_slew(inst: number): void;

/**
 * Drain buffered pin-change events as a flat [port, pin, level, ...] array
 * (chip-driven output level changes only). Cleared on the next init().
 */
export function gpio_take_pin_events(): Uint32Array;

/**
 * Check if any interrupt is pending, respecting PRIMASK/BASEPRI.
 */
export function has_pending_interrupt(): boolean;

/**
 * SMBus ALERT input: peer pulled SMBA low on this channel → SR1 SMBALERT
 * flag (+ error IRQ when ITERREN). Returns false when disabled/no channel.
 */
export function i2c_inject_alert(channel: number): boolean;

export function i2c_inject_read(channel: number): number;

/**
 * Queue injected RX bytes for an I2C channel (virtual device -> MCU).
 */
export function i2c_inject_rx(channel: number, bytes: Uint8Array): void;

/**
 * Host-side I2C slave transactions: address this peripheral as a slave
 * from an external host (see `I2C1`/`I2C2` slave docs). Start NACKs when
 * the peripheral is disabled/busy/unmatched; write NACKs when not in
 * slave-RX, RXNE unread or ACK cleared; read returns -1 when not in
 * slave-TX or DR empty (stretch equivalents).
 */
export function i2c_inject_start(channel: number, addr: number, is_read: boolean): boolean;

export function i2c_inject_stop(channel: number): boolean;

export function i2c_inject_write(channel: number, byte: number): boolean;

/**
 * Read back an I2C OLED display's framebuffer (page-major, 1 byte per column).
 */
export function i2c_oled_fb(peripheral: string, address: number): Uint8Array;

/**
 * Debug: bytes the I2C OLED device received (should be ~1K+ for a full frame).
 */
export function i2c_oled_writes(peripheral: string, address: number): bigint;

/**
 * Initialize the emulator with hardcoded peripheral map.
 * Must be called after adding all ext devices (add_spi_flash, add_i2c_eeprom).
 * Can be called multiple times to reset emulator state.
 */
export function init(): void;

/**
 * Initialize the emulator from an SVD XML string (e.g., STM32F407.svd).
 * Must be called after adding all ext devices (add_spi_flash, add_i2c_eeprom).
 */
export function init_svd(svd_xml: string): void;

/**
 * Next pending IRQ within the batch budget (like get_next_pending_interrupt,
 * but capped at 64 per step/step_batch so one hot IRQ can't starve others).
 */
export function intr_next(): number;

export function is_watchdog_reset_requested(): boolean;

/**
 * Read back an SPI LCD display's framebuffer (128x64, 1 byte per pixel).
 */
export function lcd_fb(peripheral: string): Uint8Array;

/**
 * Host-driven OTG_FS bus reset (SE0): endpoints + FIFOs + address reset,
 * USBRST + ENUMDNE events. Returns false with no OTG peripheral mapped.
 */
export function otg_bus_reset(): boolean;

/**
 * Host disconnect on OTG_FS (pull-up off). Returns false with no OTG
 * peripheral mapped.
 */
export function otg_detach(): boolean;

/**
 * Virtual-device attach/detach on the OTG_FS host port (HPRT PCSTS
 * follows, edges raise PCDET + HPRTINT).
 */
export function otg_host_attach(present: boolean): boolean;

/**
 * Answer a pending OTG_FS host IN token on `ep` with `data` (or a STALL
 * handshake when `stall`). Returns false when no IN token is waiting.
 */
export function otg_host_feed_in(ep: number, data: Uint8Array, stall: boolean): boolean;

/**
 * Inject a USB OTG_FS OUT packet into an endpoint's RX FIFO (host ->
 * device). `addr` selects hardware address filtering (None =
 * correctly-addressed host). Returns false when dropped.
 */
export function otg_inject_out(ep: number, data: Uint8Array, addr?: number | null): boolean;

/**
 * Inject a USB OTG_FS SETUP packet (8 bytes) into EP0's RX FIFO (host ->
 * device). `addr` selects hardware address filtering (None =
 * correctly-addressed host). Returns false when dropped.
 */
export function otg_inject_setup(data: Uint8Array, addr?: number | null): boolean;

export function periph_read(addr: number, width: number): number;

export function periph_write(addr: number, width: number, value: number): void;

/**
 * One-call batch processor: advance the instruction count, reset the IRQ
 * dispatch budget, tick all peripherals, then report watchdog status and
 * whether any IRQ is pending — so JS needs one crossing per batch instead of
 * three (step_batch + a pending probe + the watchdog poll).
 * Returns:
 *   0x8000_0000  = watchdog reset requested (stop the run)
 *   0x4000_0000  = at least one IRQ pending (dispatch via intr_next loop)
 *   0            = nothing pending
 * The pending probe is EXACTLY equivalent to the first intr_next() call
 * (same INTR_MASK statics + same find_highest_pending), minus the pop —
 * the actual pop still happens in JS after processDma, preserving dispatch
 * order. Watchdog requests made *during* IRQ handlers are still caught by
 * the JS is_watchdog_reset_requested() check after processInterrupts.
 */
export function process_batch(count: number): number;

/**
 * Current PWM duty (0-100) of a timer channel; 0 if addr is not a timer.
 */
export function pwm_duty(addr: number, channel: number): number;

/**
 * Live current-draw estimate in µA (see `pwr_estimate_ua` for the caveats).
 */
export function pwr_estimate(): number;

/**
 * Live power state from the model (0=RUN, 1=SLEEP, 2=STOP, 3=STANDBY).
 * Truthful mode tracking for tests and host tools; current-draw numbers
 * stay a documented estimate (DS5319-typical, uncalibrated — see
 * docs/PERIPHERALS.md), not a modeled quantity.
 */
export function pwr_mode(): number;

/**
 * Set the modeled PWR supply in mV (test entry point for PVD ramps
 * across the PLS thresholds, default 3300). Returns the new PVDO level.
 */
export function pwr_set_supply_mv(mv: number): boolean;

/**
 * Raise a fault (kind: 0=fetch, 1=data read, 2=data write, 3=undef instruction).
 * Sets SCB CFSR/HFSR/BFAR and pends the fault exception (with SHCSR escalation
 * to HardFault when the specific fault handler is disabled).
 */
export function raise_fault(kind: number, addr: number): void;

/**
 * Full configured clock tree (sysclk, hclk, pclk1, pclk2) in Hz decoded
 * from RCC CFGR HPRE/PPRE1/PPRE2 (HSE assumed 8 MHz). Audit surface for
 * the divider half of the tree; timing stays instruction-budget based.
 */
export function rcc_clocks_hz(): Uint32Array;

/**
 * Inject an HSE clock failure (test entry point for the CSS path):
 * HSERDY clears; with CSSON set this raises CSSF, pends an NMI and falls
 * back to HSI. Returns true when CSS fired.
 */
export function rcc_fail_hse(): boolean;

/**
 * MCO pin output in Hz from CFGR[26:24] (0 = no clock output).
 */
export function rcc_mco_hz(): number;

/**
 * Configured SYSCLK in Hz decoded from RCC CFGR (HSE assumed 8 MHz).
 * Timing stays instruction-budget based; for drivers computing dividers.
 */
export function rcc_sysclk_hz(): number;

/**
 * Register a peripheral implemented entirely in JS (rp2040js-style custom
 * chip). Callbacks are invoked with `(addr, size)` / `(addr, value, size)`
 * where addr is the ABSOLUTE access address. Requires init()/init_svd() first;
 * last registration wins on overlap. Returns false if not initialized.
 */
export function register_js_peripheral(base: number, size: number, read: Function, write: Function): boolean;

/**
 * Clear all registered ext devices (spi flash, eeprom, oled, lcd, touchscreen,
 * fsmc, software spi). Call BEFORE adding devices for a new emulator instance —
 * otherwise devices from a previous init (stale CS pins reading low on the
 * fresh GPIO) shadow the new ones during SPI/I2C device selection.
 */
export function reset_ext_devices(): void;

/**
 * Dispatch all pending interrupts within the shared per-batch budget.
 * Returns the number of IRQs dispatched.
 */
export function rustcpu_dispatch(): number;

/**
 * Whole DMA pump against Rust RAM with no JS crossings: build the op plan
 * and execute it in one call.
 */
export function rustcpu_dma_pump(): void;

/**
 * Pending CPU fault, if the last run/dispatch stopped on one: empty when
 * clean, else [pc, op1, op2, len]. (Periph39 runs fault-free; anything here
 * is a loud decoder gap.)
 */
export function rustcpu_fault(): Uint32Array;

export function rustcpu_fault_clear(): void;

/**
 * Fires when I2C1 DR was written with the R-bit set (HAL I2C1 ISR needs
 * hi2c->Mode == 0x22 before reading DR). The driver drains the model flag
 * per batch, then patches RAM *(0x200002d8)+0x3D.
 */
export function rustcpu_i2c_hook_fired(): boolean;

/**
 * Create the CPU + guest RAM. Call after init()/init_svd() and before load.
 * `dsp` is always false here (Cortex-M3 has no DSP extension).
 */
export function rustcpu_init(sp: number, pc: number, flash_size: number, ram_size: number): void;

/**
 * Load firmware bytes at a guest physical address (bypasses flash
 * protection, like a debugger memory write at load time).
 */
export function rustcpu_load(data: Uint8Array, base: number): void;

/**
 * Raw guest-memory access (RAM + flash; flash writes stay protected, use
 * rustcpu_load for firmware). Bypasses MPU checks like a debugger would.
 * Backs memRead32 + the hi2c Mode RAM patch.
 */
export function rustcpu_mem_read(addr: number, len: number): Uint8Array;

export function rustcpu_mem_write(addr: number, data: Uint8Array): void;

/**
 * Raw guest-memory write for debugger clients (GDB `M` packets, BKPT
 * patching): bypasses flash protection and MPU checks like a probe would.
 * Firmware install should still use rustcpu_load.
 */
export function rustcpu_mem_write_raw(addr: number, data: Uint8Array): void;

/**
 * Registers for getRegisters/getPc/getSp parity + debugging:
 * [r0..r12, sp, lr, pc, xpsr, primask, control, ipsr] (20 words).
 */
export function rustcpu_regs(): Uint32Array;

/**
 * Run the CPU for up to `slice` instructions. SVC is dispatched inline onto
 * the real stack (no mirror needed); any other fault stops the run and is
 * reported via rustcpu_fault(). Returns instructions actually executed
 * (thread + handler), for exact accounting.
 */
export function rustcpu_run(slice: number): number;

export function rustcpu_set_pc(pc: number): void;

/**
 * Debugger register write (GDB `P` packet): r0-r12, SP (bank-synced like
 * the run loop), LR, PC (forced Thumb). xPSR is read-only here.
 */
export function rustcpu_set_reg(i: number, v: number): void;

/**
 * Drain recorded writes as flat [addr, size, value, ...]. Clears the log.
 */
export function rustcpu_take_writes(): Uint32Array;

/**
 * Enable/disable recording of peripheral writes (driver enables when a
 * write watcher subscribes, disables when the last one leaves).
 */
export function rustcpu_write_tap(on: boolean): void;

/**
 * Select the emulated chip's IDCODE (see DBG_IDCODE). Call after init().
 */
export function set_dbg_idcode(code: number): void;

/**
 * Set PRIMASK and BASEPRI values from CPU state.
 */
export function set_intr_masks(primask: number, basepri: number): void;

/**
 * Queue injected MISO bytes for a SPI channel (virtual device -> MCU).
 */
export function spi_inject_miso(channel: number, bytes: Uint8Array): void;

/**
 * Combined per-instruction step: sets masks, ticks peripherals, checks conditions.
 * Returns: 0=continue, 1=watchdog reset, 2=DMA pending, 3=interrupt pending.
 */
export function step(primask: number, basepri: number): number;

/**
 * Process a batch of N instructions in one WASM call.
 * Peripheral ticks are instruction-delta based (each reads INSTRUCTION_COUNT
 * and accumulates elapsed time), so one tick after advancing the count by N
 * is equivalent to N per-instruction ticks — but ~N× cheaper (tick() was
 * ~55% of runtime via 100K iterations per batch).
 * Returns: 0=continue, 1=watchdog reset.
 */
export function step_batch(count: number): number;

/**
 * Install a data watchpoint: kind 1 = write (GDB Z2), 2 = read (Z3),
 * 3 = access (Z4). Returns the slot (0-3) or -1 when full.
 */
export function swd_add_watchpoint(kind: number, addr: number, len: number): number;

/**
 * MEM-AP register read. Bank-0 DRW (reg 0xC) performs the data movement:
 * reads TAR-width bytes, latches RDBUFF, auto-increments TAR.
 */
export function swd_ap_read(bank: number, reg: number): number;

/**
 * MEM-AP register write. Bank-0 DRW (reg 0xC) stores TAR-width bytes and
 * auto-increments TAR.
 */
export function swd_ap_write(bank: number, reg: number, value: number): void;

export function swd_dp_read(addr: number): number;

export function swd_dp_write(addr: number, value: number): void;

/**
 * External halt request (probe/GDB Ctrl-C path): sets C_DEBUGEN+C_HALT.
 */
export function swd_halt(): void;

export function swd_halted(): boolean;

/**
 * JTAG APACC shift with explicit bank. DRW register moves data like the
 * SWD AP path (rnw=true reads, false writes); other registers are direct.
 */
export function swd_jtag_ap(bank: number, reg: number, rnw: boolean, wdata: number): number;

export function swd_jtag_dp(addr: number, rnw: boolean, wdata: number): number;

export function swd_jtag_idcode(): number;

export function swd_jtag_ir(ir: number): void;

export function swd_jtag_reset(): void;

/**
 * DCRSR-style core register read (0-12, 13 SP, 14 LR, 15 PC, 16 xPSR,
 * 17 MSP, 18 PSP). Synchronous: DCRDR holds the value on return.
 */
export function swd_reg_read(idx: number): number;

/**
 * DCRSR-style core register write (same numbering). Synchronous.
 */
export function swd_reg_write(idx: number, value: number): void;

export function swd_remove_watchpoint(slot: number): void;

/**
 * Debugger resume: clears C_HALT (C_DEBUGEN stays, like silicon).
 */
export function swd_resume(): void;

/**
 * Single-step the halted core once (0/1 executed; faults stay live).
 */
export function swd_step(): number;

/**
 * Take the pending watch trip: [] when clean, else [addr, dir] with dir
 * 1 = write, 2 = read. One-shot latch; the halt stays until resume.
 */
export function swd_take_trip(): Uint32Array;

export function tick(): void;

/**
 * Set touch coordinates on a touchscreen device. Must be called after init().
 */
export function touchscreen_set_touch(peripheral: string, x: number, y: number, pressure: number): void;

/**
 * Inject a LIN break (13 low bits) into the UART at the given peripheral
 * base address: LBD in LIN mode, framing error + 0x00 byte otherwise.
 * Returns true if a peripheral was found at that address.
 */
export function uart_inject_break(addr: number): boolean;

/**
 * Inject a received byte into the UART at the given peripheral base address.
 * Returns true if a peripheral was found at that address.
 */
export function uart_rx_byte(addr: number, byte: number): boolean;

/**
 * Number of unread bytes still queued in the UART RX buffer at addr.
 */
export function uart_rx_pending(addr: number): number;

/**
 * Host-driven USB bus reset (SE0): device address clears, endpoints
 * reset, RESET event + IRQ — what a real plug-in sends. Returns false
 * with no USB peripheral mapped.
 */
export function usb_bus_reset(): boolean;

/**
 * Host disconnect (pull-up off): tokens stop, IN never completes, SOF
 * freezes; the next bus reset reattaches. Returns false with no USB
 * peripheral mapped.
 */
export function usb_detach(): boolean;

/**
 * Inject a USB OUT packet into an endpoint's RX buffer (host -> device).
 * `addr` selects hardware address filtering (None = correctly-addressed
 * host). Returns false when NAKed/filtered or the address is bad.
 */
export function usb_inject_out(ep: number, data: Uint8Array, addr?: number | null): boolean;

/**
 * Inject a USB SETUP packet (8 bytes) into EP0's RX buffer (host -> device).
 * `addr` selects hardware address filtering (None = correctly-addressed
 * host). Returns false when NAKed/filtered or the address is bad.
 */
export function usb_inject_setup(data: Uint8Array, addr?: number | null): boolean;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly adc_set_internal: (a: number, b: number) => void;
    readonly adc_set_rc_tau: (a: number) => void;
    readonly adc_set_sim_value: (a: number) => void;
    readonly add_fsmc_bank: (a: number, b: number, c: number, d: number) => void;
    readonly add_i2c_eeprom: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly add_i2c_oled: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly add_lcd: (a: number, b: number, c: number, d: number) => void;
    readonly add_sd_card: (a: number, b: number, c: number, d: number) => void;
    readonly add_software_spi: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => void;
    readonly add_spi_flash: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly add_touchscreen: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly board_boot0: (a: number) => void;
    readonly board_boot0_get: () => number;
    readonly board_info: (a: number) => [number, number];
    readonly board_nrst: () => number;
    readonly bootloader_enable: (a: number) => void;
    readonly bootloader_go_addr: () => number;
    readonly can_inject_message: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly clear_current_interrupt: () => void;
    readonly dma_absorb_periph: (a: number, b: number) => [number, number];
    readonly dma_get_all_pending: () => [number, number];
    readonly dma_get_pending: (a: number) => [number, number];
    readonly dma_get_pending_count: () => number;
    readonly dma_pump_all: () => [number, number];
    readonly dma_push_periph: (a: number, b: number, c: number) => void;
    readonly dma_set_completed: (a: number, b: number) => void;
    readonly dma_set_completed_many: (a: number) => void;
    readonly dma_take_absorbed: (a: number, b: number) => [number, number];
    readonly drain_events: () => [number, number];
    readonly finish_interrupt: (a: number) => void;
    readonly fsmc_read_byte: (a: number, b: number, c: number) => number;
    readonly fsmc_write_byte: (a: number, b: number, c: number, d: number) => number;
    readonly get_next_pending_interrupt: () => number;
    readonly get_uart_output: () => [number, number];
    readonly gpio_read_input: (a: number, b: number) => number;
    readonly gpio_read_output: (a: number, b: number) => number;
    readonly gpio_set_analog: (a: number, b: number, c: number) => void;
    readonly gpio_set_input: (a: number, b: number, c: number) => void;
    readonly gpio_set_slew: (a: number) => void;
    readonly gpio_take_pin_events: () => [number, number];
    readonly has_pending_interrupt: () => number;
    readonly i2c_inject_alert: (a: number) => number;
    readonly i2c_inject_read: (a: number) => number;
    readonly i2c_inject_rx: (a: number, b: number, c: number) => void;
    readonly i2c_inject_start: (a: number, b: number, c: number) => number;
    readonly i2c_inject_stop: (a: number) => number;
    readonly i2c_inject_write: (a: number, b: number) => number;
    readonly i2c_oled_fb: (a: number, b: number, c: number) => [number, number];
    readonly i2c_oled_writes: (a: number, b: number, c: number) => bigint;
    readonly init: () => void;
    readonly init_svd: (a: number, b: number) => void;
    readonly intr_next: () => number;
    readonly is_watchdog_reset_requested: () => number;
    readonly lcd_fb: (a: number, b: number) => [number, number];
    readonly otg_bus_reset: () => number;
    readonly otg_detach: () => number;
    readonly otg_host_attach: (a: number) => number;
    readonly otg_host_feed_in: (a: number, b: number, c: number, d: number) => number;
    readonly otg_inject_out: (a: number, b: number, c: number, d: number) => number;
    readonly otg_inject_setup: (a: number, b: number, c: number) => number;
    readonly periph_read: (a: number, b: number) => number;
    readonly periph_write: (a: number, b: number, c: number) => void;
    readonly process_batch: (a: number) => number;
    readonly pwm_duty: (a: number, b: number) => number;
    readonly pwr_estimate: () => number;
    readonly pwr_mode: () => number;
    readonly pwr_set_supply_mv: (a: number) => number;
    readonly raise_fault: (a: number, b: number) => void;
    readonly rcc_clocks_hz: () => [number, number];
    readonly rcc_fail_hse: () => number;
    readonly rcc_mco_hz: () => number;
    readonly rcc_sysclk_hz: () => number;
    readonly register_js_peripheral: (a: number, b: number, c: any, d: any) => number;
    readonly reset_ext_devices: () => void;
    readonly rustcpu_dispatch: () => number;
    readonly rustcpu_dma_pump: () => void;
    readonly rustcpu_fault: () => [number, number];
    readonly rustcpu_fault_clear: () => void;
    readonly rustcpu_i2c_hook_fired: () => number;
    readonly rustcpu_init: (a: number, b: number, c: number, d: number) => void;
    readonly rustcpu_load: (a: number, b: number, c: number) => void;
    readonly rustcpu_mem_read: (a: number, b: number) => [number, number];
    readonly rustcpu_mem_write: (a: number, b: number, c: number) => void;
    readonly rustcpu_mem_write_raw: (a: number, b: number, c: number) => void;
    readonly rustcpu_regs: () => [number, number];
    readonly rustcpu_run: (a: number) => number;
    readonly rustcpu_set_pc: (a: number) => void;
    readonly rustcpu_set_reg: (a: number, b: number) => void;
    readonly rustcpu_take_writes: () => [number, number];
    readonly rustcpu_write_tap: (a: number) => void;
    readonly set_dbg_idcode: (a: number) => void;
    readonly set_intr_masks: (a: number, b: number) => void;
    readonly spi_inject_miso: (a: number, b: number, c: number) => void;
    readonly step: (a: number, b: number) => number;
    readonly step_batch: (a: number) => number;
    readonly swd_add_watchpoint: (a: number, b: number, c: number) => number;
    readonly swd_ap_read: (a: number, b: number) => number;
    readonly swd_ap_write: (a: number, b: number, c: number) => void;
    readonly swd_dp_read: (a: number) => number;
    readonly swd_dp_write: (a: number, b: number) => void;
    readonly swd_halt: () => void;
    readonly swd_halted: () => number;
    readonly swd_jtag_ap: (a: number, b: number, c: number, d: number) => number;
    readonly swd_jtag_dp: (a: number, b: number, c: number) => number;
    readonly swd_jtag_idcode: () => number;
    readonly swd_jtag_ir: (a: number) => void;
    readonly swd_jtag_reset: () => void;
    readonly swd_reg_read: (a: number) => number;
    readonly swd_reg_write: (a: number, b: number) => void;
    readonly swd_remove_watchpoint: (a: number) => void;
    readonly swd_resume: () => void;
    readonly swd_step: () => number;
    readonly swd_take_trip: () => [number, number];
    readonly tick: () => void;
    readonly touchscreen_set_touch: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly uart_inject_break: (a: number) => number;
    readonly uart_rx_byte: (a: number, b: number) => number;
    readonly uart_rx_pending: (a: number) => number;
    readonly usb_bus_reset: () => number;
    readonly usb_detach: () => number;
    readonly usb_inject_out: (a: number, b: number, c: number, d: number) => number;
    readonly usb_inject_setup: (a: number, b: number, c: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
