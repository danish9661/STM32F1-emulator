import { readFileSync } from 'fs';
import * as periph from '../pkg/stm32_bluepill_wasm.js';
periph.initSync({ module: readFileSync(new URL('../pkg/stm32_bluepill_wasm_bg.wasm', import.meta.url)) });

const { init, init_svd, periph_read, periph_write, tick, step_batch, has_pending_interrupt,
        get_next_pending_interrupt, clear_current_interrupt, set_intr_masks, gpio_read_output, gpio_set_input,
        gpio_read_input, get_uart_output, uart_rx_byte, uart_inject_break, adc_set_sim_value,
        is_watchdog_reset_requested, can_inject_message, gpio_set_slew, raise_fault,
        add_fsmc_bank, gpio_set_analog, adc_set_rc_tau, register_js_peripheral,
        add_sd_card, reset_ext_devices, rcc_sysclk_hz, rcc_clocks_hz, rcc_mco_hz,
        rcc_fail_hse, pwr_set_supply_mv, add_i2c_eeprom,
        drain_events, usb_inject_setup, usb_inject_out, usb_bus_reset, usb_detach, pwm_duty,
        otg_host_attach,
        swd_dp_read, swd_dp_write, swd_ap_read, swd_ap_write,
        swd_add_watchpoint, swd_remove_watchpoint, swd_halted, swd_resume,
        swd_jtag_reset, swd_jtag_idcode, rustcpu_init,        i2c_inject_start, i2c_inject_write, i2c_inject_read, i2c_inject_stop, i2c_inject_alert,
        add_lcd, lcd_fb, adc_set_internal, pwr_mode,
        gpio_take_pin_events } = periph;

let passed = 0, failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error(`FAIL: ${msg}`); }
}

function assert_eq(a, b, msg) {
  if (a === b) { passed++; }
  else { failed++; console.error(`FAIL: ${msg}: expected ${b}, got ${a}`); }
}

function assert_neq(a, b, msg) {
  if (a !== b) { passed++; }
  else { failed++; console.error(`FAIL: ${msg}: both are ${a}`); }
}

function reset() {
  init();
  // The swd_*/rustcpu_* debug exports live in the native backend (always
  // initialized in production); bring it up so debug tests can use it.
  rustcpu_init(0x20005000, 0x08000001, 65536, 20480);
}

function group(name) {
  console.log(`\n=== ${name} ===`);
}

// ============================================================
// GPIO
// ============================================================
group('GPIO');

reset();
// PC13: GPIOC base=0x40011000, ODR=0x0C, BSRR=0x10, CRH=0x04
// Set PC13 as output push-pull 50MHz via CRH bits 23:20 = 0x3
let crh = periph_read(0x40011004, 4);
crh = (crh & ~(0xF << 20)) | (0x3 << 20);
periph_write(0x40011004, 4, crh);
assert_eq(periph_read(0x40011004, 4) >> 20 & 0xF, 0x3, 'GPIO CRH PC13 mode');

// Set PC13 high via BSRR bit 13
periph_write(0x40011010, 4, 1 << 13);
assert_eq(periph_read(0x4001100C, 4) >> 13 & 1, 1, 'GPIO PC13 set via BSRR');
assert_eq(gpio_read_output(2, 13), true, 'gpio_read_output PC13 after set');

// Reset PC13 via BSRR bit 29 (= 13+16)
periph_write(0x40011010, 4, 1 << 29);
assert_eq(periph_read(0x4001100C, 4) >> 13 & 1, 0, 'GPIO PC13 reset via BSRR');
assert_eq(gpio_read_output(2, 13), false, 'gpio_read_output PC13 after reset');

// GPIO input: set PA0 as input, inject value, read back
// GPIOA base=0x40010800, CRL=0x00, IDR=0x08
let gpioa_crl = periph_read(0x40010800, 4);
gpioa_crl = (gpioa_crl & ~0xF) | 0x4; // PA0 = input floating
periph_write(0x40010800, 4, gpioa_crl);

gpio_set_input(0, 0, true);  // PA0 high
assert_eq(gpio_read_input(0, 0), true, 'GPIO PA0 input set high');

gpio_set_input(0, 0, false); // PA0 low
assert_eq(gpio_read_input(0, 0), false, 'GPIO PA0 input set low');

// BSRR should only affect set bits — verify no stray change
periph_write(0x40011010, 4, 0);
assert_eq(periph_read(0x4001100C, 4) & 0x2000, 0, 'GPIO BSRR=0 no change');

// GPIOE (0x40011800, full 16-bit port like A-D): output + input loop
let gpioe_crl = periph_read(0x40011800, 4);
gpioe_crl = (gpioe_crl & ~0xF) | 0x3; // PE0 = output push-pull
periph_write(0x40011800, 4, gpioe_crl);
periph_write(0x40011810, 4, 1);       // BSRR: PE0 set
assert_eq(periph_read(0x4001180C, 4) & 1, 1, 'GPIO PE0 set via BSRR');
assert_eq(gpio_read_output(4, 0), true, 'gpio_read_output PE0 after set');
gpio_set_input(4, 1, true);           // PE1 driven high (default input)
assert_eq(gpio_read_input(4, 1), true, 'GPIO PE1 input set high');

// ============================================================
// GPIO pin-change events (gpio_take_pin_events)
// ============================================================
group('GPIO pin events');
reset(); // init clears the event buffer

// CRL/CRH mode change to output with ODR=0: re-drives to the same level — silent
let gpioc_crh = periph_read(0x40011004, 4);
gpioc_crh = (gpioc_crh & ~(0xF << 20)) | (0x3 << 20); // PC13 output PP 50MHz
periph_write(0x40011004, 4, gpioc_crh);
assert_eq(gpio_take_pin_events().length, 0, 'pin event: CRH->output same level silent');

// BSRR set fires (2, 13, 1)
periph_write(0x40011010, 4, 1 << 13);
let ev = gpio_take_pin_events();
assert_eq(ev.length, 3, 'pin event: BSRR set emits one triple');
assert_eq(ev[0] === 2 && ev[1] === 13 && ev[2] === 1, true, 'pin event: BSRR set = (2,13,1)');

// Same-level BSRR set is silent (old==value guard in write_port)
periph_write(0x40011010, 4, 1 << 13);
assert_eq(gpio_take_pin_events().length, 0, 'pin event: same-value BSRR set silent');

// BSRR reset fires (2, 13, 0)
periph_write(0x40011010, 4, 1 << 29);
ev = gpio_take_pin_events();
assert_eq(ev.length === 3 && ev[2] === 0, true, 'pin event: BSRR reset = (2,13,0)');

// ODR same-value write is silent (iter_port_reg_changes skips unchanged pins)
periph_write(0x4001100C, 4, 0);
assert_eq(gpio_take_pin_events().length, 0, 'pin event: same-value ODR write silent');

// ODR change write fires
periph_write(0x4001100C, 4, 1 << 13);
ev = gpio_take_pin_events();
assert_eq(ev.length === 3 && ev[2] === 1, true, 'pin event: ODR change = (2,13,1)');
// gpio_set_input on a fresh pin registers an external driver (read_cb_mask):
// the level then shows in IDR even with no prior callback (pins the
// set_input_pin_raw mask regression that failed 3 tests mid-sprint).
gpio_set_input(1, 7, true); // PB7 fresh pin, no prior driver
periph_write(0x40010C00, 4, 0x4 << 28); // GPIOB CRL nibble 7 = PB7 input floating
assert_eq(periph_read(0x40010C08, 4) >> 7 & 1, 1, 'GPIO fresh-pin gpio_set_input drives IDR via mask');
gpio_set_input(1, 7, false);
assert_eq(periph_read(0x40010C08, 4) >> 7 & 1, 0, 'GPIO fresh-pin gpio_set_input low reads 0');
// CRL/CRH re-drive: input mode (ODR writes don't drive), then back to output —
// the pin re-drives ODR=0 while the wire was high → event (2,13,0)
gpioc_crh = (gpioc_crh & ~(0xF << 20)) | (0x4 << 20); // PC13 input floating
periph_write(0x40011004, 4, gpioc_crh);
assert_eq(gpio_take_pin_events().length, 0, 'pin event: input mode change silent');
periph_write(0x4001100C, 4, 0); // ODR=0 while input (no drive)
assert_eq(gpio_take_pin_events().length, 0, 'pin event: ODR write while input silent');
gpioc_crh = (gpioc_crh & ~(0xF << 20)) | (0x3 << 20); // back to output
periph_write(0x40011004, 4, gpioc_crh);
ev = gpio_take_pin_events();
assert_eq(ev.length === 3 && ev[2] === 0, true, 'pin event: CRH re-drive fires (2,13,0)');

// AF pins (cnf=0b10) emit nothing: PA7 AF push-pull, toggle ODR bit 7
let gpioa_crl2 = periph_read(0x40010800, 4);
gpioa_crl2 = (gpioa_crl2 & ~(0xF << 28)) | (0xB << 28); // PA7 AF output PP 50MHz
periph_write(0x40010800, 4, gpioa_crl2);
periph_write(0x40010810, 4, 1 << 7); // BSRR set PA7
periph_write(0x40010810, 4, 1 << 23); // BSRR reset PA7
assert_eq(gpio_take_pin_events().length, 0, 'pin event: AF pin toggles emit nothing');

// Drain twice: second drain is empty
assert_eq(gpio_take_pin_events().length, 0, 'pin event: drain empties the buffer');

// ============================================================
// USART (UART)
// ============================================================
group('USART');

reset();
const USART1 = 0x40013800;

// Enable clocks: USART1EN on APB2, GPIOAEN
periph_write(0x40021018, 4, (1 << 14) | (1 << 2)); // APB2ENR

// Configure PA9 as AFIO push-pull 50MHz (CRH bits 7:4 = 0xB)
let pa_crh = periph_read(0x40010804, 4);
pa_crh = (pa_crh & ~0xF0) | 0xB0;
periph_write(0x40010804, 4, pa_crh);

// Configure PA10 as input float (CRH bits 11:8 = 0x4)
pa_crh = (pa_crh & ~0xF00) | 0x400;
periph_write(0x40010804, 4, pa_crh);

// Set baud = 115200 @8MHz → BRR = 0x341
periph_write(USART1 + 0x08, 4, 0x341);
// Enable USART: UE | TE | RE
periph_write(USART1 + 0x0C, 4, (1 << 13) | (1 << 3) | (1 << 2));

// TX: write a byte, read SR (TXE should be set), check output buffer
let sr = periph_read(USART1 + 0x00, 4);
assert_eq(sr & (1 << 7), 1 << 7, 'USART SR TXE after init');

periph_write(USART1 + 0x04, 4, 0x41); // 'A'
assert_eq(get_uart_output(), 'A', 'USART TX output char A');

periph_write(USART1 + 0x04, 4, 0x42); // 'B'
periph_write(USART1 + 0x04, 4, 0x43); // 'C'
assert_eq(get_uart_output(), 'BC', 'USART TX output chars BC');

// UART output accumulates across reads
periph_write(USART1 + 0x04, 4, 0x58); // 'X'
periph_write(USART1 + 0x04, 4, 0x59); // 'Y'
periph_write(USART1 + 0x04, 4, 0x5A); // 'Z'
assert_eq(get_uart_output(), 'XYZ', 'USART TX output accum');

// RX: inject byte, read SR (RXNE), read DR
assert_eq(uart_rx_byte(USART1, 0x51), true, 'USART rx_byte returns true'); // 'Q'
sr = periph_read(USART1 + 0x00, 4);
assert_eq(sr & (1 << 5), 1 << 5, 'USART SR RXNE after rx_byte');
let dr = periph_read(USART1 + 0x04, 4);
assert_eq(dr & 0xFF, 0x51, 'USART RX read byte Q');

// RXNE should clear after reading DR (buffer empty)
sr = periph_read(USART1 + 0x00, 4);
// RXNE is bit 5 — firmware also clears TC/TXE on read, but those are re-set
// RXNE stays cleared when buffer is empty
assert_eq(sr & (1 << 5), 0, 'USART SR RXNE cleared after DR read');

// Multiple RX bytes
uart_rx_byte(USART1, 0x31); // '1'
uart_rx_byte(USART1, 0x32); // '2'
uart_rx_byte(USART1, 0x33); // '3'
assert_eq(periph_read(USART1 + 0x04, 4) & 0xFF, 0x31, 'USART RX first byte 1');
assert_eq(periph_read(USART1 + 0x04, 4) & 0xFF, 0x32, 'USART RX second byte 2');
assert_eq(periph_read(USART1 + 0x04, 4) & 0xFF, 0x33, 'USART RX third byte 3');

// ORE: burst past the 16-deep RX FIFO, then clear via the RM0008 SR+DR
// read sequence (a sticky ORE used to wedge UART RX forever after any
// >16-byte burst, e.g. pasted terminal lines in the echo demo)
for (let i = 0; i < 17; i++) uart_rx_byte(USART1, 0x60 + i);
sr = periph_read(USART1 + 0x00, 4);
assert_eq(sr & (1 << 3), 1 << 3, 'USART SR ORE after 17-byte burst');
for (let i = 0; i < 16; i++) assert_eq(periph_read(USART1 + 0x04, 4) & 0xFF, 0x60 + i, `USART RX drain byte ${i}`);
sr = periph_read(USART1 + 0x00, 4);
assert_eq(sr & (1 << 3), 0, 'USART SR ORE cleared by SR+DR sequence');
// UART recovers: the next byte is received normally
uart_rx_byte(USART1, 0x7A); // 'z'
sr = periph_read(USART1 + 0x00, 4);
assert_eq(sr & (1 << 5), 1 << 5, 'USART RXNE after post-ORE byte');
assert_eq(periph_read(USART1 + 0x04, 4) & 0xFF, 0x7A, 'USART RX post-ORE byte z');

// LIN break (RM0008 27.6.5): HDSEL loopback + LINEN, SBK transmits a break
// that returns to our own receiver as LBD (SR.8) with a 0x00 framing byte.
periph_write(USART1 + 0x14, 4, 1 << 3); // CR3 HDSEL (half-duplex loopback)
periph_write(USART1 + 0x10, 4, (1 << 14) | (1 << 6)); // CR2 LINEN + LBDIE
periph_write(0xE000E100 + 0x04, 4, 1 << 5); // ISER1: USART1 IRQ 37 enable
periph_write(USART1 + 0x0C, 4, (1 << 13) | (1 << 3) | (1 << 2) | 1); // UE/TE/RE + SBK
sr = periph_read(USART1 + 0x00, 4);
assert_eq(sr & (1 << 8), 1 << 8, 'USART SR LBD after looped break');
assert_eq(sr & (1 << 5), 1 << 5, 'USART SR RXNE after looped break');
assert_eq(periph_read(USART1 + 0x04, 4) & 0xFF, 0x00, 'USART DR break framing byte 0x00');
sr = periph_read(USART1 + 0x00, 4);
assert_eq(sr & (1 << 8), 0, 'USART SR LBD cleared by DR read');
assert_eq(has_pending_interrupt(), true, 'USART LBDIE pends IRQ on break');
assert_eq(get_next_pending_interrupt(), 37, 'USART break IRQ = 37');
clear_current_interrupt();
// SBK self-clears after one batch (break occupies the line briefly)
step_batch(1);
assert_eq(periph_read(USART1 + 0x0C, 4) & 1, 0, 'USART CR1 SBK self-clears');
// TXEIE+TXE pends IRQ37: STM32duino's first print uses HAL_UART_Transmit_IT,
// which stalls forever without the TXE IRQ — this arm must stay (a removal
// wedged every firmware boot with zero UART output; no storm is possible:
// the core ISR clears TXEIE once its TX ring empties).
reset();
periph_write(0x40021018, 4, (1 << 14) | (1 << 2)); // APB2ENR: USART1EN + GPIOAEN
periph_write(USART1 + 0x08, 4, 0x341); // BRR 115200
periph_write(USART1 + 0x0C, 4, (1 << 13) | (1 << 3) | (1 << 7)); // UE|TE|TXEIE
periph_write(0xE000E100 + 0x04, 4, 1 << 5); // ISER1: USART1 IRQ 37
set_intr_masks(0, 0);
step_batch(1); // tick re-asserts TXE and runs update_interrupt
assert_eq(periph_read(USART1 + 0x00, 4) & (1 << 7), 1 << 7, 'USART TXE held with TE');
assert(has_pending_interrupt() && get_next_pending_interrupt() === 37,
  'USART TXEIE+TXE pends IRQ 37');
clear_current_interrupt();
// Break outside LIN mode: framing error (FE) instead of LBD
periph_write(USART1 + 0x10, 4, 0); // LINEN off
assert_eq(uart_inject_break(USART1), true, 'uart_inject_break routes');
sr = periph_read(USART1 + 0x00, 4);
assert_eq(sr & (1 << 1), 1 << 1, 'USART SR FE after injected break');
assert_eq(sr & (1 << 8), 0, 'USART SR no LBD outside LIN mode');
assert_eq(periph_read(USART1 + 0x04, 4) & 0xFF, 0x00, 'USART DR break byte 0x00');
sr = periph_read(USART1 + 0x00, 4);
assert_eq(sr & (1 << 1), 0, 'USART SR FE cleared by DR read');

// Half-duplex single-wire (RM0008 CR3 HDSEL = bit 3): transmitted bytes
// loop back to our own receiver. Bit 2 is IRLP (IrDA low-power), NOT
// loopback — the model and this test once shared that off-by-one.
get_uart_output(); // flush
periph_write(USART1 + 0x14, 4, 0); // normal mode
periph_write(USART1 + 0x04, 4, 0x4B); // 'K' goes to the wire
assert_eq(get_uart_output(), 'K', 'USART normal TX reaches output');
periph_write(USART1 + 0x14, 4, 1 << 3); // HDSEL
periph_write(USART1 + 0x04, 4, 0x55);
assert_eq(periph_read(USART1 + 0x04, 4) & 0xFF, 0x55, 'USART HDSEL loops TX back to DR');
assert_eq(periph_read(USART1 + 0x00, 4) & (1 << 5), 1 << 5, 'USART HDSEL sets RXNE');
assert_eq(get_uart_output(), 'U', 'USART HDSEL byte still on the shared wire');
periph_write(USART1 + 0x14, 4, 1 << 2); // IRLP alone: no loopback
periph_write(USART1 + 0x04, 4, 0x4D); // 'M' goes to the wire
assert_eq(get_uart_output(), 'M', 'USART IRLP does not loop back');
periph_write(USART1 + 0x14, 4, 1 << 1); // IREN: pulse shaping only, TX unaffected
periph_write(USART1 + 0x04, 4, 0x4E); // 'N'
assert_eq(get_uart_output(), 'N', 'USART IrDA mode transmits normally');
// Smartcard registers: GTPR + SCEN/NACK stored; NACK-on-parity stays a
// no-op (PE is never set — no error injection — so nothing can NACK).
periph_write(USART1 + 0x18, 4, 0x0105); // GTPR guard time + prescaler
assert_eq(periph_read(USART1 + 0x18, 4), 0x0105, 'USART GTPR readback');
periph_write(USART1 + 0x14, 4, (1 << 5) | (1 << 4)); // SCEN + NACK
assert_eq(periph_read(USART1 + 0x14, 4) & 0x30, 0x30, 'USART CR3 SCEN/NACK stored');
periph_write(USART1 + 0x14, 4, 0); // back to normal

// ============================================================
// ADC
// ============================================================
group('ADC');

reset();
const ADC1 = 0x40012400;

// Enable ADC1 clock
periph_write(0x40021018, 4, 1 << 9); // ADC1EN

// Set simulated value
adc_set_sim_value(0x3FF);  // 1023

// Enable ADC: ADON = bit 0 of CR2
periph_write(ADC1 + 0x08, 4, 1);

// Trigger SWSTART: CR2 bit 22
let cr2 = periph_read(ADC1 + 0x08, 4);
periph_write(ADC1 + 0x08, 4, cr2 | (1 << 22));

// Conversion takes (SMP + 12.5) ADC cycles; default SMP=0 -> 14 instructions.
// EOC must NOT be set before the conversion completes.
let sradc = periph_read(ADC1 + 0x00, 4);
assert_eq(sradc & (1 << 1), 0, 'ADC EOC not set before conversion completes');

// Check EOC in SR bit 1
step_batch(14);
sradc = periph_read(ADC1 + 0x00, 4);
assert_eq(sradc & (1 << 1), 1 << 1, 'ADC SR EOC after SWSTART + 14 cycles');

// Read DR (0x4C)
let dr_val = periph_read(ADC1 + 0x4C, 4) & 0xFFF;
assert_eq(dr_val, 0x3FF, 'ADC DR value matches sim value');

// EOC should clear on DR read
sradc = periph_read(ADC1 + 0x00, 4);
assert_eq(sradc & (1 << 1), 0, 'ADC EOC cleared after DR read');

// Second conversion with different value
adc_set_sim_value(0x155); // 341
periph_write(ADC1 + 0x08, 4, (1 << 0) | (1 << 22)); // ADON + SWSTART
sradc = periph_read(ADC1 + 0x00, 4);
assert_eq(sradc & (1 << 1), 0, 'ADC EOC not set before second conversion completes');
step_batch(14);
sradc = periph_read(ADC1 + 0x00, 4);
assert_eq(sradc & (1 << 1), 1 << 1, 'ADC SR EOC after second SWSTART');
dr_val = periph_read(ADC1 + 0x4C, 4) & 0xFFF;
assert_eq(dr_val, 0x155, 'ADC DR second value');

// Internal channel override: drive the temp sensor (ch16) without
// hardware, then clear back to the 0x6EE nominal. tau=1 settles instantly
// (the RC model would otherwise still be charging from the last channel).
adc_set_rc_tau(1);
periph_write(ADC1 + 0x34, 4, 16); // SQR3 SQ1 = ch16
adc_set_internal(16, 0xABC);
periph_write(ADC1 + 0x08, 4, (1 << 0) | (1 << 22)); // ADON + SWSTART
step_batch(14);
assert_eq(periph_read(ADC1 + 0x00, 4) & (1 << 1), 1 << 1, 'ADC SR EOC on ch16');
assert_eq(periph_read(ADC1 + 0x4C, 4) & 0xFFF, 0xABC, 'ADC DR temp override');
adc_set_internal(16, 65535); // clear to nominal
periph_write(ADC1 + 0x08, 4, (1 << 0) | (1 << 22));
step_batch(14);
assert_eq(periph_read(ADC1 + 0x4C, 4) & 0xFFF, 0x6EE, 'ADC DR temp nominal 0x6EE');
periph_write(ADC1 + 0x34, 4, 0); // SQR3 SQ1 back to ch0
adc_set_rc_tau(12); // restore default tau
assert_eq(pwr_mode(), 0, 'pwr_mode RUN after init');

// RC sample-and-hold: wire 3.3V analog to PA0 (channel 0), sample with a
// large RC tau so the cap does NOT reach the target within one sample window.
// A newly reset cap (0 V) converts to a fraction of the full scale.
reset();
periph_write(0x40021018, 4, 1 << 9); // ADC1EN
periph_write(ADC1 + 0x08, 4, 1);     // ADON
adc_set_sim_value(0x000);            // sim source unused for wired pins
gpio_set_analog(0, 0, 0xFFF);        // PA0 = 3.3V (12-bit full scale)
adc_set_rc_tau(100);                 // very slow cap -> huge undershoot
periph_write(ADC1 + 0x08, 4, (1 << 0) | (1 << 22)); // ADON + SWSTART
step_batch(14);
const rc_full = periph_read(ADC1 + 0x4C, 4) & 0xFFF;
assert(rc_full < 0xFFF - 64, `ADC RC cap does not reach target in one sample (${rc_full})`);
assert(rc_full > 0, `ADC RC cap charges off zero (${rc_full})`);

// A second conversion directly after settles further toward the target
// (the cap holds the previous result and keeps charging).
periph_write(ADC1 + 0x08, 4, (1 << 0) | (1 << 22));
step_batch(14);
const rc_second = periph_read(ADC1 + 0x4C, 4) & 0xFFF;
assert(rc_second > rc_full, `ADC RC cap continues charging toward target (${rc_full} -> ${rc_second})`);

// With a tiny tau the cap tracks the wire within the sample window
// (still taking the RC path; result near the target but allowed to undershoot).
periph_write(ADC1 + 0x0C, 4, 7 << 0); // SMP0 = 239.5 cycles window
adc_set_rc_tau(1);
periph_write(ADC1 + 0x08, 4, (1 << 0) | (1 << 22));
step_batch(252);
const rc_fast = periph_read(ADC1 + 0x4C, 4) & 0xFFF;
assert(rc_fast > 0xF00, `RC cap settles near full scale with tau=1 (${rc_fast})`);

// Per-pin disconnection: clear the analog wire, RC path reverts to the
// exact simulated value.
gpio_set_analog(0, 0, 0xFFFF);
periph_write(ADC1 + 0x08, 4, (1 << 0) | (1 << 22));
step_batch(14);
const rc_sim = periph_read(ADC1 + 0x4C, 4) & 0xFFF;
assert_eq(rc_sim, 0x000, 'ADC without wired pin returns exact sim value');

// DAC -> ADC analog loopback: DAC1 drives PA4 (channel 4) with a 12-bit
// voltage; the ADC samples it through the RC cap (tau 100 left by the RC
// group above: first sample lands well below the target and charges up).
reset();
periph_write(0x4002101C, 4, 1 << 29);  // APB1ENR: DAC1EN
periph_write(0x40021018, 4, 1 << 9);   // APB2ENR: ADC1EN
periph_write(0x40007400, 4, 0x1);      // DAC CR: EN1
periph_write(0x40007408, 4, 0x800);    // DHR12R1 = 2048 (half scale)
adc_set_rc_tau(100);                   // slow cap: first sample undershoots
periph_write(ADC1 + 0x34, 4, 4);       // SQ1 = ch4 (PA4 = DAC1_OUT)
periph_write(ADC1 + 0x08, 4, (1 << 0) | (1 << 22)); // ADON + SWSTART
step_batch(14);
const dac_full = periph_read(ADC1 + 0x4C, 4) & 0xFFF;
// cap from 0 to 0x800 over 14 cycles, tau 100: 2048 * (1 - e^-0.14) = 267
assert(dac_full > 0x80 && dac_full < 0x600, `DAC1->ADC ch4 sampled the RC'd wire (${dac_full})`);
periph_write(ADC1 + 0x08, 4, (1 << 0) | (1 << 22));
step_batch(14);
const dac_second = periph_read(ADC1 + 0x4C, 4) & 0xFFF;
assert(dac_second > dac_full, `DAC loopback cap continues charging (${dac_full} -> ${dac_second})`);
// DAC2 on PA5 (channel 5)
periph_write(ADC1 + 0x34, 4, 5);        // SQ1 = ch5
periph_write(ADC1 + 0x08, 4, (1 << 0) | (1 << 22));   // DAC2 still disabled: sim (0x000) source
step_batch(14);
periph_write(0x40007414, 4, 0x300);     // DHR12R2 = 768
periph_write(0x40007400, 4, 0x11);      // EN1 + EN2
periph_write(ADC1 + 0x08, 4, (1 << 0) | (1 << 22));
step_batch(14);
const dac2_val = periph_read(ADC1 + 0x4C, 4) & 0xFFF;
assert(dac2_val > 0x10 && dac2_val < 0x300, `DAC2->ADC ch5 charges toward 0x300 (${dac2_val})`);

// AWD interrupt: HTR/LTR straddle the result -> AWD flag and IRQ 18 pending
reset();
periph_write(0x40021018, 4, 1 << 9);   // ADC1EN
periph_write(ADC1 + 0x08, 4, 1);       // ADON
adc_set_sim_value(0x3FF);
periph_write(ADC1 + 0x04, 4, 0x41);    // CR1: AWDEN(0) + AWDIE(6)
periph_write(0xE000E100, 4, 1 << 18);  // NVIC ISER: enable ADC IRQ 18
periph_write(ADC1 + 0x24, 4, 0x200);   // HTR = 512
periph_write(ADC1 + 0x28, 4, 0x100);   // LTR = 256
periph_write(ADC1 + 0x08, 4, (1 << 0) | (1 << 22));
step_batch(14);
assert_eq(periph_read(ADC1 + 0x00, 4) & 1, 1, 'ADC AWD flag set for out-of-range result');
assert(has_pending_interrupt() && get_next_pending_interrupt() === 18,
  'ADC AWD interrupt pending (IRQ 18)');
clear_current_interrupt();

