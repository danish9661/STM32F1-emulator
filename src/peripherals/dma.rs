use crate::system::{System, DmaTransfer, DmaDir, set_dma_intr_info};
use super::Peripheral;

pub struct Dma {
    name: String,
    isr: u32,
    ifcr: u32,
    channels: Vec<Channel>,
    num_channels: usize,
    /// DMA channel numbers that have pending requests from peripherals.
    /// Processed in tick(); keeps peripheral dma_request() free of borrow issues.
    pending_requests: Vec<u32>,
}

impl Default for Dma {
    fn default() -> Self {
        Self {
            name: String::new(),
            isr: 0, ifcr: 0,
            channels: Vec::new(),
            num_channels: 7,
            pending_requests: Vec::new(),
        }
    }
}

impl Dma {
    pub fn new(name: &str) -> Option<Box<dyn Peripheral>> {
        if name == "DMA1" {
            Some(Box::new(Self {
                name: name.to_string(),
                channels: vec![Channel::default(); 7],
                num_channels: 7,
                pending_requests: Vec::new(),
                ..Default::default()
            }))
        } else if name == "DMA2" {
            Some(Box::new(Self {
                name: name.to_string(),
                channels: vec![Channel::default(); 5],
                num_channels: 5,
                pending_requests: Vec::new(),
                ..Default::default()
            }))
        } else {
            None
        }
    }

    fn channel_irq(&self, ch: usize) -> i32 {
        // DMA1: IRQ 11-17 (channels 1-7). DMA2: IRQ 56-60 (channels 1-5).
        if self.name == "DMA2" {
            56 + ch as i32
        } else {
            11 + ch as i32
        }
    }
}

#[derive(Default, Clone)]
struct Channel {
    cr: u32,
    ndtr: u32,
    par: u32,
    mar: u32,
    /// CNDTR latched at EN rising edge: circular mode reloads it on every
    /// completion instead of stopping (silicon auto-reload).
    ndtr_init: u32,
}

impl Channel {
    fn dir(&self) -> u8 { ((self.cr >> 4) & 1) as u8 }
    fn data_size(&self) -> usize {
        let psize = match (self.cr >> 8) & 0b11 { 0b00 => 1, 0b01 => 2, _ => 4 };
        let msize = match (self.cr >> 10) & 0b11 { 0b00 => 1, 0b01 => 2, _ => 4 };
        std::cmp::max(msize, psize) * self.ndtr as usize
    }

    fn do_xfer(&self, name: &str, sys: &System, ch: usize) {
        let m2m = self.cr & (1 << 14) != 0;
        let dir = self.dir();
        let (src, dst, direction, peripheral) = if m2m {
            (self.par, self.mar, DmaDir::MemCopy, false)
        } else if dir == 1 {
            (self.mar, self.par, DmaDir::Write, true)
        } else {
            (self.par, self.mar, DmaDir::Read, true)
        };
        let size = self.data_size();
        // Completion stream indices are GLOBAL across both DMAs (DMA1 ch0-6 ->
        // streams 0-6, DMA2 ch0-4 -> streams 7-11): the completion bitspace
        // and IRQ/flag tables in system.rs are shared, so local indices would
        // collide (DMA1 CH4 and DMA2 CH4 both claiming stream 3).
        let stream_idx = if name == "DMA2" { 7 + ch } else { ch };
        sys.queue_dma_transfer(DmaTransfer {
            direction,
            stream_idx,
            dma_name: name.to_string(),
            src, dst, size,
            peri_addr: self.par,
            peripheral,
        });
    }
}

impl Peripheral for Dma {
    fn dma_request(&mut self, _sys: &System, channel: u32) {
        if (channel as usize) < self.num_channels && !self.pending_requests.contains(&channel) {
            self.pending_requests.push(channel);
        }
    }

