// SPDX-License-Identifier: MIT
//
// ARMv7-M Thumb-2 interpreter core + guest memory.
// Provenance: first prototyped in danish9661/stm32F4-emulator
// (stm32-periph-wasm/src/cpu/) and ported M4→M3 here by the same author.
// All original work, MIT like the rest of the repo (see docs/PATH_B.md).
pub mod regs;
pub mod mem;
pub(crate) mod thumb;
// NOTE: the vendored F407 `tests` module is deleted (it needed F407 SVD,
// firmware images and harness shims that don't exist in this tree). Its
// portable core — the SVC roundtrip + ISA snippet probes — lives in
// `isa_tests.rs` on a firmware-free harness instead.
#[cfg(test)]
mod smoke;
#[cfg(test)]
mod core_tests;
#[cfg(test)]
mod isa_tests;
#[cfg(test)]
mod census;
#[cfg(test)]
mod diffuzz;

pub use regs::Regs;
pub use mem::{FlatMemory, Memory};
use crate::system::WasmSystem;

/// EXC_RETURN values we support (thread mode). F1 (return to handler) is
/// nested-interrupt territory and faults loudly for now.
pub const EXC_RETURN_MSP: u32 = 0xFFFFFFF9;
pub const EXC_RETURN_PSP: u32 = 0xFFFFFFFD;
pub const EXC_RETURN_HANDLER: u32 = 0xFFFFFFF1;

/// The CPU stopped because of this (unknown instruction, BKPT, branch to
/// ARM state, ...). `pc` is the faulting instruction address (without thumb
/// bit); `op1`/`op2` are the raw halfwords; `len` is 2 or 4.
#[derive(Clone, Copy, Debug, Default)]
pub struct CpuFault {
    pub pc: u32,
    pub op1: u16,
    pub op2: u16,
    pub len: u8,
}

/// Saved IT-block state across an exception (pushed on entry, popped on
/// return — the handler runs with a clean ITSTATE, per ARM).
#[derive(Clone, Copy, Debug, Default)]
struct SavedIt {
    cond: u8,
    mask: u8,
    n: u8,
    idx: u8,
}

pub struct Cpu {
    pub regs: Regs,
    pub fault: Option<CpuFault>,
    // IT-block state. `n == 0` means no active block. `idx` counts consumed
    // instructions (1-based). See the IT rule in thumb.rs (`it_ok`): j>=2
    // uses `cond` iff mask bit (5-j) equals cond bit 0, else the inverse.
    pub it_cond: u8,
    pub it_mask: u8,
    pub it_n: u8,
    pub it_idx: u8,
    /// Exception number currently executing (0 = thread mode). Mirrors IPSR.
    pub ipsr: u32,
    /// IRQ numbers of entered exceptions (for NVIC active-bit hygiene).
    exc_stack: Vec<i32>,
    /// LDREX reservation address (word-aligned), None when clear. Single
    /// global monitor is exact on a single core; cleared on CLREX and on
    /// exception entry/return (firmware retry loops then behave like HW).
    pub exclusive: Option<u32>,
    /// Saved IT states, parallel to exc_stack.
    it_stack: Vec<SavedIt>,
    /// Break `run()` when the model has a pending interrupt, so a driver
    /// with guest exception delivery can take it. Off by default: polling
    /// firmware (and the lazy batch-boundary driver) must run full budgets
    /// exactly, never stopping early on model IRQs.
    pub deliver_irqs: bool,
    /// Halted in WFI/WFE (low-power). JS advances virtual time and wakes
    /// via `wake()` when an interrupt is pending. Only set when
    /// `deliver_irqs` is on; otherwise WFI is a nop.
    pub sleeping: bool,
    /// DSP extension present (Cortex-M4). Cortex-M3 drivers set false, which
    /// faults SMLAXY/SMULXY/SMLAD/SMUAD/SMULW/SMLAW as UNDEFINED. Defaults
    /// true so the M4-verified behavior is unchanged.
    pub dsp: bool,
    /// Predicated 16-bit data-processing must not update APSR (ARM rule:
    /// 16-bit instructions in an IT block, other than CMP/CMN/TST, do not
    /// set flags). Set fresh by exec16/exec32 on every instruction; helpers
    /// (nz/add_flags/sub_flags) and T1 carry lines consult it, CMP/CMN/TST
    /// arms and all T2 arms ignore it.
    pub it_suppress: bool,
}

