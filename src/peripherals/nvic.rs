use crate::system::{System, INSTRUCTION_COUNT, INTR_MASK_PRIMASK, INTR_MASK_BASEPRI};
use std::sync::atomic::Ordering;
use super::Peripheral;

const IRQ_COUNT: usize = 97;
const IRQ_OFFSET: i32 = 16;
const REG_WORDS: usize = (IRQ_COUNT + 31) / 32;

pub mod irq {
    pub const NMI: i32 = -14;
    pub const HARD_FAULT: i32 = -13;
    pub const MEM_MANAGE: i32 = -12;
    pub const BUS_FAULT: i32 = -11;
    pub const USAGE_FAULT: i32 = -10;
    pub const SVCALL: i32 = -5;
    pub const PENDSV: i32 = -2;
    pub const SYSTICK: i32 = -1;
}

#[derive(Clone)]
pub struct Nvic {
    pub systick_period: Option<u32>,
    pub last_systick_trigger: u64,
    pub systick_debt: u32,
    pending: u128,
    enable: [u32; REG_WORDS],
    pending_reg: [u32; REG_WORDS],
    active: [u32; REG_WORDS],
    priority: [u8; IRQ_COUNT],
    /// System exception priorities for exceptions 4..15 (SHPR1-3). Default 0x80.
    sys_handler_priority: [u8; 16],
    /// Active exception priorities stack (top = current priority)
    active_prio_stack: Vec<u8>,
    /// Last IRQ popped by get_next_pending_intr (for same-batch fairness)
    last_popped: Option<i32>,
}

impl Default for Nvic {
    fn default() -> Self {
        Self {
            systick_period: None,
            last_systick_trigger: 0,
            systick_debt: 0,
            pending: 0,
            enable: [0; REG_WORDS],
            pending_reg: [0; REG_WORDS],
            active: [0; REG_WORDS],
            priority: [0; IRQ_COUNT],
            sys_handler_priority: [0x80; 16],
            active_prio_stack: Vec::new(),
            last_popped: None,
        }
    }
}

impl Nvic {
    fn irq_reg_idx(irq: i32) -> Option<(usize, u32)> {
        if irq < 0 { return None; }
        let idx = (irq as usize) / 32;
        let mask = 1u32 << (irq as usize % 32);
        if idx >= REG_WORDS { None } else { Some((idx, mask)) }
    }

    pub fn enable_irq(&mut self, irq: i32) {
        if let Some((idx, mask)) = Self::irq_reg_idx(irq) {
            self.enable[idx] |= mask;
        }
    }

    pub fn set_intr_pending(&mut self, irq: i32) {
        // All peripheral/USC/STIR/SysTick pends funnel through here: mark
        // the hot-loop hint mirror (conservative — invalid IRQs also mark;
        // a spurious hint costs one wasted borrow, never a missed IRQ).
        crate::system::nvic_mark_pending();
        if irq < 0 {
            self.pending |= 1u128 << (IRQ_OFFSET + irq);
        } else if let Some((idx, mask)) = Self::irq_reg_idx(irq) {
            self.pending |= 1u128 << (IRQ_OFFSET + irq);
            self.pending_reg[idx] |= mask;
        }
    }

    /// Push an active-priority entry for a synchronously-taken exception
    /// (SVC), which has no pending bit to pop via get_next_pending_intr.
    /// Balanced by exactly one pop in `exception_return` (via
    /// `clear_current_interrupt`), including nested entries.
    pub fn push_active(&mut self, irq: i32) {
        if irq == irq::NMI || irq == irq::HARD_FAULT {
            if let Some(p) = Self::fixed_exception_priority(irq) {
                self.active_prio_stack.push(p);
                return;
            }
        }
        self.active_prio_stack.push(self.exception_priority(irq));
    }

    pub fn clear_pending(&mut self, irq: i32) {
        self.pending &= !(1u128 << (IRQ_OFFSET + irq));
        if let Some((idx, mask)) = Self::irq_reg_idx(irq) {
            self.pending_reg[idx] &= !mask;
        }
    }

    pub fn is_enabled(&self, irq: i32) -> bool {
        if let Some((idx, mask)) = Self::irq_reg_idx(irq) {
            self.enable[idx] & mask != 0
        } else {
            false
        }
    }

