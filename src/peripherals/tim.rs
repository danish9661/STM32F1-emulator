use crate::system::{System, instruction_count};
use super::Peripheral;

fn tim_irq(name: &str) -> Option<i32> {
    match name {
        "TIM1" => Some(24), "TIM2" => Some(28), "TIM3" => Some(29),
        "TIM4" => Some(30), "TIM5" => Some(50), "TIM6" => Some(54),
        "TIM7" => Some(55), "TIM8" => Some(70), "TIM9" => Some(20),
        "TIM10" => Some(25), "TIM11" => Some(26), "TIM12" => Some(43),
        "TIM13" => Some(54), "TIM14" => Some(51),
        _ => None,
    }
}

fn timer_base(name: &str) -> u32 {
    match name {
        "TIM1" => 0x4001_2C00, "TIM8" => 0x4001_3400,
        "TIM9" => 0x4001_4C00, "TIM10" => 0x4001_5000, "TIM11" => 0x4001_5400,
        "TIM2" => 0x4000_0000, "TIM3" => 0x4000_0400, "TIM4" => 0x4000_0800,
        "TIM5" => 0x4000_0C00, "TIM6" => 0x4000_1000, "TIM7" => 0x4000_1400,
        "TIM12" => 0x4000_1800, "TIM13" => 0x4000_1C00, "TIM14" => 0x4000_2000,
        _ => 0,
    }
}

/// ITR slave-mode connections: maps (slave_name, itr_index) → (master_base, master_mms).
/// TS[2:0] selects ITR0-ITR3; the actual trigger comes from the master's MMS output.
/// Table derived from RM0008 (STM32F103) inter-timer connectivity.
fn itr_master(slave: &str, itr: u32) -> Option<(u32, u8)> {
    match (slave, itr) {
        // TIM2: ITR1 = TIM1_TRGO (AFIO remap bit 8 controls connection)
        ("TIM2", 1) => Some((0x4001_2C00, 4)), // TIM1 base, MMS=TRGO(ch4)
        // TIM3: ITR0 = TIM2_TRGO (direct connection)
        ("TIM3", 0) => Some((0x4000_0000, 4)), // TIM2 base, TRGO
        // TIM3: ITR1 = TIM1_TRGO (via AFIO remap)
        ("TIM3", 1) => Some((0x4001_2C00, 4)), // TIM1 base, TRGO
        // TIM4: ITR1 = TIM3_TRGO (direct connection)
        ("TIM4", 1) => Some((0x4000_0400, 4)), // TIM3 base, TRGO
        _ => None,
    }
}

/// Read the trigger output level from the master timer at `master_base`.
/// Returns true if the trigger is active. For MMS=010 (update event output),
/// TRGO pulses on each update event; we approximate by checking if the master
/// timer is currently enabled (CEN=1 in CR1).
fn read_master_trigger(sys: &System, master_base: u32, _ch: u8) -> bool {
    if let Some(slot) = sys.p.bus.borrow().get(master_base) {
        if let Ok(t) = slot.peripheral.try_borrow() {
            return t.is_enabled();
        }
    }
    false
}

/// Default + AFIO-remapped channel -> GPIO pin mapping for STM32F103 timers.
/// `remap` is the AFIO MAPR remap code for the timer (0 = default).
/// Returns (port, pin) where port: 0=A, 1=B, 2=C, 3=D.
/// (pub(crate): also served to JS as the `tim_chan_pin` observation export
/// so hosts can wire PWM outputs to board pins without duplicating this table.)
pub(crate) fn tim_chan_pin(name: &str, ch: u8, remap: u32) -> Option<(u8, u8)> {
    let pins: &[(u8, u8)] = match name {
        "TIM1" => &[(0, 8), (0, 9), (0, 10), (0, 11)], // no remap on Bluepill F103C8
        "TIM2" => match remap & 3 {
            0 => &[(0, 0), (0, 1), (0, 2), (0, 3)],
            1 => &[(0, 15), (1, 3), (1, 10), (1, 11)],
            2 => &[(0, 0), (0, 1), (1, 10), (1, 11)],
            _ => &[(0, 15), (1, 3), (0, 2), (0, 3)],
        },
        "TIM3" => match remap & 3 {
            0 => &[(0, 6), (0, 7), (1, 0), (1, 1)],
            1 => &[(1, 4), (1, 5), (1, 0), (1, 1)],
            _ => &[(2, 6), (2, 7), (2, 8), (2, 9)], // full remap (PC6..PC9)
        },
        "TIM4" => if remap & 1 != 0 {
            &[(3, 12), (3, 13), (3, 14), (3, 15)] // PD12..PD15
        } else {
            &[(1, 6), (1, 7), (1, 8), (1, 9)]      // PB6..PB9
        },
        "TIM5" => &[(0, 0), (0, 1), (0, 2), (0, 3)],
        "TIM8" => &[(2, 6), (2, 7), (2, 8), (2, 9)],
        "TIM9" => &[(0, 2), (0, 3)],
        "TIM10" => &[(1, 8)],
        "TIM11" => &[(1, 9)],
        "TIM12" => &[(1, 14), (1, 15)],
        "TIM13" => &[(0, 6)],
        "TIM14" => &[(1, 1)],
        _ => return None,
    };
    pins.get(ch as usize).copied()
}

