//! WASM-native Thumb-2 (Cortex-M4) interpreter core.
//!
//! Decodes and executes integer Thumb/Thumb-2 instructions against a
//! [`Memory`](super::mem::Memory) and the shared peripheral model. Every
//! encoding here was verified against `arm-none-eabi-as`/`objdump` output
//! for the repo's own firmware (see the `t32.s`/`it3.s` probes): the op
//! nibble `X=(op1>>5)&0xF` maps `{0:AND,1:BIC,2:ORR,3:MVN,4:EOR,8:ADD,
//! 10:ADC,11:SBC,13:SUB,14:RSB}` uniformly across the F (modified-immediate)
//! and EA/EB (shifted-register) groups; `S=(op1>>4)&1`; `Rn=op1&0xF`.
//! `ThumbExpandImm` follows the ARM ARM (rotation uses `'1':imm12[6:0]`
//! rotated by `imm12[11:7]`). IT predication: instruction j>=2 uses `cond`
//! iff mask bit (5-j) equals cond bit 0 (verified against GAS for 13
//! IT forms — identical patterns assemble to different masks per cond).
//!
//! Anything not yet implemented (SVC, coprocessor, FPU, exception entry,
//! RSC/SRS, ...) records a [`CpuFault`](super::CpuFault) and stops, so gaps
//! are loud and precisely located instead of silently wrong.

use super::{mem::{FlatMemory, Memory}, Cpu};
use crate::system::WasmSystem;

pub(crate) fn len(op: u16) -> usize {
    let t = op >> 11;
    if t == 0b11101 || t == 0b11110 || t == 0b11111 {
        4
    } else {
        2
    }
}

#[inline]
fn sx(v: u32, b: u32) -> u32 {
    let s = 32 - b;
    ((v as i32) << s >> s) as u32
}
#[inline]
fn ror32(v: u32, s: u32) -> u32 {
    let s = s & 31;
    if s == 0 {
        v
    } else {
        (v >> s) | (v << (32 - s))
    }
}
/// Register read with Thumb PC semantics: reads of R15 see `(pc+4)&!3`.
#[inline]
fn rr(c: &Cpu, n: usize, pc: u32) -> u32 {
    if n == 15 {
        (pc + 4) & !3
    } else {
        c.regs.r[n]
    }
}
#[inline]
fn adv(c: &mut Cpu, pc: u32, l: u32) {
    c.regs.r[15] = pc.wrapping_add(l) | 1;
}

fn fault(c: &mut Cpu, pc: u32, op1: u16, op2: u16, l: u8) -> u32 {
    c.fault = Some(super::CpuFault { pc, op1, op2, len: l });
    0
}
/// Interworking branch. An EXC_RETURN value performs an exception return
/// through the stacked context instead. Branching to ARM state (bit0
/// clear, non-EXC_RETURN) is a fault on Cortex-M (no ARM state); halting
/// loudly beats silently running garbage.
fn branch(
    c: &mut Cpu,
    sys: &WasmSystem,
    mem: &mut FlatMemory,
    t: u32,
    pc: u32,
    op1: u16,
    op2: u16,
    l: u8,
) -> u32 {
    if (t & 0x0FFFFFF0) == 0x0FFFFFF0 {
        return c.exception_return(sys, mem, t, pc) as u32;
    }
    if t & 1 == 0 {
        return fault(c, pc, op1, op2, l);
    }
    c.regs.r[15] = t;
    1
}

// ---- flags ----
#[inline]
fn nz(c: &mut Cpu, v: u32) {
    if c.it_suppress {
        return;
    }
    c.regs.xpsr = (c.regs.xpsr & !0xC0000000)
        | if v == 0 { 0x40000000 } else { 0 }
        | if v & 0x80000000 != 0 { 0x80000000 } else { 0 };
}
/// Flag-setting logical op: N/Z from the result, C = shifter carry-out,
/// V unchanged (ARM ARM). Differential fuzz caught the missing C write
/// (orrs-imm kept a stale C=1 where the oracle cleared it).
#[inline]
fn nzc(c: &mut Cpu, v: u32, co: u32) {
    if c.it_suppress {
        return;
    }
    c.regs.xpsr = (c.regs.xpsr & !0xE0000000)
        | if v == 0 { 0x40000000 } else { 0 }
        | if v & 0x80000000 != 0 { 0x80000000 } else { 0 }
        | if co != 0 { 0x20000000 } else { 0 };
}
fn add_flags(c: &mut Cpu, a: u32, b: u32, ci: u32) -> u32 {
    let r = a.wrapping_add(b).wrapping_add(ci);
    let carry = (a as u64) + (b as u64) + (ci as u64) > 0xFFFF_FFFF;
    let over = ((a ^ r) & (b ^ r) & 0x80000000) != 0;
    if c.it_suppress {
        return r;
    }
    c.regs.xpsr = (c.regs.xpsr & !0xF0000000)
        | if r == 0 { 0x40000000 } else { 0 }
        | if r & 0x80000000 != 0 { 0x80000000 } else { 0 }
        | if carry { 0x20000000 } else { 0 }
        | if over { 0x10000000 } else { 0 };
    r
}
fn sub_flags(c: &mut Cpu, a: u32, b: u32, ci: u32) -> u32 {
    // ci here is "carry in" (1 = no borrow). NOT carry = borrow.
    let r = a.wrapping_sub(b).wrapping_sub(1 - ci);
    let borrow = (a as u64) < (b as u64) + (1 - ci) as u64;
    let over = ((a ^ b) & (a ^ r) & 0x80000000) != 0;
    if c.it_suppress {
        return r;
    }
    c.regs.xpsr = (c.regs.xpsr & !0xF0000000)
        | if r == 0 { 0x40000000 } else { 0 }
        | if r & 0x80000000 != 0 { 0x80000000 } else { 0 }
        | if !borrow { 0x20000000 } else { 0 }
        | if over { 0x10000000 } else { 0 };
    r
}
#[inline]
fn carry(c: &Cpu) -> u32 {
    (c.regs.xpsr >> 29) & 1
}
fn cond_ok(c: &Cpu, cc: u32) -> bool {
    let x = c.regs.xpsr;
    let n = x & 0x80000000 != 0;
    let z = x & 0x40000000 != 0;
    let cy = x & 0x20000000 != 0;
    let v = x & 0x10000000 != 0;
    match cc {
        0 => z,
        1 => !z,
        2 => cy,
        3 => !cy,
        4 => n,
        5 => !n,
        6 => v,
        7 => !v,
        8 => cy && !z,
        9 => !cy || z,
        10 => n == v,
        11 => n != v,
        12 => !z && n == v,
        13 => z || n != v,
        14 => true,
        _ => false,
    }
}
/// IT-block predication. Returns true when the current instruction executes.
/// Always consumes one IT slot. GAS-verified rule: slot j>=2 uses `cond`
/// iff mask bit (5-j) equals cond bit 0, else the inverse condition.
/// Slot 1 always uses `cond`. `n = 4 - trailing_zeros(mask)`.
fn it_ok(c: &mut Cpu) -> bool {
    if c.it_n == 0 {
        return true;
    }
    c.it_idx += 1;
    let cc = if c.it_idx == 1 {
        c.it_cond
    } else {
        let b = (c.it_mask >> (5 - c.it_idx)) & 1;
        if b == (c.it_cond & 1) {
            c.it_cond
        } else {
            c.it_cond ^ 1
        }
    };
    let take = cond_ok(c, cc as u32);
    if c.it_idx >= c.it_n {
        c.it_n = 0;
        c.it_idx = 0;
    }
    take
}
/// ARM ARM ThumbExpandImm_C. Returns (value, carry_out).
fn expand_imm(imm12: u32, carry_in: u32) -> (u32, u32) {
    let imm8 = imm12 & 0xFF;
    if imm12 & 0xC00 == 0 {
        let v = match (imm12 >> 8) & 3 {
            0 => imm8,
            1 => (imm8 << 16) | imm8, // 0x00:imm8:0x00:imm8
            2 => (imm8 << 24) | (imm8 << 8), // imm8:0x00:imm8:0x00
            _ => imm8 | (imm8 << 8) | (imm8 << 16) | (imm8 << 24),
        };
        (v, carry_in)
    } else {
        let unrot = 0x80 | (imm12 & 0x7F); // '1' : imm12[6:0]
        let rot = (imm12 >> 7) & 0x1F;
        let v = ror32(unrot, rot);
        let co = if rot == 0 {
            carry_in
        } else {
            (unrot >> ((rot - 1) & 31)) & 1
        };
        (v, co)
    }
}
/// Shifted-register operand. Returns (result, carry_out).
fn shift_op(v: u32, typ: u32, amt: u32, ci: u32) -> (u32, u32) {
    match typ {
        0 => {
            // LSL
            if amt == 0 {
                (v, ci)
            } else if amt < 32 {
                (v.wrapping_shl(amt), (v >> (32 - amt)) & 1)
            } else if amt == 32 {
                (0, v & 1)
            } else {
                (0, 0)
            }
        }
        1 => {
            // LSR
            if amt == 0 || amt == 32 {
                (0, (v >> 31) & 1)
            } else if amt < 32 {
                (v >> amt, (v >> (amt - 1)) & 1)
            } else {
                (0, 0)
            }
        }
        2 => {
            // ASR
            if amt == 0 || amt >= 32 {
                let s = if v & 0x80000000 != 0 { 0xFFFF_FFFF } else { 0 };
                (s, (v >> 31) & 1)
            } else {
                (((v as i32) >> amt) as u32, (v >> (amt - 1)) & 1)
            }
        }
        _ => {
            // ROR / RRX
            if amt == 0 {
                ((ci << 31) | (v >> 1), v & 1)
            } else {
                let s = amt & 31;
                if s == 0 {
                    (v, (v >> 31) & 1)
                } else {
                    (ror32(v, s), (v >> (s - 1)) & 1)
                }
            }
        }
    }
}


/// Superoperator kill-switch (differential testing): when set, template
/// checks never fire and every pair takes the legacy sequential path.
/// Checked LAST in each guard chain (only on shape match), so production
/// cost is ~zero. Tests run snippets both ways and compare full state.
static FUSION_OFF: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub(crate) fn fusion_off(on: bool) {
    FUSION_OFF.store(on, std::sync::atomic::Ordering::Relaxed);
}

#[inline(always)]
fn fusion_live() -> bool {
    !FUSION_OFF.load(std::sync::atomic::Ordering::Relaxed)
}

/// Bcc-shape probe for fused seconds: Bcc but never SVC/UDF (DF00/DE00 live
/// inside Bcc's range and are claimed by earlier arms — fusing them would
/// execute a trap as a branch).
#[inline(always)]
fn is_bcc_shape(o2: u32) -> bool {
    (o2 & 0xF000) == 0xD000 && (o2 & 0xFF00) != 0xDF00 && (o2 & 0xFF00) != 0xDE00
}

/// Fused (LDRlit, LDR-imm): two loads, no flags either way. Bodies copied
/// verbatim from the two arms (sequential order preserved, so overlapping
/// Rt/Rn resolve like silicon); single pc+4 advance. Callers guarantee:
/// it_n == 0, o1 matches LDRlit, o2 matches LDR-imm5.
fn fused_ldr_ldr(
    cpu: &mut Cpu, _sys: &WasmSystem, mem: &mut FlatMemory, o1: u32, o2: u32, pc: u32,
) -> u32 {
    let rt1 = ((o1 >> 8) & 7) as usize;
    let base1 = (pc + 4) & !3;
    cpu.regs.r[rt1] = mem.read32(base1.wrapping_add((o1 & 0xFF) * 4));
    let (rn2, rt2) = (((o2 >> 3) & 7) as usize, (o2 & 7) as usize);
    let addr2 = rr(cpu, rn2, pc.wrapping_add(2)).wrapping_add(((o2 >> 6) & 0x1F) * 4);
    cpu.regs.r[rt2] = mem.read32(addr2);
    adv(cpu, pc, 4);
    2
}

/// Fused (SUBreg, CMP-reg): flag-setting subtract, then a flag-only compare
/// (result discarded, like the CMP arm). Callers guarantee it_n == 0 and
/// both shapes (o2 = ALU arm with sop == 10).
fn fused_sub_cmp(
    cpu: &mut Cpu, _sys: &WasmSystem, _mem: &mut FlatMemory, o1: u32, o2: u32, pc: u32,
) -> u32 {
    let (rd, rs, rn) = ((o1 & 7) as usize, ((o1 >> 3) & 7) as usize, ((o1 >> 6) & 7) as usize);
    let r = sub_flags(cpu, rr(cpu, rs, pc), rr(cpu, rn, pc), 1);
    cpu.regs.r[rd] = r;
    let (rs2, rd2) = (((o2 >> 3) & 7) as usize, (o2 & 7) as usize);
    cpu.it_suppress = false; // mirror CMP arm (no-op under the it_n gate)
    sub_flags(cpu, rr(cpu, rd2, pc.wrapping_add(2)), rr(cpu, rs2, pc.wrapping_add(2)), 1);
    adv(cpu, pc, 4);
    2
}

/// Shared Bcc tail for fused compare/branch pairs: pc2/o2 always describe
/// the branch (pc+2 of the fused pair). Returns via branch() exactly like
/// the Bcc arm (taken target, EXC_RETURN reshape, misaligned fault).
fn fused_bcc_tail(
    cpu: &mut Cpu, sys: &WasmSystem, mem: &mut FlatMemory, o2: u32, pc: u32,
) -> u32 {
    let cc = (o2 >> 8) & 0xF;
    let imm = sx(((o2 & 0xFF) << 1) as u32, 9);
    let pc2 = pc.wrapping_add(2);
    if cond_ok(cpu, cc) {
        // Branch completes the second op: 1 (first) + branch's 1, or 1 + 0
        // when the branch itself stops (misaligned/EXC_RETURN fault).
        return branch(cpu, sys, mem, (pc2.wrapping_add(4).wrapping_add(imm)) | 1, pc2, o2 as u16, 0, 2) + 1;
    }
    adv(cpu, pc, 4);
    2
}

