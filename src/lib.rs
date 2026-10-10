use std::sync::atomic::Ordering;
use wasm_bindgen::prelude::*;

mod system;
pub mod bus;
mod interrupts;
pub mod peripherals;
pub mod ext_devices;
pub mod cpu;
pub mod native;

use system::{WasmSystem, VmEvent};

/// Emit a `console.warn` from Rust without pulling in `web_sys` (zero extra
/// wasm size). Works in both the browser and Node.js. Used for recoverable
/// configuration/deprecation notices — never for hot paths.
pub(crate) fn console_warn(msg: &str) {
    let global = js_sys::global();
    if let Ok(console) = js_sys::Reflect::get(&global, &JsValue::from_str("console")) {
        if let Ok(warn) = js_sys::Reflect::get(&console, &JsValue::from_str("warn")) {
            if let Some(f) = warn.dyn_ref::<js_sys::Function>() {
                let _ = f.call1(&console, &JsValue::from_str(msg));
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod test_util {
    use crate::system::WasmSystem;
    use std::sync::{Mutex, OnceLock};

    static TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    /// Run `f` against a freshly built emulator system. The ext-device
    /// registry and the instruction counter are process-wide and WasmSystem
    /// holds Rc's, so every test that builds one is serialized.
    pub(crate) fn with_sys<R>(f: impl FnOnce(&WasmSystem) -> R) -> R {
        let _held = lock();
        let sys = WasmSystem::new();
        f(&sys)
    }

    /// Hold the global test lock directly (for tests that install the
    /// process-wide SYS via init() instead of using a local system).
    pub(crate) fn lock() -> std::sync::MutexGuard<'static, ()> {
        let guard = TEST_LOCK.get_or_init(|| Mutex::new(()));
        guard.lock().unwrap_or_else(|e| e.into_inner())
    }
}

// We use static mut since WASM is single-threaded — this allows re-initialization.
static mut SYS: Option<WasmSystem> = None;

/// Replace the emulator system (init()/init_svd()). Any `&'static WasmSystem`
/// handed out by sys() dangles afterwards, so this must only be called from a
/// wasm export with no emulator call in flight — which is the case, since JS
/// enters the module one export at a time.
fn set_sys(new: WasmSystem) {
    unsafe { *std::ptr::addr_of_mut!(SYS) = Some(new); }
}

/// Borrow the system, or None before init()/init_svd().
///
/// Goes through a raw pointer rather than referencing the `static mut`
/// directly (the 2024-edition `static_mut_refs` lint): the reference is to the
/// WasmSystem inside, never to the static itself.
fn try_sys() -> Option<&'static WasmSystem> {
    unsafe { (*std::ptr::addr_of!(SYS)).as_ref() }
}

#[inline(always)]
pub(crate) fn sys() -> &'static WasmSystem {
    try_sys().expect("WasmSystem not initialized — call init() or init_svd() first")
}

/// Clear all registered ext devices (spi flash, eeprom, oled, lcd, touchscreen,
/// fsmc, software spi). Call BEFORE adding devices for a new emulator instance —
/// otherwise devices from a previous init (stale CS pins reading low on the
/// fresh GPIO) shadow the new ones during SPI/I2C device selection.
#[wasm_bindgen]
pub fn reset_ext_devices() {
    let mut ext = system::get_ext_devices().lock().unwrap();
    ext.spi_flashes.clear();
    ext.i2c_eeproms.clear();
    ext.usart_probes.clear();
    ext.lcds.clear();
    ext.touchscreens.clear();
    ext.displays.clear();
    ext.i2c_oleds.clear();
    ext.fsmc_nors.clear();
    ext.sd_cards.clear();
    drop(ext);
    system::get_software_spi_configs().lock().unwrap().clear();
}

/// Initialize the emulator with hardcoded peripheral map.
/// Must be called after adding all ext devices (add_spi_flash, add_i2c_eeprom).
/// Can be called multiple times to reset emulator state.
#[wasm_bindgen]
pub fn init() {
    console_error_panic_hook::set_once();
    system::INSTRUCTION_COUNT.store(0, Ordering::Relaxed);
    DBG_IDCODE.store(0x1001_6410, Ordering::Relaxed);
    peripherals::gpio::clear_pin_events();
    peripherals::bootloader::reset();
    native::reset();
    set_sys(WasmSystem::new());
    system::sync_mpu_gate(sys());
    system::reset_debug_mirrors();
}

/// Debug MCU IDCODE reported at 0xE0042000 (set per chip; defaults to the
/// STM32F103 value). GD32F103 reports 0x2BA01477. Timing stays
/// instruction-budget based regardless of the chip's rated MHz.
static DBG_IDCODE: std::sync::atomic::AtomicU32 =
    std::sync::atomic::AtomicU32::new(0x1001_6410);

/// Select the emulated chip's IDCODE (see DBG_IDCODE). Call after init().
#[wasm_bindgen]
pub fn set_dbg_idcode(code: u32) {
    DBG_IDCODE.store(code, Ordering::Relaxed);
}

pub(crate) fn dbg_idcode() -> u32 {
    DBG_IDCODE.load(Ordering::Relaxed)
}

/// Initialize the emulator from an SVD XML string (e.g., STM32F407.svd).
/// Must be called after adding all ext devices (add_spi_flash, add_i2c_eeprom).
#[wasm_bindgen]
pub fn init_svd(svd_xml: &str) {
    console_error_panic_hook::set_once();
    system::INSTRUCTION_COUNT.store(0, Ordering::Relaxed);
    peripherals::gpio::clear_pin_events();
    peripherals::bootloader::reset();
    native::reset();
    set_sys(WasmSystem::new_svd(svd_xml));
    system::sync_mpu_gate(sys());
    system::reset_debug_mirrors();
}

#[wasm_bindgen]
pub fn periph_read(addr: u32, width: u32) -> u32 {
    sys().p.read(&*sys(), addr, width as u8)
}

#[wasm_bindgen]
pub fn periph_write(addr: u32, width: u32, value: u32) {
    sys().p.write(&*sys(), addr, width as u8, value);
}

/// Register a peripheral implemented entirely in JS (rp2040js-style custom
/// chip). Callbacks are invoked with `(addr, size)` / `(addr, value, size)`
/// where addr is the ABSOLUTE access address. Requires init()/init_svd() first;
/// last registration wins on overlap. Returns false if not initialized.
#[wasm_bindgen]
pub fn register_js_peripheral(base: u32, size: u32, read: js_sys::Function, write: js_sys::Function) -> bool {
    match try_sys() {
        Some(sys) => {
            sys.p.register_js(base, size, read, write);
            true
        }
        None => false,
    }
}

/// DMA periph->mem pump: pop `size` bytes from the peripheral at `addr` via
/// the normal periph_read path (chunks <= 4, little-endian packed), so JS only
/// writes the result to RAM once per transfer instead of one crossing per chunk.
#[wasm_bindgen]
pub fn dma_absorb_periph(addr: u32, size: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(size as usize);
    let mut j = 0u32;
    while j < size {
        let chunk = std::cmp::min(4, size - j);
        let val = sys().p.read(&*sys(), addr, chunk as u8);
        for k in 0..chunk {
            out.push(((val >> (k * 8)) & 0xFF) as u8);
        }
        j += chunk;
    }
    out
}

/// DMA mem->periph pump: push `data` bytes into the peripheral at `addr` via
/// the normal periph_write path (chunks <= 4, little-endian unpacked), so JS
/// only reads RAM once per transfer instead of one crossing per chunk.
#[wasm_bindgen]
pub fn dma_push_periph(addr: u32, data: &[u8]) {
    let mut j = 0usize;
    while j < data.len() {
        let chunk = std::cmp::min(4, data.len() - j);
        let mut val = 0u32;
        for k in 0..chunk {
            val |= (data[j + k] as u32) << (k * 8);
        }
        sys().p.write(&*sys(), addr, chunk as u8, val);
        j += chunk;
    }
}

#[wasm_bindgen]
pub fn tick() {
    use std::sync::atomic::Ordering;
    system::INSTRUCTION_COUNT.fetch_add(1, Ordering::Relaxed);
    sys().tick();
}

/// Combined per-instruction step: sets masks, ticks peripherals, checks conditions.
/// Returns: 0=continue, 1=watchdog reset, 2=DMA pending, 3=interrupt pending.
#[wasm_bindgen]
pub fn step(primask: u32, basepri: u32) -> u32 {
    system::INTR_MASK_PRIMASK.store(primask, Ordering::Relaxed);
    system::INTR_MASK_BASEPRI.store(basepri, Ordering::Relaxed);
    system::INSTRUCTION_COUNT.fetch_add(1, Ordering::Relaxed);
    sys().intr.borrow_mut().reset_budget();
    sys().tick();
    if is_watchdog_reset_requested() { return 1; }
    if sys().pending_dma_count() > 0 { return 2; }
    if sys().p.nvic.borrow().has_pending_masked(primask, basepri) { return 3; }
    0
}

/// Process a batch of N instructions in one WASM call.
/// Peripheral ticks are instruction-delta based (each reads INSTRUCTION_COUNT
/// and accumulates elapsed time), so one tick after advancing the count by N
/// is equivalent to N per-instruction ticks — but ~N× cheaper (tick() was
/// ~55% of runtime via 100K iterations per batch).
/// Returns: 0=continue, 1=watchdog reset.
#[wasm_bindgen]
pub fn step_batch(count: u32) -> u32 {
    let sys = sys();
    system::INSTRUCTION_COUNT.fetch_add(count as u64, Ordering::Relaxed);
    sys.intr.borrow_mut().reset_budget();
    sys.tick();
    if is_watchdog_reset_requested() { 1 } else { 0 }
}

/// Raw engine instruction counter (same domain as pin-event tcounts).
/// The facade-level instCount does NOT credit IRQ-handler instructions,
/// so the two counters diverge under interrupt load — host observers must
/// measure edge ages in THIS domain (now - tcount), never by mixing with
/// facade counts. Returns full u64 (JS BigInt; safely < 2^53 in practice).
#[wasm_bindgen]
pub fn instruction_count_now() -> u64 {
    use std::sync::atomic::Ordering;
    system::INSTRUCTION_COUNT.load(Ordering::Relaxed)
}

/// One-call batch processor: advance the instruction count, reset the IRQ
/// dispatch budget, tick all peripherals, then report watchdog status and
/// whether any IRQ is pending — so JS needs one crossing per batch instead of
/// three (step_batch + a pending probe + the watchdog poll).
/// Returns:
///   0x8000_0000  = watchdog reset requested (stop the run)
///   0x4000_0000  = at least one IRQ pending (dispatch via intr_next loop)
///   0            = nothing pending
/// The pending probe is EXACTLY equivalent to the first intr_next() call
/// (same INTR_MASK statics + same find_highest_pending), minus the pop —
/// the actual pop still happens in JS after processDma, preserving dispatch
/// order. Watchdog requests made *during* IRQ handlers are still caught by
/// the JS is_watchdog_reset_requested() check after processInterrupts.
#[wasm_bindgen]
pub fn process_batch(count: u32) -> u32 {
    let sys = sys();
    system::INSTRUCTION_COUNT.fetch_add(count as u64, Ordering::Relaxed);
    sys.intr.borrow_mut().reset_budget();
    sys.tick();
    if is_watchdog_reset_requested() {
        return 0x8000_0000;
    }
    let primask = system::INTR_MASK_PRIMASK.load(Ordering::Relaxed);
    let basepri = system::INTR_MASK_BASEPRI.load(Ordering::Relaxed);
    if sys.p.nvic.borrow().has_pending_masked(primask, basepri) {
        0x4000_0000
    } else {
        0
    }
}

/// Check if any interrupt is pending, respecting PRIMASK/BASEPRI.
#[wasm_bindgen]
pub fn has_pending_interrupt() -> bool {
    let primask = system::INTR_MASK_PRIMASK.load(Ordering::Relaxed);
    let basepri = system::INTR_MASK_BASEPRI.load(Ordering::Relaxed);
    sys().p.nvic.borrow().has_pending_masked(primask, basepri)
}

#[wasm_bindgen]
pub fn get_next_pending_interrupt() -> i32 {
    sys().p.nvic.borrow_mut().get_next_pending_intr()
        .unwrap_or(-255)
}

/// Set PRIMASK and BASEPRI values from CPU state.
#[wasm_bindgen]
pub fn set_intr_masks(primask: u32, basepri: u32) {
    system::INTR_MASK_PRIMASK.store(primask, Ordering::Relaxed);
    system::INTR_MASK_BASEPRI.store(basepri, Ordering::Relaxed);
}

/// Call after an ISR returns to pop the active priority stack AND clear
/// this entry's IABR active bit (set on dispatch). The old pop-only return
/// left the bit set forever (phantom-active IRQs); the native
/// `exception_return` path clears both, so this matches it.
#[wasm_bindgen]
pub fn clear_current_interrupt() {
    let irq = sys().p.nvic.borrow_mut().last_popped_clear_take();
    if let Some(q) = irq {
        sys().p.nvic.borrow_mut().clear_active_bit(q);
    }
    sys().p.nvic.borrow_mut().clear_current_interrupt();
}

/// Call after an ISR returns: pops the active priority stack, and for SysTick
/// (irq == -1) also drains any unconsumed 1ms debt ticks internally (re-pends
/// each), so JS needs no nvic_systick_take loop.
#[wasm_bindgen]
pub fn finish_interrupt(irq: i32) {
    let mut nvic = sys().p.nvic.borrow_mut();
    nvic.clear_current_interrupt();
    if irq == -1 {
        while nvic.systick_take() {}
    }
}

#[wasm_bindgen]
pub fn dma_get_pending_count() -> u32 {
    sys().pending_dma_count() as u32
}

/// Rust-side DMA pump: pops ALL pending transfers, performs the peripheral
/// byte absorb/push internally (periph_read/periph_write chunked), and returns
/// a flat op plan for JS:
///   [op, a, b, c] quadruples:
///     op 0 = RAM memcpy (a=src, b=dst, c=size)          -> JS mem_read + mem_write
///     op 1 = write absorbed bytes (a=dst, b=size, c=off) -> JS mem_write(dma_take_absorbed(off,size))
///     op 2 = read RAM then push to periph (a=src, b=size, c=periAddr) -> JS mem_read + dma_push_periph
///     op 3 = done (a=completed stream bits)             -> JS dma_set_completed_many(a)
/// The plan is built in queue order; absorbed bytes land in a side buffer
/// fetched with dma_take_absorbed(). Completion is signaled LAST so DMA IRQs
/// fire only after every RAM move has landed.
#[wasm_bindgen]
pub fn dma_pump_all() -> Vec<u32> {
    sys().dma_build_plan()
}

/// Fetch a slice of the bytes absorbed by the last dma_pump_all() (offset,
/// length) so JS can mem_write them into RAM. Clears the whole buffer.
#[wasm_bindgen]
pub fn dma_take_absorbed(offset: u32, len: u32) -> Vec<u8> {
    sys().dma_absorb_take(offset as usize, len as usize)
}

#[wasm_bindgen]
pub fn dma_get_pending(index: u32) -> Vec<u32> {
    sys().take_pending_dma_transfer(index as usize)
        .map(|t| t.to_u32_vec())
        .unwrap_or_default()
}

#[wasm_bindgen]
pub fn dma_get_all_pending() -> Vec<u32> {
    sys().take_pending_dma_transfers()
        .iter()
        .flat_map(|t| t.to_u32_vec())
        .collect()
}

#[wasm_bindgen]
pub fn dma_set_completed(stream_idx: u32, success: bool) {
    sys().mark_dma_completed(stream_idx as usize, success);
}

#[wasm_bindgen]
pub fn dma_set_completed_many(bits: u32) {
    // Streams are global across both DMAs (DMA1 ch0-6 -> 0-6, DMA2 ch0-4 ->
    // 7-11); the JS pump passes the plan's done bits straight through.
    for stream in 0..12 {
        if bits & (1 << stream) != 0 {
            sys().mark_dma_completed(stream, true);
        }
    }
}

#[wasm_bindgen]
pub fn gpio_read_output(port: u32, pin: u32) -> bool {
    sys().p.gpio.borrow_mut().read_output_pin(&*sys(), port as u8, pin as u8)
}

/// Set the GPIO output slew delay in instructions (0 = instant). Affects IDR
/// readback only; device callbacks stay instant.
#[wasm_bindgen]
pub fn gpio_set_slew(inst: u32) {
    peripherals::gpio::set_gpio_slew(inst);
}

#[wasm_bindgen]
pub fn gpio_set_input(port: u32, pin: u32, value: bool) {
    let sys = sys();
    sys.p.gpio.borrow_mut().set_input_pin(&sys, port as u8, pin as u8, value);
}

#[wasm_bindgen]
pub fn gpio_read_input(port: u32, pin: u32) -> bool {
    sys().p.gpio.borrow().read_input_pin(port as u8, pin as u8)
}

/// Drain buffered pin-change events as a flat [port, pin, level, ...] array
/// (chip-driven output level changes only). Cleared on the next init().
#[wasm_bindgen]
pub fn gpio_take_pin_events() -> Vec<u32> {
    peripherals::gpio::take_pin_events()
}

/// Drain virtual-peripheral transaction events as a flat i32 array.
/// Encoding (discriminant first):
///   1 SpiTransfer  [1, channel, txLen, rxLen, tx bytes..., rx bytes...]
///   2 I2cStart     [2, channel, addr]
///   3 I2cWrite     [3, channel, byte]
///   4 I2cRead      [4, channel]
///   5 I2cStop      [5, channel]
///   6 UartTx       [6, usart, byte]
///   7 ExtiEdge     [7, line]
///   8 AdcDone      [8, adc, chan]
///   9 TimUpdate    [9, tim]
///  10 DacWrite     [10, chan, value]
///  11 CrcResult    [11, value]
///  12 RtcAlarm     [12, alarm]
///  13 WdogReset    [13, which]   (1=IWDG, 2=WWDG)
///  14 CanTx        [14, can, id, len, d0..d7]
///  15 CanRx        [15, can, id, len, d0..d7]
///  16 TimCapture    [16, tim, ch, value]   (input-capture latch)
///  17 FsmcAccess    [17, bank, offset, write, size, value]
///  18 UsbIn         [18, ep, len, bytes...]   (device->host IN completion)
///  19 I2cAlert      [19, channel, asserted] (SMBus SMBA drive edge)
///  20 HostTx        [20, ch, ep, setup, len, bytes...] (host OUT/SETUP done)
///  21 HostRx        [21, ch, ep, len]       (host IN token: feed an answer)
///  22 ItmByte       [22, port, byte]        (ITM stimulus printf channel)
#[wasm_bindgen]
pub fn drain_events() -> Vec<i32> {
    match try_sys() {
        Some(sys) => {
            let events = sys.take_events();
            let mut out: Vec<i32> = Vec::with_capacity(events.len() * 4);
            for e in &events {
                match e {
                    VmEvent::SpiTransfer { channel, tx, rx } => {
                        out.push(1);
                        out.push(*channel as i32);
                        out.push(tx.len() as i32);
                        out.push(rx.len() as i32);
                        for &b in tx { out.push(b as i32); }
                        for &b in rx { out.push(b as i32); }
                    }
                    VmEvent::I2cStart { channel, addr } => { out.push(2); out.push(*channel as i32); out.push(*addr as i32); }
                    VmEvent::I2cWrite { channel, byte } => { out.push(3); out.push(*channel as i32); out.push(*byte as i32); }
                    VmEvent::I2cRead { channel } => { out.push(4); out.push(*channel as i32); }
                    VmEvent::I2cStop { channel } => { out.push(5); out.push(*channel as i32); }
                    VmEvent::UartTx { usart, byte } => { out.push(6); out.push(*usart as i32); out.push(*byte as i32); }
                    VmEvent::ExtiEdge { line } => { out.push(7); out.push(*line as i32); }
                    VmEvent::AdcDone { adc, chan } => { out.push(8); out.push(*adc as i32); out.push(*chan as i32); }
                    VmEvent::TimUpdate { tim } => { out.push(9); out.push(*tim as i32); }
                    VmEvent::DacWrite { chan, value } => { out.push(10); out.push(*chan as i32); out.push(*value as i32); }
                    VmEvent::CrcResult { value } => { out.push(11); out.push(*value as i32); }
                    VmEvent::RtcAlarm { alarm } => { out.push(12); out.push(*alarm as i32); }
                    VmEvent::WdogReset { which } => { out.push(13); out.push(*which as i32); }
                    VmEvent::CanTx { can, id, len, data } => {
                        out.push(14); out.push(*can as i32); out.push(*id as i32); out.push(*len as i32);
                        for &b in data { out.push(b as i32); }
                    }
                    VmEvent::CanRx { can, id, len, data } => {
                        out.push(15); out.push(*can as i32); out.push(*id as i32); out.push(*len as i32);
                        for &b in data { out.push(b as i32); }
                    }
                    VmEvent::TimCapture { tim, ch, value } => { out.push(16); out.push(*tim as i32); out.push(*ch as i32); out.push(*value as i32); }
                    VmEvent::FsmcAccess { bank, offset, write, size, value } => {
                        out.push(17); out.push(*bank as i32); out.push(*offset as i32); out.push(if *write { 1 } else { 0 }); out.push(*size as i32); out.push(*value as i32);
                    }
                    VmEvent::UsbIn { ep, data } => {
                        out.push(18);
                        out.push(*ep as i32);
                        out.push(data.len() as i32);
                        for &b in data { out.push(b as i32); }
                    }
                    VmEvent::I2cAlert { channel, asserted } => {
                        out.push(19);
                        out.push(*channel as i32);
                        out.push(if *asserted { 1 } else { 0 });
                    }
                    VmEvent::HostTx { ch, ep, setup, data } => {
                        out.push(20);
                        out.push(*ch as i32);
                        out.push(*ep as i32);
                        out.push(if *setup { 1 } else { 0 });
                        out.push(data.len() as i32);
                        for &b in data { out.push(b as i32); }
                    }
                    VmEvent::HostRx { ch, ep, len } => {
                        out.push(21);
                        out.push(*ch as i32);
                        out.push(*ep as i32);
                        out.push(*len as i32);
                    }
                    VmEvent::ItmByte { port, byte } => {
                        out.push(22);
                        out.push(*port as i32);
                        out.push(*byte as i32);
                    }
                }
            }
            out
        }
        None => Vec::new(),
    }
}

/// Host-driven USB bus reset (SE0): device address clears, endpoints
/// reset, RESET event + IRQ — what a real plug-in sends. Returns false
/// with no USB peripheral mapped.
#[wasm_bindgen]
pub fn usb_bus_reset() -> bool {
    match try_sys() {
        Some(sys) => sys.p.usb_bus_reset(sys),
        None => false,
    }
}

/// Inject a USB SETUP packet (8 bytes) into EP0's RX buffer (host -> device).
/// `addr` selects hardware address filtering (None = correctly-addressed
/// host). Returns false when NAKed/filtered or the address is bad.
#[wasm_bindgen]
pub fn usb_inject_setup(data: &[u8], addr: Option<u8>) -> bool {
    if data.len() != 8 {
        return false;
    }
    match try_sys() {
        Some(sys) => sys.p.usb_inject(sys, 0, data, true, addr),
        None => false,
    }
}

/// Inject a USB OUT packet into an endpoint's RX buffer (host -> device).
/// `addr` selects hardware address filtering (None = correctly-addressed
/// host). Returns false when NAKed/filtered or the address is bad.
#[wasm_bindgen]
pub fn usb_inject_out(ep: u8, data: &[u8], addr: Option<u8>) -> bool {
    match try_sys() {
        Some(sys) => sys.p.usb_inject(sys, ep as usize, data, false, addr),
        None => false,
    }
}

/// Host disconnect (pull-up off): tokens stop, IN never completes, SOF
/// freezes; the next bus reset reattaches. Returns false with no USB
/// peripheral mapped.
#[wasm_bindgen]
pub fn usb_detach() -> bool {
    match try_sys() {
        Some(sys) => sys.p.usb_detach(sys),
        None => false,
    }
}

/// Inject a USB OTG_FS SETUP packet (8 bytes) into EP0's RX FIFO (host ->
/// device). `addr` selects hardware address filtering (None =
/// correctly-addressed host). Returns false when dropped.
#[wasm_bindgen]
pub fn otg_inject_setup(data: &[u8], addr: Option<u8>) -> bool {
    if data.len() != 8 {
        return false;
    }
    match try_sys() {
        Some(sys) => sys.p.otg_inject(sys, 0, data, true, addr),
        None => false,
    }
}

/// Inject a USB OTG_FS OUT packet into an endpoint's RX FIFO (host ->
/// device). `addr` selects hardware address filtering (None =
/// correctly-addressed host). Returns false when dropped.
#[wasm_bindgen]
pub fn otg_inject_out(ep: u8, data: &[u8], addr: Option<u8>) -> bool {
    match try_sys() {
        Some(sys) => sys.p.otg_inject(sys, ep as usize, data, false, addr),
        None => false,
    }
}

/// Host-driven OTG_FS bus reset (SE0): endpoints + FIFOs + address reset,
/// USBRST + ENUMDNE events. Returns false with no OTG peripheral mapped.
#[wasm_bindgen]
pub fn otg_bus_reset() -> bool {
    match try_sys() {
        Some(sys) => sys.p.otg_bus_reset(sys),
        None => false,
    }
}

/// Host disconnect on OTG_FS (pull-up off). Returns false with no OTG
/// peripheral mapped.
#[wasm_bindgen]
pub fn otg_detach() -> bool {
    match try_sys() {
        Some(sys) => sys.p.otg_detach(sys),
        None => false,
    }
}

/// Answer a pending OTG_FS host IN token on `ep` with `data` (or a STALL
/// handshake when `stall`). Returns false when no IN token is waiting.
#[wasm_bindgen]
pub fn otg_host_feed_in(ep: u8, data: &[u8], stall: bool) -> bool {
    match try_sys() {
        Some(sys) => sys.p.otg_host_feed_in(sys, ep as usize, data, stall),
        None => false,
    }
}

/// Virtual-device attach/detach on the OTG_FS host port (HPRT PCSTS
/// follows, edges raise PCDET + HPRTINT).
#[wasm_bindgen]
pub fn otg_host_attach(present: bool) -> bool {
    match try_sys() {
        Some(sys) => sys.p.otg_host_attach(sys, present),
        None => false,
    }
}

/// Queue injected MISO bytes for a SPI channel (virtual device -> MCU).
#[wasm_bindgen]
pub fn spi_inject_miso(channel: u8, bytes: &[u8]) {
    if let Some(sys) = try_sys() { sys.spi_inject_miso(channel, bytes); }
}

/// Queue injected RX bytes for an I2C channel (virtual device -> MCU).
#[wasm_bindgen]
pub fn i2c_inject_rx(channel: u8, bytes: &[u8]) {
    if let Some(sys) = try_sys() { sys.i2c_inject_rx(channel, bytes); }
}

/// Drop all queued injected RX bytes for an I2C channel. Reactive runners
/// clear-then-prefill at read-START so stale leftovers never poison the
/// front (empty queue still NACKs the address phase, as before).
#[wasm_bindgen]
pub fn i2c_clear_rx(channel: u8) {
    if let Some(sys) = try_sys() { sys.i2c_clear_rx(channel); }
}

/// Host-side I2C slave transactions: address this peripheral as a slave
/// from an external host (see `I2C1`/`I2C2` slave docs). Start NACKs when
/// the peripheral is disabled/busy/unmatched; write NACKs when not in
/// slave-RX, RXNE unread or ACK cleared; read returns -1 when not in
/// slave-TX or DR empty (stretch equivalents).
#[wasm_bindgen]
pub fn i2c_inject_start(channel: u8, addr: u16, is_read: bool) -> bool {
    match try_sys() {
        Some(sys) => sys.p.i2c_inject_start(sys, channel as u32, addr, is_read),
        None => false,
    }
}
#[wasm_bindgen]
pub fn i2c_inject_write(channel: u8, byte: u8) -> bool {
    match try_sys() {
        Some(sys) => sys.p.i2c_inject_write(sys, channel as u32, byte),
        None => false,
    }
}
#[wasm_bindgen]
pub fn i2c_inject_read(channel: u8) -> i32 {
    match try_sys() {
        Some(sys) => sys.p.i2c_inject_read(sys, channel as u32).map(|b| b as i32).unwrap_or(-1),
        None => -1,
    }
}
#[wasm_bindgen]
pub fn i2c_inject_stop(channel: u8) -> bool {
    match try_sys() {
        Some(sys) => sys.p.i2c_inject_stop(sys, channel as u32),
        None => false,
    }
}

/// SMBus ALERT input: peer pulled SMBA low on this channel → SR1 SMBALERT
/// flag (+ error IRQ when ITERREN). Returns false when disabled/no channel.
#[wasm_bindgen]
pub fn i2c_inject_alert(channel: u8) -> bool {
    match try_sys() {
        Some(sys) => sys.p.i2c_inject_alert(sys, channel as u32),
        None => false,
    }
}

/// Set an analog wire voltage on a GPIO pin (12-bit, 0xFFFF clears it).
/// ADC channels mapped to the pin then sample this voltage with an RC
/// sample-and-hold model instead of the injected simulation value.
#[wasm_bindgen]
pub fn gpio_set_analog(port: u32, pin: u32, level: u32) {
    sys().p.gpio.borrow_mut().set_analog(port as u8, pin as u8, level as u16);
}

/// RC sample-and-hold time constant in ADC cycles (1 instr = 1 cycle).
#[wasm_bindgen]
pub fn adc_set_rc_tau(cycles: u32) {
    peripherals::adc::set_adc_rc_tau(cycles.min(0xFFFF) as u16);
}

/// Configured SYSCLK in Hz decoded from RCC CFGR (HSE assumed 8 MHz).
/// Timing stays instruction-budget based; for drivers computing dividers.
#[wasm_bindgen]
pub fn rcc_sysclk_hz() -> u32 {
    match try_sys() {
        Some(sys) => sys.p.rcc_clocks().0,
        None => 8_000_000,
    }
}

/// Full configured clock tree (sysclk, hclk, pclk1, pclk2) in Hz decoded
/// from RCC CFGR HPRE/PPRE1/PPRE2 (HSE assumed 8 MHz). Audit surface for
/// the divider half of the tree; timing stays instruction-budget based.
#[wasm_bindgen]
pub fn rcc_clocks_hz() -> Vec<u32> {
    match try_sys() {
        Some(sys) => {
            let (s, h, p1, p2) = sys.p.rcc_clocks();
            vec![s, h, p1, p2]
        }
        None => vec![8_000_000, 8_000_000, 8_000_000, 8_000_000],
    }
}

/// MCO pin output in Hz from CFGR[26:24] (0 = no clock output).
#[wasm_bindgen]
pub fn rcc_mco_hz() -> u32 {
    match try_sys() {
        Some(sys) => sys.p.rcc_mco(),
        None => 0,
    }
}

/// Current PWM duty (0-100) of a timer channel; 0 if addr is not a timer.
#[wasm_bindgen]
pub fn pwm_duty(addr: u32, channel: u32) -> u32 {
    sys().p.pwm_duty(addr, channel)
}

/// PWM output pin for a timer channel (1-based timer number, 0-based
/// channel): packed (port << 4 | pin) with the live AFIO remap applied
/// (port 0=A .. 3=D), or -1 when the timer/channel has no output pin.
/// E.g. tim_chan_pin(3, 0) = 0x06 (PA6) by default. Read-only observation
/// helper for servo/LED/buzzer wiring; -1 before init too.
#[wasm_bindgen]
pub fn tim_chan_pin(timer: u8, channel: u8) -> i32 {
    match try_sys() {
        Some(sys) => sys.p.tim_chan_pin(timer as u32, channel as u32),
        None => -1,
    }
}

#[wasm_bindgen]
pub fn is_watchdog_reset_requested() -> bool {
    system::is_watchdog_reset_requested()
}

/// Inject a received byte into the UART at the given peripheral base address.
/// Returns true if a peripheral was found at that address.
#[wasm_bindgen]
pub fn uart_rx_byte(addr: u32, byte: u8) -> bool {
    sys().p.rx_byte(&*sys(), addr, byte)
}

/// Inject a LIN break (13 low bits) into the UART at the given peripheral
/// base address: LBD in LIN mode, framing error + 0x00 byte otherwise.
/// Returns true if a peripheral was found at that address.
#[wasm_bindgen]
pub fn uart_inject_break(addr: u32) -> bool {
    sys().p.rx_break(&*sys(), addr)
}

/// Number of unread bytes still queued in the UART RX buffer at addr.
#[wasm_bindgen]
pub fn uart_rx_pending(addr: u32) -> u32 {
    sys().p.rx_pending(addr)
}

/// Inject a CAN message into the CAN peripheral at the given address.
/// Returns true if the message was accepted (matched a filter and placed in a FIFO).
#[wasm_bindgen]
pub fn can_inject_message(addr: u32, tir: u32, tdtr: u32, tdlr: u32, tdhr: u32) -> bool {
    sys().p.can_inject_message(&*sys(), addr, tir, tdtr, tdlr, tdhr)
}

/// Inject an HSE clock failure (test entry point for the CSS path):
/// HSERDY clears; with CSSON set this raises CSSF, pends an NMI and falls
/// back to HSI. Returns true when CSS fired.
#[wasm_bindgen]
pub fn rcc_fail_hse() -> bool {
    sys().p.rcc_fail_hse(&*sys())
}

/// Set the modeled PWR supply in mV (test entry point for PVD ramps
/// across the PLS thresholds, default 3300). Returns the new PVDO level.
#[wasm_bindgen]
pub fn pwr_set_supply_mv(mv: u32) -> bool {
    sys().p.pwr_set_supply(&*sys(), mv)
}

/// Enable/disable the system-memory bootloader responder (AN3155 USART
/// protocol on USART1). While enabled it claims USART1 RX and answers the
/// host flashing flow instead of the USART model.
#[wasm_bindgen]
pub fn bootloader_enable(on: bool) {
    peripherals::bootloader::set_enabled(on);
}

/// Last GO target address issued to the bootloader, or -1 when none.
#[wasm_bindgen]
pub fn bootloader_go_addr() -> i32 {
    peripherals::bootloader::go_addr().map(|a| a as i32).unwrap_or(-1)
}

/// Board identity block (BOOT/RST buttons + LED + clock note). One call
/// replaces per-board docs lookups for drivers: the model only knows
/// reset/boot *semantics* (BOOT0 held at reset → bootloader on USART1;
/// NRST → AIRCR SYSRESETREQ), but a widget layer needs the hardware
/// facts too (which LED lights, which user button exists per board).
///
/// `chip`: 0=f103c8/cb pill, 1=maple_mini, 2=nucleo_f103rb,
/// 3=f103rc, 4=f105, 5=gd32 pills. Returns
/// [led_port, led_pin, btn_port, btn_pin, btn_level, boot_present,
///  nrst_present, crystal_hz, max_sysclk_mhz]:
/// - LED: (port 0=A/1=B/2=C, pin) driven by firmware.
/// - BTN: user button (port, pin, active level); Maple BUT=PB8/LOW,
///   Nucleo B1=PC13/HIGH, pills have NO user button (port = 0xFF).
/// - boot_present/nrst_present: every board in the table has both.
/// - crystal/fonts: 8 MHz HSE everywhere modeled; max SYSCLK 72 MHz
///   (instruction-budget timing — see `rcc_clocks_hz`).
#[wasm_bindgen]
pub fn board_info(chip: u32) -> Vec<u32> {
    match chip {
        1 => vec![1, 1, 1, 8, 0, 1, 1, 8_000_000, 72], // PB1 LED, PB8 BUT
        2 => vec![0, 5, 2, 13, 1, 1, 1, 8_000_000, 72], // PA5 LD2, PC13 B1
        _ => vec![2, 13, 0xFF, 0xFF, 0, 1, 1, 8_000_000, 72], // PC13 LED, no BTN
    }
}

/// BOOT0 strap state (false = BOOT0 low = boot main flash, the power-on
/// default; true = BOOT0 high = boot system memory / bootloader path).
/// Read by `board_nrst()` at reset. JS drives the page BOOT0 jumper.
static BOOT_PIN_HIGH: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Set the BOOT0 strap level (page BOOT0 jumper / host-driven probe).
#[wasm_bindgen]
pub fn board_boot0(high: bool) {
    BOOT_PIN_HIGH.store(high, std::sync::atomic::Ordering::Relaxed);
}

/// Read back the BOOT0 strap level.
#[wasm_bindgen]
pub fn board_boot0_get() -> bool {
    BOOT_PIN_HIGH.load(std::sync::atomic::Ordering::Relaxed)
}

/// NRST press: full model reset — INSTRUCTION_COUNT to zero (all
/// instruction-delta peripherals rebase; without this a post-reset tick
/// sees now=0 against stale last_tick≈200K and every peripheral tries to
/// "catch up" 200K ticks at once — the USART TXE storm wedged Node in
/// process_batch), model-wide NVIC/DMA/event state cleared, pins,
/// bootloader claim, debug mirrors.
/// NOTE: the *native CPU + guest RAM* live in the driver (emulator.js
/// recreates them via its own `reset()` path + firmware reload; this
/// export only resets the map-independent model state). Returns 1 when
/// the bootloader path is taken, else 0.
#[wasm_bindgen]
pub fn board_nrst() -> u32 {
    let boot = BOOT_PIN_HIGH.load(std::sync::atomic::Ordering::Relaxed);
    // Fresh model state (mirrors init(): counters, pins, bootloader).
    system::INSTRUCTION_COUNT.store(0, std::sync::atomic::Ordering::Relaxed);
    peripherals::gpio::clear_pin_events();
    peripherals::bootloader::reset();
    peripherals::bootloader::set_enabled(boot);
    system::reset_debug_mirrors();
    // Model-wide NVIC state (the old SYS is dropped on the floor — its
    // NVIC keeps pending/active/priority/debt/SysTick phase from the
    // pre-reset run, and the next tick/dispatch wedges on it: USART1 TXE
    // (IRQ37, ISER-kept-enabled + SR-kept-set) re-pends forever into a
    // raised active-priority ceiling, so process_batch never returns).
    // NVIC/SysTick have no guest-visible reset hook, so clear here.
    {
        let sys = crate::sys();
        // Rebase FIRST (borrows each peripheral slot one at a time; the
        // NVIC borrow below must not be held across it — rebase itself
        // touches sys.p.nvic for the SysTick phase, nesting borrow_mut on
        // the same RefCell panics "already borrowed").
        sys.p.rebase_clocks(sys, 0);
        let mut nvic = sys.p.nvic.borrow_mut();
        *nvic = crate::peripherals::nvic::Nvic::default();
        sys.pending_dma.borrow_mut().clear();
        sys.absorb_buf.borrow_mut().clear();
        sys.event_queue.borrow_mut().clear();
        sys.i2c_dr_hook.set(false);
    }
    // NOTE: the native CPU + guest RAM are NOT touched here — they belong
    // to the driver (emulator.js re-inits + reloads firmware in its own
    // `reset()` right after this call). Clearing NATIVE here orphaned the
    // CPU mid-session: the next rustcpu_run panicked ("backend not
    // initialized") and the wasm `expect` unwind wedged Node (bisect27).
    // NOTE: the peripheral map itself is NOT rebuilt here (the active map —
    // hardcoded F103 vs F105 SVD — is chosen at init; rebuilding the wrong
    // one would silently switch an F105 board to F103). The driver reloads
    // firmware + CPU around this call anyway.
    if boot { 1 } else { 0 }
}

/// Power-state mapping (pure, unit-tested): 0=RUN, 1=SLEEP (WFI, no deep),
/// 2=STOP (WFI + SLEEPDEEP), 3=STANDBY (WFI + SLEEPDEEP + PWR PDDS).
pub fn pwr_mode_of(sleeping: bool, deep: bool, standby_sel: bool) -> u32 {
    match (sleeping, deep, standby_sel) {
        (true, true, true) => 3,
        (true, true, false) => 2,
        (true, false, _) => 1,
        (false, _, _) => 0,
    }
}

/// Live power state from the model (0=RUN, 1=SLEEP, 2=STOP, 3=STANDBY).
/// Truthful mode tracking for tests and host tools; current-draw numbers
/// stay a documented estimate (DS5319-typical, uncalibrated — see
/// docs/PERIPHERALS.md), not a modeled quantity.
#[wasm_bindgen]
pub fn pwr_mode() -> u32 {
    match try_sys() {
        Some(sys) => {
            let sleeping = system::CPU_SLEEPING.load(std::sync::atomic::Ordering::Relaxed);
            pwr_mode_of(sleeping, sys.p.in_deep_sleep(), sys.p.pwr_standby())
        }
        None => 0,
    }
}

/// Current-draw estimate in µA (pure formula, unit-tested). DS5319-typical
/// orders, NOT calibrated: RUN scales ~linearly with SYSCLK on a 4 mA base,
/// SLEEP keeps 70% (peripherals clocked, CPU gated), STOP depends on the
/// regulator (LPDS), STANDBY is RTC-domain leakage. Treat ±2× as honest.
pub fn pwr_estimate_ua(mode: u32, sysclk_hz: u32, lpds: bool) -> u32 {
    let run = 4_000 + (32_000u64 * sysclk_hz.min(72_000_000) as u64 / 72_000_000) as u32;
    match mode {
        3 => 4,
        2 => {
            if lpds {
                15
            } else {
                40
            }
        }
        1 => run * 70 / 100,
        _ => run,
    }
}

/// Live current-draw estimate in µA (see `pwr_estimate_ua` for the caveats).
#[wasm_bindgen]
pub fn pwr_estimate() -> u32 {
    match try_sys() {
        Some(sys) => {
            let sleeping = system::CPU_SLEEPING.load(std::sync::atomic::Ordering::Relaxed);
            let mode = pwr_mode_of(sleeping, sys.p.in_deep_sleep(), sys.p.pwr_standby());
            pwr_estimate_ua(mode, sys.p.rcc_clocks().0, sys.p.pwr_low_power_reg())
        }
        None => 0,
    }
}

/// Collect UART output since last call.
#[wasm_bindgen]
pub fn get_uart_output() -> String {
    use std::mem::take;
    take(&mut *system::get_uart_output().lock().unwrap())
}

/// Add an SPI flash device. Must be called before init().
#[wasm_bindgen]
pub fn add_spi_flash(peripheral: &str, jedec_id: u32, data: &[u8], cs: Option<String>) {    use crate::ext_devices::spi_flash::{SpiFlash, SpiFlashConfig};
    let config = SpiFlashConfig {
        peripheral: peripheral.to_string(),
        jedec_id,
        content: data.to_vec(),
        size: data.len(),
        cs,
    };
    let flash = SpiFlash::new(config);
    system::get_ext_devices().lock().unwrap().spi_flashes
        .push(std::rc::Rc::new(std::cell::RefCell::new(flash)));
}

/// Add an I2C EEPROM device. Must be called before init().
#[wasm_bindgen]
pub fn add_i2c_eeprom(peripheral: &str, address: u8, data: &[u8]) {
    use crate::ext_devices::i2c_eeprom::{I2cEeprom, I2cEepromConfig};
    let config = I2cEepromConfig {
        peripheral: peripheral.to_string(),
        address,
        content: data.to_vec(),
        size: data.len(),
    };
    let eeprom = I2cEeprom::new(config);
    system::get_ext_devices().lock().unwrap().i2c_eeproms
        .push(std::rc::Rc::new(std::cell::RefCell::new(eeprom)));
}

/// Raise a fault (kind: 0=fetch, 1=data read, 2=data write, 3=undef instruction).
/// Sets SCB CFSR/HFSR/BFAR and pends the fault exception (with SHCSR escalation
/// to HardFault when the specific fault handler is disabled).
#[wasm_bindgen]
pub fn raise_fault(kind: u32, addr: u32) {
    sys().p.raise_fault(&*sys(), kind, addr);
}

/// Add an SD card image for the SDIO peripheral (SDHC, 512 B sectors).
/// Must be called before init().
#[wasm_bindgen]
pub fn add_sd_card(peripheral: &str, data: &[u8]) {
    use crate::ext_devices::sd_card::SdCard;
    let card = std::rc::Rc::new(std::cell::RefCell::new(SdCard::new(peripheral, data)));
    system::get_ext_devices().lock().unwrap().sd_cards.push(card);
}

/// Add an FSMC NOR/PSRAM memory device backed by `data` (byte image).
/// `name` must be FSMC.BANK1..4 (NE1-4), FSMC.BANK5..6 (NAND), or FSMC.BANK7
/// (PC Card). Must be called before init().
#[wasm_bindgen]
pub fn add_fsmc_bank(name: &str, data: &[u8]) {
    use crate::ext_devices::fsmc_nor::FsmcNor;
    let bank = std::rc::Rc::new(std::cell::RefCell::new(FsmcNor::new(name, data)));
    system::get_ext_devices().lock().unwrap().fsmc_nors.push(bank);
}

/// Write a byte directly into an FSMC backing image (bypasses the peripheral
/// bus — no events, no side effects).  Returns true on success.
/// Use this from JS virtual peripherals to feed read-back data to the MCU.
#[wasm_bindgen]
pub fn fsmc_write_byte(name: &str, offset: u32, value: u8) -> bool {
    let ext = system::get_ext_devices().lock().unwrap();
    for bank in &ext.fsmc_nors {
        if bank.borrow().name() == name {
            let mut b = bank.borrow_mut();
            let i = offset as usize;
            if i < b.data.len() {
                b.data[i] = value;
                return true;
            }
            return false;
        }
    }
    false
}

/// Read a byte from an FSMC backing image (bypasses the peripheral bus).
/// Returns the byte value (0..255) or -1 if the bank/offset is invalid.
#[wasm_bindgen]
pub fn fsmc_read_byte(name: &str, offset: u32) -> i32 {
    let ext = system::get_ext_devices().lock().unwrap();
    for bank in &ext.fsmc_nors {
        if bank.borrow().name() == name {
            let b = bank.borrow();
            let i = offset as usize;
            if i < b.data.len() {
                return b.data[i] as i32;
            }
            return -1;
        }
    }
    -1
}

#[wasm_bindgen]
pub fn adc_set_sim_value(val: u16) {
    peripherals::adc::set_adc_value(val);
}

/// Override an internal ADC channel (16=temp, 17=VREFINT, 18=VBAT) with a
/// 12-bit value; pass 65535 (u16::MAX) to clear back to nominal.
#[wasm_bindgen]
pub fn adc_set_internal(channel: u8, val: u16) {
    peripherals::adc::set_adc_internal(channel, val);
}

/// Register a software SPI device. Must be called before init().
#[wasm_bindgen]
pub fn add_software_spi(name: &str, cs: Option<String>, clk: &str, miso: &str, mosi: &str) {
    system::get_software_spi_configs().lock().unwrap()
        .push((name.to_string(), cs, clk.to_string(), miso.to_string(), mosi.to_string()));
}

/// Add an SPI LCD display device (e.g. ST7789, ILI9341). Must be called before init().
#[wasm_bindgen]
pub fn add_lcd(peripheral: &str, cs: Option<String>) {
    use crate::ext_devices::lcd::{Lcd, LcdConfig};
    let config = LcdConfig {
        peripheral: peripheral.to_string(),
        framebuffer: String::new(),
        cs,
    };
    let lcd = Lcd::new(config);
    system::get_ext_devices().lock().unwrap().lcds
        .push(std::rc::Rc::new(std::cell::RefCell::new(lcd)));
}

/// Add an I2C OLED display device (e.g. SSD1306). Must be called before init().
#[wasm_bindgen]
pub fn add_i2c_oled(peripheral: &str, address: u8, width: u16, height: u16) {
    use crate::ext_devices::i2c_oled::{I2cOled, I2cOledConfig};
    let config = I2cOledConfig {
        peripheral: peripheral.to_string(),
        address,
        width,
        height,
    };
    let oled = I2cOled::new(config);
    system::get_ext_devices().lock().unwrap().i2c_oleds
        .push(std::rc::Rc::new(std::cell::RefCell::new(oled)));
}

/// Register a touchscreen device. Must be called before init().
#[wasm_bindgen]
pub fn add_touchscreen(peripheral: &str, touch_detected_pin: Option<String>, cs: Option<String>) {
    use crate::ext_devices::touchscreen::{Touchscreen, TouchscreenConfig};
    let config = TouchscreenConfig {
        peripheral: peripheral.to_string(),
        framebuffer: String::new(),
        flip_x: None,
        flip_y: None,
        swap_x_y: None,
        touch_detected_pin,
        scale_down: None,
        cs,
    };
    let ts = Touchscreen::new(config);
    system::get_ext_devices().lock().unwrap().touchscreens
        .push(std::rc::Rc::new(std::cell::RefCell::new(ts)));
}

/// Set touch coordinates on a touchscreen device. Must be called after init().
#[wasm_bindgen]
pub fn touchscreen_set_touch(peripheral: &str, x: u16, y: u16, pressure: u16) {
    let et = system::get_ext_devices().lock().unwrap();
    for ts in &et.touchscreens {
        if ts.borrow().config.peripheral == peripheral {
            ts.borrow_mut().set_touch(x, y, pressure);
            break;
        }
    }
}

/// Read back an SPI LCD display's framebuffer (128x64, 1 byte per pixel).
#[wasm_bindgen]
pub fn lcd_fb(peripheral: &str) -> Vec<u8> {
    let et = system::get_ext_devices().lock().unwrap();
    for d in &et.lcds {
        if d.borrow().config.peripheral == peripheral {
            return d.borrow().fb.clone();
        }
    }
    Vec::new()
}

/// Read back an I2C OLED display's framebuffer (page-major, 1 byte per column).
#[wasm_bindgen]
pub fn i2c_oled_fb(peripheral: &str, address: u32) -> Vec<u8> {
    let et = system::get_ext_devices().lock().unwrap();
    for d in &et.i2c_oleds {
        if d.borrow().config.peripheral == peripheral && d.borrow().config.address as u32 == address {
            return d.borrow().framebuffer().to_vec();
        }
    }
    Vec::new()
}

/// Debug: bytes the I2C OLED device received (should be ~1K+ for a full frame).
#[wasm_bindgen]
pub fn i2c_oled_writes(peripheral: &str, address: u32) -> u64 {
    let et = system::get_ext_devices().lock().unwrap();
    for d in &et.i2c_oleds {
        if d.borrow().config.peripheral == peripheral && d.borrow().config.address as u32 == address {
            return d.borrow().write_count;
        }
    }
    0
}


#[cfg(test)]
mod lib_tests {
    use super::pwr_mode_of;

    #[test]
    fn power_state_mapping() {
        assert_eq!(pwr_mode_of(false, false, false), 0); // RUN
        assert_eq!(pwr_mode_of(false, true, true), 0); // awake beats config
        assert_eq!(pwr_mode_of(true, false, false), 1); // SLEEP
        assert_eq!(pwr_mode_of(true, false, true), 1); // PDDS irrelevant awake-shallow
        assert_eq!(pwr_mode_of(true, true, false), 2); // STOP
        assert_eq!(pwr_mode_of(true, true, true), 3); // STANDBY
    }

    #[test]
    fn power_estimate_ordering() {
        use super::pwr_estimate_ua;
        let run = pwr_estimate_ua(0, 72_000_000, false);
        let sleep = pwr_estimate_ua(1, 72_000_000, false);
        let stop = pwr_estimate_ua(2, 72_000_000, false);
        let stop_lp = pwr_estimate_ua(2, 72_000_000, true);
        let standby = pwr_estimate_ua(3, 72_000_000, false);
        assert!(standby < stop_lp && stop_lp < stop && stop < sleep && sleep < run);
        assert_eq!(run, 36_000);
        // RUN scales ~linearly with SYSCLK.
        assert!(pwr_estimate_ua(0, 8_000_000, false) < run);
        assert_eq!(pwr_estimate_ua(0, 8_000_000, false), 4_000 + 32_000 * 8 / 72);
    }
}
