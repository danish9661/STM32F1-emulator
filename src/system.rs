use std::sync::atomic::{AtomicU32, AtomicU64, AtomicBool, AtomicI32, AtomicU8, Ordering};
use std::cell::RefCell;
use std::cell::Cell;
use std::rc::Rc;
use std::collections::HashMap;
use std::sync::Mutex;
use crate::peripherals::{Peripherals, gpio::GpioPorts};
use crate::ext_devices::ExtDevices;

// UART output buffer: USART write_dr pushes chars here, JS reads via get_uart_output()
use std::sync::OnceLock;
static UART_OUTPUT: OnceLock<Mutex<String>> = OnceLock::new();
pub fn get_uart_output() -> &'static Mutex<String> {
    UART_OUTPUT.get_or_init(|| Mutex::new(String::new()))
}

// Global ExtDevices: populated by JS add_* calls before init
static EXT_DEVICES: OnceLock<Mutex<ExtDevices>> = OnceLock::new();
pub fn get_ext_devices() -> &'static Mutex<ExtDevices> {
    EXT_DEVICES.get_or_init(|| Mutex::new(ExtDevices::default()))
}

pub static INSTRUCTION_COUNT: AtomicU64 = AtomicU64::new(0);
pub fn instruction_count() -> u64 { INSTRUCTION_COUNT.load(Ordering::Relaxed) }

/// Live WFI/WFE sleep mirror for power-state queries (pwr_mode): set when
/// the core halts in WFI/WFE, cleared on exception entry and reset. One
/// relaxed store at three cold sites; the hot loop never touches it.
pub static CPU_SLEEPING: AtomicBool = AtomicBool::new(false);

// Interrupt masks set by JS from CPU state on each batch.
pub static INTR_MASK_PRIMASK: AtomicU32 = AtomicU32::new(0);
pub static INTR_MASK_BASEPRI: AtomicU32 = AtomicU32::new(0);

static WATCHDOG_RESET: AtomicBool = AtomicBool::new(false);

// Software SPI configs queued before init, registered after GPIO exists
static SOFTWARE_SPI_CONFIGS: OnceLock<Mutex<Vec<(String, Option<String>, String, String, String)>>> = OnceLock::new();
pub fn get_software_spi_configs() -> &'static Mutex<Vec<(String, Option<String>, String, String, String)>> {
    SOFTWARE_SPI_CONFIGS.get_or_init(|| Mutex::new(Vec::new()))
}
pub fn is_watchdog_reset_requested() -> bool { WATCHDOG_RESET.swap(false, Ordering::Acquire) }
pub fn request_watchdog_reset() { WATCHDOG_RESET.store(true, Ordering::Release); }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DmaDir { Read, Write, MemCopy }

#[derive(Debug, Clone)]
pub struct DmaTransfer {
    pub direction: DmaDir,
    pub stream_idx: usize,
    pub dma_name: String,
    pub src: u32,
    pub dst: u32,
    pub size: usize,
    pub peri_addr: u32,
    pub peripheral: bool,
}

impl DmaTransfer {
    pub fn to_u32_vec(&self) -> Vec<u32> {
        vec![
            self.direction as u32,
            self.stream_idx as u32,
            self.src,
            self.dst,
            self.size as u32,
            self.peri_addr,
            self.peripheral as u32,
        ]
    }
}

static DMA_COMPLETION_BITS: AtomicU32 = AtomicU32::new(0);

// Per-stream DMA interrupt info: IRQ number (-1 = none) and flags (bit 0=TCIE, 1=HTIE, 2=TEIE).
// Streams are GLOBAL across both DMAs (DMA1 ch0-6 -> 0-6, DMA2 ch0-4 -> 7-11).
static DMA_STREAM_IRQ: [AtomicI32; 12] = [
    AtomicI32::new(-1), AtomicI32::new(-1), AtomicI32::new(-1), AtomicI32::new(-1),
    AtomicI32::new(-1), AtomicI32::new(-1), AtomicI32::new(-1), AtomicI32::new(-1),
    AtomicI32::new(-1), AtomicI32::new(-1), AtomicI32::new(-1), AtomicI32::new(-1),
];
static DMA_STREAM_FLAGS: [AtomicU8; 12] = [
    AtomicU8::new(0), AtomicU8::new(0), AtomicU8::new(0), AtomicU8::new(0),
    AtomicU8::new(0), AtomicU8::new(0), AtomicU8::new(0), AtomicU8::new(0),
    AtomicU8::new(0), AtomicU8::new(0), AtomicU8::new(0), AtomicU8::new(0),
];

pub fn set_dma_intr_info(stream_idx: usize, irq: i32, flags: u8) {
    if stream_idx < 12 {
        DMA_STREAM_IRQ[stream_idx].store(irq, Ordering::Release);
        DMA_STREAM_FLAGS[stream_idx].store(flags, Ordering::Release);
    }
}

