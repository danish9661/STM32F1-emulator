use crate::{system::System, ext_devices::{ExtDevices, I2cDeviceEntry}};
use super::Peripheral;

#[derive(Clone, PartialEq, Debug)]
enum I2cState {
    Idle,
    StartSent,
    AddrSent { is_read: bool },
    Active { is_read: bool },
    /// Slave mode (this peripheral addressed by an external host via the
    /// inject_* API): address matched, awaiting the SR1+SR2 clear sequence.
    SlaveAddr { is_read: bool },
    /// Slave mode active: master-write (is_read=false, host bytes land in
    /// DR+RXNE) or master-read (is_read=true, firmware loads DR for TX).
    SlaveActive { is_read: bool },
}

impl Default for I2cState { fn default() -> Self { I2cState::Idle } }

fn i2c_irqs(name: &str) -> Option<(i32, i32)> {
    match name {
        "I2C1" => Some((31, 32)),
        "I2C2" => Some((33, 34)),
        "I2C3" => Some((72, 73)),
        _ => None,
    }
}

#[derive(Clone)]
pub struct I2c {
    #[allow(dead_code)]
    name: String,
    devices: Vec<I2cDeviceEntry>,
    active_device: Option<usize>,
    cr1: u32,
    cr2: u32,
    oar1: u32,
    oar2: u32,
    sr1: u32,
    sr2: u32,
    ccr: u32,
    trise: u32,
    dr: u32,
    state: I2cState,
    sr1_addr_flag: bool,
    irq_ev: i32,
    irq_er: i32,
    /// DMA channel: I2C1 TX=ch4/ch6 (remap), RX=ch5/ch7 (remap); I2C2=none
    dma_channel_tx: u8,
    dma_channel_rx: u8,
    /// STOPF clear sequence: set by an SR1 read while STOPF is up, consumed
    /// by the next CR1 write (RM0008: SR1 read followed by CR1 write).
    stopf_armed: bool,
    /// Virtual-claim ACK (JS-only slave): the address phase ACKed a master
    /// transfer with no engine-internal device because the inject queue held
    /// bytes (a virtual host is serving this channel). Data comes from the
    /// queue (0xFF when momentarily dry); master-TX bytes surface as
    /// I2cWrite. Cleared on START/NACK/reset.
    virtual_claim: bool,
    /// Address the JS host has taken ownership of (virtual slave). Set the
    /// first time an address phase is ACKed from the inject queue; unlike
    /// `virtual_claim` (per-transfer) this persists across START/STOP so a
    /// host that answers by reacting to `onWrite` is not starved once its
    /// queue drains (chicken-and-egg: no queue -> no claim -> no onWrite ->
    /// no inject). Cleared only by a peripheral SW reset / PE disable, i.e.
    /// never by ordinary bus activity — a registered host slave stays
    /// present until the emulator is re-created. An address that was never
    /// registered still NACKs, preserving bus-scan/AF semantics.
    virtual_addr: Option<u8>,
    /// The byte currently held in DR came from the inject queue (address
    /// preload or pipeline reload). The STOP-tail DR read returns it instead
    /// of double-consuming the queue (RM0008 N=1 + HAL last-bytes drain),
    /// and an unread held byte is returned to the queue front on START/STOP
    /// so back-to-back transfers preserve FIFO order.
    rx_hold_queued: bool,
    /// SMBus packet-error-code accumulator (CRC-8/SMBus, poly 0x07, init 0).
    /// Covers address+R/W + data bytes while PECEN (CR1.5) is set; readable
    /// via PECR. SMBALERT pin (CR1.13/SMBALERT) is register-only (no pin).
    pec: u8,
}

impl Default for I2c {
    fn default() -> Self {
        Self {
            name: String::new(), devices: Vec::new(), active_device: None,
            cr1: 0, cr2: 0, oar1: 0, oar2: 0, sr1: 0, sr2: 0, ccr: 0, trise: 0, dr: 0,
            state: I2cState::Idle, sr1_addr_flag: false, stopf_armed: false,
            virtual_claim: false, rx_hold_queued: false,
            virtual_addr: None,
            irq_ev: 0, irq_er: 0,
            dma_channel_tx: 0, dma_channel_rx: 0,
            pec: 0,
        }
    }
}