/// Effective privilege for MPU checks: handlers always run privileged;
// thread mode follows CONTROL.nPRIV (bit 0 set = unprivileged).
pub(crate) fn current_privileged(cpu: &Cpu) -> bool {
    cpu.ipsr != 0 || (cpu.regs.control & 1) == 0
}

/// Publish the CPU's privilege to the model (FlatMemory has no CPU context
/// of its own). Called on MSR CONTROL, exception entry and return — the only
/// events that can change it.
pub(crate) fn sync_privilege(cpu: &Cpu, sys: &WasmSystem) {
    sys.set_privileged(current_privileged(cpu));
}

impl Cpu {
    pub fn new(sp: u32, pc: u32) -> Self {
        Self {
            regs: Regs::new(sp, pc),
            fault: None,
            it_cond: 0,
            it_mask: 0,
            it_n: 0,
            it_idx: 0,
            ipsr: 0,
            exc_stack: Vec::new(),
            it_stack: Vec::new(),
            deliver_irqs: false,
            sleeping: false,
            dsp: true,
            it_suppress: false,
            exclusive: None,
        }
    }
    pub fn reset(&mut self, sp: u32, pc: u32) {
        self.regs = Regs::new(sp, pc);
        self.fault = None;
        self.it_cond = 0;
        self.it_mask = 0;
        self.it_n = 0;
        self.it_idx = 0;
        self.ipsr = 0;
        self.exc_stack.clear();
        self.it_stack.clear();
        self.sleeping = false;
        crate::system::CPU_SLEEPING.store(false, std::sync::atomic::Ordering::Relaxed);
        // NOTE: `dsp` is configuration, not CPU state — preserved across reset.
        // it_suppress is per-instruction transient (recomputed at each entry).
        self.it_suppress = false;
        self.exclusive = None;
    }

    /// Current stack pointer (r13 always mirrors it).
    #[inline]
    pub fn sp(&self) -> u32 {
        self.regs.r[13]
    }

    /// Read the MSP (banked). In handler mode MSP == r13; in thread+MSP
    /// mode r13 == msp too. Only thread+PSP mode differs.
    pub fn read_msp(&self) -> u32 {
        if self.ipsr == 0 && self.regs.control & 2 != 0 {
            self.regs.msp
        } else {
            self.regs.r[13]
        }
    }
    /// Read the PSP (banked).
    pub fn read_psp(&self) -> u32 {
        if self.ipsr == 0 && self.regs.control & 2 != 0 {
            self.regs.r[13]
        } else {
            self.regs.psp
        }
    }
    /// Write the MSP (banked): updates r13 too when MSP is current.
    pub fn write_msp(&mut self, v: u32) {        self.regs.msp = v;
        if self.ipsr != 0 || self.regs.control & 2 == 0 {
            self.regs.r[13] = v;
        }
    }
    /// Write the PSP (banked): updates r13 too when PSP is current.
    /// This is the FreeRTOS task-switch primitive (`msr psp, rX` in the
    /// PendSV handler while in handler mode only updates the bank).
    pub fn write_psp(&mut self, v: u32) {
        self.regs.psp = v;
        if self.ipsr == 0 && self.regs.control & 2 != 0 {
            self.regs.r[13] = v;
        }
    }