/// Virtual-peripheral transaction events drained by JS via `drain_events()`.
#[derive(Debug, Clone)]
pub enum VmEvent {
    SpiTransfer { channel: u8, tx: Vec<u8>, rx: Vec<u8> },
    I2cStart { channel: u8, addr: u8 },
    I2cWrite { channel: u8, byte: u8 },
    I2cRead { channel: u8 },
    I2cStop { channel: u8 },
    UartTx { usart: u8, byte: u8 },
    ExtiEdge { line: u8 },
    AdcDone { adc: u8, chan: u8 },
    TimUpdate { tim: u8 },
    DacWrite { chan: u8, value: u32 },
    CrcResult { value: u32 },
    RtcAlarm { alarm: u32 },
    WdogReset { which: u8 },
    CanTx { can: u8, id: u32, len: u8, data: [u8; 8] },
    CanRx { can: u8, id: u32, len: u8, data: [u8; 8] },
    TimCapture { tim: u8, ch: u8, value: u32 },
    FsmcAccess { bank: u8, offset: u32, write: bool, size: u8, value: u32 },
    UsbIn { ep: u8, data: Vec<u8> },
    I2cAlert { channel: u8, asserted: bool },
    /// OTG_FS host-mode OUT/SETUP completion (host -> device bytes).
    HostTx { ch: u8, ep: u8, setup: bool, data: Vec<u8> },
    /// OTG_FS host-mode IN token request (device -> host): feed with
    /// otg_host_feed_in.
    HostRx { ch: u8, ep: u8, len: u32 },
    /// ARM ITM stimulus port 0 byte (firmware printf channel).
    ItmByte { port: u8, byte: u8 },
}

/// ARMv7-M MPU region (RBAR + RASR shadows). Plain Copy data behind one
/// Cell on WasmSystem: config writes are rare, checks are hot.
#[derive(Debug, Clone, Copy, Default)]
pub struct MpuRegion {
    pub rbar: u32,
    pub rasr: u32,
}

/// Mirrored MPU-enable flag for the per-access fast path.
///
/// Reading `WasmSystem.mpu.ctrl` requires `crate::sys()` (static load +
/// expect branch) plus a method call — ~500M evaluations per 200M-instruction
/// run made that ~45% of runtime even with the check itself inlined. This
/// mirror collapses the fast path to one `global.get` + branch with zero
/// calls. Synced on init() and every MPU CTRL write (single-threaded wasm:
/// plain Relaxed load/store, always coherent).
/// Plain (non-atomic) bool: single-threaded wasm needs no atomics, and
/// `i32.atomic.load` codegen costs measurably more than `global.get` here.
/// Same `addr_of!` pattern as SYS (2024-edition `static_mut_refs` lint).
static mut MPU_ON: bool = false;

/// Fast-path MPU gate: true only while the MPU is enabled.
#[inline(always)]
pub(crate) fn mpu_gate_on() -> bool {
    unsafe { *std::ptr::addr_of!(MPU_ON) }
}

/// Sync the fast-path mirror from live CTRL state. Call after install and
/// after any CTRL write.
pub(crate) fn sync_mpu_gate(sys: &WasmSystem) {
    unsafe { *std::ptr::addr_of_mut!(MPU_ON) = sys.mpu.enabled(); }
}

/// Debug-halt mirror for the CPU hot loop (DHCSR C_HALT / watchpoint trip /
/// VC_HARDERR). Same plain-static discipline as MPU_ON: one `global.get` +
/// branch per instruction, synced only on debug-state writes (cold).
static mut DEBUG_HALT: bool = false;

/// Watchpoint-armed mirror for the memory hot paths (read8/write8). One
/// load + branch per guest data access when disarmed (zero when... — the
/// branch is always evaluated, but predicted-not-taken; fetches bypass it
/// entirely via read16_raw). Synced on watch add/remove only.
static mut WATCH_ON: bool = false;

/// Hot-loop halt check (cpu run + dispatch entry).
#[inline(always)]
pub(crate) fn debug_halted() -> bool {
    unsafe { *std::ptr::addr_of!(DEBUG_HALT) }
}

/// Hot-path watch gate (FlatMemory read8/write8).
#[inline(always)]
pub(crate) fn watch_on() -> bool {
    unsafe { *std::ptr::addr_of!(WATCH_ON) }
}

pub(crate) fn set_debug_halt(h: bool) {
    unsafe { *std::ptr::addr_of_mut!(DEBUG_HALT) = h; }
}

/// Sync halt from DHCSR C bits: halted = C_DEBUGEN && C_HALT.
pub(crate) fn sync_debug_halt_from_dhcsr(dhcsr: u32) {
    unsafe { *std::ptr::addr_of_mut!(DEBUG_HALT) = dhcsr & 3 == 3; }
}

pub(crate) fn sync_watch_gate(swd: &crate::peripherals::swd::SwdState) {
    unsafe { *std::ptr::addr_of_mut!(WATCH_ON) = swd.any_watch(); }
}

/// Fresh-install reset (init/init_svd build a default SwdState anyway; this
/// clears the process-wide mirrors).
pub(crate) fn reset_debug_mirrors() {
    unsafe {
        *std::ptr::addr_of_mut!(DEBUG_HALT) = false;
        *std::ptr::addr_of_mut!(WATCH_ON) = false;
    }
}