pub struct Timer {
    cr1: u32,
    cr2: u32,
    smcr: u32,
    dier: u32,
    sr: u32,
    egr: u32,
    ccmr1: u32,
    ccmr2: u32,
    ccer: u32,
    cnt: u32,
    psc: u32,
    arr: u32,
    ccr: [u32; 4],
    rcr: u32,
    dcr: u32,
    dmar: u32,
    /// DMA-burst window position: each DMAR write lands in the register at
    /// DBA+idx and advances idx (wraps every DBL+1 transfers). Matches HW
    /// sequencing for both DMA-paced and CPU-driven burst writes.
    burst_idx: u8,
    or_: u32,
    // Extended
    ccmr3: u32,
    ccr5: u32,
    ccr6: u32,
    /// Break-and-dead-time register (advanced timers: TIM1/TIM8 on F103
    /// only TIM1 exists). DTG is stored (no edge-shaping surface: PWM
    /// output is duty-value only); MOE gates all outputs, break clears
    /// MOE + raises BIF, LOCK freezes DTG/BKE/BKP/AOE once set.
    bdtr: u32,
    pwm_duty: [u32; 4],
    last_tick: u64,
    irq_num: i32,
    base: u32,
    // Input-capture support: last sampled pin level + edge counter + init flag per ch.
    last_cap: [bool; 4],
    cap_count: [u32; 4],
    cap_inited: [bool; 4],
    #[allow(dead_code)]
    name: String,
    #[allow(dead_code)]
    one_pulse_active: bool,
    /// DMA channel for update events (UDE). 0 = none.
    dma_update_ch: u8,
    /// DMA channel for CCx events (CC1DE-CC4DE). 0 = none.
    dma_cc_ch: [u8; 4],
    /// Previous trigger level for edge detection in slave modes (SMS=4 reset, SMS=6 trigger).
    prev_itr: bool,
    /// PWM input capture: period (ticks between consecutive rising edges) per channel.
    ic_period: [u32; 4],
    /// PWM input capture: pulse width (ticks between rising and falling edge) per channel.
    ic_pulse: [u32; 4],
    /// Timestamp of last rising edge per channel (for PWM input capture).
    ic_rising_ts: [u32; 4],
    /// Whether a rising edge has been captured in PWM input mode per channel.
    ic_rising_captured: [bool; 4],
}

