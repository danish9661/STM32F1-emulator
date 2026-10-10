use crate::system::{System, INSTRUCTION_COUNT};
use super::Peripheral;

/// Minimal ARM DWT (Data Watchpoint and Trace) cycle counter.
///
/// Arduino-STM32's `micros()` and `TwoWire::recoverBus()` spin on
/// `DWT->CYCCNT` (0xE0001004), which reads returned 0 for, so any CYCCNT
/// delay loop hung forever. CYCCNT tracks the global instruction counter
/// (1 instr = 1 cycle, matching the TIM/ADC model), PLUS flash wait-state
/// stalls: each instruction retires `1 + LATENCY` cycles where LATENCY is
/// the FLASH ACR setting (RM0008: 0/1/2 wait states, clamped to 2).
/// Instruction pacing itself is untouched — only the cycle counter sees
/// the stalls, so delay loops paced by CYCCNT stretch exactly like silicon
/// while instruction budgets stay put.
/// CTRL.CYCCNTENA is stored but not gated (lenient, like the rest of the
/// model). Other DWT registers read 0 / ignore writes.
#[derive(Default)]
pub struct Dwt {
    ctrl: u32,
    /// Wait-state-scaled cycles retired up to `last_count`.
    cycles: u64,
    /// INSTRUCTION_COUNT at the last tick (delta base).
    last_count: u64,
    /// Written CYCCNT base: reads return computed cycles + offset, so a
    /// guest write takes effect immediately and then keeps counting.
    cyccnt_offset: i64,
}

impl Dwt {
    pub fn new(name: &str) -> Option<Box<dyn Peripheral>> {
        if name == "DWT" { Some(Box::new(Self::default())) } else { None }
    }

    fn count_now() -> u64 {
        INSTRUCTION_COUNT.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Current cycles per instruction: always 1. The engine retires one
    /// instruction per core-clock cycle everywhere else (SysTick RVR,
    /// TIM PSC/ARR, runner instruction budgets), and silicon with the
    /// prefetch buffer enabled retires sequential code at ~1/cycle too,
    /// so CYCCNT must track the retired-instruction count 1:1.
    /// (A FLASH-latency multiplier lived here briefly and was reverted:
    /// instruction pacing ignores wait states, so inflating only the
    /// counter made DWT-paced delays — STM32duino delayMicroseconds()
    /// spins on CYCCNT — run (1+LATENCY)x fast relative to every other
    /// clock. At 72MHz/WS2 that is 3x fast, breaking sub-ms bit-bang
    /// protocols: the DHT22 start handshake needs a >=1ms wake pulse
    /// and a 55us pull-up wait, both of which collapsed below the
    /// sensor's reaction time. ACR LATENCY still programs and reads
    /// back; it just no longer bends the cycle counter.)
    fn live_rate(_sys: &System) -> u64 {
        1
    }

    /// Cycles retired so far (exact between ticks).
    fn computed(&self, sys: &System) -> u64 {
        let now = Self::count_now();
        self.cycles + now.saturating_sub(self.last_count) * Self::live_rate(sys)
    }

    fn cyccnt(&self, sys: &System) -> u32 {
        (self.computed(sys) as i64).wrapping_add(self.cyccnt_offset) as u32
    }
}

impl Peripheral for Dwt {
    fn tick(&mut self, sys: &System) {
        let now = Self::count_now();
        self.cycles += now.saturating_sub(self.last_count) * Self::live_rate(sys);
        self.last_count = now;
    }

    fn tick_frozen(&mut self, _sys: &System) {
        // Deep sleep gates the core clock: resync the delta base WITHOUT
        // retiring cycles, or the wake tick would redeem the whole sleep
        // as CYCCNT progress (same class as the TIM catch-up bug).
        self.last_count = Self::count_now();
    }

    fn rebase_clock(&mut self, _sys: &System, now: u64) {
        // NRST zeroes the count: re-anchor without retiring (same shape as
        // tick_frozen — cycles are computed from the live count anyway).
        self.last_count = now;
    }

    fn read(&mut self, sys: &System, offset: u32) -> u32 {
        match offset {
            0x00 => self.ctrl,
            0x04 => self.cyccnt(sys),
            _ => 0,
        }
    }

    fn write(&mut self, sys: &System, offset: u32, value: u32) {
        match offset {
            0x00 => self.ctrl = value,
            0x04 => {
                self.cyccnt_offset = (value as i64).wrapping_sub(self.computed(sys) as i64);
            }
            _ => {}
        }
    }
}
