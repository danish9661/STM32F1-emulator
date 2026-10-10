use crate::system::System;
use super::Peripheral;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

const NUM_PORTS: usize = 8;

/// Optional output slew (rise/fall) delay in instructions, 0 = instant.
/// Affects IDR readback only (device callbacks stay instant).
static GPIO_SLEW: AtomicU32 = AtomicU32::new(0);

pub fn set_gpio_slew(inst: u32) {
    GPIO_SLEW.store(inst, Ordering::Relaxed);
}

/// Pin-change event buffer: flat [port, pin, level, tcount] quads, recorded
/// whenever the chip drives an output pin to a NEW level (ODR/BSRR/BRR writes
/// and CRL/CRH mode-change re-drives). tcount is INSTRUCTION_COUNT (u32
/// wrap) at the transition — sub-batch edge timing for host observers
/// (e.g. software-serial start-bit phase; batch drains quantize edges to
/// ~20K instr ≈ 2.7 bit times at 9600 baud, unrecoverable without stamps).
/// Drained by JS via gpio_take_pin_events(); cleared by the next
/// init()/init_svd(). Bounded: on overflow the buffer is dropped wholesale
/// (page drains per batch, so this never happens in practice). Zero hot-path
/// cost: recorded per transition, never per access (fetches bypass).
const MAX_PIN_EVENTS: usize = 1024;
static GPIO_PIN_EVENTS: Mutex<Vec<u32>> = Mutex::new(Vec::new());

pub fn clear_pin_events() {
    GPIO_PIN_EVENTS.lock().unwrap().clear();
}

/// Drain buffered pin-change events as a flat [port, pin, level, tcount, ...]
/// array.
pub fn take_pin_events() -> Vec<u32> {
    let mut ev = GPIO_PIN_EVENTS.lock().unwrap();
    std::mem::take(&mut *ev)
}

fn record_pin_event(port: u8, pin: u8, level: bool) {
    let mut ev = GPIO_PIN_EVENTS.lock().unwrap();
    if ev.len() + 4 > MAX_PIN_EVENTS {
        ev.clear();
    }
    ev.push(port as u32);
    ev.push(pin as u32);
    ev.push(level as u32);
    ev.push(crate::system::instruction_count() as u32);
}

#[derive(Clone, Copy)]
pub struct Pin {
    port: u8,
    pin: u8,
}

/// Split a pin name into `(port index, pin number)`: an optional leading `P`,
/// a port letter A-G (case-insensitive), then the pin number 0-15. Returns
/// None if the name is malformed.
///
/// This is the single parser for pin names — `Pin::from_str` and the
/// ext-device config path (`ext_devices::parse_pin`) both go through it.
pub fn parse_pin_name(name: &str) -> Option<(u8, u8)> {
    let rest = name.strip_prefix(['P', 'p']).unwrap_or(name);
    let mut chars = rest.chars();
    let port = GpioPorts::try_port_index(chars.next()?.to_ascii_uppercase())?;
    let digits = chars.as_str();
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let pin: u8 = digits.parse().ok()?;
    (pin < 16).then_some((port, pin))
}

impl Pin {
    /// Parse a pin name (see [`parse_pin_name`]). Returns `None` on a malformed
    /// name instead of panicking — these names come from the JS `add_*()` device
    /// config at setup time, and a bad one should be a recoverable config error
    /// (the device registration is skipped), not a WASM abort.
    pub fn from_str(name: &str) -> Option<Self> {
        match parse_pin_name(name) {
            Some((port, pin)) => Some(Self { port, pin }),
            None => {
                if !name.is_empty() {
                    crate::console_warn(&format!(
                        "Ignoring pin with invalid name '{}'", name));
                }
                None
            }
        }
    }

    pub fn new(port: u8, pin: u8) -> Self {
        Self { port, pin }
    }
}