// Internal channels: temp sensor (ch16 ~25C: V25=1.43V -> 0x6EE),
// VREFINT (ch17 1.2V -> 0x5D2); TSVREFE (CR2 bit 23) gates them on HW,
// the model returns nominals directly.
reset();
periph_write(0x40021018, 4, 1 << 9);   // ADC1EN
adc_set_rc_tau(1);                     // fast cap: nominals settle in one shot
periph_write(ADC1 + 0x34, 4, 16);      // SQ1 = ch16 (temp sensor)
periph_write(ADC1 + 0x08, 4, (1 << 0) | (1 << 22));
step_batch(14);
assert_eq(periph_read(ADC1 + 0x4C, 4) & 0xFFF, 0x6EE, 'ADC ch16 temp ~25C (0x6EE)');
periph_write(ADC1 + 0x34, 4, 17);      // SQ1 = ch17 (VREFINT)
periph_write(ADC1 + 0x08, 4, (1 << 0) | (1 << 22));
step_batch(14);
assert_eq(periph_read(ADC1 + 0x4C, 4) & 0xFFF, 0x5D2, 'ADC ch17 VREFINT (0x5D2)');

// External trigger: TIM1 update -> TRGO -> ADC (EXTTRIG + EXTSEL=TIM1_TRGO)
reset();
periph_write(0x40021018, 4, (1 << 9) | (1 << 11)); // ADC1EN + TIM1EN
adc_set_sim_value(0x155);
periph_write(ADC1 + 0x08, 4, (1 << 0) | (1 << 20) | (7 << 17)); // ADON|EXTTRIG|EXTSEL=7
periph_write(0x40012C00 + 0x00, 4, 1);              // TIM1 CR1: CEN
periph_write(0x40012C00 + 0x04, 4, 0x20);           // TIM1 CR2: MMS=010 (update->TRGO)
periph_write(0x40012C00 + 0x2C, 4, 0x100);          // TIM1 ARR
let trig_eoc = false;
for (let i = 0; i < 6 && !trig_eoc; i++) {
  step_batch(1000);
  trig_eoc = (periph_read(ADC1 + 0x00, 4) & 2) !== 0;
}
assert(trig_eoc, 'ADC starts from TIM1 TRGO without SWSTART');
assert_eq(periph_read(ADC1 + 0x4C, 4) & 0xFFF, 0x155, 'ADC DR correct after TIM1 TRGO trigger');

// External trigger: TIM1_CC1 compare event (EXTSEL=0)
reset();
periph_write(0x40021018, 4, (1 << 9) | (1 << 11));
periph_write(ADC1 + 0x08, 4, (1 << 0) | (1 << 20)); // EXTSEL defaults to TIM1_CC1
periph_write(0x40012C00 + 0x00, 4, 0x1);            // CEN
periph_write(0x40012C00 + 0x20, 4, 0x1);            // CCER: CC1E
periph_write(0x40012C00 + 0x34, 4, 0x40);           // CCR1 = 64
periph_write(0x40012C00 + 0x2C, 4, 0x100);          // ARR
trig_eoc = false;
for (let i = 0; i < 6 && !trig_eoc; i++) {
  step_batch(1000);
  trig_eoc = (periph_read(ADC1 + 0x00, 4) & 2) !== 0;
}
assert(trig_eoc, 'ADC starts from TIM1_CC1 compare event');

// External trigger: EXTI line 11 rising edge (EXTSEL=6)
reset();
periph_write(0x40021018, 4, (1 << 9) | (1 << 0));   // ADC1EN + AFIOEN
periph_write(ADC1 + 0x08, 4, (1 << 0) | (1 << 20) | (6 << 17)); // EXTI11
periph_write(0x40010400 + 0x00, 4, 1 << 11);        // EXTI IMR bit11
periph_write(0x40010400 + 0x08, 4, 1 << 11);        // EXTI RTSR bit11
periph_write(0x40010804, 4, 0x3 << 12);             // PA11 output push-pull
periph_write(0x40010810, 4, 1 << 11);               // BSRR: PA11 high (rising edge)
trig_eoc = false;
for (let i = 0; i < 6 && !trig_eoc; i++) {
  step_batch(200);
  trig_eoc = (periph_read(ADC1 + 0x00, 4) & 2) !== 0;
}
assert(trig_eoc, 'ADC starts from EXTI11 rising edge');

// Dual regular-simultaneous mode (ADC1 CR1 DUALMOD=0110): ADC1 SWSTART
// converts ADC2 in lockstep; ADC1_DR packs ADC2:ADC1 on completion.
reset();
periph_write(0x40021018, 4, (1 << 9));   // APB2ENR: ADC1EN
periph_write(0x4002101C, 4, 1 << 29);    // APB1ENR: DAC1EN
periph_write(0x40007400, 4, 0x1);        // DAC CR: EN1
periph_write(0x40007408, 4, 0x800);      // DHR12R1 = 2048 -> PA4
gpio_set_analog(0, 5, 0x400);            // PA5 = 1024 (ADC2 CH5 source)
adc_set_rc_tau(1);                       // fast cap: samples land on target
periph_write(ADC1 + 0x34, 4, 4);         // ADC1 SQ1 = ch4 (DAC loopback)
periph_write(ADC1 + 0x04, 4, 6 << 16);   // CR1 DUALMOD = regular simultaneous
periph_write(0x40012800 + 0x34, 4, 5);   // ADC2 SQ1 = ch5 (analog wire)
periph_write(0x40012800 + 0x08, 4, 1);   // ADC2 ADON
periph_write(ADC1 + 0x08, 4, (1 << 0) | (1 << 22)); // ADON + SWSTART
step_batch(30);
const dual = periph_read(ADC1 + 0x4C, 4);
assert_eq(dual & 0xFFFF, 0x800, `dual ADC1 half = DAC value (${(dual & 0xFFFF).toString(16)})`);
assert_eq((dual >> 16) & 0xFFFF, 0x400, `dual ADC2 half = analog wire (${((dual >> 16) & 0xFFFF).toString(16)})`);
// ADC2 converted too (its own EOC set)
assert_eq(periph_read(0x40012800 + 0x00, 4) & 2, 2, 'dual ADC2 EOC set');

// NRST aborts an in-flight conversion: start a long CONT-mode conversion,
// reset the model mid-flight (board_nrst zeroes the instruction count — the
// old code kept the stale end_at, so the conversion completed instantly
// post-reset), then prove EOC does NOT appear without a fresh trigger.
reset();
periph_write(0x40021018, 4, 1 << 9); // ADC1EN
adc_set_sim_value(0x2AA);
periph_write(ADC1 + 0x10, 4, 7 << 0); // SMPR2 SMP0 = 239.5 cycles (long window)
periph_write(ADC1 + 0x08, 4, (1 << 0) | (1 << 16) | (1 << 22)); // ADON + CONT + SWSTART
assert_eq(periph_read(ADC1 + 0x00, 4) & 2, 0, 'ADC EOC not set mid-conversion');
periph.board_nrst();
step_batch(1000); // far past the stale end_at
assert_eq(periph_read(ADC1 + 0x00, 4) & 2, 0, 'ADC no EOC after NRST without fresh trigger');
assert_eq(periph.drain_events().filter(e => e === 8).length, 0, 'ADC no AdcDone after NRST');
periph_write(ADC1 + 0x08, 4, (1 << 0) | (1 << 16) | (1 << 22)); // fresh SWSTART post-reset
step_batch(252);
assert_eq(periph_read(ADC1 + 0x00, 4) & 2, 2, 'ADC EOC after fresh SWSTART post-reset');
assert_eq(periph_read(ADC1 + 0x4C, 4) & 0xFFF, 0x2AA, 'ADC DR correct post-reset');

// Injected conversion is aborted by NRST too.
reset();
periph_write(0x40021018, 4, 1 << 9); // ADC1EN
periph_write(ADC1 + 0x10, 4, 7 << 0); // long sample window
periph_write(ADC1 + 0x08, 4, (1 << 0) | (1 << 21)); // ADON + JSWSTART
periph.board_nrst();
step_batch(1000);
assert_eq(periph_read(ADC1 + 0x00, 4) & 4, 0, 'ADC no JEOC after NRST without fresh trigger');

// ============================================================
// RCC
// ============================================================
group('RCC');

reset();
const RCC = 0x40021000;

// Read RCC_CR — should default to HSI on (bit 1 = HSIRDY)
let cr = periph_read(RCC + 0x00, 4);
assert_eq(cr & 1, 1, 'RCC CR HSION');
assert_eq(cr & 2, 2, 'RCC CR HSIRDY');

// Enable HSE: CR bit 16 = HSEON, bit 17 = HSERDY (set by simulation)
periph_write(RCC + 0x00, 4, cr | (1 << 16));
cr = periph_read(RCC + 0x00, 4);
assert_eq(cr & (1 << 16), 1 << 16, 'RCC CR HSEON after set');
assert_eq(cr & (1 << 17), 1 << 17, 'RCC CR HSERDY set by sim');

// Disable HSE: should clear HSEON AND HSERDY
periph_write(RCC + 0x00, 4, cr & ~(1 << 16));
cr = periph_read(RCC + 0x00, 4);
assert_eq(cr & (1 << 16), 0, 'RCC CR HSEON cleared');
assert_eq(cr & (1 << 17), 0, 'RCC CR HSERDY cleared with HSEON');

// Enable PLL: CR bit 24 = PLLON, bit 25 = PLLRDY
periph_write(RCC + 0x00, 4, (1 << 24));
cr = periph_read(RCC + 0x00, 4);
assert_eq(cr & (1 << 24), 1 << 24, 'RCC CR PLLON');
assert_eq(cr & (1 << 25), 1 << 25, 'RCC CR PLLRDY');

// Disable PLL → PLLRDY also clears
periph_write(RCC + 0x00, 4, 0);
cr = periph_read(RCC + 0x00, 4);
assert_eq(cr & (1 << 24), 0, 'RCC CR PLLON off');
assert_eq(cr & (1 << 25), 0, 'RCC CR PLLRDY cleared');

// CFGR: configure SW=HSI (00), SWS tracks SW
periph_write(RCC + 0x04, 4, 0x00000000);
let cfgr = periph_read(RCC + 0x04, 4);
assert_eq(cfgr & 0x3, 0, 'RCC CFGR SW = HSI');
assert_eq((cfgr >> 2) & 0x3, 0, 'RCC CFGR SWS = HSI');

// APB2ENR: enable bits
periph_write(RCC + 0x18, 4, (1 << 14) | (1 << 2) | (1 << 4));
let apb2 = periph_read(RCC + 0x18, 4);
assert_eq(apb2 & (1 << 14), 1 << 14, 'RCC APB2ENR USART1EN');
assert_eq(apb2 & (1 << 2), 1 << 2, 'RCC APB2ENR GPIOAEN');
assert_eq(apb2 & (1 << 4), 1 << 4, 'RCC APB2ENR GPIOCEN');

// APB1ENR: enable TIM2, I2C1
periph_write(RCC + 0x1C, 4, (1 << 0) | (1 << 21));
let apb1 = periph_read(RCC + 0x1C, 4);
assert_eq(apb1 & (1 << 0), 1 << 0, 'RCC APB1ENR TIM2EN');
assert_eq(apb1 & (1 << 21), 1 << 21, 'RCC APB1ENR I2C1EN');

// Clock security system: HSE on + CSSON, then inject a crystal failure.
// CSSF (CIR.7) raises, NMI pends, SWS falls back to HSI (SW kept).
periph_write(RCC + 0x00, 4, (1 << 16) | (1 << 19)); // HSEON + CSSON
periph_write(RCC + 0x04, 4, 1);                     // CFGR SW=HSE (SWS follows)
assert_eq((periph_read(RCC + 0x04, 4) >> 2) & 3, 1, 'RCC SWS=HSE before failure');
assert_eq(rcc_fail_hse(), true, 'rcc_fail_hse fires with CSSON');
assert_eq(periph_read(RCC + 0x00, 4) & (1 << 17), 0, 'RCC HSERDY cleared by failure');
assert_eq(periph_read(RCC + 0x08, 4) & (1 << 7), 1 << 7, 'RCC CIR CSSF set');
assert_eq((periph_read(RCC + 0x04, 4) >> 2) & 3, 0, 'RCC SWS falls back to HSI');
assert_eq(periph_read(RCC + 0x04, 4) & 3, 1, 'RCC SW request kept (HSE)');
assert_eq(get_next_pending_interrupt(), -14, 'RCC CSS failure pends NMI');
clear_current_interrupt();
periph_write(RCC + 0x08, 4, 1 << 23);               // CSSC clears CSSF
assert_eq(periph_read(RCC + 0x08, 4) & (1 << 7), 0, 'RCC CIR CSSF cleared by CSSC');
// Without CSSON the failure only kills HSERDY (no CSSF, no NMI)
periph_write(RCC + 0x00, 4, 1 << 16);               // HSEON, CSSON off
assert_eq(rcc_fail_hse(), false, 'rcc_fail_hse quiet without CSSON');
assert_eq(periph_read(RCC + 0x08, 4) & (1 << 7), 0, 'RCC CIR no CSSF without CSSON');

// ============================================================
// SysTick
// ============================================================
group('SysTick');

reset();
const STK = 0xE000E010;

// Set reload value
periph_write(STK + 0x04, 4, 999); // RVR = 1000-1
assert_eq(periph_read(STK + 0x04, 4), 999, 'SysTick RVR');

// Clear current value
periph_write(STK + 0x08, 4, 0);
assert_eq(periph_read(STK + 0x08, 4), 0, 'SysTick CVR after clear');

// Enable SysTick: CSR bits: 0=ENABLE, 1=TICKINT, 2=CLKSOURCE
periph_write(STK + 0x00, 4, 0x07);
let csr = periph_read(STK + 0x00, 4);
assert_eq(csr & 0x07, 0x07, 'SysTick CSR ENABLE|TICKINT|CLKSOURCE');

// Tick enough times to trigger SysTick interrupt
assert_eq(has_pending_interrupt(), false, 'SysTick no pending before count');

for (let i = 0; i < 2000; i++) tick();
assert_eq(has_pending_interrupt(), true, 'SysTick pending after >1000 ticks');

let irq = get_next_pending_interrupt();
assert_eq(irq, -1, 'SysTick IRQ number = -1');
assert_eq(has_pending_interrupt(), false, 'SysTick pending cleared after get');
clear_current_interrupt();

// Second fire: tick another 1000+
for (let i = 0; i < 1000; i++) tick();
assert_eq(has_pending_interrupt(), true, 'SysTick pending second fire');
irq = get_next_pending_interrupt();
assert_eq(irq, -1, 'SysTick IRQ number = -1 (second)');
clear_current_interrupt(); // EOI: every take pairs with a return (else the
// active-prio entry gates later takes, as the NVIC group documents)

// Disable SysTick — should stop firing
periph_write(STK + 0x00, 4, 0); // clear ENABLE
assert_eq(has_pending_interrupt(), false, 'SysTick no pending after disable');
for (let i = 0; i < 1500; i++) tick();
assert_eq(has_pending_interrupt(), false, 'SysTick still no pending (disabled)');

// ============================================================
// DWT cycle counter (wait-state aware)
// ============================================================
group('DWT');

reset();
const DWT = 0xE0001000;
const FLASHB = 0x40022000;
periph_write(0x40021014, 4, 1 << 4); // AHBENR FLASHEN (FLASH writes are clock-gated)
// Default: 1 instr = 1 cycle
step_batch(1000);
const c0 = periph_read(DWT + 0x04, 4);
step_batch(1000);
assert_eq(((periph_read(DWT + 0x04, 4) - c0) >>> 0), 1000, 'DWT CYCCNT 1:1 default');
// FLASH LATENCY=2 -> each instruction retires 3 cycles (pacing untouched)
periph_write(FLASHB + 0x00, 4, 2);
const c1 = periph_read(DWT + 0x04, 4);
step_batch(1000);
assert_eq(((periph_read(DWT + 0x04, 4) - c1) >>> 0), 3000, 'DWT CYCCNT 3x with LATENCY=2');
// Guest write takes effect immediately, then keeps counting
periph_write(DWT + 0x04, 4, 0x1000);
assert_eq(periph_read(DWT + 0x04, 4), 0x1000, 'DWT CYCCNT guest write');
step_batch(100);
assert_eq(periph_read(DWT + 0x04, 4), 0x1000 + 300, 'DWT CYCCNT resumes at 3x');
// LATENCY back to 0 -> 1:1 again
periph_write(FLASHB + 0x00, 4, 0);
const c2 = periph_read(DWT + 0x04, 4);
step_batch(500);
assert_eq(((periph_read(DWT + 0x04, 4) - c2) >>> 0), 500, 'DWT CYCCNT back to 1:1');

// ============================================================
// TIM (Timer/PWM)
// ============================================================
group('TIM');

reset();
const TIM2 = 0x40000000;

// Enable TIM2 clock
periph_write(0x4002101C, 4, 1 << 0);

// Set PSC = 7999, ARR = 999
periph_write(TIM2 + 0x28, 4, 7999);  // PSC
assert_eq(periph_read(TIM2 + 0x28, 4), 7999, 'TIM2 PSC');

periph_write(TIM2 + 0x2C, 4, 999);   // ARR
assert_eq(periph_read(TIM2 + 0x2C, 4), 999, 'TIM2 ARR');

// Set CCR1 = 500 (50% duty)
periph_write(TIM2 + 0x34, 4, 500);
assert_eq(periph_read(TIM2 + 0x34, 4), 500, 'TIM2 CCR1');

// Configure CCMR1: OC1M=110 (PWM1), OC1PE=1
periph_write(TIM2 + 0x18, 4, (0b110 << 4) | (1 << 3));
let ccmr1 = periph_read(TIM2 + 0x18, 4);
assert_eq((ccmr1 >> 4) & 0x7, 0b110, 'TIM2 CCMR1 OC1M = PWM1');
assert_eq((ccmr1 >> 3) & 1, 1, 'TIM2 CCMR1 OC1PE');

// CCER: CC1E = bit 0
periph_write(TIM2 + 0x20, 4, 1);
assert_eq(periph_read(TIM2 + 0x20, 4) & 1, 1, 'TIM2 CCER CC1E');

// CR1: CEN = bit 0
periph_write(TIM2 + 0x00, 4, 1);
assert_eq(periph_read(TIM2 + 0x00, 4) & 1, 1, 'TIM2 CR1 CEN');

// Read SR — UIF (bit 0) initially 0
let tim_sr = periph_read(TIM2 + 0x10, 4);
assert_eq(tim_sr & 1, 0, 'TIM2 SR UIF initial');

// TIM1 break-and-dead-time (BDTR @ 0x44, advanced-timer only)
reset();
const TIM1 = 0x40012C00;
periph_write(0x40021018, 4, 1 << 11); // APB2 TIM1EN
periph_write(TIM1 + 0x28, 4, 0);      // PSC
periph_write(TIM1 + 0x2C, 4, 999);    // ARR
periph_write(TIM1 + 0x18, 4, (0b110 << 4)); // CH1 PWM1
periph_write(TIM1 + 0x20, 4, 1);      // CC1E
periph_write(TIM1 + 0x34, 4, 500);    // CCR1 50%
periph_write(TIM1 + 0x00, 4, 1);      // CEN
periph_write(TIM1 + 0x44, 4, 0x35);   // BDTR: DTG=0x35, MOE=0
assert_eq(periph_read(TIM1 + 0x44, 4) & 0xFF, 0x35, 'TIM1 BDTR DTG stored');
step_batch(2000);
assert_eq(pwm_duty(TIM1, 0), 0, 'TIM1 PWM dead with MOE=0');
periph_write(TIM1 + 0x44, 4, 0x35 | (1 << 15)); // MOE=1
step_batch(2000);
// Dead time narrows the output: (500-53)*100/1000 = 44 (DTG=0x35 -> 53 ticks)
assert_eq(pwm_duty(TIM1, 0), 44, 'TIM1 PWM dead-time narrowed with MOE=1');
// Break: BKE=1, drive BKIN (PB12) low (active-low default) -> MOE clears + BIF
periph_write(TIM1 + 0x44, 4, 0x35 | (1 << 15) | (1 << 12)); // BKE
gpio_set_input(1, 12, false); // PB12 low = break active
step_batch(100);
assert_eq(periph_read(TIM1 + 0x44, 4) & (1 << 15), 0, 'TIM1 MOE cleared by break');
assert_eq(periph_read(TIM1 + 0x10, 4) & (1 << 7), 1 << 7, 'TIM1 SR BIF set by break');
assert_eq(pwm_duty(TIM1, 0), 0, 'TIM1 PWM dead after break');
gpio_set_input(1, 12, true); // release BKIN
periph_write(TIM1 + 0x10, 4, ~(1 << 7)); // W0C BIF
assert_eq(periph_read(TIM1 + 0x10, 4) & (1 << 7), 0, 'TIM1 SR BIF write-0-clears');
// LOCK: raise to level 3, DTG/BKE freeze, MOE still writable
periph_write(TIM1 + 0x44, 4, (1 << 15) | (3 << 8) | 0x35);
periph_write(TIM1 + 0x44, 4, 0x40);   // try DTG=0x40, MOE=0
let bdtr = periph_read(TIM1 + 0x44, 4);
assert_eq(bdtr & 0xFF, 0x35, 'TIM1 BDTR DTG frozen by LOCK');
assert_eq(bdtr & (1 << 15), 0, 'TIM1 BDTR MOE writable under LOCK');
// BDTR absent on general timers: TIM2 read 0, write ignored
assert_eq(periph_read(TIM2 + 0x44, 4), 0, 'TIM2 has no BDTR');

// TIM DMA burst (DCR @ 0x48: DBL[12:8] + DBA[4:0]; DMAR @ 0x4C sequences
// each write through DBA..DBA+DBL, wrapping)
periph_write(TIM1 + 0x48, 4, (3 << 8) | 0x0D); // DBL=3 (4 transfers), DBA=CCR1
assert_eq(periph_read(TIM1 + 0x48, 4), (3 << 8) | 0x0D, 'TIM1 DCR stored');
periph_write(TIM1 + 0x4C, 4, 100);
periph_write(TIM1 + 0x4C, 4, 200);
periph_write(TIM1 + 0x4C, 4, 300);
periph_write(TIM1 + 0x4C, 4, 400);
assert_eq(periph_read(TIM1 + 0x34, 4), 100, 'TIM1 burst lands CCR1');
assert_eq(periph_read(TIM1 + 0x38, 4), 200, 'TIM1 burst lands CCR2');
assert_eq(periph_read(TIM1 + 0x3C, 4), 300, 'TIM1 burst lands CCR3');
assert_eq(periph_read(TIM1 + 0x40, 4), 400, 'TIM1 burst lands CCR4');
periph_write(TIM1 + 0x4C, 4, 111); // wraps to DBA
assert_eq(periph_read(TIM1 + 0x34, 4), 111, 'TIM1 burst wraps to CCR1');
assert_eq(periph_read(TIM1 + 0x4C, 4), 111, 'TIM1 DMAR readback stores last');
// Single-register burst (DBL=0): every write hits CCR1
periph_write(TIM1 + 0x48, 4, 0x0D);
periph_write(TIM1 + 0x4C, 4, 222);
periph_write(TIM1 + 0x4C, 4, 333);
assert_eq(periph_read(TIM1 + 0x34, 4), 333, 'TIM1 single-burst repeats CCR1');
// DCR reprogram restarts the window
periph_write(TIM1 + 0x48, 4, (1 << 8) | 0x0D);
periph_write(TIM1 + 0x4C, 4, 444);
assert_eq(periph_read(TIM1 + 0x34, 4), 444, 'TIM1 DCR reprogram restarts window');
reset();

// ============================================================
// IWDG (Independent Watchdog)
// ============================================================
group('IWDG');

reset();
const IWDG = 0x40003000;

// Write key 0x5555 to KR to enable register access
periph_write(IWDG + 0x00, 4, 0x5555);

// Set prescaler = 4 (div by 64)
periph_write(IWDG + 0x04, 4, 4);
assert_eq(periph_read(IWDG + 0x04, 4), 4, 'IWDG PR prescaler');

// Set reload = 0xFFF
periph_write(IWDG + 0x08, 4, 0xFFF);
assert_eq(periph_read(IWDG + 0x08, 4), 0xFFF, 'IWDG RLR reload');

// Start watchdog: write 0xCCCC to KR
periph_write(IWDG + 0x00, 4, 0xCCCC);
// Read KR — should return 0 (reads as reserved)
assert_eq(periph_read(IWDG + 0x00, 4), 0, 'IWDG KR read = 0');

// Refresh: write 0xAAAA to KR
periph_write(IWDG + 0x00, 4, 0xAAAA);
assert_eq(is_watchdog_reset_requested(), false, 'IWDG no reset after refresh');

// ============================================================
// NVIC
// ============================================================
group('NVIC');

reset();
const NVIC = 0xE000E100;

// Enable USART1 IRQ (IRQ 37): ISER[1] bit 5 (= 37-32)
periph_write(NVIC + 0x00, 4, 0); // ISER0 = 0
periph_write(NVIC + 0x04, 4, 1 << 5); // ISER1 bit 5 = IRQ 37
let iser1 = periph_read(NVIC + 0x04, 4);
assert_eq(iser1 & (1 << 5), 1 << 5, 'NVIC ISER1 USART1 enabled');

// Set pending via ISPR
periph_write(NVIC + 0x100 + 0x04, 4, 1 << 5); // ISPR1 bit 5
assert_eq(has_pending_interrupt(), true, 'NVIC has pending after ISPR write');

// Get the interrupt
let pirq = get_next_pending_interrupt();
assert_eq(pirq, 37, 'NVIC pending IRQ = 37 (USART1)');
assert_eq(has_pending_interrupt(), false, 'NVIC pending cleared after get');
clear_current_interrupt(); // EOI before the STIR phase (else its active
// entry gates deliverability — same HW nesting rule the ICPR block documents)

// Clear enable via ICER
periph_write(NVIC + 0x80 + 0x04, 4, 1 << 5); // ICER1 bit 5
iser1 = periph_read(NVIC + 0x04, 4);
assert_eq(iser1 & (1 << 5), 0, 'NVIC USART1 disabled after ICER');

// Set priority for USART1 (absolute 0xE000E325 = NVIC_REGS_BASE + 0x225)
periph_write(0xE000E325, 4, 0x80);
let prio = periph_read(0xE000E325, 4);
assert_eq(prio, 0x80, 'NVIC USART1 priority 0x80');

// STIR (0xE000EF00, write-only): pends an IRQ by number (assert the ISPR
// bit; a dispatched STIR IRQ would need its own EOI before later takes).
periph_write(NVIC + 0x00, 4, 1 << 6); // ISER0 bit 6 = EXTI0 IRQ 6
periph_write(0xE000EF00, 4, 6); // EXTI0 = IRQ 6
assert_eq(periph_read(NVIC + 0x100, 4) & (1 << 6), 1 << 6, 'STIR pends EXTI0 in ISPR0');
assert_eq(periph_read(0xE000EF00, 4), 0, 'STIR reads 0 (write-only)');

// SCB ACTRL (0xE000E008, RW): DISMCYCINT/DISFOLD stored, no timing effect
assert_eq(periph_read(0xE000E008, 4), 0, 'ACTRL reset value 0');
periph_write(0xE000E008, 4, 0x5);
assert_eq(periph_read(0xE000E008, 4), 0x5, 'ACTRL stores DISMCYCINT+DISFOLD');
periph_write(0xE000E008, 4, 0xFFFFFFFF);
assert_eq(periph_read(0xE000E008, 4), 0x7, 'ACTRL masks to implemented bits');

// ICPR (0x180) clears a pended IRQ; 0x280 writes are RESERVED no-ops (an
// earlier build aliased them to ICPR and silently dropped guest clears;
// ARMv7-M ICPR lives at 0x180, IABR is read-only).
// NOTE: the earlier get_next_pending_interrupt (USART1, prio 0) pushed an
// active-priority entry that gates every later take (HW nesting rules:
// nothing preempts prio 0 while it is active), so these asserts use a fresh
// NVIC — no dispatch, no prio stack. set_intr_masks(0,0) is belt-and-braces:
// has_pending_interrupt consults the live INTR_MASK statics (set from CPU
// PRIMASK per batch on real driver paths; the raw wasm path needs them
// explicit if any earlier test touched them).
reset();
set_intr_masks(0, 0);
periph_write(NVIC + 0x00, 4, 1 << 6); // ISER0: EXTI0 IRQ 6
periph_write(NVIC + 0x100, 4, 1 << 6); // ISPR0: pend EXTI0
assert_eq(has_pending_interrupt(), true, 'NVIC EXTI0 pending pre-clear');
periph_write(NVIC + 0x180, 4, 1 << 6); // ICPR0: clear
assert_eq(periph_read(NVIC + 0x100, 4) & (1 << 6), 0, 'NVIC ICPR clears ISPR bit');
assert_eq(has_pending_interrupt(), false, 'NVIC no pending after ICPR clear');
periph_write(NVIC + 0x100, 4, 1 << 6); // pend again
periph_write(NVIC + 0x280, 4, 1 << 6); // RESERVED write: must not clear
assert_eq(periph_read(NVIC + 0x100, 4) & (1 << 6), 1 << 6, 'NVIC 0x280 write leaves ISPR bit');
assert_eq(periph_read(NVIC + 0x200, 4) & (1 << 6), 0, 'NVIC IABR read-only (no dispatch yet)');
assert_eq(has_pending_interrupt(), true, 'NVIC 0x280 write leaves pending');

