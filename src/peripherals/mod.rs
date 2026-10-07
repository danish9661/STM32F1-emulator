pub mod rcc;
pub mod bootloader;
pub mod spi;
pub mod usart;
pub mod systick;
pub mod gpio;
pub mod dma;
pub mod i2c;
pub mod nvic;
pub mod scb;
pub mod tim;
pub mod adc;
pub mod flash;
pub mod pwr;
pub mod wwdg;
pub mod iwdg;
pub mod rtc;
pub mod crc;
pub mod can;
pub mod fsmc;
pub mod sw_spi;
pub mod afio;
pub mod exti;
pub mod bkp;
pub mod dac;
pub mod usb;
pub mod otg;
pub mod sdio;
pub mod dwt;
pub mod itm;
pub mod swd;

use std::cell::RefCell;
use std::collections::HashMap;
use crate::system::System;
use crate::ext_devices::ExtDevices;
use crate::bus::{Bus, JsPeripheral};
use fsmc::Fsmc;
use gpio::GpioPorts;
use svd_parser::svd::{MaybeArray, PeripheralInfo};

pub trait Peripheral {
    fn read(&mut self, sys: &System, offset: u32) -> u32;
    fn write(&mut self, sys: &System, offset: u32, value: u32);
    fn tick(&mut self, _sys: &System) {}
    /// Width-aware read (memory-mapped devices like FSMC need the access size
    /// to assemble bytes); defaults to plain read().
    fn read_sized(&mut self, sys: &System, offset: u32, _size: u8) -> u32 {
        self.read(sys, offset)
    }
    /// Width-aware write; defaults to plain write().
    fn write_sized(&mut self, sys: &System, offset: u32, _size: u8, value: u32) {
        self.write(sys, offset, value);
    }
    fn rx_byte(&mut self, _sys: &System, _byte: u8) {}
    fn rx_pending(&self) -> u32 { 0 }
    /// LIN break reception (also used for TX-break loopback): in LIN mode
    /// sets LBD, otherwise a framing error with a 0x00 byte.
    fn rx_break(&mut self, _sys: &System) {}
    fn can_inject_message(&mut self, _sys: &System, _tir: u32, _tdtr: u32, _tdlr: u32, _tdhr: u32) -> bool { false }
    /// Returns the GPIO port letter for the given EXTI line, if this is AFIO.
    fn exti_port(&self, _line: u32) -> Option<char> { None }
    /// Called by GPIO when a pin changes state. Returns true if handled.
    fn gpio_pin_changed(&mut self, _sys: &System, _port: u8, _pin: u8, _rising: bool) -> bool { false }
    /// Internal edge on an EXTI line (no GPIO port). Default: unhandled.
    fn exti_line_edge(&mut self, _sys: &System, _line: u32, _rising: bool) -> bool { false }
    /// Tamper-pin (PC13) level edge for the backup domain. Default: unhandled.
    fn bkp_tamper(&mut self, _sys: &System, _rising: bool) -> bool { false }
    /// Host-side USB OUT/SETUP delivery into endpoint `ep` (`is_setup` only
    /// legal on EP0). `addr` selects hardware address filtering (None =
    /// correctly-addressed host). Returns false when NAKed/filtered.
    /// Default: unhandled.
    fn usb_inject(
        &mut self,
        _sys: &System,
        _ep: usize,
        _data: &[u8],
        _is_setup: bool,
        _addr: Option<u8>,
    ) -> bool {
        false
    }
    /// Host-driven USB bus reset (SE0): device address clears, endpoints
    /// reset, RESET event + IRQ (what a real plug-in/enumeration sends;
    /// FRES release alone is NOT a reset — only this is).
    /// Default: unhandled.
    fn usb_bus_reset(&mut self, _sys: &System) -> bool { false }
    /// Host disconnect (pull-up off): tokens stop, IN never completes, SOF
    /// freezes; the next bus reset reattaches. Default: unhandled.
    fn usb_detach(&mut self, _sys: &System) -> bool { false }
    /// Host-side OTG_FS OUT/SETUP delivery into endpoint `ep` (`is_setup`
    /// only legal on EP0). `addr` selects hardware address filtering
    /// (None = correctly-addressed host). Returns false when dropped.
    /// Default: unhandled.
    fn otg_inject(
        &mut self,
        _sys: &System,
        _ep: usize,
        _data: &[u8],
        _is_setup: bool,
        _addr: Option<u8>,
    ) -> bool {
        false
    }
    /// Host-driven OTG_FS bus reset (SE0): endpoints + FIFOs + address
    /// reset, USBRST + ENUMDNE events. Default: unhandled.
    fn otg_bus_reset(&mut self, _sys: &System) -> bool { false }
    /// Host disconnect on OTG_FS (pull-up off). Default: unhandled.
    fn otg_detach(&mut self, _sys: &System) -> bool { false }
    /// Answer a pending OTG_FS host IN token on `ep` with `data` (or a
    /// STALL handshake). Matches the first armed IN channel addressed at
    /// `ep`. Default: unhandled (false).
    fn otg_host_feed_in(&mut self, _sys: &System, _ep: usize, _data: &[u8], _stall: bool) -> bool {
        false
    }
    /// Virtual-device attach/detach on the OTG_FS host port (PCSTS follows,
    /// edges raise PCDET + HPRTINT). Default: unhandled (false).
    fn otg_host_attach(&mut self, _sys: &System, _present: bool) -> bool { false }    /// Host-side I2C slave transactions (this peripheral addressed as slave).
    /// Defaults: unhandled (NACK / no data).
    fn i2c_slave_start(&mut self, _sys: &System, _addr: u16, _is_read: bool) -> bool { false }    fn i2c_slave_write(&mut self, _sys: &System, _byte: u8) -> bool { false }
    fn i2c_slave_read(&mut self, _sys: &System) -> Option<u8> { None }
    fn i2c_slave_stop(&mut self, _sys: &System) -> bool { false }
    /// SMBus ALERT input: peer pulled SMBA low → SR1 SMBALERT + error IRQ.
    /// Default: unhandled (no flag).
    fn i2c_slave_alert(&mut self, _sys: &System) -> bool { false }
    /// CAN filter match against shared banks (for CAN2's delegated match
    /// on CAN1's bank). Default: no match.
    fn can_match_for(&self, _tir: u32, _for_can2: bool) -> Option<usize> { None }
    /// PWR deep-standby selection (CR PDDS bit) for power-state queries.
    fn pwr_standby_selected(&self) -> bool { false }
    /// PWR low-power regulator selection (CR LPDS bit) for STOP current.
    fn pwr_regulator_low_power(&self) -> bool { false }
    /// PWR EWUP bit (CSR.8): WKUP pin armed. Only PWR implements meaningfully.
    fn pwr_ewup(&self) -> bool { false }
    /// PWR WKUP-pin edge (latches WUF when EWUP is set). Only PWR implements.
    fn pwr_wkup_edge(&mut self, _sys: &System, _rising: bool) {}
    /// Configured (sysclk, hclk, pclk1, pclk2) in Hz, if this is RCC.
    fn rcc_clocks(&self) -> Option<(u32, u32, u32, u32)> { None }
    /// MCO pin output in Hz, if this is RCC.
    fn rcc_mco(&self) -> Option<u32> { None }
    /// Returns AFIO MAPR remap bits for this peripheral, if applicable.
    fn periph_remap(&self, _sys: &System) -> Option<u32> { None }
    /// Returns the MAPR remap bits for a named peripheral (only AFIO implements meaningfully).
    fn remap_status(&self, _name: &str) -> Option<u32> { None }
    /// AFIO MAPR SWJ_CFG debug-port mode (only AFIO implements meaningfully).
    fn swj_cfg(&self) -> u32 { 0 }
    /// FLASH option USER.WDG_SW clear = hardware watchdog (auto-started).
    /// Only FLASH implements meaningfully.
    fn flash_wdg_hw(&self) -> bool { false }
    /// Returns the current PWM duty (0-100) of a timer channel, if this is a timer.
    fn pwm_duty(&self, _channel: u32) -> Option<u32> { None }
    /// Peripheral DMA request (e.g. ADC end-of-conversion): triggers a configured
    /// DMA channel transfer if it is enabled.
    fn dma_request(&mut self, _sys: &System, _channel: u32) {}
    /// ADC external trigger from a timer source: (timer base, channel index,
    /// 4 = TRGO update). ADC checks its own EXTSEL configuration.
    fn adc_timer_trigger(&mut self, _sys: &System, _tim_base: u32, _ch: u8) {}
    /// ADC external trigger from an EXTI line (regular: 11, injected: 15).
    fn adc_exti_trigger(&mut self, _sys: &System, _line: u32) {}
    /// Dual-mode slave start: ADC1 in regular-simultaneous mode fans out to
    /// ADC2, which converts its own sequence in lockstep (no-op default).
    fn adc_dual_slave_start(&mut self, _sys: &System) {}
    /// Force-complete an in-flight slave conversion now (dual lockstep).
    fn adc_dual_slave_complete(&mut self, _sys: &System) {}
    /// HSE clock failure injection (CSS path): true when CSS fired.
    fn rcc_fail_hse(&mut self, _sys: &System) -> bool { false }
    /// Set the modeled supply voltage in mV (PVD entry point). Returns the
    /// new PVDO level; only PWR implements meaningfully.
    fn pwr_set_supply(&mut self, _sys: &System, _mv: u32) -> bool { false }
    /// FLASH ACR wait-state setting (ACR LATENCY bits) for the DWT cycle
    /// counter. Default 0 (no wait states).
    fn flash_latency(&self) -> u32 { 0 }    /// STOP-mode exit: fall back to HSI (SWS=00, SW kept).
    fn rcc_wake_from_stop(&mut self) {}
    /// Last regular conversion result (for dual-mode DR packing).
    fn adc_data_reg(&self) -> u32 { 0 }
    /// 12-bit voltage a peripheral drives on a GPIO pin (DAC output), if any.
    fn dac_output(&self, _port: u8, _pin: u8) -> Option<u32> { None }
    /// True when the CPU is in a deep-sleep mode (STOP/STANDBY), gating peripheral ticks.
    fn in_deep_sleep(&self) -> bool { false }
    /// Called instead of tick() while the peripheral is frozen in STOP/STANDBY.
    /// Instruction-delta peripherals must advance their delta base here without
    /// processing state, so they don't catch up when the CPU wakes.
    fn tick_frozen(&mut self, _sys: &System) {}
    /// Rebase the instruction-delta clock to `now` (NRST path): move the
    /// delta base without processing state — same shape as tick_frozen,
    /// but for count jumps rather than sleep. Default no-op (peripherals
    /// without a delta clock need nothing).
    fn rebase_clock(&mut self, _sys: &System, _now: u64) {}
    /// Whether the peripheral is currently enabled/running (e.g. TIM CEN bit).
    fn is_enabled(&self) -> bool { false }
    /// Raise a fault (kind: 0=fetch, 1=read, 2=write, 3=undef instruction), setting
    /// SCB fault status registers and pending the fault exception with escalation.
    fn raise_fault(&mut self, _sys: &System, _kind: u32, _addr: u32) {}
}

