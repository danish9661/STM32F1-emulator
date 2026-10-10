//! Decoder census: execute every 16-bit opcode (and a structured sample of
//! the 32-bit space) in a sterile CPU and record defined-vs-fault. The dump
//! (`/tmp/census16_ours.json`, `/tmp/census32_ours.json`) is diffed against
//! Capstone (M-class Thumb) by `tests/census_16.py` — any encoding Capstone
//! accepts but we fault on is a decoder gap; anything we execute but
//! Capstone rejects is an over-accept. Known-trapping encodings (SVC/BKPT/UDF)
//! fault by design and are bucketed as defined on both sides.
//!
//! Sterile state per opcode: all regs odd (BX/BLX/POP-PC take the Thumb path
//! instead of faulting on ARM-state entry), SP in RAM, privileged thread
//! mode, no IT block, delivery off (SVC must fault, not take).

use super::{
    mem::FlatMemory,
    thumb, Cpu,
};
use crate::{init, sys};

fn sterile_cpu() -> Cpu {
    let mut cpu = Cpu::new(0x200000C0, 0x08000001);
    // r0-r12 and lr point 0x81 into RAM with odd addresses: decrement
    // forms stay mapped, values are odd so BX and PC-loads take the Thumb
    // path. SP is even RAM (bx sp then faults exactly like silicon).
    for (i, r) in cpu.regs.r.iter_mut().enumerate() {
        *r = if i == 13 { 0x2000_00C0 } else { 0x2000_0081 };
    }
    // SP 64B below the top of the 0x100-byte RAM: even the widest POP/LDM
    // (9 words) reads preloaded odd words (SP one-past-end or short reads
    // return 0 and fault BX-to-ARM spuriously).
    cpu.regs.r[13] = 0x2000_00C0;
    cpu.dsp = false; // M3 has no DSP extension: those encodings must fault
    cpu.deliver_irqs = false;
    cpu
}

/// Sterile memory where every word is odd: indirect branches (POP-PC, BX,
/// LDR-PC, TBB/TBH, literal loads) land on Thumb addresses and succeed, so
/// a fault means the DECODER rejected the encoding — not a bad target.
fn sterile_mem() -> FlatMemory {
    let mut mem = FlatMemory::new(0x100, 0x100);
    mem.load(&[0x01; 0x100], 0x0800_0000);
    mem.load(&[0x01; 0x100], 0x2000_0000);
    mem
}

/// 0 = executes, 1 = known trap (SVC/BKPT/UDF), 2 = fault (undefined/gap).
fn classify16(op: u16, sys: &crate::system::WasmSystem) -> u8 {
    let mut cpu = sterile_cpu();
    let mut mem = sterile_mem();
    let n = thumb::exec16(&mut cpu, sys, &mut mem, op, 0x0800_0001, 0);
    if n != 0 {
        return 0;
    }
    match op {
        0xBE00..=0xBEFF | 0xDF00..=0xDFFF | 0xDE00..=0xDEFF => 1,
        _ => 2,
    }
}

#[test]
fn census_dump_16() {
    let _held = crate::test_util::lock();
    init();
    let sys = sys();
    let mut out = String::with_capacity(65536);
    for op in 0..=0xFFFFu32 {
        // 32-bit prefixes belong to the census-32 job (len routes them).
        if op & 0xF800 >= 0xE800 {
            out.push('3');
            continue;
        }
        out.push(match classify16(op as u16, sys) {
            0 => '0',
            1 => '1',
            _ => '2',
        });
    }
    std::fs::write("/tmp/census16_ours.json", out).unwrap();
}

/// Structured 32-bit sample: every legal first halfword x 256 evenly
/// sampled second halfwords. Same 0/1/2 coding ('3' unused here).
#[test]
fn census_dump_32() {
    let _held = crate::test_util::lock();
    init();
    let sys = sys();
    let mut out = String::new();
    let mut first = 0xE800u32;
    while first <= 0xFFFF {
        let mut j = 0u32;
        while j < 256 {
            let op2 = (j * 257) & 0xFFFF;
            let mut cpu = sterile_cpu();
            let mut mem = sterile_mem();
            let n = thumb::exec32(&mut cpu, sys, &mut mem, first as u16, op2 as u16, 0x0800_0001);
            out.push(if n != 0 { '0' } else { '2' });
            j += 1;
        }
        out.push('\n');
        first += 1;
    }
    std::fs::write("/tmp/census32_ours.json", out).unwrap();
}