/// Fused (CMP-imm, Bcc). Callers guarantee it_n == 0 and both shapes.
fn fused_cmp_bcc(
    cpu: &mut Cpu, sys: &WasmSystem, mem: &mut FlatMemory, o1: u32, o2: u32, pc: u32,
) -> u32 {
    let rn = ((o1 >> 8) & 7) as usize;
    cpu.it_suppress = false; // mirror CMP arm (no-op under the it_n gate)
    sub_flags(cpu, rr(cpu, rn, pc), o1 & 0xFF, 1);
    fused_bcc_tail(cpu, sys, mem, o2, pc)
}

/// Fused (LSL-imm, Bcc). Callers guarantee it_n == 0 and both shapes.
fn fused_lsl_bcc(
    cpu: &mut Cpu, sys: &WasmSystem, mem: &mut FlatMemory, o1: u32, o2: u32, pc: u32,
) -> u32 {
    let (rd, rs) = ((o1 & 7) as usize, ((o1 >> 3) & 7) as usize);
    let im = (o1 >> 6) & 0x1F;
    let v = rr(cpu, rs, pc);
    let (r, co) = shift_op(v, 0, im, carry(cpu));
    cpu.regs.r[rd] = r;
    nz(cpu, r);
    if !cpu.it_suppress {
        cpu.regs.xpsr = (cpu.regs.xpsr & !0x20000000) | (co << 29);
    }
    fused_bcc_tail(cpu, sys, mem, o2, pc)
}