    /// Take an exception: stack the context, load the handler from the
    /// vector table (via VTOR), set EXC_RETURN. Works for system exceptions
    /// (negative irq) and external IRQs, thread mode and nested (a higher-
    /// priority exception preempting a running handler stacks on MSP and
    /// returns with EXC_RETURN_HANDLER), including FreeRTOS SVC/PendSV/
    /// SysTick handlers.
    pub fn take_exception(&mut self, sys: &WasmSystem, mem: &mut FlatMemory, irq: i32) {
        let vector = (16 + irq) as u32;
        // Exception entry wakes the core (WFI sleeps until an interrupt is
        // delivered; without this a sleeping core never resumes, since the
        // driver pumps take_exception for every dispatch).
        // Save IT state; the handler starts with a clean ITSTATE.
        self.it_stack.push(SavedIt {
            cond: self.it_cond,
            mask: self.it_mask,
            n: self.it_n,
            idx: self.it_idx,
        });
        // STOP exit (was in deep sleep): the system clock falls back to
        // HSI until firmware re-selects (SWS=00, SW kept).
        if self.sleeping && sys.p.in_deep_sleep() {
            sys.p.rcc_wake_from_stop(sys);
        }
        self.it_n = 0;
        self.it_idx = 0;
        self.sleeping = false;
        crate::system::CPU_SLEEPING.store(false, std::sync::atomic::Ordering::Relaxed);
        self.exc_stack.push(irq);
        // Bank the thread stack, then run the handler on MSP. The frame
        // goes onto the CURRENT stack (PSP if thread+PSP, else MSP) — this
        // is what makes FreeRTOS task stacks work.
        let was_psp = self.ipsr == 0 && self.regs.control & 2 != 0;
        if was_psp {
            self.regs.psp = self.regs.r[13];
        } else if self.ipsr == 0 {
            self.regs.msp = self.regs.r[13];
        }
        let mut sp = self.regs.r[13];
        // Push xPSR (T-bit set), PC, LR, R12, R3-R0.
        let xpsr = self.regs.xpsr | 0x01000000;
        sp = sp.wrapping_sub(4);
        mem.write32(sp, xpsr);
        sp = sp.wrapping_sub(4);
        mem.write32(sp, self.regs.r[15]);
        sp = sp.wrapping_sub(4);
        mem.write32(sp, self.regs.r[14]);
        sp = sp.wrapping_sub(4);
        mem.write32(sp, self.regs.r[12]);
        sp = sp.wrapping_sub(4);
        mem.write32(sp, self.regs.r[3]);
        sp = sp.wrapping_sub(4);
        mem.write32(sp, self.regs.r[2]);
        sp = sp.wrapping_sub(4);
        mem.write32(sp, self.regs.r[1]);
        sp = sp.wrapping_sub(4);
        mem.write32(sp, self.regs.r[0]);
        // Handler mode always runs on MSP.
        self.regs.r[13] = self.regs.msp;
        // LR selects the return stack: handler returns use EXC_RETURN_HANDLER
        // (0xFFFFFFF1); thread returns select the bank we came from.
        // (The stale `^ BUG` comment above was the pre-nesting confusion.)
        self.regs.r[14] = if self.ipsr != 0 {
            EXC_RETURN_HANDLER
        } else if was_psp {
            EXC_RETURN_PSP
        } else {
            EXC_RETURN_MSP
        };
        self.regs.r[13] = sp;
        self.regs.msp = sp;
        // Hardware also advances the THREAD bank past the pushed frame, so a
        // later `mrs psp` (PendSV save) points BELOW the entry frame and the
        // stmdb doesn't overwrite it. Without this the entry frame is
        // clobbered and the switch-back unstacks garbage (FreeRTOS slide).
        if was_psp {
            self.regs.psp = sp;
        }
        self.ipsr = vector;
        // VC_HARDERR (DEMCR bit 10): a debug probe halts the core on
        // HardFault entry instead of running the handler. Take first (the
        // dispatch already happened), then halt so the run loop stops.
        if irq == crate::peripherals::nvic::irq::HARD_FAULT && sys.swd.vc_harderr() {
            sys.swd.halt_from_model();
        }
        // LDREX reservation dies on exception entry (firmware retry loops
        // then behave like silicon instead of succeeding spuriously).
        self.exclusive = None;
        // Entering handler mode is always privileged (MPU).
        // NVIC active-priority accounting: whoever pops a pending IRQ pushes
        // here. `get_next_pending_intr()` pops + pushes for dispatched IRQs;
        // synchronous takes (SVC) push explicitly at their call sites via
        // `push_active()` — every take is balanced by exactly one pop in
        // `exception_return`, including nested entries.
        // Load handler PC through VTOR (model SCB, default 0x08000000).
        let vtor = sys.p.read(sys, 0xE000ED08, 4);
        let handler = mem.read32(vtor.wrapping_add(vector * 4));
        self.regs.r[15] = handler | 1;
    }