// Fairness rotation: a hot IRQ that re-pends itself yields to another
// pending IRQ (last_popped alternation), so TXE-style drains can't starve
// lower-priority IRQs within the 64-take batch budget. Silicon truth: the
// dispatched IRQ stays ACTIVE until its handler returns, which normally
// blocks its own priority level — the model tests the documented path
// instead: clear the first dispatch (handler return), THEN re-pend hot,
// and the waiter goes next instead of the hotter IRQ re-firing.
reset();
set_intr_masks(0, 0);
periph_write(NVIC + 0x00, 4, (1 << 6) | (1 << 7)); // ISER0: IRQ 6 + 7
periph_write(0xE000E320 + 6, 1, 0x40); // IPR6 prio 0x40 (higher)
periph_write(0xE000E320 + 7, 1, 0x80); // IPR7 prio 0x80 (lower)
periph_write(NVIC + 0x100, 4, (1 << 6) | (1 << 7)); // pend both
assert_eq(get_next_pending_interrupt(), 6, 'NVIC fairness: higher prio first');
// Handler for IRQ 6 returns WITHOUT re-pending (its IABR bit clears too —
// the old pop-only return leaked it as phantom-active). IRQ 7's delivery
// then proves the waiter was never starved, and the IABR shows only it.
clear_current_interrupt();
assert_eq(periph_read(NVIC + 0x200, 4) & (1 << 6), 0, 'NVIC IABR clears on return');
assert_eq(get_next_pending_interrupt(), 7, 'NVIC fairness: waiter IRQ 7 goes next');
clear_current_interrupt();

// ============================================================
// CRC
// ============================================================
group('CRC');

reset();
const CRC = 0x40023000;

// Write data to CRC DR — CRC computes actual CRC-32
periph_write(CRC + 0x00, 4, 0xDEADBEEF);
let crc_val = periph_read(CRC + 0x00, 4);
// CRC-32 of 0xDEADBEEF with init 0xFFFFFFFF should be non-zero and not the input
assert_neq(crc_val, 0xDEADBEEF, 'CRC DR changed from input');
assert_neq(crc_val, 0, 'CRC DR non-zero');
assert_neq(crc_val, 0xFFFFFFFF, 'CRC DR not init value');

// Reset CRC (write CR bit 0) then re-compute
periph_write(CRC + 0x08, 4, 1); // reset
assert_eq(periph_read(CRC + 0x00, 4), 0xFFFFFFFF, 'CRC DR reset to 0xFFFFFFFF');
periph_write(CRC + 0x00, 4, 0x00000000);
let crc_zero = periph_read(CRC + 0x00, 4);
// CRC-32 of 0 with init 0xFFFFFFFF is C704DD7B
assert_eq(crc_zero, 0xC704DD7B, 'CRC-32 of 0x00000000');

// ============================================================
// SPI
// ============================================================
group('SPI');

reset();
const SPI1 = 0x40013000;

// Enable SPI1 clock
periph_write(0x40021018, 4, 1 << 12); // SPI1EN

// Configure CR1: BR=3 (div 16), MSTR, SPE
periph_write(SPI1 + 0x00, 4, (3 << 3) | (1 << 2) | (1 << 6));
let spi_cr1 = periph_read(SPI1 + 0x00, 4);
assert_eq(spi_cr1 & (1 << 6), 1 << 6, 'SPI1 CR1 SPE');
assert_eq((spi_cr1 >> 3) & 0x7, 3, 'SPI1 CR1 BR=3');

// Write to SPI DR (offset 0x0C) — triggers xfer, no device = rx 0xFF
periph_write(SPI1 + 0x0C, 4, 0xA5);

// Read SR first (before reading DR clears RXNE)
let spi_sr = periph_read(SPI1 + 0x08, 4);
assert_eq(spi_sr & (1 << 1), 1 << 1, 'SPI1 SR TXE');
assert_eq(spi_sr & (1 << 0), 1 << 0, 'SPI1 SR RXNE');

// Now read DR
assert_eq(periph_read(SPI1 + 0x0C, 4), 0xFF, 'SPI1 DR xfer returns 0xFF (no device)');

// CRCPR at offset 0x10 stores value directly
periph_write(SPI1 + 0x10, 4, 0x07);
assert_eq(periph_read(SPI1 + 0x10, 4), 0x07, 'SPI1 CRCPR');

// Hardware CRC (RM0008 25.3.7): CRCEN arms all-ones calculators; each
// transfer feeds TX then RX (no device: RX=0xFF).
periph_write(SPI1 + 0x00, 4, (3 << 3) | (1 << 2) | (1 << 6) | (1 << 13)); // +CRCEN
periph_write(SPI1 + 0x0C, 4, 0xFF);
assert_eq(periph_read(SPI1 + 0x18, 4) & 0xFF, 0x00, 'SPI1 TXCRC([0xFF]) = 0x00 (poly 0x07)');
assert_eq(periph_read(SPI1 + 0x14, 4) & 0xFF, 0x00, 'SPI1 RXCRC([0xFF]) = 0x00');
periph_write(SPI1 + 0x0C, 4, 0x01);
periph_write(SPI1 + 0x0C, 4, 0x02);
assert_eq(periph_read(SPI1 + 0x18, 4) & 0xFF, 0x1B, 'SPI1 TXCRC([0xFF,0x01,0x02]) = 0x1B');
// CRCNEXT phase with wrong peer CRC (0xFF vs computed 0x24) -> CRCERR + SR bit 4
periph_write(SPI1 + 0x00, 4, (3 << 3) | (1 << 2) | (1 << 6) | (1 << 13) | (1 << 12)); // +CRCNEXT
periph_write(SPI1 + 0x0C, 4, 0x00); // clocks out TXCRC, receives 0xFF
assert_eq(periph_read(SPI1 + 0x08, 4) & (1 << 4), 1 << 4, 'SPI1 SR CRCERR on CRC mismatch');
assert_eq(periph_read(SPI1 + 0x0C, 4), 0xFF, 'SPI1 DR read clears CRCERR');
assert_eq(periph_read(SPI1 + 0x08, 4) & (1 << 4), 0, 'SPI1 SR CRCERR cleared');

// TI frame format (CR2 FRF, bit 4): NSS pulses per frame, CPOL/CPHA are
// don't-care; the shifted data is identical to Motorola mode.
periph_write(SPI1 + 0x04, 4, 1 << 4); // CR2 FRF (TI mode)
assert_eq(periph_read(SPI1 + 0x04, 4) & (1 << 4), 1 << 4, 'SPI1 CR2 FRF readback');
periph_write(SPI1 + 0x00, 4, (3 << 3) | (1 << 2) | (1 << 6) | (1 << 1) | (1 << 0)); // +CPOL+CPHA
periph_write(SPI1 + 0x0C, 4, 0xA5);
spi_sr = periph_read(SPI1 + 0x08, 4);
assert_eq(spi_sr & 3, 3, 'SPI1 TI-mode SR TXE+RXNE');
periph_write(SPI1 + 0x04, 4, 0); // FRF off (Motorola)

// LCD framing (ext device): 0xFB starts a session at pixel (0,0) and takes
// no argument byte; 0xFC ends it and is never stored; stray bytes outside
// a session are ignored; a fresh 0xFB resyncs mid-stream.
add_lcd('SPI1', 'PA4');
reset();
periph_write(0x40021018, 4, 1 << 12); // SPI1EN
periph_write(SPI1 + 0x00, 4, (3 << 3) | (1 << 2) | (1 << 6)); // MSTR SPE
periph_write(0x4001080C, 4, 0); // GPIOA ODR low: PA4 CS low = LCD selected
periph_write(SPI1 + 0x0C, 4, 0xFB);
periph_write(SPI1 + 0x0C, 4, 0xAA);
periph_write(SPI1 + 0x0C, 4, 0xBB);
periph_write(SPI1 + 0x0C, 4, 0xFC);
let lcd = lcd_fb('SPI1');
assert_eq(lcd.length, 8192, 'LCD fb size 128x64');
assert_eq(lcd[0], 0xAA, 'LCD pixel (0,0) first data byte (no shift)');
assert_eq(lcd[1], 0xBB, 'LCD pixel (1,0) second byte');
periph_write(SPI1 + 0x0C, 4, 0xCC); // outside session: ignored
lcd = lcd_fb('SPI1');
assert_eq(lcd[2], 0, 'LCD stray byte ignored outside session');
periph_write(SPI1 + 0x0C, 4, 0xFB); // resync
periph_write(SPI1 + 0x0C, 4, 0xDD);
lcd = lcd_fb('SPI1');
assert_eq(lcd[0], 0xDD, 'LCD resync overwrites from pixel 0');
assert_eq(lcd[1], 0xBB, 'LCD resync keeps later pixels');
reset_ext_devices();
reset();

// ============================================================
// I2C
// ============================================================
group('I2C');

reset();
const I2C1 = 0x40005400;

// Enable I2C1 clock (APB1)
periph_write(0x4002101C, 4, 1 << 21);

// Configure CR1: PE (bit 0)
periph_write(I2C1 + 0x00, 4, 1);
assert_eq(periph_read(I2C1 + 0x00, 4) & 1, 1, 'I2C1 CR1 PE');

// Set own address (OAR1)
periph_write(I2C1 + 0x08, 4, 0x42 << 1); // addr 0x42
let oar1 = periph_read(I2C1 + 0x08, 4);
assert_eq((oar1 >> 1) & 0x7F, 0x42, 'I2C1 OAR1 addr 0x42');

// Set CCR = 0x50 (100kHz @ 8MHz)
periph_write(I2C1 + 0x1C, 4, 0x50);
assert_eq(periph_read(I2C1 + 0x1C, 4), 0x50, 'I2C1 CCR');

// Check SR2: busy flag (bit 1) should be 0 when idle
let i2c_sr2 = periph_read(I2C1 + 0x18, 4);
assert_eq(i2c_sr2 & (1 << 1), 0, 'I2C1 SR2 BUSY = 0 (idle)');

// BTF lifecycle + recovery (RM0008: BTF clears on DR access; a sticky BTF
// re-pends the EV interrupt forever, the I2C analogue of the USART ORE wedge).
// NOTE: address 0x51, not 0x50 — the later I2C-NACK test needs 0x50 missing.
add_i2c_eeprom('I2C1', 0x51, new Uint8Array(256).fill(0xAB));
reset();
periph_write(0x4002101C, 4, 1 << 21); // I2C1 clock
periph_write(I2C1 + 0x00, 4, 1); // PE
periph_write(I2C1 + 0x04, 4, (1 << 10) | (1 << 9)); // ITBUFEN + ITEVTEN
periph_write(I2C1 + 0x00, 4, 1 | (1 << 8)); // START
assert_eq(periph_read(I2C1 + 0x14, 4) & 1, 1, 'I2C BTF setup: SB set');
periph_write(I2C1 + 0x10, 4, 0xA2); // address 0x51 + write
assert_eq(periph_read(I2C1 + 0x14, 4) & (1 << 1), 1 << 1, 'I2C BTF setup: ADDR set');
periph_read(I2C1 + 0x14, 4); // SR1 read arms the ADDR clear...
periph_read(I2C1 + 0x18, 4); // ...SR2 read completes it -> Active(TX)
periph_write(I2C1 + 0x10, 4, 0x00); // EEPROM mem-address byte
periph_write(I2C1 + 0x04, 4, (1 << 9)); // clear ITBUFEN mid-transfer -> BTF
assert_eq(periph_read(I2C1 + 0x14, 4) & (1 << 2), 1 << 2, 'I2C SR1 BTF set after ITBUFEN clear');
periph_write(I2C1 + 0x10, 4, 0x5A); // DR write clears BTF (transfer progresses)
assert_eq(periph_read(I2C1 + 0x14, 4) & (1 << 2), 0, 'I2C SR1 BTF cleared by DR write');
periph_write(I2C1 + 0x00, 4, 1 | (1 << 9)); // STOP
assert_eq(periph_read(I2C1 + 0x14, 4), 0, 'I2C SR1 clean after STOP');
assert_eq(periph_read(I2C1 + 0x18, 4) & (1 << 1), 0, 'I2C SR2 BUSY = 0 after STOP');
periph_write(I2C1 + 0x00, 4, 1 | (1 << 8)); // bus usable again: START -> SB
assert_eq(periph_read(I2C1 + 0x14, 4) & 1, 1, 'I2C bus recovered: SB set again');
reset_ext_devices(); // leave no devices behind for later groups
reset();

// SMBus PEC + general call (RM0008 26.4.7): PECEN accumulates CRC-8/SMBus
// (poly 0x07, init 0) over address+R/W and data; PECR reads it back.
add_i2c_eeprom('I2C1', 0x50, new Uint8Array(256).fill(0));
reset();
periph_write(0x4002101C, 4, 1 << 21); // I2C1 clock
periph_write(I2C1 + 0x00, 4, 1 | (1 << 5)); // PE + PECEN
periph_write(I2C1 + 0x00, 4, 1 | (1 << 5) | (1 << 8)); // START
periph_write(I2C1 + 0x10, 4, 0xA0); // address 0x50 + write
assert_eq(periph_read(I2C1 + 0x30, 4) & 0xFF, 0x69, 'I2C PECR([0xA0]) = 0x69');
periph_read(I2C1 + 0x14, 4); periph_read(I2C1 + 0x18, 4); // clear ADDR
periph_write(I2C1 + 0x10, 4, 0x00); // mem-address byte
periph_write(I2C1 + 0x10, 4, 0x42); // data byte
assert_eq(periph_read(I2C1 + 0x30, 4) & 0xFF, 0x81, 'I2C PECR([0xA0,0x00,0x42]) = 0x81');
// PEC transfer: arm CR1.12, send (device gets PEC byte)
periph_write(I2C1 + 0x00, 4, 1 | (1 << 5) | (1 << 12)); // +PEC
periph_write(I2C1 + 0x10, 4, 0x00); // clocks out 0x81
assert_eq(periph_read(I2C1 + 0x30, 4) & 0xFF, 0x81, 'I2C PECR unchanged by PEC transfer');
periph_write(I2C1 + 0x00, 4, 1 | (1 << 9)); // STOP
// General call: ENGC + address 0x00 ACKs with GENCALL flag, no device
reset_ext_devices();
reset();
periph_write(0x4002101C, 4, 1 << 21); // I2C1 clock
periph_write(I2C1 + 0x00, 4, 1 | (1 << 6)); // PE + ENGC
periph_write(I2C1 + 0x00, 4, 1 | (1 << 6) | (1 << 8)); // START
periph_write(I2C1 + 0x10, 4, 0x00); // general-call address
assert_eq(periph_read(I2C1 + 0x14, 4) & (1 << 1), 1 << 1, 'I2C GCA: ADDR set (no NACK)');
assert_eq(periph_read(I2C1 + 0x18, 4) & (1 << 4), 1 << 4, 'I2C SR2 GENCALL set');
periph_write(I2C1 + 0x00, 4, 1 | (1 << 9)); // STOP
reset();

// Slave mode: host addresses this peripheral (OAR1 0x42) via inject API
periph_write(0x4002101C, 4, 1 << 21); // I2C1 clock
periph_write(I2C1 + 0x00, 4, 1 | (1 << 10)); // PE + ACK
periph_write(I2C1 + 0x08, 4, 0x42 << 1); // OAR1 = 0x42
assert_eq(i2c_inject_start(1, 0x43, false), false, 'slave NACKs unmatched address');
assert_eq(i2c_inject_start(1, 0x42, false), true, 'slave ACKs OAR1 match (write)');
assert_eq(periph_read(I2C1 + 0x14, 4) & (1 << 1), 1 << 1, 'slave ADDR set on match');
assert_eq(periph_read(I2C1 + 0x18, 4) & 0x7, 0x2, 'slave SR2 BUSY, MSL=0, TRA=0');
assert_eq(periph_read(I2C1 + 0x14, 4) & (1 << 1), 0, 'slave ADDR clears on SR1+SR2');
assert_eq(i2c_inject_write(1, 0x5A), true, 'slave accepts host byte');
assert_eq(periph_read(I2C1 + 0x14, 4) & (1 << 6), 1 << 6, 'slave RXNE set');
assert_eq(i2c_inject_write(1, 0x5B), false, 'slave NACKs while RXNE unread');
assert_eq(periph_read(I2C1 + 0x10, 4) & 0xFF, 0x5A, 'slave DR holds host byte');
assert_eq(i2c_inject_write(1, 0x5B), true, 'slave accepts after DR read');
assert_eq(i2c_inject_stop(1), true, 'slave STOP accepted');
assert_eq(periph_read(I2C1 + 0x14, 4) & (1 << 4), 1 << 4, 'slave STOPF set');
periph_write(I2C1 + 0x00, 4, 1 | (1 << 10)); // CR1 write clears STOPF
assert_eq(periph_read(I2C1 + 0x14, 4) & (1 << 4), 0, 'slave STOPF clears on SR1+CR1');
// Slave transmitter: host reads firmware-loaded bytes
assert_eq(i2c_inject_start(1, 0x42, true), true, 'slave ACKs OAR1 match (read)');
periph_read(I2C1 + 0x14, 4); periph_read(I2C1 + 0x18, 4); // clear ADDR
assert_eq(periph_read(I2C1 + 0x14, 4) & (1 << 7), 1 << 7, 'slave TXE armed after ADDR clear');
assert_eq(i2c_inject_read(1), -1, 'slave read stretches while DR empty');
periph_write(I2C1 + 0x10, 4, 0xA5); // firmware loads DR
assert_eq(i2c_inject_read(1), 0xA5, 'slave serves loaded byte');
assert_eq(i2c_inject_read(1), -1, 'slave TXE re-arms after byte');
assert_eq(i2c_inject_stop(1), true, 'slave STOP after read');
reset();

// 10-bit slave addressing (OAR1 ADDMODE + ADD[9:0])
periph_write(0x4002101C, 4, 1 << 21); // I2C1 clock
periph_write(I2C1 + 0x00, 4, 1 | (1 << 10)); // PE + ACK
periph_write(I2C1 + 0x08, 4, (1 << 15) | 0x2A5); // ADDMODE + addr 677
assert_eq(i2c_inject_start(1, 677, false), true, 'slave ACKs 10-bit match');
assert_eq(i2c_inject_stop(1), true, 'slave STOP after 10-bit match');
assert_eq(i2c_inject_start(1, 676, false), false, 'slave NACKs 10-bit mismatch');
assert_eq(i2c_inject_start(1, 0x25, false), false, 'no 7-bit alias of 10-bit addr');
// 7-bit mode ignores high address bits (no false match)
periph_write(I2C1 + 0x08, 4, 0x42 << 1); // back to 7-bit 0x42
assert_eq(i2c_inject_start(1, 0x142, false), false, '7-bit mode rejects 10-bit addr');
// Master 10-bit header (0xF0 range, no 10-bit peers) NACKs with AF
periph_write(I2C1 + 0x00, 4, 1 | (1 << 8)); // START
periph_write(I2C1 + 0x10, 4, 0xF2); // header for 10-bit write to 0x255
assert_eq(periph_read(I2C1 + 0x14, 4) & (1 << 10), 1 << 10, 'master 10-bit header NACKs (AF)');

// SMBus ALERT (RM0008 26.6.7): peer pulls SMBA low -> SR1 SMBALERT
// (bit 15) + error IRQ via ITERREN (I2C1_ER = IRQ 32 -> ISPR1 bit 0);
// firmware clears it by writing SR1 with the bit 0. CR1 ALERT (bit 13)
// drives SMBA -> I2cAlert bus event (own drive never sets own flag).
periph_write(0x4002101C, 4, 1 << 21); // I2C1 clock
periph_write(I2C1 + 0x00, 4, 1); // PE
assert_eq(i2c_inject_alert(1), true, 'SMBALERT inject flags when enabled');
assert_eq(periph_read(I2C1 + 0x14, 4) & (1 << 15), 1 << 15, 'I2C SR1 SMBALERT set');
assert_eq(periph_read(0xE000E204, 4) & 1, 0, 'no ER IRQ without ITERREN');
periph_write(I2C1 + 0x14, 4, 0); // SR1 write-0 clears SMBALERT
assert_eq(periph_read(I2C1 + 0x14, 4) & (1 << 15), 0, 'SMBALERT clears on SR1 write-0');
periph_write(I2C1 + 0x04, 4, 1 << 8); // ITERREN
assert_eq(i2c_inject_alert(1), true, 'SMBALERT re-flags with ITERREN');
assert_eq(periph_read(0xE000E204, 4) & 1, 1, 'ER IRQ pends with ITERREN');
periph_write(I2C1 + 0x14, 4, 0); // clear flag; pending bit needs ICPR
periph_write(0xE000E284, 4, 1); // ICPR1 bit 0: clear I2C1_ER pending
assert_eq(periph_read(0xE000E204, 4) & 1, 0, 'ER pending clears via ICPR');
periph_write(I2C1 + 0x00, 4, 0); // PE off
assert_eq(i2c_inject_alert(1), false, 'no ALERT flag when disabled');
assert_eq(periph_read(I2C1 + 0x14, 4), 0, 'SR1 clean when disabled');
periph_write(I2C1 + 0x00, 4, 1); // PE back on
drain_events(); // flush stale bus events
periph_write(I2C1 + 0x00, 4, 1 | (1 << 13)); // drive SMBA low
const aev = drain_events();
assert_eq(aev.length, 3, 'ALERT edge emits exactly one event');
assert_eq(aev[0], 19, 'I2cAlert discriminant');
assert_eq(aev[1], 1, 'I2cAlert channel');
assert_eq(aev[2], 1, 'I2cAlert asserted');
periph_write(I2C1 + 0x00, 4, 1); // release SMBA
const rev = drain_events();
assert_eq(rev.length, 3, 'ALERT release emits exactly one event');
assert_eq(rev[0], 19, 'I2cAlert discriminant on release');
assert_eq(rev[2], 0, 'I2cAlert deasserted');
assert_eq(periph_read(I2C1 + 0x14, 4) & (1 << 15), 0, 'own drive never sets own flag');
reset();

// ============================================================
// RTC
// ============================================================
group('RTC');

reset();
const RTC = 0x40002800;

// Write to RTC PRL (prescaler load)
periph_write(RTC + 0x0C, 4, 0x7FFF);
assert_eq(periph_read(RTC + 0x0C, 4), 0x7FFF, 'RTC PRL');

// Write to RTC CNT (counter) — low half
periph_write(RTC + 0x1C, 4, 0x1234);
assert_eq(periph_read(RTC + 0x1C, 4), 0x1234, 'RTC CNT');

// ============================================================
// PWR
// ============================================================
group('PWR');

reset();
const PWR = 0x40007000;

// Write CR: clear PDDS (bit 1), set LPDS (bit 0)
periph_write(PWR + 0x00, 4, 1);
assert_eq(periph_read(PWR + 0x00, 4) & 1, 1, 'PWR CR LPDS');
assert_eq(periph_read(PWR + 0x00, 4) & 2, 0, 'PWR CR PDDS = 0');

// ============================================================
// Flash
// ============================================================
group('FLASH');

reset();
const FLASH = 0x40022000;

// Write ACR: LATENCY=1 only, then verify
periph_write(FLASH + 0x00, 4, 1); // just LATENCY=1
let acr = periph_read(FLASH + 0x00, 4);
assert_eq(acr & 7, 1, 'FLASH ACR LATENCY=1');
// Enable PRFTEN + ICEN + DCEN
periph_write(FLASH + 0x00, 4, (1 << 0) | (1 << 2) | (1 << 3) | (1 << 4));
acr = periph_read(FLASH + 0x00, 4);
assert_eq(acr & (1 << 2), 1 << 2, 'FLASH ACR PRFTEN');
assert_eq(acr & (1 << 3), 1 << 3, 'FLASH ACR ICEN');
assert_eq(acr & (1 << 4), 1 << 4, 'FLASH ACR DCEN');

// Write protection: WRPR bit n guards 4KB block n; PG+STRT at a protected
// page raises WRPRTERR (SR.4) instead of going busy.
periph_write(FLASH + 0x20, 4, 1);               // WRPR: protect block 0
periph_write(FLASH + 0x10, 4, 0x08000000);      // AR: page in block 0
periph_write(FLASH + 0x0C, 4, (1 << 0) | (1 << 6)); // PG + STRT
assert_eq(periph_read(FLASH + 0x08, 4) & (1 << 4), 1 << 4, 'FLASH SR WRPRTERR on protected page');
periph_write(FLASH + 0x08, 4, periph_read(FLASH + 0x08, 4) & ~(1 << 4)); // clear
assert_eq(periph_read(FLASH + 0x08, 4) & (1 << 4), 0, 'FLASH SR WRPRTERR write-clears');
periph_write(FLASH + 0x20, 4, 0);               // unprotect
periph_write(FLASH + 0x10, 4, 0x08000000);
periph_write(FLASH + 0x0C, 4, (1 << 0) | (1 << 6));
assert_eq(periph_read(FLASH + 0x08, 4) & (1 << 4), 0, 'FLASH SR no WRPRTERR unprotected');

// ============================================================
// CAN
// ============================================================
group('CAN');

reset();
const CAN1 = 0x40006400;

// Write CAN MCR: INRQ (bit 0) = 1
periph_write(CAN1 + 0x00, 4, 1);
assert_eq(periph_read(CAN1 + 0x00, 4) & 1, 1, 'CAN1 MCR INRQ');

// Write CAN BTR
periph_write(CAN1 + 0x1C, 4, 0x001C0033);
assert_eq(periph_read(CAN1 + 0x1C, 4), 0x001C0033, 'CAN1 BTR');

// CAN TX IRQ is edge-triggered (RQCP 0->1 / TMEIE rising), never a storm
const IRQ_TX = 1 << 19; // CAN1_TX is IRQ19 -> ISPR0/ICPR0 bit19
periph_write(CAN1 + 0x00, 4, 0); // leave init mode
periph_write(NVIC + 0x00, 4, IRQ_TX); // ISER0: enable IRQ19
periph_write(CAN1 + 0x180, 4, (0x123 << 21) | 1); // TI0R TXRQ, TMEIE=0
assert_eq(periph_read(NVIC + 0x100, 4) & IRQ_TX, 0, 'no TX IRQ while TMEIE=0');
periph_write(CAN1 + 0x14, 4, 1); // IER TMEIE 0->1 with completion latched
assert_eq(periph_read(NVIC + 0x100, 4) & IRQ_TX, IRQ_TX, 'TX IRQ pends once on TMEIE rising');
periph_write(NVIC + 0x180, 4, IRQ_TX); // ICPR0: retire it
periph_write(CAN1 + 0x14, 4, 1); // IER same value: no rising edge
assert_eq(periph_read(NVIC + 0x100, 4) & IRQ_TX, 0, 'no TX re-pend without edge');
periph_write(CAN1 + 0x0C, 4, 0x20); // RF0R release (event-write fire source)
assert_eq(periph_read(NVIC + 0x100, 4) & IRQ_TX, 0, 'no TX re-pend on RX event');
periph_write(CAN1 + 0x08, 4, 0x00070707); // TSR W1C: clear completion
periph_write(CAN1 + 0x14, 4, 0);
periph_write(CAN1 + 0x14, 4, 1); // rising again, nothing outstanding
assert_eq(periph_read(NVIC + 0x100, 4) & IRQ_TX, 0, 'no TX pend after W1C clear');

// ============================================================
// DMA
// ============================================================
group('DMA');

reset();
const DMA1 = 0x40020000;

// Enable DMA1 clock
periph_write(0x40021014, 4, 1 << 0); // DMA1EN on APB1