pub struct GpioPorts {
    read_callbacks: [Vec<(u8, Box<dyn FnMut(&System) -> bool>)>; NUM_PORTS],
    write_callbacks: [Vec<(u8, Box<dyn FnMut(&System, bool)>)>; NUM_PORTS],
    /// Bitmask of pins with a registered external read driver, per port.
    /// Lets the IDR fast path skip the callback scan entirely when no pin
    /// on the port is driven (the common case: zero external devices).
    read_cb_mask: [u16; NUM_PORTS],
    output_states: [u16; NUM_PORTS],
    input_states: [u16; NUM_PORTS],
    /// Pending output transitions for slew emulation: (pin, transition_at, old_level)
    pending_transitions: [Vec<(u8, u64, bool)>; NUM_PORTS],
    /// Analog wire voltage per pin (12-bit, 0xFFFF = no analog source).
    /// When set, ADC channels mapped to the pin sample this voltage with an
    /// RC sample-and-hold instead of the injected simulation value.
    analog_states: [u16; NUM_PORTS * 16],
}

impl Default for GpioPorts {
    fn default() -> Self {
        Self {
            read_callbacks: Default::default(),
            write_callbacks: Default::default(),
            read_cb_mask: [0; NUM_PORTS],
            output_states: [0; NUM_PORTS],
            input_states: [0; NUM_PORTS],
            pending_transitions: Default::default(),
            analog_states: [0xFFFF; NUM_PORTS * 16],
        }
    }
}

impl GpioPorts {
    pub fn port_index(letter: char) -> Option<u8> {
        Self::try_port_index(letter)
    }

    /// Port index for a letter A-G, None if it isn't a port on this device.
    pub fn try_port_index(letter: char) -> Option<u8> {
        matches!(letter, 'A'..='G').then(|| letter as u8 - b'A')
    }

    pub fn add_read_callback(&mut self, pin: Pin, cb: impl FnMut(&System) -> bool + 'static) {
        self.read_cb_mask[pin.port as usize] |= 1 << pin.pin;
        self.read_callbacks[pin.port as usize].push((pin.pin, Box::new(cb)));
    }

    pub fn add_write_callback(&mut self, pin: Pin, cb: impl FnMut(&System, bool) + 'static) {
        self.write_callbacks[pin.port as usize].push((pin.pin, Box::new(cb)));
    }

    /// External driver level for a pin (read callback), if one is registered.
    pub fn read_pin_option(&mut self, sys: &System, port: u8, pin: u8) -> Option<bool> {
        if self.read_cb_mask[port as usize] & (1 << pin) == 0 {
            return None;
        }
        for (p, cb) in &mut self.read_callbacks[port as usize] {
            if *p == pin {
                return Some(cb(sys));
            }
        }
        None
    }

    /// Effective pin level: read callback if registered, otherwise the last driven output state.
    pub fn read_pin_effective(&mut self, sys: &System, port: u8, pin: u8) -> bool {
        if self.read_cb_mask[port as usize] & (1 << pin) == 0 {
            return (self.output_states[port as usize] >> pin) & 1 != 0;
        }
        for (p, cb) in &mut self.read_callbacks[port as usize] {
            if *p == pin {
                return cb(sys);
            }
        }
        (self.output_states[port as usize] >> pin) & 1 != 0
    }

    /// Set an analog wire voltage on a pin (12-bit). 0xFFFF clears it.
    pub fn set_analog(&mut self, port: u8, pin: u8, level: u16) {
        self.analog_states[port as usize * 16 + pin as usize] = level;
    }

    /// Analog voltage present on the pin, if one is wired.
    pub fn analog_pin_value(&self, port: u8, pin: u8) -> Option<u16> {
        let v = self.analog_states[port as usize * 16 + pin as usize];
        if v == 0xFFFF { None } else { Some(v) }
    }

    /// Drive an output pin. `record_event` controls whether a NEW driven level
    /// emits a pin-change event (false for alternate-function pins — PWM/SPI
    /// clocks churn at MHz and are observed via pwmDuty/onPeriphWrite instead).
    pub fn write_port(&mut self, sys: &System, port: u8, pin: u8, value: bool, record_event: bool) {
        let old = (self.output_states[port as usize] >> pin) & 1 != 0;
        if old != value && record_event {
            record_pin_event(port, pin, value);
        }
        let slew = GPIO_SLEW.load(Ordering::Relaxed) as u64;
        if slew > 0 {
            if old != value {
                self.pending_transitions[port as usize]
                    .push((pin, crate::system::instruction_count() + slew, old));
            }
        }
        if value {
            self.output_states[port as usize] |= 1 << pin;
        } else {
            self.output_states[port as usize] &= !(1 << pin);
        }
        for (pin_cb, cb) in &mut self.write_callbacks[port as usize] {
            if *pin_cb == pin {
                cb(sys, value);
            }
        }
    }