impl I2c {
    pub fn new(name: &str, ext_devices: &ExtDevices) -> Option<Box<dyn Peripheral>> {
        if !name.starts_with("I2C") { return None; }
        let (irq_ev, irq_er) = i2c_irqs(name)?;
        let devices = ext_devices.find_i2c_devices(name);
        let (dma_tx, dma_rx) = match name {
            "I2C1" => (4, 5),  // default: DMA1 ch4(TX)/ch5(RX); AFIO remap shifts to ch6/ch7
            _ => (0, 0),
        };
        Some(Box::new(Self {
            name: name.to_string(), devices, irq_ev, irq_er,
            dma_channel_tx: dma_tx, dma_channel_rx: dma_rx,
            ..Default::default()
        }))
    }

    fn i2c_channel(&self) -> u8 {
        self.name.trim_start_matches("I2C").parse::<u8>().unwrap_or(0)
    }

    fn reset(&mut self, sys: &System) {
        // An unread queue-sourced byte held in DR goes back to the queue
        // front (FIFO preserved across back-to-back transfers); device-held
        // bytes are re-readable from their model, so only queued holds move.
        if self.rx_hold_queued {
            sys.i2c_push_front_rx(self.i2c_channel(), self.dr as u8);
        }
        self.sr1 = 0; self.sr2 = 0;
        self.active_device = None; self.state = I2cState::Idle;
        self.sr1_addr_flag = false;
        self.stopf_armed = false;
        self.virtual_claim = false; self.rx_hold_queued = false;
        self.pec = 0;
    }

    /// Master-RX pipeline reload: account PEC, stage the next byte in DR
    /// with RXNE, emit I2cRead, arm BTF once the tail (<=3 bytes queued) is
    /// in sight, and poke DMA. Shared by the device-backed and virtual-claim
    /// read arms. BTF arming is what the HAL N>2 tail (RXNE loop ends at
    /// count==3 with BUF off; counts 4/3/2 complete through BTF) waits on —
    /// without it multi-byte master reads stall and time out.
    fn rx_reload(&mut self, sys: &System, byte: u8) {
        if self.pec_enabled() {
            if self.pec_xfer() {
                // PEC byte itself: compare, NACK-equivalent
                // error flag on mismatch (no accumulate).
                if byte != self.pec {
                    self.sr1 |= 1 << 12; // PECERR
                }
            } else {
                self.pec_feed(byte);
            }
        }
        self.dr = byte as u32;
        self.sr1 |= 1 << 6; // RXNE
        if sys.i2c_rx_len(self.i2c_channel()) <= 3 {
            self.sr1 |= 1 << 2; // BTF: tail bytes buffered behind DR
        } else {
            self.sr1 &= !(1 << 2);
        }
        sys.push_event(crate::system::VmEvent::I2cRead { channel: self.i2c_channel() });
        if self.cr2 & (1 << 11) != 0 {
            let ch = self.resolve_dma_channel(sys, false);
            if ch != 0 { sys.p.dma_request(sys, ch as u32); }
        }
    }

    /// SMBus PEC update (CRC-8, poly x^8+x^2+x+1 = 0x07, init 0, MSB-first).
    fn pec_feed(&mut self, byte: u8) {
        let mut crc = self.pec;
        let mut v = byte;
        for _ in 0..8 {
            let msb = (crc ^ v) & 0x80;
            crc = (crc << 1) & 0xFF;
            v <<= 1;
            if msb != 0 {
                crc ^= 0x07;
            }
        }
        self.pec = crc;
    }

    fn pec_enabled(&self) -> bool { self.cr1 & (1 << 5) != 0 }
    fn pec_xfer(&self) -> bool { self.cr1 & (1 << 12) != 0 }
    fn engc(&self) -> bool { self.cr1 & (1 << 6) != 0 }