pub struct PeripheralSlot<T> {
    pub start: u32,
    pub end: u32,
    pub tick: bool,
    pub peripheral: T,
}

pub struct Peripherals {
    pub bus: RefCell<Bus>,
    pub nvic: RefCell<nvic::Nvic>,
    pub gpio: RefCell<GpioPorts>,
    rcc_enrs: RefCell<(u32, u32, u32)>,
    /// Auxiliary Control Register (SCB ACTRL @ 0xE000E008, RW): DISMCYCINT/
    /// DISFOLD cycle-count subtilities only — stored, no timing effect.
    /// Handled here (like STIR) so both maps route it without touching
    /// any bus window.
    actrl: core::cell::Cell<u32>,
}

fn extract_svd_max_offset(p: &PeripheralInfo) -> u32 {
    let mut max_off = 0u32;

    use svd_parser::svd::register::{address_offsets as reg_offsets};
    use svd_parser::svd::array::{names as arr_names};
    use svd_parser::svd::cluster::{address_offsets as clus_offsets};

    for reg in p.registers() {
        match reg {
            MaybeArray::Single(r) => max_off = max_off.max(r.address_offset + 4),
            MaybeArray::Array(r, dim) => {
                for (off, _) in reg_offsets(r, dim).zip(arr_names(r, dim)) {
                    max_off = max_off.max(off + 4);
                }
            }
        }
    }

    for cluster in p.clusters() {
        match cluster {
            MaybeArray::Single(c) => {
                let base = c.address_offset;
                for reg in c.registers() {
                    match reg {
                        MaybeArray::Single(r) => max_off = max_off.max(base + r.address_offset + 4),
                        MaybeArray::Array(r, dim) => {
                            for (off, _) in reg_offsets(r, dim).zip(arr_names(r, dim)) {
                                max_off = max_off.max(base + off + 4);
                            }
                        }
                    }
                }
            }
            MaybeArray::Array(c, dim) => {
                for (clus_off, _) in clus_offsets(c, dim).zip(dim.indexes()) {
                    let base = c.address_offset + clus_off as u32;
                    for reg in c.registers() {
                        match reg {
                            MaybeArray::Single(r) => max_off = max_off.max(base + r.address_offset + 4),
                            MaybeArray::Array(r, d) => {
                                for (off, _) in reg_offsets(r, d).zip(arr_names(r, d)) {
                                    max_off = max_off.max(base + off + 4);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    max_off
}

fn name_has_tick(name: &str) -> bool {
    name.starts_with("TIM") || name.starts_with("DMA") || name == "RTC" || name.starts_with("ADC")
        || name.starts_with("USART") || name.starts_with("UART") || name == "USB" || name == "DWT"
        || name.starts_with("USB_OTG") || name == "IWDG" || name == "WWDG"
}

impl Peripherals {
    pub const NVIC_REGS_BASE: u32 = 0xE000_E100;
    pub const NVIC_REGS_END: u32 = 0xE000_E500;
    /// Software Trigger Interrupt Register: write-only, pends an interrupt
    /// by number (INTID, 9 bits). Present in both SVDs inside NVIC; handled
    /// here (not in Nvic itself) so both the hardcoded and SVD maps route
    /// it without widening any bus window into SCB territory.
    pub const STIR_ADDR: u32 = 0xE000_EF00;

    /// Auxiliary Control Register (SCB ACTRL @ 0xE000E008, RW, reset 0).
    pub const ACTRL_ADDR: u32 = 0xE000_E008;
    /// Implemented ACTRL bits: DISMCYCINT(0)/DISFOLD(2) (DISFPCA is M4).
    pub const ACTRL_MASK: u32 = 0x7;

    /// Debug MCU IDCODE register (DBGMCU_IDCODE @ 0xE0042000, read-only).
    /// Reports the selected chip (STM32F103: 0x10016410, GD32F103:
    /// 0x2BA01477). Routed here so both maps answer without a bus window.
    pub const DBG_IDCODE_ADDR: u32 = 0xE004_2000;

    /// 96-bit device UID words @ 0x1FFFF7E8 (system memory, read-only).
    /// Fixed constant serial (GD32's layout differs; noted, not modeled).
    /// Routed here so both maps answer without a bus window.
    pub const UID_ADDR: u32 = 0x1FFF_F7E8;
    pub const UID_WORDS: [u32; 3] = [0x0031_0033, 0x3231_3034, 0x3837_3635];

    pub const MEMORY_MAPS: [(u32, u32); 2] = [
        (0x4000_0000, 0xB000_0000),
        (0xE000_0000, 0xE100_0000),
    ];

    pub fn from_svd(svd_xml: &str, gpio: GpioPorts, ext_devices: &ExtDevices) -> Self {
        let mut device: svd_parser::svd::Device = svd_parser::parse(svd_xml)
            .expect("Failed to parse SVD XML");

        device.peripherals.sort_by_key(|p| p.base_address);

        let rcc_enrs = RefCell::new((0x0000_0014, 0x0000_0000, 0x0000_0000));
        let mut peripherals = Peripherals {
            bus: RefCell::new(Bus::new()),
            nvic: RefCell::new(nvic::Nvic::default()),
            gpio: RefCell::new(gpio),
            rcc_enrs,
            actrl: core::cell::Cell::new(0),
        };

        let svd_map: HashMap<&str, &PeripheralInfo> = device.peripherals.iter()
            .filter_map(|p| match p {
                MaybeArray::Single(p) => Some((p.name.as_str(), p)),
                MaybeArray::Array(_, _) => None,
            })
            .collect();

        let mut otg_done = false;
        for p in &device.peripherals {
            let p = match p {
                MaybeArray::Single(p) => p,
                MaybeArray::Array(_, _) => continue,
            };

            let resolved = p.derived_from.as_ref()
                .and_then(|d| svd_map.get(d.as_str()).copied())
                .unwrap_or(p);

            let name = &p.name;
            let size = extract_svd_max_offset(resolved).max(0x10).min(0x400);
            let (start, end) = if name.as_str() == "FSMC" {
                (0x6000_0000, 0xA000_1000)
            } else if name.as_str() == "USB" {
                // Registers + packet memory (SVD only sizes the registers).
                (0x4000_5C00, 0x4000_6400)
            } else if name.as_str().starts_with("USB_OTG") {
                // One shared OTG_FS instance owns registers + all data
                // FIFOs; the SVD splits them into GLOBAL/HOST/DEVICE/
                // PWRCLK parts, so register once and skip the rest.
                if otg_done {
                    continue;
                }
                otg_done = true;
                (0x5000_0000, 0x5000_5000)
            } else {
                (p.base_address as u32, p.base_address as u32 + size)
            };
            let peri: Option<Box<dyn Peripheral>> =
                Self::build_peripheral(name, ext_devices, &mut peripherals.gpio.borrow_mut());

            if let Some(peri) = peri {
                peripherals.bus.get_mut().register(start, end, name_has_tick(name), peri);
            }
        }

        // ARM core peripherals are architectural: fixed addresses on every
        // Cortex-M3. Some SVDs omit them (e.g. STM32F105xx has no SCB/SysTick) —
        // register defaults so SysTick, faults and deep-sleep always work.
        for (name, base, size) in [
            ("NVIC", 0xE000_E000u32, 0x100u32),
            ("SysTick", 0xE000_E010u32, 0x20u32),
            ("SCB", 0xE000_ED00u32, 0x100u32),
            ("DWT", 0xE000_1000u32, 0x1000u32),
            ("ITM", 0xE000_0000u32, 0x1000u32),
        ] {
            if peripherals.bus.get_mut().get(base).is_none() {
                if let Some(p) = Self::build_peripheral(name, ext_devices, &mut peripherals.gpio.borrow_mut()) {
                    peripherals.bus.get_mut().register(base, base + size, false, p);
                }
            }
        }

        peripherals.bus.get_mut().finish_assert_no_overlap();
        peripherals
    }

    /// Construct a peripheral implementation from its SVD peripheral name.
    /// Returns None for peripherals this emulator doesn't model (ETH, ...)
    /// — those are silently skipped.
    fn build_peripheral(name: &str, ext_devices: &ExtDevices, gpio: &mut GpioPorts) -> Option<Box<dyn Peripheral>> {
        None
            .or_else(|| nvic::NvicWrapper::new(name))
            .or_else(|| SysTick::new(name))
            .or_else(|| Scb::new(name))
            .or_else(|| Gpio::new(name))
            .or_else(|| Usart::new(name, ext_devices))
            .or_else(|| Rcc::new(name))
            .or_else(|| Flash::new(name))
            .or_else(|| Pwr::new(name))
            .or_else(|| Wwdg::new(name))
            .or_else(|| Iwdg::new(name))
            .or_else(|| Rtc::new(name))
            .or_else(|| Crc::new(name))
            .or_else(|| I2c::new(name, ext_devices))
            .or_else(|| Dma::new(name))
            .or_else(|| Spi::new(name, ext_devices, gpio))
            .or_else(|| Timer::new(name))
            .or_else(|| Adc::new(name))
            .or_else(|| Can::new(name))
            .or_else(|| Usb::new(name))
            .or_else(|| OtgFs::new(name))
            .or_else(|| Fsmc::new(name, ext_devices))
            .or_else(|| Afio::new(name))
            .or_else(|| Exti::new(name))
            .or_else(|| Bkp::new(name))
            .or_else(|| Dac::new(name))
            .or_else(|| Sdio::new(name))
            .or_else(|| Dwt::new(name))
            .or_else(|| Itm::new(name))
    }

    pub fn new_wasm(gpio: GpioPorts, ext_devices: &ExtDevices) -> Self {
        let rcc_enrs = RefCell::new((0x0000_0014, 0x0000_0000, 0x0000_0000));
        let mut peripherals = Peripherals {
            bus: RefCell::new(Bus::new()),
            nvic: RefCell::new(nvic::Nvic::default()),
            gpio: RefCell::new(gpio),
            rcc_enrs,
            actrl: core::cell::Cell::new(0),
        };

        let mut regs: Vec<(u32, &str)> = vec![
            (0x4000_0000, "TIM2"),  (0x4000_0400, "TIM3"),  (0x4000_0800, "TIM4"),
            (0x4000_0C00, "TIM5"),  (0x4000_1000, "TIM6"),  (0x4000_1400, "TIM7"),
            (0x4000_2800, "RTC"),  (0x4000_2C00, "WWDG"),  (0x4000_3000, "IWDG"),
            (0x4000_3800, "SPI2"),
            (0x4000_3C00, "SPI3"),
            (0x4000_4400, "USART2"), (0x4000_4800, "USART3"),
            (0x4000_4C00, "UART4"), (0x4000_5000, "UART5"),
            (0x4000_5400, "I2C1"), (0x4000_5800, "I2C2"),
            (0x4000_5C00, "USB"),
            (0x4000_6400, "CAN1"), (0x4000_6800, "CAN2"),
            (0x4000_6C00, "BKP"),
            (0x4000_7000, "PWR"),
            (0x4000_7400, "DAC"),
            (0x4001_0000, "AFIO"), (0x4001_0400, "EXTI"),
            (0x4001_0800, "GPIOA"), (0x4001_0C00, "GPIOB"),
            (0x4001_1000, "GPIOC"), (0x4001_1400, "GPIOD"),
            (0x4001_1800, "GPIOE"),
            (0x4001_2400, "ADC1"), (0x4001_2800, "ADC2"),
            (0x4001_2C00, "TIM1"),
            (0x4001_3000, "SPI1"),
            (0x4001_3800, "USART1"), (0x4001_3C00, "ADC3"),
            (0x4001_8000, "SDIO"),
            (0x4002_0000, "DMA1"), (0x4002_0400, "DMA2"),
            (0x4002_1000, "RCC"),  (0x4002_2000, "FLASH"),
            (0x4002_3000, "CRC"),
            (0xE000_1000, "DWT"),
            (0xE000_0000, "ITM"),
            (0xE000_E000, "NVIC"), (0xE000_E010, "SysTick"), (0xE000_ED00, "SCB"),
        ];
        regs.sort_by_key(|k| k.0);

        for (i, &(base, name)) in regs.iter().enumerate() {
            let size = regs.get(i + 1)
                .map(|&(next, _)| (next - base).min(0x400))
                .unwrap_or(0x100);
            // USB needs registers + 1024 B packet-memory window (ends at CAN1 start).
            let size = if name == "USB" { 0x800 } else { size };
            // ITM needs the full 4K stimulus block (TER/TPR/TCR live above +0xE00).
            let size = if name == "ITM" { 0x1000 } else { size };

            let p: Option<Box<dyn Peripheral>> =
                Self::build_peripheral(name, ext_devices, &mut peripherals.gpio.borrow_mut());

            if let Some(p) = p {
                peripherals.bus.get_mut().register(base, base + size, name_has_tick(name), p);
            }
        }

        if let Some(p) = Fsmc::new("FSMC", ext_devices) {
            peripherals.bus.get_mut().register(0x6000_0000, 0xA000_1000, false, p);
        }
        // OTG_FS shares the F105 register/DFIFO window. It is HD/CL-only
        // silicon, but rides the harmless-superset rule like DAC/FSMC/SDIO
        // so high-density firmware runs on the builtin map too.
        if let Some(p) = Self::build_peripheral("USB_OTG", ext_devices, &mut peripherals.gpio.borrow_mut()) {
            peripherals.bus.get_mut().register(0x5000_0000, 0x5000_5000, name_has_tick("USB_OTG"), p);
        }

        peripherals.bus.get_mut().finish_assert_no_overlap();
        peripherals
    }

    pub fn register_software_spi(&self, name: &str, cs: Option<String>, clk: &str, miso: &str, mosi: &str, ext_devices: &ExtDevices) {
        let config = sw_spi::SoftwareSpiConfig {
            name: name.to_string(),
            cs,
            clk: clk.to_string(),
            miso: miso.to_string(),
            mosi: mosi.to_string(),
        };
        sw_spi::SoftwareSpi::register(config, &mut self.gpio.borrow_mut(), ext_devices);
    }

    /// Register a peripheral implemented in JS (read/write callbacks receive
    /// the absolute address + access width). Last registration wins on
    /// overlap, so custom peripherals can shadow built-ins.
    pub fn register_js(&self, base: u32, size: u32, read: js_sys::Function, write: js_sys::Function) {
        self.bus.borrow_mut().register(
            base, base + size, false,
            Box::new(JsPeripheral::new(base, read, write)),
        );
    }

    fn bitbanding(addr: u32) -> Option<(u32, u8)> {
        if (0x4200_0000..0x4400_0000).contains(&addr) {
            let bit_number = (addr % 32) / 4;
            let mapped = 0x4000_0000 + (addr - 0x4200_0000) / 32;
            Some((mapped, bit_number as u8))
        } else { None }
    }

    fn is_register(addr: u32) -> bool {
        // USB packet memory (0x40006000-0x40006400) is byte-addressable SRAM:
        // exempt it from the word-lane shifting so PMA accesses stay exact.
        !(0x6000_0000..0xA000_0000).contains(&addr)
            && !(0x4000_6000..0x4000_6400).contains(&addr)
    }

    fn align_addr_4(addr: u32) -> (u32, u8) {
        let byte_offset = (addr % 4) as u8;
        (addr - byte_offset as u32, byte_offset)
    }

    /// Mask of the `size` low-order bytes (size >= 4 → all 32 bits).
    fn width_mask(size: u8) -> u32 {
        match size {
            1 => 0x0000_00FF,
            2 => 0x0000_FFFF,
            3 => 0x00FF_FFFF,
            _ => 0xFFFF_FFFF,
        }
    }

    fn nvic_priority_check(addr: u32) -> bool {
        const NVIC_PRIO_BASE: u32 = 0xE000E300;
        addr >= NVIC_PRIO_BASE && addr < NVIC_PRIO_BASE + 0x100
    }

    /// Whether the RCC clock for the peripheral at `base_addr` is enabled.
    ///
    /// NOT enforced by read()/write(): the emulator deliberately answers
    /// accesses to unclocked peripherals, so firmware that forgets its
    /// `RCC_APBxENR` bit still runs here even though it would read back zeros
    /// on real silicon. Gating on this is a behaviour change (some test
    /// firmware relies on the lenient path), so it stays opt-in rather than
    /// being wired in silently — the mapping is kept ready for that switch.
    #[allow(dead_code)]
    fn clock_enabled(&self, base_addr: u32) -> bool {
        let (ahbenr, apb2enr, apb1enr) = *self.rcc_enrs.borrow();
        if base_addr >= 0xE000_0000 { return true; }
        if base_addr >= 0x4002_1000 && base_addr < 0x4002_2000 { return true; }
        match base_addr {
            0x4002_0000 => (ahbenr & 1) != 0,
            0x4002_0400 => (ahbenr & (1 << 1)) != 0,
            0x4002_2000 => (ahbenr & (1 << 4)) != 0,
            0x4002_3000 => (ahbenr & (1 << 6)) != 0,
            0x4001_0000 | 0x4001_0400 => (apb2enr & 1) != 0,
            0x4001_0800 => (apb2enr & (1 << 2)) != 0,
            0x4001_0C00 => (apb2enr & (1 << 3)) != 0,
            0x4001_1000 => (apb2enr & (1 << 4)) != 0,
            0x4001_1400 => (apb2enr & (1 << 5)) != 0,
            0x4001_2400 => (apb2enr & (1 << 9)) != 0,
            0x4001_2800 => (apb2enr & (1 << 10)) != 0,
            0x4001_3C00 => (apb2enr & (1 << 15)) != 0,
            0x4001_2C00 => (apb2enr & (1 << 11)) != 0,
            0x4001_3000 => (apb2enr & (1 << 12)) != 0,
            0x4001_3800 => (apb2enr & (1 << 14)) != 0,
            0x4001_8000 => (ahbenr & (1 << 10)) != 0, // SDIOEN
            0x4000_0000 => (apb1enr & 1) != 0,
            0x4000_0400 => (apb1enr & (1 << 1)) != 0,
            0x4000_0800 => (apb1enr & (1 << 2)) != 0,
            0x4000_0C00 => (apb1enr & (1 << 3)) != 0,
            0x4000_1000 | 0x4000_1400 => true,
            0x4000_2800 => (apb1enr & (1 << 9)) != 0,
            0x4000_2C00 => (apb1enr & (1 << 11)) != 0,
            0x4000_3000 => true,
            0x4000_3800 => (apb1enr & (1 << 14)) != 0,
            0x4000_4400 => (apb1enr & (1 << 17)) != 0,
            0x4000_4800 => (apb1enr & (1 << 18)) != 0,
            0x4000_4C00 => (apb1enr & (1 << 19)) != 0,
            0x4000_5000 => (apb1enr & (1 << 20)) != 0,
            0x4000_5400 => (apb1enr & (1 << 21)) != 0,
            0x4000_5800 => (apb1enr & (1 << 22)) != 0,
            0x4000_6400 => (apb1enr & (1 << 25)) != 0,
            0x4000_6800 => (apb1enr & (1 << 26)) != 0,
            0x4000_6C00 => (apb1enr & (1 << 27)) != 0,
            0x4000_7000 => (apb1enr & (1 << 28)) != 0,
            0x4000_7400 => (apb1enr & (1 << 29)) != 0,
            _ => true,
        }
    }

    fn update_rcc_enrs(&self, offset: u32, value: u32) {
        let mut enrs = self.rcc_enrs.borrow_mut();
        match offset {
            0x14 => { enrs.0 = value; }
            0x18 => { enrs.1 = value; }
            0x1C => { enrs.2 = value; }
            _ => {},
        }
    }

    /// Rebase every instruction-delta clock in the model to `now`
    /// (INSTRUCTION_COUNT): call after the global count jumps (NRST reset
    /// zeroes it) so no peripheral sees a wrapped/huge delta and tries to
    /// "catch up" thousands of ticks at once. NRST-shaped: free (no guest
    /// state changes — CEN/CNT/SR untouched, only the delta bases move).
    pub fn rebase_clocks(&self, sys: &System, now: u64) {
        // NOTE: no bus RefCell or peripheral RefCell may be held across a
        // rebase_clock call — TIM's rebase reads sibling state
        // (afio_remap_status → bus.get + peripheral.borrow on AFIO), and
        // nesting borrows panics with "RefCell already borrowed" (the bus
        // borrow AND the slot's own peripheral borrow must both drop
        // first; borrow_mut on the slot while rebase re-borrows AFIO is
        // the exact panic seen in board_nrst).
        let n = self.bus.borrow().len();
        for i in 0..n {
            let raw: *const RefCell<Box<dyn Peripheral>> = {
                let bus = self.bus.borrow();
                &bus.slot_at(i).peripheral as *const _
            };
            unsafe { (*raw).borrow_mut() }.rebase_clock(sys, now);
        }
        let mut nvic = self.nvic.borrow_mut();
        nvic.last_systick_trigger = now;
        nvic.systick_debt = 0;
    }

    /// PWM duty (0-100) of a timer channel, 0 if the address is not a timer.
    pub fn pwm_duty(&self, addr: u32, channel: u32) -> u32 {
        if let Some(p) = self.bus.borrow().get(addr) {
            if let Ok(t) = p.peripheral.try_borrow() {
                return t.pwm_duty(channel).unwrap_or(0);
            }
        }
        0
    }

    /// PWM output pin for a timer channel (1-based timer number, 0-based
    /// channel): packed (port << 4 | pin) with the LIVE AFIO remap applied
    /// (port 0=A .. 3=D), or -1 when the timer/channel has no output pin.
    /// Read-only observation helper for servo/LED/buzzer wiring; touches no
    /// model state (never panics: unknown timers and borrow conflicts
    /// both yield -1).
    pub fn tim_chan_pin(&self, timer: u32, channel: u32) -> i32 {
        let name = match timer {
            1 => "TIM1",
            2 => "TIM2",
            3 => "TIM3",
            4 => "TIM4",
            5 => "TIM5",
            8 => "TIM8",
            9 => "TIM9",
            10 => "TIM10",
            11 => "TIM11",
            12 => "TIM12",
            13 => "TIM13",
            14 => "TIM14",
            _ => return -1, // 6/7 are basic timers (no channels); rest unknown
        };
        if channel > 3 {
            return -1;
        }
        let remap = self.afio_remap_status(name).unwrap_or(0);
        match tim::tim_chan_pin(name, channel as u8, remap) {
            Some((port, pin)) => ((port << 4) | pin) as i32,
            None => -1,
        }
    }

    pub fn read(&self, sys: &System, addr: u32, size: u8) -> u32 {
        if let Some((addr, bit_number)) = Self::bitbanding(addr) {
            return (self.read(sys, addr, 1) >> bit_number) & 1;
        }
        if addr == Self::STIR_ADDR {
            return 0; // STIR is write-only
        }
        if addr == Self::ACTRL_ADDR {
            return self.actrl.get();
        }
        if addr == Self::DBG_IDCODE_ADDR {
            return crate::dbg_idcode();
        }
        if (Self::UID_ADDR..Self::UID_ADDR + 12).contains(&addr) && addr % 4 == 0 {
            return Self::UID_WORDS[((addr - Self::UID_ADDR) / 4) as usize];
        }
        // NVIC priority registers are byte-addressable, bypass alignment
        if Self::nvic_priority_check(addr) {
            return self.nvic.borrow_mut().read(sys, addr - Self::NVIC_REGS_BASE);
        }
        let is_reg = Self::is_register(addr);
        let (addr, byte_offset) = if is_reg {
            Self::align_addr_4(addr)
        } else { (addr, 0) };
        let value = if Self::NVIC_REGS_BASE <= addr && addr < Self::NVIC_REGS_END {
            self.nvic.borrow_mut().read(sys, addr - Self::NVIC_REGS_BASE)
        } else if let Some(p) = self.bus.borrow().get(addr) {
            p.peripheral.borrow_mut().read_sized(sys, addr - p.start, size)
        } else { 0 };
        // Registers are read as a whole word; a sub-word access wants the byte
        // lane it addressed, so shift it DOWN into bits [0, 8*size) — the JS
        // memory hook (and the bit-band path above) take the low bytes of the
        // returned value.
        if is_reg && byte_offset != 0 {
            (value >> (8 * byte_offset as u32)) & Self::width_mask(size)
        } else if is_reg {
            value & Self::width_mask(size)
        } else {
            value
        }
    }

    pub fn write(&self, sys: &System, addr: u32, size: u8, mut value: u32) {
        if let Some((addr, bit_number)) = Self::bitbanding(addr) {
            let mut v = self.read(sys, addr, 1);
            v &= !(1 << bit_number);
            v |= (value & 1) << bit_number;
            return self.write(sys, addr, 1, v);
        }
        // Bus tap feeding onPeriphWrite watchers: model writes never cross
        // JS, so record them here (translated address, once). Gated by the
        // driver (enabled only while a watcher subscribes).
        if crate::native::write_tap_enabled() {
            crate::native::record_write(addr, size, value);
        }
        // NVIC priority registers are byte-addressable, bypass alignment
        if Self::nvic_priority_check(addr) {
            self.nvic.borrow_mut().write(sys, addr - Self::NVIC_REGS_BASE, value);
            return;
        }
        let (addr, byte_offset) = if Self::is_register(addr) {
            Self::align_addr_4(addr)
        } else { (addr, 0) };
        // NOTE: an ALIGNED sub-word store (byte_offset == 0, size < 4) is
        // deliberately passed through as a whole-word write instead of being
        // merged. Merging would require reading the register back, and the
        // registers written that way are exactly the ones with read side
        // effects — CMSIS types SPI/USART DR as __IO uint16_t, so `SPI->DR = b`
        // compiles to strh, and a read-back would consume RXNE/flags. Those
        // registers have no meaningful bits above the lane, so writing the
        // narrow value directly is correct for them.
        if byte_offset != 0 {
            // Sub-word store into a byte lane above bit 0: merge into the
            // current word so the bytes OUTSIDE the addressed lane survive —
            // both below the lane and above it. Only the lanes the access
            // actually covers (`size` bytes at `byte_offset`) are replaced.
            let shift = 8 * byte_offset as u32;
            let lane = Self::width_mask(size).checked_shl(shift).unwrap_or(0);
            let v = self.read(sys, addr, 4);
            value = (v & !lane) | ((value << shift) & lane);
        }
        // Always allow writes to RCC (0x40021000-0x40021FFF)
        if addr >= 0x4002_1000 && addr < 0x4002_2000 {
            self.update_rcc_enrs(addr - 0x4002_1000, value);
        }
        if addr == Self::STIR_ADDR {
            self.nvic
                .borrow_mut()
                .set_intr_pending((value & 0x1FF) as i32);
        } else if addr == Self::ACTRL_ADDR {
            self.actrl.set(value & Self::ACTRL_MASK);
        } else if Self::NVIC_REGS_BASE <= addr && addr < Self::NVIC_REGS_END {
            self.nvic.borrow_mut().write(sys, addr - Self::NVIC_REGS_BASE, value);
        } else if let Some(p) = self.bus.borrow().get(addr) {
            p.peripheral.borrow_mut().write_sized(sys, addr - p.start, size, value);
        }
    }

    pub fn can_inject_message(&self, sys: &System, addr: u32, tir: u32, tdtr: u32, tdlr: u32, tdhr: u32) -> bool {
        if let Some(p) = self.bus.borrow().get(addr) {
            p.peripheral.borrow_mut().can_inject_message(sys, tir, tdtr, tdlr, tdhr)
        } else { false }
    }

    pub fn rx_byte(&self, sys: &System, addr: u32, byte: u8) -> bool {
        // System-memory bootloader (when enabled) claims USART1 RX and
        // answers the AN3155 flashing flow instead of the USART model.
        if addr == bootloader::USART_BASE && bootloader::is_enabled() {
            bootloader::rx_byte(sys, byte);
            return true;
        }
        if let Some(p) = self.bus.borrow().get(addr) {
            p.peripheral.borrow_mut().rx_byte(sys, byte);
            true
        } else { false }
    }

    /// Inject a LIN break (13 low bits) into the UART at addr. Test and
    /// firmware entry point for the LBD path (also used by TX-break
    /// loopback in half-duplex mode).
    pub fn rx_break(&self, sys: &System, addr: u32) -> bool {
        if let Some(p) = self.bus.borrow().get(addr) {
            p.peripheral.borrow_mut().rx_break(sys);
            true
        } else { false }
    }

    pub fn rx_pending(&self, addr: u32) -> u32 {
        if let Some(p) = self.bus.borrow().get(addr) {
            p.peripheral.borrow().rx_pending()
        } else { 0 }
    }

    /// Queries the AFIO peripheral for the GPIO port mapped to a given EXTI line (0-15).
    pub fn exti_port_for_line(&self, line: u32) -> Option<char> {
        if let Some(slot) = self.bus.borrow().get(0x4001_0000) {
            return slot.peripheral.borrow().exti_port(line);
        }
        None
    }

    /// Queries AFIO MAPR remap bits for a given peripheral name.
    /// Returns None if the peripheral has no remap bits or AFIO is unavailable.
    pub fn afio_remap_status(&self, name: &str) -> Option<u32> {
        if let Some(slot) = self.bus.borrow().get(0x4001_0000) {
            return slot.peripheral.borrow().remap_status(name);
        }
        None
    }

    /// AFIO MAPR SWJ_CFG debug-port mode (0 when AFIO is unavailable =
    /// full SWJ, everything reserved — the reset state).
    pub fn afio_swj_cfg(&self) -> u32 {
        if let Some(slot) = self.bus.borrow().get(0x4001_0000) {
            return slot.peripheral.borrow().swj_cfg();
        }
        0
    }

    /// FLASH wait states (ACR LATENCY) for wait-state-aware cycle counting.
    pub fn flash_latency(&self) -> u32 {
        if let Some(slot) = self.bus.borrow().get(0x4002_2000) {
            return slot.peripheral.borrow().flash_latency();
        }
        0
    }

    /// PWR standby selection (CR PDDS) for power-state queries.
    pub fn pwr_standby(&self) -> bool {
        if let Some(slot) = self.bus.borrow().get(0x4000_7000) {
            return slot.peripheral.borrow().pwr_standby_selected();
        }
        false
    }

    /// PWR regulator mode (CR LPDS) for the STOP current estimate.
    pub fn pwr_low_power_reg(&self) -> bool {
        if let Some(slot) = self.bus.borrow().get(0x4000_7000) {
            return slot.peripheral.borrow().pwr_regulator_low_power();
        }
        false
    }

    /// Called from GPIO when a pin changes state. Triggers EXTI if the port/pin
    /// matches the AFIO EXTICR mapping and EXTI edge configuration.
    pub fn gpio_exti_trigger(&self, sys: &System, port: u8, pin: u8, rising: bool) {
        if let Some(slot) = self.bus.borrow().get(0x4001_0400) {
            slot.peripheral.borrow_mut().gpio_pin_changed(sys, port, pin, rising);
        }
    }

    /// Internal-peripheral edge on an EXTI line (PVD line 16, RTC alarm line
    /// 17, ...): same IMR/RTSR/FTSR gating as GPIO edges, without a port.
    pub fn exti_line_edge(&self, sys: &System, line: u32, rising: bool) {
        if let Some(slot) = self.bus.borrow().get(0x4001_0400) {
            slot.peripheral.borrow_mut().exti_line_edge(sys, line, rising);
        }
    }

    /// Tamper-pin (PC13) level edge into the backup domain (BKP CR.TPE/TPAL
    /// decide whether it is an event). Called from GPIO external-input paths.
    pub fn bkp_tamper(&self, sys: &System, rising: bool) {
        if let Some(slot) = self.bus.borrow().get(0x4000_6C00) {
            slot.peripheral.borrow_mut().bkp_tamper(sys, rising);
        }
    }

    /// Host-side USB delivery into an endpoint's RX buffer (OUT/SETUP).
    pub fn usb_inject(
        &self,
        sys: &System,
        ep: usize,
        data: &[u8],
        is_setup: bool,
        addr: Option<u8>,
    ) -> bool {
        if let Some(slot) = self.bus.borrow().get(0x4000_5C00) {
            slot.peripheral
                .borrow_mut()
                .usb_inject(sys, ep, data, is_setup, addr)
        } else {
            false
        }
    }

    /// Host-driven USB bus reset (SE0) on the FS-device peripheral.
    pub fn usb_bus_reset(&self, sys: &System) -> bool {
        if let Some(slot) = self.bus.borrow().get(0x4000_5C00) {
            slot.peripheral.borrow_mut().usb_bus_reset(sys)
        } else {
            false
        }
    }

    /// Host disconnect (pull-up off) on the FS-device peripheral.
    pub fn usb_detach(&self, sys: &System) -> bool {
        if let Some(slot) = self.bus.borrow().get(0x4000_5C00) {
            slot.peripheral.borrow_mut().usb_detach(sys)
        } else {
            false
        }
    }

    /// Host-side OTG_FS delivery into an endpoint's RX buffer (OUT/SETUP).
    pub fn otg_inject(
        &self,
        sys: &System,
        ep: usize,
        data: &[u8],
        is_setup: bool,
        addr: Option<u8>,
    ) -> bool {
        if let Some(slot) = self.bus.borrow().get(0x5000_0000) {
            slot.peripheral
                .borrow_mut()
                .otg_inject(sys, ep, data, is_setup, addr)
        } else {
            false
        }
    }

    /// Host-driven OTG_FS bus reset (SE0).
    pub fn otg_bus_reset(&self, sys: &System) -> bool {
        if let Some(slot) = self.bus.borrow().get(0x5000_0000) {
            slot.peripheral.borrow_mut().otg_bus_reset(sys)
        } else {
            false
        }
    }

    /// Host disconnect on OTG_FS (pull-up off).
    pub fn otg_detach(&self, sys: &System) -> bool {
        if let Some(slot) = self.bus.borrow().get(0x5000_0000) {
            slot.peripheral.borrow_mut().otg_detach(sys)
        } else {
            false
        }
    }

    /// Answer a pending OTG_FS host IN token on `ep` (or STALL it).
    pub fn otg_host_feed_in(&self, sys: &System, ep: usize, data: &[u8], stall: bool) -> bool {
        if let Some(slot) = self.bus.borrow().get(0x5000_0000) {
            slot.peripheral.borrow_mut().otg_host_feed_in(sys, ep, data, stall)
        } else {
            false
        }
    }

    /// Virtual-device attach/detach on the OTG_FS host port.
    pub fn otg_host_attach(&self, sys: &System, present: bool) -> bool {
        if let Some(slot) = self.bus.borrow().get(0x5000_0000) {
            slot.peripheral.borrow_mut().otg_host_attach(sys, present)
        } else {
            false
        }
    }

    /// I2C base address for a 1-based channel number (F103: I2C1/2 only).
    fn i2c_base(channel: u32) -> Option<u32> {
        match channel {
            1 => Some(0x4000_5400),
            2 => Some(0x4000_5800),
            _ => None,
        }
    }

    /// Host-side I2C slave transactions (this peripheral addressed as slave
    /// by an external host). See the `I2c::slave_*` methods for semantics.
    pub fn i2c_inject_start(&self, sys: &System, channel: u32, addr: u16, is_read: bool) -> bool {
        if let Some(b) = Self::i2c_base(channel) {
            if let Some(slot) = self.bus.borrow().get(b) {
                return slot.peripheral.borrow_mut().i2c_slave_start(sys, addr, is_read);
            }
        }
        false
    }
    pub fn i2c_inject_write(&self, sys: &System, channel: u32, byte: u8) -> bool {
        if let Some(b) = Self::i2c_base(channel) {
            if let Some(slot) = self.bus.borrow().get(b) {
                return slot.peripheral.borrow_mut().i2c_slave_write(sys, byte);
            }
        }
        false
    }
    pub fn i2c_inject_read(&self, sys: &System, channel: u32) -> Option<u8> {
        if let Some(b) = Self::i2c_base(channel) {
            if let Some(slot) = self.bus.borrow().get(b) {
                return slot.peripheral.borrow_mut().i2c_slave_read(sys);
            }
        }
        None
    }
    pub fn i2c_inject_stop(&self, sys: &System, channel: u32) -> bool {
        if let Some(b) = Self::i2c_base(channel) {
            if let Some(slot) = self.bus.borrow().get(b) {
                return slot.peripheral.borrow_mut().i2c_slave_stop(sys);
            }
        }
        false
    }
    /// SMBus ALERT input: peer pulled SMBA low on this channel → SR1
    /// SMBALERT flag (+ error IRQ when ITERREN). See `I2c::slave_alert`.
    pub fn i2c_inject_alert(&self, sys: &System, channel: u32) -> bool {
        if let Some(b) = Self::i2c_base(channel) {
            if let Some(slot) = self.bus.borrow().get(b) {
                return slot.peripheral.borrow_mut().i2c_slave_alert(sys);
            }
        }
        false
    }

    /// CAN2 filter match against CAN1's shared bank (banks [CAN2SB..28]).
    /// CAN2 owns no filter registers on silicon; the match always runs on
    /// CAN1's bank. Returns None when CAN1 is absent (f103 map).
    pub fn can_match_can2(&self, tir: u32) -> Option<usize> {
        if let Some(slot) = self.bus.borrow().get(0x4000_6400) {
            return slot.peripheral.borrow().can_match_for(tir, true);
        }
        None
    }

    /// Configured clocks (sysclk, hclk, pclk1, pclk2) in Hz from the RCC
    /// CFGR (HSE assumed 8 MHz). Timing stays instruction-budget based; this
    /// is for drivers computing dividers from the clocks (e.g. USART BRR).
    pub fn rcc_clocks(&self) -> (u32, u32, u32, u32) {
        if let Some(slot) = self.bus.borrow().get(0x4002_1000) {
            if let Some(c) = slot.peripheral.borrow().rcc_clocks() {
                return c;
            }
        }
        (8_000_000, 8_000_000, 8_000_000, 8_000_000)
    }

    /// MCO pin output in Hz (0 = no clock output).
    pub fn rcc_mco(&self) -> u32 {
        if let Some(slot) = self.bus.borrow().get(0x4002_1000) {
            if let Some(m) = slot.peripheral.borrow().rcc_mco() {
                return m;
            }
        }
        0
    }

    /// Peripheral DMA request: fires the enabled DMA channel if configured.
    /// Channels 1-7 go to DMA1; channels 8-12 go to DMA2 (ch = channel - 8).
    pub fn dma_request(&self, sys: &System, channel: u32) {
        if channel <= 7 {
            if let Some(p) = self.bus.borrow().get(0x4002_0000) {
                p.peripheral.borrow_mut().dma_request(sys, channel);
            }
        } else if channel <= 12 {
            if let Some(p) = self.bus.borrow().get(0x4002_0400) {
                p.peripheral.borrow_mut().dma_request(sys, channel - 8);
            }
        }
    }

    /// Timer-originated ADC external trigger: fanned out to every ADC, which
    /// gates on its own EXTSEL/JEXTSEL configuration.
    pub fn adc_timer_trigger(&self, sys: &System, tim_base: u32, ch: u8) {
        if let Some(slot) = self.bus.borrow().get(0x4001_2400) {
            slot.peripheral.borrow_mut().adc_timer_trigger(sys, tim_base, ch);
        }
        if let Some(slot) = self.bus.borrow().get(0x4001_2800) {
            slot.peripheral.borrow_mut().adc_timer_trigger(sys, tim_base, ch);
        }
    }

    /// EXTI-originated ADC trigger (line 11 = regular, 15 = injected).
    pub fn adc_exti_trigger(&self, sys: &System, line: u32) {
        if let Some(slot) = self.bus.borrow().get(0x4001_2400) {
            slot.peripheral.borrow_mut().adc_exti_trigger(sys, line);
        }
        if let Some(slot) = self.bus.borrow().get(0x4001_2800) {
            slot.peripheral.borrow_mut().adc_exti_trigger(sys, line);
        }
    }

    /// Dual-mode slave start (ADC1 regular-simultaneous fans out to ADC2)
    /// + ADC2 data register readback (for DR packing on ADC1 completion).
    pub fn adc_dual_slave_start(&self, sys: &System) {
        if let Some(slot) = self.bus.borrow().get(0x4001_2800) {
            slot.peripheral.borrow_mut().adc_dual_slave_start(sys);
        }
    }

    /// Force-complete an in-flight slave conversion now (dual lockstep:
    /// same start tick and rate, so this only collapses sub-tick order —
    /// ADC1's slot ticks before ADC2's and would otherwise pack stale data).
    pub fn adc_dual_slave_complete(&self, sys: &System) {
        if let Some(slot) = self.bus.borrow().get(0x4001_2800) {
            slot.peripheral.borrow_mut().adc_dual_slave_complete(sys);
        }
    }

    /// Inject an HSE clock failure (test/firmware entry point for the CSS
    /// path). Returns true when CSS fired (CSSON set).
    pub fn rcc_fail_hse(&self, sys: &System) -> bool {
        if let Some(slot) = self.bus.borrow().get(0x4002_1000) {
            return slot.peripheral.borrow_mut().rcc_fail_hse(sys);
        }
        false
    }

    /// Set the modeled PWR supply in mV (test/firmware entry point for PVD
    /// ramps). Returns the new PVDO level.
    pub fn pwr_set_supply(&self, sys: &System, mv: u32) -> bool {
        if let Some(slot) = self.bus.borrow().get(0x4000_7000) {
            return slot.peripheral.borrow_mut().pwr_set_supply(sys, mv);
        }
        false
    }

    /// STOP-mode exit hook (called on wake from deep sleep): HSI fallback.
    pub fn rcc_wake_from_stop(&self, _sys: &System) {
        if let Some(slot) = self.bus.borrow().get(0x4002_1000) {
            slot.peripheral.borrow_mut().rcc_wake_from_stop();
        }
    }

    pub fn adc_slave_data_reg(&self) -> u32 {
        if let Some(slot) = self.bus.borrow().get(0x4001_2800) {
            // Borrow dance: read without holding across returns.
            return slot.peripheral.borrow().adc_data_reg();
        }
        0
    }

    /// Analog voltage driven on a pin by a peripheral (DAC output), if any.
    pub fn dac_output(&self, port: u8, pin: u8) -> Option<u32> {
        if let Some(p) = self.bus.borrow().get(0x4000_7400) {
            if let Ok(dac) = p.peripheral.try_borrow() {
                return dac.dac_output(port, pin);
            }
        }
        None
    }

    /// STOP/STANDBY detection: SCB SCR SLEEPDEEP (bit 2). In deep sleep the core is
    /// halted; only LSI/LSE-clocked peripherals (IWDG, RTC) keep running.
    pub fn in_deep_sleep(&self) -> bool {
        if let Some(p) = self.bus.borrow().get(0xE000_ED00) {
            if let Ok(s) = p.peripheral.try_borrow() {
                return s.in_deep_sleep();
            }
        }
        false
    }

    /// Standby (vs Stop): deep sleep with PWR PDDS (CR.1) selected. Wake
    /// sources narrow to WKUP (PA0 + EWUP), the RTC alarm and IWDG/NRST;
    /// EXTI dispatch consults this (see exti.rs fire_line). SRAM/registers
    /// are kept (no reset sequencing is modeled — documented).
    pub fn in_standby(&self) -> bool {
        if !self.in_deep_sleep() {
            return false;
        }
        if let Some(slot) = self.bus.borrow().get(0x4000_7000) {
            if let Ok(p) = slot.peripheral.try_borrow() {
                return p.pwr_standby_selected();
            }
        }
        false
    }

    /// EWUP (PWR CSR.8): WKUP pin armed as a standby wakeup source.
    pub fn pwr_wkup_armed(&self) -> bool {
        if let Some(slot) = self.bus.borrow().get(0x4000_7000) {
            if let Ok(p) = slot.peripheral.try_borrow() {
                return p.pwr_ewup();
            }
        }
        false
    }

    /// WKUP-pin (PA0) edge into PWR (latches WUF when EWUP is set).
    pub fn pwr_wkup_edge(&self, sys: &System, rising: bool) {
        if let Some(slot) = self.bus.borrow().get(0x4000_7000) {
            slot.peripheral.borrow_mut().pwr_wkup_edge(sys, rising);
        }
    }

    /// Hardware-watchdog option (FLASH OBR USER.WDG_SW clear): the IWDG
    /// runs from reset without a KR start.
    pub fn flash_wdg_hw(&self) -> bool {
        if let Some(slot) = self.bus.borrow().get(0x4002_2000) {
            if let Ok(p) = slot.peripheral.try_borrow() {
                return p.flash_wdg_hw();
            }
        }
        false
    }

    /// Raise a fault through the SCB (CFSR/HFSR/BFAR + NVIC escalation).
    pub fn raise_fault(&self, sys: &System, kind: u32, addr: u32) {
        if let Some(p) = self.bus.borrow().get(0xE000_ED00) {
            p.peripheral.borrow_mut().raise_fault(sys, kind, addr);
        }
    }

    pub fn addr_desc(&self, addr: u32) -> String {
        format!("addr=0x{:08x}", addr)
    }
}

use spi::Spi;
use usart::Usart;
use systick::SysTick;
use gpio::Gpio;
use dma::Dma;
use i2c::I2c;
use scb::Scb;
use tim::Timer;
use adc::Adc;
use flash::Flash;
use pwr::Pwr;
use wwdg::Wwdg;
use iwdg::Iwdg;
use rtc::Rtc;
use crc::Crc;
use rcc::Rcc;
use can::Can;
use afio::Afio;
use exti::Exti;
use bkp::Bkp;
use dac::Dac;
use otg::OtgFs;
use usb::Usb;
use sdio::Sdio;
use dwt::Dwt;
use itm::Itm;

#[cfg(test)]
mod tests {
    use super::Peripherals;
    use crate::test_util::with_sys;

    /// DMA1 channel 1 CMAR: a plain 32-bit scratch register (stored and read
    /// back unmasked, no read side effects) — ideal for byte-lane assertions.
    const MAR: u32 = 0x4002_0014;

    #[test]
    fn reads_the_addressed_byte_lane() {
        with_sys(|sys| {
            sys.p.write(sys, MAR, 4, 0xAABB_CCDD);

            assert_eq!(sys.p.read(sys, MAR, 4), 0xAABB_CCDD, "word read");
            // Upper half-word: shifted DOWN into the low bytes, since the JS
            // memory hook takes the low `size` bytes of the returned value.
            assert_eq!(sys.p.read(sys, MAR + 2, 2), 0x0000_AABB, "upper half");
            assert_eq!(sys.p.read(sys, MAR, 2), 0x0000_CCDD, "lower half");
            assert_eq!(sys.p.read(sys, MAR + 3, 1), 0x0000_00AA, "byte 3");
            assert_eq!(sys.p.read(sys, MAR + 1, 1), 0x0000_00CC, "byte 1");
            assert_eq!(sys.p.read(sys, MAR, 1), 0x0000_00DD, "byte 0");
        });
    }

    #[test]
    fn sub_word_write_preserves_the_other_lanes() {
        with_sys(|sys| {
            sys.p.write(sys, MAR, 4, 0xAABB_CCDD);
            sys.p.write(sys, MAR + 2, 2, 0x0000_1234);
            assert_eq!(sys.p.read(sys, MAR, 4), 0x1234_CCDD, "upper half store");

            sys.p.write(sys, MAR, 4, 0xAABB_CCDD);
            sys.p.write(sys, MAR + 1, 1, 0x0000_0099);
            // Bytes ABOVE the written lane must survive too, not just below.
            assert_eq!(sys.p.read(sys, MAR, 4), 0xAABB_99DD, "byte 1 store");

            sys.p.write(sys, MAR, 4, 0xAABB_CCDD);
            sys.p.write(sys, MAR + 3, 1, 0x0000_0011);
            assert_eq!(sys.p.read(sys, MAR, 4), 0x11BB_CCDD, "byte 3 store");
        });
    }

    #[test]
    fn bit_band_touches_only_its_own_bit() {
        with_sys(|sys| {
            // Alias of bit 0 of the byte at MAR+2, i.e. bit 16 of the word.
            let alias = 0x4200_0000 + (MAR - 0x4000_0000) * 32;
            sys.p.write(sys, MAR, 4, 0xAABA_CCDD);

            assert_eq!(sys.p.read(sys, alias + 2 * 32, 4), 0, "bit reads clear");
            sys.p.write(sys, alias + 2 * 32, 4, 1);
            assert_eq!(sys.p.read(sys, MAR, 4), 0xAABB_CCDD, "set bit 16");
            assert_eq!(sys.p.read(sys, alias + 2 * 32, 4), 1, "bit reads set");

            sys.p.write(sys, alias + 2 * 32, 4, 0);
            assert_eq!(sys.p.read(sys, MAR, 4), 0xAABA_CCDD, "clear bit 16");
        });
    }

    #[test]
    fn width_mask_covers_each_access_size() {
        assert_eq!(Peripherals::width_mask(1), 0x0000_00FF);
        assert_eq!(Peripherals::width_mask(2), 0x0000_FFFF);
        assert_eq!(Peripherals::width_mask(4), 0xFFFF_FFFF);
    }
}