    /// Wire level of an output pin, honoring pending slew transitions.
    /// External drivers (read callbacks) always win over driven state.
    pub fn read_output_pin(&mut self, sys: &System, port: u8, pin: u8) -> bool {
        if self.read_cb_mask[port as usize] & (1 << pin) != 0 {
            if let Some(v) = self.read_pin_option(sys, port, pin) {
                return v;
            }
        }
        self.driven_pin_level(port, pin)
    }

    /// Driven output level of a pin, honoring pending slew transitions and
    /// ignoring external drivers (used where the drive state always wins,
    /// e.g. an open-drain output driving low).
    pub fn driven_pin_level(&mut self, port: u8, pin: u8) -> bool {
        let now = crate::system::instruction_count();
        let mut v = (self.output_states[port as usize] >> pin) & 1 != 0;
        self.pending_transitions[port as usize].retain(|(p, at, old)| {
            if *p != pin {
                return true;
            }
            if now >= *at {
                false // transition complete: final level is the driven state in v
            } else {
                v = *old;
                true
            }
        });
        v
    }

    pub fn set_input_pin(&mut self, sys: &System, port: u8, pin: u8, value: bool) {
        let prev = (self.input_states[port as usize] >> pin) & 1 != 0;
        self.set_input_pin_raw(port, pin, value);
        // A real push-button wired to an input pin produces EXTI edges. Fire
        // the same edge detection as GPIO output writes so attachInterrupt()
        // works for page-driven input pins (button widgets).
        if prev != value {
            let rising = value && !prev;
            sys.p.gpio_exti_trigger(sys, port, pin, rising);
            // PC13 doubles as the TAMPER pin: route its level edges into the
            // backup domain too (BKP decides by TPE/TPAL whether it is an event).
            if port == 2 && pin == 13 {
                sys.p.bkp_tamper(sys, rising);
            }
            // PA0 doubles as the WKUP pin: rising edges latch WUF when EWUP
            // is set (PWR decides); EXTI0 delivery itself is standby-gated
            // in fire_line, so no mode check is needed here.
            if port == 0 && pin == 0 {
                sys.p.pwr_wkup_edge(sys, rising);
            }
        }
    }

    fn set_input_pin_raw(&mut self, port: u8, pin: u8, value: bool) {
        let mut found = false;
        for (p, ref mut cb) in &mut self.read_callbacks[port as usize] {
            if *p == pin {
                found = true;
                *cb = Box::new(move |_| value);
            }
        }
        if !found {
            self.read_cb_mask[port as usize] |= 1 << pin;
            self.read_callbacks[port as usize].push((pin, Box::new(move |_| value)));
        }
        if value {
            self.input_states[port as usize] |= 1 << pin;
        } else {
            self.input_states[port as usize] &= !(1 << pin);
        }
    }

    pub fn read_input_pin(&self, port: u8, pin: u8) -> bool {
        (self.input_states[port as usize] >> pin) & 1 != 0
    }
}

#[derive(Default)]
pub struct Gpio {
    #[allow(dead_code)]
    port_letter: char,
    port: u8,
    crl: u32,
    crh: u32,
    odr: u32,
    bsrr: u32,
    brr: u32,
    lckr: u32,
    /// LCKR lock-sequence progress (0-2) + last written key. The lock
    /// itself lives in `lckr` (LCKK bit 16 + frozen LCK bits) and only a
    /// reset clears it; sequence writes never touch locked state.
    lck_seq: u8,
    lck_last: u32,
}

impl Gpio {
    pub fn new(name: &str) -> Option<Box<dyn Peripheral>> {
        if let Some(block) = name.strip_prefix("GPIO") {
            let port_letter = block.chars().next()?;
            let port = GpioPorts::port_index(port_letter)?;
            Some(Box::new(Self { port_letter, port, ..Self::default() }))
        } else {
            None
        }
    }