/// ARMv7-M MPU state: 8 regions + control + fault mirrors + the CPU's
/// current privilege (maintained by the core on MSR CONTROL and exception
/// transitions — FlatMemory has no CPU context of its own).
/// Semantics: docs/CPU.md "Memory protection"; AP table verified against
/// the ARMv7-M ARM (v7-M 0b111 == 0b110: RO/RO) and CMSIS core_cm3.h.
///
/// Layout note: field-level Cells, NOT Cell<MpuState> — `enabled()` must stay
/// a single load. (Measured: the per-access cost was the sys()+call overhead,
/// not struct copies; the hot path avoids calls entirely via MPU_ON above.)
#[derive(Debug)]
pub struct MpuState {
    pub ctrl: Cell<u32>,
    pub rnr: Cell<u8>,
    pub privileged: Cell<bool>,
    pub mmfsr: Cell<u8>,
    pub mmfar: Cell<u32>,
    pub mmfar_valid: Cell<bool>,
    pub regions: [Cell<MpuRegion>; 8],
}

impl Default for MpuState {
    fn default() -> Self {
        Self {
            ctrl: Cell::new(0),
            rnr: Cell::new(0),
            privileged: Cell::new(true), // reset state is privileged
            mmfsr: Cell::new(0),
            mmfar: Cell::new(0),
            mmfar_valid: Cell::new(false),
            regions: std::array::from_fn(|_| Cell::new(MpuRegion::default())),
        }
    }
}

/// Private Peripheral Bus: always privileged-accessible, unprivileged-
/// inaccessible and non-executable, regardless of MPU configuration.
fn in_ppb(addr: u32) -> bool {
    (0xE000_0000..0xE001_0000).contains(&addr)
}

impl MpuState {
    #[inline(always)]
    pub fn enabled(&self) -> bool {
        self.ctrl.get() & 1 != 0
    }

    pub(crate) fn sel(&self) -> usize {
        (self.rnr.get() & 7) as usize
    }

    /// Test-only region programmer (bypasses RBAR/RASR ordering).
    #[cfg(test)]
    fn set_region(&self, idx: usize, rbar: u32, rasr: u32) {
        self.regions[idx].set(MpuRegion { rbar, rasr });
    }

    /// Highest-numbered enabled region containing `addr`: (base, size,
    /// rasr). A subregion disabled via SRD does not match (falls through to
    /// lower regions). Sizes < 32 B (SIZE field 0/1, reserved) never match.
    fn match_region(&self, addr: u64) -> Option<(u64, u64, u32)> {
        for slot in self.regions.iter().rev() {
            let r = slot.get();
            if r.rasr & 1 == 0 {
                continue;
            }
            let size_field = (r.rasr >> 1) & 0x1F;
            if size_field < 2 {
                continue;
            }
            let size: u64 = 1u64 << (size_field + 1);
            let base: u64 = (r.rbar as u64) & !(size - 1);
            if addr.wrapping_sub(base) >= size {
                continue;
            }
            if size >= 256 {
                let sub = ((addr - base) / (size / 8)) as u32;
                if (r.rasr >> (8 + sub)) & 1 != 0 {
                    continue;
                }
            }
            return Some((base, size, r.rasr));
        }
        None
    }

    /// AP[2:0] gate for the current privilege. Table (ARMv7-M):
    /// 000 none; 001 priv-RW; 010 priv-RW/user-RO; 011 full; 100 reserved
    /// (deny); 101 priv-RO; 110/111 RO/RO.
    fn ap_allows(&self, ap: u32, write: bool) -> bool {
        let priv_ = self.privileged.get();
        if write {
            // Writable: full(3), or any priv-RW bit with privilege.
            ap == 3 || (priv_ && (ap == 1 || ap == 2))
        } else {
            // Readable: everything except none(0)/reserved(4); 1 and 5 need priv.
            match ap {
                0 | 4 => false,
                1 | 5 => priv_,
                _ => true,
            }
        }
    }

    fn region_allows(&self, rasr: u32, write: bool) -> bool {
        self.ap_allows((rasr >> 24) & 7, write)
    }

    /// Data access gate. Unmatched addresses use the background map, which
    /// needs PRIVDEFENA + privilege.
    pub fn data_allow(&self, addr: u32, write: bool) -> bool {
        if !self.enabled() {
            return true;
        }
        if in_ppb(addr) {
            return self.privileged.get();
        }
        match self.match_region(addr as u64) {
            Some((_, _, rasr)) => self.region_allows(rasr, write),
            None => self.privileged.get() && (self.ctrl.get() & 4 != 0),
        }
    }

    /// Instruction-fetch gate: needs read permission for the current
    /// privilege plus XN clear (executable implies readable on v7-M).
    /// PPB is never executable.
    pub fn exec_allow(&self, addr: u32) -> bool {
        if !self.enabled() {
            return true;
        }
        if in_ppb(addr) {
            return false;
        }
        match self.match_region(addr as u64) {
            Some((_, _, rasr)) => self.region_allows(rasr, false) && (rasr & (1 << 28)) == 0,
            None => self.privileged.get() && (self.ctrl.get() & 4 != 0),
        }
    }
}