    /// Slave address match: OAR1 (7-bit ADD[7:1], or 10-bit ADD[9:0] with
    /// ADDMODE), OAR2 dual 7-bit (ENDUAL), general call (addr 0 with ENGC).
    /// 10-bit matches compare the full 10 bits (no 7-bit aliasing); the
    /// ADD10 staging flag is abbreviated (single-shot inject sets ADDR).
    fn slave_match(&self, addr: u16) -> bool {
        if addr == 0 {
            return self.engc();
        }
        if self.oar1 & (1 << 15) != 0 {
            return (self.oar1 & 0x3FF) as u16 == (addr & 0x3FF);
        }
        if addr > 0x7F {
            return false;
        }
        if ((self.oar1 >> 1) & 0x7F) as u16 == addr {
            return true;
        }
        if self.oar2 & 1 != 0 && ((self.oar2 >> 1) & 0x7F) as u16 == addr {
            return true;
        }
        false
    }

    /// Host START + address (slave mode). ACKs on OAR match (PE must be set,
    /// master engine idle): ADDR flag, BUSY (MSL=0), GENCALL for addr 0.
    /// Returns false (NACK) when busy, disabled or unmatched.
    pub fn slave_start(&mut self, sys: &System, addr: u16, is_read: bool) -> bool {
        if self.cr1 & 1 == 0 {
            return false;
        }
        if !matches!(self.state, I2cState::Idle) {
            return false;
        }
        if !self.slave_match(addr) {
            return false;
        }
        self.sr1 = 1 << 1; // ADDR
        self.sr2 = (1 << 1) | if addr == 0 { 1 << 4 } else { 0 }; // BUSY[+GENCALL]
        if self.pec_enabled() {
            self.pec = 0;
            if addr > 0x7F {
                self.pec_feed((addr >> 8) as u8);
            }
            self.pec_feed(((addr << 1) & 0xFF) as u8 | is_read as u8);
        }
        self.state = I2cState::SlaveAddr { is_read };
        self.fire_interrupts(sys);
        true
    }

    /// Host data byte (master-write): lands in DR + RXNE. Returns false
    /// (NACK — the stretch equivalent) when not in slave-RX or the previous
    /// byte is still unread, or ACK is cleared.
    pub fn slave_write(&mut self, sys: &System, byte: u8) -> bool {
        if !matches!(self.state, I2cState::SlaveActive { is_read: false }) {
            return false;
        }
        if self.cr1 & (1 << 10) == 0 {
            return false;
        }
        if self.sr1 & (1 << 6) != 0 {
            return false;
        }
        self.dr = byte as u32;
        self.sr1 |= 1 << 6; // RXNE
        if self.pec_enabled() {
            self.pec_feed(byte);
        }
        self.fire_interrupts(sys);
        true
    }

    /// Host read (master-read): consumes the firmware-loaded DR byte, sets
    /// TXE. Returns None (stretch) when not in slave-TX or DR still empty.
    pub fn slave_read(&mut self, sys: &System) -> Option<u8> {
        if !matches!(self.state, I2cState::SlaveActive { is_read: true }) {
            return None;
        }
        if self.sr1 & (1 << 7) != 0 {
            return None;
        }
        let b = self.dr as u8;
        self.sr1 |= 1 << 7; // TXE
        self.fire_interrupts(sys);
        Some(b)
    }