impl Timer {
    pub fn new(name: &str) -> Option<Box<dyn Peripheral>> {
        tim_irq(name).map(|irq| {
            // DMA channels: 1-7 = DMA1, 8-12 = DMA2 (offset by 8)
            let (dma_upd, dma_cc) = match name {
                "TIM1" => (2, [2, 4, 6, 4]),
                "TIM2" => (2, [5, 5, 2, 3]),
                "TIM3" => (3, [6, 4, 1, 3]),
                "TIM4" => (7, [1, 4, 5, 7]),
                // DMA2 channels (offset +8): TIM5 ch4/ch5, TIM6 ch11, TIM7 ch12
                "TIM5" => (12, [13, 13, 12, 12]),  // DMA2 ch4=12, ch5=13
                "TIM6" => (11, [0; 4]),              // DMA2 ch3=11 (update only)
                "TIM7" => (12, [0; 4]),              // DMA2 ch4=12 (update only)
                _ => (0, [0; 4]),
            };
            Box::new(Self {
                cr1: 0, cr2: 0, smcr: 0, dier: 0, sr: 0, egr: 0,
                ccmr1: 0, ccmr2: 0, ccer: 0, cnt: 0, psc: 0,
                // Reset value is 0xFFFF (RM0008: ARR reset = 0xFFFF, the
                // TOP of the 16-bit counter — NOT 0xFFFF_FFFF, which made
                // every closed-form jump compute over a 4B-tick window and
                // wedged the post-NRST catch-up tick in process_batch).
                arr: 0xFFFF,
                ccr: [0; 4], rcr: 0, dcr: 0, dmar: 0, burst_idx: 0, or_: 0,
                 ccmr3: 0, ccr5: 0, ccr6: 0, pwm_duty: [0; 4],
                bdtr: 0,
                 last_tick: instruction_count(),
                 irq_num: irq,
                 base: timer_base(name),
                 last_cap: [false; 4], cap_count: [0; 4], cap_inited: [false; 4],
                name: name.to_string(),
                one_pulse_active: false,
                dma_update_ch: dma_upd,
                dma_cc_ch: dma_cc,
                prev_itr: false,
                ic_period: [0; 4], ic_pulse: [0; 4],
                ic_rising_ts: [0; 4], ic_rising_captured: [false; 4],
            }) as Box<dyn Peripheral>
        })
    }

    fn prescaler(&self) -> u64 {
        (self.psc as u64).saturating_add(1)
    }

    fn elapsed_ticks(&self) -> u64 {
        let now = instruction_count();
        let delta = now.wrapping_sub(self.last_tick);
        delta / self.prescaler()
    }

    fn advance(&mut self, sys: &System) {
        let ticks = self.elapsed_ticks();
        if ticks == 0 { return; }
        self.last_tick = instruction_count();

        let enabled = self.cr1 & 1;
        if enabled == 0 { return; }

        // Slave mode handling
        let sms = self.smcr & 7;
        if sms != 0 {
            let ts = (self.smcr >> 4) & 7;
            let trigger_active = if let Some((master_base, ch)) = itr_master(&self.name, ts) {
                read_master_trigger(sys, master_base, ch)
            } else {
                false
            };
            match sms {
                5 => { // Gated mode (SMS=101): counter runs only when trigger is high
                    if !trigger_active { return; }
                }
                6 => { // Trigger mode (SMS=110): counter starts on trigger rising edge
                    let rising = trigger_active && !self.prev_itr;
                    self.prev_itr = trigger_active;
                    if !rising { return; }
                }
                4 => { // Reset mode (SMS=100): counter resets on trigger rising edge
                    let rising = trigger_active && !self.prev_itr;
                    self.prev_itr = trigger_active;
                    if rising {
                        self.cnt = 0;
                    }
                }
                7 => { // External clock mode (SMS=111): count on trigger edges
                    let rising = trigger_active && !self.prev_itr;
                    self.prev_itr = trigger_active;
                    if !rising { return; }
                }
                1 | 2 | 3 => { // Encoder modes: count via TI1/TI2 edges
                    self.encoder_tick(sys);
                    return;
                }
                _ => {}
            }
        } else {
            self.prev_itr = false;
        }

        let cms = (self.cr1 >> 5) & 0x3;
        let down = cms == 0 && (self.cr1 >> 4) & 1 == 1;
        let arr = self.arr as u64;

        // Closed-form advance: skip no-event ticks in bulk and only execute the
        // per-tick body at event ticks (update wrap + CCx compare matches). CNT
        // is only observable at batch boundaries (step_batch), and all events
        // (UIF/CCxIF/TRGO/DMA-request) pend into batch-boundary queues, so the
        // final CNT + fired events are bit-identical to iterating every tick —
        // without the O(ticks) cost (3 active timers × 20K ticks × 4 channels
        // dominated step_batch: ~14.5% of runtime).
        let mut remaining = ticks;
        while remaining > 0 {
            let cnt = self.cnt as u64;
            let mut next = if down {
                // update fires on the tick AFTER cnt reaches 0 (wrap tick);
                // if cnt >= remaining the wrap lies beyond this batch
                if cnt >= remaining { remaining } else { cnt + 1 }
            } else if cnt < arr {
                arr - cnt + 1
            } else {
                1 // cnt >= arr: next tick wraps
            };
            for ch in 0..4 {
                if self.ccer & (1 << (ch * 4)) == 0 { continue; }
                let ccr = self.ccr[ch] as u64;
                // CCx match fires on the tick where cnt crosses ccr (old==ccr
                // also matches); ccr already passed only re-fires via the wrap
                // tick's overflow check in tick_once. Down-mode ccr==0 at cnt==0
                // can't match: that tick wraps (new=arr, no match_down).
                let d = if down {
                    if cnt > ccr { cnt - ccr }
                    else if cnt == ccr { if ccr == 0 { u64::MAX } else { 1 } }
                    else { u64::MAX }
                } else if cnt <= ccr {
                    (ccr - cnt).max(1)
                } else {
                    u64::MAX
                };
                next = next.min(d);
            }
            next = next.min(remaining);
            if next > 1 {
                if down { self.cnt = (cnt - (next - 1)) as u32; }
                else { self.cnt = (cnt + next - 1) as u32; }
                remaining -= next - 1;
            }
            self.tick_once(sys);
            remaining -= 1;
        }

        // Update PWM duty based on CCR/ARR
        for ch in 0..4 {
            if self.ccer & (1 << (ch * 4)) != 0 && self.arr != u32::MAX {
                // Dead-time insertion (BDTR DTG, advanced timers, channels
                // with complementary outputs): the rising edge slips by DT
                // timer clocks, narrowing the effective high time.
                let mut high = self.ccr[ch];
                if ch < 3 && (self.name == "TIM1" || self.name == "TIM8") {
                    high = high.saturating_sub(self.deadtime_ticks());
                }
                self.pwm_duty[ch] = high * 100 / (self.arr + 1);
            }
        }

        self.sample_break(sys);
        self.update_interrupt(sys);
    }