    pub fn is_pending(&self, irq: i32) -> bool {
        if let Some((idx, mask)) = Self::irq_reg_idx(irq) {
            self.pending_reg[idx] & mask != 0
        } else {
            false
        }
    }

    fn fixed_exception_priority(irq: i32) -> Option<u8> {
        match irq {
            -14 => Some(0),    // NMI
            -13 => Some(1),    // HardFault
            _ => None,
        }
    }

    pub fn exception_priority(&self, irq: i32) -> u8 {
        if let Some(p) = Self::fixed_exception_priority(irq) {
            return p;
        }
        // System exceptions with programmable priority: read SHPR (via
        // set_sys_handler_prio from SCB writes), default 0x80.
        if irq < 0 {
            let exc = (irq + 16) as usize;
            if (4..16).contains(&exc) {
                return self.sys_handler_priority[exc];
            }
            return 0x80;
        }
        self.priority.get(irq as usize).copied().unwrap_or(0xFF)
    }

    /// SCB SHPR writes route here: set the priority of system exception `exc` (4..15).
    pub fn set_sys_handler_prio(&mut self, exc: usize, priority: u8) {
        if (4..16).contains(&exc) {
            self.sys_handler_priority[exc] = priority;
        }
    }

    pub fn current_priority(&self, basepri: u32) -> u8 {
        if let Some(&prio) = self.active_prio_stack.last() {
            prio
        } else if basepri & 0xFF != 0 {
            (basepri & 0xFF) as u8
        } else {
            0xFF
        }
    }

    fn can_fire(&self, irq: i32, primask: u32, basepri: u32) -> bool {
        if primask & 1 != 0 {
            return irq == irq::NMI || irq == irq::HARD_FAULT;
        }
        if irq >= 0 {
            let idx = (irq as usize) / 32;
            let mask = 1u32 << (irq as usize % 32);
            if idx >= REG_WORDS || self.enable[idx] & mask == 0 {
                return false;
            }
        }
        let prio = self.exception_priority(irq);
        let current = self.current_priority(basepri);
        prio < current
    }

    fn find_highest_pending(&self, primask: u32, basepri: u32) -> Option<i32> {
        self.find_highest_pending_excluding(primask, basepri, None)
    }

    fn find_highest_pending_excluding(&self, primask: u32, basepri: u32, exclude: Option<i32>) -> Option<i32> {
        let mut best: Option<i32> = None;
        let mut best_prio: u8 = 0xFF;
        let mut bits = self.pending;
        // Iterate only the SET pending bits (O(active) instead of scanning all
        // 111 possible IRQs). Among those, pick the lowest priority number
        // (highest priority), matching the old linear scan's tie-break
        // (lowest IRQ first). Identical result, cheaper when few are pending.
        while bits != 0 {
            let bit = bits.trailing_zeros() as i32;
            bits &= bits - 1;
            let irq = bit - IRQ_OFFSET as i32;
            if irq < -14 || irq >= IRQ_COUNT as i32 { continue; }
            if Some(irq) == exclude { continue; }
            if !self.can_fire(irq, primask, basepri) { continue; }
            let prio = self.exception_priority(irq);
            if best.is_none() || prio < best_prio {
                best = Some(irq);
                best_prio = prio;
            }
        }
        best
    }

    pub fn has_pending(&self) -> bool { self.pending != 0 }

    pub fn has_pending_masked(&self, primask: u32, basepri: u32) -> bool {
        self.find_highest_pending(primask, basepri).is_some()
    }

    pub fn get_pending_vector(&self) -> u32 {
        if self.pending != 0 {
            let bit = self.pending.trailing_zeros();
            bit - IRQ_OFFSET as u32
        } else {
            0
        }
    }

    pub fn get_next_pending_intr(&mut self) -> Option<i32> {
        let primask = INTR_MASK_PRIMASK.load(Ordering::Relaxed);
        let basepri = INTR_MASK_BASEPRI.load(Ordering::Relaxed);
        let mut irq = self.find_highest_pending(primask, basepri)?;
        // Fairness: if the IRQ that just ran re-pended itself (e.g. UART TXE
        // draining a software TX ring), yield to another pending IRQ so one
        // hot interrupt cannot consume every slot of the batch and starve
        // lower-priority IRQs (EXTI13 never fired during a long print).
        if self.last_popped == Some(irq) {
            if let Some(other) = self.find_highest_pending_excluding(primask, basepri, Some(irq)) {
                irq = other;
            }
        }
        self.last_popped = Some(irq);
        let bit = (IRQ_OFFSET + irq) as u128;
        self.pending &= !(1u128 << bit);
        if irq >= 0 {
            let idx = (irq as usize) / 32;
            let mask = 1u32 << (irq as usize % 32);
            self.pending_reg[idx] &= !mask;
            self.active[idx] |= mask;
        }
        let prio = self.exception_priority(irq);
        self.active_prio_stack.push(prio);
        Some(irq)
    }