pub struct WasmSystem {
    pub p: Rc<Peripherals>,    pub pending_dma: RefCell<Vec<DmaTransfer>>,
    pub absorb_buf: RefCell<Vec<u8>>,
    /// Virtual-peripheral transaction event queue (SPI/I2C/USART), drained by JS.
    pub event_queue: RefCell<Vec<VmEvent>>,
    /// Injected MISO bytes per SPI channel (virtual device -> MCU).
    pub spi_miso: RefCell<HashMap<u8, Vec<u8>>>,
    /// Injected RX bytes per I2C channel (virtual device -> MCU).
    pub i2c_rx: RefCell<HashMap<u8, Vec<u8>>>,
    /// Interrupt-dispatch policy state (batch budget) — shared by every
    /// driver loop so dispatch stays identical.
    pub intr: RefCell<crate::interrupts::IntrDispatch>,
    /// ARMv7-M MPU state (registers live in the SCB delegate to this).
    pub mpu: MpuState,
    /// ARM debug-port slice (SWD DP + MEM-AP + DHCSR/DCRSR/DCRDR/DEMCR +
    /// watchpoints + JTAG TAP). Registers live in the SCB delegate here.
    pub swd: crate::peripherals::swd::SwdState,
    /// Set when I2C1 DR is written with the R-bit set; the native driver
    /// drains it per batch for the hi2c Mode RAM patch (same condition as
    /// the former JS mem hook). Taken (cleared) on read.
    pub i2c_dr_hook: Cell<bool>,
}

impl WasmSystem {
    pub fn new() -> Self {
        let gpio = GpioPorts::default();
        let ext = get_ext_devices().lock().unwrap();
        let p = Rc::new(Peripherals::new_wasm(gpio, &*ext));
        drop(ext);
        Self::register_software_spis(&p);
        Self::register_touchscreen_gpios(&p);
        WasmSystem { p, pending_dma: RefCell::new(Vec::new()), absorb_buf: RefCell::new(Vec::new()),
            event_queue: RefCell::new(Vec::new()), spi_miso: RefCell::new(HashMap::new()),
            i2c_rx: RefCell::new(HashMap::new()), intr: RefCell::new(crate::interrupts::IntrDispatch::default()),
            i2c_dr_hook: Cell::new(false), mpu: MpuState::default(), swd: crate::peripherals::swd::SwdState::default() }
    }

    pub fn new_svd(svd_xml: &str) -> Self {
        let gpio = GpioPorts::default();
        let ext = get_ext_devices().lock().unwrap();
        let p = Rc::new(Peripherals::from_svd(svd_xml, gpio, &*ext));
        drop(ext);
        Self::register_software_spis(&p);
        Self::register_touchscreen_gpios(&p);
        WasmSystem { p, pending_dma: RefCell::new(Vec::new()), absorb_buf: RefCell::new(Vec::new()),
            event_queue: RefCell::new(Vec::new()), spi_miso: RefCell::new(HashMap::new()),
            i2c_rx: RefCell::new(HashMap::new()), intr: RefCell::new(crate::interrupts::IntrDispatch::default()),
            i2c_dr_hook: Cell::new(false), mpu: MpuState::default(), swd: crate::peripherals::swd::SwdState::default() }
    }

    /// Record the CPU's current privilege for MPU checks (FlatMemory has no
    /// CPU context of its own). Called on MSR CONTROL, exception entry
    /// (always privileged) and exception return.
    pub fn set_privileged(&self, priv_: bool) {
        self.mpu.privileged.set(priv_);
    }

    /// MPU-gated CPU data access. Fast no-op unless the MPU is enabled.
    /// Denials record MMFSR/MMFAR + pend MemManage (escalating to HardFault
    /// without MEMFAULTENA) and report false (readers return 0, writers drop).
    /// Inlined hot path: one flag load + branch when the MPU is off
    /// (the common case) — the region scan lives in the cold outline below
    /// so the per-access cost collapses to ~2 wasm ops after inlining.
    #[inline(always)]
    pub fn mpu_check_data(&self, addr: u32, write: bool) -> bool {
        if !self.mpu.enabled() {
            return true;
        }
        Self::mpu_check_data_slow(self, addr, write)
    }

    #[cold]
    #[inline(never)]
    pub(crate) fn mpu_check_data_slow(&self, addr: u32, write: bool) -> bool {
        if self.mpu.data_allow(addr, write) {
            return true;
        }
        self.report_memmanage(addr, false);
        false
    }

    /// MPU-gated instruction fetch. Denials report like data faults (IACCVIOL,
    /// no MMFAR) and report false; the core then halts loudly via CpuFault
    /// instead of silently running forbidden code.
    /// Inlined hot path (see mpu_check_data): one flag load + branch.
    #[inline(always)]
    pub fn mpu_check_exec(&self, addr: u32) -> bool {
        if !self.mpu.enabled() {
            return true;
        }
        Self::mpu_check_exec_slow(self, addr)
    }

    #[cold]
    #[inline(never)]
    pub(crate) fn mpu_check_exec_slow(&self, addr: u32) -> bool {
        if self.mpu.exec_allow(addr) {
            return true;
        }
        self.report_memmanage(addr, true);
        false
    }