    /// Dead-time generator count in timer clocks, decoded from BDTR DTG
    /// (RM0008): 0xx → DTG[6:0]×T, 10x → (64+DTG[5:0])×2T,
    /// 110 → (32+DTG[4:0])×8T, 111 → (32+DTG[4:0])×16T.
    fn deadtime_ticks(&self) -> u32 {
        let dtg = (self.bdtr & 0xFF) as u64;
        (match (dtg >> 5) & 7 {
            0..=3 => dtg & 0x7F,
            4..=5 => (64 + (dtg & 0x3F)) * 2,
            6 => (32 + (dtg & 0x1F)) * 8,
            _ => (32 + (dtg & 0x1F)) * 16,
        }) as u32
    }

    /// Break input (advanced timers only): TIM1 BKIN defaults to PB12.
    /// A level matching BKP polarity with BKE set clears MOE in hardware,
    /// raises BIF (SR bit 7) and IRQs when BIE is set. Sampled once per
    /// batch (level-sensitive, like silicon).
    fn sample_break(&mut self, sys: &System) {
        if self.name != "TIM1" || self.bdtr & (1 << 12) == 0 {
            return; // BKE clear
        }
        if self.bdtr & (1 << 15) == 0 {
            return; // MOE already off
        }
        let level = sys.p.gpio.borrow_mut().read_pin_effective(sys, 1, 12);
        let active = level == (self.bdtr & (1 << 13) != 0); // BKP: 1 = active high
        if !active {
            return;
        }
        self.bdtr &= !(1 << 15); // MOE cleared by hardware
        self.sr |= 1 << 7; // BIF
        if self.dier & (1 << 7) != 0 {
            sys.p.nvic.borrow_mut().set_intr_pending(self.irq_num);
        }
    }