pub fn exec16(
    cpu: &mut Cpu,
    sys: &WasmSystem,
    mem: &mut FlatMemory,
    op: u16,
    pc: u32,
    o2n: u16,
) -> u32 {
    let o = op as u32;
    let q = o2n as u32; // fusion lookahead (next halfword; 0 on edge fallback, matches nothing)
    // 16-bit data-processing (except CMP/CMN/TST) must not update APSR inside
    // an IT block (verified against silicon behavior via the availableForWrite
    // spin). Capture predication BEFORE it_ok() runs: it clears it_n on the
    // last slot, which must still be suppressed. CMP/CMN/TST arms below opt
    // back out explicitly.
    cpu.it_suppress = cpu.it_n != 0;
    // IT predication: a not-taken instruction is still a 2-byte NOP for PC
    // purposes (and still consumes its IT slot).
    if !it_ok(cpu) {
        adv(cpu, pc, 2);
        return 1;
    }
    // high-register ops + BX/BLX (op select is bits[9:8])
    if o & 0xFC00 == 0x4400 {
        let h = (o >> 8) & 3;
        let rs = ((o >> 3) & 0xF) as usize;
        let rd = ((o & 7) | ((o >> 4) & 8)) as usize;
        match h {
            0 => {
                let r = rr(cpu, rd, pc).wrapping_add(rr(cpu, rs, pc));
                if rd == 15 {
                    return branch(cpu, sys, mem, r, pc, op, 0, 2);
                }
                cpu.regs.r[rd] = r;
            }
            1 => {
                cpu.it_suppress = false; // T1 CMP always updates flags.
                sub_flags(cpu, rr(cpu, rd, pc), rr(cpu, rs, pc), 1);
            }
            2 => {
                let v = rr(cpu, rs, pc);
                if rd == 15 {
                    return branch(cpu, sys, mem, v, pc, op, 0, 2);
                }
                cpu.regs.r[rd] = v;
            }
            _ => {
                let t = rr(cpu, rs, pc);
                if o & 0x80 != 0 {
                    // BLX reg: bits[2:0] are reserved 000 on Cortex-M3
                    // (v8-M blxns space) — validate BEFORE writing LR, or
                    // a faulting BLX corrupts LR (differential fuzz: LR
                    // written, oracle faults cleanly). Target must stay
                    // Thumb (branch faults even targets like HW).
                    if o & 7 != 0 {
                        return fault(cpu, pc, op, 0, 2);
                    }
                    // BLX reg: LR = next addr; target must stay Thumb
                    cpu.regs.r[14] = (pc + 2) | 1;
                }
                return branch(cpu, sys, mem, t, pc, op, 0, 2);
            }
        }
        adv(cpu, pc, 2);
        return 1;
    }
    // SVC: synchronous exception. With delivery on, take it inline (exact
    // stacking, handler runs on MSP); otherwise loud fault (polling
    // firmware never SVCs, so hitting one is a bug worth surfacing).
    // The active-priority push balances exception_return's pop, including
    // an SVC taken inside a handler (nested).
    if o & 0xFF00 == 0xDF00 {
        if !cpu.deliver_irqs {
            return fault(cpu, pc, op, 0, 2);
        }
        adv(cpu, pc, 2);
        sys.p.nvic.borrow_mut().push_active(-5);
        cpu.take_exception(sys, mem, -5);
        return 1;
    }
    if o & 0xFF00 == 0xDE00 {
        return fault(cpu, pc, op, 0, 2);
    }
    // B.cond / B (base is pc+4: Thumb PC reads as addr+4)
    if o & 0xF000 == 0xD000 {
        let cc = (o >> 8) & 0xF;
        let imm = sx(((o & 0xFF) << 1) as u32, 9);
        if cond_ok(cpu, cc) {
            return branch(cpu, sys, mem, (pc.wrapping_add(4).wrapping_add(imm)) | 1, pc, op, 0, 2);
        }
        adv(cpu, pc, 2);
        return 1;
    }
    // LDR literal
    if o & 0xF800 == 0x4800 {
        // Fused (LDRlit, LDR-imm): common literal-then-field double load.
        if cpu.it_n == 0 && (q & 0xF800) == 0x6800 && fusion_live() {
            return fused_ldr_ldr(cpu, sys, mem, o, q, pc);
        }
        let rt = ((o >> 8) & 7) as usize;
        let base = (pc + 4) & !3;
        cpu.regs.r[rt] = mem.read32(base.wrapping_add((o & 0xFF) * 4));
        adv(cpu, pc, 2);
        return 1;
    }
    if o & 0xF800 == 0x6800 {
        let (rn, rt) = (((o >> 3) & 7) as usize, (o & 7) as usize);
        let addr = rr(cpu, rn, pc).wrapping_add(((o >> 6) & 0x1F) * 4);
        cpu.regs.r[rt] = mem.read32(addr);
        adv(cpu, pc, 2);
        return 1;
    }
    // ALU ops
    if o & 0xFC00 == 0x4000 {
        let sop = (o >> 6) & 0xF;
        let (rs, rd) = (((o >> 3) & 7) as usize, (o & 7) as usize);
        let a = rr(cpu, rd, pc);
        let b = rr(cpu, rs, pc);
        match sop {
            0 => {
                let r = a & b;
                cpu.regs.r[rd] = r;
                nz(cpu, r);
            }
            1 => {
                let r = a ^ b;
                cpu.regs.r[rd] = r;
                nz(cpu, r);
            }
            2 => {
                let (r, co) = shift_op(a, 0, b & 0xFF, carry(cpu));
                cpu.regs.r[rd] = r;
                nz(cpu, r);
                if !cpu.it_suppress {
                    cpu.regs.xpsr = (cpu.regs.xpsr & !0x20000000) | (co << 29);
                }
            }
            3 => {
                // LSR (register): Rs==0 means NO shift (carry unchanged).
                // shift_op's amt==0 arm is the immediate encoding (LSR#0=#32).
                let amt = b & 0xFF;
                let (r, co) = if amt == 0 {
                    (a, carry(cpu))
                } else {
                    shift_op(a, 1, amt, carry(cpu))
                };
                cpu.regs.r[rd] = r;
                nz(cpu, r);
                if !cpu.it_suppress {
                    cpu.regs.xpsr = (cpu.regs.xpsr & !0x20000000) | (co << 29);
                }
            }
            4 => {
                // ASR (register): Rs==0 means NO shift (see LSR note).
                let amt = b & 0xFF;
                let (r, co) = if amt == 0 {
                    (a, carry(cpu))
                } else {
                    shift_op(a, 2, amt, carry(cpu))
                };
                cpu.regs.r[rd] = r;
                nz(cpu, r);
                if !cpu.it_suppress {
                    cpu.regs.xpsr = (cpu.regs.xpsr & !0x20000000) | (co << 29);
                }
            }
            5 => {
                let r = add_flags(cpu, a, b, carry(cpu));
                cpu.regs.r[rd] = r;
            }
            6 => {
                let r = sub_flags(cpu, a, b, carry(cpu));
                cpu.regs.r[rd] = r;
            }
            7 => {
                // ROR (register): Rs==0 means NO shift (see LSR note; RRX is
                // the immediate ROR#0 encoding only).
                let amt = b & 0xFF;
                let (r, co) = if amt == 0 {
                    (a, carry(cpu))
                } else {
                    shift_op(a, 3, amt, carry(cpu))
                };
                cpu.regs.r[rd] = r;
                nz(cpu, r);
                if !cpu.it_suppress {
                    cpu.regs.xpsr = (cpu.regs.xpsr & !0x20000000) | (co << 29);
                }
            }
            8 => {
                cpu.it_suppress = false; // T1 TST always updates flags.
                // TST is an AND test (not SUB): N/Z from a&b, C/V unchanged.
                // Using sub_flags here mis-set Z when a==b (1-1=0 vs 1&1=1),
                // making EXTI0_IRQHandler's `tst r1,r0; beq` skip the PR clear
                // + callback for line 0 only (other lines' SUB/AND agree).
                nz(cpu, a & b);
            }
            9 => {
                // RSB (negate): Rd = 0 - Rs, with flags
                let r = sub_flags(cpu, 0, b, 1);
                cpu.regs.r[rd] = r;
            }
            10 => {
                cpu.it_suppress = false; // T1 CMP always updates flags.
                sub_flags(cpu, a, b, 1);
            }
            11 => {
                cpu.it_suppress = false; // T1 CMN always updates flags.
                add_flags(cpu, a, b, 0);
            }
            12 => {
                let r = a | b;
                cpu.regs.r[rd] = r;
                nz(cpu, r);
            }
            13 => {
                let r = a.wrapping_mul(b);
                cpu.regs.r[rd] = r;
                nz(cpu, r);
            }
            14 => {
                let r = a & !b;
                cpu.regs.r[rd] = r;
                nz(cpu, r);
            }
            _ => {
                let r = !b;
                cpu.regs.r[rd] = r;
                nz(cpu, r);
            }
        }
        adv(cpu, pc, 2);
        return 1;
    }
    if o & 0xFE00 == 0x1A00 {
        // Fused (SUBreg, CMP-reg): compute-then-compare idiom (delay loops).
        if cpu.it_n == 0 && (q & 0xFC00) == 0x4000 && ((q >> 6) & 0xF) == 10 && fusion_live() {
            return fused_sub_cmp(cpu, sys, mem, o, q, pc);
        }
        // SUB (register) T1 likewise sets flags (`subs`).
        let (rd, rs, rn) = ((o & 7) as usize, ((o >> 3) & 7) as usize, ((o >> 6) & 7) as usize);
        let r = sub_flags(cpu, rr(cpu, rs, pc), rr(cpu, rn, pc), 1);
        cpu.regs.r[rd] = r;
        adv(cpu, pc, 2);
        return 1;
    }
    // LSL/LSR/ASR imm, ADD/SUB reg+imm3 (all flag-setting)
    if o & 0xF800 == 0x0000 {
        // Fused (LSL-imm, Bcc): shifted-compare loop tests.
        if cpu.it_n == 0 && is_bcc_shape(q) && fusion_live() {
            return fused_lsl_bcc(cpu, sys, mem, o, q, pc);
        }
        let (rd, rs) = ((o & 7) as usize, ((o >> 3) & 7) as usize);
        let im = (o >> 6) & 0x1F;
        let v = rr(cpu, rs, pc);
        let (r, co) = shift_op(v, 0, im, carry(cpu));
        cpu.regs.r[rd] = r;
        nz(cpu, r);
        if !cpu.it_suppress {
            cpu.regs.xpsr = (cpu.regs.xpsr & !0x20000000) | (co << 29);
        }
        adv(cpu, pc, 2);
        return 1;
    }
    if o & 0xF800 == 0xE000 {
        let imm = sx(((o & 0x7FF) << 1) as u32, 12);
        return branch(cpu, sys, mem, (pc.wrapping_add(4).wrapping_add(imm)) | 1, pc, op, 0, 2);
    }
    // CBZ / CBNZ (base pc+4; offset is imm5*2 + op[9]*64, GAS-verified)
    if o & 0xF500 == 0xB100 {
        let nz = ((o >> 3) & 0x1F) * 2 + ((o >> 9) & 1) * 64;
        let rn = (o & 7) as usize;
        let take = if o & 0x800 == 0 {
            rr(cpu, rn, pc) == 0
        } else {
            rr(cpu, rn, pc) != 0
        };
        if take {
            return branch(cpu, sys, mem, (pc.wrapping_add(4).wrapping_add(nz)) | 1, pc, op, 0, 2);
        }
        adv(cpu, pc, 2);
        return 1;
    }
    if o & 0xF800 == 0x2800 {
        // Fused (CMP-imm, Bcc): the loop-test idiom.
        if cpu.it_n == 0 && is_bcc_shape(q) && fusion_live() {
            return fused_cmp_bcc(cpu, sys, mem, o, q, pc);
        }
        let rn = ((o >> 8) & 7) as usize;
        cpu.it_suppress = false; // T1 CMP always updates flags, even in IT.
        sub_flags(cpu, rr(cpu, rn, pc), o & 0xFF, 1);
        adv(cpu, pc, 2);
        return 1;
    }
    // PUSH / POP
    if o & 0xFE00 == 0xB400 {
        let list = o & 0xFF;
        let nl = list.count_ones() + if o & 0x100 != 0 { 1 } else { 0 };
        let mut sp = cpu.regs.r[13].wrapping_sub(nl * 4);
        cpu.regs.r[13] = sp;
        for i in 0..8 {
            if (list >> i) & 1 == 1 {
                mem.write32(sp, cpu.regs.r[i as usize]);
                sp += 4;
            }
        }
        if o & 0x100 != 0 {
            mem.write32(sp, cpu.regs.r[14]);
        }
        adv(cpu, pc, 2);
        return 1;
    }
    if o & 0xFE00 == 0xBC00 {
        let list = o & 0xFF;
        let topc = o & 0x100 != 0;
        let mut sp = cpu.regs.r[13];
        for i in 0..8 {
            if (list >> i) & 1 == 1 {
                cpu.regs.r[i as usize] = mem.read32(sp);
                sp += 4;
            }
        }
        cpu.regs.r[13] = sp.wrapping_add(if topc { 4 } else { 0 });
        if topc {
            let t = mem.read32(sp);
            return branch(cpu, sys, mem, t, pc, op, 0, 2);
        }
        adv(cpu, pc, 2);
        return 1;
    }
    // ADD/SUB SP imm (1011_0000_0/1_xxxxxxx)
    if o & 0xFF00 == 0xB000 {
        let im = (o & 0x7F) * 4;
        if o & 0x80 == 0 {
            cpu.regs.r[13] = cpu.regs.r[13].wrapping_add(im);
        } else {
            cpu.regs.r[13] = cpu.regs.r[13].wrapping_sub(im);
        }
        adv(cpu, pc, 2);
        return 1;
    }
    if o & 0xF800 == 0x3000 {
        let rd = ((o >> 8) & 7) as usize;
        let r = add_flags(cpu, rr(cpu, rd, pc), o & 0xFF, 0);
        cpu.regs.r[rd] = r;
        adv(cpu, pc, 2);
        return 1;
    }
    if o & 0xF800 == 0x6000 {
        let (rn, rt) = (((o >> 3) & 7) as usize, (o & 7) as usize);
        let addr = rr(cpu, rn, pc).wrapping_add(((o >> 6) & 0x1F) * 4);
        mem.write32(addr, rr(cpu, rt, pc));
        adv(cpu, pc, 2);
        return 1;
    }
    if o & 0xF800 == 0x7800 {
        let (rn, rt) = (((o >> 3) & 7) as usize, (o & 7) as usize);
        let addr = rr(cpu, rn, pc).wrapping_add((o >> 6) & 0x1F);
        cpu.regs.r[rt] = mem.read8(addr) as u32;
        adv(cpu, pc, 2);
        return 1;
    }
    // SXTH/SXTB/UXTH/UXTB (B200-B2FF)
    if o & 0xFF00 == 0xB200 {
        let (rs, rd) = (((o >> 3) & 7) as usize, (o & 7) as usize);
        let v = rr(cpu, rs, pc);
        cpu.regs.r[rd] = match (o >> 6) & 3 {
            0 => sx(v & 0xFFFF, 16),
            1 => sx(v & 0xFF, 8),
            2 => v & 0xFFFF,
            _ => v & 0xFF,
        };
        adv(cpu, pc, 2);
        return 1;
    }
    // MOVS/CMP/ADDS/SUBS imm8
    if o & 0xF800 == 0x2000 {
        let rd = ((o >> 8) & 7) as usize;
        cpu.regs.r[rd] = o & 0xFF;
        // Predicated (in-IT) T1 MOVS preserves flags (matches silicon and
        // GCC's expectation: D_PageTicker's `itt lt; movlt; strlt` needs N
        // live for strlt; clobbering it hangs the title forever). Bare movs
        // sets N/Z via nz(); C and V are UNCHANGED (differential fuzz
        // caught a stray V-clear here).
        // it_suppress covers the last-slot case too (it_n is already
        // cleared there when it_ok runs).
        nz(cpu, o & 0xFF);
        adv(cpu, pc, 2);
        return 1;
    }
    if o & 0xFE00 == 0x1E00 {
        let (rd, rn) = ((o & 7) as usize, ((o >> 3) & 7) as usize);
        let im = (o >> 6) & 7;
        let r = sub_flags(cpu, rr(cpu, rn, pc), im, 1);
        cpu.regs.r[rd] = r;
        adv(cpu, pc, 2);
        return 1;
    }
    if o & 0xF800 == 0xA000 {
        let rd = ((o >> 8) & 7) as usize;
        cpu.regs.r[rd] = ((pc + 4) & !3).wrapping_add((o & 0xFF) * 4);
        adv(cpu, pc, 2);
        return 1;
    }
    if o & 0xF800 == 0x3800 {
        let rd = ((o >> 8) & 7) as usize;
        let r = sub_flags(cpu, rr(cpu, rd, pc), o & 0xFF, 1);
        cpu.regs.r[rd] = r;
        adv(cpu, pc, 2);
        return 1;
    }
    if o & 0xF800 == 0x9800 {
        let rt = ((o >> 8) & 7) as usize;
        cpu.regs.r[rt] = mem.read32(cpu.regs.r[13].wrapping_add((o & 0xFF) * 4));
        adv(cpu, pc, 2);
        return 1;
    }
    if o & 0xF800 == 0xA800 {
        let rd = ((o >> 8) & 7) as usize;
        cpu.regs.r[rd] = cpu.regs.r[13].wrapping_add((o & 0xFF) * 4);
        adv(cpu, pc, 2);
        return 1;
    }
    // hints + IT
    if o & 0xFF00 == 0xBF00 {
        if op == 0xBF00 {
            adv(cpu, pc, 2);
            return 1;
        }
        // WFI/WFE: with delivery on, halt until an interrupt is pending
        // (JS advances virtual time and wakes us). The instruction is
        // complete at halt, so on wake we resume AFTER it. Without
        // delivery this is a plain nop (polling path).
        if op == 0xBF30 || op == 0xBF20 {
            adv(cpu, pc, 2);
            if cpu.deliver_irqs {
                // A pending interrupt with PRIMASK clear means no sleep
                // (the exception is taken on the next run-loop iteration).
                if !(sys.p.nvic.borrow().has_pending() && cpu.regs.primask == 0) {
                    cpu.sleeping = true;
                    crate::system::CPU_SLEEPING.store(true, std::sync::atomic::Ordering::Relaxed);
                }
            }
            return 1;
        }
        // YIELD/WFE/WFI/SEV/SEVL(/other reserved hints): no-op for the
        // polling firmware the wasm core runs today.
        if o & 0x0F == 0 && (o & 0xF0) <= 0x50 {
            adv(cpu, pc, 2);
            return 1;
        }
        if o & 0x0F == 0 {
            return fault(cpu, pc, op, 0, 2);
        }
        cpu.it_cond = ((o >> 4) & 0xF) as u8;
        cpu.it_mask = (o & 0xF) as u8;
        cpu.it_n = 4 - cpu.it_mask.trailing_zeros() as u8;
        cpu.it_idx = 0;
        adv(cpu, pc, 2);
        return 1;
    }
    // SP-relative + ADR
    if o & 0xF800 == 0x9000 {
        let rt = ((o >> 8) & 7) as usize;
        mem.write32(cpu.regs.r[13].wrapping_add((o & 0xFF) * 4), rr(cpu, rt, pc));
        adv(cpu, pc, 2);
        return 1;
    }
    if o & 0xF800 == 0x8000 {
        let (rn, rt) = (((o >> 3) & 7) as usize, (o & 7) as usize);
        let addr = rr(cpu, rn, pc).wrapping_add(((o >> 6) & 0x1F) * 2);
        mem.write16(addr, (rr(cpu, rt, pc) & 0xFFFF) as u16);
        adv(cpu, pc, 2);
        return 1;
    }
    if o & 0xF800 == 0x0800 {
        let (rd, rs) = ((o & 7) as usize, ((o >> 3) & 7) as usize);
        let mut im = (o >> 6) & 0x1F;
        if im == 0 {
            im = 32;
        }
        let v = rr(cpu, rs, pc);
        let (r, co) = shift_op(v, 1, im, carry(cpu));
        cpu.regs.r[rd] = r;
        nz(cpu, r);
        if !cpu.it_suppress {
            cpu.regs.xpsr = (cpu.regs.xpsr & !0x20000000) | (co << 29);
        }
        adv(cpu, pc, 2);
        return 1;
    }
    if o & 0xF800 == 0x8800 {
        let (rn, rt) = (((o >> 3) & 7) as usize, (o & 7) as usize);
        let addr = rr(cpu, rn, pc).wrapping_add(((o >> 6) & 0x1F) * 2);
        cpu.regs.r[rt] = mem.read16(addr) as u32;
        adv(cpu, pc, 2);
        return 1;
    }
    // STR/LDR register-offset (class is op[11:9]; Ro=op[8:6], Rn=op[5:3], Rt=op[2:0])
    if o & 0xF000 == 0x5000 {
        let (ro, rn, rt) = (((o >> 6) & 7) as usize, ((o >> 3) & 7) as usize, (o & 7) as usize);
        let addr = rr(cpu, rn, pc).wrapping_add(rr(cpu, ro, pc));
        match (o >> 9) & 7 {
            0 => mem.write32(addr, rr(cpu, rt, pc)),
            1 => mem.write16(addr, (rr(cpu, rt, pc) & 0xFFFF) as u16),
            2 => mem.write8(addr, (rr(cpu, rt, pc) & 0xFF) as u8),
            3 => {
                let v = mem.read8(addr) as u32;
                cpu.regs.r[rt] = sx(v, 8);
            }
            4 => cpu.regs.r[rt] = mem.read32(addr),
            5 => cpu.regs.r[rt] = mem.read16(addr) as u32,
            6 => cpu.regs.r[rt] = mem.read8(addr) as u32,
            _ => {
                let v = mem.read16(addr) as u32;
                cpu.regs.r[rt] = sx(v, 16);
            }
        }
        adv(cpu, pc, 2);
        return 1;
    }
    if o & 0xFE00 == 0x1800 {
        // ADD (register) T1 sets flags (GAS assembles `adds` here; objdump
        // prints predicated uses as `add*`). Do NOT "fix" this to preserve
        // flags — that regressed strcasecmp/title (Z lost, early return).
        let (rd, rs, rn) = ((o & 7) as usize, ((o >> 3) & 7) as usize, ((o >> 6) & 7) as usize);
        let r = add_flags(cpu, rr(cpu, rs, pc), rr(cpu, rn, pc), 0);
        cpu.regs.r[rd] = r;
        adv(cpu, pc, 2);
        return 1;
    }
    if o & 0xF800 == 0x7000 {
        let (rn, rt) = (((o >> 3) & 7) as usize, (o & 7) as usize);
        let addr = rr(cpu, rn, pc).wrapping_add((o >> 6) & 0x1F);
        mem.write8(addr, (rr(cpu, rt, pc) & 0xFF) as u8);
        adv(cpu, pc, 2);
        return 1;
    }
    if o & 0xF800 == 0x1000 {
        let (rd, rs) = ((o & 7) as usize, ((o >> 3) & 7) as usize);
        let mut im = (o >> 6) & 0x1F;
        if im == 0 {
            im = 32;
        }
        let v = rr(cpu, rs, pc);
        let (r, co) = shift_op(v, 2, im, carry(cpu));
        cpu.regs.r[rd] = r;
        nz(cpu, r);
        if !cpu.it_suppress {
            cpu.regs.xpsr = (cpu.regs.xpsr & !0x20000000) | (co << 29);
        }
        adv(cpu, pc, 2);
        return 1;
    }
    if o & 0xFE00 == 0x1C00 {
        let (rd, rn) = ((o & 7) as usize, ((o >> 3) & 7) as usize);
        let im = (o >> 6) & 7;
        let r = add_flags(cpu, rr(cpu, rn, pc), im, 0);
        cpu.regs.r[rd] = r;
        adv(cpu, pc, 2);
        return 1;
    }
    if o & 0xF800 == 0xC800 {
        let rn = ((o >> 8) & 7) as usize;
        let list = o & 0xFF;
        let mut a = cpu.regs.r[rn];
        for i in 0..8 {
            if (list >> i) & 1 == 1 {
                cpu.regs.r[i as usize] = mem.read32(a);
                a += 4;
            }
        }
        if (list >> rn) & 1 == 0 {
            cpu.regs.r[rn] = a;
        }
        adv(cpu, pc, 2);
        return 1;
    }
    // CPS (primask). SETEND faults (never emitted by firmware).
    if o & 0xFF00 == 0xB600 {
        if o & 0x20 != 0 {
            cpu.regs.primask = (o >> 4) & 1;
            adv(cpu, pc, 2);
            return 1;
        }
        return fault(cpu, pc, op, 0, 2);
    }
    // REV / REV16 / REVSH (BA00-BAFF, op is bits[7:6])
    if o & 0xFF00 == 0xBA00 {
        let (rs, rd) = (((o >> 3) & 7) as usize, (o & 7) as usize);
        let v = rr(cpu, rs, pc);
        cpu.regs.r[rd] = match (o >> 6) & 3 {
            0 => v.swap_bytes(),
            1 => {
                ((v & 0xFF) << 8)
                    | ((v >> 8) & 0xFF)
                    | ((v & 0xFF0000) << 8)
                    | ((v & 0xFF000000) >> 8)
            }
            3 => sx(((v & 0xFF) << 8) | ((v >> 8) & 0xFF), 16),
            _ => return fault(cpu, pc, op, 0, 2),
        };
        adv(cpu, pc, 2);
        return 1;
    }
    // BKPT: stays a loud fault (debug breakpoints; no firmware here uses them
    // for control flow — FreeRTOS configASSERT loops, it doesn't trap).
    if o & 0xFF00 == 0xBE00 {
        return fault(cpu, pc, op, 0, 2);
    }
    // STMIA / LDMIA
    if o & 0xF800 == 0xC000 {
        let rn = ((o >> 8) & 7) as usize;
        let list = o & 0xFF;
        let mut a = rr(cpu, rn, pc);
        for i in 0..8 {
            if (list >> i) & 1 == 1 {
                mem.write32(a, cpu.regs.r[i as usize]);
                a += 4;
            }
        }
        // T1 STM always writes back (Rn==PC excluded by construction)
        cpu.regs.r[rn] = a;
        adv(cpu, pc, 2);
        return 1;
    }
    fault(cpu, pc, op, 0, 2)
}