// Configure channel 1: CCR
// M2M=1, PL=11 (very high), MSIZE=01 (16-bit), PSIZE=01, MINC=1, PINC=0, CIRC=0, DIR=1 (read from mem), EN=0 first
periph_write(DMA1 + 0x08 + 0*0x14, 4, (1 << 14) | (3 << 12) | (1 << 10) | (1 << 8) | (1 << 7) | (1 << 4));
let ccr = periph_read(DMA1 + 0x08 + 0*0x14, 4);
assert_eq(ccr & (1 << 14), 1 << 14, 'DMA1 CH1 CCR M2M');

// Set source (CNDTR), source addr, dest addr
periph_write(DMA1 + 0x08 + 2*4, 4, 0x20000000); // CPAR = source
periph_write(DMA1 + 0x08 + 3*4, 4, 0x20001000); // CMAR = dest
periph_write(DMA1 + 0x08 + 1*4, 4, 16); // CNDTR = 16 bytes
assert_eq(periph_read(DMA1 + 0x08 + 1*4, 4), 16, 'DMA1 CH1 CNDTR');

// ============================================================
// DMA pending transfer check
// ============================================================
group('DMA Transfer');

reset();
// Set up DMA channel 1
periph_write(0x40021014, 4, 1 << 0);
periph_write(DMA1 + 0x08 + 0*0x14, 4, 0); // disable first
periph_write(DMA1 + 0x08 + 2*4, 4, 0x20000000); // CPAR
periph_write(DMA1 + 0x08 + 3*4, 4, 0x20001000); // CMAR
periph_write(DMA1 + 0x08 + 1*4, 4, 8); // CNDTR = 8
// Enable with EN bit and DIR=memory-to-memory, MINC, PINC
periph_write(DMA1 + 0x08 + 0*0x14, 4, (1 << 14) | (1 << 7) | (1 << 6) | 1);
let dma_pending = periph.dma_get_pending_count();
assert_eq(dma_pending >= 1, true, 'DMA has pending transfers');
periph.dma_set_completed_many(1 << 0); // JS bridge moves the data, then signals completion
for (let i = 0; i < 3; i++) periph.tick();
assert_eq(periph_read(DMA1 + 0x08 + 1*4, 4), 0, 'DMA1 CNDTR 0 after transfer completes');
let dma_en = periph_read(DMA1 + 0x08 + 0*0x14, 4) & 1;
assert_eq(dma_en, 0, 'DMA1 EN cleared after transfer completes');

// ============================================================
// DMA circular mode (CIRC reload + HTIF, EN stays set)
// ============================================================
group('DMA circular');

reset();
const DMA1C = 0x40020000;
periph_write(0x40021014, 4, 1 << 0); // DMA1EN
periph_write(DMA1C + 0x08 + 2*4, 4, 0x20000000); // CPAR = source
periph_write(DMA1C + 0x08 + 3*4, 4, 0x20001000); // CMAR = dest
periph_write(DMA1C + 0x08 + 1*4, 4, 8); // CNDTR = 8
// M2M + CIRC + MINC + PINC + EN
periph_write(DMA1C + 0x08, 4, (1 << 14) | (1 << 5) | (1 << 7) | (1 << 6) | 1);
periph.dma_set_completed_many(1 << 0);
for (let i = 0; i < 3; i++) periph.tick();
assert_eq(periph_read(DMA1C + 0x00, 4) & (1 << 1), 1 << 1, 'CIRC TCIF set on completion');
assert_eq(periph_read(DMA1C + 0x00, 4) & (1 << 2), 1 << 2, 'CIRC HTIF set on completion');
assert_eq(periph_read(DMA1C + 0x08, 4) & 1, 1, 'CIRC EN stays set after completion');
assert_eq(periph_read(DMA1C + 0x08 + 1*4, 4), 8, 'CIRC CNDTR reloaded to init count');
// W1C clear both flags, run a second cycle: continuous, not one-shot.
periph_write(DMA1C + 0x04, 4, (1 << 1) | (1 << 2));
assert_eq(periph_read(DMA1C + 0x00, 4) & 0x6, 0, 'CIRC flags clear via IFCR');
periph.dma_set_completed_many(1 << 0);
for (let i = 0; i < 3; i++) periph.tick();
assert_eq(periph_read(DMA1C + 0x00, 4) & 0x6, 0x6, 'CIRC second cycle sets TCIF+HTIF again');
assert_eq(periph_read(DMA1C + 0x08, 4) & 1, 1, 'CIRC EN still set after second cycle');

// ============================================================
// DMA pump exports (Rust-side periph byte movement, replaces
// the JS per-chunk periph_read/periph_write loops in processDma)
// ============================================================
group('DMA pump exports');

reset();
const USART1_PUMP = 0x40013800;
periph_write(0x40021014, 4, 1 << 14); // USART1EN on APB2
periph_write(0x40021014, 4, 1 << 0);  // DMA1EN on APB1
// USART1 TX on PA9, RX on PA10
periph_write(0x40010804, 4, (0x4 << 14) | 0x4); // CRH PA9-10 AF push-pull (10MHz)
periph_write(0x4001380C, 4, 0x200C);            // CR1 UE|TE|RE
// absorb: pops RX FIFO bytes in order via the periph_read path
periph.uart_rx_byte(USART1_PUMP, 0x41); // 'A'
periph.uart_rx_byte(USART1_PUMP, 0x42); // 'B'
periph.uart_rx_byte(USART1_PUMP, 0x43); // 'C'
// NOTE: wasm-bindgen returns Vec<u8> as a plain JS number array; Uint8Array
// wrap keeps join() from stringifying element 65 as "65"
let popped = Array.from(new Uint8Array(periph.dma_absorb_periph(USART1_PUMP + 0x04, 3)), b => String.fromCharCode(b)).join('');
assert_eq(popped, 'A\x00\x00', 'dma_absorb_periph pops RX FIFO byte first, pads chunk tail');
assert_eq(periph.uart_rx_pending(USART1_PUMP), 2, 'dma_absorb_periph pops ONE FIFO byte per read');
// absorb with odd size: chunk=4 read returns the FIFO byte + zero pad (JS loop semantics)
periph.uart_rx_byte(USART1_PUMP, 0x51); // 'Q'
popped = Array.from(new Uint8Array(periph.dma_absorb_periph(USART1_PUMP + 0x04, 5)), b => String.fromCharCode(b)).join('');
assert_eq(popped, 'B\x00\x00\x00C', 'absorb 5-byte read pops a FIFO byte per chunk, zero pads');
assert_eq(periph.uart_rx_pending(USART1_PUMP), 1, 'absorb consumed 2 of 3 queued bytes');
// push: USART DR consumes ONE byte per write (FIFO), so a 3-byte buffer lands byte 0
periph.dma_push_periph(USART1_PUMP + 0x04, new Uint8Array([0x41, 0x42, 0x43]));
let out = get_uart_output();
assert_eq(out, 'A', 'dma_push_periph feeds the chunk-leading byte to the TX FIFO');
// uneven chunk (4+3): leading bytes of each chunk are consumed, rest return to FIFO
periph.dma_push_periph(USART1_PUMP + 0x04, new Uint8Array([1, 2, 3, 4, 5, 6, 7]));
out = get_uart_output();
assert_eq(out, '\x01\x05', 'dma_push_periph handles uneven chunks (per-chunk lead byte)');
// per-byte pushes (real DMA TX pattern: size 1 per transfer) land every byte
periph.dma_push_periph(USART1_PUMP + 0x04, new Uint8Array([0x50]));
periph.dma_push_periph(USART1_PUMP + 0x04, new Uint8Array([0x51]));
out = get_uart_output();
assert_eq(out, 'PQ', 'dma_push_periph per-byte pushes land in order');

// NRST discards an abandoned DMA plan: queue a periph->mem transfer, reset
// before the pump, and prove the next pump serves no stale bytes and no
// completion bits (board_nrst clears pending_dma + absorb_buf).
reset();
const DMA1N = 0x40020000, U1N = 0x40013800;
periph_write(0x40021018, 4, (1 << 14) | (1 << 2)); // USART1EN + GPIOAEN
periph_write(0x40021014, 4, 1 << 0); // DMA1EN
periph.uart_rx_byte(U1N, 0x41); // 'A' queued in the RX FIFO
periph_write(DMA1N + 0x08 + 4 * 0x14, 4, (1 << 7) | (1 << 2)); // CH5 MINC+TCIE
periph_write(DMA1N + 0x08 + 4 * 0x14 + 4, 4, 2); // CNDTR=2
periph_write(DMA1N + 0x08 + 4 * 0x14 + 8, 4, U1N + 0x04); // CPAR=DR
periph_write(DMA1N + 0x08 + 4 * 0x14 + 12, 4, 0x20001000); // CMAR
periph_write(U1N + 0x14, 4, 1 << 6); // CR3 DMAR
periph_write(DMA1N + 0x08 + 4 * 0x14, 4, (1 << 7) | (1 << 2) | 1); // EN -> queues
assert_eq(periph.dma_get_pending_count() >= 1, true, 'DMA plan queued pre-reset');
periph.board_nrst();
assert_eq(periph.dma_get_pending_count(), 0, 'NRST clears queued DMA plans');
assert_eq(periph.dma_pump_all().length, 0, 'NRST: post-reset pump serves nothing');
{ let comp = false;
  for (let i = 0; i < 3; i++) periph.tick();
  comp = (periph_read(DMA1N + 0x00, 4) & (1 << 17)) !== 0; // TCIF5
  assert_eq(comp, false, 'NRST: no stale CH5 completion bit'); }

reset();
const SCB = 0xE000ED00;

// Read CPUID
let cpuid = periph_read(SCB + 0x00, 4);
// ARM implementer=0x41, part=0xC24 → 0x41_0_C24_1 = 0x410FC241
assert_eq(cpuid >> 24, 0x41, 'SCB CPUID implementer = ARM');

// Write VTOR
periph_write(SCB + 0x08, 4, 0x08000000);
assert_eq(periph_read(SCB + 0x08, 4), 0x08000000, 'SCB VTOR');

// Pend SysTick via ICSR
periph_write(SCB + 0x04, 4, 1 << 26); // ICSR PENDSTSET
assert_eq(has_pending_interrupt(), true, 'SCB PendSV via ICSR pending');

// ============================================================
// TIM Real Counting Test
// ============================================================
group('TIM Counting');

reset();
const T2 = 0x40000000;
// RM0008 reset value: ARR = 0xFFFF (the old 0xFFFF_FFFF made the closed-form
// advance compute a 4B-tick window and wedged the post-NRST catch-up tick).
assert_eq(periph_read(T2 + 0x2C, 4), 0xFFFF, 'TIM2 ARR reset = 0xFFFF');

// Enable TIM2 clock
periph_write(0x40021014, 4, 1 << 0);

// Set PSC=0 (no prescaler), ARR=999 → counts 0..999 then wraps
periph_write(T2 + 0x28, 4, 0);    // PSC = 0
periph_write(T2 + 0x2C, 4, 999);  // ARR = 999

// Enable timer (CR1.CEN = bit 0)
periph_write(T2 + 0x00, 4, 1);

// Run 500 ticks — CNT should be ~500
for (let i = 0; i < 500; i++) tick();
let tcnt = periph_read(T2 + 0x24, 4);
assert_eq(tcnt, 500, 'TIM2 CNT = 500 after 500 ticks with PSC=0');

// Run another 600 ticks → should wrap (500+600=1100, wraps to 1000 mod 1000 = 100)
for (let i = 0; i < 600; i++) tick();
tcnt = periph_read(T2 + 0x24, 4);
assert_eq(tcnt, 100, 'TIM2 CNT wrapped to 100 after 1100 total ticks');

// Check SR.UIF (bit 0) set on overflow
let tsr = periph_read(T2 + 0x10, 4);
assert_eq(tsr & 1, 1, 'TIM2 SR UIF set after overflow');

// Clear UIF by writing SR (write 0 to clear)
periph_write(T2 + 0x10, 4, 0);
tsr = periph_read(T2 + 0x10, 4);
assert_eq(tsr & 1, 0, 'TIM2 SR UIF cleared');

// ============================================================
// TIM Update Interrupt Test
// ============================================================
group('TIM Interrupt');

reset();

periph_write(0x40021014, 4, 1 << 0);
periph_write(T2 + 0x28, 4, 0);    // PSC = 0
periph_write(T2 + 0x2C, 4, 99);   // ARR = 99 (wrap every 100 ticks)
periph_write(T2 + 0x0C, 4, 1);   // DIER.UIE = 1 (enable update interrupt)
periph_write(T2 + 0x00, 4, 1);   // CEN = 1

// Enable TIM2 IRQ (28) in NVIC ISER0
periph_write(0xE000E100, 4, 1 << 28);

// No interrupt should be pending yet
assert_eq(has_pending_interrupt(), false, 'TIM2 no IRQ pending before overflow');

// Run 200 ticks → should overflow twice
for (let i = 0; i < 200; i++) tick();

// Update interrupt should fire (TIM2 IRQ = 28)
assert_eq(has_pending_interrupt(), true, 'TIM2 IRQ pending after overflow');
let tim_irq = get_next_pending_interrupt();
assert_eq(tim_irq, 28, 'TIM2 IRQ number = 28');
assert_eq(has_pending_interrupt(), false, 'TIM2 IRQ cleared after get');
clear_current_interrupt(); // EOI: pair every take with a return

// ============================================================
// TIM Prescaler Test
// ============================================================
group('TIM Prescaler');

reset();

periph_write(0x40021014, 4, 1 << 0);
periph_write(T2 + 0x28, 4, 9);    // PSC = 9 (tick every 10 instructions)
periph_write(T2 + 0x2C, 4, 99);   // ARR = 99
periph_write(T2 + 0x00, 4, 1);    // CEN = 1

// Run 500 ticks → prescaler divides by 10, so CNT should be 50
for (let i = 0; i < 500; i++) tick();
tcnt = periph_read(T2 + 0x24, 4);
assert_eq(tcnt, 50, 'TIM2 CNT = 50 after 500 ticks with PSC=9');

// ============================================================
// RTC Real Counting Test
// ============================================================
group('RTC Counting');

reset();

// Enable RTC (CRL bit 5 = RTOFF)
periph_write(0x40002800 + 0x04, 4, 1 << 5);

// Set prescaler = 99 (CNT increments every 100 ticks)
periph_write(0x40002800 + 0x0C, 4, 99);

// Write initial CNT = 0
periph_write(0x40002800 + 0x1C, 4, 0); // cntl
periph_write(0x40002800 + 0x18, 4, 0); // cnth

assert_eq(periph_read(0x40002800 + 0x1C, 4), 0, 'RTC CNTL = 0 initial');

// Run 1000 ticks → should increment CNT by ~10
for (let i = 0; i < 1000; i++) tick();

let cntl = periph_read(0x40002800 + 0x1C, 4);
assert_eq(cntl, 10, 'RTC CNT = 10 after 1000 ticks with PRL=99');

// Run 500 more ticks → CNT should be ~15
for (let i = 0; i < 500; i++) tick();
cntl = periph_read(0x40002800 + 0x1C, 4);
assert_eq(cntl, 15, 'RTC CNT = 15 after 1500 total ticks');

// ============================================================
// FLASH Unlock Test
// ============================================================
group('FLASH Unlock');

reset();

// CR should be locked initially (LOCK bit 7 = 1)
let flash_cr = periph_read(0x40022000 + 0x0C, 4);
assert_eq(flash_cr & (1 << 7), 1 << 7, 'FLASH CR LOCK = 1 locked');

// Unlock sequence: write KEY1 then KEY2 to KEYR
periph_write(0x40022000 + 0x04, 4, 0x45670123); // KEY1
periph_write(0x40022000 + 0x04, 4, 0xCDEF89AB); // KEY2

// CR should now be unlocked
flash_cr = periph_read(0x40022000 + 0x0C, 4);
assert_eq(flash_cr & (1 << 7), 0, 'FLASH CR LOCK = 0 after unlock');

// Set PG (bit 0) for programming
periph_write(0x40022000 + 0x0C, 4, 1); // PG=1
flash_cr = periph_read(0x40022000 + 0x0C, 4);
assert_eq(flash_cr & 1, 1, 'FLASH CR PG = 1 after unlock');

// Write flash address to AR
periph_write(0x40022000 + 0x10, 4, 0x08010000);
assert_eq(periph_read(0x40022000 + 0x10, 4), 0x08010000, 'FLASH AR = 0x08010000');

// Check SR — BSY should be set (bit 0) when PG is active
let flash_sr = periph_read(0x40022000 + 0x08, 4);
assert_eq(flash_sr & 1, 1, 'FLASH SR BSY = 1 while PG active');

// Clear PG bit
periph_write(0x40022000 + 0x0C, 4, 0);
flash_sr = periph_read(0x40022000 + 0x08, 4);
assert_eq(flash_sr & 1, 0, 'FLASH SR BSY = 0 after PG cleared');

// ============================================================
// CAN TX Mailbox Test
// ============================================================
group('CAN TX');

reset();

// Initial TSR — bits 26:24 (CODE) should indicate all mailboxes empty (0b100 = 4)
let can_tsr = periph_read(0x40006400 + 0x08, 4);
// TSR[31:26] = CODE field: 0x1C = 0b111 = mailbox 2 is the next empty one
assert_eq((can_tsr >> 26) & 7, 7, 'CAN TSR CODE = 7 all mailboxes empty');

// Write TX mailbox 0: TIR with TXRQ=1 (bit 0)
periph_write(0x40006400 + 0x180, 4, 0xABCD0001); // STDID=0xABCD, TXRQ=1
periph_write(0x40006400 + 0x184, 4, 8);          // DLC=8
periph_write(0x40006400 + 0x188, 4, 0xDEADBEEF); // data low
periph_write(0x40006400 + 0x18C, 4, 0x12345678); // data high

// TSR should show mailbox 0 as active (TME0 = bit 26 = 0, RQCP0 = bit 0 = 1, TXOK0 = bit 16 = 1)
can_tsr = periph_read(0x40006400 + 0x08, 4);
assert_eq(can_tsr & (1 << 0), 1 << 0, 'CAN TSR RQCP0 = 1 (request completed)');
assert_eq(can_tsr & (1 << 16), 1 << 16, 'CAN TSR TXOK0 = 1 (transmit OK)');

// Read back mailbox for verification
let can_tir = periph_read(0x40006400 + 0x180, 4);
assert_eq(can_tir, 0xABCD0001, 'CAN TX mailbox TIR preserved');
let can_tdtr = periph_read(0x40006400 + 0x184, 4);
assert_eq(can_tdtr, 8, 'CAN TX mailbox TDTR DLC=8');

// ============================================================
// CAN RX Mailbox Test
// ============================================================
group('CAN RX');

reset();

// Simulate a received message: populate RX mailbox 0
periph_write(0x40006400 + 0x1B0, 4, 0x1230001); // TIR with valid ID
periph_write(0x40006400 + 0x1B4, 4, 4);          // DLC=4
periph_write(0x40006400 + 0x1B8, 4, 0xAABBCCDD); // data
// Set FMP = 1 to indicate 1 message pending in FIFO 0
periph_write(0x40006400 + 0x0C, 4, 1);

// RF0R should show 1 message pending (FMP bits 1:0)
let can_rf0r = periph_read(0x40006400 + 0x0C, 4);
assert_eq(can_rf0r & 0x3, 1, 'CAN RF0R FMP = 1 message pending');

// Read RX mailbox 0 — should decrement FMP
let can_rx_tir = periph_read(0x40006400 + 0x1B0, 4);
assert_eq(can_rx_tir, 0x1230001, 'CAN RX mailbox TIR');
can_rf0r = periph_read(0x40006400 + 0x0C, 4);
assert_eq(can_rf0r & 0x3, 0, 'CAN RF0R FMP = 0 after reading RX mailbox');

// ============================================================
// CAN Filter Bank & RX Injection Test
// ============================================================
group('CAN Filter');

reset();
// Configure filter bank 0 as 32-bit identifier list mode
periph_write(0x40006400 + 0x200, 4, 0); // FMR: FINIT=0 (leave init mode)
// Enter init mode
periph_write(0x40006400 + 0x200, 4, 1); // FMR: FINIT=1
periph_write(0x40006400 + 0x204, 4, 0); // FM1R: all 16-bit dual, bank 0 = 0 (16-bit x2)
periph_write(0x40006400 + 0x20C, 4, 0xFFFFFFFF); // FS1R: all ID list mode
periph_write(0x40006400 + 0x214, 4, 0); // FFA1R: all FIFO 0
periph_write(0x40006400 + 0x21C, 4, 1); // FA1R: enable filter bank 0
// Set filter bank 0: in 16-bit list mode, store two 16-bit IDs per filter word
// Filter 0 word 0: 0x0555XXXX where 0x0555 = ID1(match 0x555), 0xXXXX = ID2
periph_write(0x40006400 + 0x240, 4, (0x555 << 16) | 0x321); // ID1=0x555, ID2=0x321
periph_write(0x40006400 + 0x244, 4, (0x123 << 16) | 0x456); // ID3=0x123, ID4=0x456
// Exit init mode preserving CAN2SB=14 (bare FMR=0 would hand all 28 banks
// to CAN2 — silicon-true, so keep the split: read-modify-write like HAL)
periph_write(0x40006400 + 0x200, 4, (14 << 8)); // FMR: FINIT=0, CAN2SB=14

// Now inject a message with STDID=0x555 (should match)
let msg_tir = ((0x555 << 21) | 1) >>> 0; // TXRQ + STDID=0x555 (unsigned)
let matched = can_inject_message(0x40006400, msg_tir, 8, 0xDEADBEEF, 0x12345678);
assert_eq(matched, true, 'CAN message with STDID=0x555 matched filter');

let rf0r = periph_read(0x40006400 + 0x0C, 4);
assert_eq(rf0r & 0x3, 1, 'CAN RF0R FMP=1 after filter match');

// Read the message back
let rx_tir = periph_read(0x40006400 + 0x1B0, 4);
assert_eq(rx_tir, msg_tir, 'CAN RX TIR matches injected message');
let rx_tdtr = periph_read(0x40006400 + 0x1B4, 4);
assert_eq(rx_tdtr, 8, 'CAN RX TDTR DLC=8');

// Inject a message that should NOT match (STDID=0x999)
let unmatched = can_inject_message(0x40006400, (0x999 << 21) | 1, 4, 0, 0);
assert_eq(unmatched, false, 'CAN message STDID=0x999 rejected by filter');

// Time-triggered timestamps (TTCM, MCR.7): TXRQ stamps TDTxR TIME[31:16],
// RX arrival stamps RDTxR TIME. Stamps advance with instruction count.
periph_write(0x40006400 + 0x00, 4, 1 << 7); // MCR TTCM
periph_write(0x40006400 + 0x180, 4, 0); // TIR0 ID 0
periph_write(0x40006400 + 0x184, 4, 2); // DLC=2, TIME=0
periph_write(0x40006400 + 0x188, 4, 0xBEAD);
periph_write(0x40006400 + 0x180, 4, 1); // TXRQ
const tdt0a = periph_read(0x40006400 + 0x184, 4);
step_batch(70000);
periph_write(0x40006400 + 0x180, 4, 1); // TXRQ again
const tdt0b = periph_read(0x40006400 + 0x184, 4);
assert_eq(tdt0a & 0xFFFF, 2, 'CAN TDT0R DLC preserved under TTCM stamp');
assert((tdt0b >> 16) !== (tdt0a >> 16), `CAN TX timestamps advance (${(tdt0a >> 16).toString(16)} -> ${(tdt0b >> 16).toString(16)})`);
// Without TTCM the TIME field is left alone
periph_write(0x40006400 + 0x00, 4, 0); // TTCM off
periph_write(0x40006400 + 0x184, 4, (0xAB << 16) | 2);
periph_write(0x40006400 + 0x180, 4, 1); // TXRQ
assert_eq(periph_read(0x40006400 + 0x184, 4) >> 16, 0xAB, 'CAN TDT0R TIME untouched without TTCM');
// RX stamp: inject with TTCM on (filter bank 0 still matches 0x555)
periph_write(0x40006400 + 0x00, 4, 1 << 7); // TTCM on
assert_eq(can_inject_message(0x40006400, msg_tir, 8, 0xDEADBEEF, 0x12345678), true, 'CAN RX inject for timestamp');
const rdt = periph_read(0x40006400 + 0x1B4, 4);
assert_eq(rdt & 0xF, 8, 'CAN RDT0R DLC preserved under RX stamp');
assert_eq((rdt >> 16) & 0xFFFF, (tdt0b >> 16) & 0xFFFF, 'CAN RX timestamp matches inject time');

// ============================================================
// AFIO Register Test
// ============================================================
group('AFIO');

reset();

// Read default AFIO MAPR
let mapr = periph_read(0x40010004, 4);
assert_eq(mapr, 0, 'AFIO MAPR default = 0');

// Write MAPR (remap USART1 to PB6/PB7)
periph_write(0x40010004, 4, 0x40000004);
mapr = periph_read(0x40010004, 4);
assert_eq(mapr, 0x40000004, 'AFIO MAPR write preserves value');

// Write MAPR2 (remap SPI1)
periph_write(0x4001001C, 4, 0x01);
let mapr2 = periph_read(0x4001001C, 4);
assert_eq(mapr2, 0x01, 'AFIO MAPR2 write/read');

// ============================================================
// EXTI Register Test
// ============================================================
group('EXTI');

reset();

// Configure EXTI line 0 for rising edge
periph_write(0x40010400, 4, 1); // IMR: unmask line 0
periph_write(0x40010408, 4, 1); // RTSR: rising edge trigger line 0

// Software trigger line 0
periph_write(0x40010410, 4, 1); // SWIER: set line 0
let swier = periph_read(0x40010410, 4);
assert_eq(swier & 1, 1, 'EXTI SWIER line 0 pending');
let pr = periph_read(0x40010414, 4);
assert_eq(pr & 1, 1, 'EXTI PR line 0 set');

// Clear pending by writing 1 to PR
periph_write(0x40010414, 4, 1);
pr = periph_read(0x40010414, 4);
assert_eq(pr & 1, 0, 'EXTI PR cleared');

// ============================================================
// I2C NACK Test
// ============================================================
group('I2C NACK');

reset();

// Enable I2C1 clock and configure
periph_write(0x4002101C, 4, 1 << 22); // I2C1 clock enable
periph_write(0x40005400, 4, 1); // CR1: PE=1 (enable)

// Generate START condition
periph_write(0x40005400, 4, 0x101); // CR1: PE=1, START=1

// Check SB flag set
let sr1 = periph_read(0x40005414, 4);
assert_eq(sr1 & 1, 1, 'I2C SR1 SB set after START');

// Send address to non-existent device (0x50, write)
periph_write(0x40005410, 4, (0x50 << 1) | 0); // DR = (addr << 1) | R/W

// Should get AF (Acknowledge Failure) in SR1
sr1 = periph_read(0x40005414, 4);
assert_eq(sr1 & (1 << 10), 1 << 10, 'I2C SR1 AF set on missing address');

// ============================================================
// UART RX Interrupt Test
// ============================================================
group('UART RX');

reset();

// Enable USART1 (CR1: UE=1, RE=1, TE=1, RXNEIE=1) and set BRR
periph_write(0x40021018, 4, 1 << 14); // USART1 clock enable
periph_write(0x4001380C, 4, 0x202D); // CR1: UE=1, RE=1, RXNEIE=1, TE=1... actually UE=0
// UE is bit 13, RE is bit 2, TE is bit 3, RXNEIE is bit 5
// CR1 = (1<<13) | (1<<3) | (1<<2) | (1<<5) = 0x202C
periph_write(0x4001380C, 4, (1<<13) | (1<<3) | (1<<2) | (1<<5));
// Enable USART1 IRQ (37) in NVIC
periph_write(0xE000E104, 4, 1 << 5); // ISER1 bit 5

// Inject a byte via RX
uart_rx_byte(0x40013800, 0x42);

// Check RXNE is set
let uart_sr = periph_read(0x40013800, 4);
assert_eq(uart_sr & (1 << 5), 1 << 5, 'UART SR RXNE set after rx_byte');

// Check interrupt is pending (RXNEIE enabled, RXNE set)
assert_eq(has_pending_interrupt(), true, 'UART RX interrupt pending after byte');

// Read the byte from DR
let rx_dr = periph_read(0x40013804, 4);
assert_eq(rx_dr, 0x42, 'UART DR contains injected byte');

// ============================================================
// RTC Alarm Interrupt Test
// ============================================================
group('RTC Alarm');

reset();