    /// Encoder mode: read TI1/TI2 pins and count edges per SMS[1:0] mode.
    /// SMS=001: count on TI1 only; SMS=010: count on TI2 only;
    /// SMS=011: count on both TI1 and TI2 edges (3x resolution).
    fn encoder_tick(&mut self, sys: &System) {
        let sms = self.smcr & 3; // SMS[1:0]
        let remap = sys.p.afio_remap_status(&self.name).unwrap_or(0);
        let ti1 = if let Some((p, i)) = tim_chan_pin(&self.name, 0, remap) {
            sys.p.gpio.borrow_mut().read_pin_effective(sys, p, i)
        } else { return };
        let ti2 = if let Some((p, i)) = tim_chan_pin(&self.name, 1, remap) {
            sys.p.gpio.borrow_mut().read_pin_effective(sys, p, i)
        } else { return };

        let dir = (self.cr1 >> 4) & 1; // DIR bit

        // Detect edges and update counter
        match sms {
            1 => { // Count on TI1 edges
                if ti1 != self.last_cap[0] {
                    self.last_cap[0] = ti1;
                    if (ti1 && dir == 0) || (!ti1 && dir == 1) {
                        self.cnt = self.cnt.wrapping_add(1);
                    } else {
                        self.cnt = self.cnt.wrapping_sub(1);
                    }
                }
            }
            2 => { // Count on TI2 edges
                if ti2 != self.last_cap[1] {
                    self.last_cap[1] = ti2;
                    if (ti2 && dir == 0) || (!ti2 && dir == 1) {
                        self.cnt = self.cnt.wrapping_add(1);
                    } else {
                        self.cnt = self.cnt.wrapping_sub(1);
                    }
                }
            }
            3 => { // Count on both TI1 and TI2 edges
                let old1 = self.last_cap[0];
                let old2 = self.last_cap[1];
                self.last_cap[0] = ti1;
                self.last_cap[1] = ti2;
                if ti1 != old1 {
                    // TI1 edge: count based on TI2 level
                    if (ti1 && !ti2) || (!ti1 && ti2) {
                        self.cnt = self.cnt.wrapping_add(1);
                    } else {
                        self.cnt = self.cnt.wrapping_sub(1);
                    }
                }
                if ti2 != old2 {
                    // TI2 edge: count based on TI1 level
                    if (ti2 && ti1) || (!ti2 && !ti1) {
                        self.cnt = self.cnt.wrapping_add(1);
                    } else {
                        self.cnt = self.cnt.wrapping_sub(1);
                    }
                }
            }
            _ => {}
        }
    }

    /// The original per-tick loop body, executed only at event ticks.
    fn tim_num(&self) -> u8 {
        self.name.trim_start_matches("TIM").parse::<u8>().unwrap_or(0)
    }

    fn tick_once(&mut self, sys: &System) {
        let cms = (self.cr1 >> 5) & 0x3;
        let down = cms == 0 && (self.cr1 >> 4) & 1 == 1;
        let old_cnt = self.cnt;
        let arr = self.arr as u64;
        let cnt = old_cnt as u64;

        if down {
            if old_cnt > 0 { self.cnt -= 1; }
            else {
                self.cnt = self.arr;
                self.sr |= 1; // UIF
                self.update_event_trigger(sys);
                sys.push_event(crate::system::VmEvent::TimUpdate { tim: self.tim_num() });
                if self.dier & 1 != 0 { // UIE
                    sys.p.nvic.borrow_mut().set_intr_pending(self.irq_num);
                }
                if self.dier & (1 << 8) != 0 && self.dma_update_ch != 0 { // UDE
                    sys.p.dma_request(sys, self.dma_update_ch as u32);
                }
            }
        } else if cnt < arr {
            self.cnt += 1;
        } else {
            self.cnt = 0;
            self.sr |= 1; // UIF
            self.update_event_trigger(sys);
            sys.push_event(crate::system::VmEvent::TimUpdate { tim: self.tim_num() });
            if self.dier & 1 != 0 { // UIE
                sys.p.nvic.borrow_mut().set_intr_pending(self.irq_num);
            }
            if self.dier & (1 << 8) != 0 && self.dma_update_ch != 0 { // UDE
                sys.p.dma_request(sys, self.dma_update_ch as u32);
            }
        }

        // Output compare / PWM interrupts (skip input-capture channels)
        for ch in 0..4 {
            let ccmr = if ch < 2 { self.ccmr1 } else { self.ccmr2 };
            let off = if ch < 2 { ch } else { ch - 2 };
            let ccs = (ccmr >> (off * 8)) & 3;
            if ccs != 0 { continue; } // input capture mode
            if self.ccer & (1 << (ch * 4)) != 0 { // CCxE
                let ccr_val = self.ccr[ch];
                let new_cnt = self.cnt;
                let match_up = !down && old_cnt <= ccr_val && new_cnt >= ccr_val;
                let match_down = down && old_cnt >= ccr_val && new_cnt <= ccr_val;
                let match_overflow = (old_cnt > new_cnt) && (old_cnt <= ccr_val || new_cnt >= ccr_val);
                if match_up || match_down || match_overflow {
                    self.sr |= 1 << (1 + ch); // CC1IF-CC4IF
                    // ADC external trigger on channel compare events
                    sys.p.adc_timer_trigger(sys, self.base, ch as u8);
                    // DMA request when CCxDE enabled (DIER bit 9+ch)
                    if self.dier & (1 << (9 + ch)) != 0 && self.dma_cc_ch[ch] != 0 {
                        sys.p.dma_request(sys, self.dma_cc_ch[ch] as u32);
                    }
                    let cc_irq_enable = (self.dier >> (1 + ch)) & 1;
                    if cc_irq_enable != 0 {
                        sys.p.nvic.borrow_mut().set_intr_pending(self.irq_num);
                    }
                }
            }
        }
    }