    fn tick(&mut self, sys: &System) {
        let nc = self.num_channels;
        let pending: Vec<u32> = self.pending_requests.drain(..).collect();
        for &ch in &pending {
            let ch_idx = ch as usize;
            if ch_idx < nc && self.channels[ch_idx].cr & 1 != 0 && self.channels[ch_idx].ndtr > 0 {
                self.channels[ch_idx].do_xfer(&self.name, sys, ch_idx);
            }
        }

        // Take only this DMA's streams; the other DMA's bits stay queued for
        // its own tick (a plain global drain here would eat them).
        let base = if self.name == "DMA2" { 7 } else { 0 };
        let mut own_mask = 0u32;
        for ch in 0..nc {
            own_mask |= 1 << (base + ch);
        }
        let bits = sys.dma_take_completions_masked(own_mask);
        if bits != 0 {
            // Global stream numbering (see do_xfer): this DMA owns streams
            // [base, base+nc).
            for ch in 0..nc {
                if bits & (1 << (base + ch)) != 0 {
                    // Circular mode (CCR.5): the transfer passed halfway AND
                    // completed in the same pump (whole buffer moves at once),
                    // so both HTIF and TCIF set; NDTR reloads and EN stays
                    // set for the next cycle instead of stopping.
                    if self.channels[ch].cr & (1 << 5) != 0 {
                        self.isr |= (1 << (ch * 4 + 1)) | (1 << (ch * 4 + 2));
                        self.channels[ch].ndtr = self.channels[ch].ndtr_init;
                    } else {
                        self.isr |= 1 << (ch * 4 + 1); // TCIF
                        self.channels[ch].cr &= !1;
                        self.channels[ch].ndtr = 0;
                    }
                }
            }
        }
    }

    fn read(&mut self, _sys: &System, offset: u32) -> u32 {
        match offset {
            0x00 => self.isr,
            0x04 => self.ifcr,
            _ => {
                let nc = self.num_channels;
                if offset >= 0x08 && offset < 0x08 + (nc as u32) * 0x14 {
                    let ch = ((offset - 0x08) / 0x14) as usize;
                    let reg = (offset - 0x08) % 0x14;
                    if ch < nc {
                        return match reg {
                            0x00 => self.channels[ch].cr,
                            0x04 => self.channels[ch].ndtr,
                            0x08 => self.channels[ch].par,
                            0x0C => self.channels[ch].mar,
                            _ => 0,
                        };
                    }
                }
                0
            }
        }
    }

    fn write(&mut self, sys: &System, offset: u32, value: u32) {
        let nc = self.num_channels;
        match offset {
            0x00 => {}
            0x04 => {
                for ch in 0..nc {
                    let mask = value >> (ch * 4);
                    if mask & 0x0F != 0 {
                        self.isr &= !(mask << (ch * 4));
                    }
                }
            }
            _ => {
                if offset >= 0x08 && offset < 0x08 + (nc as u32) * 0x14 {
                    let ch = ((offset - 0x08) / 0x14) as usize;
                    let reg = (offset - 0x08) % 0x14;
                    if ch < nc {
                        match reg {
                            0x00 => {
                                let was_en = self.channels[ch].cr & 1;
                                self.channels[ch].cr = value & 0x7FFF;
                                if value & 1 != 0 {
                                    // Latch the reload count on EN rising edge
                                    // (firmware programs CNDTR first, silicon order).
                                    if was_en == 0 {
                                        self.channels[ch].ndtr_init = self.channels[ch].ndtr;
                                    }
                                    self.channels[ch].do_xfer(&self.name, sys, ch);
                                    let irq = self.channel_irq(ch);
                                    let cr = self.channels[ch].cr;
                                    // RM0008 DMA_CCRx: EN=0, TCIE=1, HTIE=2,
                                    // TEIE=3, DIR=4 (see SVD CCR1 register).
                                    let tcie = ((cr >> 1) & 1) as u8;
                                    let htie = ((cr >> 2) & 1) as u8;
                                    let teie = ((cr >> 3) & 1) as u8;
                                    let flags = tcie | (htie << 1) | (teie << 2);
                                    let stream = if self.name == "DMA2" { 7 + ch } else { ch };
                                    set_dma_intr_info(stream, irq, flags);
                                }
                            }
                            0x04 => self.channels[ch].ndtr = value & 0xFFFF,
                            0x08 => self.channels[ch].par = value,
                            0x0C => self.channels[ch].mar = value,
                            _ => {}
                        }
                    }
                }
            }
        }
    }
}