    /// Nibble mask of LCKR-locked pins for CRL (pins 0-7).
    fn lock_mask_lo(&self) -> u32 {
        let mut m = 0u32;
        for pin in 0..8 {
            if self.lckr & (1 << pin) != 0 {
                m |= 0xF << (pin * 4);
            }
        }
        m
    }

    /// Nibble mask of LCKR-locked pins for CRH (pins 8-15).
    fn lock_mask_hi(&self) -> u32 {
        let mut m = 0u32;
        for pin in 8..16 {
            if self.lckr & (1 << pin) != 0 {
                m |= 0xF << ((pin - 8) * 4);
            }
        }
        m
    }

    /// Debug-port reservation (AFIO MAPR SWJ_CFG): with the debug port
    /// enabled these pins belong to SWJ/JTAG, and GPIO configuration
    /// writes to them are ignored (real HW behavior).
    /// 000 full SWJ: PA13/14/15 + PB3/4 reserved. 001 (no NJTRST): PB4
    /// free. 010 (JTAG off, SW on): PA15/PB3/PB4 free, PA13/14 stay SWD.
    /// 100 (all off): all five free. Other codes behave like 000.
    fn dbg_reserved(port: u8, pin: u8, sys: &System) -> bool {
        let swj = sys.p.afio_swj_cfg();
        match (port, pin) {
            (0, 13) | (0, 14) => swj != 0b100,
            (0, 15) | (1, 3) => swj != 0b010 && swj != 0b100,
            (1, 4) => swj != 0b001 && swj != 0b010 && swj != 0b100,
            _ => false,
        }
    }

    /// Nibble mask of debug-reserved pins for CRL (pins 0-7).
    fn swj_mask_lo(&self, sys: &System) -> u32 {
        let mut m = 0u32;
        for pin in 0..8 {
            if Self::dbg_reserved(self.port, pin, sys) {
                m |= 0xF << (pin * 4);
            }
        }
        m
    }

    /// Nibble mask of debug-reserved pins for CRH (pins 8-15).
    fn swj_mask_hi(&self, sys: &System) -> u32 {
        let mut m = 0u32;
        for pin in 8..16 {
            if Self::dbg_reserved(self.port, pin, sys) {
                m |= 0xF << ((pin - 8) * 4);
            }
        }
        m
    }

    /// LCKR lock sequence (RM0008): write LCKK+LCK, then LCK alone, then
    /// LCKK+LCK again with the same key. Completion freezes those pins'
    /// CRL/CRH nibbles until reset; anything else just restarts tracking.
    fn write_lckr(&mut self, value: u32) {
        let key = value & 0xFFFF;
        let kk = value & 0x1_0000 != 0;
        if kk && self.lck_seq != 1 {
            if self.lck_seq == 2 && key == self.lck_last {
                self.lckr = key | 0x1_0000;
                self.lck_seq = 0;
            } else {
                self.lck_seq = 1;
                self.lck_last = key;
            }
        } else if !kk && self.lck_seq == 1 && key == self.lck_last {
            self.lck_seq = 2;
        } else {
            self.lck_seq = 0;
            self.lck_last = key;
        }
    }

    fn pin_is_output(&self, pin: u8) -> bool {
        let cfg = if pin < 8 { (self.crl >> (pin * 4)) & 0xF } else { (self.crh >> ((pin - 8) * 4)) & 0xF };
        cfg & 0b11 != 0
    }

    /// True for alternate-function output pins (cnf=0b10, mode!=0): driven by a
    /// peripheral, not by ODR — excluded from pin-change events.
    fn pin_is_af(&self, pin: u8) -> bool {
        let cfg = if pin < 8 { (self.crl >> (pin * 4)) & 0xF } else { (self.crh >> ((pin - 8) * 4)) & 0xF };
        cfg & 0b11 != 0 && (cfg >> 2) & 0b11 == 2
    }