    /// SMBus ALERT input (RM0008 §26.6.7, SR1 bit 15): the SMBA pin pulled
    /// low by a peer (host side). Sets the SMBALERT flag + error IRQ (via
    /// ITERREN); firmware clears it by writing SR1 with bit 15 = 0.
    /// Returns false (no flag) when the peripheral is disabled.
    pub fn slave_alert(&mut self, sys: &System) -> bool {
        if self.cr1 & 1 == 0 {
            return false;
        }
        self.sr1 |= 1 << 15; // SMBALERT
        self.fire_interrupts(sys);
        true
    }
    /// Host STOP: STOPF flag, back to Idle. Only valid out of a slave
    /// transaction (a STOP during master activity is a bus error, ignored).
    pub fn slave_stop(&mut self, sys: &System) -> bool {
        if !matches!(self.state, I2cState::SlaveAddr { .. } | I2cState::SlaveActive { .. }) {
            return false;
        }
        self.sr1 |= 1 << 4; // STOPF
        self.state = I2cState::Idle;
        self.fire_interrupts(sys);
        true
    }
    /// Resolves the DMA channel to use, accounting for AFIO remap.
    /// I2C1 default: TX=ch4, RX=ch5. AFIO remap (MAPR bit 1): TX=ch6, RX=ch7.
    fn resolve_dma_channel(&self, sys: &System, tx: bool) -> u8 {
        if self.name != "I2C1" { return 0; }
        let remap = sys.p.afio_remap_status("I2C1").unwrap_or(0);
        if remap & 1 != 0 {
            if tx { 6 } else { 7 }
        } else {
            if tx { self.dma_channel_tx } else { self.dma_channel_rx }
        }
    }

    fn fire_interrupts(&mut self, sys: &System) {
        // NOTE: no clock-stretch deferral here. Stretching is modeled at the
        // transfer level instead (slave inject NACKs/None while not ready),
        // never by delaying IRQs — deferring TXE interrupts deadlocked the
        // ISR-driven HAL_I2C_Master_Transmit_IT path (stall after 1st byte).
        let itevten = (self.cr2 >> 9) & 1;  // bit 9 = ITEVTEN
        let iterren = (self.cr2 >> 8) & 1;  // bit 8 = ITERREN
        let itbufen = (self.cr2 >> 10) & 1; // bit 10 = ITBUFEN

        let ev_flags = self.sr1 & 0x17;
        let buf_flags = self.sr1 & 0xC0;
        let err_flags = self.sr1 & (0x1E00 | (1 << 15)); // ARLO/AF/OVR/PECERR(12) + SMBALERT(15); BERR(8) out (pre-existing)

        if ev_flags != 0 && itevten != 0 {
            sys.p.nvic.borrow_mut().set_intr_pending(self.irq_ev);
        }
        if buf_flags != 0 && itbufen != 0 {
            sys.p.nvic.borrow_mut().set_intr_pending(self.irq_ev);
        }
        if err_flags != 0 && iterren != 0 {
            sys.p.nvic.borrow_mut().set_intr_pending(self.irq_er);
        }
    }
}

impl Peripheral for I2c {
    fn periph_remap(&self, sys: &System) -> Option<u32> {
        sys.p.afio_remap_status(&self.name)
    }

    fn i2c_slave_start(&mut self, sys: &System, addr: u16, is_read: bool) -> bool {
        self.slave_start(sys, addr, is_read)
    }
    fn i2c_slave_write(&mut self, sys: &System, byte: u8) -> bool {
        self.slave_write(sys, byte)
    }
    fn i2c_slave_read(&mut self, sys: &System) -> Option<u8> {
        self.slave_read(sys)
    }
    fn i2c_slave_stop(&mut self, sys: &System) -> bool {
        self.slave_stop(sys)
    }
    fn i2c_slave_alert(&mut self, sys: &System) -> bool {
        self.slave_alert(sys)
    }

