/* @ts-self-types="./stm32_bluepill_wasm.d.ts" */

/**
 * Override an internal ADC channel (16=temp, 17=VREFINT, 18=VBAT) with a
 * 12-bit value; pass 65535 (u16::MAX) to clear back to nominal.
 * @param {number} channel
 * @param {number} val
 */
export function adc_set_internal(channel, val) {
    wasm.adc_set_internal(channel, val);
}

/**
 * RC sample-and-hold time constant in ADC cycles (1 instr = 1 cycle).
 * @param {number} cycles
 */
export function adc_set_rc_tau(cycles) {
    wasm.adc_set_rc_tau(cycles);
}

/**
 * @param {number} val
 */
export function adc_set_sim_value(val) {
    wasm.adc_set_sim_value(val);
}

/**
 * Add an FSMC NOR/PSRAM memory device backed by `data` (byte image).
 * `name` must be FSMC.BANK1..4 (NE1-4), FSMC.BANK5..6 (NAND), or FSMC.BANK7
 * (PC Card). Must be called before init().
 * @param {string} name
 * @param {Uint8Array} data
 */
export function add_fsmc_bank(name, data) {
    const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    wasm.add_fsmc_bank(ptr0, len0, ptr1, len1);
}

/**
 * Add an I2C EEPROM device. Must be called before init().
 * @param {string} peripheral
 * @param {number} address
 * @param {Uint8Array} data
 */
