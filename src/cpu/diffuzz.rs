//! Differential-execution worker for tests/fuzz_diff.py (Unicorn oracle).
//!
//! Protocol v2 (all plain text, no new dependencies):
//! - reads cases from the path in env FUZZ_CASES, one per line:
//!     `ncode h1 h2 ... r0..r12 sp lr xpsr itc itm itn itx steps`
//!   ncode = number of code halfwords (1, 2 or 4); regs hex;
//!   itc/it m/itn/itx = IT-block state (cond, mask, n, idx), 0 when inactive.
//! - writes one result line per case to the path in env FUZZ_OUT:
//!     `R0..R12 SP LR XPSR ITC ITM ITN ITX MEMHASH FAULT`
//!   MEMHASH = FNV-1a/64 over flash+RAM after execution; FAULT = 1 when the
//!   core faulted instead of executing.
//! - exits 0 silently when FUZZ_CASES is missing (plain `cargo test` stays
//!   green without the fuzzer driver).
//!
//! The sterile image is deterministic: flash/RAM filled with an
//! address-derived pattern (odd words, so valid indirect branches land in
//! Thumb state), SP region preloaded likewise.

use super::{
    mem::{FlatMemory, Memory},
    Cpu,
};
use crate::{init, sys};

fn parse_hex(s: &str) -> u32 {
    u32::from_str_radix(s, 16).unwrap_or(0)
}

fn fill_pattern(mem: &mut FlatMemory) {
    let mut fb = vec![0u8; 0x10000];
    let mut rb = vec![0u8; 0x10000];
    for (i, b) in fb.iter_mut().enumerate() {
        *b = ((0x0800_0000u32.wrapping_add(i as u32)) ^ ((i as u32) >> 8)) as u8 | 1;
    }
    for (i, b) in rb.iter_mut().enumerate() {
        *b = ((0x2000_0000u32.wrapping_add(i as u32)) ^ ((i as u32) >> 8)) as u8 | 1;
    }
    mem.load(&fb, 0x0800_0000);
    mem.load(&rb, 0x2000_0000);
}

fn mem_hash(mem: &FlatMemory) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in mem.flash.iter().chain(mem.ram.iter()) {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

#[test]
fn diffuzz_exec() {
    let cases_path = match std::env::var("FUZZ_CASES") {
        Ok(p) => p,
        Err(_) => return, // no driver: stay green
    };
    let out_path = std::env::var("FUZZ_OUT").unwrap();
    let text = std::fs::read_to_string(&cases_path).unwrap();
    let _held = crate::test_util::lock();
    init();
    let sys = sys();
    // Fusion OFF for the oracle comparison: cases budget steps assuming one
    // retired instruction per step, and the sterile pattern padding happens
    // to form fusable shapes (e.g. 0x2323 is MOV-imm) — a fused pair would
    // retire 2 ops in one step and outrun the oracle's exact stop count.
    // Fusion equivalence is proven separately by the fused_*_matches_legacy
    // differential suites (fused vs fusion_off, full-state compare), so the
    // oracle gate stays valid as legacy-vs-silicon-truth (transitively:
    // fused == legacy == oracle). Same rationale as run_snippet in
    // isa_tests.rs.
    super::thumb::fusion_off(true);
    let mut out = String::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let f: Vec<&str> = line.split_whitespace().collect();
        let ncode: usize = f[0].parse().unwrap_or(0);
        if ncode == 0 || ncode > 24 || f.len() < 1 + ncode + 21 {
            continue; // malformed: skip, driver counts lines
        }
        let mut code: Vec<u8> = Vec::with_capacity(ncode * 2);
        for k in 0..ncode {
            let h = parse_hex(f[1 + k]) as u16;
            code.push((h & 0xFF) as u8);
            code.push((h >> 8) as u8);
        }
        let r = &f[1 + ncode..];
        let mut cpu = Cpu::new(0x2000FFF0, 0x20002001);
        for (i, v) in r[0..13].iter().enumerate() {
            cpu.regs.r[i] = parse_hex(v);
        }
        cpu.regs.r[13] = parse_hex(r[13]);
        cpu.regs.r[14] = parse_hex(r[14]);
        cpu.regs.xpsr = parse_hex(r[15]);
        cpu.it_cond = parse_hex(r[16]) as u8;
        cpu.it_mask = parse_hex(r[17]) as u8;
        cpu.it_n = parse_hex(r[18]) as u8;
        cpu.it_idx = parse_hex(r[19]) as u8;
        cpu.dsp = false;
        cpu.deliver_irqs = false;
        let steps: u32 = r[20].parse().unwrap_or(1);
        let mut mem = FlatMemory::new(0x10000, 0x10000);
        fill_pattern(&mut mem);
        // Install the snippet at PC.
        let pc = (cpu.regs.r[15] & !1) as usize;
        for (i, b) in code.iter().enumerate() {
            mem.write8_raw((pc as u32).wrapping_add(i as u32), *b);
        }
        crate::set_intr_masks(0, 0);
        cpu.run(sys, &mut mem, steps);
        let faulted = if cpu.fault.is_some() { 1 } else { 0 };
        let mut cols: Vec<String> = cpu.regs.r[0..16]
            .iter()
            .map(|r| format!("{r:08x}"))
            .collect();
        cols.push(format!("{:08x}", cpu.regs.xpsr));
        cols.push(format!(
            "{:02x} {:02x} {:02x} {:02x}",
            cpu.it_cond, cpu.it_mask, cpu.it_n, cpu.it_idx
        ));
        cols.push(format!("{:016x}", mem_hash(&mem)));
        cols.push(format!("{faulted}"));
        out.push_str(&cols.join(" "));
        out.push('\n');
    }
    super::thumb::fusion_off(false);
    std::fs::write(&out_path, out).unwrap();
}