    fn report_memmanage(&self, addr: u32, exec: bool) {
        if exec {
            self.mpu.mmfsr.set(self.mpu.mmfsr.get() | (1 << 0)); // IACCVIOL
        } else {
            self.mpu.mmfsr.set(self.mpu.mmfsr.get() | (1 << 1) | (1 << 7)); // DACCVIOL + MMARVALID
            self.mpu.mmfar.set(addr);
            self.mpu.mmfar_valid.set(true);
        }
        // Escalate to HardFault unless the MemManage handler is enabled.
        let shcsr = self.p.read(self, 0xE000ED24, 4);
        let irq = if shcsr & (1 << 16) != 0 { -12 } else { -13 };
        self.p.nvic.borrow_mut().set_intr_pending(irq);
    }

    fn register_software_spis(p: &Peripherals) {        use crate::peripherals::sw_spi::{SoftwareSpi, SoftwareSpiConfig};
        let configs = get_software_spi_configs().lock().unwrap();
        let ext_devices = get_ext_devices().lock().unwrap();
        for (name, cs, clk, miso, mosi) in configs.iter() {
            let config = SoftwareSpiConfig {
                name: name.clone(),
                cs: cs.clone(),
                clk: clk.clone(),
                miso: miso.clone(),
                mosi: mosi.clone(),
            };
            SoftwareSpi::register(config, &mut p.gpio.borrow_mut(), &ext_devices);
        }
    }

    fn register_touchscreen_gpios(p: &Peripherals) {
        let ext_devices = get_ext_devices().lock().unwrap();
        for ts in &ext_devices.touchscreens {
            ts.borrow_mut().setup_gpio(&mut p.gpio.borrow_mut());
        }
    }

    pub fn queue_dma_transfer(&self, t: DmaTransfer) {
        let mut pending = self.pending_dma.borrow_mut();
        if pending.iter().any(|x| x.stream_idx == t.stream_idx) {
            return; // channel already has a transfer queued; ignore re-arms
        }
        pending.push(t);
    }

    pub fn pending_dma_count(&self) -> usize {
        self.pending_dma.borrow().len()
    }

    pub fn take_pending_dma_transfer(&self, index: usize) -> Option<DmaTransfer> {
        let mut pending = self.pending_dma.borrow_mut();
        if index < pending.len() {
            Some(pending.remove(index))
        } else {
            None
        }
    }

    pub fn take_pending_dma_transfers(&self) -> Vec<DmaTransfer> {
        let mut pending = self.pending_dma.borrow_mut();
        std::mem::take(&mut *pending)
    }

    /// DMA pump helper: absorb `size` bytes from the peripheral at `addr`
    /// (periph_read chunks <= 4, little-endian packed) into the side buffer.
    /// Returns the byte offset for dma_absorb_take(). Absorbs immediately so
    /// JS only writes the result to RAM once per transfer.
    pub fn dma_absorb_store(&self, addr: u32, size: usize) -> usize {
        let mut buf = self.absorb_buf.borrow_mut();
        let off = buf.len();
        let mut j = 0u32;
        while (j as usize) < size {
            let chunk = std::cmp::min(4, size as u32 - j);
            let val = self.p.read(&*self, addr, chunk as u8);
            for k in 0..chunk {
                buf.push(((val >> (k * 8)) & 0xFF) as u8);
            }
            j += chunk;
        }
        off
    }

    /// Fetch [offset, offset+len) of the absorbed bytes. One pump can absorb
    /// for SEVERAL periph->mem transfers, each taken with its own offset, so
    /// the buffer is only released once the take reaches its end — clearing on
    /// the first take dropped every later transfer's bytes. dma_pump_all()
    /// clears it up front, so an abandoned plan cannot leak into the next pump.
    pub fn dma_absorb_take(&self, offset: usize, len: usize) -> Vec<u8> {
        let mut buf = self.absorb_buf.borrow_mut();
        if offset >= buf.len() {
            return Vec::new();
        }
        let end = buf.len().min(offset.saturating_add(len));
        let out = buf[offset..end].to_vec();
        if end >= buf.len() {
            buf.clear();
        }
        out
    }

    /// Drop any bytes left over from a previous pump (see dma_absorb_take).
    pub fn dma_absorb_reset(&self) {
        self.absorb_buf.borrow_mut().clear();
    }

    /// Build the flat DMA op plan (see dma_pump_all in lib.rs): pops ALL
    /// pending transfers, absorbs periph->mem bytes internally, and returns
    /// [op,a,b,c] quadruples. Moved here from lib.rs so native (non-JS)
    /// drivers can build the same plan.
    pub fn dma_build_plan(&self) -> Vec<u32> {
        self.dma_absorb_reset();
        let mut plan: Vec<u32> = Vec::new();
        let mut done_bits = 0u32;
        for t in self.take_pending_dma_transfers() {
            done_bits |= 1 << t.stream_idx;
            if t.direction == DmaDir::MemCopy || !t.peripheral {
                plan.extend([0, t.src, t.dst, t.size as u32]);
            } else if t.direction == DmaDir::Read {
                // periph -> mem: absorb now, executor writes the bytes to RAM
                let off = self.dma_absorb_store(t.peri_addr, t.size);
                plan.extend([1, t.dst, t.size as u32, off as u32]);
            } else {
                // mem -> periph: executor reads RAM, then pushes via dma_push_periph
                plan.extend([2, t.src, t.size as u32, t.peri_addr]);
            }
        }
        if done_bits != 0 {
            plan.extend([3, done_bits, 0, 0]);
        }
        plan
    }