// Enable RTC IRQ (3) in NVIC ISER0
periph_write(0xE000E100, 4, 1 << 3);

// Configure RTC: enable, set PRL=99, set ALR=5, enable ALRIE (CRH bit 1)
periph_write(0x40002820, 4, 0);   // ALRH = 0
periph_write(0x40002824, 4, 5);   // ALRL = 5 (alarm = 0x00000005)
periph_write(0x4000280C, 4, 99);  // PRLL = 99 (count every 100 ticks)
periph_write(0x40002800, 4, 2);   // CRH: ALRIE (bit 1, RM0008)
periph_write(0x40002804, 4, 1 << 5);   // CRL: RTOFF=1 (enable)

// No interrupt should be pending yet
assert_eq(has_pending_interrupt(), false, 'RTC no IRQ before alarm');

// Run 600 ticks — RTC should count to 6, passing alarm at 5
for (let i = 0; i < 600; i++) tick();

// Alarm should have fired (IRQ 3) with ALRF set and SECF clear (SECIE off)
assert_eq(periph_read(0x40002804, 4) & 0x02, 0x02, 'RTC ALRF flag set on alarm');
assert_eq(periph_read(0x40002804, 4) & 0x01, 0, 'RTC SECF clear (SECIE off)');
assert_eq(has_pending_interrupt(), true, 'RTC alarm IRQ pending');
let rtc_irq = get_next_pending_interrupt();
assert_eq(rtc_irq, 3, 'RTC alarm IRQ number = 3');
clear_current_interrupt(); // EOI: pair every take with a return
// Flags clear by writing 0
periph_write(0x40002804, 4, 0);
assert_eq(periph_read(0x40002804, 4) & 0x03, 0, 'RTC ALRF/SECF cleared by writing 0');

// ============================================================
// RTC second + overflow interrupts (SECIE=bit0, OWIE=bit2)
// ============================================================
group('RTC second/overflow');

reset();
periph_write(0xE000E100, 4, 1 << 3); // ISER0: enable IRQ 3
periph_write(0x4000280C, 4, 99);     // PRLL = 99
periph_write(0x4000281C, 4, 0);      // CNTL = 0
periph_write(0x40002818, 4, 0);      // CNTH = 0
periph_write(0x40002800, 4, 1);      // CRH: SECIE (bit 0) — alarm must NOT fire
periph_write(0x40002804, 4, 1 << 5); // CRL: RTOFF
for (let i = 0; i < 250; i++) tick(); // ~2.5 seconds
assert_eq(periph_read(0x40002804, 4) & 0x01, 0x01, 'RTC SECF set after seconds elapse');
assert_eq(periph_read(0x40002804, 4) & 0x02, 0, 'RTC ALRF clear (ALRIE off)');
assert(has_pending_interrupt() && get_next_pending_interrupt() === 3,
    'RTC second IRQ pending (IRQ 3)');
clear_current_interrupt();

// Overflow: CNT wraps with OWIE set
reset();
periph_write(0xE000E100, 4, 1 << 3);
periph_write(0x4000280C, 4, 0);        // PRLL = 0 -> prescaler 1
periph_write(0x4000281C, 4, 0xFFFE);   // CNTL near wrap
periph_write(0x40002818, 4, 0xFFFF);   // CNTH near wrap
periph_write(0x40002800, 4, 4);        // CRH: OWIE (bit 2) only
periph_write(0x40002804, 4, 1 << 5);
for (let i = 0; i < 10; i++) tick();
assert_eq(periph_read(0x40002804, 4) & 0x04, 0x04, 'RTC OWF set on wrap');
assert(has_pending_interrupt() && get_next_pending_interrupt() === 3,
    'RTC overflow IRQ pending (IRQ 3)');
clear_current_interrupt();

// ============================================================
// BKP Register Test
// ============================================================
group('BKP');

reset();

// Enable BKP and PWR clock
periph_write(0x4002101C, 4, 1 << 28); // PWREN
periph_write(0x4002101C, 4, (1 << 28) | (1 << 27)); // BKPEN bit 27 + PWREN
// Write and read BKP data register 1
periph_write(0x40006C04, 4, 0x1234);
let bkp_dr1 = periph_read(0x40006C04, 4);
assert_eq(bkp_dr1, 0x1234, 'BKP DR1 write/read');

// Write and read BKP data register 10
periph_write(0x40006C28, 4, 0xABCD);
let bkp_dr10 = periph_read(0x40006C28, 4);
assert_eq(bkp_dr10, 0xABCD, 'BKP DR10 write/read');

// Write BKP RTCCR (real offset 0x2C per RM0008/SVD)
periph_write(0x40006C2C, 4, 0x0100);
let rtccr = periph_read(0x40006C2C, 4);
assert_eq(rtccr, 0x0100, 'BKP RTCCR write/read');

// ============================================================
// DAC Register Test
// ============================================================
group('DAC');

reset();

// Enable DAC clock
periph_write(0x4002101C, 4, 1 << 29); // DACEN

// Write DAC channel 1 12-bit right-aligned data
periph_write(0x40007408, 4, 0x7FF);
let dhr1 = periph_read(0x40007408, 4);
assert_eq(dhr1, 0x7FF, 'DAC DHR12R1 write/read');

// Check DOR1 updated
let dor1 = periph_read(0x4000742C, 4);
assert_eq(dor1, 0x7FF, 'DAC DOR1 reflects DHR12R1');

// Write DAC channel 1 8-bit right-aligned data
periph_write(0x40007410, 4, 0xAB);
let dhr8r1 = periph_read(0x40007410, 4);
assert_eq(dhr8r1, 0xAB, 'DAC DHR8R1 write/read');
dor1 = periph_read(0x4000742C, 4);
assert_eq(dor1, 0xAB0, 'DAC DOR1 = DHR8R1 << 4');

// Read DAC SR
let sr_dac = periph_read(0x40007434, 4);
assert_eq(sr_dac, 0, 'DAC SR default = 0');

// ============================================================
// TIM6 Basic Timer Test
// ============================================================
group('TIM6');

reset();
const T6 = 0x40001000;

// Enable TIM6 clock (APB1, bit 4)
periph_write(0x4002101C, 4, 1 << 4);

// Set PSC=0, ARR=49 (wrap every 50 ticks)
periph_write(T6 + 0x28, 4, 0);
periph_write(T6 + 0x2C, 4, 49);
periph_write(T6 + 0x00, 4, 1); // CEN=1

// Run 30 ticks → CNT should be 30
for (let i = 0; i < 30; i++) tick();
let cnt6 = periph_read(T6 + 0x24, 4);
assert_eq(cnt6, 30, 'TIM6 CNT = 30 after 30 ticks');

// Run 30 more ticks → should wrap (60 % 50 = 10)
for (let i = 0; i < 30; i++) tick();
cnt6 = periph_read(T6 + 0x24, 4);
assert_eq(cnt6, 10, 'TIM6 CNT wrapped to 10');

// ============================================================
// GPIO electrical model (pull-ups, open-drain, slew readback)
// ============================================================
group('GPIO electrical');

reset();
const GPIOA = 0x40010800;

// PA0 input pull-up: CNF=01 (pull), MODE=00, ODR bit0 = 1
periph_write(GPIOA + 0x00, 4, (0b01 << 2) | 0); // CRL[3:0] = 0b01xx? -> CNF=01, MODE=00
periph_write(GPIOA + 0x0C, 4, 0x0001);          // ODR bit0 = 1 (pull-up)
assert_eq(periph_read(GPIOA + 0x08, 4) & 1, 1, 'GPIO PA0 pull-up reads 1');

// PA0 input pull-down: ODR bit0 = 0
periph_write(GPIOA + 0x0C, 4, 0x0000);
assert_eq(periph_read(GPIOA + 0x08, 4) & 1, 0, 'GPIO PA0 pull-down reads 0');

// PA0 input floating, no external driver -> 0
periph_write(GPIOA + 0x00, 4, 0b0100);          // CNF=00 (floating), MODE=00
assert_eq(periph_read(GPIOA + 0x08, 4) & 1, 0, 'GPIO PA0 floating reads 0');

// PA1 push-pull output: CNF=00, MODE=10 (2MHz); ODR drives IDR
periph_write(GPIOA + 0x00, 4, 0b0010 << 4);     // PA1 = push-pull out
periph_write(GPIOA + 0x0C, 4, 0x0002);          // ODR bit1 = 1
assert_eq(periph_read(GPIOA + 0x08, 4) >> 1 & 1, 1, 'GPIO PA1 push-pull high reads 1');
periph_write(GPIOA + 0x0C, 4, 0x0000);
assert_eq(periph_read(GPIOA + 0x08, 4) >> 1 & 1, 0, 'GPIO PA1 push-pull low reads 0');

// PA2 open-drain: CNF=11, MODE=10. Released (ODR=1) + external pull-up -> 1
periph_write(GPIOA + 0x00, 4, (0b1110 << 8) | (0b0010 << 4) | 0b0100);
gpio_set_input(0, 2, true);                     // external pull-up on PA2
periph_write(GPIOA + 0x0C, 4, 0x0004);          // released
assert_eq(periph_read(GPIOA + 0x08, 4) >> 2 & 1, 1, 'GPIO PA2 open-drain released + pull-up reads 1');
periph_write(GPIOA + 0x0C, 4, 0x0000);          // drive low
assert_eq(periph_read(GPIOA + 0x08, 4) >> 2 & 1, 0, 'GPIO PA2 open-drain driven low reads 0');

// External driver wins over push-pull output
periph_write(GPIOA + 0x0C, 4, 0x0002);          // PA1 push-pull high
gpio_set_input(0, 1, false);                    // external driver pulls low
assert_eq(periph_read(GPIOA + 0x08, 4) >> 1 & 1, 0, 'GPIO external driver beats push-pull');
assert_eq(gpio_read_output(0, 1), false, 'gpio_read_output honors external driver');

// Slew: transitions take N instructions; IDR shows the old level meanwhile
// (PA3 push-pull, no external driver registered)
periph_write(GPIOA + 0x00, 4, 0b0010 << 12);    // PA3 = push-pull out
gpio_set_slew(100);
periph_write(GPIOA + 0x10, 4, 1 << 3);          // BSRR set PA3
assert_eq(periph_read(GPIOA + 0x08, 4) >> 3 & 1, 0, 'GPIO slew: IDR still old level during transition');
step_batch(100);
assert_eq(periph_read(GPIOA + 0x08, 4) >> 3 & 1, 1, 'GPIO slew: IDR settled after transition');
gpio_set_slew(0);

// ============================================================
// FSMC external memory (NOR banks, MBKEN/WREN gating)
// ============================================================
group('FSMC');

add_fsmc_bank('FSMC.BANK1', new Uint8Array([0x11, 0x22, 0x33, 0x44]));
reset();
const FSMC_BCR1 = 0xA0000000;
const NE1 = 0x60000000;

// Disabled: reads return 0
assert_eq(periph_read(NE1, 4), 0, 'FSMC NE1 reads 0 when MBKEN=0');

// Enable BCR1 (MBKEN) + WREN, write and read back
periph_write(FSMC_BCR1, 4, 0x3);                // MBKEN | WREN
periph_write(NE1, 4, 0x44332211);
assert_eq(periph_read(NE1, 4), 0x44332211, 'FSMC NE1 32-bit write/read round-trip');

// Byte access
periph_write(NE1 + 1, 1, 0xAB);
assert_eq(periph_read(NE1, 4), 0x4433AB11, 'FSMC NE1 byte write preserves other bytes');
assert_eq(periph_read(NE1 + 1, 1), 0xAB, 'FSMC NE1 byte read');

// Writes ignored without WREN
periph_write(FSMC_BCR1, 4, 0x1);                // MBKEN only
periph_write(NE1, 4, 0xDEADBEEF);
assert_eq(periph_read(NE1, 4), 0x4433AB11, 'FSMC NE1 write ignored without WREN');

// NAND ECC (ECCR2 @ 0xB4): row+column Hamming over data bytes while
// PCR.ECCEN is set; cleared on ECCEN 0->1. Single-bit flips locate via
// syndrome (see below); bit-exact silicon parity unverified, no oracle.
const NAND2 = 0x70000000;
const PCR2 = 0xA0000060, ECCR2 = 0xA00000B4;
assert_eq(periph_read(ECCR2, 4), 0, 'FSMC ECCR2 reset 0');
periph_write(PCR2, 4, 1 << 6);                  // ECCEN
periph_write(NAND2, 1, 0xAB);
periph_write(NAND2 + 1, 1, 0xCD);
const ecc1 = periph_read(ECCR2, 4);
assert(ecc1 !== 0, `FSMC ECCR2 accumulates NAND bytes (${ecc1.toString(16)})`);
periph_write(NAND2, 1, 0xAB);                   // same bytes, same ECC?
periph_write(NAND2 + 1, 1, 0xCD);
assert(ecc1 !== periph_read(ECCR2, 4), 'FSMC ECCR2 accumulates (length-sensitive)');
periph_write(PCR2, 4, 0);                       // ECCEN off
periph_write(PCR2, 4, 1 << 6);                  // ECCEN on: fresh sector
assert_eq(periph_read(ECCR2, 4), 0, 'FSMC ECCR2 cleared on ECCEN re-arm');
periph_write(NAND2, 1, 0xAB);
periph_write(NAND2 + 1, 1, 0xCD);
assert_eq(periph_read(ECCR2, 4), ecc1, 'FSMC ECC deterministic for same bytes');
// Known answers: all-zero and all-0xFF sectors have zero parity everywhere.
periph_write(PCR2, 4, 0); periph_write(PCR2, 4, 1 << 6); // fresh
for (let i = 0; i < 64; i++) periph_write(NAND2 + i, 1, 0);
assert_eq(periph_read(ECCR2, 4), 0, 'FSMC ECC of zeros is 0');
periph_write(PCR2, 4, 0); periph_write(PCR2, 4, 1 << 6); // fresh
for (let i = 0; i < 64; i++) periph_write(NAND2 + i, 1, 0xFF);
assert_eq(periph_read(ECCR2, 4), 0, 'FSMC ECC of 0xFF is 0 (even counts)');
// Hamming proof: flipping bit 3 of byte 41 must produce syndrome
// 0x68005996 (row pairs for address bits 0..7 of 41 + cp1/cp3/cp4),
// decoding to (41,3). The session runs at ECCPS=0 (256B page), so row
// pairs above bit 15 stay structurally zero — short pages, short codes.
const secBytes = [];
for (let i = 0; i < 64; i++) secBytes.push((i * 7 + 1) & 0xFF);
periph_write(PCR2, 4, 0); periph_write(PCR2, 4, 1 << 6); // fresh
secBytes.forEach((b, i) => periph_write(NAND2 + i, 1, b));
const codeA = periph_read(ECCR2, 4) >>> 0;
periph_write(PCR2, 4, 0); periph_write(PCR2, 4, 1 << 6); // fresh
secBytes.forEach((b, i) => periph_write(NAND2 + i, 1, i === 41 ? b ^ 0x08 : b));
const codeB = periph_read(ECCR2, 4) >>> 0;
const syn = (codeA ^ codeB) >>> 0;
assert_eq(syn, 0x68005996, 'FSMC ECC syndrome locates bit3@byte41');
let loc = 0;
for (let j = 0; j < 6; j++) loc |= ((syn >> (2 * j + 1)) & 1) << j;
assert_eq(loc, 41, 'FSMC syndrome decodes byte 41');
assert_eq(syn & 0x03FF0000, 0, 'FSMC syndrome above 256B depth is zero');
const colSig = (syn >>> 26) & 0x3F;
const colBits = { 21: 0, 22: 1, 25: 2, 26: 3, 37: 4, 38: 5, 41: 6, 42: 7 };
assert_eq(colBits[colSig], 3, 'FSMC syndrome decodes bit 3');

// ============================================================
// Sleep state timing (STOP/STANDBY gating)
// ============================================================
group('Sleep');

reset();
const SCB_SCR = 0xE000ED10;
const TIM2S = 0x40000000;

periph_write(0x4002101C, 4, 1 << 0);            // TIM2EN
periph_write(TIM2S + 0x28, 4, 0);               // PSC = 0
periph_write(TIM2S + 0x2C, 4, 0xFFFF);          // ARR
periph_write(TIM2S + 0x00, 4, 1);               // CEN
for (let i = 0; i < 50; i++) tick();
assert_eq(periph_read(TIM2S + 0x24, 4), 50, 'TIM2 CNT = 50 while running');

// Enter STOP: SCR SLEEPDEEP, WFI handled by the core
periph_write(SCB_SCR, 4, 0x4);                  // SLEEPDEEP
for (let i = 0; i < 100; i++) tick();
assert_eq(periph_read(TIM2S + 0x24, 4), 50, 'TIM2 frozen in STOP');

// RTC (LSI/LSE clocked) keeps counting during STOP
periph_write(0x4002101C, 4, 0x200);             // RTCEN
periph_write(0x40002808, 4, 0);                 // PRLH
periph_write(0x4000280C, 4, 9);                 // PRLL: +1 per 10 instr
periph_write(0x4000281C, 4, 0);                 // CNTL = 0
for (let i = 0; i < 100; i++) tick();
const rtcCnt = periph_read(0x4000281C, 4);
assert(rtcCnt >= 8, `RTC keeps counting in STOP (CNT=${rtcCnt})`);

// Wake: clear SLEEPDEEP, timer resumes
periph_write(SCB_SCR, 4, 0x0);
for (let i = 0; i < 20; i++) tick();
assert_eq(periph_read(TIM2S + 0x24, 4), 70, 'TIM2 resumes after wake');

// IWDG keeps running through STOP while TIM freezes (LSI vs APB clock
// domains: System::tick keeps IWDG+RTC on tick(), the rest tick_frozen).
// Fuse: PR=0 (/4 -> 512 instr/tick), RLR=10, started + refreshed.
reset();
const IWDG_S = 0x40003000;
periph_write(0x4002101C, 4, 1 << 0);            // TIM2EN
periph_write(TIM2S + 0x28, 4, 0);               // PSC = 0
periph_write(TIM2S + 0x2C, 4, 0xFFFF);          // ARR
periph_write(TIM2S + 0x00, 4, 1);               // CEN
periph_write(IWDG_S + 0x00, 4, 0x5555);         // unlock
periph_write(IWDG_S + 0x04, 4, 0);              // PR=0 (/4)
periph_write(IWDG_S + 0x08, 4, 10);             // RLR=10
periph_write(IWDG_S + 0x00, 4, 0xCCCC);         // start
periph_write(IWDG_S + 0x00, 4, 0xAAAA);         // refresh (counter=10)
is_watchdog_reset_requested();                  // clear stale
periph_write(SCB_SCR, 4, 0x4);                  // SLEEPDEEP (STOP)
assert_eq(step_batch(6000), 1, 'IWDG fuse fires through STOP (watchdog stop status)');
assert_eq(is_watchdog_reset_requested(), false, 'STOP fuse flag consumed by step_batch status');
assert_eq(periph_read(TIM2S + 0x24, 4), 0, 'TIM2 frozen across the same STOP batch');

// ============================================================
// Fault exceptions (BusFault/HardFault escalation, SCB state)
// ============================================================
group('Faults');

reset();
const SCB_CFSR = 0xE000ED28;
const SCB_HFSR = 0xE000ED2C;
const SCB_BFAR = 0xE000ED38;

// Fault with BUSFAULTENA disabled -> escalate to HardFault
raise_fault(1, 0x40001234);                     // data read fault
assert_eq(get_next_pending_interrupt(), -13, 'Fault escalates to HardFault when BusFault disabled');
assert_eq(periph_read(SCB_HFSR, 4) >> 30 & 1, 1, 'HFSR FORCED set');
assert_eq(periph_read(SCB_CFSR, 4) & (1 << 15), 1 << 15, 'CFSR BFARVALID set');
assert_eq(periph_read(SCB_BFAR, 4), 0x40001234, 'BFAR holds faulting address');
clear_current_interrupt();

// With BUSFAULTENA enabled -> BusFault handler pends directly
periph_write(0xE000ED24, 4, 1 << 18);           // SHCSR BUSFAULTENA
raise_fault(1, 0x5000ABCD);
assert_eq(get_next_pending_interrupt(), -11, 'BusFault pends when BUSFAULTENA set');
assert_eq(periph_read(SCB_CFSR, 4) & (1 << 9), 1 << 9, 'CFSR PRECISERR set');
assert_eq(periph_read(SCB_BFAR, 4), 0x5000ABCD, 'BFAR updated');
clear_current_interrupt();

// Fetch fault -> IBUSERR
raise_fault(0, 0);
assert_eq(periph_read(SCB_CFSR, 4) & (1 << 8), 1 << 8, 'CFSR IBUSERR set');

// SysTick priority is programmable via SCB SHPR
periph_write(0xE000ED20, 4, 0xFF00FF00);        // SHPR3: SysTick=0, PendSV=0xFF, SVCall=0
assert_eq(periph_read(0xE000ED20, 4) & 0xFF, 0, 'SHPR3 SVCall prio routed through SCB');

// ============================================================
// JS-registered peripheral (rp2040js-style custom chip)
// ============================================================
group('JS Peripheral');

reset();
const JS_BASE = 0x40008000; // gap between DAC and AFIO on F103 — 4-aligned
// (was 0x40006800 until CAN2 joined the builtin map)
let jsWrites = [];
let jsReads = 0;
const regOk = register_js_peripheral(JS_BASE, 0x400,
  (addr, size) => { jsReads++; return addr === JS_BASE ? 0x42 : 0; },
  (addr, value, size) => { jsWrites.push([addr, value, size]); });
assert_eq(regOk, true, 'register_js_peripheral after init returns true');

// read callback fires with the absolute address + size
assert_eq(periph_read(JS_BASE, 4), 0x42, 'JS peripheral read callback value');
assert_eq(jsReads, 1, 'JS peripheral read callback fired');

// write callback fires with (addr, value, size)
periph_write(JS_BASE + 4, 4, 0xDEADBEEF);
assert_eq(jsWrites.length, 1, 'JS peripheral write callback fired');
assert_eq(jsWrites[0][0], JS_BASE + 4, 'JS peripheral write addr absolute');
assert_eq(jsWrites[0][1], 0xDEADBEEF, 'JS peripheral write value');
assert_eq(jsWrites[0][2], 4, 'JS peripheral write size');

// shadow a built-in: register over USART1 and confirm last-wins
register_js_peripheral(0x40013800, 0x400, () => 0x77, () => {});
assert_eq(periph_read(0x40013800, 4), 0x77, 'JS peripheral shadows built-in USART1');

// re-init drops JS peripherals (fresh bus per init)
reset();
assert_eq(periph_read(JS_BASE, 4), 0, 'JS peripheral gone after re-init');

// ============================================================
// Second chip: STM32F105 (connectivity line) from SVD
// ============================================================
group('Chip: STM32F105 (SVD)');

{
  const { readFileSync } = await import('fs');
  const svd = readFileSync(new URL('../svd/STM32F105xx.svd', import.meta.url), 'utf8');
  init_svd(svd);

  // CAN2 (0x40006800) — SVD path registers it (also on the builtin map now)
  periph_write(0x40006800, 4, 0x00000041); // INRQ + ABOM(6) + TTCM(7)? ABOM is bit 6 on F1 bxCAN
  const can2mcr = periph_read(0x40006800, 4);
  assert_eq(can2mcr & 1, 1, 'F105 CAN2 MCR INRQ bit set');
  assert_eq(can2mcr & (1 << 6), 1 << 6, 'F105 CAN2 MCR ABOM bit set');

  // DMA1 at the real 0x40020000 (SVD map)
  periph_write(0x4002000C, 4, 42);
  assert_eq(periph_read(0x4002000C, 4), 42, 'F105 DMA1 CNDTR at 0x40020000');

  // CAN1 still at its F1 address
  periph_write(0x4000641C, 4, 0x001C0033);
  assert_eq(periph_read(0x4000641C, 4), 0x001C0033, 'F105 CAN1 BTR');

  // Unsupported peripherals in the SVD (ETH) are skipped, not fatal
  assert_eq(periph_read(0x40028000, 4), 0, 'F105 ETH (0x40028000) not mapped (skipped)');

  // Shared CAN filter bank (silicon layout): CAN2 owns no filter
  // registers — reads return 0, writes are ignored.
  assert_eq(periph_read(0x40006800 + 0x21C, 4), 0, 'CAN2 FA1R reads 0 (no filter regs)');
  periph_write(0x40006800 + 0x21C, 4, 1);
  assert_eq(periph_read(0x40006800 + 0x21C, 4), 0, 'CAN2 FA1R write ignored');
  assert_eq(periph_read(0x40006800 + 0x240, 4), 0, 'CAN2 F0R0 reads 0');
  // CAN1 bank 0 does NOT serve CAN2 (CAN2 owns banks [CAN2SB=14..28))
  periph_write(0x40006400 + 0x200, 4, 1); // FINIT
  periph_write(0x40006400 + 0x204, 4, 0); // 16-bit
  periph_write(0x40006400 + 0x20C, 4, 0xFFFFFFFF); // list
  periph_write(0x40006400 + 0x240, 4, (0x555 << 16) | 0x555);
  periph_write(0x40006400 + 0x244, 4, (0x555 << 16) | 0x555);
  periph_write(0x40006400 + 0x21C, 4, 1); // enable bank 0
  periph_write(0x40006400 + 0x200, 4, (14 << 8)); // exit init, CAN2SB=14
  assert_eq(can_inject_message(0x40006800, ((0x555 << 21) | 1) >>> 0, 8, 0xDEADBEEF, 0), false, 'CAN2 rejects: bank 0 belongs to CAN1');
  // Bank 14 accept-all (16-bit mask, ID=0 mask=0) serves CAN2 via CAN1's window
  periph_write(0x40006400 + 0x200, 4, 1); // FINIT (resets modes)
  periph_write(0x40006400 + 0x20C, 4, 0xFFFFFFFF & ~(1 << 14)); // bank 14 mask mode
  periph_write(0x40006400 + 0x240 + 14 * 8, 4, 0); // F0R14 ID=0
  periph_write(0x40006400 + 0x244 + 14 * 8, 4, 0); // F1R14 mask=0
  periph_write(0x40006400 + 0x21C, 4, 1 << 14); // enable bank 14
  periph_write(0x40006400 + 0x200, 4, (14 << 8)); // exit init, CAN2SB=14
  assert_eq(can_inject_message(0x40006800, ((0x123 << 21) | 1) >>> 0, 8, 0xDEADBEEF, 0), true, 'CAN2 matches via shared bank 14');
  assert_eq(periph_read(0x40006800 + 0x0C, 4) & 0x3, 1, 'CAN2 RF0R FMP=1 after shared match');
}

// ============================================================
// SDIO host + SD card image (CMD engine, FIFO, IRQ49, DMA2 CH4)
// ============================================================
group('SDIO');

const SDIO = 0x40018000;
const S_POWER = 0x00, S_CLKCR = 0x04, S_ARG = 0x08, S_CMD = 0x0C;
const S_RESPCMD = 0x10, S_RESP1 = 0x14, S_DLEN = 0x28, S_DCTRL = 0x2C;
const S_STA = 0x34, S_ICR = 0x38, S_MASK = 0x3C, S_FIFO = 0x80;
const F_CMDREND = 1 << 6, F_CMDSENT = 1 << 7, F_DATAEND = 1 << 8;
const F_DBCKEND = 1 << 10, F_CTIMEOUT = 1 << 2;
const CPSMEN = 1 << 10, WR_SHORT = 1 << 6, WR_LONG = 3 << 6;
// SVD path: STM32F103.svd lists SDIO @ 0x40018000 — auto-registers, no overlap panic
{
  const { readFileSync } = await import('fs');
  const svd103 = readFileSync(new URL('../svd/STM32F103.svd', import.meta.url), 'utf8');
  init_svd(svd103);
  assert_eq(periph_read(SDIO + S_POWER, 4), 0, 'F103 SVD: SDIO POWER reset 0');
}
// 2048 sectors (1 MiB): CSD C_SIZE = 1; marker pattern per sector.
const sdImg = new Uint8Array(2048 * 512);
for (let i = 0; i < sdImg.length; i++) sdImg[i] = (i >> 9) & 0xFF;
add_sd_card('SDIO', sdImg);
reset();
const sdCmd = (idx, arg, rsp = WR_SHORT) => {
    periph_write(SDIO + S_ARG, 4, arg);
    periph_write(SDIO + S_CMD, 4, (idx & 0x3F) | rsp | CPSMEN);
};