    /// Electrical wire level of a pin:
    /// - external driver (read callback) wins whenever present;
    /// - input floating: external or 0;
    /// - input with pull-up/down: ODR bit selects pull direction;
    /// - output push-pull: ODR drives both levels;
    /// - output open-drain: low is driven, high releases the line (external/pull/0);
    /// - analog: always 0.
    fn pin_level(&self, sys: &System, gpio: &mut GpioPorts, pin: u8) -> bool {
        let crl = self.crl;
        let crh = self.crh;
        let odr = self.odr;
        // Fast path: whole-port mode word is 0 (all pins input floating) or
        // the pin is a plain push-pull output with no external driver and no
        // pending slew — no per-pin decode, no callback scan.
        let cfg = if pin < 8 { (crl >> (pin * 4)) & 0xF } else { (crh >> ((pin - 8) * 4)) & 0xF };
        let mode = cfg & 0b11;
        let cnf = (cfg >> 2) & 0b11;
        if mode == 0 && cnf == 0 {
            if gpio.read_cb_mask[self.port as usize] & (1 << pin) == 0 {
                return false; // floating, undriven
            }
            return gpio.read_pin_option(sys, self.port, pin).unwrap_or(false);
        }
        if cnf == 0 && mode != 0 {
            // Push-pull output: the strong ODR driver wins over any
            // injected external level (silicon behavior). A stale host
            // injection (e.g. a sensor's idle-HIGH while the firmware
            // drives its wake-LOW) must never flip firmware readback of
            // its own driven pin. Pending slew transitions still gate
            // the visible edge via the driven state.
            return gpio.driven_pin_level(self.port, pin);
        }
        let odr_bit = (odr >> pin) & 1 != 0;
        if mode == 0 {
            match cnf {
                // 01: floating input — external driver, else 0.
                1 => gpio.read_pin_option(sys, self.port, pin).unwrap_or(false),
                // 10: input with pull-up / pull-down (e.g. Arduino
                // INPUT_PULLUP) — external driver wins, else the
                // ODR-selected pull. Without this a pulled-up pin
                // reads 0 forever, breaking bit-banged single-wire
                // reads (DHT22 DATA stuck LOW -> firmware sees no
                // ACK/data edges -> nan).
                2 => gpio.read_pin_option(sys, self.port, pin).unwrap_or(odr_bit),
                // 00 analog / 11 reserved: always 0.
                _ => false,
            }
        } else {
            // open-drain: 0 drives low; 1 releases the line
            if odr_bit {
                gpio.read_pin_option(sys, self.port, pin).unwrap_or(false)
            } else {
                // driven low (wins over any external pull); honor pending slew
                gpio.driven_pin_level(self.port, pin)
            }
        }
    }

    fn iter_port_reg_changes(old_value: u32, new_value: u32, stride: u8, mut f: impl FnMut(u8, u8)) {
        let mut changes = old_value ^ new_value;
        let stride_mask = 0xFF >> (8 - stride);
        while changes != 0 {
            let right_most_bit = changes.trailing_zeros() as u8;
            let pin = right_most_bit / stride;
            if pin <= 16 {
                let v = (new_value >> (pin * stride)) as u8 & stride_mask;
                f(pin, v);
            }
            changes &= !(stride_mask as u32) << (pin * stride);
        }
    }
}

impl Peripheral for Gpio {
    fn read(&mut self, sys: &System, offset: u32) -> u32 {
        match offset {
            0x00 => self.crl,
            0x04 => self.crh,
            0x08 => {
                let mut gpio = sys.p.gpio.borrow_mut();
                let mut v = 0u16;
                for pin in 0..16 {
                    if self.pin_level(sys, &mut gpio, pin) {
                        v |= 1 << pin;
                    }
                }
                v as u32
            }
            0x0C => self.odr,
            0x10 => self.bsrr,
            0x14 => self.brr,
            0x18 => self.lckr,
            _ => 0,
        }
    }