    fn update_event_trigger(&mut self, sys: &System) {
        // TRGO fires on update when MMS = 010 (update)
        if (self.cr2 >> 4) & 7 == 2 {
            sys.p.adc_timer_trigger(sys, self.base, 4);
        }
    }

    fn update_interrupt(&self, _sys: &System) {
        // UIF, CCxIF, TIF, etc. already trigger during advance
    }

    fn generate_update(&mut self, sys: &System) {
        self.cnt = 0;
        self.sr |= 1; // UIF
        // AOE re-arms MOE on every update (advanced timers).
        if self.bdtr & (1 << 14) != 0 {
            self.bdtr |= 1 << 15;
        }
        self.update_event_trigger(sys);
        sys.push_event(crate::system::VmEvent::TimUpdate { tim: self.tim_num() });
        if self.dier & 1 != 0 {
            sys.p.nvic.borrow_mut().set_intr_pending(self.irq_num);
        }
    }

    /// Sample input-capture channel pins once per batch. When a channel is
    /// configured for input capture (CCxS != 0) and an edge matching its
    /// polarity occurs on the source pin, latch CNT into CCRx, set CCxIF, and
    /// emit a TimCapture event.
    fn sample_input_capture(&mut self, sys: &System) {
        for ch in 0..4u8 {
            let ccmr = if ch < 2 { self.ccmr1 } else { self.ccmr2 };
            let off = if ch < 2 { ch } else { ch - 2 } as u32;
            let ccs = (ccmr >> (off * 8)) & 3;
            if ccs == 0 { continue; } // output compare mode
            let src_ch = if ccs == 1 { ch } else { ch ^ 1 }; // CCxS=10 -> partner pin
            let psc = ((ccmr >> (off * 8 + 2)) & 3) as u32; // ICxPSC prescaler
            let remap = sys.p.afio_remap_status(&self.name).unwrap_or(0);
            let (port, pin) = match tim_chan_pin(&self.name, src_ch, remap) { Some(p) => p, None => continue };
            let level = sys.p.gpio.borrow_mut().read_pin_effective(sys, port, pin);
            if !self.cap_inited[ch as usize] {
                self.cap_inited[ch as usize] = true;
                self.last_cap[ch as usize] = level;
                continue;
            }
            let prev = self.last_cap[ch as usize];
            self.last_cap[ch as usize] = level;
            if level == prev { continue; }
            let ccer_bit = (ch as usize) * 4;
            let cxp = (self.ccer >> (ccer_bit + 1)) & 1;
            let cxnp = (self.ccer >> (ccer_bit + 3)) & 1;
            // CCxP=0 & CCXNP=0 -> rising; CCxP=1 & CCXNP=1 -> both; else falling
            let rising_ok = (cxp == 0 && cxnp == 0) || (cxp == 1 && cxnp == 1);
            let falling_ok = cxp == 1;
            let is_rising = level && !prev;
            let is_falling = !level && prev;
            if !((is_rising && rising_ok) || (is_falling && falling_ok)) { continue; }
            self.cap_count[ch as usize] += 1;
            if self.cap_count[ch as usize] % (psc + 1) != 0 { continue; }

            // PWM input capture: when both edges are configured (CCxP=1 & CCXNP=1),
            // capture period on rising and pulse width on falling.
            if cxp == 1 && cxnp == 1 {
                let cnt = self.cnt;
                let ch_usize = ch as usize;
                if is_rising {
                    if self.ic_rising_captured[ch_usize] {
                        let prev_ts = self.ic_rising_ts[ch_usize];
                        self.ic_period[ch_usize] = cnt.wrapping_sub(prev_ts);
                    }
                    self.ic_rising_ts[ch_usize] = cnt;
                    self.ic_rising_captured[ch_usize] = true;
                } else if self.ic_rising_captured[ch_usize] {
                    self.ic_pulse[ch_usize] = cnt.wrapping_sub(self.ic_rising_ts[ch_usize]);
                }
                // Also write CCR for backward compatibility
                self.ccr[ch_usize] = cnt;
                self.sr |= 1 << (1 + ch as u32); // CCxIF
                sys.push_event(crate::system::VmEvent::TimCapture { tim: self.tim_num(), ch, value: cnt });
                if (self.dier >> (1 + ch as u32)) & 1 != 0 {
                    sys.p.nvic.borrow_mut().set_intr_pending(self.irq_num);
                }
            } else {
                // Standard input capture
                self.ccr[ch as usize] = self.cnt;
                self.sr |= 1 << (1 + ch as u32); // CCxIF
                sys.push_event(crate::system::VmEvent::TimCapture { tim: self.tim_num(), ch, value: self.cnt });
                if (self.dier >> (1 + ch as u32)) & 1 != 0 {
                    sys.p.nvic.borrow_mut().set_intr_pending(self.irq_num);
                }
            }
        }
    }
}