    fn read(&mut self, sys: &System, offset: u32) -> u32 {
        match offset {
            0x00 => self.cr1,
            0x04 => self.cr2,
            0x08 => self.oar1,
            0x0C => self.oar2,
            0x1C => self.ccr,
            0x20 => self.trise,
            0x30 => self.pec as u32, // PECR: computed packet error code
                0x10 => {
                let mut v = self.dr;
                // Capture before clearing: the single-byte master-RX keep-alive
                // (STOP programmed right after ADDR, RM0008 N=1) reaches here as
                // Idle + no device with the byte still held in RXNE.
                let rxne_pending = self.sr1 & (1 << 6) != 0;
                self.sr1 &= !(1 << 6); // Clear RXNE on DR read
                self.sr1 &= !(1 << 2); // BTF clears on DR read (byte taken)
                if matches!(self.state, I2cState::Active { is_read: true }) {
                    // Master receiver: device-backed or virtual-claim (JS-only
                    // slave). The queue wins either way; the device model (or
                    // released-SDA 0xFF for a dry virtual claim) is the fallback.
                    if self.active_device.is_some() || self.virtual_claim {
                        let ch = self.i2c_channel();
                        let qb = sys.i2c_take_rx(ch);
                        self.rx_hold_queued = qb.is_some();
                        let byte = match qb {
                            Some(b) => b,
                            None => match self.active_device {
                                Some(idx) => self.devices[idx].device.borrow_mut().read(sys, ()) as u8,
                                None => 0xFF,
                            },
                        };
                        self.rx_reload(sys, byte);
                    }
                    } else if rxne_pending && matches!(self.state, I2cState::Idle) {
                        // Master-RX STOP tail: the STOP handler already went Idle
                        // with a byte held in RXNE (RM0008 N=1, or the HAL N>2
                        // last-bytes drain which reads twice after STOP with no
                        // further bus clocks).
                        if self.rx_hold_queued {
                            // The held byte came from the queue (address preload
                            // or pipeline reload): it IS the received byte, so
                            // return it instead of double-consuming the queue.
                            // Still-queued bytes stay readable (RXNE re-armed)
                            // for the drain-style tail; each byte emits exactly
                            // one I2cRead.
                            v = self.dr;
                            sys.push_event(crate::system::VmEvent::I2cRead { channel: self.i2c_channel() });
                            if let Some(nb) = sys.i2c_take_rx(self.i2c_channel()) {
                                self.dr = nb as u32;
                                self.sr1 |= 1 << 6; // RXNE
                                self.rx_hold_queued = true;
                            } else {
                                self.rx_hold_queued = false;
                            }
                        } else {
                            // Stale/device-held byte, late inject wins — virtual
                            // hosts answer the I2cStart after the address-phase
                            // preload. Single-shot: the transfer is over, this
                            // read consumes.
                            let byte = sys.i2c_take_rx(self.i2c_channel()).unwrap_or(v as u8);
                            self.dr = byte as u32;
                            v = byte as u32;
                            self.rx_hold_queued = false;
                            sys.push_event(crate::system::VmEvent::I2cRead { channel: self.i2c_channel() });
                        }
                    }
                    self.fire_interrupts(sys);
                    v
                }
             0x14 => {
                self.sr1_addr_flag = (self.sr1 & (1 << 1)) != 0;
                self.stopf_armed = (self.sr1 & (1 << 4)) != 0;
                self.sr1
            }
            0x18 => {
                // Reading SR2 clears ADDR flag
                if self.sr1_addr_flag {
                    self.sr1 &= !(1 << 1); // Clear ADDR
                    self.sr1_addr_flag = false;
                    // (is_master, is_read); slave setup is fully handled
                    // in its arm below, master continues in the shared block.
                    let addr_kind = match std::mem::replace(&mut self.state, I2cState::Idle) {
                        I2cState::AddrSent { is_read } => {
                            self.state = I2cState::Active { is_read };
                            Some(is_read)
                        }
                        I2cState::SlaveAddr { is_read } => {
                            // Slave addressing: MSL stays 0, BUSY set at
                            // match; TRA follows direction. Read mode arms
                            // TXE (firmware must load DR); write mode waits
                            // for the first host byte (RXNE). No slave DMA.
                            self.state = I2cState::SlaveActive { is_read };
                            if is_read {
                                self.sr1 |= 1 << 7; // TXE
                                self.sr2 |= 1 << 2; // TRA=1 (transmitter)
                            } else {
                                self.sr2 &= !(1 << 2); // TRA=0 (receiver)
                            }
                            None
                        }
                        s => { self.state = s; None }
                    };
                    if let Some(is_read) = addr_kind {
                        if is_read {
                            self.sr1 |= 1 << 6; // RXNE
                            self.sr2 &= !(1 << 2); // TRA=0 (receiver)
                            // BTF arming for short host-served reads: with <=3
                            // bytes queued the HAL N<=4 tail completes purely
                            // through BTF (counts 4/3/2) without any DR read
                            // ever occurring, so the reload path can't arm it.
                            // N==1 is excluded via ACK==0 (HAL NACKs at ADDR
                            // for a single byte, which then drains via RXNE).
                            let ack = self.cr1 & (1 << 10) != 0;
                            let served = self.active_device.is_some() || self.virtual_claim;
                            if ack && served && sys.i2c_rx_len(self.i2c_channel()) <= 3 {
                                self.sr1 |= 1 << 2; // BTF
                            } else {
                                self.sr1 &= !(1 << 2);
                            }
                            if self.cr2 & (1 << 11) != 0 {
                                let ch = self.resolve_dma_channel(sys, false);
                                if ch != 0 { sys.p.dma_request(sys, ch as u32); }
                            }
                        } else {
                            self.sr1 |= 1 << 7; // TXE
                            self.sr2 |= 1 << 2; // TRA=1 (transmitter)
                            if self.cr2 & (1 << 11) != 0 {
                                let ch = self.resolve_dma_channel(sys, true);
                                if ch != 0 { sys.p.dma_request(sys, ch as u32); }
                            }
                        }
                    }
                    self.fire_interrupts(sys);
                }
                self.sr2
            }
            _ => 0,
        }
    }