    fn write(&mut self, sys: &System, offset: u32, value: u32) {
        match offset {
            0x00 => {
                let old = self.crl;
                // Locked pins keep their configuration nibbles (LCKR);
                // debug-reserved pins ignore GPIO config (SWJ owns them).
                let locked = self.lock_mask_lo() | self.swj_mask_lo(sys);
                let new = (value & !locked) | (old & locked);
                self.crl = new;
                let mut gpio = sys.p.gpio.borrow_mut();
                // Mode change re-drives pins now in output mode with their ODR
                // level (real HW behavior); write_port records pin events only
                // when the driven level actually changes.
                Self::iter_port_reg_changes(old, new, 4, |pin, _| {
                    if self.pin_is_output(pin) {
                        gpio.write_port(sys, self.port, pin, ((self.odr >> pin) & 1) != 0, !self.pin_is_af(pin));
                    }
                });
            }
            0x04 => {
                let old = self.crh;
                let locked = self.lock_mask_hi() | self.swj_mask_hi(sys);
                let new = (value & !locked) | (old & locked);
                self.crh = new;
                let mut gpio = sys.p.gpio.borrow_mut();
                Self::iter_port_reg_changes(old, new, 4, |pin, _| {
                    let pin = pin + 8;
                    if self.pin_is_output(pin) {
                        gpio.write_port(sys, self.port, pin, ((self.odr >> pin) & 1) != 0, !self.pin_is_af(pin));
                    }
                });
            }
            0x08 => {}
            0x0C => {
                let old_odr = self.odr;
                let mut gpio = sys.p.gpio.borrow_mut();
                Self::iter_port_reg_changes(old_odr, value, 1, |pin, v| {
                    if self.pin_is_output(pin) {
                        gpio.write_port(sys, self.port, pin, v != 0, !self.pin_is_af(pin));
                        sys.p.gpio_exti_trigger(sys, self.port, pin, v != 0);
                    }
                });
                // Full register write: input pins use ODR to select pull-up/down
                self.odr = value;
            }
            0x10 => {
                let reset = value >> 16;
                let set = value & 0xFFFF;
                let mut gpio = sys.p.gpio.borrow_mut();
                Self::iter_port_reg_changes(0, set, 1, |pin, _| {
                    if self.pin_is_output(pin) {
                        gpio.write_port(sys, self.port, pin, true, !self.pin_is_af(pin));
                        sys.p.gpio_exti_trigger(sys, self.port, pin, true);
                    }
                });
                Self::iter_port_reg_changes(0, reset, 1, |pin, _| {
                    if self.pin_is_output(pin) {
                        gpio.write_port(sys, self.port, pin, false, !self.pin_is_af(pin));
                        sys.p.gpio_exti_trigger(sys, self.port, pin, false);
                    }
                });
                self.odr = (self.odr & !reset) | set;
                self.bsrr = value;
            }
            0x14 => {
                let mut gpio = sys.p.gpio.borrow_mut();
                Self::iter_port_reg_changes(0, value, 1, |pin, _| {
                    if self.pin_is_output(pin) {
                        gpio.write_port(sys, self.port, pin, false, !self.pin_is_af(pin));
                        sys.p.gpio_exti_trigger(sys, self.port, pin, false);
                    }
                });
                self.odr &= !value;
                self.brr = value;
            }
            0x18 => self.write_lckr(value),
            _ => {}
        }
    }

    fn tick(&mut self, _sys: &System) {}
}

#[cfg(test)]
mod tests {
    use super::parse_pin_name;

    #[test]
    fn parses_pin_names() {
        assert_eq!(parse_pin_name("PA5"), Some((0, 5)));
        assert_eq!(parse_pin_name("A5"), Some((0, 5)));
        assert_eq!(parse_pin_name("pb0"), Some((1, 0)));
        assert_eq!(parse_pin_name("PC13"), Some((2, 13)));
        assert_eq!(parse_pin_name("PG15"), Some((6, 15)));
    }

    #[test]
    fn rejects_malformed_names() {
        assert_eq!(parse_pin_name(""), None);
        assert_eq!(parse_pin_name("P"), None);
        assert_eq!(parse_pin_name("PA"), None, "no pin number");
        assert_eq!(parse_pin_name("PA16"), None, "pin out of range");
        assert_eq!(parse_pin_name("PZ0"), None, "not a port on this device");
        assert_eq!(parse_pin_name("PA5x"), None, "trailing garbage");
        assert_eq!(parse_pin_name("PA 5"), None);
        assert_eq!(parse_pin_name("PA999"), None, "overflows u8");
    }
}