export function add_i2c_eeprom(peripheral, address, data) {
    const ptr0 = passStringToWasm0(peripheral, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    wasm.add_i2c_eeprom(ptr0, len0, address, ptr1, len1);
}

/**
 * Add an I2C OLED display device (e.g. SSD1306). Must be called before init().
 * @param {string} peripheral
 * @param {number} address
 * @param {number} width
 * @param {number} height
 */
export function add_i2c_oled(peripheral, address, width, height) {
    const ptr0 = passStringToWasm0(peripheral, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    wasm.add_i2c_oled(ptr0, len0, address, width, height);
}

/**
 * Add an SPI LCD display device (e.g. ST7789, ILI9341). Must be called before init().
 * @param {string} peripheral
 * @param {string | null} [cs]
 */
export function add_lcd(peripheral, cs) {
    const ptr0 = passStringToWasm0(peripheral, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    var ptr1 = isLikeNone(cs) ? 0 : passStringToWasm0(cs, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len1 = WASM_VECTOR_LEN;
    wasm.add_lcd(ptr0, len0, ptr1, len1);
}

/**
 * Add an SD card image for the SDIO peripheral (SDHC, 512 B sectors).
 * Must be called before init().
 * @param {string} peripheral
 * @param {Uint8Array} data
 */
export function add_sd_card(peripheral, data) {
    const ptr0 = passStringToWasm0(peripheral, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    wasm.add_sd_card(ptr0, len0, ptr1, len1);
}

/**
 * Register a software SPI device. Must be called before init().
 * @param {string} name
 * @param {string | null | undefined} cs
 * @param {string} clk
 * @param {string} miso
 * @param {string} mosi
 */
export function add_software_spi(name, cs, clk, miso, mosi) {
    const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    var ptr1 = isLikeNone(cs) ? 0 : passStringToWasm0(cs, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(clk, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passStringToWasm0(miso, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passStringToWasm0(mosi, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len4 = WASM_VECTOR_LEN;
    wasm.add_software_spi(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4);
}

/**
 * Add an SPI flash device. Must be called before init().
 * @param {string} peripheral
 * @param {number} jedec_id
 * @param {Uint8Array} data
 * @param {string | null} [cs]
 */
export function add_spi_flash(peripheral, jedec_id, data, cs) {
    const ptr0 = passStringToWasm0(peripheral, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    var ptr2 = isLikeNone(cs) ? 0 : passStringToWasm0(cs, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len2 = WASM_VECTOR_LEN;
    wasm.add_spi_flash(ptr0, len0, jedec_id, ptr1, len1, ptr2, len2);
}

/**
 * Register a touchscreen device. Must be called before init().
 * @param {string} peripheral
 * @param {string | null} [touch_detected_pin]
 * @param {string | null} [cs]
 */
export function add_touchscreen(peripheral, touch_detected_pin, cs) {
    const ptr0 = passStringToWasm0(peripheral, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    var ptr1 = isLikeNone(touch_detected_pin) ? 0 : passStringToWasm0(touch_detected_pin, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len1 = WASM_VECTOR_LEN;
    var ptr2 = isLikeNone(cs) ? 0 : passStringToWasm0(cs, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len2 = WASM_VECTOR_LEN;
    wasm.add_touchscreen(ptr0, len0, ptr1, len1, ptr2, len2);
}

/**
 * Set the BOOT0 strap level (page BOOT0 jumper / host-driven probe).
 * @param {boolean} high
 */
export function board_boot0(high) {
    wasm.board_boot0(high);
}

/**
 * Read back the BOOT0 strap level.
 * @returns {boolean}
 */
export function board_boot0_get() {
    const ret = wasm.board_boot0_get();
    return ret !== 0;
}

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
 * @param {number} chip
 * @returns {Uint32Array}
 */
export function board_info(chip) {
    const ret = wasm.board_info(chip);
    var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
}

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
 * @returns {number}
 */
export function board_nrst() {
    const ret = wasm.board_nrst();
    return ret >>> 0;
}

/**
 * Enable/disable the system-memory bootloader responder (AN3155 USART
 * protocol on USART1). While enabled it claims USART1 RX and answers the
 * host flashing flow instead of the USART model.
 * @param {boolean} on
 */
export function bootloader_enable(on) {
    wasm.bootloader_enable(on);
}

/**
 * Last GO target address issued to the bootloader, or -1 when none.
 * @returns {number}
 */
export function bootloader_go_addr() {
    const ret = wasm.bootloader_go_addr();
    return ret;
}

/**
 * Inject a CAN message into the CAN peripheral at the given address.
 * Returns true if the message was accepted (matched a filter and placed in a FIFO).
 * @param {number} addr
 * @param {number} tir
 * @param {number} tdtr
 * @param {number} tdlr
 * @param {number} tdhr
 * @returns {boolean}
 */
export function can_inject_message(addr, tir, tdtr, tdlr, tdhr) {
    const ret = wasm.can_inject_message(addr, tir, tdtr, tdlr, tdhr);
    return ret !== 0;
}

/**
 * Call after an ISR returns to pop the active priority stack AND clear
 * this entry's IABR active bit (set on dispatch). The old pop-only return
 * left the bit set forever (phantom-active IRQs); the native
 * `exception_return` path clears both, so this matches it.
 */
export function clear_current_interrupt() {
    wasm.clear_current_interrupt();
}

/**
 * DMA periph->mem pump: pop `size` bytes from the peripheral at `addr` via
 * the normal periph_read path (chunks <= 4, little-endian packed), so JS only
 * writes the result to RAM once per transfer instead of one crossing per chunk.
 * @param {number} addr
 * @param {number} size
 * @returns {Uint8Array}
 */
export function dma_absorb_periph(addr, size) {
    const ret = wasm.dma_absorb_periph(addr, size);
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
}

/**
 * @returns {Uint32Array}
 */
export function dma_get_all_pending() {
    const ret = wasm.dma_get_all_pending();
    var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
}

/**
 * @param {number} index
 * @returns {Uint32Array}
 */
export function dma_get_pending(index) {
    const ret = wasm.dma_get_pending(index);
    var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
}

/**
 * @returns {number}
 */
export function dma_get_pending_count() {
    const ret = wasm.dma_get_pending_count();
    return ret >>> 0;
}

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
 * @returns {Uint32Array}
 */
export function dma_pump_all() {
    const ret = wasm.dma_pump_all();
    var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
}

/**
 * DMA mem->periph pump: push `data` bytes into the peripheral at `addr` via
 * the normal periph_write path (chunks <= 4, little-endian unpacked), so JS
 * only reads RAM once per transfer instead of one crossing per chunk.
 * @param {number} addr
 * @param {Uint8Array} data
 */
export function dma_push_periph(addr, data) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    wasm.dma_push_periph(addr, ptr0, len0);
}

/**
 * @param {number} stream_idx
 * @param {boolean} success
 */
export function dma_set_completed(stream_idx, success) {
    wasm.dma_set_completed(stream_idx, success);
}

/**
 * @param {number} bits
 */
export function dma_set_completed_many(bits) {
    wasm.dma_set_completed_many(bits);
}

/**
 * Fetch a slice of the bytes absorbed by the last dma_pump_all() (offset,
 * length) so JS can mem_write them into RAM. Clears the whole buffer.
 * @param {number} offset
 * @param {number} len
 * @returns {Uint8Array}
 */
export function dma_take_absorbed(offset, len) {
    const ret = wasm.dma_take_absorbed(offset, len);
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
}

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
 * @returns {Int32Array}
 */
export function drain_events() {
    const ret = wasm.drain_events();
    var v1 = getArrayI32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
}

/**
 * Call after an ISR returns: pops the active priority stack, and for SysTick
 * (irq == -1) also drains any unconsumed 1ms debt ticks internally (re-pends
 * each), so JS needs no nvic_systick_take loop.
 * @param {number} irq
 */
export function finish_interrupt(irq) {
    wasm.finish_interrupt(irq);
}

/**
 * Read a byte from an FSMC backing image (bypasses the peripheral bus).
 * Returns the byte value (0..255) or -1 if the bank/offset is invalid.
 * @param {string} name
 * @param {number} offset
 * @returns {number}
 */
export function fsmc_read_byte(name, offset) {
    const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.fsmc_read_byte(ptr0, len0, offset);
    return ret;
}

/**
 * Write a byte directly into an FSMC backing image (bypasses the peripheral
 * bus — no events, no side effects).  Returns true on success.
 * Use this from JS virtual peripherals to feed read-back data to the MCU.
 * @param {string} name
 * @param {number} offset
 * @param {number} value
 * @returns {boolean}
 */
export function fsmc_write_byte(name, offset, value) {
    const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.fsmc_write_byte(ptr0, len0, offset, value);
    return ret !== 0;
}

/**
 * @returns {number}
 */
export function get_next_pending_interrupt() {
    const ret = wasm.get_next_pending_interrupt();
    return ret;
}

/**
 * Collect UART output since last call.
 * @returns {string}
 */
export function get_uart_output() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.get_uart_output();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * @param {number} port
 * @param {number} pin
 * @returns {boolean}
 */
export function gpio_read_input(port, pin) {
    const ret = wasm.gpio_read_input(port, pin);
    return ret !== 0;
}

/**
 * @param {number} port
 * @param {number} pin
 * @returns {boolean}
 */
export function gpio_read_output(port, pin) {
    const ret = wasm.gpio_read_output(port, pin);
    return ret !== 0;
}

/**
 * Set an analog wire voltage on a GPIO pin (12-bit, 0xFFFF clears it).
 * ADC channels mapped to the pin then sample this voltage with an RC
 * sample-and-hold model instead of the injected simulation value.
 * @param {number} port
 * @param {number} pin
 * @param {number} level
 */
export function gpio_set_analog(port, pin, level) {
    wasm.gpio_set_analog(port, pin, level);
}

/**
 * @param {number} port
 * @param {number} pin
 * @param {boolean} value
 */
export function gpio_set_input(port, pin, value) {
    wasm.gpio_set_input(port, pin, value);
}

/**
 * Set the GPIO output slew delay in instructions (0 = instant). Affects IDR
 * readback only; device callbacks stay instant.
 * @param {number} inst
 */
export function gpio_set_slew(inst) {
    wasm.gpio_set_slew(inst);
}

/**
 * Drain buffered pin-change events as a flat [port, pin, level, ...] array
 * (chip-driven output level changes only). Cleared on the next init().
 * @returns {Uint32Array}
 */
export function gpio_take_pin_events() {
    const ret = wasm.gpio_take_pin_events();
    var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
}

/**
 * Check if any interrupt is pending, respecting PRIMASK/BASEPRI.
 * @returns {boolean}
 */
export function has_pending_interrupt() {
    const ret = wasm.has_pending_interrupt();
    return ret !== 0;
}

/**
 * Drop all queued injected RX bytes for an I2C channel. Reactive runners
 * clear-then-prefill at read-START so stale leftovers never poison the
 * front (empty queue still NACKs the address phase, as before).
 * @param {number} channel
 */
export function i2c_clear_rx(channel) {
    wasm.i2c_clear_rx(channel);
}

/**
 * SMBus ALERT input: peer pulled SMBA low on this channel → SR1 SMBALERT
 * flag (+ error IRQ when ITERREN). Returns false when disabled/no channel.
 * @param {number} channel
 * @returns {boolean}
 */
export function i2c_inject_alert(channel) {
    const ret = wasm.i2c_inject_alert(channel);
    return ret !== 0;
}

/**
 * @param {number} channel
 * @returns {number}
 */
export function i2c_inject_read(channel) {
    const ret = wasm.i2c_inject_read(channel);
    return ret;
}

/**
 * Queue injected RX bytes for an I2C channel (virtual device -> MCU).
 * @param {number} channel
 * @param {Uint8Array} bytes
 */
export function i2c_inject_rx(channel, bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    wasm.i2c_inject_rx(channel, ptr0, len0);
}

/**
 * Host-side I2C slave transactions: address this peripheral as a slave
 * from an external host (see `I2C1`/`I2C2` slave docs). Start NACKs when
 * the peripheral is disabled/busy/unmatched; write NACKs when not in
 * slave-RX, RXNE unread or ACK cleared; read returns -1 when not in
 * slave-TX or DR empty (stretch equivalents).
 * @param {number} channel
 * @param {number} addr
 * @param {boolean} is_read
 * @returns {boolean}
 */
export function i2c_inject_start(channel, addr, is_read) {
    const ret = wasm.i2c_inject_start(channel, addr, is_read);
    return ret !== 0;
}

/**
 * @param {number} channel
 * @returns {boolean}
 */
export function i2c_inject_stop(channel) {
    const ret = wasm.i2c_inject_stop(channel);
    return ret !== 0;
}

/**
 * @param {number} channel
 * @param {number} byte
 * @returns {boolean}
 */
export function i2c_inject_write(channel, byte) {
    const ret = wasm.i2c_inject_write(channel, byte);
    return ret !== 0;
}

/**
 * Read back an I2C OLED display's framebuffer (page-major, 1 byte per column).
 * @param {string} peripheral
 * @param {number} address
 * @returns {Uint8Array}
 */
export function i2c_oled_fb(peripheral, address) {
    const ptr0 = passStringToWasm0(peripheral, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.i2c_oled_fb(ptr0, len0, address);
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * Debug: bytes the I2C OLED device received (should be ~1K+ for a full frame).
 * @param {string} peripheral
 * @param {number} address
 * @returns {bigint}
 */
export function i2c_oled_writes(peripheral, address) {
    const ptr0 = passStringToWasm0(peripheral, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.i2c_oled_writes(ptr0, len0, address);
    return BigInt.asUintN(64, ret);
}

/**
 * Initialize the emulator with hardcoded peripheral map.
 * Must be called after adding all ext devices (add_spi_flash, add_i2c_eeprom).
 * Can be called multiple times to reset emulator state.
 */
export function init() {
    wasm.init();
}

/**
 * Initialize the emulator from an SVD XML string (e.g., STM32F407.svd).
 * Must be called after adding all ext devices (add_spi_flash, add_i2c_eeprom).
 * @param {string} svd_xml
 */
export function init_svd(svd_xml) {
    const ptr0 = passStringToWasm0(svd_xml, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    wasm.init_svd(ptr0, len0);
}

/**
 * Raw engine instruction counter (same domain as pin-event tcounts).
 * The facade-level instCount does NOT credit IRQ-handler instructions,
 * so the two counters diverge under interrupt load — host observers must
 * measure edge ages in THIS domain (now - tcount), never by mixing with
 * facade counts. Returns full u64 (JS BigInt; safely < 2^53 in practice).
 * @returns {bigint}
 */
export function instruction_count_now() {
    const ret = wasm.instruction_count_now();
    return BigInt.asUintN(64, ret);
}

/**
 * Next pending IRQ within the batch budget (like get_next_pending_interrupt,
 * but capped at 64 per step/step_batch so one hot IRQ can't starve others).
 * @returns {number}
 */
export function intr_next() {
    const ret = wasm.intr_next();
    return ret;
}

/**
 * @returns {boolean}
 */
export function is_watchdog_reset_requested() {
    const ret = wasm.is_watchdog_reset_requested();
    return ret !== 0;
}

/**
 * Read back an SPI LCD display's framebuffer (128x64, 1 byte per pixel).
 * @param {string} peripheral
 * @returns {Uint8Array}
 */
export function lcd_fb(peripheral) {
    const ptr0 = passStringToWasm0(peripheral, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.lcd_fb(ptr0, len0);
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * Host-driven OTG_FS bus reset (SE0): endpoints + FIFOs + address reset,
 * USBRST + ENUMDNE events. Returns false with no OTG peripheral mapped.
 * @returns {boolean}
 */
export function otg_bus_reset() {
    const ret = wasm.otg_bus_reset();
    return ret !== 0;
}

/**
 * Host disconnect on OTG_FS (pull-up off). Returns false with no OTG
 * peripheral mapped.
 * @returns {boolean}
 */
export function otg_detach() {
    const ret = wasm.otg_detach();
    return ret !== 0;
}

/**
 * Virtual-device attach/detach on the OTG_FS host port (HPRT PCSTS
 * follows, edges raise PCDET + HPRTINT).
 * @param {boolean} present
 * @returns {boolean}
 */
export function otg_host_attach(present) {
    const ret = wasm.otg_host_attach(present);
    return ret !== 0;
}

/**
 * Answer a pending OTG_FS host IN token on `ep` with `data` (or a STALL
 * handshake when `stall`). Returns false when no IN token is waiting.
 * @param {number} ep
 * @param {Uint8Array} data
 * @param {boolean} stall
 * @returns {boolean}
 */
export function otg_host_feed_in(ep, data, stall) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.otg_host_feed_in(ep, ptr0, len0, stall);
    return ret !== 0;
}

/**
 * Inject a USB OTG_FS OUT packet into an endpoint's RX FIFO (host ->
 * device). `addr` selects hardware address filtering (None =
 * correctly-addressed host). Returns false when dropped.
 * @param {number} ep
 * @param {Uint8Array} data
 * @param {number | null} [addr]
 * @returns {boolean}
 */
export function otg_inject_out(ep, data, addr) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.otg_inject_out(ep, ptr0, len0, isLikeNone(addr) ? 0xFFFFFF : addr);
    return ret !== 0;
}

/**
 * Inject a USB OTG_FS SETUP packet (8 bytes) into EP0's RX FIFO (host ->
 * device). `addr` selects hardware address filtering (None =
 * correctly-addressed host). Returns false when dropped.
 * @param {Uint8Array} data
 * @param {number | null} [addr]
 * @returns {boolean}
 */
export function otg_inject_setup(data, addr) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.otg_inject_setup(ptr0, len0, isLikeNone(addr) ? 0xFFFFFF : addr);
    return ret !== 0;
}

/**
 * @param {number} addr
 * @param {number} width
 * @returns {number}
 */
export function periph_read(addr, width) {
    const ret = wasm.periph_read(addr, width);
    return ret >>> 0;
}

/**
 * @param {number} addr
 * @param {number} width
 * @param {number} value
 */
export function periph_write(addr, width, value) {
    wasm.periph_write(addr, width, value);
}

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
 * @param {number} count
 * @returns {number}
 */
export function process_batch(count) {
    const ret = wasm.process_batch(count);
    return ret >>> 0;
}

/**
 * Current PWM duty (0-100) of a timer channel; 0 if addr is not a timer.
 * @param {number} addr
 * @param {number} channel
 * @returns {number}
 */
export function pwm_duty(addr, channel) {
    const ret = wasm.pwm_duty(addr, channel);
    return ret >>> 0;
}

/**
 * Live current-draw estimate in µA (see `pwr_estimate_ua` for the caveats).
 * @returns {number}
 */
export function pwr_estimate() {
    const ret = wasm.pwr_estimate();
    return ret >>> 0;
}

/**
 * Live power state from the model (0=RUN, 1=SLEEP, 2=STOP, 3=STANDBY).
 * Truthful mode tracking for tests and host tools; current-draw numbers
 * stay a documented estimate (DS5319-typical, uncalibrated — see
 * docs/PERIPHERALS.md), not a modeled quantity.
 * @returns {number}
 */
export function pwr_mode() {
    const ret = wasm.pwr_mode();
    return ret >>> 0;
}

/**
 * Set the modeled PWR supply in mV (test entry point for PVD ramps
 * across the PLS thresholds, default 3300). Returns the new PVDO level.
 * @param {number} mv
 * @returns {boolean}
 */
export function pwr_set_supply_mv(mv) {
    const ret = wasm.pwr_set_supply_mv(mv);
    return ret !== 0;
}

/**
 * Raise a fault (kind: 0=fetch, 1=data read, 2=data write, 3=undef instruction).
 * Sets SCB CFSR/HFSR/BFAR and pends the fault exception (with SHCSR escalation
 * to HardFault when the specific fault handler is disabled).
 * @param {number} kind
 * @param {number} addr
 */
export function raise_fault(kind, addr) {
    wasm.raise_fault(kind, addr);
}

/**
 * Full configured clock tree (sysclk, hclk, pclk1, pclk2) in Hz decoded
 * from RCC CFGR HPRE/PPRE1/PPRE2 (HSE assumed 8 MHz). Audit surface for
 * the divider half of the tree; timing stays instruction-budget based.
 * @returns {Uint32Array}
 */
export function rcc_clocks_hz() {
    const ret = wasm.rcc_clocks_hz();
    var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
}

/**
 * Inject an HSE clock failure (test entry point for the CSS path):
 * HSERDY clears; with CSSON set this raises CSSF, pends an NMI and falls
 * back to HSI. Returns true when CSS fired.
 * @returns {boolean}
 */
export function rcc_fail_hse() {
    const ret = wasm.rcc_fail_hse();
    return ret !== 0;
}

/**
 * MCO pin output in Hz from CFGR[26:24] (0 = no clock output).
 * @returns {number}
 */
export function rcc_mco_hz() {
    const ret = wasm.rcc_mco_hz();
    return ret >>> 0;
}

/**
 * Configured SYSCLK in Hz decoded from RCC CFGR (HSE assumed 8 MHz).
 * Timing stays instruction-budget based; for drivers computing dividers.
 * @returns {number}
 */
export function rcc_sysclk_hz() {
    const ret = wasm.rcc_sysclk_hz();
    return ret >>> 0;
}

/**
 * Register a peripheral implemented entirely in JS (rp2040js-style custom
 * chip). Callbacks are invoked with `(addr, size)` / `(addr, value, size)`
 * where addr is the ABSOLUTE access address. Requires init()/init_svd() first;
 * last registration wins on overlap. Returns false if not initialized.
 * @param {number} base
 * @param {number} size
 * @param {Function} read
 * @param {Function} write
 * @returns {boolean}
 */
export function register_js_peripheral(base, size, read, write) {
    const ret = wasm.register_js_peripheral(base, size, read, write);
    return ret !== 0;
}

/**
 * Clear all registered ext devices (spi flash, eeprom, oled, lcd, touchscreen,
 * fsmc, software spi). Call BEFORE adding devices for a new emulator instance —
 * otherwise devices from a previous init (stale CS pins reading low on the
 * fresh GPIO) shadow the new ones during SPI/I2C device selection.
 */
export function reset_ext_devices() {
    wasm.reset_ext_devices();
}

/**
 * Dispatch all pending interrupts within the shared per-batch budget.
 * Returns the number of IRQs dispatched.
 * @returns {number}
 */
export function rustcpu_dispatch() {
    const ret = wasm.rustcpu_dispatch();
    return ret >>> 0;
}

/**
 * Whole DMA pump against Rust RAM with no JS crossings: build the op plan
 * and execute it in one call.
 */
export function rustcpu_dma_pump() {
    wasm.rustcpu_dma_pump();
}

/**
 * Pending CPU fault, if the last run/dispatch stopped on one: empty when
 * clean, else [pc, op1, op2, len]. (Periph39 runs fault-free; anything here
 * is a loud decoder gap.)
 * @returns {Uint32Array}
 */
export function rustcpu_fault() {
    const ret = wasm.rustcpu_fault();
    var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
}

export function rustcpu_fault_clear() {
    wasm.rustcpu_fault_clear();
}

/**
 * Fires when I2C1 DR was written with the R-bit set (HAL I2C1 ISR needs
 * hi2c->Mode == 0x22 before reading DR). The driver drains the model flag
 * per batch, then patches RAM *(0x200002d8)+0x3D.
 * @returns {boolean}
 */
export function rustcpu_i2c_hook_fired() {
    const ret = wasm.rustcpu_i2c_hook_fired();
    return ret !== 0;
}

/**
 * Create the CPU + guest RAM. Call after init()/init_svd() and before load.
 * `dsp` is always false here (Cortex-M3 has no DSP extension).
 * @param {number} sp
 * @param {number} pc
 * @param {number} flash_size
 * @param {number} ram_size
 */
export function rustcpu_init(sp, pc, flash_size, ram_size) {
    wasm.rustcpu_init(sp, pc, flash_size, ram_size);
}

/**
 * Load firmware bytes at a guest physical address (bypasses flash
 * protection, like a debugger memory write at load time).
 * @param {Uint8Array} data
 * @param {number} base
 */
export function rustcpu_load(data, base) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    wasm.rustcpu_load(ptr0, len0, base);
}

/**
 * Raw guest-memory access (RAM + flash; flash writes stay protected, use
 * rustcpu_load for firmware). Bypasses MPU checks like a debugger would.
 * Backs memRead32 + the hi2c Mode RAM patch.
 * @param {number} addr
 * @param {number} len
 * @returns {Uint8Array}
 */
export function rustcpu_mem_read(addr, len) {
    const ret = wasm.rustcpu_mem_read(addr, len);
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
}

/**
 * @param {number} addr
 * @param {Uint8Array} data
 */
export function rustcpu_mem_write(addr, data) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    wasm.rustcpu_mem_write(addr, ptr0, len0);
}

/**
 * Raw guest-memory write for debugger clients (GDB `M` packets, BKPT
 * patching): bypasses flash protection and MPU checks like a probe would.
 * Firmware install should still use rustcpu_load.
 * @param {number} addr
 * @param {Uint8Array} data
 */
export function rustcpu_mem_write_raw(addr, data) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    wasm.rustcpu_mem_write_raw(addr, ptr0, len0);
}

/**
 * Registers for getRegisters/getPc/getSp parity + debugging:
 * [r0..r12, sp, lr, pc, xpsr, primask, control, ipsr] (20 words).
 * @returns {Uint32Array}
 */
export function rustcpu_regs() {
    const ret = wasm.rustcpu_regs();
    var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
}

/**
 * Run the CPU for up to `slice` instructions. SVC is dispatched inline onto
 * the real stack (no mirror needed); any other fault stops the run and is
 * reported via rustcpu_fault(). Returns instructions actually executed
 * (thread + handler), for exact accounting.
 * @param {number} slice
 * @returns {number}
 */
export function rustcpu_run(slice) {
    const ret = wasm.rustcpu_run(slice);
    return ret >>> 0;
}

/**
 * @param {number} pc
 */
export function rustcpu_set_pc(pc) {
    wasm.rustcpu_set_pc(pc);
}

/**
 * Debugger register write (GDB `P` packet): r0-r12, SP (bank-synced like
 * the run loop), LR, PC (forced Thumb). xPSR is read-only here.
 * @param {number} i
 * @param {number} v
 */
export function rustcpu_set_reg(i, v) {
    wasm.rustcpu_set_reg(i, v);
}

/**
 * Drain recorded writes as flat [addr, size, value, ...]. Clears the log.
 * @returns {Uint32Array}
 */
export function rustcpu_take_writes() {
    const ret = wasm.rustcpu_take_writes();
    var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
}

/**
 * Enable/disable recording of peripheral writes (driver enables when a
 * write watcher subscribes, disables when the last one leaves).
 * @param {boolean} on
 */
export function rustcpu_write_tap(on) {
    wasm.rustcpu_write_tap(on);
}

/**
 * Select the emulated chip's IDCODE (see DBG_IDCODE). Call after init().
 * @param {number} code
 */
export function set_dbg_idcode(code) {
    wasm.set_dbg_idcode(code);
}

/**
 * Set PRIMASK and BASEPRI values from CPU state.
 * @param {number} primask
 * @param {number} basepri
 */
export function set_intr_masks(primask, basepri) {
    wasm.set_intr_masks(primask, basepri);
}

/**
 * Queue injected MISO bytes for a SPI channel (virtual device -> MCU).
 * @param {number} channel
 * @param {Uint8Array} bytes
 */
export function spi_inject_miso(channel, bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    wasm.spi_inject_miso(channel, ptr0, len0);
}

/**
 * Combined per-instruction step: sets masks, ticks peripherals, checks conditions.
 * Returns: 0=continue, 1=watchdog reset, 2=DMA pending, 3=interrupt pending.
 * @param {number} primask
 * @param {number} basepri
 * @returns {number}
 */
export function step(primask, basepri) {
    const ret = wasm.step(primask, basepri);
    return ret >>> 0;
}

/**
 * Process a batch of N instructions in one WASM call.
 * Peripheral ticks are instruction-delta based (each reads INSTRUCTION_COUNT
 * and accumulates elapsed time), so one tick after advancing the count by N
 * is equivalent to N per-instruction ticks — but ~N× cheaper (tick() was
 * ~55% of runtime via 100K iterations per batch).
 * Returns: 0=continue, 1=watchdog reset.
 * @param {number} count
 * @returns {number}
 */
export function step_batch(count) {
    const ret = wasm.step_batch(count);
    return ret >>> 0;
}

/**
 * Install a data watchpoint: kind 1 = write (GDB Z2), 2 = read (Z3),
 * 3 = access (Z4). Returns the slot (0-3) or -1 when full.
 * @param {number} kind
 * @param {number} addr
 * @param {number} len
 * @returns {number}
 */
export function swd_add_watchpoint(kind, addr, len) {
    const ret = wasm.swd_add_watchpoint(kind, addr, len);
    return ret;
}

/**
 * MEM-AP register read. Bank-0 DRW (reg 0xC) performs the data movement:
 * reads TAR-width bytes, latches RDBUFF, auto-increments TAR.
 * @param {number} bank
 * @param {number} reg
 * @returns {number}
 */
export function swd_ap_read(bank, reg) {
    const ret = wasm.swd_ap_read(bank, reg);
    return ret >>> 0;
}

/**
 * MEM-AP register write. Bank-0 DRW (reg 0xC) stores TAR-width bytes and
 * auto-increments TAR.
 * @param {number} bank
 * @param {number} reg
 * @param {number} value
 */
export function swd_ap_write(bank, reg, value) {
    wasm.swd_ap_write(bank, reg, value);
}

/**
 * @param {number} addr
 * @returns {number}
 */
export function swd_dp_read(addr) {
    const ret = wasm.swd_dp_read(addr);
    return ret >>> 0;
}

/**
 * @param {number} addr
 * @param {number} value
 */
export function swd_dp_write(addr, value) {
    wasm.swd_dp_write(addr, value);
}

/**
 * External halt request (probe/GDB Ctrl-C path): sets C_DEBUGEN+C_HALT.
 */
export function swd_halt() {
    wasm.swd_halt();
}

/**
 * @returns {boolean}
 */
export function swd_halted() {
    const ret = wasm.swd_halted();
    return ret !== 0;
}

/**
 * JTAG APACC shift with explicit bank. DRW register moves data like the
 * SWD AP path (rnw=true reads, false writes); other registers are direct.
 * @param {number} bank
 * @param {number} reg
 * @param {boolean} rnw
 * @param {number} wdata
 * @returns {number}
 */
export function swd_jtag_ap(bank, reg, rnw, wdata) {
    const ret = wasm.swd_jtag_ap(bank, reg, rnw, wdata);
    return ret >>> 0;
}

/**
 * @param {number} addr
 * @param {boolean} rnw
 * @param {number} wdata
 * @returns {number}
 */
export function swd_jtag_dp(addr, rnw, wdata) {
    const ret = wasm.swd_jtag_dp(addr, rnw, wdata);
    return ret >>> 0;
}

/**
 * @returns {number}
 */
export function swd_jtag_idcode() {
    const ret = wasm.swd_jtag_idcode();
    return ret >>> 0;
}

/**
 * @param {number} ir
 */
export function swd_jtag_ir(ir) {
    wasm.swd_jtag_ir(ir);
}

export function swd_jtag_reset() {
    wasm.swd_jtag_reset();
}

/**
 * DCRSR-style core register read (0-12, 13 SP, 14 LR, 15 PC, 16 xPSR,
 * 17 MSP, 18 PSP). Synchronous: DCRDR holds the value on return.
 * @param {number} idx
 * @returns {number}
 */
export function swd_reg_read(idx) {
    const ret = wasm.swd_reg_read(idx);
    return ret >>> 0;
}

/**
 * DCRSR-style core register write (same numbering). Synchronous.
 * @param {number} idx
 * @param {number} value
 */
export function swd_reg_write(idx, value) {
    wasm.swd_reg_write(idx, value);
}

/**
 * @param {number} slot
 */
export function swd_remove_watchpoint(slot) {
    wasm.swd_remove_watchpoint(slot);
}

/**
 * Debugger resume: clears C_HALT (C_DEBUGEN stays, like silicon).
 */
export function swd_resume() {
    wasm.swd_resume();
}

/**
 * Single-step the halted core once (0/1 executed; faults stay live).
 * @returns {number}
 */
export function swd_step() {
    const ret = wasm.swd_step();
    return ret >>> 0;
}

/**
 * Take the pending watch trip: [] when clean, else [addr, dir] with dir
 * 1 = write, 2 = read. One-shot latch; the halt stays until resume.
 * @returns {Uint32Array}
 */
export function swd_take_trip() {
    const ret = wasm.swd_take_trip();
    var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
}

export function tick() {
    wasm.tick();
}

/**
 * PWM output pin for a timer channel (1-based timer number, 0-based
 * channel): packed (port << 4 | pin) with the live AFIO remap applied
 * (port 0=A .. 3=D), or -1 when the timer/channel has no output pin.
 * E.g. tim_chan_pin(3, 0) = 0x06 (PA6) by default. Read-only observation
 * helper for servo/LED/buzzer wiring; -1 before init too.
 * @param {number} timer
 * @param {number} channel
 * @returns {number}
 */
export function tim_chan_pin(timer, channel) {
    const ret = wasm.tim_chan_pin(timer, channel);
    return ret;
}

/**
 * Set touch coordinates on a touchscreen device. Must be called after init().
 * @param {string} peripheral
 * @param {number} x
 * @param {number} y
 * @param {number} pressure
 */
export function touchscreen_set_touch(peripheral, x, y, pressure) {
    const ptr0 = passStringToWasm0(peripheral, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    wasm.touchscreen_set_touch(ptr0, len0, x, y, pressure);
}

/**
 * Inject a LIN break (13 low bits) into the UART at the given peripheral
 * base address: LBD in LIN mode, framing error + 0x00 byte otherwise.
 * Returns true if a peripheral was found at that address.
 * @param {number} addr
 * @returns {boolean}
 */
export function uart_inject_break(addr) {
    const ret = wasm.uart_inject_break(addr);
    return ret !== 0;
}

/**
 * Inject a received byte into the UART at the given peripheral base address.
 * Returns true if a peripheral was found at that address.
 * @param {number} addr
 * @param {number} byte
 * @returns {boolean}
 */
export function uart_rx_byte(addr, byte) {
    const ret = wasm.uart_rx_byte(addr, byte);
    return ret !== 0;
}

/**
 * Number of unread bytes still queued in the UART RX buffer at addr.
 * @param {number} addr
 * @returns {number}
 */
export function uart_rx_pending(addr) {
    const ret = wasm.uart_rx_pending(addr);
    return ret >>> 0;
}

/**
 * Host-driven USB bus reset (SE0): device address clears, endpoints
 * reset, RESET event + IRQ — what a real plug-in sends. Returns false
 * with no USB peripheral mapped.
 * @returns {boolean}
 */
export function usb_bus_reset() {
    const ret = wasm.usb_bus_reset();
    return ret !== 0;
}

/**
 * Host disconnect (pull-up off): tokens stop, IN never completes, SOF
 * freezes; the next bus reset reattaches. Returns false with no USB
 * peripheral mapped.
 * @returns {boolean}
 */
export function usb_detach() {
    const ret = wasm.usb_detach();
    return ret !== 0;
}

/**
 * Inject a USB OUT packet into an endpoint's RX buffer (host -> device).
 * `addr` selects hardware address filtering (None = correctly-addressed
 * host). Returns false when NAKed/filtered or the address is bad.
 * @param {number} ep
 * @param {Uint8Array} data
 * @param {number | null} [addr]
 * @returns {boolean}
 */
export function usb_inject_out(ep, data, addr) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.usb_inject_out(ep, ptr0, len0, isLikeNone(addr) ? 0xFFFFFF : addr);
    return ret !== 0;
}

/**
 * Inject a USB SETUP packet (8 bytes) into EP0's RX buffer (host -> device).
 * `addr` selects hardware address filtering (None = correctly-addressed
 * host). Returns false when NAKed/filtered or the address is bad.
 * @param {Uint8Array} data
 * @param {number | null} [addr]
 * @returns {boolean}
 */
export function usb_inject_setup(data, addr) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.usb_inject_setup(ptr0, len0, isLikeNone(addr) ? 0xFFFFFF : addr);
    return ret !== 0;
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_is_function_1ff95bcc5517c252: function(arg0) {
            const ret = typeof(arg0) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_undefined_c05833b95a3cf397: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_number_get_394265ed1e1b84ee: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'number' ? obj : undefined;
            getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_throw_344f42d3211c4765: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_call_44b7209e1e252e6a: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4) {
            const ret = arg0.call(arg1, arg2, arg3, arg4);
            return ret;
        }, arguments); },
        __wbg_call_a6e5c5dce5018821: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.call(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_call_e3b662382210db98: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = arg0.call(arg1, arg2, arg3);
            return ret;
        }, arguments); },
        __wbg_error_a6fa202b58aa1cd3: function(arg0, arg1) {
            let deferred0_0;
            let deferred0_1;
            try {
                deferred0_0 = arg0;
                deferred0_1 = arg1;
                console.error(getStringFromWasm0(arg0, arg1));
            } finally {
                wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
            }
        },
        __wbg_get_78f252d074a84d0b: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_new_227d7c05414eb861: function() {
            const ret = new Error();
            return ret;
        },
        __wbg_stack_3b0d974bbf31e44f: function(arg0, arg1) {
            const ret = arg1.stack;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_static_accessor_GLOBAL_4ef717fb391d88b7: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_THIS_8d1badc68b5a74f4: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_146583524fe1469b: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_f2829a2234d7819e: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbindgen_cast_0000000000000001: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_cast_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./stm32_bluepill_wasm_bg.js": import0,
    };
}

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function getArrayI32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getInt32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedInt32ArrayMemory0 = null;
function getInt32ArrayMemory0() {
    if (cachedInt32ArrayMemory0 === null || cachedInt32ArrayMemory0.byteLength === 0) {
        cachedInt32ArrayMemory0 = new Int32Array(wasm.memory.buffer);
    }
    return cachedInt32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedInt32ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('stm32_bluepill_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