// Apply a data-processing ALU op. Returns Some(writeback value) or None for
// test ops (TST/TEQ/CMP/CMN: S=1 and Rd=15). Flags set iff `s`.
fn alu_op(
    cpu: &mut Cpu,
    op: u32,
    s: bool,
    a: u32,
    b: u32,
    ci: u32,
    co: u32,
    rd_is_test: bool,
) -> Option<u32> {
    match op {
        0 => {
            let r = a & b;
            if s {
                nzc(cpu, r, co);
            }
            if rd_is_test {
                None
            } else {
                Some(r)
            }
        }
        1 => {
            let r = a & !b;
            if s {
                nzc(cpu, r, co);
            }
            Some(r)
        }
        2 => {
            let r = a | b;
            if s {
                nzc(cpu, r, co);
            }
            Some(r)
        }
        3 => {
            let r = a | !b;
            if s {
                nzc(cpu, r, co);
            }
            Some(r)
        }
        4 => {
            let r = a ^ b;
            if s {
                nzc(cpu, r, co);
            }
            if rd_is_test {
                None
            } else {
                Some(r)
            }
        }
        8 => {
            let r = if s {
                add_flags(cpu, a, b, 0)
            } else {
                a.wrapping_add(b)
            };
            if rd_is_test {
                None
            } else {
                Some(r)
            }
        }
        10 => {
            // ADC: a + b + carry
            let r = if s {
                add_flags(cpu, a, b, ci)
            } else {
                a.wrapping_add(b).wrapping_add(ci)
            };
            Some(r)
        }
        11 => {
            // SBC: a - b - !carry
            let r = if s {
                sub_flags(cpu, a, b, ci)
            } else {
                a.wrapping_sub(b).wrapping_sub(1 - ci)
            };
            Some(r)
        }
        13 => {
            let r = if s {
                sub_flags(cpu, a, b, 1)
            } else {
                a.wrapping_sub(b)
            };
            if rd_is_test {
                None
            } else {
                Some(r)
            }
        }
        14 => {
            // RSB: b - a... note operand order: RSB Rd,Rn,op2 = op2 - Rn.
            // Callers pass (a=Rn, b=op2) so RSB must compute b-a.
            let r = if s {
                sub_flags(cpu, b, a, 1)
            } else {
                b.wrapping_sub(a)
            };
            Some(r)
        }
        _ => {
            // 5,6,7,9,12,15 are unallocated in the integer subset
            let _ = co;
            None // caller turns this into a fault via a flag; see below
        }
    }
}