    pub fn clear_current_interrupt(&mut self) {
        self.active_prio_stack.pop();
    }

    /// Take (and clear) the fairness-slot hint for `clear_current_interrupt`:
    /// the most recently dispatched IRQ. The raw test/driver path has no CPU
    /// exception-return to name the finished IRQ, so the return clears the
    /// last dispatched entry's IABR bit (matching what the native
    /// `exception_return` does with its exact IRQ).
    pub fn last_popped_clear_take(&mut self) -> Option<i32> {
        self.last_popped.take()
    }

    /// Clear the IABR active bit for a returned exception (external IRQs
    /// only; system exceptions have no IABR bit). `get_next_pending_intr`
    /// sets the bit on dispatch but the old pop-only return left it set
    /// forever — firmware reading IABR saw phantom-active IRQs.
    pub fn clear_active_bit(&mut self, irq: i32) {
        if irq >= 0 {
            if let Some((idx, mask)) = Self::irq_reg_idx(irq) {
                self.active[idx] &= !mask;
            }
        }
    }

    pub fn maybe_set_systick_intr_pending(&mut self) {
        if let Some(systick_period) = self.systick_period {
            let n = INSTRUCTION_COUNT.load(Ordering::Relaxed);
            let elapsed = n.saturating_sub(self.last_systick_trigger);
            if elapsed >= systick_period as u64 {
                // Deliver any number of elapsed 1ms ticks, not just one per
                // batch — otherwise delay(ms)/millis() run at 1 IRQ per batch.
                let ticks = (elapsed / systick_period.max(1) as u64).min(16) as u32;
                // Keep phase: advance the trigger by whole periods instead of
                // snapping to now, or the overshoot (up to a batch) is lost
                // every tick (28% slow millis at 50K batches, 10% at 20K).
                self.last_systick_trigger += ticks as u64 * systick_period.max(1) as u64;
                // The pending SysTick IRQ (set below) delivers the FIRST tick;
                // debt holds only the REMAINING ticks, which systick_take()
                // re-pends one per delivery. Adding `ticks` wholesale double-
                // delivered every tick once the JS drain was wired to irq=-1.
                let already_pending = self.pending & (1u128 << (IRQ_OFFSET + irq::SYSTICK)) != 0;
                let extra = if already_pending { ticks } else { ticks.saturating_sub(1) };
                self.systick_debt = self.systick_debt.saturating_add(extra).min(16);
                self.set_intr_pending(irq::SYSTICK);
            }
        }
    }

    /// Called by JS after each SysTick handler delivery: re-pends while
    /// unconsumed 1ms ticks remain, so uwTick/millis() track instruction time.
    pub fn systick_take(&mut self) -> bool {
        if self.systick_debt > 0 {
            self.systick_debt -= 1;
            self.set_intr_pending(irq::SYSTICK);
            true
        } else {
            false
        }
    }

    pub fn is_in_interrupt(&self) -> bool { !self.active_prio_stack.is_empty() }
}