    /// Perform an exception return for an EXC_RETURN value in `exc`.
    /// 0xFFFFFFF9/0xFFFFFFFD return to thread (MSP/PSP bank); 0xFFFFFFF1
    /// returns to the preempted handler (nested case). Returns false (with
    /// fault recorded) for anything else.
    pub fn exception_return(
        &mut self,
        sys: &WasmSystem,
        mem: &mut FlatMemory,
        exc: u32,
        pc: u32,
    ) -> bool {
        let to_handler = exc == EXC_RETURN_HANDLER;
        if !to_handler && exc != EXC_RETURN_MSP && exc != EXC_RETURN_PSP {
            self.fault = Some(CpuFault { pc, op1: 0x4770, op2: 0, len: 2 });
            return false;
        }
        // Unstack from the bank selected by EXC_RETURN. Nested (F1) and
        // thread-MSP (F9) returns MUST use live r13: in handler mode r13 IS
        // the stack and the bank still points at an already-consumed inner
        // frame (unstacking the bank dereferenced handler-pushed registers
        // as a frame and derailed the PC into unmapped space). Only PSP
        // (FD) returns use the bank, which task switches retarget mid-
        // handler. Afterwards the banks are re-synced to the unstacked SP.
        let mut sp = if exc == EXC_RETURN_PSP {
            self.regs.psp
        } else {
            self.regs.r[13]
        };
        // In handler mode r13 == MSP; if returning to MSP it must match.
        // (If a buggy handler moved MSP, trust the bank per ARM.)
        let r0 = mem.read32(sp);
        let r1 = mem.read32(sp.wrapping_add(4));
        let r2 = mem.read32(sp.wrapping_add(8));
        let r3 = mem.read32(sp.wrapping_add(12));
        let r12 = mem.read32(sp.wrapping_add(16));
        let lr = mem.read32(sp.wrapping_add(20));
        let retpc = mem.read32(sp.wrapping_add(24));
        let xpsr = mem.read32(sp.wrapping_add(28));
        sp = sp.wrapping_add(32);
        self.regs.r[0] = r0;
        self.regs.r[1] = r1;
        self.regs.r[2] = r2;
        self.regs.r[3] = r3;
        self.regs.r[12] = r12;
        self.regs.r[14] = lr;
        // Restore flags (APSR) + IT/ICI bits live in xPSR; T-bit stays set.
        self.regs.xpsr = (xpsr & 0xF8000000) | 0x01000000;
        self.regs.r[13] = sp;
        if exc == EXC_RETURN_PSP {
            self.regs.psp = sp;
        } else {
            self.regs.msp = sp;
        }
        // Exception return selects the thread stack AND updates CONTROL.SPSEL
        // to match (hardware keeps them coherent; without this every
        // CONTROL-gated bank decision after the first return is wrong and
        // PendSV saves to a stale PSP — the FreeRTOS wedge). Bit0
        // (privilege) is preserved. Handler-to-handler returns leave CONTROL
        // alone (SPSEL is meaningless in handler mode).
        if !to_handler {
            if exc == EXC_RETURN_PSP {
                self.regs.control |= 2;
            } else {
                self.regs.control &= !2;
            }
        }
        // Restore the pre-exception IT state.
        if let Some(saved) = self.it_stack.pop() {
            self.it_cond = saved.cond;
            self.it_mask = saved.mask;
            self.it_n = saved.n;
            self.it_idx = saved.idx;
        }
        let irq = self.exc_stack.pop();
        // Resume the preempted context: outer handler's vector when nested,
        // thread mode (0) otherwise. (Always-zero here was the nested-return
        // bug: the core "returned" into thread mode mid-nest.)
        self.ipsr = match self.exc_stack.last() {
            Some(&outer) => (16 + outer) as u32,
            None => 0,
        };
        sync_privilege(self, sys);
        self.exclusive = None;
        // Clear this entry's IABR active bit (set on dispatch); the old
        // pop-only return leaked it, leaving phantom-active IRQs.
        if let Some(q) = irq {
            sys.p.nvic.borrow_mut().clear_active_bit(q);
        }
        // Balance the active-priority push for this entry: get_next's push
        // for dispatched IRQs, the caller's push_active for synchronous
        // takes (SVC). A standalone SVC on an empty stack is a safe no-op.
        sys.p.nvic.borrow_mut().clear_current_interrupt();
        // SysTick debt: re-pend exactly ONE unconsumed 1ms tick per return
        // so the dispatch loop delivers it next iteration. Draining the
        // whole debt here coalesces into the single pending bit and loses
        // ticks (millis() ran ~14x slow at 1M batches).
        if irq == Some(crate::peripherals::nvic::irq::SYSTICK) {
            sys.p.nvic.borrow_mut().systick_take();
        }
        // Chained PendSV/SVC tail? No tail-chaining in v1; the run loop
        // delivers the next pending exception on the next iteration.
        self.regs.r[15] = retpc | 1;
        // NOTE: no even-retpc fault here. FreeRTOS's M4 port deliberately
        // stores the task entry with bit0 CLEAR (`bic r1, #1` in
        // pxPortInitialiseStack) and relies on exception return forcing
        // Thumb state, so force |1 like hardware does for the PC load.
        true
    }