pub fn exec32(
    cpu: &mut Cpu,
    sys: &WasmSystem,
    mem: &mut FlatMemory,
    op1: u16,
    op2: u16,
    pc: u32,
) -> u32 {
    let o1 = op1 as u32;
    let o2 = op2 as u32;
    // 32-bit instructions respect their explicit S bit (helpers stay
    // unconditional); only 16-bit paths use it_suppress.
    cpu.it_suppress = false;
    if !it_ok(cpu) {
            adv(cpu, pc, 4);
            return 1;
        }
        // USAT / SSAT (saturate). Shares hw1 with MSR (0xF380|Rn) but o2[15]
        // is always 0 here (imm5 lives in o2[14:10]); MSR needs o2>=0x8800,
        // so the two are disjoint. GAS-verified: usat=F380, ssat=F300/F322.
        // USAT shift type lives in o1[5] (0=LSL 0xF380, 1=ASR 0xF3A0); the
        // ASR form previously fell into modified-imm data-proc and computed
        // garbage (silent mis-decode of a valid encoding).
        // Shift amount is imm3:imm2 = o2[14:12]:o2[7:6] (NOT o2[14:10]:
        // o2[11:8] is Rd — differential fuzz caught LSL-by-16-vs-17 here).
        // Dual-halfword forms take the ASR hw1 with o2[15:12]==0 AND
        // o2[7:4]==0 (capstone-verified: anything else with those hw1
        // bytes is single-shift or INVALID, never USAT16/SSAT16).
        if (o1 & 0xFFF0 == 0xF380 || o1 & 0xFFF0 == 0xF3A0) && o2 < 0x8000 {
            // USAT Rd, #sat, Rn [, LSL/ASR #sh]
            let rd = ((o2 >> 8) & 0xF) as usize;
            let rn = (o1 & 0xF) as usize;
            let asr = (o1 & 0xFFF0) == 0xF3A0;
            if asr && (o2 & 0xF000) == 0 && (o2 & 0x00F0) == 0 {
                // USAT16 Rd, #sat, Rn: per-halfword unsigned saturate, sat
                // direct from o2[3:0] (0-15, no +1 unlike SSAT16).
                let sat = (o2 & 0xF) as u32;
                let max: u64 = if sat >= 32 { 0xFFFF_FFFF } else { (1u64 << sat) - 1 };
                let a = rr(cpu, rn, pc);
                let mut r = 0u32;
                let mut q = false;
                for half in 0..2 {
                    let v = ((a >> (half * 16)) & 0xFFFF) as u64;
                    if v > max {
                        r |= (max as u32) << (half * 16);
                        q = true;
                    } else {
                        r |= (v as u32) << (half * 16);
                    }
                }
                if q {
                    cpu.regs.xpsr |= 0x08000000; // Q sticky
                }
                cpu.regs.r[rd] = r;
                adv(cpu, pc, 4);
                return 1;
            }
            let sat = (o2 & 0x1F) as u32;
            // Reserved o2[5] (capstone-INVALID, e.g. F380:0020): fault.
            // ASR #0 is UNPREDICTABLE (F3A0:0010 INVALID); LSL #0 = no shift.
            if (o2 & 0x20) != 0 {
                return fault(cpu, pc, op1, op2, 4);
            }
            let sh = (((o2 >> 12) & 7) << 2) | ((o2 >> 6) & 3);
            if asr && sh == 0 {
                return fault(cpu, pc, op1, op2, 4);
            }
            let a = rr(cpu, (o1 & 0xF) as usize, pc);
            let v = if (o1 >> 5) & 1 == 0 {
                a.wrapping_shl(sh)
            } else {
                ((a as i32).wrapping_shr(sh.min(31))) as u32
            };
            let max: u64 = if sat >= 32 { 0xFFFF_FFFF } else { (1u64 << sat) - 1 };
            let r = (v as u64).min(max) as u32;
            if (v as u64) > max {
                cpu.regs.xpsr |= 0x08000000; // Q sticky
            }
            cpu.regs.r[((o2 >> 8) & 0xF) as usize] = r;
            adv(cpu, pc, 4);
            return 1;
        }
        if (o1 & 0xFFF0 == 0xF300 || o1 & 0xFFF0 == 0xF320) && o2 < 0x8000 {
            // SSAT Rd, #sat, Rn [, LSL/ASL #sh] (sh-type is o1[5]).
            // Exact hw1 bytes: the 0xFFC0 mask also swallowed PKHBT/PKHTB
            // (0xF31x, DSP) as SSAT-garbage (differential fuzz caught it).
            // o2[15]==0 keeps B.W/Bcc.W/BL (op2[15]=1) falling through.
            // Unlike USAT, the sat field encodes N-1 (GAS: ssat#8=o2:0x07,
            // ssat#16=0x0F; usat#16=0x10 direct).
            // Dual-halfword SSAT16 takes the ASR hw1 (0xF320|Rn) with
            // o2[15:12]==0 AND o2[7:4]==0 (capstone-verified: F320:0010 and
            // F320:0110 are INVALID, F328:4141 is single-ASR#17).
            if (o1 & 0xFFF0) == 0xF320 && (o2 & 0xF000) == 0 && (o2 & 0x00F0) == 0 {
                let rd = ((o2 >> 8) & 0xF) as usize;
                let rn = (o1 & 0xF) as usize;
                let sat = ((o2 & 0xF) + 1) as u32;
                let (lo, hi): (i64, i64) = if sat >= 32 {
                    (i64::MIN, i64::MAX)
                } else {
                    (-(1i64 << (sat - 1)), (1i64 << (sat - 1)) - 1)
                };
                let a = rr(cpu, rn, pc);
                let mut r = 0u32;
                let mut q = false;
                for half in 0..2 {
                    let s = ((a >> (half * 16)) & 0xFFFF) as i16 as i64;
                    let c = (s.clamp(lo, hi) as i32 as u32) & 0xFFFF;
                    if s < lo || s > hi {
                        q = true;
                    }
                    r |= c << (half * 16);
                }
                if q {
                    cpu.regs.xpsr |= 0x08000000; // Q sticky
                }
                cpu.regs.r[rd] = r;
                adv(cpu, pc, 4);
                return 1;
            }
            let sat = ((o2 & 0x1F) + 1) as u32;
            // Reserved o2[5] and ASR #0 are UNPREDICTABLE (capstone-INVALID).
            if (o2 & 0x20) != 0 {
                return fault(cpu, pc, op1, op2, 4);
            }
            let sh = (((o2 >> 12) & 7) << 2) | ((o2 >> 6) & 3);
            if (o1 >> 5) & 1 == 1 && sh == 0 {
                return fault(cpu, pc, op1, op2, 4);
            }
            let a = rr(cpu, (o1 & 0xF) as usize, pc);
            let v = if (o1 >> 5) & 1 == 0 {
                a.wrapping_shl(sh)
            } else {
                ((a as i32).wrapping_shr(sh.min(31))) as u32
            };
            let (lo, hi): (i64, i64) = if sat == 0 || sat >= 32 {
                (i64::MIN, i64::MAX)
            } else {
                (-(1i64 << (sat - 1)), (1i64 << (sat - 1)) - 1)
            };
            let s = v as i32 as i64;
            let r = s.clamp(lo, hi) as i32 as u32;
            if s < lo || s > hi {
                cpu.regs.xpsr |= 0x08000000; // Q sticky
            }
            cpu.regs.r[((o2 >> 8) & 0xF) as usize] = r;
            adv(cpu, pc, 4);
            return 1;
        }
    // ---- F3: misc (hints, barriers, MRS/MSR, bitfield) ----
    // NOTE: F3xx overlaps Bcc.W's op1 range (F000-F3FF), so this must only
    // claim exact/shape-checked F3 forms and let Bcc.W-shaped op2 fall
    // through to the branch decoder below. MRS/MSR are safe to prioritize:
    // Bcc.W never validly uses their op1 (cond would be NV/AL, which
    // assemblers don't emit — B.W covers AL).
    if o1 & 0xFF00 == 0xF300 {
        if o1 == 0xF3AF && o2 == 0x8000 {
            adv(cpu, pc, 4); // NOP.W
            return 1;
        }
        if o1 == 0xF3AF && o2 == 0x80F0 {
            adv(cpu, pc, 4); // DBG: hint, no-op on silicon
            return 1;
        }
        if o1 == 0xF3BF && (o2 & 0xFF00) == 0x8F00 {
            // DMB/DSB/ISB/CLREX. CLREX (o2==0x8F5F) drops the LDREX
            // reservation; the barriers are NOPs for the emulator.
            if o2 == 0x8F5F {
                cpu.exclusive = None;
            }
            adv(cpu, pc, 4);
            return 1;
        }
        if o1 & 0xFFF0 == 0xF3E0 && o2 & 0xF000 == 0x8000 {
            // MRS Rd, SYSm
            let sysm = (o2 & 0xFF) as u32;
            let rd = ((o2 >> 8) & 0xF) as usize;
            cpu.regs.r[rd] = match sysm {
                0 | 1 | 2 => cpu.regs.xpsr & 0xF8000000, // APSR/IAPSR/EAPSR
                3 => cpu.regs.xpsr,                     // XPSR
                5 => cpu.ipsr,                          // IPSR (live exception number)
                6 | 7 => cpu.regs.xpsr & 0x0700FC00,    // EPSR/IEPSR
                8 => cpu.read_msp(),
                9 => cpu.read_psp(),
                16 => cpu.regs.primask,                 // PRIMASK
                17 | 18 => 0,                           // FAULTMASK/BASEPRI
                20 => cpu.regs.control,                 // CONTROL
                _ => return fault(cpu, pc, op1, op2, 4),
            };
            adv(cpu, pc, 4);
            return 1;
        }
        if o1 & 0xFFF0 == 0xF380 && o2 & 0xF000 == 0x8000 {
            // MSR SYSm, Rn. SYSm lives in o2[7:0] (0-3 xPSR, 8-9 MSP/PSP,
            // 16-20 PRIMASK..CONTROL) with o2[15:12]==8 for all of them —
            // the old 0x8800 guard rejected SYSm with high nibble 0
            // (PRIMASK, CONTROL, APSR) and those encodings fell through
            // into the branch decoder as wild branches.
            let sysm = (o2 & 0xFF) as u32;
            let v = rr(cpu, (o1 & 0xF) as usize, pc);
            match sysm {
                0 | 1 | 2 | 3 => {
                    cpu.regs.xpsr = (cpu.regs.xpsr & !0xF8000000) | (v & 0xF8000000)
                }
                8 => cpu.write_msp(v),
                9 => cpu.write_psp(v),
                16 => cpu.regs.primask = v & 1,
                17 | 18 => {}
                20 => {
                    // MSR CONTROL: an SPSEL change switches the current stack
                    // (hardware swaps r13 with the other bank).
                    let v = v & 3;
                    if (v ^ cpu.regs.control) & 2 != 0 {
                        if v & 2 != 0 {
                            cpu.regs.msp = cpu.regs.r[13];
                            cpu.regs.r[13] = cpu.regs.psp;
                        } else {
                            cpu.regs.psp = cpu.regs.r[13];
                            cpu.regs.r[13] = cpu.regs.msp;
                        }
                    }
                    cpu.regs.control = v;
                    // CONTROL.nPRIV gates MPU checks (FlatMemory has no CPU
                    // context); publish it. Rare event, negligible cost.
                    super::sync_privilege(cpu, sys);
                }
                _ => return fault(cpu, pc, op1, op2, 4),
            }
            adv(cpu, pc, 4);
            return 1;
        }
        if o2 < 0x8000 {
            // Bitfield with op2[15]=0 (Bcc.W/BL always have op2[15]=1).
            if o1 & 0xFFF0 == 0xF3C0 || o1 & 0xFFF0 == 0xF340 {
                // UBFX / SBFX
                let rn = (o1 & 0xF) as usize;
                let rd = ((o2 >> 8) & 0xF) as usize;
                let lsb = (((o2 >> 12) & 7) << 2) | ((o2 >> 6) & 3);
                let w = (o2 & 0x1F) + 1;
                // lsb+width > 32 is UNPREDICTABLE (differential fuzz: the
                // oracle faults sbfx #29,#17 while we extracted garbage).
                if lsb + w > 32 {
                    return fault(cpu, pc, op1, op2, 4);
                }
                let v = rr(cpu, rn, pc).wrapping_shr(lsb);
                let v = if w >= 32 { v } else { v & ((1u32 << w) - 1) };
                cpu.regs.r[rd] = if o1 & 0xFFF0 == 0xF340 { sx(v, w) } else { v };
                adv(cpu, pc, 4);
                return 1;
            }
            if o1 & 0xFFF0 == 0xF360 {
                // BFI / BFC (Rn==15)
                let rn = (o1 & 0xF) as usize;
                let rd = ((o2 >> 8) & 0xF) as usize;
                let lsb = (((o2 >> 12) & 7) << 2) | ((o2 >> 6) & 3);
                let msb = o2 & 0x1F;
                if msb < lsb || msb >= 32 {
                    return fault(cpu, pc, op1, op2, 4);
                }
                let w = msb - lsb + 1;
                let mask = if w >= 32 {
                    0xFFFF_FFFF
                } else {
                    ((1u32 << w) - 1) << lsb
                };
                if rn == 15 {
                    cpu.regs.r[rd] &= !mask;
                } else {
                    cpu.regs.r[rd] =
                        (cpu.regs.r[rd] & !mask) | ((rr(cpu, rn, pc) << lsb) & mask);
                }
                adv(cpu, pc, 4);
                return 1;
            }
            return fault(cpu, pc, op1, op2, 4);
        }
        // else: op2 >= 0x8000 with F3xx op1 and no exact match above.
        // Falls through to the F-bucket branch decoder (Bcc.W with F3xx
        // op1) or faults there. Do NOT return here.
    }
    // ---- F000-F7FF prefix: branches, MOVW/MOVT, modified-immediate ----
    if o1 & 0xF800 == 0xF000 {
        // branches (op2[15:14] == 10)
        if o2 & 0xC000 == 0x8000 {
            let s = (o1 >> 10) & 1;
            let imm10 = o1 & 0x3FF;
            let imm11 = o2 & 0x7FF;
            let j1 = (o2 >> 13) & 1;
            let j2 = (o2 >> 11) & 1;
            let i1 = j1 ^ s ^ 1;
            let i2 = j2 ^ s ^ 1;
            let off = sx((s << 24) | (i1 << 23) | (i2 << 22) | (imm10 << 12) | (imm11 << 1), 25);
            if o2 & 0x1000 != 0 {
                // B.W unconditional
                return branch(cpu, sys, mem, pc.wrapping_add(4).wrapping_add(off) | 1, pc, op1, op2, 4);
            }
            // Bcc.W: cond in op1[9:6]. 21-bit offset S:J1:J2:imm6:imm11:0
            // where J1=o2[11], J2=o2[13], used DIRECTLY with no S inversion
            // — unlike B.W above (NOT(J^S) + J1=o2[13]/J2=o2[11]).
            // Oracle+capstone+GCC-firmware triple-verified: F000:A880 ->
            // +0xC0100 (NOT-form would give +0x100); F416:8C8C ->
            // 0x1ff9891c; F47F:A741 -> 0x1ff81e86; firmware F040:80CA ->
            // 0x80013d2. (A "B.W-style inversion fix" here broke firmware
            // boot: for S=0 it differs from direct exactly when J is set,
            // i.e. on every real forward wide conditional.)
            let cc = (o1 >> 6) & 0xF;
            if cc == 0xF {
                return fault(cpu, pc, op1, op2, 4);
            }
            let imm6 = o1 & 0x3F;
            let j1 = (o2 >> 11) & 1;
            let j2 = (o2 >> 13) & 1;
            let off = sx(
                (s << 20) | (j1 << 19) | (j2 << 18) | (imm6 << 12) | (imm11 << 1),
                21,
            );
            if cc == 0xE || cond_ok(cpu, cc) {
                return branch(cpu, sys, mem, pc.wrapping_add(4).wrapping_add(off) | 1, pc, op1, op2, 4);
            }
            adv(cpu, pc, 4);
            return 1;
        }
        // BL (Fxxx) / BLX-imm (Exxx, ARM state: impossible on Cortex-M)
        if o2 & 0xC000 == 0xC000 {
            if o2 & 0xF000 == 0xF000 {
                let s = (o1 >> 10) & 1;
                let imm10 = o1 & 0x3FF;
                let imm11 = o2 & 0x7FF;
                let j1 = (o2 >> 13) & 1;
                let j2 = (o2 >> 11) & 1;
                let i1 = j1 ^ s ^ 1;
                let i2 = j2 ^ s ^ 1;
                let off = sx((s << 24) | (i1 << 23) | (i2 << 22) | (imm10 << 12) | (imm11 << 1), 25);
                cpu.regs.r[14] = (pc + 4) | 1;
                return branch(cpu, sys, mem, pc.wrapping_add(4).wrapping_add(off) | 1, pc, op1, op2, 4);
            }
            // BLX-imm (Exxx) targets ARM state, Cxxx/Dxxx unallocated here.
            return fault(cpu, pc, op1, op2, 4);
        }
        // MOVW / MOVT (F2 group, exact masks so F6/F7 never match).
        // Rd==PC is UNPREDICTABLE (the adv() below would silently swallow
        // the write and fall through): fault loudly like the oracle.
        if o1 & 0xFBF0 == 0xF240 {
            let rd = ((o2 >> 8) & 0xF) as usize;
            if rd == 15 {
                return fault(cpu, pc, op1, op2, 4);
            }
            let i = (o1 >> 10) & 1;
            let imm = (i << 11) | ((o1 & 0xF) << 12) | (((o2 >> 12) & 7) << 8) | (o2 & 0xFF);
            cpu.regs.r[rd] = imm;
            adv(cpu, pc, 4);
            return 1;
        }
        if o1 & 0xFBF0 == 0xF2C0 {
            let rd = ((o2 >> 8) & 0xF) as usize;
            if rd == 15 {
                return fault(cpu, pc, op1, op2, 4);
            }
            let i = (o1 >> 10) & 1;
            let imm = (i << 11) | ((o1 & 0xF) << 12) | (((o2 >> 12) & 7) << 8) | (o2 & 0xFF);
            cpu.regs.r[rd] = (cpu.regs.r[rd] & 0xFFFF) | (imm << 16);
            adv(cpu, pc, 4);
            return 1;
        }
        // ADDW / SUBW (F2 group): plain 12-bit immediate, NO ThumbExpand,
        // no flags. GAS-verified: addw=F20x, subw=F2Ax (i-bit in o1[10]
        // flips F2->F6, e.g. subw#4095=F6A1). Must precede modified-imm:
        // ADDW's o1[8:5]=0 decodes as AND-imm (silently wrong), SUBW's =5
        // faults. (ADDSW/SUBSW F3 S-variants still fault loudly.)
        if o1 & 0xFBF0 == 0xF200 || o1 & 0xFBF0 == 0xF2A0 {
            let sub = (o1 & 0xFBF0) == 0xF2A0;
            let rn = (o1 & 0xF) as usize;
            let rd = ((o2 >> 8) & 0xF) as usize;
            // Rd==PC is UNPREDICTABLE (differential fuzz: subw pc silently
            // wrote PC where the oracle faults): fault loudly.
            if rd == 15 {
                return fault(cpu, pc, op1, op2, 4);
            }
            let imm = (((o1 >> 10) & 1) << 11) | (((o2 >> 12) & 7) << 8) | (o2 & 0xFF);
            cpu.regs.r[rd] = if sub {
                rr(cpu, rn, pc).wrapping_sub(imm)
            } else {
                rr(cpu, rn, pc).wrapping_add(imm)
            };
            adv(cpu, pc, 4);
            return 1;
        }
        // F6/F7 + data op2: SSAT/USAT/coprocessor zone (no samples) -> fault
        if o1 >= 0xF600 {
            return fault(cpu, pc, op1, op2, 4);
        }
        // modified-immediate data processing (F000-F5FF, op2 < 0x8000)
        if o2 & 0x8000 == 0 {
            let b8 = (o1 >> 8) & 1;
            let b7 = (o1 >> 7) & 1;
            let b6 = (o1 >> 6) & 1;
            let b5 = (o1 >> 5) & 1;
            let s = (o1 & 0x10) != 0;
            // GAS-verified op table (uniform across F and EA/EB groups)
            let op = match (b8 << 3) | (b7 << 2) | (b6 << 1) | b5 {
                0b0000 => 0,  // AND
                0b0001 => 1,  // BIC
                0b0010 => 2,  // ORR
                0b0011 => 3,  // MVN/ORN
                0b0100 => 4,  // EOR
                0b1000 => 8,  // ADD
                0b1010 => 10, // ADC
                0b1011 => 11, // SBC
                0b1101 => 13, // SUB
                0b1110 => 14, // RSB
                _ => return fault(cpu, pc, op1, op2, 4),
            };
            let rn = (o1 & 0xF) as usize;
            let rd = ((o2 >> 8) & 0xF) as usize;
            let imm12 = (((o1 >> 10) & 1) << 11) | (((o2 >> 12) & 7) << 8) | (o2 & 0xFF);
            let ci = carry(cpu);
            let (imm, co) = expand_imm(imm12, ci);
            let a = rr(cpu, rn, pc);
            // MOV/MVN: Rn==15 selects move form
            if op == 2 && rn == 15 {
                if rd == 15 {
                    if s {
                        // MOVS pc: exception return (not supported yet)
                        return fault(cpu, pc, op1, op2, 4);
                    }
                    return branch(cpu, sys, mem, imm, pc, op1, op2, 4);
                }
                cpu.regs.r[rd] = imm;
                if s {
                    nzc(cpu, imm, co);
                }
                adv(cpu, pc, 4);
                return 1;
            }
            if op == 3 && rn == 15 {
                if rd == 15 {
                    return fault(cpu, pc, op1, op2, 4);
                }
                cpu.regs.r[rd] = !imm;
                if s {
                    nzc(cpu, !imm, co);
                }
                adv(cpu, pc, 4);
                return 1;
            }
            let test = s && rd == 15;
            match alu_op(cpu, op, s, a, imm, ci, co, test) {
                Some(r) => {
                    if rd == 15 {
                        return branch(cpu, sys, mem, r, pc, op1, op2, 4);
                    }
                    cpu.regs.r[rd] = r;
                    adv(cpu, pc, 4);
                    1
                }
                None => {
                    if test {
                        adv(cpu, pc, 4);
                        1
                    } else {
                        fault(cpu, pc, op1, op2, 4)
                    }
                }
            }
        } else {
            fault(cpu, pc, op1, op2, 4)
        }
        // ---- F8/F9: single data transfer (word/byte/half/signed) ----
    } else if o1 & 0xF800 == 0xF800 && o1 < 0xFA00 {
        let c = (o1 >> 4) & 0xF; // class nibble
        let rn = (o1 & 0xF) as usize;
        let rt = ((o2 >> 12) & 0xF) as usize;
        // size/load operation by class:
        // F8 T3 (c 0..5): 0 STRB,1 LDRB,2 STRH,3 LDRH,4 STR,5 LDR (imm8-PUW or reg)
        // F8 T2 (c 8..13): 8 STRB,9 LDRB,10 STRH,11 LDRH,12 STR,13 LDR (imm12)
        // F9 T1 (c 9,11): 9 LDRSB,11 LDRSH (imm12); F9 T2 (c 1,3): PUW forms
        let f9 = o1 >= 0xF900;
        let (is_load, size, signed) = if !f9 {
            match c {
                0 => (false, 1, false),
                1 => (true, 1, false),
                2 => (false, 2, false),
                3 => (true, 2, false),
                4 => (false, 4, false),
                5 => (true, 4, false),
                8 => (false, 1, false),
                9 => (true, 1, false),
                10 => (false, 2, false),
                11 => (true, 2, false),
                12 => (false, 4, false),
                13 => (true, 4, false),
                _ => return fault(cpu, pc, op1, op2, 4),
            }
        } else {
            match c {
                1 => (true, 1, true),
                3 => (true, 2, true),
                9 => (true, 1, true),
                11 => (true, 2, true),
                _ => return fault(cpu, pc, op1, op2, 4),
            }
        };
        // addressing: T2-imm12 (c>=8) vs T3-PUW/register (c<8)
        if c >= 8 {
            let imm12 = o2 & 0xFFF;
            if rn == 15 {
                // literal pool
                if !is_load {
                    return fault(cpu, pc, op1, op2, 4);
                }
                // Unsigned byte/half into PC are PLD hints, signed are
                // PLI (no literal signed-into-PC encoding). Word LDR-pc
                // is a genuine interworking branch (NOT a hint).
                if rt == 15 && size != 4 {
                    adv(cpu, pc, 4); // PLD/PLI
                    return 1;
                }
                let base = (pc + 4) & !3;
                let v = mem.read32(base.wrapping_add(imm12));
                cpu.regs.r[rt] = match (size, signed) {
                    (1, false) => v & 0xFF,
                    (2, false) => v & 0xFFFF,
                    (1, true) => sx(v & 0xFF, 8),
                    (2, true) => sx(v & 0xFFFF, 16),
                    _ => v,
                };
                if rt == 15 {
                    // Word LDR-literal into PC: genuine interwork.
                    return branch(cpu, sys, mem, v, pc, op1, op2, 4);
                }
                adv(cpu, pc, 4);
                return 1;
            }
            if rt == 15 {
                if !is_load {
                    return fault(cpu, pc, op1, op2, 4);
                }
                // Genuine interworking loads: word LDR + F9 signed (T and
                // privileged alike). Unsigned byte/half into PC are PLD.
                if !signed && size != 4 {
                    adv(cpu, pc, 4); // PLD
                    return 1;
                }
                // else: fall through to the load path (writes r15, then
                // interworks at the rt==15 check below).
            }
            let addr = rr(cpu, rn, pc).wrapping_add(imm12);
            if is_load {
                let v = match size {
                    1 => mem.read8(addr) as u32,
                    2 => mem.read16(addr) as u32,
                    _ => mem.read32(addr),
                };
                cpu.regs.r[rt] = if signed {
                    sx(v, size * 8)
                } else {
                    v
                };
                if rt == 15 {
                    // LDR pc literal already handled; imm12 LDR pc: interwork
                    let t = cpu.regs.r[15];
                    return branch(cpu, sys, mem, t, pc, op1, op2, 4);
                }
            } else {
                let v = rr(cpu, rt, pc);
                match size {
                    1 => mem.write8(addr, (v & 0xFF) as u8),
                    2 => mem.write16(addr, (v & 0xFFFF) as u16),
                    _ => mem.write32(addr, v),
                }
            }
            adv(cpu, pc, 4);
            return 1;
        }
        // T3 literal pool (Rn==PC, c<8): ALWAYS the negative form —
        // positive literals encode as c>=8 (F89F/F8BF/F8DF), so U is
        // hardwired 0 here and o2 is Rt:imm12 (not P:U:W:imm8). Routing
        // these into the PUW path below read a garbage imm8 (differential
        // fuzz: ldrb.w [pc,#-0x757] loaded base+0x57 instead of base-0x757).
        // Literal stores have no encoding (UNDEFINED): fault loudly.
        if rn == 15 {
            if !is_load {
                return fault(cpu, pc, op1, op2, 4);
            }
            let addr = ((pc + 4) & !3).wrapping_sub(o2 & 0xFFF);
            if rt == 15 {
                if !signed && size != 4 {
                    adv(cpu, pc, 4); // PLD: pure hint
                    return 1;
                }
                if signed {
                    adv(cpu, pc, 4); // PLI: no literal-into-PC signed load
                    return 1;
                }
                let v = mem.read32(addr);
                cpu.regs.r[15] = v;
                return branch(cpu, sys, mem, v, pc, op1, op2, 4);
            }
            let v = match size {
                1 => mem.read8(addr) as u32,
                2 => mem.read16(addr) as u32,
                _ => mem.read32(addr),
            };
            cpu.regs.r[rt] = if signed { sx(v, size * 8) } else { v };
            adv(cpu, pc, 4);
            return 1;
        }
        // T3: c<8. Register-offset iff op2[11:10]==00 AND Rn!=PC: with
        // Rn==PC every form is literal (capstone-verified: even [11:10]==00
        // decodes literal, e.g. `ldr.w r0,[pc,#-3]`), so Rn==PC always
        // routes to the imm8/literal path below. (GAS-verified: strh
        // [r9,r3,lsl#1]=o2:0x2013, str [r4,r7,lsl#2]=0x0027,
        // strb [r9,r3]=0x2003, ldr [r3,r0,lsl#2]=0x4020; imm forms like
        // str [r4],#4 (0x0B04) have [11:10]!=00). Applies to every data
        // class (STRB/LDRB/STRH/LDRH/STR/LDR), not just words — routing
        // only c4/5 here sent strh-reg into imm8 post-indexed writeback
        // (r9 -= imm8 per store), which corrupted DOOM's collump pointer.
        if (o2 & 0xC00) == 0 && rn != 15 {
            let rm = (o2 & 0xF) as usize;
            let sh = (o2 >> 4) & 3;
            let off = rr(cpu, rm, pc).wrapping_shl(sh);
            let addr = rr(cpu, rn, pc).wrapping_add(off);
            if is_load {
                // Rt==PC: unsigned byte/half is PLD (pure hint); word is a
                // genuine LDR-register branch (`ldr.w pc,[r5,r2]`); F9
                // signed into PC behaves as a hint too (differential fuzz:
                // the oracle advances past `ldrsb pc,[r0,r2]` shapes that
                // Capstone prints as `pli`, without loading).
                if rt == 15 && !signed && size != 4 {
                    adv(cpu, pc, 4);
                    return 1;
                }
                if rt == 15 && signed {
                    adv(cpu, pc, 4);
                    return 1;
                }
                if rt == 15 {
                    if size != 4 || signed {
                        return fault(cpu, pc, op1, op2, 4);
                    }
                    cpu.regs.r[15] = mem.read32(addr);
                    let t = cpu.regs.r[15];
                    return branch(cpu, sys, mem, t, pc, op1, op2, 4);
                }
                // Signed forms (F9 LDRSB/LDRSH-reg, GAS-verified) sign-extend.
                cpu.regs.r[rt] = match (size, signed) {
                    (1, false) => mem.read8(addr) as u32,
                    (2, false) => mem.read16(addr) as u32,
                    (1, true) => sx(mem.read8(addr) as u32, 8),
                    (2, true) => sx(mem.read16(addr) as u32, 16),
                    _ => mem.read32(addr),
                };
            } else {
                if signed {
                    // No signed store encodings exist; stay loud.
                    return fault(cpu, pc, op1, op2, 4);
                }
                if rt == 15 {
                    return fault(cpu, pc, op1, op2, 4);
                }
                let v = rr(cpu, rt, pc);
                match size {
                    1 => mem.write8(addr, (v & 0xFF) as u8),
                    2 => mem.write16(addr, (v & 0xFFFF) as u16),
                    _ => mem.write32(addr, v),
                }
            }
            adv(cpu, pc, 4);
            return 1;
        }
        // imm8 P/U/W form
        let p = (o2 >> 10) & 1;
        let u = (o2 >> 9) & 1;
        let w = (o2 >> 8) & 1;
        let imm8 = o2 & 0xFF;
        let off = if u == 1 { imm8 } else { imm8.wrapping_neg() };
        let base = rr(cpu, rn, pc);
        let addr = if p == 1 { base.wrapping_add(off) } else { base };
        if is_load {
            // PLD/PLI are pure hints: unsigned byte/half with Rt==PC (any
            // Rn — `pld [pc,#-x]`, `pld [r0,#-x]`), plus F9 LDRSB/LDRSH
            // with Rt==PC (there is no literal-into-PC signed load; the
            // encoding IS PLI). Word Rt==PC is the genuine `ldr.w pc`
            // interworking branch (literal or offset, handled by the load
            // path below); other signed-RtPC has no encoding (faults below).
            if rt == 15 && !signed && size != 4 {
                adv(cpu, pc, 4);
                return 1;
            }
            // F9 LDRSB/LDRSH (incl. T-forms LDRSBT/LDRSHT) with Rt==PC
            // and Rn!=PC are genuine interworking loads, NOT PLI
            // (differential fuzz: the oracle loads and branches; PLI is
            // literal-only, handled in the Rn==PC block above).
            if rt == 15 && signed && f9 && (c == 1 || c == 3 || c == 9 || c == 11) {
                let v = match size {
                    1 => mem.read8(addr) as u32,
                    2 => mem.read16(addr) as u32,
                    _ => mem.read32(addr),
                };
                let v = sx(v, size * 8);
                cpu.regs.r[15] = v;
                if w == 1 || p == 0 {
                    cpu.regs.r[rn] = base.wrapping_add(off);
                }
                return branch(cpu, sys, mem, v, pc, op1, op2, 4);
            }
            let v = match size {
                1 => mem.read8(addr) as u32,
                2 => mem.read16(addr) as u32,
                _ => mem.read32(addr),
            };
            let v = if signed { sx(v, size * 8) } else { v };
            if rt == 15 {
                // F9 signed loads into PC (T and privileged alike) are
                // genuine interworking loads (see the c>=8 note above).
                if size != 4 && !(signed && f9 && (c == 1 || c == 3 || c == 9 || c == 11)) {
                    return fault(cpu, pc, op1, op2, 4);
                }
                cpu.regs.r[15] = v;
                if w == 1 || p == 0 {
                    cpu.regs.r[rn] = base.wrapping_add(off);
                }
                return branch(cpu, sys, mem, v, pc, op1, op2, 4);
            }
            cpu.regs.r[rt] = v;
        } else {
            if rt == 15 {
                return fault(cpu, pc, op1, op2, 4);
            }
            let v = rr(cpu, rt, pc);
            match size {
                1 => mem.write8(addr, (v & 0xFF) as u8),
                2 => mem.write16(addr, (v & 0xFFFF) as u16),
                _ => mem.write32(addr, v),
            }
        }
        if w == 1 || p == 0 {
            cpu.regs.r[rn] = base.wrapping_add(off);
        }
        adv(cpu, pc, 4);
        return 1;
        // ---- FA: shifted-reg, extend, CLZ/RBIT/REV ----
    } else if o1 & 0xFF00 == 0xFA00 {
        let op = (o1 >> 4) & 0xF;
        let rn = (o1 & 0xF) as usize;
        let rd = ((o2 >> 8) & 0xF) as usize;
        let rm = (o2 & 0xF) as usize;
        match op {
            0 => {
                // LSL-reg (op2[7:4]==0) or SXT AH/SXTH (op2[7:4]==8)
                if o2 & 0xF000 != 0xF000 {
                    return fault(cpu, pc, op1, op2, 4);
                }
                match (o2 >> 4) & 0xF {
                    0 => {
                        // Rd = Rn << (Rm & 0xFF): value is Rn (op1), amount Rm (op2)
                        let amt = rr(cpu, rm, pc) & 0xFF;
                        let (r, _) = shift_op(rr(cpu, rn, pc), 0, amt, carry(cpu));
                        cpu.regs.r[rd] = r;
                        adv(cpu, pc, 4);
                        return 1;
                    }
                    8 => {
                        if o2 & 0xC0 != 0x80 {
                            return fault(cpu, pc, op1, op2, 4);
                        }
                        let rot = ((o2 >> 4) & 3) * 8;
                        let v = sx(ror32(rr(cpu, rm, pc), rot) & 0xFFFF, 16);
                        cpu.regs.r[rd] = if rn == 15 {
                            v
                        } else {
                            rr(cpu, rn, pc).wrapping_add(v)
                        };
                        adv(cpu, pc, 4);
                        return 1;
                    }
                    _ => return fault(cpu, pc, op1, op2, 4),
                }
            }
            2 | 3 | 6 | 7 => {
                // LSR/LSRS/ROR/RORS (register), op2[7:4]==0; S iff op is odd
                // (GAS-verified: FA20 lsr.w / FA30 lsrs.w, FA60 ror.w /
                // FA70 rors.w). SXT16 forms fault loudly for now.
                if o2 & 0xF0F0 != 0xF000 {
                    return fault(cpu, pc, op1, op2, 4);
                }
                let typ = op >> 1; // 1 (LSR), 3 (ROR)
                let amt = rr(cpu, rm, pc) & 0xFF;
                // Register shift by 0 = no shift (carry unchanged). shift_op's
                // amt==0 arm is the IMMEDIATE encoding (LSR#0=#32, ROR#0=RRX),
                // so bypass it here (HAL_GPIO_Init's lsrs.w r5,r2,r6 with r6=0
                // returned 0 instead of r2, skipping all GPIO/EXTI setup).
                let (r, co) = if amt == 0 {
                    (rr(cpu, rn, pc), carry(cpu))
                } else {
                    shift_op(rr(cpu, rn, pc), typ, amt, carry(cpu))
                };
                cpu.regs.r[rd] = r;
                if op & 1 != 0 {
                    nz(cpu, r);
                    cpu.regs.xpsr = (cpu.regs.xpsr & !0x20000000) | (co << 29);
                }
                adv(cpu, pc, 4);
                return 1;
            }
            1 => {
                // LSLS (op2[7:4]==0, S) or UXT AH / UXTH (op2 = F:Rd:10:rot:Rm).
                // (GAS-verified: FA12 lsls.w.)
                if o2 & 0xF000 != 0xF000 {
                    return fault(cpu, pc, op1, op2, 4);
                }
                match (o2 >> 4) & 0xF {
                    0 => {
                        let amt = rr(cpu, rm, pc) & 0xFF;
                        let (r, co) = shift_op(rr(cpu, rn, pc), 0, amt, carry(cpu));
                        cpu.regs.r[rd] = r;
                        nz(cpu, r);
                        cpu.regs.xpsr = (cpu.regs.xpsr & !0x20000000) | (co << 29);
                        adv(cpu, pc, 4);
                        return 1;
                    }
                    8 => {
                        if o2 & 0xC0 != 0x80 {
                            return fault(cpu, pc, op1, op2, 4);
                        }
                        let rot = ((o2 >> 4) & 3) * 8;
                        let v = ror32(rr(cpu, rm, pc), rot) & 0xFFFF;
                        cpu.regs.r[rd] = if rn == 15 {
                            v
                        } else {
                            rr(cpu, rn, pc).wrapping_add(v)
                        };
                        adv(cpu, pc, 4);
                        return 1;
                    }
                    _ => return fault(cpu, pc, op1, op2, 4),
                }
            }
            4 => {
                // ASR-reg (op2[7:4]==0) or SXTAB/SXTB (op2[7:4]==8)
                if o2 & 0xF000 != 0xF000 {
                    return fault(cpu, pc, op1, op2, 4);
                }
                match (o2 >> 4) & 0xF {
                    0 => {
                        let amt = rr(cpu, rm, pc) & 0xFF;
                        // Register ASR by 0 = no shift (see LSR note above).
                        let (r, _) = if amt == 0 {
                            (rr(cpu, rn, pc), carry(cpu))
                        } else {
                            shift_op(rr(cpu, rn, pc), 2, amt, carry(cpu))
                        };
                        cpu.regs.r[rd] = r;
                        adv(cpu, pc, 4);
                        return 1;
                    }
                    8 => {
                        if o2 & 0xC0 != 0x80 {
                            return fault(cpu, pc, op1, op2, 4);
                        }
                        let rot = ((o2 >> 4) & 3) * 8;
                        let v = sx(ror32(rr(cpu, rm, pc), rot) & 0xFF, 8);
                        cpu.regs.r[rd] = if rn == 15 {
                            v
                        } else {
                            rr(cpu, rn, pc).wrapping_add(v)
                        };
                        adv(cpu, pc, 4);
                        return 1;
                    }
                    _ => return fault(cpu, pc, op1, op2, 4),
                }
            }
            5 => {
                // ASRS (op2[7:4]==0, S) or UXTAB / UXTB (op2 = F:Rd:10:rot:Rm).
                // (GAS-verified: FA52 asrs.w.)
                if ((o2 >> 4) & 0xF) == 0 {
                    let amt = rr(cpu, rm, pc) & 0xFF;
                    // Register ASRS by 0 = no shift (see LSR note above).
                    let (r, co) = if amt == 0 {
                        (rr(cpu, rn, pc), carry(cpu))
                    } else {
                        shift_op(rr(cpu, rn, pc), 2, amt, carry(cpu))
                    };
                    cpu.regs.r[rd] = r;
                    nz(cpu, r);
                    cpu.regs.xpsr = (cpu.regs.xpsr & !0x20000000) | (co << 29);
                    adv(cpu, pc, 4);
                    return 1;
                }
                // UXTAB / UXTB (op2 = F:Rd:10:rot:Rm)
                if o2 & 0xF0C0 != 0xF080 {
                    return fault(cpu, pc, op1, op2, 4);
                }
                let rot = ((o2 >> 4) & 3) * 8;
                let v = ror32(rr(cpu, rm, pc), rot) & 0xFF;
                cpu.regs.r[rd] = if rn == 15 {
                    v
                } else {
                    rr(cpu, rn, pc).wrapping_add(v)
                };
                adv(cpu, pc, 4);
                return 1;
            }
            9 => {
                // REV.W / REV16.W / REVSH.W / RBIT (op2[7:4] selects)
                if o2 & 0xF000 != 0xF000 {
                    return fault(cpu, pc, op1, op2, 4);
                }
                let v = rr(cpu, rm, pc);
                cpu.regs.r[rd] = match (o2 >> 4) & 0xF {
                    8 => v.swap_bytes(),
                    9 => {
                        ((v & 0xFF) << 8)
                            | ((v >> 8) & 0xFF)
                            | ((v & 0xFF0000) << 8)
                            | ((v & 0xFF000000) >> 8)
                    }
                    10 => v.reverse_bits(),
                    11 => sx(((v & 0xFF) << 8) | ((v >> 8) & 0xFF), 16),
                    _ => return fault(cpu, pc, op1, op2, 4),
                };
                adv(cpu, pc, 4);
                return 1;
            }
            11 => {
                // CLZ / RBIT
                if o2 & 0xF000 != 0xF000 {
                    return fault(cpu, pc, op1, op2, 4);
                }
                let v = rr(cpu, rm, pc);
                cpu.regs.r[rd] = match (o2 >> 4) & 0xF {
                    8 => v.leading_zeros(),
                    10 => v.reverse_bits(),
                    _ => return fault(cpu, pc, op1, op2, 4),
                };
                adv(cpu, pc, 4);
                return 1;
            }
            _ => return fault(cpu, pc, op1, op2, 4),
        }
        // ---- FB: multiply / divide ----
    } else if o1 & 0xFF00 == 0xFB00 {
        let op = (o1 >> 4) & 0xF;
        let rn = (o1 & 0xF) as usize;
        let ra = ((o2 >> 12) & 0xF) as usize;
        let rd = ((o2 >> 8) & 0xF) as usize;
        let rm = (o2 & 0xF) as usize;
        match op {
            0 => {
                // PC operands are UNPREDICTABLE here (unlike ADD etc.);
                // fault loudly like the oracle does.
                if rn == 15 || rm == 15 {
                    return fault(cpu, pc, op1, op2, 4);
                }
                let sub = (o2 >> 4) & 0xF;
                if sub == 0 {
                    if ra == 15 {
                        cpu.regs.r[rd] =
                            rr(cpu, rn, pc).wrapping_mul(rr(cpu, rm, pc));
                    } else {
                        cpu.regs.r[rd] = rr(cpu, ra, pc).wrapping_add(
                            rr(cpu, rn, pc).wrapping_mul(rr(cpu, rm, pc)),
                        );
                    }
                    adv(cpu, pc, 4);
                    return 1;
                } else if sub == 1 {
                    if ra == 15 {
                        return fault(cpu, pc, op1, op2, 4);
                    }
                    cpu.regs.r[rd] = rr(cpu, ra, pc).wrapping_sub(
                        rr(cpu, rn, pc).wrapping_mul(rr(cpu, rm, pc)),
                    );
                    adv(cpu, pc, 4);
                    return 1;
                }
                return fault(cpu, pc, op1, op2, 4);
            }
            1 => {
                // SMLAXY (Ra!=15) / SMULXY (Ra==15). X/Y = bottom/top half
                // of Rn/Rm via op2[5]/op2[4] (0=B/low, 1=T/high).
                // UNDEFINED on Cortex-M3 (DSP extension): fault when disabled.
                if !cpu.dsp {
                    return fault(cpu, pc, op1, op2, 4);
                }
                let an = rr(cpu, rn, pc);
                let am = rr(cpu, rm, pc);
                let hn = if (o2 >> 5) & 1 == 1 {
                    (an >> 16) as i16 as i32
                } else {
                    (an & 0xFFFF) as i16 as i32
                };
                let hm = if (o2 >> 4) & 1 == 1 {
                    (am >> 16) as i16 as i32
                } else {
                    (am & 0xFFFF) as i16 as i32
                };
                let p = hn.wrapping_mul(hm);
                cpu.regs.r[rd] = if ra == 15 {
                    p as u32
                } else {
                    (rr(cpu, ra, pc) as i32).wrapping_add(p) as u32
                };
                adv(cpu, pc, 4);
                return 1;
            }
            2 => {
                // SMLAD (Ra!=15) / SMUAD (Ra==15), dual 16x16 + accumulate.
                // Only the plain form ([7:4]==0); X/SD variants fault loudly.
                // UNDEFINED on Cortex-M3 (DSP extension): fault when disabled.
                if !cpu.dsp {
                    return fault(cpu, pc, op1, op2, 4);
                }
                if o2 & 0xF0 != 0 {
                    return fault(cpu, pc, op1, op2, 4);
                }
                let an = rr(cpu, rn, pc);
                let am = rr(cpu, rm, pc);
                let lo = ((an & 0xFFFF) as i16 as i32)
                    .wrapping_mul((am & 0xFFFF) as i16 as i32);
                let hi = ((an >> 16) as i16 as i32)
                    .wrapping_mul((am >> 16) as i16 as i32);
                let p = lo.wrapping_add(hi);
                cpu.regs.r[rd] = if ra == 15 {
                    p as u32
                } else {
                    (rr(cpu, ra, pc) as i32).wrapping_add(p) as u32
                };
                adv(cpu, pc, 4);
                return 1;
            }
            3 => {
                // SMULW (Ra==15) / SMLAW: 32x16 -> top 32 bits.
                // Half via op2[4] (0=B/low, 1=T/high).
                // UNDEFINED on Cortex-M3 (DSP extension): fault when disabled.
                if !cpu.dsp {
                    return fault(cpu, pc, op1, op2, 4);
                }
                let an = rr(cpu, rn, pc) as i32 as i64;
                let am = rr(cpu, rm, pc);
                let half = if (o2 >> 4) & 1 == 1 {
                    (am >> 16) as i16 as i64
                } else {
                    (am & 0xFFFF) as i16 as i64
                };
                let p = (an.wrapping_mul(half) >> 16) as u32;
                cpu.regs.r[rd] = if ra == 15 {
                    p
                } else {
                    rr(cpu, ra, pc).wrapping_add(p)
                };
                adv(cpu, pc, 4);
                return 1;
            }
            8 => {
                // SMULL. Word form needs o2[7:4]==0 (differential fuzz:
                // nonzero selects DSP smlald etc., which the oracle
                // advances past without writing — we fault, triaged).
                if o2 & 0xF0 != 0 {
                    return fault(cpu, pc, op1, op2, 4);
                }
                if rn == 15 || rm == 15 {
                    return fault(cpu, pc, op1, op2, 4); // UNPREDICTABLE
                }
                // SMULL
                let a = rr(cpu, rn, pc) as i32 as i64;
                let b = rr(cpu, rm, pc) as i32 as i64;
                let p = a.wrapping_mul(b) as u64;
                cpu.regs.r[((o2 >> 12) & 0xF) as usize] = p as u32;
                cpu.regs.r[((o2 >> 8) & 0xF) as usize] = (p >> 32) as u32;
                adv(cpu, pc, 4);
                return 1;
            }
            9 => {
                // SDIV (1111_Rd_1111_Rm op2 shape) shares op 9 with SMLAL,
                // exactly like UDIV/UMLAL share op 11 (see arm 11 below).
                // Missing this ran every sdiv as multiply-accumulate (the
                // quotient came back as the dividend's high word, i.e. the
                // dividend itself — DOOM's (10*168/10) stayed 1680).
                // NOTE: plain (non-F:F) op-9 has no SMLAL encoding (SMLAL
                // lives at op 0xC) — fault it instead of accumulating.
                if o2 & 0xF0F0 == 0xF0F0 {
                    let b = rr(cpu, rm, pc) as i32;
                    cpu.regs.r[rd] = if b == 0 {
                        0
                    } else {
                        (rr(cpu, rn, pc) as i32).wrapping_div(b) as u32
                    };
                    // Rd==PC: raw write stands (differential fuzz: the
                    // oracle keeps the quotient without interworking or
                    // adv-clobber); anything else advances past.
                    if rd == 15 {
                        return 1;
                    }
                    adv(cpu, pc, 4);
                    return 1;
                }
                return fault(cpu, pc, op1, op2, 4);
            }
            10 => {
                // UMULL (word form needs o2[7:4]==0; see SMULL).
                if o2 & 0xF0 != 0 {
                    return fault(cpu, pc, op1, op2, 4);
                }
                if rn == 15 || rm == 15 {
                    return fault(cpu, pc, op1, op2, 4); // UNPREDICTABLE
                }
                // UMULL
                let p = (rr(cpu, rn, pc) as u64).wrapping_mul(rr(cpu, rm, pc) as u64);
                cpu.regs.r[((o2 >> 12) & 0xF) as usize] = p as u32;
                cpu.regs.r[((o2 >> 8) & 0xF) as usize] = (p >> 32) as u32;
                adv(cpu, pc, 4);
                return 1;
            }
            11 => {
                // UDIV (1111_Rd_1111_Rm). Plain (non-F:F) op-0xB has no
                // UMLAL encoding (that lives at op 0xE) — fault it instead
                // of accumulating, mirroring the arm-9 SDIV/SMLAL split.
                if o2 & 0xF0F0 != 0xF0F0 {
                    return fault(cpu, pc, op1, op2, 4);
                }
                let b = rr(cpu, rm, pc);
                cpu.regs.r[rd] = if b == 0 { 0 } else { rr(cpu, rn, pc) / b };
                // Rd==PC: raw write stands (see SDIV).
                if rd == 15 {
                    return 1;
                }
                adv(cpu, pc, 4);
                return 1;
            }
            13 => {
                // SMLSLD/X (dual-halfword DSP) is all that lives here:
                // UNDEFINED on Cortex-M3, fault either way.
                return fault(cpu, pc, op1, op2, 4);
            }
            12 => {
                // SMLAL word form needs o2[7:4]==0 (see SMULL).
                if o2 & 0xF0 != 0 {
                    return fault(cpu, pc, op1, op2, 4);
                }
                if rn == 15 || rm == 15 {
                    return fault(cpu, pc, op1, op2, 4); // UNPREDICTABLE
                }
                // SMLAL (signed 32x32 + 64 accumulate). Op 0xC is its only
                // home (the old arm-9 fallback accepted invalid op-9 shapes
                // as SMLAL instead).
                let a = rr(cpu, rn, pc) as i32 as i64;
                let b = rr(cpu, rm, pc) as i32 as i64;
                let lo = ((o2 >> 12) & 0xF) as usize;
                let hi = ((o2 >> 8) & 0xF) as usize;
                let acc = ((cpu.regs.r[hi] as u64) << 32) | cpu.regs.r[lo] as u64;
                let p = (acc as i64).wrapping_add(a.wrapping_mul(b)) as u64;
                cpu.regs.r[lo] = p as u32;
                cpu.regs.r[hi] = (p >> 32) as u32;
                adv(cpu, pc, 4);
                return 1;
            }
            14 => {
                // UMLAL word form needs o2[7:4]==0 (see SMULL).
                if o2 & 0xF0 != 0 {
                    return fault(cpu, pc, op1, op2, 4);
                }
                if rn == 15 || rm == 15 {
                    return fault(cpu, pc, op1, op2, 4); // UNPREDICTABLE
                }
                // UMLAL (unsigned 32x32 + 64 accumulate). Op 0xE is its only
                // home (UDIV lives at op 0xB). Missing this faulted the
                // soft-float __muldf3 helper, killing CoreMark result prints.
                let lo = ((o2 >> 12) & 0xF) as usize;
                let hi = ((o2 >> 8) & 0xF) as usize;
                let acc = ((cpu.regs.r[hi] as u64) << 32) | cpu.regs.r[lo] as u64;
                let p = acc.wrapping_add(
                    (rr(cpu, rn, pc) as u64).wrapping_mul(rr(cpu, rm, pc) as u64),
                );
                cpu.regs.r[lo] = p as u32;
                cpu.regs.r[hi] = (p >> 32) as u32;
                adv(cpu, pc, 4);
                return 1;
            }
            _ => return fault(cpu, pc, op1, op2, 4),
        }
        // ---- EA/EB: shifted-register data processing ----
    } else if o1 & 0xFF00 == 0xEA00 || o1 & 0xFF00 == 0xEB00 {
        // hw2[15] is reserved 0 here (the shift amount is imm3:imm2 =
        // o2[14:12]:o2[7:6]); o2[15]==1 is UNPREDICTABLE — the oracle
        // faults INSN_INVALID while we executed garbage-agreeing values
        // (differential fuzz: adc/sbc/rsb/and with 0x8xxx op2).
        if o2 & 0x8000 != 0 {
            return fault(cpu, pc, op1, op2, 4);
        }
        let b8 = (o1 >> 8) & 1;
        let b7 = (o1 >> 7) & 1;
        let b6 = (o1 >> 6) & 1;
        let b5 = (o1 >> 5) & 1;
        let s = (o1 & 0x10) != 0;
        let op = match (b8 << 3) | (b7 << 2) | (b6 << 1) | b5 {
            0b0010 => 2,  // ORR
            0b1000 => 8,  // ADD
            0b1010 => 10, // ADC
            0b1011 => 11, // SBC
            0b1101 => 13, // SUB
            0b1110 => 14, // RSB
            0b0000 => 0,  // AND
            0b0001 => 1,  // BIC
            0b0011 => 3,  // MVN/ORN
            0b0100 => 4,  // EOR
            _ => return fault(cpu, pc, op1, op2, 4),
        };
        let rn = (o1 & 0xF) as usize;
        let rd = ((o2 >> 8) & 0xF) as usize;
        let rm = (o2 & 0xF) as usize;
        let typ = (o2 >> 4) & 3;
        let amt = (((o2 >> 12) & 7) << 2) | ((o2 >> 6) & 3);
        let ci = carry(cpu);
        let (sv, co) = shift_op(rr(cpu, rm, pc), typ, amt, ci);
        let a = rr(cpu, rn, pc);
        if op == 2 && rn == 15 {
            // MOV (register)
            if rd == 15 {
                if s {
                    return fault(cpu, pc, op1, op2, 4);
                }
                return branch(cpu, sys, mem, sv, pc, op1, op2, 4);
            }
            cpu.regs.r[rd] = sv;
            if s {
                nz(cpu, sv);
                if !cpu.it_suppress {
                    cpu.regs.xpsr = (cpu.regs.xpsr & !0x20000000) | (co << 29);
                }
            }
            adv(cpu, pc, 4);
            return 1;
        }
        if op == 3 && rn == 15 {
            if rd == 15 {
                return fault(cpu, pc, op1, op2, 4);
            }
            cpu.regs.r[rd] = !sv;
            if s {
                nzc(cpu, !sv, co);
            }
            adv(cpu, pc, 4);
            return 1;
        }
        let test = s && rd == 15;
        match alu_op(cpu, op, s, a, sv, ci, co, test) {
            Some(r) => {
                if rd == 15 {
                    return branch(cpu, sys, mem, r, pc, op1, op2, 4);
                }
                cpu.regs.r[rd] = r;
                adv(cpu, pc, 4);
                1
            }
            None => {
                if test {
                    adv(cpu, pc, 4);
                    1
                } else {
                    fault(cpu, pc, op1, op2, 4)
                }
            }
        }
        // ---- E8/E9: LDM/STM, STRD/LDRD, LDREX/STREX, TBB/TBH ----
    } else if (o1 & 0xF000) == 0xE000 && o1 < 0xEC00 {
        let rn = (o1 & 0xF) as usize;
        // TBB / TBH: E8D0|Rn + F000/F010 op2. The table index is the
        // VALUE in Rm (rr), not the register number — using the number
        // dispatched every switch on Rm's encoding (DOOM always played
        // demo2: tbb [pc,r3] used table[3] for any demosequence).
        // Table base is pc+4 with NO word masking: a halfword-aligned TBB
        // (like D_Display's at 0x1CA6) is followed immediately by its table;
        // masking back to 0x1CA8 reads entries shifted by 2 (case 3 went to
        // the status-bar tail instead of D_PageDrawer, so no title drew).
        if (o1 & 0x0FF0) == 0x08D0 && (o2 & 0xFFF0) == 0xF000 {
            let tab = if rn == 15 { pc.wrapping_add(4) } else { rr(cpu, rn, pc) };
            let idx = rr(cpu, rm_of(o2) as usize, pc);
            let t = pc.wrapping_add(4).wrapping_add((mem.read8(tab.wrapping_add(idx)) as u32) * 2);
            return branch(cpu, sys, mem, t | 1, pc, op1, op2, 4);
        }
        if (o1 & 0x0FF0) == 0x08D0 && (o2 & 0xFFF0) == 0xF010 {
            let tab = if rn == 15 { pc.wrapping_add(4) } else { rr(cpu, rn, pc) };
            let idx = rr(cpu, rm_of(o2) as usize, pc);
            let t = pc
                .wrapping_add(4)
                .wrapping_add((mem.read16(tab.wrapping_add(idx.wrapping_mul(2))) as u32) * 2);
            return branch(cpu, sys, mem, t | 1, pc, op1, op2, 4);
        }
        // LDREXB/H (E8D0|Rn; size in o2[4], Rt in o2[15:12]). Shapes
        // verified against the oracle (E8D2:4F4F loads the byte;
        // o2[11:8]/[7:5]/[3:0] are fixed 1111/010/1111). Reservation at
        // the exact address (word forms use addr&!3; mixed-size pairs
        // fail, matching the oracle). Previously these fell into the
        // STRD/LDRD block below (values agreed, but wrongly).
        if (o1 & 0x0FF0) == 0x08D0 && (o2 & 0x0FEF) == 0x0F4F {
            let rt = ((o2 >> 12) & 0xF) as usize;
            let addr = rr(cpu, rn, pc);
            cpu.exclusive = Some(addr);
            cpu.regs.r[rt] = if (o2 >> 4) & 1 == 1 {
                mem.read16(addr) as u32
            } else {
                mem.read8(addr) as u32
            };
            adv(cpu, pc, 4);
            return 1;
        }
        // STREXB/H (E8C0|Rn; Rd=status in o2[11:8], Rt=data in o2[15:12]).
        // The oracle faults these unconditionally (byte-exclusive not
        // implemented there), so differential pairs resample; our pair
        // logic is probe-tested (ldrex_strex_forms).
        if (o1 & 0x0FF0) == 0x08C0 && (o2 & 0x00EF) == 0x004F {
            let rt = ((o2 >> 12) & 0xF) as usize;
            let rdv = ((o2 >> 8) & 0xF) as usize;
            let addr = rr(cpu, rn, pc);
            if cpu.exclusive == Some(addr) {
                if (o2 >> 4) & 1 == 1 {
                    mem.write16(addr, rr(cpu, rt, pc) as u16);
                } else {
                    mem.write8(addr, rr(cpu, rt, pc) as u8);
                }
                cpu.regs.r[rdv] = 0;
            } else {
                cpu.regs.r[rdv] = 1;
            }
            cpu.exclusive = None; // STREX always clears, pass or fail
            adv(cpu, pc, 4);
            return 1;
        }
        // LDREX / STREX (E8 + nibble 4/5, word form). Single global
        // reservation: exact on a single core (see Cpu::exclusive).
        if (o1 & 0x0FF0) == 0x0840 {
            let rt = ((o2 >> 12) & 0xF) as usize;
            let rdv = ((o2 >> 8) & 0xF) as usize;
            let addr = rr(cpu, rn, pc).wrapping_add(o2 & 0xFF);
            if cpu.exclusive == Some(addr & !3) {
                mem.write32(addr, rr(cpu, rt, pc));
                cpu.regs.r[rdv] = 0;
            } else {
                cpu.regs.r[rdv] = 1;
            }
            cpu.exclusive = None; // STREX always clears, pass or fail
            adv(cpu, pc, 4);
            return 1;
        }
        if (o1 & 0x0FF0) == 0x0850 {
            if o2 & 0x0F00 != 0x0F00 {
                return fault(cpu, pc, op1, op2, 4);
            }
            let rt = ((o2 >> 12) & 0xF) as usize;
            let addr = rr(cpu, rn, pc).wrapping_add(o2 & 0xFF);
            cpu.exclusive = Some(addr & !3);
            cpu.regs.r[rt] = mem.read32(addr);
            adv(cpu, pc, 4);
            return 1;
        }
        // LDM / STM: P=o1[8] (pre/post), U=o1[7] (up/down), W=o1[5], L=o1[4].
        // IA=P0U1, IB=P1U1, DA=P0U0, DB=P1U0 (the old code keyed everything
        // off P alone, swapping IB/DB and DA/IA semantics).
        if (o1 & 0x0E40) == 0x0800 {
            let p = o1 & 0x0100 != 0;
            let u = o1 & 0x0080 != 0;
            let w = o1 & 0x0020 != 0;
            let l = o1 & 0x0010 != 0;
            // P==U (IB/DA shapes) is the SRS/RFE space (Rn==SP selects the
            // banked form, which needs banked stacks we don't model):
            // UNDEFINED for Rn!=SP — the oracle (INSN_INVALID) and
            // Capstone both reject, so fault loudly instead of running
            // SRS-space as LDM.
            if p == u {
                return fault(cpu, pc, op1, op2, 4);
            }
            let list = o2;
            let n = list.count_ones() as u32;
            if n == 0 {
                return fault(cpu, pc, op1, op2, 4);
            }
            // Writeback with Rn itself in a LOAD list is UNPREDICTABLE
            // (differential fuzz: the oracle faults INSN_INVALID while a
            // late check let the loaded values win) — fault BEFORE any
            // state change. (Stores with Rn in the list keep the original
            // value, which is silicon-plausible.)
            if w && l && (list >> rn) & 1 == 1 {
                return fault(cpu, pc, op1, op2, 4);
            }
            let mut a = cpu.regs.r[rn];
            if p && u {
                a = a.wrapping_add(4); // IB: first transfer at Rn+4
            } else if !u {
                // DB: first transfer 4n below Rn (DA faulted above as
                // SRS-space, so !u here is always DB).
                a = a.wrapping_sub(n * 4);
            }
            let mut newpc: Option<u32> = None;
            for i in 0..16 {
                if (list >> i) & 1 == 1 {
                    if l {
                        let v = mem.read32(a);
                        if i == 15 {
                            newpc = Some(v);
                        } else {
                            // (If Rn itself is in a writeback list the
                            // loaded value wins; firmware never does this.)
                            cpu.regs.r[i as usize] = v;
                        }
                    } else {
                        let v = if i == 15 { (pc + 4) & !3 } else { cpu.regs.r[i as usize] };
                        mem.write32(a, v);
                    }
                    a += 4;
                }
            }
            // Writeback: incrementing modes (IA/IB) end at the final
            // address; decrementing modes (DA/DB) write back the START
            // address — for loads AND stores (differential fuzz: LDMDB
            // wrote back base instead of base-4n). Rn-in-list loads
            // faulted above, so no suppression case remains here.
            if w {
                cpu.regs.r[rn] = if !u {
                    a.wrapping_sub(n * 4)
                } else {
                    a
                };
            }
            if let Some(t) = newpc {
                return branch(cpu, sys, mem, t, pc, op1, op2, 4);
            }
            adv(cpu, pc, 4);
            return 1;
        }
        // STRD / LDRD: same bits[11:9]==100 as LDM/STM but bit6==1
        // (complementary patterns 0x0800 vs 0x0840; GAS-verified).
        if (o1 & 0x0E40) == 0x0840 {
            let p = o1 & 0x0100 != 0; // E9 offset/pre-indexed; E8 post
            let u = o1 & 0x0080 != 0;
            let w = o1 & 0x0020 != 0;
            let l = o1 & 0x0010 != 0;
            // GAS-verified: first reg Rt = op2[15:12], second Rt2 = op2[11:8].
            let rt = ((o2 >> 12) & 0xF) as usize;
            let rt2 = ((o2 >> 8) & 0xF) as usize;
            let off = (o2 & 0xFF) * 4;
            let base = rr(cpu, rn, pc);
            // Post-indexed (P=0): transfer at base, then write base+/-off
            // back (writeback is implicit, W ignored).
            let addr = if p {
                if u { base.wrapping_add(off) } else { base.wrapping_sub(off) }
            } else {
                base
            };
            if l {
                let v0 = mem.read32(addr);
                let v1 = mem.read32(addr.wrapping_add(4));
                cpu.regs.r[rt] = v0;
                cpu.regs.r[rt2] = v1;
                // LDRD into PC interworks like LDR-pc (differential fuzz:
                // we adv-clobbered the loaded PC while the oracle branched).
                // Falls through to the shared writeback first when the
                // destination isn't PC.
                if rt == 15 || rt2 == 15 {
                    if w || !p {
                        cpu.regs.r[rn] = if p {
                            addr
                        } else if u {
                            base.wrapping_add(off)
                        } else {
                            base.wrapping_sub(off)
                        };
                    }
                    return branch(cpu, sys, mem, cpu.regs.r[15], pc, op1, op2, 4);
                }
            } else {
                mem.write32(addr, rr(cpu, rt, pc));
                mem.write32(addr.wrapping_add(4), rr(cpu, rt2, pc));
            }
            if w || !p {
                cpu.regs.r[rn] = if p {
                    addr
                } else if u {
                    base.wrapping_add(off)
                } else {
                    base.wrapping_sub(off)
                };
                // Writeback into PC stands as the final PC (no adv past
                // it): differential fuzz shows the oracle keeping the
                // written-back value (STRD-post-indexed with Rn==PC).
                if rn == 15 {
                    return 1;
                }
            }
            adv(cpu, pc, 4);
            return 1;
        }
        return fault(cpu, pc, op1, op2, 4);
    } else {
        fault(cpu, pc, op1, op2, 4)
    }
}

#[inline]
fn rm_of(o2: u32) -> u32 {
    o2 & 0xF
}