    /// Execute a plan from dma_build_plan() against Rust guest memory
    /// (what the drivers pump via rustcpu_dma_pump). Raw access: DMA is a
    /// trusted bus master here, not subject to MPU checks (documented).
    pub fn dma_exec_plan(&self, mem: &mut dyn crate::cpu::mem::Memory, plan: &[u32]) {
        let mut i = 0;
        while i + 4 <= plan.len() {
            let (op, a, b, c) = (plan[i], plan[i + 1], plan[i + 2], plan[i + 3]);
            match op {
                0 => {
                    for k in 0..c {
                        let v = mem.read8_raw(a.wrapping_add(k));
                        mem.write8_raw(b.wrapping_add(k), v);
                    }
                }
                1 => {
                    for (k, v) in self.dma_absorb_take(c as usize, b as usize).into_iter().enumerate() {
                        mem.write8_raw(a.wrapping_add(k as u32), v);
                    }
                }
                2 => {
                    // mem -> periph: read RAM, push through the normal
                    // peripheral write path in <=4B chunks (mirrors the
                    // dma_push_periph wasm export).
                    let mut k = 0usize;
                    let n = b as usize;
                    while k < n {
                        let chunk = std::cmp::min(4, n - k);
                        let mut val = 0u32;
                        for j in 0..chunk {
                            val |= (mem.read8_raw(a.wrapping_add((k + j) as u32)) as u32) << (j * 8);
                        }
                        self.p.write(self, c, chunk as u8, val);
                        k += chunk;
                    }
                }
                _ => {
                    for stream in 0..12 {
                        if a & (1 << stream) != 0 {
                            self.mark_dma_completed(stream, true);
                        }
                    }
                }
            }
            i += 4;
        }
    }

    pub fn mark_dma_completed(&self, stream_idx: usize, _success: bool) {
        if stream_idx < 12 {
            DMA_COMPLETION_BITS.fetch_or(1 << stream_idx, Ordering::Release);
        }
        // Fire NVIC interrupt after transfer completes
        if stream_idx < 12 {
            let irq = DMA_STREAM_IRQ[stream_idx].swap(-1, Ordering::Acquire);
            if irq >= 0 {
                let flags = DMA_STREAM_FLAGS[stream_idx].swap(0, Ordering::Acquire);
                if flags & 0x7 != 0 {
                    self.p.nvic.borrow_mut().set_intr_pending(irq);
                }
            }
        }
    }

    pub fn dma_check_completion(&self, stream_idx: usize) -> bool {
        if stream_idx < 12 {
            let mask = 1 << stream_idx;
            DMA_COMPLETION_BITS.fetch_and(!mask, Ordering::Acquire) & mask != 0
        } else {
            false
        }
    }

    pub fn dma_take_completions(&self) -> u32 {
        DMA_COMPLETION_BITS.swap(0, Ordering::Acquire)
    }

    /// Take only the completion bits in `mask`, leaving other streams' bits
    /// queued for their own DMA's tick.
    pub fn dma_take_completions_masked(&self, mask: u32) -> u32 {
        let old = DMA_COMPLETION_BITS.load(Ordering::Acquire);
        DMA_COMPLETION_BITS.fetch_and(!mask, Ordering::AcqRel);
        old & mask
    }

    /// Append a virtual-peripheral event to the drain queue.
    pub fn push_event(&self, e: VmEvent) {
        self.event_queue.borrow_mut().push(e);
    }

    /// Take (and clear) all buffered virtual-peripheral events.
    pub fn take_events(&self) -> Vec<VmEvent> {
        std::mem::take(&mut *self.event_queue.borrow_mut())
    }

    /// Queue injected MISO bytes for a SPI channel (virtual device -> MCU).
    pub fn spi_inject_miso(&self, channel: u8, bytes: &[u8]) {
        self.spi_miso.borrow_mut().entry(channel).or_default().extend_from_slice(bytes);
    }

    /// Pop the next injected MISO byte for a SPI channel, if any.
    pub fn spi_take_miso(&self, channel: u8) -> Option<u8> {
        let mut m = self.spi_miso.borrow_mut();
        m.get_mut(&channel).and_then(|v| { if v.is_empty() { None } else { Some(v.remove(0)) } })
    }

    /// Queue injected RX bytes for an I2C channel (virtual device -> MCU).
    pub fn i2c_inject_rx(&self, channel: u8, bytes: &[u8]) {
        self.i2c_rx.borrow_mut().entry(channel).or_default().extend_from_slice(bytes);
    }