impl Peripheral for Nvic {
    fn read(&mut self, _sys: &System, offset: u32) -> u32 {
        match offset {
            0x00..=0x1C if offset < 4 * REG_WORDS as u32 => {
                let i = (offset / 4) as usize;
                self.enable[i]
            }
            0x80..=0x9C if offset < 0x80 + 4 * REG_WORDS as u32 => {
                let i = ((offset - 0x80) / 4) as usize;
                self.enable[i]
            }
            0x100..=0x11C if offset < 0x100 + 4 * REG_WORDS as u32 => {
                let i = ((offset - 0x100) / 4) as usize;
                self.pending_reg[i]
            }
            0x200..=0x21C if offset < 0x200 + 4 * REG_WORDS as u32 => {
                let i = ((offset - 0x200) / 4) as usize;
                self.active[i]
            }
            0x280..=0x29C if offset < 0x280 + 4 * REG_WORDS as u32 => {
                let i = ((offset - 0x280) / 4) as usize;
                self.active[i]
            }
            // Byte-level priority access (via priority path addr 0xE000E300+, offset 0x200-0x2FF)
            0x200..=0x2FF => {
                let byte_idx = (offset - 0x200) as usize;
                if byte_idx < IRQ_COUNT { self.priority[byte_idx] as u32 } else { 0 }
            }
            // Word-level IPR access (ARM correct offset 0x300 from NVIC base)
            0x300..=0x3EF => {
                let reg_idx = ((offset - 0x300) / 4) as usize;
                let mut v = 0u32;
                for b in 0..4 {
                    let idx = reg_idx * 4 + b;
                    if idx < IRQ_COUNT {
                        v |= (self.priority[idx] as u32) << (b * 8);
                    }
                }
                v
            }
            _ => 0,
        }
    }

    fn write(&mut self, _sys: &System, offset: u32, value: u32) {
        match offset {
            0x00..=0x1C if offset < 4 * REG_WORDS as u32 => {
                let i = (offset / 4) as usize;
                let was = self.enable[i];
                self.enable[i] |= value;
                let newly_enabled = self.enable[i] & !was;
                let newly_pending = self.pending_reg[i] & newly_enabled;
                if newly_pending != 0 {
                    crate::system::nvic_mark_pending();
                }
                for b in 0..32 {
                    if newly_pending & (1 << b) != 0 {
                        self.pending |= 1u128 << (IRQ_OFFSET as u32 + i as u32 * 32 + b) as u128;
                    }
                }
            }
            0x80..=0x9C if offset < 0x80 + 4 * REG_WORDS as u32 => {
                let i = ((offset - 0x80) / 4) as usize;
                self.enable[i] &= !value;
            }
             0x100..=0x11C if offset < 0x100 + 4 * REG_WORDS as u32 => {
                let i = ((offset - 0x100) / 4) as usize;
                let new_pending = value & !self.pending_reg[i];
                self.pending_reg[i] |= value;
                if new_pending != 0 {
                    crate::system::nvic_mark_pending();
                }
                for b in 0..32 {
                    if new_pending & (1 << b) != 0 {
                        self.pending |= 1u128 << (IRQ_OFFSET as u32 + i as u32 * 32 + b) as u128;
                    }
                }
            }
            0x180..=0x19C if offset < 0x180 + 4 * REG_WORDS as u32 => {
                let i = ((offset - 0x180) / 4) as usize;
                let cleared = self.pending_reg[i] & value;
                self.pending_reg[i] &= !value;
                for b in 0..32 {
                    if cleared & (1 << b) != 0 {
                        self.pending &= !(1u128 << (IRQ_OFFSET as u32 + i as u32 * 32 + b) as u128);
                    }
                }
            }
            // 0x280 reads ACTIVE (IABR alias, above); 0x280 WRITES are
            // RESERVED on ARMv7-M (ICPR lives at 0x180) — ignore, do not
            // clear pending (an earlier build aliased them and silently
            // dropped guest ICPR writes to the wrong bank).
            // IABR is read-only by software
            0x200..=0x21C if offset < 0x200 + 4 * REG_WORDS as u32 => {}
            // Byte-level priority access (backward compat, via priority path addr 0xE000E300+)
            0x200..=0x2FF => {
                let byte_idx = (offset - 0x200) as usize;
                if byte_idx < IRQ_COUNT {
                    self.priority[byte_idx] = (value & 0xFF) as u8;
                }
            }
            // Word-level IPR access (ARM correct offset 0x300 from NVIC base)
            0x300..=0x3EF => {
                let reg_idx = ((offset - 0x300) / 4) as usize;
                for b in 0..4 {
                    let idx = reg_idx * 4 + b;
                    if idx < IRQ_COUNT {
                        self.priority[idx] = ((value >> (b * 8)) & 0xFF) as u8;
                    }
                }
            }
            _ => {}
        }
    }
}

pub struct NvicWrapper;

impl NvicWrapper {
    pub fn new(_name: &str) -> Option<Box<dyn Peripheral>> {
        None // NVIC is handled by shortcut in Peripherals::read/write, not as a peripheral slot
    }
}