    fn write(&mut self, sys: &System, offset: u32, value: u32) {
        match offset {
            0x00 => {
                let prev_start = self.cr1 & (1 << 8);
                let prev_pe = self.cr1 & 1;
                let prev_alert = self.cr1 & (1 << 13);
                self.cr1 = value;

                // STOPF clear: SR1 read followed by any CR1 write.
                if self.stopf_armed {
                    self.sr1 &= !(1 << 4);
                    self.stopf_armed = false;
                }

                // SW reset (bit 15)
                if value & (1 << 15) != 0 {
                    self.reset(sys);
                    self.cr1 = value & 1;
                    self.virtual_addr = None;
                    return;
                }
                // Disable (PE=0)
                if prev_pe != 0 && value & 1 == 0 {
                    self.reset(sys);
                    self.virtual_addr = None;
                    return;
                }

                let start = value & (1 << 8);
                let stop = value & (1 << 9);

                // START generation
                if start != 0 && prev_start == 0 {
                    // A new transfer claims the bus: an unread queue-sourced
                    // byte held from a previous STOP tail goes back to the
                    // queue front (FIFO preserved across back-to-back
                    // transfers), then the virtual claim lapses (the next
                    // address phase re-claims if the queue is non-empty).
                    if self.rx_hold_queued {
                        sys.i2c_push_front_rx(self.i2c_channel(), self.dr as u8);
                        self.rx_hold_queued = false;
                    }
                    self.virtual_claim = false;
                    self.state = I2cState::StartSent;
                    self.sr1 = 1; // SB
                    self.sr2 = (1 << 0) | (1 << 1); // BUSY=1, MSL=1
                    self.active_device = None;
                    self.cr1 &= !(1 << 8); // Clear START
                    self.fire_interrupts(sys);
                }

                // STOP generation
                if stop != 0 {
                    sys.push_event(crate::system::VmEvent::I2cStop { channel: self.i2c_channel() });
                    if matches!(self.state, I2cState::Active { .. } | I2cState::AddrSent { .. }) {
                        let rxne_pending = self.sr1 & (1 << 6);
                        if matches!(self.state, I2cState::Active { is_read: true }) && rxne_pending != 0 {
                            // Master receiver: HAL writes STOP in the ADDR handler
                            // (single-byte reads: NACK + STOP immediately), then reads
                            // the byte via RXNE. Keep the pending byte readable.
                            self.state = I2cState::Idle;
                            self.active_device = None;
                            self.sr1_addr_flag = false;
                        } else {
                            self.reset(sys);
                        }
                    } else {
                        // STOP in any other state (e.g. StartSent) — clear BUSY/MSL
                        self.reset(sys);
                    }
                    self.cr1 &= !(1 << 9); // Clear STOP
                }
                // SMBus ALERT output (CR1.13 drives SMBA low): edge → bus
                // event for virtual hosts. Own drive never sets the own
                // SR1 flag (that's the peer-pulled input path, inject only).
                let new_alert = self.cr1 & (1 << 13);
                if new_alert != prev_alert {
                    sys.push_event(crate::system::VmEvent::I2cAlert {
                        channel: self.i2c_channel(),
                        asserted: new_alert != 0,
                    });
                }
            }
            0x04 => {
                let prev_buf = self.cr2 & (1 << 10);
                self.cr2 = value & 0x1FFF;
                if prev_buf != 0 && value & (1 << 10) == 0 {
                    if matches!(self.state, I2cState::Active { .. }) {
                        self.sr1 |= 1 << 2; // BTF
                    }
                }
                if value & (1 << 8 | 1 << 9 | 1 << 10) != 0 {
                    sys.p.nvic.borrow_mut().enable_irq(31);
                    sys.p.nvic.borrow_mut().enable_irq(32);
                }
                self.fire_interrupts(sys);
            }
            0x08 => self.oar1 = value & 0x87FF, // ADD[9:0] + ADDMODE(15)
            0x0C => self.oar2 = value & 0x3FF,
            0x10 => {
                // Driver hook parity (was a JS mem hook): the HAL
                // I2C1 ISR needs hi2c->Mode == 0x22 (MASTER_RX) before reading
                // DR. Flag read-address DR writes for the per-batch RAM patch.
                if self.name == "I2C1" && (value & 1) != 0 {
                    sys.i2c_dr_hook.set(true);
                }
                match self.state {
                    I2cState::StartSent => {
                        let addr = ((value >> 1) & 0x7F) as u8;
                        let is_read = (value & 1) != 0;
                        sys.push_event(crate::system::VmEvent::I2cStart { channel: self.i2c_channel(), addr });
                        let found = self.devices.iter().position(|d| d.address == addr);

                        if addr == 0 && found.is_none() && self.engc() {
                            // General call (ENGC): ACK with no device; the
                            // GENCALL flag (SR2 bit 4) marks it, bytes go
                            // nowhere (documented).
                            self.active_device = None;
                            self.sr1 = 1 << 1; // ADDR
                            self.sr2 = (1 << 0) | (1 << 1) | (1 << 4); // BUSY|MSL|GENCALL
                            if self.pec_enabled() {
                                self.pec = 0;
                                self.pec_feed(value as u8);
                            }
                            self.state = I2cState::AddrSent { is_read };
                        } else if let Some(idx) = found {
                            self.active_device = Some(idx);
                            self.devices[idx].device.borrow_mut().reset();
                            self.sr1 = 1 << 1; // ADDR
                            self.sr2 = (1 << 0) | (1 << 1); // BUSY=1, MSL=1
                            if self.pec_enabled() {
                                self.pec = 0;
                                self.pec_feed(value as u8);
                            }
                            if is_read {
                                let ch = self.i2c_channel();
                                let qb = sys.i2c_take_rx(ch);
                                self.rx_hold_queued = qb.is_some();
                                let byte = qb.unwrap_or_else(|| {
                                    self.devices[idx].device.borrow_mut().read(sys, ()) as u8
                                });
                                self.dr = byte as u32;
                            }
                            self.state = I2cState::AddrSent { is_read };
                        } else {
                            // No engine-internal slave at this address. A
                            // non-empty inject queue is a virtual host's claim
                            // (JS-only slave via onStart/onWrite/onRead +
                            // injectRx, no add_i2c_eeprom): ACK it with ADDR
                            // like a real slave so master transfers can run.
                            // Data comes from the queue (0xFF when momentarily
                            // dry); master-TX bytes surface as I2cWrite. An
                            // empty queue still NACKs (AF), preserving
                            // bus-scan and error semantics (see
                            // test_i2c_busy). CR1 ACK is not consulted here —
                            // it governs slave-to-master byte ACKs, not the
                            // address ACK — matching the device arm above.
                            let ch = self.i2c_channel();
                            if sys.i2c_rx_len(ch) > 0 || self.virtual_addr == Some(addr) {
                                self.active_device = None;
                                self.virtual_claim = true;
                                // Register the address for this host: from here on
                                // the claim no longer depends on queue depth, so
                                // an onWrite-answering slave keeps working after
                                // its queue drains (see `virtual_addr`).
                                self.virtual_addr = Some(addr);
                                self.sr1 = 1 << 1; // ADDR
                                self.sr2 = (1 << 0) | (1 << 1); // BUSY=1, MSL=1
                                if self.pec_enabled() {
                                    self.pec = 0;
                                    self.pec_feed(value as u8);
                                }
                                if is_read {
                                    let qb = sys.i2c_take_rx(ch);
                                    self.rx_hold_queued = qb.is_some();
                                    self.dr = qb.unwrap_or(0xFF) as u32;
                                }
                                self.state = I2cState::AddrSent { is_read };
                            } else {
                                // NACK: set AF (Acknowledge Failure, bit 10)
                                // Real HW generates STOP automatically on NACK, clearing BUSY/MSL
                                self.sr1 = 1 << 10;
                                self.sr2 = 0; // BUSY=0, MSL=0 (STOP generated)
                                self.state = I2cState::Idle;
                                self.active_device = None;
                                self.sr1_addr_flag = false;
                                sys.push_event(crate::system::VmEvent::I2cStop { channel: self.i2c_channel() });
                            }
                        }
                        self.fire_interrupts(sys);
                    }
                    I2cState::Active { is_read: false } => {
                        // Master transmitter: push byte (or the PEC value
                        // when a PEC transfer is armed via CR1.12; the
                        // accumulator covers address + data only).
                        let txb = if self.pec_enabled() && self.pec_xfer() {
                            self.pec
                        } else {
                            value as u8
                        };
                        if let Some(idx) = self.active_device {
                            let mut d = self.devices[idx].device.borrow_mut();
                            d.write(sys, (), txb);
                            sys.push_event(crate::system::VmEvent::I2cWrite { channel: self.i2c_channel(), byte: txb });
                        } else if self.virtual_claim {
                            // JS-only slave: no model to update, but the byte
                            // is still observed (register pointers, commands).
                            sys.push_event(crate::system::VmEvent::I2cWrite { channel: self.i2c_channel(), byte: txb });
                        }
                        // DR now carries a TX byte: any held RX byte is gone.
                        self.rx_hold_queued = false;
                        if self.pec_enabled() && !self.pec_xfer() {
                            self.pec_feed(value as u8);
                        }
                        self.sr1 |= 1 << 7; // TXE
                        self.sr1 &= !(1 << 2); // BTF clears on DR write
                        if self.cr2 & (1 << 11) != 0 {
                            let ch = self.resolve_dma_channel(sys, true);
                            if ch != 0 { sys.p.dma_request(sys, ch as u32); }
                        }
                        self.fire_interrupts(sys);
                    }
                    I2cState::SlaveActive { is_read: true } => {
                        // Slave transmitter: firmware loads the next byte
                        // for the host to read; TXE clears on DR write.
                        self.dr = value & 0xFF;
                        self.sr1 &= !(1 << 7);
                        self.fire_interrupts(sys);
                    }
                    _ => {}
                }
            }
             0x1C => self.ccr = value & 0xFFF,
             0x20 => self.trise = value & 0x3F,
             // SR1 write-0-clears for SMBALERT (RM0008: cleared by SW
             // writing 0). Other status bits keep their existing clear
             // paths (START/ADDR/STOPF/DR sequences); plain writes to them
             // stay no-ops so driver read-modify-write cycles can't wipe
             // live flags.
             0x14 => {
                 if value & (1 << 15) == 0 {
                     self.sr1 &= !(1 << 15);
                 }
                 self.fire_interrupts(sys);
             }
             _ => {}
        }
    }
}