impl Peripheral for Timer {
    fn periph_remap(&self, sys: &System) -> Option<u32> {
        sys.p.afio_remap_status(&self.name)
    }

    fn is_enabled(&self) -> bool {
        self.cr1 & 1 != 0 // CEN
    }

    fn pwm_duty(&self, channel: u32) -> Option<u32> {
        // Advanced-timer outputs die with MOE (break or SW clear).
        if self.name == "TIM1" && self.bdtr & (1 << 15) == 0 {
            return Some(0);
        }
        self.pwm_duty.get(channel as usize).copied()
    }

    fn tick(&mut self, sys: &System) {
        self.sample_input_capture(sys);
        self.advance(sys);
    }

    /// Frozen in STOP/STANDBY: sync the instruction-delta base without
    /// advancing the counter (the timer clock is gated in deep sleep).
    fn tick_frozen(&mut self, _sys: &System) {
        self.last_tick = instruction_count();
    }

    fn rebase_clock(&mut self, _sys: &System, now: u64) {
        // NOTE: AFIO-remap reads are skipped here on purpose: the remap
        // query re-borrows the bus + AFIO peripheral, which panics when
        // called under the slot's own borrow_mut (board_nrst rebase loop).
        // Input-capture pin sampling needs no remap for the rebase (only
        // the delta base moves; edges are sampled on the next tick).
        self.last_tick = now;
    }

    fn read(&mut self, sys: &System, offset: u32) -> u32 {
        if offset == 0x24 { return self.cnt; }
        self.advance(sys);
        match offset {
            0x00 => self.cr1,
            0x04 => self.cr2,
            0x08 => self.smcr,
            0x0C => self.dier,
            0x10 => self.sr,
            0x14 => {
                // EGR reads as 0
                self.egr
            }
            0x18 => self.ccmr1,
            0x1C => self.ccmr2,
            0x20 => self.ccer,
            0x24 => self.cnt,
            0x28 => self.psc,
            0x2C => self.arr,
            0x30 => self.rcr,
            // BDTR exists only on advanced timers (TIM1/TIM8).
            0x44 if self.name == "TIM1" || self.name == "TIM8" => self.bdtr,
            0x34..=0x40 => {
                let i = ((offset - 0x34) / 4) as usize;
                self.ccr.get(i).copied().unwrap_or(0)
            }
            0x48 => self.dcr,
            0x4C => self.dmar,
            0x50 => self.or_,
            0x54 => self.ccmr3,
            0x58 => self.ccr5,
            0x5C => self.ccr6,
            // PWM input capture: OR1 space (0x60-0x6C) returns period/pulse
            // on channels 1-4. These sit in unused register space on F103 but
            // give firmware a way to read captured values via the emulator API.
            0x60 => self.ic_period[0],
            0x64 => self.ic_pulse[0],
            0x68 => self.ic_period[1],
            0x6C => self.ic_pulse[1],
            _ => 0,
        }
    }