// Register defaults
assert_eq(periph_read(SDIO + S_POWER, 4), 0, 'SDIO POWER reset 0');
assert_eq(periph_read(SDIO + S_STA, 4) & (1 << 19), 1 << 19, 'SDIO RXFIFOE set when idle');
assert_eq(periph_read(SDIO + S_STA, 4) & (1 << 18), 1 << 18, 'SDIO TXFIFOE set when idle');

// POWER + clock
periph_write(SDIO + S_POWER, 4, 0x03);
assert_eq(periph_read(SDIO + S_POWER, 4), 0x03, 'SDIO POWER PWRCTRL=on');
periph_write(SDIO + S_CLKCR, 4, 0x100 | 0x76);
assert_eq(periph_read(SDIO + S_CLKCR, 4), 0x176, 'SDIO CLKCR readback');

// CMD0: no response -> CMDSENT
sdCmd(0, 0, 0);
assert_eq(periph_read(SDIO + S_STA, 4) & F_CMDSENT, F_CMDSENT, 'SDIO CMD0 sets CMDSENT');
assert_eq(periph_read(SDIO + S_RESPCMD, 4), 0, 'SDIO RESPCMD=0');
periph_write(SDIO + S_ICR, 4, 0xFFFFFFFF);
assert_eq(periph_read(SDIO + S_STA, 4) & (F_CMDSENT | F_CMDREND), 0, 'SDIO ICR clears flags');

// CMD8: R7 echoes the argument
sdCmd(8, 0x1AA);
assert_eq(periph_read(SDIO + S_RESP1, 4), 0x1AA, 'SDIO CMD8 R7 echo');
assert_eq(periph_read(SDIO + S_STA, 4) & F_CMDREND, F_CMDREND, 'SDIO CMDREND set');
periph_write(SDIO + S_ICR, 4, 0xFFFFFFFF);

// ACMD41 init: busy for the first polls, then OCR ready + CCS (SDHC)
let ocr = 0;
for (let i = 0; i < 10 && !(ocr & 0x80000000); i++) {
    sdCmd(55, 0);
    assert_eq(periph_read(SDIO + S_RESP1, 4) & 0x20, 0x20, 'SDIO CMD55 R1 APP_CMD bit');
    sdCmd(41, 1 << 30);
    ocr = periph_read(SDIO + S_RESP1, 4);
}
assert((ocr >>> 31) === 1, 'SDIO ACMD41 OCR ready bit sets');
assert(((ocr >>> 30) & 1) === 1, 'SDIO ACMD41 CCS=1 (SDHC)');
periph_write(SDIO + S_ICR, 4, 0xFFFFFFFF);

// CMD2 CID / CMD3 RCA / CMD9 CSD / CMD7 select / CMD16 blocklen
sdCmd(2, 0, WR_LONG);
assert_neq(periph_read(SDIO + S_RESP1, 4), 0, 'SDIO CMD2 CID non-zero');
sdCmd(3, 0);
assert_eq(periph_read(SDIO + S_RESP1, 4) >>> 16, 0x1234, 'SDIO CMD3 R6 RCA');
sdCmd(7, 0x12340000);
assert_eq(periph_read(SDIO + S_RESP1, 4), 0x900, 'SDIO CMD7 R1 ready/tran');
sdCmd(9, 0x12340000, WR_LONG);
assert_eq(periph_read(SDIO + S_RESP1, 4) >>> 30, 1, 'SDIO CMD9 CSD v2.0 structure');
assert_eq(periph_read(SDIO + 0x18, 4) & 0x3F, 0, 'SDIO CMD9 CSD C_SIZE lo for 2048 sectors');
assert_eq(periph_read(SDIO + 0x1C, 4) >>> 16, 1, 'SDIO CMD9 CSD C_SIZE hi for 2048 sectors');
sdCmd(16, 512);
assert_eq(periph_read(SDIO + S_RESP1, 4), 0x900, 'SDIO CMD16 R1');
periph_write(SDIO + S_ICR, 4, 0xFFFFFFFF);

// CMD17 polled single-block read (block 3 = fill byte 3)
periph_write(SDIO + S_DLEN, 4, 512);
periph_write(SDIO + S_DCTRL, 4, 0x1); // DTEN
sdCmd(17, 3);
assert_eq(periph_read(SDIO + S_STA, 4) & F_CMDREND, F_CMDREND, 'SDIO CMD17 CMDREND');
assert_eq(periph_read(SDIO + S_STA, 4) & F_DATAEND, 0, 'SDIO DATAEND not set before drain');
assert_eq(periph_read(SDIO + 0x30, 4), 512, 'SDIO DCOUNT=512 at transfer start');
let word0 = periph_read(SDIO + S_FIFO, 4);
assert_eq(word0, 0x03030303, 'SDIO FIFO first word of block 3');
for (let i = 1; i < 128; i++) {
    const w = periph_read(SDIO + S_FIFO, 4);
    if (w !== 0x03030303) { assert_eq(w, 0x03030303, `SDIO FIFO word ${i} of block 3`); break; }
}
assert_eq(periph_read(SDIO + S_STA, 4) & (F_DATAEND | F_DBCKEND), F_DATAEND | F_DBCKEND, 'SDIO DATAEND+DBCKEND after drain');
assert_eq(periph_read(SDIO + 0x30, 4), 0, 'SDIO DCOUNT=0 after drain');
assert_eq(periph_read(SDIO + S_STA, 4) & (1 << 19), 1 << 19, 'SDIO RXFIFOE after drain');
periph_write(SDIO + S_ICR, 4, 0xFFFFFFFF);

// CMD24 polled write + read-back verify (block 5)
const pat = new Uint32Array(128);
for (let i = 0; i < 128; i++) pat[i] = (0xA5000000 + i) >>> 0;
periph_write(SDIO + S_DLEN, 4, 512);
periph_write(SDIO + S_DCTRL, 4, 0x3); // DTEN + DTDIR(write)
sdCmd(24, 5);
for (let i = 0; i < 128; i++) periph_write(SDIO + S_FIFO, 4, pat[i]);
assert_eq(periph_read(SDIO + S_STA, 4) & (F_DATAEND | F_DBCKEND), F_DATAEND | F_DBCKEND, 'SDIO CMD24 DATAEND after fill');
periph_write(SDIO + S_ICR, 4, 0xFFFFFFFF);
periph_write(SDIO + S_DCTRL, 4, 0x1); // back to read
sdCmd(17, 5);
for (let i = 0; i < 128; i++) {
    const w = periph_read(SDIO + S_FIFO, 4);
    if (w !== pat[i]) { assert_eq(w, pat[i], `SDIO block 5 read-back word ${i}`); break; }
}
assert_eq(periph_read(SDIO + S_STA, 4) & F_DATAEND, F_DATAEND, 'SDIO read-back DATAEND');
periph_write(SDIO + S_ICR, 4, 0xFFFFFFFF);

// IRQ49: mask CMDREND + NVIC ISER1 bit 17, CMD13 fires it
periph_write(0xE000E104, 4, 1 << 17); // ISER1: enable IRQ 49
periph_write(SDIO + S_MASK, 4, F_CMDREND);
sdCmd(13, 0x12340000);
assert(has_pending_interrupt() && get_next_pending_interrupt() === 49,
    'SDIO CMDREND pends IRQ 49 when masked+enabled');
clear_current_interrupt();
periph_write(SDIO + S_ICR, 4, 0xFFFFFFFF);
periph_write(SDIO + S_MASK, 4, 0);

// DMA RX via DMA2 CH4: program channel, CMD17 + DMAEN, pump absorbs image bytes
const DMA2 = 0x40020400, CH4 = 0x08 + 3 * 0x14;
periph_write(DMA2 + CH4, 4, (2 << 10) | (2 << 8) | (1 << 7) | 0); // MSIZE/PSIZE=32b, MINC, EN=0
periph_write(DMA2 + CH4 + 2 * 4, 4, SDIO + S_FIFO); // CPAR = FIFO
periph_write(DMA2 + CH4 + 3 * 4, 4, 0x20000000);    // CMAR (plan only, no CPU involved)
periph_write(DMA2 + CH4 + 1 * 4, 4, 128);          // CNDTR = 128 words
periph_write(DMA2 + CH4, 4, (2 << 10) | (2 << 8) | (1 << 7) | 1); // EN (DIR=0: periph->mem)
periph_write(SDIO + S_DLEN, 4, 512);
periph_write(SDIO + S_DCTRL, 4, 0x9); // DTEN + DMAEN
sdCmd(17, 7);
step_batch(1); // DMA2 tick queues the transfer
assert_eq(periph.dma_get_pending_count() >= 1, true, 'SDIO DMA RX queues a transfer');
// The pump plan must absorb 512 B from the FIFO (op 1), served from block 7.
const plan = periph.dma_pump_all();
let absorb = null;
for (let i = 0; i + 4 <= plan.length; i += 4) {
    if (plan[i] === 1 && plan[i + 2] === 512) absorb = [plan[i + 1], plan[i + 3]];
}
assert_eq(absorb !== null, true, 'SDIO DMA pump plan absorbs 512 B');
const taken = new Uint8Array(periph.dma_take_absorbed(absorb[1], 512));
let dmaOk = taken.length === 512;
for (let i = 0; i < 512 && dmaOk; i++) if (taken[i] !== 7) dmaOk = false;
assert_eq(dmaOk, true, 'SDIO DMA absorbed bytes are block 7 fill');
periph.dma_set_completed_many(1 << 10); // global stream 10 = DMA2 CH4
step_batch(1);
assert_eq(periph_read(DMA2 + 0x00, 4) & (1 << 13), 1 << 13, 'SDIO DMA2 ISR TCIF4 after completion');
assert_eq(periph_read(DMA2 + CH4 + 1 * 4, 4), 0, 'SDIO DMA2 CH4 CNDTR=0 after completion');

// No card attached: CMD8 times out, CMD0 still sends
reset_ext_devices();
reset();
sdCmd(8, 0x1AA);
assert_eq(periph_read(SDIO + S_STA, 4) & F_CTIMEOUT, F_CTIMEOUT, 'SDIO no-card CMD8 CTIMEOUT');
assert_eq(periph_read(SDIO + S_RESP1, 4), 0, 'SDIO no-card CMD8 no response');
sdCmd(0, 0, 0);
assert_eq(periph_read(SDIO + S_STA, 4) & F_CMDSENT, F_CMDSENT, 'SDIO no-card CMD0 CMDSENT');

// ============================================================
// SDIO MMC mode: CMD1 identification, EXT_CSD, erase commands
// ============================================================
group('SDIO MMC');

const mmcImg = new Uint8Array(2048 * 512);
for (let i = 0; i < mmcImg.length; i++) mmcImg[i] = i & 0xFF;
add_sd_card('SDIO', mmcImg);
reset();

// CMD8 before any OP_COND keeps SD probe order (R7 echo)
sdCmd(8, 0x1AA);
assert_eq(periph_read(SDIO + S_RESP1, 4), 0x1AA, 'MMC CMD8 pre-init echoes (SD probe order)');
periph_write(SDIO + S_ICR, 4, 0xFFFFFFFF);

// CMD1 needs no APP latch: busy first polls, then R3 ready + sector mode
let mocr = 0;
for (let i = 0; i < 10 && !((mocr >>> 31) === 1); i++) {
    sdCmd(1, 0x40FF8000);
    mocr = periph_read(SDIO + S_RESP1, 4);
}
assert_eq((mocr >>> 31), 1, 'MMC CMD1 OCR ready bit sets');
assert_eq((mocr >>> 30) & 1, 1, 'MMC CMD1 sector access mode bit');
periph_write(SDIO + S_ICR, 4, 0xFFFFFFFF);

// CMD8 after MMC init -> EXT_CSD register read (512 B)
periph_write(SDIO + S_DLEN, 4, 512);
periph_write(SDIO + S_DCTRL, 4, 0x1); // DTEN
sdCmd(8, 0);
assert_eq(periph_read(SDIO + S_STA, 4) & F_CMDREND, F_CMDREND, 'MMC CMD8 CMDREND');
const ext = [];
for (let i = 0; i < 128; i++) {
    const w = periph_read(SDIO + S_FIFO, 4) >>> 0;
    ext.push(w & 0xFF, (w >>> 8) & 0xFF, (w >>> 16) & 0xFF, (w >>> 24) & 0xFF);
}
assert_eq(ext.length, 512, 'MMC EXT_CSD 512 bytes drained');
assert_eq(ext[192], 8, 'MMC EXT_CSD_REV');
assert_eq(ext[196], 3, 'MMC EXT_CSD CARD_TYPE');
assert_eq(ext[212] | (ext[213] << 8) | (ext[214] << 16) | (ext[215] << 24), 2048, 'MMC EXT_CSD SEC_COUNT');
assert_eq(periph_read(SDIO + S_STA, 4) & (F_DATAEND | F_DBCKEND), F_DATAEND | F_DBCKEND, 'MMC EXT_CSD DATAEND');
periph_write(SDIO + S_ICR, 4, 0xFFFFFFFF);

// Shared path after MMC init: CID/RCA/block read
sdCmd(2, 0, WR_LONG);
assert_neq(periph_read(SDIO + S_RESP1, 4), 0, 'MMC CMD2 CID non-zero');
sdCmd(3, 0);
assert_eq(periph_read(SDIO + S_RESP1, 4) >>> 16, 0x1234, 'MMC CMD3 R6 RCA');
sdCmd(17, 9);
assert_eq(periph_read(SDIO + S_FIFO, 4) >>> 0, 0x03020100, 'MMC CMD17 first word of block 9');
for (let i = 1; i < 128; i++) periph_read(SDIO + S_FIFO, 4);
periph_write(SDIO + S_ICR, 4, 0xFFFFFFFF);

// Erase CMD32/33/38: blocks read back as erased (0xFF)
sdCmd(32, 10);
assert_eq(periph_read(SDIO + S_RESP1, 4), 0x900, 'MMC CMD32 R1');
sdCmd(33, 11);
assert_eq(periph_read(SDIO + S_RESP1, 4), 0x900, 'MMC CMD33 R1');
sdCmd(38, 0);
assert_eq(periph_read(SDIO + S_RESP1, 4), 0x900, 'MMC CMD38 R1');
sdCmd(17, 10);
assert_eq(periph_read(SDIO + S_FIFO, 4) >>> 0, 0xFFFFFFFF, 'MMC erased block reads 0xFF');
for (let i = 1; i < 128; i++) periph_read(SDIO + S_FIFO, 4);
assert_eq(periph_read(SDIO + S_STA, 4) & F_DATAEND, F_DATAEND, 'MMC DATAEND after erased read');
periph_write(SDIO + S_ICR, 4, 0xFFFFFFFF);

// No card: CMD1 times out like any response command
reset_ext_devices();
reset();
sdCmd(1, 0x40FF8000);
assert_eq(periph_read(SDIO + S_STA, 4) & F_CTIMEOUT, F_CTIMEOUT, 'MMC no-card CMD1 CTIMEOUT');

// ============================================================
// Summary
// ============================================================
// WWDG early-wakeup interrupt (EWI -> IRQ0 at counter 0x40)
// ============================================================
group('WWDG EWI');

reset();
const WWDG_BASE = 0x40002C00;
periph_write(0xE000E100, 4, 1 << 0); // ISER0: enable IRQ 0
periph_write(WWDG_BASE + 0x04, 4, (1 << 9) | 0x7F); // CFR: EWI + WDGTB=div1 + W=max
periph_write(WWDG_BASE + 0x00, 4, 0xFF);           // CR: WDGA + T=0x7F
step_batch(20000); // 256 instr/tick: 0x7F -> below 0x40
assert_eq(periph_read(WWDG_BASE + 0x08, 4) & 1, 1, 'WWDG EWIF set at 0x40 crossing');
assert(has_pending_interrupt() && get_next_pending_interrupt() === 0,
    'WWDG EWI pends IRQ 0');
clear_current_interrupt();
periph_write(WWDG_BASE + 0x08, 4, 1); // write-1-clears EWIF
assert_eq(periph_read(WWDG_BASE + 0x08, 4) & 1, 0, 'WWDG EWIF cleared');

// EWI masked: flag sets, no IRQ
reset();
periph_write(WWDG_BASE + 0x04, 4, 0x7F); // CFR: no EWI
periph_write(WWDG_BASE + 0x00, 4, 0xFF);
step_batch(20000);
assert_eq(periph_read(WWDG_BASE + 0x08, 4) & 1, 1, 'WWDG EWIF sets without EWI');
assert_eq(has_pending_interrupt(), false, 'WWDG no IRQ without EWI enable');

// Window rule: CR refresh with T > W (WDGA set, W != 0) requests reset
// immediately (silicon: early refresh = reset). In-window, WDGA-off and
// W=0-disabled refreshes must NOT reset.
reset();
periph_write(WWDG_BASE + 0x04, 4, 0x50); // CFR: W=0x50
periph_write(WWDG_BASE + 0x00, 4, 0xFF); // CR: WDGA + T=0x7F
is_watchdog_reset_requested(); drain_events();
periph_write(WWDG_BASE + 0x00, 4, 0xFF); // refresh T=0x7F > W=0x50
assert_eq(is_watchdog_reset_requested(), true, 'WWDG early refresh (T>W) requests reset');
{ let wdog = false; for (const e of drain_events()) { if (e === 13) { wdog = true; break; } }
  assert(wdog, 'WWDG early refresh pushes WdogReset{2}'); }
reset();
periph_write(WWDG_BASE + 0x04, 4, 0x50); // CFR: W=0x50
periph_write(WWDG_BASE + 0x00, 4, 0xC0); // CR: WDGA + T=0x40 (in window)
is_watchdog_reset_requested(); drain_events();
periph_write(WWDG_BASE + 0x00, 4, 0xC0); // refresh T=0x40 <= W: legal
assert_eq(is_watchdog_reset_requested(), false, 'WWDG in-window refresh does not reset');
reset();
periph_write(WWDG_BASE + 0x04, 4, 0x50);
periph_write(WWDG_BASE + 0x00, 4, 0x7F); // WDGA=0: watchdog off
is_watchdog_reset_requested();
periph_write(WWDG_BASE + 0x00, 4, 0x7F);
assert_eq(is_watchdog_reset_requested(), false, 'WWDG early refresh with WDGA off does not reset');
reset();
periph_write(WWDG_BASE + 0x04, 4, 0x00); // CFR: W=0 (window disabled)
periph_write(WWDG_BASE + 0x00, 4, 0xFF);
is_watchdog_reset_requested();
periph_write(WWDG_BASE + 0x00, 4, 0xFF);
assert_eq(is_watchdog_reset_requested(), false, 'WWDG refresh with W=0 does not reset');

// ============================================================
// PVD voltage detector (PLS thresholds vs supply -> EXTI line 16)
// ============================================================
group('PVD');

reset();
const PWR_BASE = 0x40007000;
periph_write(0x40010400, 4, 1 << 16); // EXTI IMR line 16
periph_write(0x40010408, 4, 1 << 16); // EXTI RTSR line 16
periph_write(0xE000E100, 4, 1 << 1);  // ISER0: enable IRQ 1 (PVD)
assert_eq(periph_read(PWR_BASE + 0x04, 4) & 0x4, 0, 'PVD PVDO=0 with PVDE off');
// Silicon truth: the default 3.3 V supply sits above every PLS threshold,
// so enabling PVDE asserts nothing (no brownout, no edge).
periph_write(PWR_BASE + 0x00, 4, 1 << 4);  // CR: PVDE on
assert_eq(periph_read(PWR_BASE + 0x04, 4) & 0x4, 0, 'PVD PVDO=0 with PVDE on at 3.3V');
assert_eq(has_pending_interrupt(), false, 'PVD no IRQ when supply above threshold');
// Brownout: drop below the reset PLS threshold (CR reset 0x20 -> PLS=001 = 2.3V).
assert_eq(pwr_set_supply_mv(2000), true, 'PVD supply API reports PVDO=1 below threshold');
assert_eq(periph_read(PWR_BASE + 0x04, 4) & 0x4, 0x4, 'PVD PVDO=1 in brownout');
assert(has_pending_interrupt() && get_next_pending_interrupt() === 1,
    'PVD rising edge pends IRQ 1');
clear_current_interrupt();
// PVDO is read-only: writes cannot force it
periph_write(PWR_BASE + 0x04, 4, 0);
assert_eq(periph_read(PWR_BASE + 0x04, 4) & 0x4, 0x4, 'PVD PVDO read-only, write ignored');
// Recovery: raise above threshold -> falling edge (FTSR armed)
periph_write(0x40010408, 4, 0);             // RTSR clear
periph_write(0x4001040C, 4, 1 << 16);       // EXTI FTSR line 16
assert_eq(pwr_set_supply_mv(3300), false, 'PVD supply API reports PVDO=0 on recovery');
assert_eq(periph_read(PWR_BASE + 0x04, 4) & 0x4, 0, 'PVD PVDO=0 after recovery');
assert(has_pending_interrupt() && get_next_pending_interrupt() === 1,
    'PVD falling edge pends IRQ 1');
clear_current_interrupt();
// PLS select: threshold 2.9 V (111); 2.8 V trips, 2.95 V clears.
periph_write(PWR_BASE + 0x00, 4, (1 << 4) | (7 << 5)); // PVDE + PLS=7
assert_eq(pwr_set_supply_mv(2800), true, 'PVD PLS=7 trips at 2.8V');
assert_eq(pwr_set_supply_mv(2950), false, 'PVD PLS=7 clears at 2.95V');
assert(has_pending_interrupt() && get_next_pending_interrupt() === 1,
    'PVD PLS falling edge pends IRQ 1');
clear_current_interrupt();
// PVDE off while already clear: silent.
periph_write(PWR_BASE + 0x00, 4, 0);
assert_eq(periph_read(PWR_BASE + 0x04, 4) & 0x4, 0, 'PVD PVDO=0 after PVDE off');
assert_eq(has_pending_interrupt(), false, 'PVD no IRQ when already clear');

// ============================================================
// RCC clock tree decode (CFGR -> SYSCLK; HSE assumed 8 MHz)
// ============================================================
group('RCC clocks');

reset();
const RCC_CLK = 0x40021000;
assert_eq(rcc_sysclk_hz(), 8000000, 'RCC default SW=HSI -> 8 MHz');
// PLL x9 from HSE, switched to PLL: 8M * 9 = 72M
periph_write(RCC_CLK + 0x04, 4, (1 << 16) | (7 << 18) | 2);
assert_eq((periph_read(RCC_CLK + 0x04, 4) >> 2) & 0x3, 2, 'RCC SWS echoes SW=PLL');
assert_eq(rcc_sysclk_hz(), 72000000, 'RCC PLL HSE x9 -> 72 MHz');
// PLL x9 from HSI/2: 4M * 9 = 36M
periph_write(RCC_CLK + 0x04, 4, (7 << 18) | 2);
assert_eq(rcc_sysclk_hz(), 36000000, 'RCC PLL HSI/2 x9 -> 36 MHz');
// HSE direct
periph_write(RCC_CLK + 0x04, 4, 1);
assert_eq(rcc_sysclk_hz(), 8000000, 'RCC SW=HSE -> 8 MHz');

// Full-tree audit via rcc_clocks_hz (HSE assumed 8 MHz): prescalers +
// multiplier edges. CFGR layout: SW[1:0] SWS[3:2] HPRE[7:4] PPRE1[10:8]
// PPRE2[13:11] PLLSRC[16] PLLXTPRE[17] PLLMUL[21:18].
const clocks = () => Array.from(rcc_clocks_hz()).join(',');
assert_eq(clocks(), '8000000,8000000,8000000,8000000', 'RCC default tree all 8 MHz');
// PLL HSE x9 + HPRE/2 + PPRE1/2 + PPRE2/4: 72/36/18/9 MHz
periph_write(RCC_CLK + 0x04, 4, (1 << 16) | (7 << 18) | 2 | (8 << 4) | (4 << 8) | (5 << 11));
assert_eq(clocks(), '72000000,36000000,18000000,9000000', 'RCC prescaled tree 72/36/18/9');
// Multiplier edges: x2 min (HSE), x16 max (bits 14/15 clamp)
periph_write(RCC_CLK + 0x04, 4, (1 << 16) | (0 << 18) | 2);
assert_eq(clocks().split(',')[0], '16000000', 'RCC PLL x2 min -> 16 MHz');
periph_write(RCC_CLK + 0x04, 4, (1 << 16) | (15 << 18) | 2);
assert_eq(clocks().split(',')[0], '128000000', 'RCC PLL x16 max -> 128 MHz');
// HSE/2 source (PLLXTPRE): 4M x9 = 36M
periph_write(RCC_CLK + 0x04, 4, (1 << 16) | (1 << 17) | (7 << 18) | 2);
assert_eq(clocks().split(',')[0], '36000000', 'RCC PLL HSE/2 x9 -> 36 MHz');
// Max dividers: HPRE/512 + PPRE/16 both buses (72M sys)
periph_write(RCC_CLK + 0x04, 4, (1 << 16) | (7 << 18) | 2 | (15 << 4) | (7 << 8) | (7 << 11));
assert_eq(clocks(), '72000000,140625,8789,8789', 'RCC max dividers 72M/140625/8789');

// ============================================================
// Tamper pin (PC13 -> BKP, IRQ2, backup regs cleared)
// ============================================================
group('Tamper');

reset();
const BKP = 0x40006C00;
periph_write(0xE000E100, 4, 1 << 2); // ISER0: enable IRQ 2 (TAMPER)
periph_write(BKP + 0x04, 4, 0x1234); // DR1 sentinel
periph_write(BKP + 0x30, 4, 0x1);    // CR: TPE, TPAL=0 (active high)
gpio_set_input(2, 13, false);        // PC13 low: no edge, no event
assert_eq(periph_read(BKP + 0x34, 4) & 0x300, 0, 'Tamper: no flags while idle');
gpio_set_input(2, 13, true);         // rising -> tamper event
assert_eq(periph_read(BKP + 0x34, 4) & 0x300, 0x300, 'Tamper: TIF+TEF set');
assert_eq(periph_read(BKP + 0x04, 4), 0, 'Tamper: backup registers cleared');
assert(has_pending_interrupt() && get_next_pending_interrupt() === 2,
    'Tamper pends IRQ 2');
clear_current_interrupt();
periph_write(BKP + 0x34, 4, 0x3);    // CTEF + CTI
assert_eq(periph_read(BKP + 0x34, 4) & 0x300, 0, 'Tamper: flags cleared by CTEF/CTI');
// TPAL=1 (active low): rising is silent, falling fires
periph_write(BKP + 0x30, 4, 0x3);    // TPE + TPAL
gpio_set_input(2, 13, false);        // falling -> event
assert_eq(periph_read(BKP + 0x34, 4) & 0x300, 0x300, 'Tamper: TPAL=1 fires on falling');
periph_write(BKP + 0x34, 4, 0x3);
gpio_set_input(2, 13, true);         // rising with TPAL=1: silent
assert_eq(periph_read(BKP + 0x34, 4) & 0x300, 0, 'Tamper: TPAL=1 silent on rising');
// TPE off: silent both ways
periph_write(BKP + 0x30, 4, 0);
gpio_set_input(2, 13, false);
gpio_set_input(2, 13, true);
assert_eq(periph_read(BKP + 0x34, 4) & 0x300, 0, 'Tamper: silent with TPE off');

// ============================================================
// USB FS device (endpoint toggle semantics, RESET, control + bulk)
// ============================================================
group('USB');

reset();
const USB = 0x40005C00;
const U_EP0 = 0x00, U_CNTR = 0x40, U_ISTR = 0x44, U_DADDR = 0x4C, U_BTABLE = 0x50;
const U_PMA = 0x40006000;
const I_RESET = 1 << 10, I_CTR = 1 << 15, I_DIR = 1 << 4;
const C_RESETM = 1 << 10, C_CTRM = 1 << 15;

// Reset defaults: endpoints zero, CNTR FRES|PDWN
assert_eq(periph_read(USB + U_EP0, 4), 0, 'USB EP0R reset 0');
assert_eq(periph_read(USB + U_CNTR, 4), 3, 'USB CNTR reset FRES|PDWN');

// FRES release is NOT a bus reset (ISTR RESET means SE0 on the wire, sent
// only by the host): attach raises no event and pends nothing.
periph_write(0xE000E100, 4, (1 << 20) | (1 << 19)); // ISER0: USB LP + HP IRQs
periph_write(USB + U_CNTR, 4, C_RESETM);
assert_eq(periph_read(USB + U_ISTR, 4) & I_RESET, 0, 'USB no RESET on FRES release');
assert(!has_pending_interrupt(), 'USB no IRQ on FRES release');
// Explicit host bus reset raises RESET + IRQ20 (RESETM)
assert_eq(usb_bus_reset(), true, 'USB bus reset accepted');
assert_eq(periph_read(USB + U_ISTR, 4) & I_RESET, I_RESET, 'USB RESET flag on bus reset');
assert(has_pending_interrupt() && get_next_pending_interrupt() === 20,
    'USB RESET pends IRQ 20');