    /// Cold MPU execute-never arm: records MMFSR + pends MemManage
    /// (escalating without MEMFAULTENA) and raises the diagnosable halt.
    /// Returns true when the run loop must break. Outlined so the hot
    /// fetch skeleton stays small for the JIT (see MPU_ON docs).
    #[cold]
    #[inline(never)]
    fn mpu_exec_denied(&mut self, sys: &WasmSystem, mem: &mut FlatMemory, pc: u32) -> bool {
        if sys.mpu_check_exec_slow(pc) {
            return false;
        }
        if self.fault.is_none() {
            self.fault = Some(CpuFault { pc, op1: mem.read16_raw(pc), op2: 0, len: 2 });
        }
        true
    }

    pub fn run(&mut self, sys: &WasmSystem, mem: &mut FlatMemory, budget: u32) -> u32 {
        let mut done = 0;
        while done < budget {
            if self.fault.is_some() {
                break;
            }
            if self.sleeping {
                break;
            }
            // Debug halt (DHCSR C_HALT / watchpoint trip / VC_HARDERR):
            // one mirror load + branch, same discipline as the WFI check
            // above. Set only on debug-state writes (cold).
            if crate::system::debug_halted() {
                break;
            }
            let pc = self.regs.r[15] & !1;

            // MPU execute-never (no-op unless enabled): fault loudly instead
            // of silently running forbidden code. Outlined cold so the hot
            // fetch skeleton stays JIT-friendly (see MPU_ON docs).
            if sys.mpu.enabled() {
                core::hint::cold_path();
                if self.mpu_exec_denied(sys, mem, pc) {
                    break;
                }
            }
            // Fused wide fetch: one region resolve serves both halfwords
            // when pc..pc+3 is contained (the common case); otherwise fall
            // back to two halfword fetches (region edges, peripheral
            // windows — exact bad-record/model behavior there).
            let (op, o2, l) = match mem.fetch32_raw(pc) {
                Some(w) => {
                    let op = w as u16;
                    (op, (w >> 16) as u16, thumb::len(op))
                }
                None => {
                    let op = mem.read16_raw(pc);
                    let l = thumb::len(op);
                    (op, if l == 4 { mem.read16_raw(pc + 2) } else { 0 }, l)
                }
            };
            // o2 doubles as the fusion lookahead: the high halfword of a
            // fused fetch, or 0 on the edge fallback (no template matches
            // 0 — fusion safely disabled there). exec returns the guest
            // instruction count (0 = stop/fault, 1, or 2 for a fused pair).
            let n = if l == 2 {
                thumb::exec16(self, sys, mem, op, pc, o2)
            } else {
                thumb::exec32(self, sys, mem, op, o2, pc)
            };
            if n == 0 {
                if self.fault.is_none() {
                    self.fault = Some(CpuFault { pc, op1: op, op2: 0, len: 2 });
                }
                break;
            }
            // No per-instruction stack-bank sync: the banks don't need it.
            // take_exception copies live r13 into the outgoing bank at
            // entry (and advances PSP past the frame); exception_return
            // re-syncs both banks to the unstacked SP; MRS/MSR go through
            // read/write_msp/psp, which resolve live r13 whenever it is
            // the current stack; MSR-CONTROL SPSEL swaps swap explicitly.
            // No production reader consumes a mid-thread bank value, and
            // no test asserts bank freshness after raw thread-mode stack
            // traffic (all bank asserts follow entry/return, which
            // maintain them) — so the old every-op sync (kept since the
            // FreeRTOS wedge, before the above discipline existed) was
            // pure overhead: two branches + a store per guest op.
            done += n;
            // Inline interrupt delivery (no JS pump needed): take the next
            // deliverable exception with PRIMASK clear — in thread mode AND
            // in handler mode, where a strictly-higher-priority IRQ preempts
            // (nested). Priority vs the active stack is enforced inside
            // get_next_pending_intr, so same-priority re-pends never nest and
            // depth is bounded by priority levels. Stacking is exact, so the
            // store completes, PC advances, then we stack the next PC.
            // Budget: route through intr_next() (shared 64-IRQ batch cap),
            // not the raw pop — a level-storming IRQ (e.g. CAN TX with its
            // flag uncleared) would otherwise take unboundedly every slice
            // and starve the firmware, a shape the lazy path already caps.
            // Idle fast path: skip the RefCell borrow + queue scan unless
            // the hint mirror says an IRQ may be pending (set on every
            // pend path, cleared lazily below on a proven-empty queue).
            if self.deliver_irqs && self.regs.primask == 0 && crate::system::nvic_pending_hint() {
                let pending = sys.p.nvic.borrow().has_pending();
                if pending {
                    // Bind first: `if let` would extend the borrow_mut guard
                    // through the body and take_exception would re-borrow.
                    // intr_next() pops the highest-priority pending IRQ
                    // (PRIMASK/BASEPRI via the INTR_MASK statics the driver
                    // maintains) within the batch budget, and pushes the
                    // active stack entry that exception_return balances.
                    let next = crate::interrupts::intr_next();
                    if next > -100 {
                        self.take_exception(sys, mem, next);
                    }
                } else {
                    // Proven-empty queue: drop the hint so idle polling
                    // stays a single mirror load until the next pend.
                    crate::system::nvic_drop_hint();
                }
            }
        }
        done
    }
}