    /// Pop the next injected RX byte for an I2C channel, if any.
    pub fn i2c_take_rx(&self, channel: u8) -> Option<u8> {
        let mut m = self.i2c_rx.borrow_mut();
        m.get_mut(&channel).and_then(|v| { if v.is_empty() { None } else { Some(v.remove(0)) } })
    }

    /// Number of queued injected RX bytes for an I2C channel. A non-empty
    /// queue is a virtual host's claim on the next addressed transfer
    /// (JS-only slave ACK), and bounds the master-RX BTF tail arming.
    pub fn i2c_rx_len(&self, channel: u8) -> usize {
        self.i2c_rx.borrow().get(&channel).map(|v| v.len()).unwrap_or(0)
    }

    /// Return an unconsumed queue-sourced byte to the FRONT of the queue
    /// (back-to-back transfers preserve FIFO order).
    pub fn i2c_push_front_rx(&self, channel: u8, byte: u8) {
        self.i2c_rx.borrow_mut().entry(channel).or_default().insert(0, byte);
    }

    /// Drop all queued injected RX bytes for an I2C channel (virtual device
    /// -> MCU). Reactive runners clear-then-prefill at read-START (the
    /// pointer is already drained into the model by then), so stale
    /// leftovers from previous transactions never poison the front and
    /// every transaction is exact regardless of execute-batch timing.
    /// Clearing drops queued bytes only, never the host's address
    /// registration: a registered address keeps ACKing while dry (reads serve
    /// 0xFF). An address no host ever served still NACKs the address phase
    /// (bus-scan/error semantics unchanged); in-flight DR-held bytes are
    /// untouched.
    pub fn i2c_clear_rx(&self, channel: u8) {
        if let Some(v) = self.i2c_rx.borrow_mut().get_mut(&channel) {
            v.clear();
        }
    }

    pub fn tick(&self) {
        let p = self.p.clone();
        let deep = p.in_deep_sleep();
        let bus = p.bus.borrow();
        for &idx in bus.tick_indices() {
            if deep {
                // STOP/STANDBY: only LSI/LSE-clocked peripherals keep running
                // (IWDG @ 0x40003000, RTC @ 0x40002800); everything else freezes.
                let base = bus.slot_at(idx).start;
                if base != 0x4000_3000 && base != 0x4000_2800 {
                    bus.slot_at(idx).peripheral.borrow_mut().tick_frozen(self);
                    continue;
                }
            }
            bus.slot_at(idx).peripheral.borrow_mut().tick(self);
        }
        drop(bus);
        // SysTick runs off HCLK: frozen in STOP/STANDBY.
        if !deep {
            p.nvic.borrow_mut().maybe_set_systick_intr_pending();
        }
    }

    pub fn addr_desc(&self, addr: u32) -> String {
        self.p.addr_desc(addr)
    }
}

pub type System = WasmSystem;

unsafe impl Sync for WasmSystem {}
unsafe impl Send for WasmSystem {}

#[cfg(test)]
mod tests {
    use super::MpuState;
    use crate::test_util::with_sys;

    /// DMA1 channel 1 CMAR — a plain 32-bit register to absorb known bytes from.
    const MAR: u32 = 0x4002_0014;

    #[test]
    fn absorb_buffer_serves_every_transfer_in_a_pump() {
        with_sys(|sys| {
            sys.p.write(sys, MAR, 4, 0xAABB_CCDD);

            // One pump can absorb for several periph->mem transfers; JS takes
            // each one by its own offset, in plan order.
            let first = sys.dma_absorb_store(MAR, 4);
            let second = sys.dma_absorb_store(MAR, 4);
            assert_eq!((first, second), (0, 4), "offsets are sequential");

            assert_eq!(sys.dma_absorb_take(first, 4), vec![0xDD, 0xCC, 0xBB, 0xAA]);
            // Taking the first slice must NOT discard the rest.
            assert_eq!(sys.dma_absorb_take(second, 4), vec![0xDD, 0xCC, 0xBB, 0xAA]);

            // The final take releases the buffer.
            assert!(sys.dma_absorb_take(0, 4).is_empty());
        });
    }

    #[test]
    fn absorb_buffer_is_reset_between_pumps() {
        with_sys(|sys| {
            sys.p.write(sys, MAR, 4, 0x1122_3344);
            sys.dma_absorb_store(MAR, 4);
            // An abandoned plan (JS threw before taking) must not shift the
            // offsets of the next pump.
            sys.dma_absorb_reset();
            assert_eq!(sys.dma_absorb_store(MAR, 4), 0);
            assert_eq!(sys.dma_absorb_take(0, 4), vec![0x44, 0x33, 0x22, 0x11]);
        });
    }

    #[test]
    fn absorb_take_clamps_out_of_range_requests() {
        with_sys(|sys| {
            sys.dma_absorb_store(MAR, 4);
            assert!(sys.dma_absorb_take(8, 4).is_empty(), "offset past the end");
            assert_eq!(sys.dma_absorb_take(2, 99).len(), 2, "length past the end");
        });
    }