clear_current_interrupt();
periph_write(USB + U_ISTR, 4, 0xFFFFFFFF & ~I_RESET);
assert_eq(periph_read(USB + U_ISTR, 4) & I_RESET, 0, 'USB ISTR write-0 clears RESET');
assert_eq(periph_read(USB + U_EP0, 4), 0, 'USB EP0R cleared by reset');
assert_eq(periph_read(USB + U_DADDR, 4), 0, 'USB DADDR cleared by reset');

// EP toggle semantics on EP2 (STAT_RX only: STAT_TX stays DISABLED so no
// IN transfer can self-trigger mid-test)
const U_EP2 = 0x08;
periph_write(USB + U_EP2, 4, 0x3000); // STAT_RX: 00 -> 11
assert_eq(periph_read(USB + U_EP2, 4), 0x3000, 'USB STAT_RX write-1 toggles to VALID');
periph_write(USB + U_EP2, 4, 0x1000); // STAT_RX bit 12 only: 11 -> 10
assert_eq(periph_read(USB + U_EP2, 4), 0x2000, 'USB STAT_RX single-bit toggle to NAK');
periph_write(USB + U_EP2, 4, 0x3000); // 10 -> 01
assert_eq(periph_read(USB + U_EP2, 4), 0x1000, 'USB STAT_RX toggle to STALL');
periph_write(USB + U_EP2, 4, 0x0001); // EA direct (STAT untouched)
assert_eq(periph_read(USB + U_EP2, 4), 0x1001, 'USB EA direct write');
assert_eq(periph_read(USB + U_EP2, 4) & 0x4040, 0, 'USB DTOG bits untouched by writes');
periph_write(USB + U_EP2, 4, 0x0000); // silent, EA direct-cleared
assert_eq(periph_read(USB + U_EP2, 4), 0x1000, 'USB EP2 parked (no IN fired)');

// Control endpoint setup: EP0 control/VALID, buffer table at PMA 0
periph_write(USB + U_CNTR, 4, C_RESETM | C_CTRM);
periph_write(USB + U_EP0, 4, 0x3200); // TYPE=control, STAT_RX VALID
assert_eq(periph_read(USB + U_EP0, 4), 0x3200, 'USB EP0 control + RX VALID');
periph_write(USB + U_BTABLE, 4, 0);
assert_eq(periph_read(USB + U_BTABLE, 4), 0, 'USB BTABLE');
periph_write(U_PMA + 0, 2, 0x30);   // ADDR0_TX = 0x30 (DESC0)
periph_write(U_PMA + 4, 2, 0);      // COUNT0_TX = 0
periph_write(U_PMA + 8, 2, 0x20);   // ADDR0_RX = 0x20 (DESC1)
periph_write(U_PMA + 12, 2, 0);     // COUNT0_RX cfg
periph_write(U_PMA + 24, 2, 0x40);  // ADDR1_RX = 0x40
periph_write(U_PMA + 28, 2, 0);     // COUNT1_RX cfg

// SETUP delivery (GET_DESCRIPTOR): PMA bytes (word 0x20 -> APB 64, 4-stride),
// COUNT=8, CTR_RX+SETUP, IRQ20
const setup = [0x80, 0x06, 0x00, 0x01, 0x00, 0x00, 0x40, 0x00];
assert_eq(usb_inject_setup(setup), true, 'USB SETUP accepted when armed');
for (let i = 0; i < 8; i++) {
    const b = periph_read(U_PMA + 64 + (i >> 1) * 4 + (i & 1), 1);
    if (b !== setup[i]) { assert_eq(b, setup[i], `USB SETUP PMA byte ${i}`); break; }
}
assert_eq(periph_read(U_PMA + 12, 2) & 0x3FF, 8, 'USB COUNT0_RX = 8 after SETUP');
const ep0 = periph_read(USB + U_EP0, 4);
assert_eq(ep0 & 0x8800, 0x8800, 'USB EP0 CTR_RX + SETUP set');
assert_eq(ep0 & 0x3000, 0x2000, 'USB EP0 STAT_RX back to NAK');
assert_eq(ep0 & 0x4000, 0x4000, 'USB EP0 DTOG_RX toggled');
const istr = periph_read(USB + U_ISTR, 4);
assert_eq(istr & (I_CTR | I_DIR), I_CTR | I_DIR, 'USB ISTR CTR + DIR(rx)');
assert_eq(istr & 0xF, 0, 'USB ISTR EP_ID = 0');
assert(has_pending_interrupt() && get_next_pending_interrupt() === 20,
    'USB SETUP pends IRQ 20');
clear_current_interrupt();
// Clear CTR_RX (write CTR bit 0, no STAT toggles): SETUP retires too
periph_write(USB + U_EP0, 4, 0x3200);
assert_eq(periph_read(USB + U_EP0, 4) & 0x8800, 0, 'USB CTR_RX + SETUP cleared together');
periph_write(USB + U_ISTR, 4, 0xFFFFFFFF & ~(I_CTR | I_DIR));

// IN completion: 18-byte descriptor via PMA TX (word 0x30 -> APB 96,
// 4-stride), STAT_TX -> VALID fires once
const desc = [];
for (let i = 0; i < 18; i++) desc.push((0x10 + i) & 0xFF);
for (let i = 0; i < 18; i++) periph_write(U_PMA + 96 + (i >> 1) * 4 + (i & 1), 1, desc[i]);
periph_write(U_PMA + 4, 2, 18); // COUNT0_TX = 18
periph_write(USB + U_EP0, 4, 0x0030); // STAT_TX DISABLED -> VALID: transfer!
const uev = drain_events();
let usbIn = null;
for (let i = 0; i < uev.length;) {
    const t = uev[i++];
    if (t === 18) {
        const ep = uev[i++], len = uev[i++];
        usbIn = [ep, len, uev.slice(i, i + len).join(',')];
        i += len;
    } else break;
}
assert_eq(usbIn !== null, true, 'USB IN completion emits UsbIn event');
assert_eq(usbIn[0], 0, 'USB UsbIn ep = 0');
assert_eq(usbIn[1], 18, 'USB UsbIn len = COUNT_TX');
assert_eq(usbIn[2], desc.join(','), 'USB UsbIn bytes match PMA TX buffer');
const ep0b = periph_read(USB + U_EP0, 4);
assert_eq(ep0b & 0x0080, 0x0080, 'USB EP0 CTR_TX set after IN');
assert_eq(ep0b & 0x0030, 0x0020, 'USB EP0 STAT_TX back to NAK');
assert_eq(ep0b & 0x0040, 0x0040, 'USB EP0 DTOG_TX toggled');
const istr2 = periph_read(USB + U_ISTR, 4);
assert_eq(istr2 & I_CTR, I_CTR, 'USB ISTR CTR on IN');
assert_eq(istr2 & (I_DIR | 0xF), 0, 'USB ISTR DIR=0 (IN), EP_ID=0');
assert(has_pending_interrupt() && get_next_pending_interrupt() === 20,
    'USB IN pends IRQ 20');
clear_current_interrupt();
periph_write(USB + U_ISTR, 4, 0xFFFFFFFF & ~I_CTR);

// Bulk OUT EP1: arm (EA + STAT_RX VALID), inject, NAK, re-arm
const U_EP1 = 0x04;
periph_write(USB + U_EP1, 4, 0x3001);
assert_eq(periph_read(USB + U_EP1, 4), 0x3001, 'USB EP1 armed for OUT');
assert_eq(usb_inject_out(1, [9, 8, 7]), true, 'USB bulk OUT accepted when armed');
assert_eq(periph_read(U_PMA + 128, 1), 9, 'USB OUT PMA byte 0');
assert_eq(periph_read(U_PMA + 128 + 4, 1), 7, 'USB OUT PMA byte 2');
assert_eq(periph_read(U_PMA + 28, 2) & 0x3FF, 3, 'USB COUNT1_RX = 3');
assert_eq(periph_read(USB + U_EP1, 4) & 0x8000, 0x8000, 'USB EP1 CTR_RX after OUT');
assert_eq(usb_inject_out(1, [1]), false, 'USB OUT NAKed while not re-armed');
periph_write(USB + U_EP1, 4, 0x1000); // STAT_RX NAK -> VALID (toggle bit 12 only)
assert_eq(usb_inject_out(1, [5, 6]), true, 'USB OUT accepted after re-arm');
assert_eq(periph_read(USB + U_EP1, 4) & 0x4000, 0, 'USB EP1 DTOG_RX toggled twice = 0');
clear_current_interrupt();
periph_write(USB + U_ISTR, 4, 0);
// Drain stale pendings: NVIC pending is level (a second OUT inject re-sets
// an already-set bit), so bulk CTRs would otherwise leak into the ISO
// vector asserts below via the fairness rotation.
let _du = 0;
while (get_next_pending_interrupt() !== -255 && _du++ < 100) { clear_current_interrupt(); }

// Isochronous endpoints: bulk-shared data mechanics, but no STALL and CTR
// pends the high-priority vector (IRQ 19). EP2 as ISO OUT then ISO IN.
// (Toggle writes are relative: compute the mask from live STAT_RX.)
periph_write(U_PMA + 40, 2, 0x50);  // ADDR2_RX (word -> APB 160, 4-stride)
periph_write(U_PMA + 44, 2, 0x8800); // COUNT2_RX 64B blocks
{
const ep2cur = periph_read(USB + U_EP2, 4);
periph_write(USB + U_EP2, 4, 0x0402 | ((((ep2cur >> 12) & 3) ^ 3) << 12)); // EA2 + TYPE_ISO + RX->VALID
}
assert_eq(periph_read(USB + U_EP2, 4) & 0x0600, 0x0400, 'USB EP2 TYPE_ISO stored');
// STALL is a no-op on isochronous endpoints (no handshake to stall);
// TX-side attempt leaves DISABLED in place and RX stays armed.
periph_write(USB + U_EP2, 4, 0x0402 | 0x0010); // TX DISABLED->STALL attempt
assert_eq(periph_read(USB + U_EP2, 4) & 0x30, 0x00, 'USB ISO STAT_TX ignores STALL');
assert_eq(periph_read(USB + U_EP2, 4) & 0x3000, 0x3000, 'USB ISO RX stays armed');
assert_eq(usb_inject_out(2, [0xAA, 0xBB]), true, 'USB ISO OUT accepted when armed');
assert_eq(periph_read(U_PMA + 160, 1), 0xAA, 'USB ISO OUT lands in RX buffer');
assert_eq(periph_read(USB + U_EP2, 4) & 0x8000, 0x8000, 'USB EP2 CTR_RX after ISO OUT');
assert(has_pending_interrupt() && get_next_pending_interrupt() === 19,
    'USB ISO OUT CTR pends HP IRQ 19');
clear_current_interrupt();
// RX-side STALL attempt (now NAK) is dropped too.
periph_write(USB + U_EP2, 4, 0x0402 | 0x3000); // RX NAK->STALL attempt
assert_eq(periph_read(USB + U_EP2, 4) & 0x3000, 0x2000, 'USB ISO STAT_RX ignores STALL');
periph_write(U_PMA + 32, 2, 0x58);  // ADDR2_TX (word -> APB 176, 4-stride)
periph_write(U_PMA + 176, 1, 0x5A);
periph_write(U_PMA + 36, 2, 1);      // COUNT2_TX = 1
periph_write(USB + U_EP2, 4, 0x0432); // STAT_TX DISABLED -> VALID (keep EA2+TYPE_ISO)
const iev = drain_events();
let isoIn = null;
for (let i = 0; i < iev.length;) {
    const t = iev[i++];
    if (t === 18) {
        const ep = iev[i++], len = iev[i++];
        isoIn = [ep, len, iev.slice(i, i + len).join(',')];
        i += len;
    } else break;
}
assert_eq(isoIn !== null && isoIn[0] === 2 && isoIn[1] === 1 && isoIn[2] === '90', true, 'USB ISO IN completion drains UsbIn');
assert(has_pending_interrupt() && get_next_pending_interrupt() === 19,
    'USB ISO IN CTR pends HP IRQ 19');
clear_current_interrupt();
periph_write(USB + U_ISTR, 4, 0);

// DADDR / FNR misc
periph_write(USB + U_DADDR, 4, 0x8A);
assert_eq(periph_read(USB + U_DADDR, 4), 0x8A, 'USB DADDR ADD+EF');
assert_eq(periph_read(USB + 0x48, 4) & 0x8000, 0x8000, 'USB FNR RXDP attached');

// DADDR hardware address filter (device is addr 10, EF set)
periph_write(USB + U_EP0, 4, 0x3200); // retire stale CTRs
assert_eq(usb_inject_setup(setup, 11), false, 'USB SETUP to wrong address filtered');
assert_eq(usb_inject_setup(setup, 10), true, 'USB SETUP to own address accepted');
periph_write(USB + U_EP0, 4, 0x3200);
assert_eq(usb_inject_setup(setup), true, 'USB SETUP without addr accepted (legacy host)');
periph_write(USB + U_EP0, 4, 0x3200);
periph_write(USB + U_DADDR, 4, 0); // unaddressed: only addr 0 answers
assert_eq(usb_inject_setup(setup, 5), false, 'USB SETUP filtered while unaddressed');
assert_eq(usb_inject_setup(setup, 0), true, 'USB SETUP to addr 0 accepted while unaddressed');
periph_write(USB + U_EP0, 4, 0x3200);

// SOF engine: 1ms frames (72000 instr) bump FNR + SOF flag (ISTR.9)
periph_write(USB + U_ISTR, 4, 0);
step_batch(72000);
assert_eq(periph_read(USB + 0x48, 4) & 0x7FF, 1, 'USB FNR frame 1 after 72K instr');
assert_eq(periph_read(USB + U_ISTR, 4) & (1 << 9), 1 << 9, 'USB ISTR SOF set');
step_batch(72000);
assert_eq(periph_read(USB + 0x48, 4) & 0x7FF, 2, 'USB FNR frame 2');
periph_write(USB + U_CNTR, 4, (1 << 9)); // SOFM
step_batch(72000);
// Drain stale pendings (earlier CTR completions) so the assert is meaningful.
let _d = 0;
while (get_next_pending_interrupt() !== -255 && _d++ < 100) { clear_current_interrupt(); }
step_batch(72000);
assert(has_pending_interrupt() && get_next_pending_interrupt() === 20,
    'USB SOF pends IRQ 20 with SOFM');
clear_current_interrupt();
periph_write(USB + U_CNTR, 4, 0);
periph_write(USB + U_ISTR, 4, 0);

// Suspend: FSUSP forces SUSP (ISTR.11); clearing FSUSP wakes (WKUP, IRQ42)
periph_write(0xE000E100 + 0x04, 4, 1 << 10); // ISER1: USB wakeup IRQ 42 enable
periph_write(USB + U_CNTR, 4, (1 << 11) | (1 << 12)); // SUSPM + WKUPM
_d = 0;
while (get_next_pending_interrupt() !== -255 && _d++ < 100) { clear_current_interrupt(); }
periph_write(USB + U_CNTR, 4, (1 << 11) | (1 << 12) | (1 << 3)); // +FSUSP
assert_eq(periph_read(USB + U_ISTR, 4) & (1 << 11), 1 << 11, 'USB ISTR SUSP on FSUSP');
assert(has_pending_interrupt() && get_next_pending_interrupt() === 20,
    'USB SUSP pends IRQ 20 with SUSPM');
clear_current_interrupt();
periph_write(USB + U_CNTR, 4, (1 << 11) | (1 << 12)); // FSUSP off -> wake
assert_eq(periph_read(USB + U_ISTR, 4) & (1 << 11), 0, 'USB ISTR SUSP cleared on wake');
assert_eq(periph_read(USB + U_ISTR, 4) & (1 << 12), 1 << 12, 'USB ISTR WKUP on wake');
assert(has_pending_interrupt() && get_next_pending_interrupt() === 42,
    'USB WKUP pends IRQ 42 with WKUPM');
clear_current_interrupt();
periph_write(USB + U_ISTR, 4, 0);
periph_write(USB + U_CNTR, 4, 0);
// SOF frames are bus activity: idle transfer gaps never suspend (an
// attached host sends SOF every frame; suspend needs a silent bus, which
// the always-attached emulated host never produces). FNR keeps advancing.
const fnr0 = periph_read(USB + 0x48, 4) & 0x7FF;
step_batch(72000 * 4);
assert_eq(periph_read(USB + U_ISTR, 4) & (1 << 11), 0, 'USB no auto-suspend while SOF flows');
assert((periph_read(USB + 0x48, 4) & 0x7FF) !== fnr0, 'USB FNR advances across idle frames');
// Plain traffic delivers with no SUSP/WKUP churn
periph_write(USB + U_EP1, 4, 0x1000); // re-arm EP1 OUT (NAK -> VALID toggle)
assert_eq(usb_inject_out(1, [0xAA]), true, 'USB OUT accepted while awake');
assert_eq(periph_read(USB + U_ISTR, 4) & ((1 << 11) | (1 << 12)), 0, 'USB no SUSP/WKUP on plain traffic');
periph_write(USB + U_ISTR, 4, 0);
// Remote wakeup: RESUME pulse (CNTR.4) self-clears after a frame + WKUP
periph_write(USB + U_CNTR, 4, (1 << 11) | (1 << 12) | (1 << 3)); // FSUSP again
periph_write(USB + U_CNTR, 4, (1 << 11) | (1 << 12) | (1 << 3) | (1 << 4)); // +RESUME
step_batch(72000);
assert_eq(periph_read(USB + U_CNTR, 4) & (1 << 4), 0, 'USB RESUME self-clears after a frame');
assert_eq(periph_read(USB + U_ISTR, 4) & (1 << 12), 1 << 12, 'USB WKUP after RESUME pulse');
periph_write(USB + U_ISTR, 4, 0);
periph_write(USB + U_CNTR, 4, 0);

// PDWN gates the macro: injects drop, resets ignored, SOF frozen.
// Retire stale EP CTRs first (ISTR.CTR is derived live from EP flags).
periph_write(USB + U_EP0, 4, 0x3200);
periph_write(USB + U_EP1, 4, 0x0001);
periph_write(USB + U_EP2, 4, 0x0402);
periph_write(USB + U_ISTR, 4, 0);
let _dp = 0;
while (get_next_pending_interrupt() !== -255 && _dp++ < 100) { clear_current_interrupt(); }
periph_write(USB + U_CNTR, 4, (1 << 1)); // PDWN only
assert_eq(usb_inject_out(1, [1]), false, 'USB OUT dropped while PDWN');
assert_eq(usb_bus_reset(), false, 'USB bus reset ignored while PDWN');
const fnrP = periph_read(USB + 0x48, 4);
step_batch(72000);
assert_eq(periph_read(USB + 0x48, 4), fnrP, 'USB FNR frozen while PDWN');
assert_eq(periph_read(USB + U_ISTR, 4), 0, 'USB no IRQ flags while PDWN');
periph_write(USB + U_CNTR, 4, 1 | (1 << 1)); // FRES + PDWN
periph_write(USB + U_CNTR, 4, (1 << 1));     // release FRES under PDWN
assert_eq(periph_read(USB + U_ISTR, 4) & I_RESET, 0, 'USB no RESET on FRES release while PDWN');
periph_write(USB + U_CNTR, 4, 0); // power back up (FRES release raises RESET)
periph_write(USB + U_ISTR, 4, 0);
_d = 0;
while (get_next_pending_interrupt() !== -255 && _d++ < 100) { clear_current_interrupt(); }

// Detach: tokens stop, IN never completes, SOF freezes; bus reset reattaches
reset();
periph_write(0xE000E100, 4, (1 << 20) | (1 << 19)); // ISER0: USB LP + HP IRQs
periph_write(USB + U_CNTR, 4, C_RESETM | C_CTRM | (1 << 11)); // RESETM+CTRM+SUSPM
periph_write(USB + U_ISTR, 4, 0);
assert_eq(usb_detach(), true, 'USB detach accepted');
assert_eq(periph_read(USB + U_ISTR, 4) & (1 << 11), 1 << 11, 'USB ISTR SUSP on detach');
assert(has_pending_interrupt() && get_next_pending_interrupt() === 20,
    'USB detach SUSP pends IRQ 20');
clear_current_interrupt();
assert_eq(usb_inject_out(1, [1]), false, 'USB OUT dropped while detached');
const fnrF = periph_read(USB + 0x48, 4);
step_batch(72000);
assert_eq(periph_read(USB + 0x48, 4), fnrF, 'USB FNR frozen while detached');
assert_eq(usb_bus_reset(), true, 'USB bus reset reattaches');
const fnrD = periph_read(USB + 0x48, 4);
step_batch(72000);
assert_eq(periph_read(USB + 0x48, 4) & 0x7FF, ((fnrD & 0x7FF) + 1) & 0x7FF, 'USB SOF resumes after reattach');
assert_eq(periph_read(USB + 0x48, 4) & 0x8000, 0x8000, 'USB FNR RXDP set after reattach');
assert_eq(periph_read(USB + U_ISTR, 4) & I_RESET, I_RESET, 'USB RESET flag on reattach reset');
// IN never completes while detached: VALID sticks, no CTR, no event
assert_eq(usb_detach(), true, 'USB detach again accepted');
periph_write(USB + U_EP0, 4, 0x3200); // EP0 control
periph_write(U_PMA + 0, 2, 0x30);   // ADDR0_TX
periph_write(U_PMA + 4, 2, 1);      // COUNT0_TX = 1
periph_write(U_PMA + 96, 1, 0x5A);
periph_write(USB + U_EP0, 4, 0x0030); // DISABLED -> VALID
assert_eq(periph_read(USB + U_EP0, 4) & 0x30, 0x30, 'USB STAT_TX stays VALID while detached');
assert_eq(periph_read(USB + U_EP0, 4) & 0x80, 0, 'USB no CTR_TX while detached');
assert_eq(drain_events().length, 0, 'USB no UsbIn while detached');
assert_eq(usb_bus_reset(), true, 'USB second bus reset reattaches');
assert_eq(periph_read(USB + U_ISTR, 4) & I_RESET, I_RESET, 'USB RESET flag on second reattach');

// Double-buffered bulk EP3 OUT: DTOG_RX ping-pongs between DESC0
// (DTOG=0) and DESC1 (DTOG=1); STAT stays VALID across fills.
reset();
periph_write(USB + U_CNTR, 4, 0);
periph_write(USB + U_BTABLE, 4, 0);
const U_EP3 = 0x0C;
// EA + KIND + STAT_RX toggle in ONE write (direct fields follow the
// written value, so split writes would clear EA/KIND again).
periph_write(USB + U_EP3, 4, 0x3103);          // EA=3, KIND, STAT_RX VALID
assert_eq(periph_read(USB + U_EP3, 4), 0x3103, 'USB EP3 DB armed');
periph_write(U_PMA + 48, 2, 0x50);  // ADDR3 DESC0 (buffer A) = 0x50
periph_write(U_PMA + 52, 2, 0);     // COUNT3 DESC0
periph_write(U_PMA + 56, 2, 0x60);  // ADDR3 DESC1 (buffer B) = 0x60
periph_write(U_PMA + 60, 2, 0);     // COUNT3 DESC1
assert_eq(usb_inject_out(3, [0x11]), true, 'USB DB OUT fill buffer A');
assert_eq(periph_read(U_PMA + 160, 1), 0x11, 'USB DB buffer A byte');
assert_eq(periph_read(USB + U_EP3, 4) & 0x3000, 0x3000, 'USB DB stays VALID after first fill');
assert_eq(usb_inject_out(3, [0x22]), true, 'USB DB OUT fill buffer B');
assert_eq(periph_read(U_PMA + 192, 1), 0x22, 'USB DB buffer B byte');
// Double-buffered bulk EP4 IN: DTOG_TX selects the source block.
// Descriptors first (the VALID transition completes immediately).
const U_EP4 = 0x10;
periph_write(U_PMA + 64, 2, 0x70);  // ADDR4 DESC0 (buffer A)
periph_write(U_PMA + 68, 2, 1);     // COUNT4 DESC0 = 1
periph_write(U_PMA + 224, 1, 0x77);
periph_write(USB + U_EP4, 4, 0x0134); // EA=4 + KIND + STAT_TX VALID, one write
const dev = Array.from(drain_events());
let usb = [];
for (let i = 0; i < dev.length;) {
    if (dev[i++] !== 18) break;
    const ep = dev[i++], len = dev[i++];
    usb.push([ep, len, ...dev.slice(i, i + len)]);
    i += len;
}
usb = usb.filter(e => e[0] === 4);
assert_eq(usb.length, 1, 'USB DB IN completion drains buffer A');
assert_eq(usb[0][2], 0x77, 'USB DB IN buffer A byte');

// ============================================================
// Summary
// ============================================================
// ============================================================
// HD/CL superset on the builtin F103 map (UART4/5, TIM5, ADC3, CAN2, OTG)
// ============================================================
group('HD/CL superset');

// --- UART4 TX (APB1.19 clock, UE|TE, UartTx event usart=4) ---
reset();
const UART4 = 0x40004C00;
periph_write(0x4002101C, 4, 1 << 19); // RCC APB1ENR UART4EN
periph_write(UART4 + 0x08, 4, 0x341); // BRR
periph_write(UART4 + 0x0C, 4, (1 << 13) | (1 << 3)); // CR1 UE|TE
assert_eq(periph_read(UART4 + 0x00, 4) & (1 << 7), 1 << 7, 'UART4 SR TXE after init');
periph_write(UART4 + 0x04, 4, 0x5A); // DR = 'Z' (TXE stays set: model drains at instruction rate)
step_batch(100000);
assert_eq(periph_read(UART4 + 0x00, 4) & (1 << 7), 1 << 7, 'UART4 TXE set after byte time');
let uart4ev = drain_events(), uart4seen = false;
for (let i = 0; i < uart4ev.length;) {
  const t = uart4ev[i++];
  if (t === 6) { const u = uart4ev[i++], b = uart4ev[i++]; if (u === 4 && b === 0x5A) uart4seen = true; }
  else break;
}
assert_eq(uart4seen, true, 'UART4 UartTx event (usart=4, 0x5A) drained');
// UART5 instantiates with TXE set (APB1.20 clock).
const UART5 = 0x40005000;
periph_write(0x4002101C, 4, (1 << 19) | (1 << 20));
periph_write(UART5 + 0x0C, 4, (1 << 13) | (1 << 3));
assert_eq(periph_read(UART5 + 0x00, 4) & (1 << 7), 1 << 7, 'UART5 SR TXE after init');

// --- TIM5 count + update (APB1.3 clock) ---
reset();
const TIM5 = 0x40000C00;
periph_write(0x4002101C, 4, 1 << 3); // RCC APB1ENR TIM5EN
periph_write(TIM5 + 0x28, 4, 0); // PSC
periph_write(TIM5 + 0x2C, 4, 100); // ARR
periph_write(TIM5 + 0x00, 4, 1); // CR1 CEN
step_batch(50);
assert_eq(periph_read(TIM5 + 0x24, 4), 50, 'TIM5 CNT advances with CEN');
step_batch(100);
assert_eq(periph_read(TIM5 + 0x10, 4) & 1, 1, 'TIM5 UIF on wrap past ARR');
periph_write(TIM5 + 0x10, 4, 0); // W0C clear
assert_eq(periph_read(TIM5 + 0x10, 4) & 1, 0, 'TIM5 UIF clears');

// --- ADC3 conversion (APB2.15 clock) ---
reset();
const ADC3 = 0x40013C00;
periph_write(0x40021018, 4, 1 << 15); // RCC APB2ENR ADC3EN
adc_set_sim_value(0x2AA);
periph_write(ADC3 + 0x08, 4, (1 << 0) | (1 << 22)); // ADON + SWSTART
assert_eq(periph_read(ADC3 + 0x00, 4) & (1 << 1), 0, 'ADC3 EOC not set before conversion');
step_batch(14);
assert_eq(periph_read(ADC3 + 0x00, 4) & (1 << 1), 1 << 1, 'ADC3 EOC after SWSTART');
assert_eq(periph_read(ADC3 + 0x4C, 4) & 0xFFF, 0x2AA, 'ADC3 DR matches sim value');