    fn write(&mut self, sys: &System, offset: u32, value: u32) {
        self.advance(sys);
        match offset {
            0x00 => {
                let was_enabled = self.cr1 & 1;
                self.cr1 = value & 0xFFFE_F17F;
                if self.cr1 & 1 != 0 && was_enabled == 0 {
                    // Enable: reset counter to 0
                    self.cnt = 0;
                }
            }
            0x04 => self.cr2 = value & 0x3F7F,
            0x08 => self.smcr = value & 0xFFFF,
            0x0C => {
                self.dier = value & 0xFFFF;
                if value & 1 != 0 {
                    sys.p.nvic.borrow_mut().enable_irq(self.irq_num);
                }
                self.update_interrupt(sys);
            }
            0x10 => self.sr &= value,
            0x14 => {
                self.egr = value & 0xFF;
                if value & 1 != 0 { self.generate_update(sys); } // UG
            }
            0x18 => self.ccmr1 = value,
            0x1C => self.ccmr2 = value,
            0x20 => self.ccer = value & 0xFFFF,
            0x24 => self.cnt = value & 0xFFFF,
            0x28 => self.psc = value & 0xFFFF,
            0x2C => self.arr = value & 0xFFFFFFFF,
            0x30 => self.rcr = value & 0xFF,
            // BDTR exists only on advanced timers (TIM1/TIM8); general
            // timers ignore the write.
            0x44 if self.name == "TIM1" || self.name == "TIM8" => {
                // BDTR with LOCK: once LOCK[9:8] is raised it can only go
                // up (never down) without reset, and DTG/BKE/BKP/AOE
                // freeze while LOCK != 0. OSSI/OSSR/MOE stay writable
                // (MOE must remain SW-settable and HW-clearable).
                let old_lock = (self.bdtr >> 8) & 3;
                let new_lock = (value >> 8) & 3;
                let mut v = value & 0xFFFF;
                if new_lock < old_lock {
                    v = (v & !(3 << 8)) | (self.bdtr & (3 << 8));
                }
                if (self.bdtr >> 8) & 3 != 0 {
                    v = (v & !(0xFF | (1 << 12) | (1 << 13) | (1 << 14)))
                        | (self.bdtr & (0xFF | (1 << 12) | (1 << 13) | (1 << 14)));
                }
                self.bdtr = v;
            }
            0x34..=0x40 => {
                let i = ((offset - 0x34) / 4) as usize;
                if let Some(ccr) = self.ccr.get_mut(i) {
                    *ccr = value & 0xFFFF;
                }
            }
            0x48 => {
                self.dcr = value & 0x1F1F;
                self.burst_idx = 0; // reprogramming the window restarts it
            }
            0x4C => {
                self.dmar = value;
                // DMA burst: route the write into the DBA window
                // (DBL+1 transfers, DBA counts 32-bit words from CR1).
                let dba = (self.dcr & 0x1F) as usize;
                let count = ((self.dcr >> 8) & 0x1F) as usize + 1;
                let off = ((dba + self.burst_idx as usize) * 4) as u32;
                self.burst_idx = (self.burst_idx as usize + 1) as u8 % count.max(1) as u8;
                // Known register map only (CR1..CCR6); anything else
                // (incl. the DMAR alias itself) is store-only. Recursion
                // depth is 1: routed offsets never re-enter this arm.
                if off != 0x4C && off <= 0x5C {
                    self.write(sys, off, value);
                }
            }
            0x50 => self.or_ = value & 0xFF,
            0x54 => self.ccmr3 = value,
            0x58 => self.ccr5 = value & 0xFFFF,
            0x5C => self.ccr6 = value & 0xFFFF,
            _ => {}
        }
    }
}