    /// AP[2:0] matrix (ARMv7-M): 000 none; 001 priv-RW; 010 priv-RW/user-RO;
    /// 011 full; 100 reserved (deny); 101 priv-RO; 110/111 RO/RO.
    #[test]
    fn mpu_ap_matrix() {
        // (ap, priv, read_ok, write_ok)
        let rows = [
            (0, true, false, false),
            (0, false, false, false),
            (1, true, true, true),
            (1, false, false, false),
            (2, true, true, true),
            (2, false, true, false),
            (3, true, true, true),
            (3, false, true, true),
            (4, true, false, false),
            (4, false, false, false),
            (5, true, true, false),
            (5, false, false, false),
            (6, true, true, false),
            (6, false, true, false),
            (7, true, true, false),
            (7, false, true, false),
        ];
        for (ap, priv_, r, w) in rows {
            let m = MpuState::default();
            m.ctrl.set(1); // enabled, no background
            m.privileged.set(priv_);
            // Region 0: RAM 128 B, given AP, enabled.
            m.set_region(0, 0x20000000, (ap << 24) | (6 << 1) | 1);
            assert_eq!(m.data_allow(0x20000010, false), r, "ap={ap} priv={priv_} read");
            assert_eq!(m.data_allow(0x20000010, true), w, "ap={ap} priv={priv_} write");
            // Exec needs read permission plus XN clear.
            assert_eq!(m.exec_allow(0x20000010), r, "ap={ap} priv={priv_} exec");
            { let r = m.regions[0].get().rasr; m.set_region(0, m.regions[0].get().rbar, r | (1 << 28)); } // XN
            assert!(!m.exec_allow(0x20000010), "ap={ap} XN must deny exec");
            assert_eq!(m.data_allow(0x20000010, false), r, "XN keeps data perms");
        }
    }

    /// Overlap priority (highest region number wins), subregion disable,
    /// reserved sizes, RBAR base masking.
    #[test]
    fn mpu_match_priority_subregions() {
        let m = MpuState::default();
        m.ctrl.set(1);
        m.privileged.set(true);
        // Regions 0 (allow) and 2 (deny) both cover 0x20000000/256: 2 wins.
        m.set_region(0, 0x20000000, (3 << 24) | (7 << 1) | 1);
        m.set_region(2, 0x20000000, (0 << 24) | (7 << 1) | 1);
        assert!(!m.data_allow(0x20000010, false));
        // Disabling region 2 falls back to region 0.
        m.set_region(2, 0, 0);
        assert!(m.data_allow(0x20000010, false));
        // Subregion 0 (0x100-0x11F of a 256 B region) disabled; region 0 is
        // switched off so only region 3 can match here.
        m.set_region(0, 0, 0);
        m.set_region(3, 0x20000100, (3 << 24) | (1 << 8) | (7 << 1) | 1);
        assert!(!m.data_allow(0x20000100, false), "disabled subregion denies");
        assert!(!m.data_allow(0x2000011F, false));
        assert!(m.data_allow(0x20000120, false), "next subregion allows");
        // Reserved SIZE fields (0/1) never match.
        m.set_region(4, 0x20000200, (3 << 24) | (1 << 1) | 1);
        // (region 0 covers 0x20000000/256 only, so 0x20000200 is unmatched)
        assert!(!m.data_allow(0x20000200, false), "no background without PRIVDEFENA");
        // Misaligned RBAR base masks to size (region 3 off: no overlap).
        m.set_region(3, 0, 0);
        m.set_region(4, 0x20000213, (3 << 24) | (7 << 1) | 1);
        assert!(m.data_allow(0x20000200, false), "base masks to 0x20000200");
        assert!(m.data_allow(0x200002FF, false));
        assert!(!m.data_allow(0x200001FF, false), "below masked base");
    }

    /// Background map + PPB rules: unmatched needs PRIVDEFENA + privilege;
    /// PPB is always priv-only and never executable.
    #[test]
    fn mpu_background_and_ppb() {
        let m = MpuState::default();
        m.ctrl.set(1); // enabled, no PRIVDEFENA
        m.privileged.set(true);
        assert!(!m.data_allow(0x20000000, false), "no background without PRIVDEFENA");
        m.ctrl.set(1 | 4); // + PRIVDEFENA
        assert!(m.data_allow(0x20000000, false), "priv background allows");
        assert!(m.data_allow(0x40010000, true), "priv background allows periph");
        assert!(m.exec_allow(0x08000000), "priv background executes");
        m.privileged.set(false);
        assert!(!m.data_allow(0x20000000, false), "unpriv background denies");
        assert!(!m.exec_allow(0x08000000), "unpriv background denies exec");
        // PPB overrides everything, even with background on.
        m.privileged.set(true);
        assert!(m.data_allow(0xE000E100, false), "priv PPB reads");
        assert!(!m.exec_allow(0xE000E100), "PPB never executes");
        m.privileged.set(false);
        assert!(!m.data_allow(0xE000E100, false), "unpriv PPB denies");
        // A region claiming unpriv PPB access still loses.
        m.set_region(7, 0xE000E000, (3 << 24) | (11 << 1) | 1); // 4K, full
        assert!(!m.data_allow(0xE000E100, false), "PPB override beats regions");
        assert!(!m.exec_allow(0xE000E100), "PPB XN beats regions");
    }
}