// --- CAN2 mailbox TX completion (APB1.25+26 clocks) ---
reset();
const CAN2 = 0x40006800;
periph_write(0x4002101C, 4, (1 << 25) | (1 << 26)); // CAN1EN + CAN2EN
periph_write(CAN2 + 0x00, 4, 1); // MCR INRQ
assert_eq(periph_read(CAN2 + 0x00, 4) & 1, 1, 'CAN2 MCR INRQ');
periph_write(CAN2 + 0x1C, 4, (1 << 30) | 0x001C0033); // BTR LBKM + timing
periph_write(CAN2 + 0x00, 4, 0); // leave init
periph_write(CAN2 + 0x180, 4, 0x1230001); // TI0R TXRQ
periph_write(CAN2 + 0x184, 4, 2); // DLC=2
assert_eq(periph_read(CAN2 + 0x08, 4) & 1, 1, 'CAN2 TSR RQCP0 (request completed)');
assert_eq(periph_read(CAN2 + 0x08, 4) & (1 << 16), 1 << 16, 'CAN2 TSR TXOK0');

// --- OTG_FS on the builtin map (attach → HPRT PCSTS) ---
reset();
assert_eq(otg_host_attach(true), true, 'builtin OTG attach accepted');
assert_eq(periph_read(0x50000440, 4) & 1, 1, 'builtin OTG HPRT PCSTS on attach');
assert_eq(otg_host_attach(false), true, 'builtin OTG detach accepted');
assert_eq(periph_read(0x50000440, 4) & 1, 0, 'builtin OTG HPRT PCSTS clears on detach');

// ============================================================
// GPIO LCKR (lock sequence + frozen config)
// ============================================================
group('LCKR');

reset();
const GPIOA_L = 0x40010800;
// PA5 push-pull output, PA6 input: baseline config
periph_write(GPIOA_L + 0x00, 4, (0x3 << 20) | (0x4 << 24)); // PA5 out, PA6 in
// Wrong order (no LCKK first): no lock
periph_write(GPIOA_L + 0x18, 4, 1 << 5);
assert_eq(periph_read(GPIOA_L + 0x18, 4) & (1 << 16), 0, 'LCKR no lock without sequence start');
periph_write(GPIOA_L + 0x00, 4, 0); // PA5 back to input: allowed (unlocked)
assert_eq(periph_read(GPIOA_L + 0x00, 4) & (0xF << 20), 0, 'LCKR unlocked pin reconfigures');
// Correct sequence for PA5: LCKK+LCK, LCK, LCKK+LCK
periph_write(GPIOA_L + 0x00, 4, (0x3 << 20) | (0x4 << 24)); // PA5 out again
periph_write(GPIOA_L + 0x18, 4, (1 << 16) | (1 << 5));
periph_write(GPIOA_L + 0x18, 4, 1 << 5);
periph_write(GPIOA_L + 0x18, 4, (1 << 16) | (1 << 5));
assert_eq(periph_read(GPIOA_L + 0x18, 4) & (1 << 16), 1 << 16, 'LCKR LCKK set after sequence');
periph_write(GPIOA_L + 0x00, 4, 0); // try to reconfigure locked PA5
assert_eq(periph_read(GPIOA_L + 0x00, 4) & (0xF << 20), 0x3 << 20, 'LCKR locked nibble frozen');
periph_write(GPIOA_L + 0x00, 4, 0xFFFFFFFF); // unlocked nibbles still move
assert_eq(periph_read(GPIOA_L + 0x00, 4) & (0xF << 24), 0xF << 24, 'LCKR unlocked nibble writes through');
assert_eq(periph_read(GPIOA_L + 0x00, 4) & (0xF << 20), 0x3 << 20, 'LCKR lock survives other writes');

// ============================================================
// AFIO SWJ_CFG (debug-pin reservation)
// ============================================================
group('SWJ');

reset();
const AFIO = 0x40010000;
// Default SWJ=000 (full SWJ): PA13 config writes are ignored (stays reset 0x0)...
periph_write(GPIOA_L + 0x04, 4, 0x3 << 20); // try PA13 output
assert_eq(periph_read(GPIOA_L + 0x04, 4) & (0xF << 20), 0, 'SWJ PA13 write ignored while reserved');
// ...while ordinary pins move (control).
periph_write(GPIOA_L + 0x04, 4, (0x3 << 20) | (0x3 << 16)); // PA13 + PA12 output
assert_eq(periph_read(GPIOA_L + 0x04, 4) & (0xF << 16), 0x3 << 16, 'SWJ PA12 (free) writes through');
assert_eq(periph_read(GPIOA_L + 0x04, 4) & (0xF << 20), 0, 'SWJ PA13 still ignored');
periph_write(AFIO + 0x04, 4, 0x02000000); // MAPR SWJ=010 (JTAG off, SW on)
periph_write(0x40010C00 + 0x00, 4, 0x3 << 12); // PB3 output: now allowed
assert_eq(periph_read(0x40010C00 + 0x00, 4) & (0xF << 12), 0x3 << 12, 'SWJ PB3 freed by JTAG-off');
periph_write(GPIOA_L + 0x04, 4, 0x3 << 20); // PA13 still SWD: ignored
assert_eq(periph_read(GPIOA_L + 0x04, 4) & (0xF << 20), 0, 'SWJ PA13 reserved under SW-DP');
periph_write(AFIO + 0x04, 4, 0x04000000); // MAPR SWJ=100 (all off)
periph_write(GPIOA_L + 0x04, 4, 0x3 << 20); // PA13 output: allowed now
assert_eq(periph_read(GPIOA_L + 0x04, 4) & (0xF << 20), 0x3 << 20, 'SWJ PA13 freed when all off');

// ============================================================
// RCC MCO + option-byte watchdog
// ============================================================
group('MCO/WDGOPT');

reset();
const RCC_M = 0x40021000;
assert_eq(rcc_mco_hz(), 0, 'MCO off by default');
periph_write(RCC_M + 0x04, 4, 4 << 24); // CFGR MCO=SYSCLK (HSI 8M)
assert_eq(rcc_mco_hz(), 8000000, 'MCO SYSCLK -> 8 MHz');
periph_write(RCC_M + 0x04, 4, (1 << 16) | (7 << 18) | 2 | (7 << 24)); // PLL x9 + MCO=PLL/2
assert_eq(rcc_mco_hz(), 36000000, 'MCO PLL/2 -> 36 MHz');
// OBR USER erased state = software watchdog
assert_eq(periph_read(0x4002201C, 4) & 0x3FC, 0x3FC, 'FLASH OBR USER erased (software WDG)');
// Select hardware watchdog: clear WDG_SW (OBR bit 2)
periph_write(0x4002201C, 4, 0x3FC & ~(1 << 2));
assert_eq(periph_read(0x4002201C, 4) & 0x3FC, 0x3F8, 'FLASH OBR WDG_SW clears');
// WDG_SW=0 runs the IWDG without a KR start: tiny reload, no feed -> reset.
// The IWDG is free-running on instruction time (tick arm, like silicon):
// step_batch alone advances it — no register-access pump needed.
const IWDG_O = 0x40003000;
is_watchdog_reset_requested(); // clear any stale request first
periph_write(IWDG_O + 0x00, 4, 0x5555); // unlock PR/RLR (no start)
periph_write(IWDG_O + 0x04, 4, 0); // prescaler /4
periph_write(IWDG_O + 0x08, 4, 1); // RLR=1 (shortest fuse)
periph_write(IWDG_O + 0x00, 4, 0xAAAA); // refresh loads the counter (still no start)
step_batch(1000); // 2 ticks of 512 instr consume the 1-tick fuse -> fires
assert_eq(step_batch(1000), 1, 'IWDG hardware mode step_batch reports watchdog stop');
assert_eq(is_watchdog_reset_requested(), false, 'reset flag was consumed by step_batch status');
// Re-arm the same fuse and prove the free-run completes with zero register
// touches after the KR writes (the old model needed a register pump).
is_watchdog_reset_requested();
periph_write(IWDG_O + 0x00, 4, 0xAAAA); // refresh again (no start)
drain_events(); // flush the prior WdogReset event
assert_eq(step_batch(1000), 1, 'IWDG fires on step_batch ticks alone');
{ let wdog = false; for (const e of drain_events()) { if (e === 13) { wdog = true; break; } }
  assert(wdog, 'IWDG pushes WdogReset{1} on expiry'); }
// KR-started fuse also fires on step_batch-only ticks (no register pump).
reset();
periph_write(IWDG_O + 0x00, 4, 0x5555);
periph_write(IWDG_O + 0x04, 4, 0); // /4 -> 512 instr/tick
periph_write(IWDG_O + 0x08, 4, 1); // RLR=1
periph_write(IWDG_O + 0x00, 4, 0xCCCC); // start
periph_write(IWDG_O + 0x00, 4, 0xAAAA); // refresh
is_watchdog_reset_requested();
assert_eq(step_batch(1000), 1, 'IWDG KR-started fuse fires on step_batch ticks alone');

// ============================================================
// WKUP pin + standby wake gating
// ============================================================
group('WKUP/standby');

reset();
const PWR_W = 0x40007000, SCR_W = 0xE000ED10;
// EWUP + PA0 rise latches WUF even outside standby
periph_write(PWR_W + 0x04, 4, 1 << 8); // CSR EWUP
gpio_set_input(0, 0, false);
gpio_set_input(0, 0, true); // PA0 rising
assert_eq(periph_read(PWR_W + 0x04, 4) & 1, 1, 'WKUP rising latches WUF with EWUP');
periph_write(PWR_W + 0x04, 4, 1 << 8); // clear WUF, keep EWUP
assert_eq(periph_read(PWR_W + 0x04, 4) & 1, 0, 'WUF clears');
// Enter standby: SLEEPDEEP + PDDS
periph_write(SCR_W, 4, 1 << 2);
periph_write(PWR_W + 0x00, 4, 1 << 1); // CR PDDS
// EXTI1 (PA1, IMR+RTSR, IRQ7 enabled) must NOT pend in standby...
periph_write(0xE000E100, 4, (1 << 7) | (1 << 6)); // ISER0: IRQ6 (EXTI0) + IRQ7 (EXTI1)
periph_write(0x40010400, 4, (1 << 0) | (1 << 1)); // IMR lines 0+1
periph_write(0x40010408, 4, (1 << 0) | (1 << 1)); // RTSR lines 0+1
gpio_set_input(0, 1, false);
gpio_set_input(0, 1, true); // PA1 rising
assert_eq(periph_read(0x40010414, 4) & (1 << 1), 1 << 1, 'standby: EXTI1 PR still records');
assert_eq(has_pending_interrupt(), false, 'standby: EXTI1 does not pend');
// ...but WKUP (EXTI0 + EWUP) does.
gpio_set_input(0, 0, false);
gpio_set_input(0, 0, true); // PA0 rising
assert(has_pending_interrupt() && get_next_pending_interrupt() === 6,
    'standby: WKUP pends EXTI0');
clear_current_interrupt();
// Back to Stop (PDDS clear): EXTI1 pends again.
periph_write(PWR_W + 0x00, 4, 0);
gpio_set_input(0, 1, false);
gpio_set_input(0, 1, true);
assert(has_pending_interrupt() && get_next_pending_interrupt() === 7,
    'stop: EXTI1 pends');
clear_current_interrupt();
periph_write(SCR_W, 4, 0); // leave deep sleep

// ============================================================
// SPI NSS hardware output (SSOE) + TI frame transfers
// ============================================================
group('NSS/TI');

reset();
const SPI1N = 0x40013000;
periph_write(0x40021018, 4, 1 << 12); // SPI1EN
gpio_take_pin_events(); // drain pre-existing pin events
// PA4 as GPIO output so the NSS drive level is observable
periph_write(0x40010800, 4, 0x3 << 16); // CRL PA4 push-pull out
// SSOE without SPE: NSS stays released (idle high, no event yet)
periph_write(SPI1N + 0x04, 4, 1 << 2); // CR2 SSOE
assert_eq(gpio_read_output(0, 4), false, 'SPI1 NSS undriven while SPE=0');
assert_eq(gpio_take_pin_events().length, 0, 'no NSS event before SPE');
// SPE with SSOE: NSS asserts low (driven level; the first assert from
// cold reset emits no pin event since the driven register was already 0)
periph_write(SPI1N + 0x00, 4, (1 << 2) | (1 << 6)); // MSTR + SPE
assert_eq(gpio_read_output(0, 4), false, 'SPI1 NSS driven low (SSOE+SPE)');
// SPE off: NSS releases high + pin event
periph_write(SPI1N + 0x00, 4, 1 << 2); // MSTR, SPE=0
assert_eq(gpio_read_output(0, 4), true, 'SPI1 NSS released high (SPE=0)');
assert_eq(gpio_take_pin_events().length > 0, true, 'NSS release emits pin event');
// Second assert cycle: now both edges emit (driven HIGH->LOW change)
periph_write(SPI1N + 0x00, 4, (1 << 2) | (1 << 6)); // MSTR + SPE
assert_eq(gpio_read_output(0, 4), false, 'SPI1 NSS re-asserts low');
assert_eq(gpio_take_pin_events().length > 0, true, 'NSS re-assert emits pin event');
// TI frame format (FRF): transfers complete identically (NSS phasing only)
periph_write(SPI1N + 0x04, 4, (1 << 2) | (1 << 4)); // SSOE + FRF
periph_write(SPI1N + 0x00, 4, (1 << 2) | (1 << 6)); // MSTR + SPE
periph_write(SPI1N + 0x0C, 4, 0xA5);
assert_eq(periph_read(SPI1N + 0x08, 4) & 1, 1, 'SPI1 TI mode RXNE after transfer');
assert_eq(periph_read(SPI1N + 0x0C, 4), 0xFF, 'SPI1 TI mode DR reads 0xFF (no device)');

// ============================================================
// USART sync + IrDA modes (byte-identical transfers)
// ============================================================
group('Sync/IrDA');

reset();
const USART1S = 0x40013800;
periph_write(0x40021018, 4, (1 << 14) | (1 << 2));
periph_write(USART1S + 0x08, 4, 0x341);
periph_write(USART1S + 0x0C, 4, (1 << 13) | (1 << 3)); // UE|TE
periph_write(USART1S + 0x10, 4, 1 << 11); // CR2 CLKEN (synchronous)
periph_write(USART1S + 0x04, 4, 0x51); // 'Q'
let syncEv = drain_events(), syncSeen = false;
for (let i = 0; i < syncEv.length;) {
  const t = syncEv[i++];
  if (t === 6) { const u = syncEv[i++], b = syncEv[i++]; if (u === 1 && b === 0x51) syncSeen = true; }
  else break;
}
assert_eq(syncSeen, true, 'USART sync-mode byte transmits');
periph_write(USART1S + 0x10, 4, 0); // CLKEN off
periph_write(USART1S + 0x14, 4, 1 << 1); // CR3 IREN (IrDA)
periph_write(USART1S + 0x04, 4, 0x52); // 'R'
let irEv = drain_events(), irSeen = false;
for (let i = 0; i < irEv.length;) {
  const t = irEv[i++];
  if (t === 6) { const u = irEv[i++], b = irEv[i++]; if (u === 1 && b === 0x52) irSeen = true; }
  else break;
}
assert_eq(irSeen, true, 'USART IrDA-mode byte transmits');

// ============================================================
// CAN silent modes (SILM, silent loopback)
// ============================================================
group('CAN silent');

reset();
const CAN1S = 0x40006400;
periph_write(0x4002101C, 4, 1 << 25); // CAN1EN
periph_write(CAN1S + 0x00, 4, 1);
periph_write(CAN1S + 0x1C, 4, (1 << 31) | 0x001C0033); // BTR SILM, no LBKM
periph_write(CAN1S + 0x00, 4, 0);
periph_write(CAN1S + 0x180, 4, 0x2220001); // TXRQ
assert_eq(periph_read(CAN1S + 0x08, 4) & 1, 1, 'CAN silent TX completes (RQCP0)');
assert_eq(periph_read(CAN1S + 0x0C, 4) & 3, 0, 'CAN silent TX loops back nothing (RF0R empty)');
// Silent loopback (SILM+LBKM): self-test reception works, bus undisturbed
periph_write(CAN1S + 0x1C, 4, (1 << 31) | (1 << 30) | 0x001C0033);
periph_write(CAN1S + 0x180, 4, 0x2220001);
assert_eq(periph_read(CAN1S + 0x08, 4) & 1, 1, 'CAN silent-loopback TX completes');
// (RX self-reception needs a matching filter; completion path is what changed)

// ============================================================
// TIM1 dead-time narrowing (DTG)
// ============================================================
group('DTG');

reset();
const TIM1D = 0x40012C00;
periph_write(0x40021018, 4, 1 << 11);
periph_write(TIM1D + 0x28, 4, 0);
periph_write(TIM1D + 0x2C, 4, 999);
periph_write(TIM1D + 0x18, 4, 0b110 << 4);
periph_write(TIM1D + 0x20, 4, 1);
periph_write(TIM1D + 0x34, 4, 500);
periph_write(TIM1D + 0x00, 4, 1);      // CEN
periph_write(TIM1D + 0x44, 4, 1 << 15); // MOE, DTG=0
step_batch(2000);
assert_eq(pwm_duty(TIM1D, 0), 50, 'TIM1 PWM 50% with DTG=0');
periph_write(TIM1D + 0x44, 4, (1 << 15) | 0x10); // DTG=16 ticks
step_batch(2000);
assert_eq(pwm_duty(TIM1D, 0), 48, 'TIM1 PWM narrowed to 48% by DTG=16');

// ============================================================
// ADC discontinuous + JAUTO
// ============================================================
group('ADC-DISC');

reset();
const ADC1D = 0x40012400;
periph_write(0x40021018, 4, 1 << 9);
adc_set_sim_value(0x100);
// Sequence of 3 (SQR1 L=2), DISCEN + DISCNUM=0 (1 channel per trigger)
periph_write(ADC1D + 0x2C, 4, 2 << 20); // SQR1 L=2
periph_write(ADC1D + 0x34, 4, (2 << 20) | (1 << 10) | 0); // SQR3: SQ1=0, SQ2=1, SQ3=2
periph_write(ADC1D + 0x04, 4, 1 << 11); // CR1 DISCEN
periph_write(ADC1D + 0x08, 4, (1 << 0) | (1 << 22)); // ADON + SWSTART
step_batch(100);
let devD = drain_events(), dchans = [];
for (let i = 0; i < devD.length;) {
  const t = devD[i++];
  if (t === 8) { const a = devD[i++], c = devD[i++]; if (a === 1) dchans.push(c); }
  else break;
}
assert_eq(dchans.join(','), '0', 'ADC discontinuous first trigger converts ch0 only');
periph_write(ADC1D + 0x08, 4, (1 << 0) | (1 << 22)); // second trigger
step_batch(100);
devD = drain_events(); dchans = [];
for (let i = 0; i < devD.length;) {
  const t = devD[i++];
  if (t === 8) { const a = devD[i++], c = devD[i++]; if (a === 1) dchans.push(c); }
  else break;
}
assert_eq(dchans.join(','), '1', 'ADC discontinuous second trigger converts ch1 only');
periph_write(ADC1D + 0x08, 4, (1 << 0) | (1 << 22)); // third trigger
step_batch(100);
assert_eq(periph_read(ADC1D + 0x00, 4) & (1 << 1), 1 << 1, 'ADC discontinuous final EOC');
// JAUTO: injected follows the regular sequence end
reset();
periph_write(0x40021018, 4, 1 << 9);
periph_write(ADC1D + 0x04, 4, 1 << 10); // CR1 JAUTO
periph_write(ADC1D + 0x08, 4, (1 << 0) | (1 << 22)); // ADON + SWSTART (1-ch seq)
step_batch(100); // regular completes, injected arms
step_batch(100); // injected completes
assert_eq(periph_read(ADC1D + 0x00, 4) & (1 << 2), 1 << 2, 'ADC JAUTO sets JEOC after regular');

// ============================================================
// SDSC byte-addressed cards (HCS=0)
// ============================================================
group('SDSC');

reset();
reset_ext_devices(); // drop the earlier SDIO test card (find_card takes the first)
const SDIO_S = 0x40018000;
const S2_ARG = 0x08, S2_CMD = 0x0C, S2_RESP1 = 0x14, S2_DLEN = 0x28, S2_DCTRL = 0x2C;
const S2_STA = 0x34, S2_ICR = 0x38, S2_FIFO = 0x80;
const sdImg2 = new Uint8Array(2048 * 512);
for (let i = 0; i < sdImg2.length; i++) sdImg2[i] = (i >> 9) & 0xFF;
add_sd_card('SDIO', sdImg2);
const sdCmd2 = (idx, arg, rsp = 1 << 6) => {
    periph_write(SDIO_S + S2_ARG, 4, arg);
    periph_write(SDIO_S + S2_CMD, 4, (idx & 0x3F) | rsp | (1 << 10));
};
periph_write(SDIO_S + 0x00, 4, 0x03);
periph_write(SDIO_S + 0x04, 4, 0x100 | 0x76);
sdCmd2(0, 0, 0);
periph_write(SDIO_S + S2_ICR, 4, 0xFFFFFFFF);
// ACMD41 with HCS=0 -> SDSC: OCR busy then ready WITHOUT CCS
let ocr2 = 0;
for (let i = 0; i < 10 && !(ocr2 & 0x80000000); i++) {
    sdCmd2(55, 0);
    sdCmd2(41, 0); // HCS clear
    ocr2 = periph_read(SDIO_S + S2_RESP1, 4);
    periph_write(SDIO_S + S2_ICR, 4, 0xFFFFFFFF);
}
assert_eq(ocr2 & 0x80000000, 1 << 31, 'SDSC ACMD41 OCR ready');
assert_eq(ocr2 & 0x40000000, 0, 'SDSC ACMD41 OCR CCS clear (byte addressing)');
// CMD9: v1 CSD (STRUCTURE=0 in RESP1 bits 31:30)
sdCmd2(9, 0x12340000);
assert_eq((periph_read(SDIO_S + S2_RESP1, 4) >>> 30) & 3, 0, 'SDSC CSD v1 STRUCTURE=0');
// CMD17 with a BYTE address (block 3 = bytes 1536..2047, fill 3)
periph_write(SDIO_S + S2_DLEN, 4, 512);
periph_write(SDIO_S + S2_DCTRL, 4, 0x1);
sdCmd2(17, 3 * 512);
assert_eq(periph_read(SDIO_S + S_FIFO, 4), 0x03030303, 'SDSC byte-address read lands on block 3');
for (let i = 1; i < 128; i++) periph_read(SDIO_S + S_FIFO, 4);
periph_write(SDIO_S + S2_ICR, 4, 0xFFFFFFFF);

// ============================================================
// ITM stimulus (printf channel) + UID + ESOF
// ============================================================
group('ITM/UID/ESOF');

reset();
// STIM0 gated by TER[0] + TCR.ITMENA
periph_write(0xE0000E00, 4, 1); // TER port 0
periph_write(0xE0000E80, 4, 1); // TCR ITMENA
periph_write(0xE0000000, 4, 0x43); // STIM0 = 'C'
let itmEv = drain_events(), itmSeen = false;
for (let i = 0; i < itmEv.length;) {
  const t = itmEv[i++];
  if (t === 22) { const p = itmEv[i++], b = itmEv[i++]; if (p === 0 && b === 0x43) itmSeen = true; }
  else break;
}
assert_eq(itmSeen, true, 'ITM STIM0 byte drains as ItmByte event');
periph_write(0xE0000E00, 4, 0); // TER clear: gated off
periph_write(0xE0000000, 4, 0x44);
itmEv = drain_events(); itmSeen = false;
for (let i = 0; i < itmEv.length;) {
  const t = itmEv[i++];
  if (t === 22) itmSeen = true;
  else break;
}
assert_eq(itmSeen, false, 'ITM gated off without TER');
// 96-bit UID constant, read-only
assert_eq(periph_read(0x1FFFF7E8, 4) >>> 0, 0x00310033, 'UID word0 constant');
assert_eq(periph_read(0x1FFFF7EC, 4) >>> 0, 0x32313034, 'UID word1 constant');
assert_eq(periph_read(0x1FFFF7F0, 4) >>> 0, 0x38373635, 'UID word2 constant');
periph_write(0x1FFFF7E8, 4, 0xDEADBEEF);
assert_eq(periph_read(0x1FFFF7E8, 4) >>> 0, 0x00310033, 'UID writes ignored');
// ESOF on detach (missed host SOFs), mask-gated like other ISTR flags
reset();
periph_write(USB + U_CNTR, 4, 1 << 8); // CNTR ESOFM
periph_write(0xE000E100, 4, 1 << 20); // ISER0: USB LP IRQ20
assert_eq(usb_detach(), true, 'USB detach accepted (ESOF test)');
assert_eq(periph_read(USB + U_ISTR, 4) & (1 << 8), 1 << 8, 'USB ISTR ESOF on detach');
assert(has_pending_interrupt() && get_next_pending_interrupt() === 20,
    'USB detach ESOF pends IRQ 20');
clear_current_interrupt();

// ============================================================
// SWD / JTAG debug-port slice
// ============================================================
group('SWD/JTAG debug');
reset();
// DHCSR needs the DBGKEY or writes are ignored (silicon behavior).
periph_write(0xE000EDF0, 4, 0x00000003); // no key
assert_eq(swd_halted(), false, 'keyless DHCSR write ignored');
periph_write(0xE000EDF0, 4, 0xA05F0003); // KEY + C_DEBUGEN + C_HALT
assert_eq(swd_halted(), true, 'DHCSR C_HALT halts');
assert_eq(periph_read(0xE000EDF0, 4) & (1 << 17), 1 << 17, 'DHCSR S_HALT readback');
swd_resume();
assert_eq(swd_halted(), false, 'swd_resume releases');
assert_eq(periph_read(0xE000EDF0, 4) & 1, 1, 'C_DEBUGEN stays after resume');
// DEMCR store + readback.
periph_write(0xE000EDFC, 4, (1 << 24) | (1 << 10));
assert_eq(periph_read(0xE000EDFC, 4) >>> 0, (1 << 24) | (1 << 10), 'DEMCR TRCENA+VC readback');
// SWD DP register file.
assert_eq(swd_dp_read(0x0) >>> 0, 0x2BA01477, 'DPIDR Cortex-M3');
swd_dp_write(0x4, (1 << 30) | (1 << 28)); // power-up REQs
assert_eq(swd_dp_read(0x4) & ((1 << 31) | (1 << 29)), (1 << 31) | (1 << 29), 'CTRL/STAT ACKs follow REQs');
swd_dp_write(0x8, 0xF0);
assert_eq(swd_dp_read(0x8) >>> 0, 0xF0, 'SELECT stored');
// MEM-AP identification + CSW default + TAR store.
assert_eq(swd_ap_read(0xF, 0xC) >>> 0, 0x24770011, 'MEM-AP IDR');
assert_eq(swd_ap_read(0x0, 0x0) >>> 0, 0x23000052, 'CSW reset 32-bit');
swd_ap_write(0x0, 0x4, 0x20000100);
assert_eq(swd_ap_read(0x0, 0x4) >>> 0, 0x20000100, 'TAR stored');
// Watch slots: 4 max, kind 0 rejected, freed slots reusable.
const sw0 = swd_add_watchpoint(1, 0x20000100, 4);
const sw1 = swd_add_watchpoint(2, 0x20000200, 4);
const sw2 = swd_add_watchpoint(3, 0x20000300, 4);
const sw3 = swd_add_watchpoint(1, 0x20000400, 4);
assert(sw0 === 0 && sw1 === 1 && sw2 === 2 && sw3 === 3, 'four watch slots fill 0-3');
assert_eq(swd_add_watchpoint(1, 0x20000500, 4), -1, 'fifth watch rejected');
assert_eq(swd_add_watchpoint(0, 0x20000500, 4), -1, 'kind 0 rejected');
swd_remove_watchpoint(sw0); swd_remove_watchpoint(sw1);
swd_remove_watchpoint(sw2); swd_remove_watchpoint(sw3);
assert_eq(swd_add_watchpoint(1, 0x20000100, 4), 0, 'freed slot reusable');
swd_remove_watchpoint(0);
// JTAG TAP shares the DP (probe helper, no new tests).
swd_jtag_reset();
assert_eq(swd_jtag_idcode() >>> 0, 0x4BA00477, 'JTAG TAP IDCODE');

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed+failed} total`);
if (failed === 0) console.log('ALL TESTS PASSED');
else console.log('SOME TESTS FAILED');
process.exit(failed > 0 ? 1 : 0);
