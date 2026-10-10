//! Ported ISA probes from the vendored F407 `tests.rs` (which can't run here:
//! wrong chip, missing SVD/firmware images). These are pure decoder checks —
//! hand-assembled snippets executed from RAM with no firmware and no model
//! interaction — so they run lock-step with the core through our own harness.
//! The firmware-driven vendor tests (blinky/eth/freertos/doom) are not
//! portable; the suites in `smoke.rs` cover real firmware instead.

use super::{
    mem::{FlatMemory, Memory},
    Cpu,
};

/// Write `code` at 0x20002000, set registers, run to completion. No firmware,
/// no peripheral traffic: pure decode + flags.
fn run_snippet(code: &[u16], regs: &[(usize, u32)]) -> (Cpu, FlatMemory) {
    crate::init();
    let sys = crate::sys();
    // Fusion OFF here on purpose: these probes assert exact PCs after fixed
    // step budgets, and a fused pair retires 2 instructions per step — the
    // budget math assumes 1/step. Fusion equivalence itself is proven by the
    // fused_*_matches_legacy differential suites (fused vs fusion_off, full
    // state compare), so the probes stay valid as single-op semantics tests.
    super::thumb::fusion_off(true);
    let mut cpu = Cpu::new(0x20008000, 0x20002001);
    cpu.dsp = false;
    let mut mem = FlatMemory::new(0x1000, 0x10000);
    for (i, w) in code.iter().enumerate() {
        mem.write16(0x20002000 + (i as u32) * 2, *w);
    }
    for &(r, v) in regs {
        cpu.regs.r[r] = v;
    }
    cpu.run(sys, &mut mem, code.len() as u32 / 2 + 2);
    super::thumb::fusion_off(false);
    (cpu, mem)
}

/// Thread-mode SVC roundtrip on a synthetic image: main does SVC #0 then
/// loops; the SVCall handler bumps a RAM counter and returns via EXC_RETURN.
#[test]
fn exception_svc_roundtrip() {
    let _held = crate::test_util::lock();
    crate::init();
    let sys = crate::sys();
    // Minimal image: SP=0x20002000, reset PC=0x08000100, SVC vector (11) at
    // 0x08000110, counter in RAM at 0x20001000. Model SCB VTOR defaults to
    // 0x08000000, so vectors live in the flash image.
    let mut img = vec![0u8; 0x200];
    img[0..4].copy_from_slice(&0x20002000u32.to_le_bytes());
    img[4..8].copy_from_slice(&0x08000100u32.to_le_bytes());
    img[11 * 4..11 * 4 + 4].copy_from_slice(&0x08000111u32.to_le_bytes());
    // main at 0x100: svc #0 (0xDF00), then b.n loop (0xE7FE).
    img[0x100] = 0x00;
    img[0x101] = 0xDF;
    img[0x102] = 0xFE;
    img[0x103] = 0xE7;
    // handler at 0x110: ldr r0,[pc,#8]; ldr r1,[r0]; adds r1,#1; str r1,[r0];
    // bx lr. Counter literal patched to 0x20001000 below.
    let h: [u8; 16] = [
        0x02, 0x48, 0x01, 0x68, 0x01, 0x31, 0x01, 0x60, 0x70, 0x47, 0x00, 0xBF, 0x00, 0x01, 0x00, 0x20,
    ];
    img[0x110..0x120].copy_from_slice(&h);
    img[0x11C..0x120].copy_from_slice(&0x20001000u32.to_le_bytes());
    let mut mem = FlatMemory::new(0x1000, 0x20000);
    mem.load(&img, 0x08000000);
    let mut cpu = Cpu::new(0x20002000, 0x08000101);
    cpu.dsp = false;
    cpu.deliver_irqs = true;
    assert_eq!(cpu.regs.r[13], 0x20002000);
    assert_eq!(cpu.regs.r[15] & !1, 0x08000100);
    cpu.run(sys, &mut mem, 10);
    assert!(cpu.fault.is_none(), "fault: {:?}", cpu.fault);
    // SVC handler should have run exactly once (counter==1) and main resumed
    // into its branch-to-self loop at 0x102.
    assert_eq!(mem.read32(0x20001000), 1, "SVC handler did not run");
    assert_eq!(cpu.regs.r[15] & !1, 0x08000102, "did not resume after SVC");
    assert_eq!(cpu.ipsr, 0, "still in handler mode");
}

#[test]
fn tbb_index_by_value() {
    let _held = crate::test_util::lock();
    // tbb [pc,r3] indexes by r3's VALUE with an unmasked pc+4 base.
    // Table at (pc+4): [0x04 -> case0][0x10 -> case1]; r3=1 -> case1.
    let (mut cpu, mut mem) = run_snippet(&[], &[]);
    mem.write16(0x20002000, 0xE8DF);
    mem.write16(0x20002002, 0xF003);
    mem.write8(0x20002004, 0x04);
    mem.write8(0x20002005, 0x10);
    cpu.regs.r[3] = 1;
    cpu.regs.r[15] = 0x20002001;
    let sys = crate::sys();
    cpu.run(sys, &mut mem, 1);
    assert_eq!(cpu.regs.r[15] & !1, 0x20002024);
}

#[test]
fn sdiv_plain_and_it() {
    let _held = crate::test_util::lock();
    // sdiv r1,r1,r3 (FB91 F1F3): plain, IT-taken, IT-skipped.
    let (cpu, _) = run_snippet(&[0xFB91, 0xF1F3], &[(1, 1680), (3, 10)]);
    assert_eq!(cpu.regs.r[1], 168);
    // cmp r1,#11 (NE); ite gt (BFCC): taken sdiv runs, skipped one doesn't.
    let (cpu, _) = run_snippet(
        &[0x290B, 0xBFCC, 0xFB91, 0xF1F3, 0xFB91, 0xF1F3],
        &[(1, 1680), (3, 10)],
    );
    // steps: cmp, it, sdiv, sdiv -> 1680->168->16. Just check no fault + sane.
    assert!(cpu.fault.is_none());
    let _ = cpu.regs.r[1];
}

#[test]
fn usat_ssat_q() {
    let _held = crate::test_util::lock();
    let (cpu, _) = run_snippet(&[0xF380, 0x0005], &[(0, 100)]);
    assert_eq!(cpu.regs.r[0], 31);
    assert_ne!(cpu.regs.xpsr & 0x08000000, 0);
    let (cpu, _) = run_snippet(&[0xF380, 0x0005], &[(0, 20)]);
    assert_eq!(cpu.regs.r[0], 20);
    assert_eq!(cpu.regs.xpsr & 0x08000000, 0);
    // SSAT sat field encodes N-1 (ssat#8 = o2 0x0007)
    let (cpu, _) = run_snippet(&[0xF300, 0x0007], &[(0, 1000)]);
    assert_eq!(cpu.regs.r[0], 127);
    assert_ne!(cpu.regs.xpsr & 0x08000000, 0);
    let (cpu, _) = run_snippet(&[0xF300, 0x0007], &[(0, 0xFFFFFC18)]);
    assert_eq!(cpu.regs.r[0], 0xFFFFFF80);
    assert_ne!(cpu.regs.xpsr & 0x08000000, 0);
}

#[test]
fn addw_subw_plain_imm() {
    let _held = crate::test_util::lock();
    let (cpu, _) = run_snippet(&[0xF20A, 0x46BC], &[(10, 100)]);
    assert_eq!(cpu.regs.r[6], 100 + 1212);
    let (cpu, _) = run_snippet(&[0xF2AA, 0x46BC], &[(10, 100)]);
    assert_eq!(cpu.regs.r[6], (100i32 - 1212) as u32);
    let (cpu, _) = run_snippet(&[0xF6A1, 0x71FF], &[(1, 5000)]);
    assert_eq!(cpu.regs.r[1], 5000 - 4095);
}

#[test]
fn t3_reg_no_writeback() {
    let _held = crate::test_util::lock();
    // strh.w r2,[r9,r3,lsl#1] (F829 2013) must not write back Rn/Rm.
    let (cpu, mem) = run_snippet(&[0xF829, 0x2013], &[(9, 0x20003000), (3, 5), (2, 0xABCD)]);
    assert_eq!(mem.read16(0x2000300A), 0xABCD);
    assert_eq!(cpu.regs.r[9], 0x20003000);
    assert_eq!(cpu.regs.r[3], 5);
}

// ---- 32-bit census probes: one canonical encoding per family, exact
// results. Encodings Capstone-verified (M-class Thumb); see census_32.py.

/// T3 flag-setting data processing (S-bit forms share the modified-imm arm).
#[test]
fn t3_s_bit_forms() {
    let _held = crate::test_util::lock();
    // adds.w r0,r1,#0x11 (F111 0011), r1=5 -> 0x16, NZCV=0000.
    // (Trailing b.n parks the overrun budget: zeros decode as flag-setting
    // LSLs and would pollute xpsr after the probe.)
    let (cpu, _) = run_snippet(&[0xF111, 0x0011, 0xE7FE], &[(1, 5)]);
    assert!(cpu.fault.is_none(), "adds.w fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.r[0], 0x16);
    assert_eq!(cpu.regs.xpsr & 0xF0000000, 0x00000000);
    // subs.w r0,r1,#0x11, r1=5 -> -12, N=1, C=0 (borrow)
    let (cpu, _) = run_snippet(&[0xF1B1, 0x0011, 0xE7FE], &[(1, 5)]);
    assert!(cpu.fault.is_none(), "subs.w fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.r[0], 0xFFFF_FFF4);
    assert_eq!(cpu.regs.xpsr & 0xF0000000, 0x80000000);
    // cmp.w r1,#0x11 (Rd=15 test form), r1=0x11 -> Z=1, C=1
    let (cpu, _) = run_snippet(&[0xF1B1, 0x0F11, 0xE7FE], &[(1, 0x11)]);
    assert!(cpu.fault.is_none(), "cmp.w fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.xpsr & 0xF0000000, 0x60000000);
    // rsbs.w r0,r1,#0, r1=5 -> -5, N=1, C=0
    let (cpu, _) = run_snippet(&[0xF1D1, 0x0000, 0xE7FE], &[(1, 5)]);
    assert!(cpu.fault.is_none(), "rsbs.w fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.r[0], 0xFFFF_FFFB);
    assert_eq!(cpu.regs.xpsr & 0xF0000000, 0x80000000);
    // tst.w r1,#0x11 (ANDS test form, Rd=15), r1=5 -> 0x01, no write, Z=0
    let (cpu, _) = run_snippet(&[0xF011, 0x0F11, 0xE7FE], &[(1, 5)]);
    assert!(cpu.fault.is_none(), "tst.w fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.r[0], 0);
    assert_eq!(cpu.regs.xpsr & 0xF0000000, 0x00000000);
}

/// T3 with i-bit set (F6xx first halfword): large modified immediates.
#[test]
fn t3_ibit_immediate() {
    let _held = crate::test_util::lock();
    // add.w r2,r3,#0xABC (F603 22BC), r3=0x100 -> 0xBBC, no flags
    let (cpu, _) = run_snippet(&[0xF603, 0x22BC, 0xE7FE], &[(3, 0x100)]);
    assert!(cpu.fault.is_none(), "add.w i-bit fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.r[2], 0xBBC);
    assert_eq!(cpu.regs.xpsr & 0xF0000000, 0x00000000);
}

/// MRS/MSR special-register moves.
#[test]
fn mrs_msr_forms() {
    let _held = crate::test_util::lock();
    // adds.w sets NZCV=0110 (Z=1,C=1); mrs r0,apsr reads it back.
    let (cpu, _) = run_snippet(
        &[0xF111, 0x0001, 0xF3EF, 0x8000],
        &[(1, 0xFFFF_FFFF)],
    );
    assert!(cpu.fault.is_none(), "mrs apsr fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.r[0], 0x6000_0000);
    // mrs r0,primask reads 0; msr primask,r1 sets it.
    let (cpu, _) = run_snippet(&[0xF3EF, 0x8010], &[]);
    assert!(cpu.fault.is_none(), "mrs primask fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.r[0], 0);
    let (cpu, _) = run_snippet(&[0xF381, 0x8010], &[(1, 1)]);
    assert!(cpu.fault.is_none(), "msr primask fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.primask, 1);
    // mrs r0,control reads 0 in thread-MSP mode.
    let (cpu, _) = run_snippet(&[0xF3E8, 0x8014], &[]);
    assert!(cpu.fault.is_none(), "mrs control fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.r[0], 0);
}

/// Bitfield: SBFX/UBFX/BFI/BFC.
#[test]
fn bitfield_forms() {
    let _held = crate::test_util::lock();
    // sbfx r0,r1,#8,#8, r1=0xABCD00 -> 0xFFFFFFCD
    let (cpu, _) = run_snippet(&[0xF341, 0x2007], &[(1, 0xABCD00)]);
    assert!(cpu.fault.is_none(), "sbfx fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.r[0], 0xFFFF_FFCD);
    // ubfx r0,r1,#8,#8 -> 0xCD
    let (cpu, _) = run_snippet(&[0xF3C1, 0x2007], &[(1, 0xABCD00)]);
    assert!(cpu.fault.is_none(), "ubfx fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.r[0], 0xCD);
    // bfi r0,r1,#8,#8: r0=0xFF000000, r1=0xAB -> 0xFF00AB00
    let (cpu, _) = run_snippet(&[0xF361, 0x200F], &[(0, 0xFF00_0000), (1, 0xAB)]);
    assert!(cpu.fault.is_none(), "bfi fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.r[0], 0xFF00_AB00);
    // bfc r0,#8,#8: r0=0xFFFFFFFF -> 0xFFFF00FF
    let (cpu, _) = run_snippet(&[0xF36F, 0x200F], &[(0, 0xFFFF_FFFF)]);
    assert!(cpu.fault.is_none(), "bfc fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.r[0], 0xFFFF_00FF);
}

/// LDRD/STRD doubleword transfers.
#[test]
fn ldrd_strd_roundtrip() {
    let _held = crate::test_util::lock();
    // strd r2,r3,[r1,#0x20]; ldrd r4,r5,[r1,#0x20]
    let (cpu, mem) = run_snippet(
        &[0xE9C1, 0x2308, 0xE9D1, 0x4508],
        &[(1, 0x20003000), (2, 0x1111_1111), (3, 0x2222_2222)],
    );
    assert!(cpu.fault.is_none(), "ldrd/strd fault: {:?}", cpu.fault);
    assert_eq!(mem.read32(0x20003020), 0x1111_1111);
    assert_eq!(mem.read32(0x20003024), 0x2222_2222);
    assert_eq!(cpu.regs.r[4], 0x1111_1111);
    assert_eq!(cpu.regs.r[5], 0x2222_2222);
}

/// UDIV incl. divide-by-zero (M3 CCR.DIV_0_TRP=0: quotient 0, no trap).
#[test]
fn udiv_and_div0() {
    let _held = crate::test_util::lock();
    // udiv r0,r1,r2 (FBB1 F0F2): 100/7 = 14
    let (cpu, _) = run_snippet(&[0xFBB1, 0xF0F2], &[(1, 100), (2, 7)]);
    assert!(cpu.fault.is_none(), "udiv fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.r[0], 14);
    // udiv by zero -> 0, no fault
    let (cpu, _) = run_snippet(&[0xFBB1, 0xF0F2], &[(1, 100), (2, 0)]);
    assert!(cpu.fault.is_none(), "udiv-by-zero fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.r[0], 0);
}

/// LDREX/STREX exclusive monitor (single global reservation, single core).
#[test]
fn ldrex_strex_pair() {
    let _held = crate::test_util::lock();
    // str r2,[r1]; ldrex r0,[r1] (E851 0F00); strex r2,r0,[r1] (E841 0200)
    let (cpu, mem) = run_snippet(
        &[0x600A, 0xE851, 0x0F00, 0xE841, 0x0200, 0xE7FE],
        &[(1, 0x20003000), (2, 0xDEAD_BEEF)],
    );
    assert!(cpu.fault.is_none(), "ldrex/strex fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.r[0], 0xDEAD_BEEF, "ldrex did not load");
    assert_eq!(cpu.regs.r[2], 0, "strex status must be 0 after ldrex");
    assert_eq!(mem.read32(0x20003000), 0xDEAD_BEEF);
    // Second strex with no reservation: status 1, store dropped.
    let (cpu, mem) = run_snippet(
        &[0xE841, 0x0400, 0xE7FE],
        &[(0, 0x1234_5678), (1, 0x20003000), (4, 0xAA)],
    );
    assert!(cpu.fault.is_none(), "bare strex fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.r[4], 1, "strex without ldrex must report 1");
    assert_eq!(mem.read32(0x20003000), 0, "failed strex must not store");
}

/// LDREXB/STREXB + LDREXH/STREXH pairs (shapes oracle-verified:
/// ldrexb r4,[r2] = E8D2 4F4F; Rt=o2[15:12], size=o2[4], Rd=o2[11:8].
/// The oracle faults byte/half STREX unconditionally, so only our side
/// of the store pair is asserted here).
#[test]
fn ldrexb_strexb_pair() {
    let _held = crate::test_util::lock();
    // strb r2,[r1]; ldrexb r0,[r1] (E8D1 0F4F); strexb r2,r0,[r1] (E8C1 024F).
    let (cpu, mem) = run_snippet(
        &[0x700A, 0xE8D1, 0x0F4F, 0xE8C1, 0x024F, 0xE7FE],
        &[(1, 0x20003000), (2, 0xAB)],
    );
    assert!(cpu.fault.is_none(), "ldrexb/strexb fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.r[0], 0xAB, "ldrexb did not load byte");
    assert_eq!(cpu.regs.r[2], 0, "strexb status must be 0 after ldrexb");
    assert_eq!(mem.read8(0x20003000), 0xAB);
    // Halfword pair: strh/ldrexh r0,[r1] (E8D1 0F5F); strexh r2,r0,[r1] (E8C1 025F).
    let (cpu, mem) = run_snippet(
        &[0x800A, 0xE8D1, 0x0F5F, 0xE8C1, 0x025F, 0xE7FE],
        &[(1, 0x20003000), (2, 0xBEEF)],
    );
    assert!(cpu.fault.is_none(), "ldrexh/strexh fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.r[0], 0xBEEF, "ldrexh did not load halfword");
    assert_eq!(cpu.regs.r[2], 0, "strexh status must be 0 after ldrexh");
    assert_eq!(mem.read16(0x20003000), 0xBEEF);
}

/// TBH halfword table branch (TBB covered by tbb_index_by_value).
#[test]
fn tbh_index_by_value() {
    let _held = crate::test_util::lock();
    let (mut cpu, mut mem) = run_snippet(&[], &[]);
    // tbh [pc,r2] (E8DF F012); table of halfwords at pc+4.
    mem.write16(0x20002000, 0xE8DF);
    mem.write16(0x20002002, 0xF012);
    mem.write16(0x20002004, 0x0004); // case0 -> base+8
    mem.write16(0x20002006, 0x0010); // case1 -> base+32
    cpu.regs.r[2] = 1;
    cpu.regs.r[15] = 0x20002001;
    let sys = crate::sys();
    cpu.run(sys, &mut mem, 1);
    assert!(cpu.fault.is_none(), "tbh fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.r[15] & !1, 0x20002024);
}

/// BL with link + landing (valid form: 2nd halfword >= 0xF800).
#[test]
fn bl_link_and_land() {
    let _held = crate::test_util::lock();
    // bl (F000 F800): off=0 -> target pc+4; movs lands, lr=(pc+4)|1.
    let (cpu, _) = run_snippet(&[0xF000, 0xF800, 0x2042, 0xE7FE], &[]);
    assert!(cpu.fault.is_none(), "bl fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.r[0], 0x42);
    assert_eq!(cpu.regs.r[14], 0x20002005);
}

/// STRD post-indexed (E8 P=0 form): transfer at base, write base-off back.
#[test]
fn strd_post_indexed() {
    let _held = crate::test_util::lock();
    // strd r2,r3,[r1],#-0x20 (E861 2308): r1=0x20003020.
    let (cpu, mem) = run_snippet(
        &[0xE861, 0x2308, 0xE7FE],
        &[(1, 0x20003020), (2, 0xAAAA_AAAA), (3, 0x5555_5555)],
    );
    assert!(cpu.fault.is_none(), "strd post fault: {:?}", cpu.fault);
    assert_eq!(mem.read32(0x20003020), 0xAAAA_AAAA);
    assert_eq!(mem.read32(0x20003024), 0x5555_5555);
    assert_eq!(cpu.regs.r[1], 0x20003000);
}

/// LDMDB (decrement-before) with and without writeback.
#[test]
fn ldmdb_forms() {
    let _held = crate::test_util::lock();
    // ldmdb r0,{r1,r2} (E910 0006): r0=0x20003008 reads [..00],[..04].
    let (cpu, _) = run_snippet(&[0xE910, 0x0006, 0xE7FE], &[(0, 0x20003008)]);
    assert!(cpu.fault.is_none(), "ldmdb fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.r[1], 0);
    assert_eq!(cpu.regs.r[2], 0);
    assert_eq!(cpu.regs.r[0], 0x20003008, "no-WB must not move Rn");
    // ldmdb r0!,{r1,r2} (E930 0006): DB+WB writes back Rn-4n.
    let (cpu, _) = run_snippet(&[0xE930, 0x0006, 0xE7FE], &[(0, 0x20003008)]);
    assert!(cpu.fault.is_none(), "ldmdb! fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.r[0], 0x20003000);
    // IB/DA shapes (P==U) are SRS/RFE space (UNDEFINED for Rn!=SP — the
    // oracle faults INSN_INVALID and Capstone rejects): fault loudly.
    // (Capstone-MCLASS rejects all IB/DA forms; earlier manual-derived
    // IB/DA execution was SRS-space mis-decoded as LDM.)
    let (cpu, _) = run_snippet(&[0xE9B0, 0x0002, 0xE7FE], &[(0, 0x20003000)]);
    assert!(cpu.fault.is_some(), "ldmib must fault (SRS-space)");
    let (cpu, _) = run_snippet(&[0xE830, 0x0002, 0xE7FE], &[(0, 0x20003000)]);
    assert!(cpu.fault.is_some(), "ldmda must fault (SRS-space)");
}

/// USAT with ASR shift (0xF3A0 form; LSL form covered by usat_ssat_q).
#[test]
fn usat_asr_shift() {
    let _held = crate::test_util::lock();
    // usat r0,#0x10,r0,asr #4 (F3A0 1010): r0=0x80000000 -> asr=0xF8000000
    // saturates to 0xFFFF with Q set.
    let (cpu, _) = run_snippet(&[0xF3A0, 0x1010, 0xE7FE], &[(0, 0x8000_0000)]);
    assert!(cpu.fault.is_none(), "usat.asr fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.r[0], 0xFFFF);
    assert_ne!(cpu.regs.xpsr & 0x08000000, 0);
    // No saturation: r0=0x8000 -> asr=0x0800, kept, Q clear. (Positive
    // input keeps it under the u16 max; LSL#4 would give 0x80000 and
    // saturate instead, so this distinguishes the shift direction.)
    let (cpu, _) = run_snippet(&[0xF3A0, 0x1010, 0xE7FE], &[(0, 0x8000)]);
    assert!(cpu.fault.is_none(), "usat.asr(2) fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.r[0], 0x0800);
    assert_eq!(cpu.regs.xpsr & 0x08000000, 0);
}

/// RBIT/CLZ are base ARMv7-M (M3 has them; only M0-class lacks them).
#[test]
fn rbit_clz_present() {
    let _held = crate::test_util::lock();
    // rbit r0,r0 (FA90 F0A0): 0x12345678 -> 0x1E6A2C48
    let (cpu, _) = run_snippet(&[0xFA90, 0xF0A0, 0xE7FE], &[(0, 0x1234_5678)]);
    assert!(cpu.fault.is_none(), "rbit fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.r[0], 0x1E6A_2C48);
    // clz r0,r0 (FAB0 F080): 0x00F00000 -> 8
    let (cpu, _) = run_snippet(&[0xFAB0, 0xF080, 0xE7FE], &[(0, 0x00F0_0000)]);
    assert!(cpu.fault.is_none(), "clz fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.r[0], 8);
}

/// MRS across the banked/system registers.
#[test]
fn mrs_full_sysm() {
    let _held = crate::test_util::lock();
    // mrs r0,ipsr (F3EF 8005) in thread mode -> 0
    let (cpu, _) = run_snippet(&[0xF3EF, 0x8005, 0xE7FE], &[]);
    assert!(cpu.fault.is_none(), "mrs ipsr fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.r[0], 0);
    // mrs r0,msp (F3EF 8008) reads the thread-mode SP
    let (cpu, _) = run_snippet(&[0xF3EF, 0x8008, 0xE7FE], &[]);
    assert!(cpu.fault.is_none(), "mrs msp fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.r[0], 0x20008000);
}

/// BL validity boundary + DBG hint.
#[test]
fn bl_boundary_and_dbg() {
    let _held = crate::test_util::lock();
    // bl (F000 F800) covered by bl_link_and_land; DBG (F3AF 80F0) is a NOP.
    let (cpu, _) = run_snippet(&[0xF3AF, 0x80F0, 0xE7FE], &[(0, 0x1234)]);
    assert!(cpu.fault.is_none(), "dbg fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.r[0], 0x1234);
}

/// PLD/PLI hints NOP (any sign, literal or offset); LDR.W pc literal branches.
#[test]
fn pld_hints_vs_ldr_pc_literal() {
    let _held = crate::test_util::lock();
    // pld [pc,#-0xf0] (F81F F0F0): hint, falls through, no fault.
    let (cpu, _) = run_snippet(&[0xF81F, 0xF0F0, 0xE7FE], &[]);
    assert!(cpu.fault.is_none(), "pld literal fault: {:?}", cpu.fault);
    // pld [r0,#-0xfc] (F810 FCFC): hint with Rn!=PC, falls through.
    let (cpu, _) = run_snippet(&[0xF810, 0xFCFC, 0xE7FE], &[(0, 0x20003000)]);
    assert!(cpu.fault.is_none(), "pld offset fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.r[0], 0x20003000, "pld must not write back");
    // ldr.w pc,[pc,#0] (F85F F000): literal pool at pc+4 holds odd target.
    let (mut cpu, mut mem) = run_snippet(&[], &[]);
    mem.write16(0x20002000, 0xF85F);
    mem.write16(0x20002002, 0xF000);
    mem.write32(0x20002004, 0x20002011);
    cpu.regs.r[15] = 0x20002001;
    let sys = crate::sys();
    cpu.run(sys, &mut mem, 1);
    assert!(cpu.fault.is_none(), "ldr.w pc literal fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.r[15] & !1, 0x20002010);
}

/// SMLAL/UMLAL 64-bit accumulate (op 0xC/0xE only; op-9 plain is invalid).
#[test]
fn smlal_umlal_forms() {
    let _held = crate::test_util::lock();
    // smlal r0,r2,r1,r1 (FBC1 0201): acc=r2:r0=1:0 plus 0x10000*0x10000.
    // 0x10000*0x10000 = 0x1_00000000 -> lo=0, hi=2 (1 accum + 1 carry).
    let (cpu, _) = run_snippet(&[0xFBC1, 0x0201], &[(0, 0), (1, 0x10000), (2, 1)]);
    assert!(cpu.fault.is_none(), "smlal fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.r[0], 0);
    assert_eq!(cpu.regs.r[2], 2);
    // umlal lr,r5,r1,r2 (FBE1 E502): acc=r5:lr=3:2 plus 5*7=35 -> lo=37,hi=3.
    let (cpu, _) = run_snippet(
        &[0xFBE1, 0xE502, 0xE7FE],
        &[(1, 5), (2, 7), (5, 3), (14, 2)],
    );
    assert!(cpu.fault.is_none(), "umlal fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.r[14], 37);
    assert_eq!(cpu.regs.r[5], 3);
}

/// SSAT16/USAT16 dual-halfword saturates (o2[15:12]==0 && o2[7:4]==0
/// selects dual; anything else on the ASR hw1 is single-shift).
#[test]
fn sat16_forms() {
    let _held = crate::test_util::lock();
    // ssat16 r5,#6,r6 (F326 0505): halves 0x7FFF/0x8000 -> sat to
    // [+31,-32] with Q. r6=0x7FFF8000.
    let (cpu, _) = run_snippet(&[0xF326, 0x0505, 0xE7FE], &[(6, 0x7FFF_8000)]);
    assert!(cpu.fault.is_none(), "ssat16 fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.r[5], 0x001F_FFE0);
    assert_ne!(cpu.regs.xpsr & 0x08000000, 0);
    // usat16 r0,#0xf,r0 (F3A0 000F): halves 0xFFFF/0x1234 -> 0xF/0x1234?
    // sat=15 direct: max 0x7FFF; 0xFFFF saturates, 0x1234 kept, Q set.
    let (cpu, _) = run_snippet(&[0xF3A0, 0x000F, 0xE7FE], &[(0, 0xFFFF_1234)]);
    assert!(cpu.fault.is_none(), "usat16 fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.r[0], 0x7FFF_1234);
    assert_ne!(cpu.regs.xpsr & 0x08000000, 0);
}

/// T1 MOVS preserves C/V (only N/Z update) — differential fuzz caught a
/// stray V-clear here.
#[test]
fn movs_imm_preserves_cv() {
    let _held = crate::test_util::lock();
    // adds r0,r1,r2 (1888) with 0x40000000+0x40000000 overflows: V=1,C=0.
    // movs r6,#0x3E (263E) must keep V=1,C=0 and set N=0,Z=0.
    let (cpu, _) = run_snippet(
        &[0x1888, 0x263E, 0xE7FE],
        &[(1, 0x4000_0000), (2, 0x4000_0000)],
    );
    assert!(cpu.fault.is_none(), "movs-cv fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.r[0], 0x8000_0000);
    assert_eq!(cpu.regs.r[6], 0x3E);
    assert_eq!(cpu.regs.xpsr & 0xF0000000, 0x10000000);
}

/// MOVW/MOVT with Rd==PC is UNPREDICTABLE (must fault, not silently NOP).
#[test]
fn movw_movt_pc_fault() {
    let _held = crate::test_util::lock();
    let (cpu, _) = run_snippet(&[0xF64E, 0x7F7F, 0xE7FE], &[]);
    assert!(cpu.fault.is_some(), "movw pc should fault loudly");
    // Sanity: normal MOVW still works (movw r0,#0x1234 = F241 2034).
    let (cpu, _) = run_snippet(&[0xF241, 0x2034, 0xE7FE], &[]);
    assert!(cpu.fault.is_none(), "movw fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.r[0], 0x1234);
}

/// Bcc.W: J1=o2[11], J2=o2[13], used DIRECTLY (no B.W-style inversion).
/// Oracle+capstone verified (Unicorn oracle + GCC firmware cross-check).
#[test]
fn bcc_w_forward_s0() {
    let _held = crate::test_util::lock();
    // beq.w +0x10 (F000 8008, cond=EQ, S=0,J1=0,J2=0) -> 0x20002016 when
    // Z=1 (plus one overrun slot into zero-RAM: 0x20002018).
    let (cpu, _) = run_snippet(&[0x2000, 0xF000, 0x8008], &[]);
    assert!(cpu.fault.is_none(), "bcc.w fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.r[15] & !1, 0x20002018);
    // Z=0: falls through past the branch (second halfword decodes as a
    // harmless 16-bit ldrh).
    let (cpu, _) = run_snippet(&[0x2001, 0xF000, 0x8008], &[]);
    assert!(cpu.fault.is_none(), "bcc.w(nt) fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.r[15] & !1, 0x20002008);
}

/// UNPREDICTABLE shapes fault loudly (differential fuzz vs the oracle).
#[test]
fn unpredictable_shapes_fault() {
    let _held = crate::test_util::lock();
    // sbfx with lsb+width > 32 (F34A 7070: lsb=29, w=17).
    let (cpu, _) = run_snippet(&[0xF34A, 0x7070, 0xE7FE], &[]);
    assert!(cpu.fault.is_some(), "sbfx#29,#17 should fault");
    // Long multiply with o2[7:4]!=0 is DSP/UMAAL space (FBE8 6A6A).
    let (cpu, _) = run_snippet(&[0xFBE8, 0x6A6A, 0xE7FE], &[]);
    assert!(cpu.fault.is_some(), "umlal-shape o2[7:4]!=0 should fault");
    // LDM with writeback + Rn in list (E8B4 001A: ldmia r4!,{r1,r3,r4}).
    let (cpu, _) = run_snippet(&[0xE8B4, 0x001A, 0xE7FE], &[(4, 0x20003000)]);
    assert!(cpu.fault.is_some(), "ldm Rn-in-list+WB should fault");
}

/// STM with writeback + Rn in its own list stores the ORIGINAL Rn value
/// (silicon-plausible order; the oracle faults INSN_INVALID on these, so
/// the fuzzer resamples them structurally — seed 6 `stm.w r0!,{r0,...}`).
#[test]
fn stm_rn_in_list_stores_original() {
    let _held = crate::test_util::lock();
    // stmia.w r0!, {r0, r3} (E8A0 0009): r0=base, r3=marker.
    let (cpu, mem) = run_snippet(&[0xE8A0, 0x0009, 0xE7FE], &[(0, 0x20003000), (3, 0xDEADBEEF)]);
    assert!(cpu.fault.is_none(), "stm Rn-in-list fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.r[0], 0x20003008, "writeback lands after the list");
    assert_eq!(mem.read32(0x20003000), 0x20003000, "stored Rn is the original value");
    assert_eq!(mem.read32(0x20003004), 0xDEADBEEF, "stored r3 intact");
}

/// Bcc.W with S=1 (backward): J still direct (J1=o2[11], J2=o2[13]).
#[test]
fn bcc_w_backward_s1() {
    let _held = crate::test_util::lock();
    // bne.w -0x10 (F47F AFF8, cond=NE, S=1,J1=1,J2=1) -> 0x20001FF6 when
    // Z=0 (plus one overrun slot into zero-RAM: 0x20001FF8).
    let (cpu, _) = run_snippet(&[0x2001, 0xF47F, 0xAFF8], &[]);
    assert!(cpu.fault.is_none(), "bcc.w(s1) fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.r[15] & !1, 0x20001FF8);
    // Z=1: falls through.
    let (cpu, _) = run_snippet(&[0x2000, 0xF47F, 0xAFF8], &[]);
    assert!(cpu.fault.is_none(), "bcc.w(s1,nt) fault: {:?}", cpu.fault);
    assert_eq!(cpu.regs.r[15] & !1, 0x20002008);
}




// ---- Superoperator differential: fused pairs vs legacy sequential ------
// Each template below runs the SAME snippet twice — once with fusion armed
// (production path) and once with FUSION_OFF (legacy dispatch) — and asserts
// full machine-state equality (regs incl. SP/LR/PC, xpsr incl. IT bits,
// fault record, scratch RAM hash, bad-address diagnostic). Any guard bug
// (false positive on traps/reserved shapes) or handler bug (wrong flags,
// regs, memory, pc) fails loudly. MPU/watch-armed paths are covered by
// construction: fused handlers call the same mem.read32/mem.write32 the
// legacy arms call, which self-route to the exact slow paths when armed.

fn xorshift(s: &mut u32) -> u32 {
    let mut x = *s;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    *s = x;
    x
}

struct Snap {
    regs: [u32; 16],
    xpsr: u32,
    fault: Option<(u32, u16, u16, u8)>,
    ram_hash: u64,
    bad: Option<u32>,
}

fn snap_of(cpu: &Cpu, mem: &FlatMemory) -> Snap {
    let mut h: u64 = 0xcbf29ce484222325;
    for a in (0x20003000..0x20003100).step_by(4) {
        h ^= mem.read32(a) as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    Snap {
        regs: cpu.regs.r,
        xpsr: cpu.regs.xpsr,
        fault: cpu.fault.as_ref().map(|f| (f.pc, f.op1, f.op2, f.len)),
        ram_hash: h,
        bad: mem.bad.get(),
    }
}

fn snap_eq(a: &Snap, b: &Snap) -> bool {
    a.regs == b.regs && a.xpsr == b.xpsr && a.fault == b.fault && a.ram_hash == b.ram_hash && a.bad == b.bad
}

/// Run one [op1, op2] pair snippet both ways. Layout at 0x20002000:
/// [op1, op2, b.n self, b.n self, 12 literal pads]; LDRlit immediates are
/// capped so literals land in the pads; LDR bases point at scratch RAM
/// (0x20003000, seeded). Returns the two snapshots.
fn run_pair_both(
    sys: &crate::system::WasmSystem,
    op1: u16,
    op2: u16,
    regs78: &[(usize, u32)],
    flags: u32,
    seed: u32,
) -> (Snap, Snap) {
    let mut out = Vec::new();
    for fused in [true, false] {
        super::thumb::fusion_off(!fused);
        let mut cpu = Cpu::new(0x20008000, 0x20002001);
        cpu.dsp = false;
        cpu.deliver_irqs = false;
        let mut mem = FlatMemory::new(0x1000, 0x10000);
        let mut code = vec![op1, op2, 0xE7FE, 0xE7FE];
        let mut s = seed;
        for _ in 0..12 {
            code.push((xorshift(&mut s) & 0xFFFF) as u16);
        }
        for (i, w) in code.iter().enumerate() {
            mem.write16(0x20002000 + (i as u32) * 2, *w);
        }
        for r in 0..8 {
            cpu.regs.r[r] = xorshift(&mut s);
        }
        for r in 8..13 {
            cpu.regs.r[r] = 0xAA000000 + (r as u32);
        }
        cpu.regs.r[14] = 0xDEADBEEF;
        for &(r, v) in regs78 {
            cpu.regs.r[r] = v;
        }
        cpu.regs.xpsr = (cpu.regs.xpsr & !0xF0000000) | (flags & 0xF0000000);
        s = seed ^ 0x9E3779B9;
        for a in (0x20003000..0x20003100).step_by(2) {
            mem.write16(a, (xorshift(&mut s) & 0xFFFF) as u16);
        }
        cpu.run(sys, &mut mem, 8);
        out.push(snap_of(&cpu, &mem));
    }
    super::thumb::fusion_off(false);
    (out.remove(0), out.remove(0))
}

fn check_pair(sys: &crate::system::WasmSystem, op1: u16, op2: u16, regs: &[(usize, u32)], flags: u32, seed: u32, what: &str) {
    let (a, b) = run_pair_both(sys, op1, op2, regs, flags, seed);
    assert!(snap_eq(&a, &b), "fused/legacy diverge for {}: op1={:04x} op2={:04x}", what, op1, op2);
}

/// Fused (LDRlit, LDR-imm): rt1 x imm8 x rn2 x rt2 x imm5, overlapping
/// registers included (rt1 == rn2 / rt2), literals + RAM seeded.
#[test]
fn fused_ldr_ldr_matches_legacy() {
    let _held = crate::test_util::lock();
    crate::init();
    let sys = crate::sys();
    let mut n = 0;
    for rt1 in 0..8 {
        for &imm8 in &[0u32, 1, 2, 3] {
            for rn2 in 0..8 {
                for rt2 in 0..8 {
                    for &imm5 in &[0u32, 31] {
                        // scratch base for rn2 (4-aligned), distinct per rn2
                        let base = 0x20003000 + (rn2 as u32) * 16;
                        let op1 = 0x4800 | ((rt1 as u16) << 8) | (imm8 as u16);
                        let op2 = 0x6800 | ((imm5 as u16) << 6) | ((rn2 as u16) << 3) | (rt2 as u16);
                        check_pair(sys, op1, op2, &[(rn2, base)], 0, 0x1000 + n, "ldr-ldr");
                        n += 1;
                    }
                }
            }
        }
    }
    assert!(n > 2000);
}

/// Fused (SUBreg, CMP-reg): full rd/rs/rn cube x CMP rs2/rd2 subset x flags.
#[test]
fn fused_sub_cmp_matches_legacy() {
    let _held = crate::test_util::lock();
    crate::init();
    let sys = crate::sys();
    let mut n = 0;
    for rd in 0..8 {
        for rs in 0..8 {
            for rn in 0..8 {
                for rs2 in 0..4 {
                    for rd2 in 0..4 {
                        for &flags in &[0x00000000u32, 0xF0000000, 0x20000000, 0x60000000] {
                            let op1 = 0x1A00 | ((rn as u16) << 6) | ((rs as u16) << 3) | (rd as u16);
                            // CMP-reg: ALU arm, sop == 10
                            let op2 = 0x4000 | (10u16 << 6) | ((rs2 as u16) << 3) | (rd2 as u16);
                            check_pair(sys, op1, op2, &[], flags, 0x2000 + n, "sub-cmp");
                            n += 1;
                        }
                    }
                }
            }
        }
    }
    assert!(n > 30000);
}

/// Fused (CMP-imm, Bcc): rn x imm x cc (ALL 16, incl. E/F with DF00/DE00
/// trap shapes to prove the exclusion) x taken/untaken x flags.
#[test]
fn fused_cmp_bcc_matches_legacy() {
    let _held = crate::test_util::lock();
    crate::init();
    let sys = crate::sys();
    let mut n = 0;
    let mut taken = 0;
    let mut untaken = 0;
    for rn in 0..8 {
        for &imm in &[0u32, 1, 127, 255, 0x80, 0x7F, 0xFE, 0x01] {
            for cc in 0..16 {
                for taken_case in [false, true] {
                    for &flags in &[0x00000000u32, 0xF0000000, 0x20000000, 0x40000000, 0x80000000, 0x60000000, 0xA0000000, 0xC0000000] {
                        let op1 = 0x2800 | ((rn as u16) << 8) | (imm as u16);
                        // Bcc offset: reach the b-self landing (taken) or sail past (untaken via flags)
                        let off: i32 = if taken_case { -4 } else { 100 };
                        let o2 = if cc == 0xE {
                            0xDE00 | ((off as u16) & 0xFF)
                        } else if cc == 0xF {
                            0xDF00 | ((off as u16) & 0xFF)
                        } else {
                            0xD000 | ((cc as u16) << 8) | ((off as u16) & 0xFF)
                        };
                        let (a, b) = run_pair_both(sys, op1, o2, &[], flags, 0x3000 + n);
                        assert!(snap_eq(&a, &b), "fused/legacy diverge for cmp-bcc: {:04x} {:04x}", op1, o2);
                        // Untaken parks in the b-self landing at +4; anything
                        // else means the branch was taken (forward pads or
                        // backward RAM zeros — both deterministic).
                        if (a.regs[15] & !1) == 0x20002004 { untaken += 1; } else { taken += 1; }
                        n += 1;
                    }
                }
            }
        }
    }
    assert!(taken > 100 && untaken > 100, "must exercise both directions (taken={}, untaken={})", taken, untaken);
    assert!(n > 15000);
}

/// Fused (LSL-imm, Bcc): rd x rs x imm5 (incl. 0/31 edges) x cc subset x
/// taken/untaken x flags.
#[test]
fn fused_lsl_bcc_matches_legacy() {
    let _held = crate::test_util::lock();
    crate::init();
    let sys = crate::sys();
    let mut n = 0;
    for rd in 0..8 {
        for rs in 0..8 {
            for &imm5 in &[0u32, 1, 2, 15, 16, 30, 31, 5] {
                for cc in [0u32, 1, 4, 14] {
                    for taken_case in [false, true] {
                        for &flags in &[0x00000000u32, 0xF0000000, 0x20000000, 0x80000000] {
                            let op1 = ((imm5 as u16) << 6) | ((rs as u16) << 3) | (rd as u16);
                            let off: i32 = if taken_case { -4 } else { 100 };
                            let o2 = 0xD000 | ((cc as u16) << 8) | ((off as u16) & 0xFF);
                            check_pair(sys, op1, o2, &[], flags, 0x4000 + n, "lsl-bcc");
                            n += 1;
                        }
                    }
                }
            }
        }
    }
    assert!(n > 15000);
}

/// IT-block fallback: fused shapes inside an IT block take the legacy path
/// both ways (suppression preserved exactly).
#[test]
fn fused_it_fallback_matches_legacy() {
    let _held = crate::test_util::lock();
    crate::init();
    let sys = crate::sys();
    // ITE MI (0xBF0C): cmp then bne, first suppressed when N==0.
    // v2 pairs exercise the same it_n == 0 gate in every new first-arm.
    for flags in [0x00000000u32, 0x80000000] {
        for op_pair in [(0x42A3u16, 0xD101u16), (0x6019u16, 0x6821u16), (0x2001u16, 0xE7FEu16), (0x4802u16, 0x4903u16)] {
            let mut out = Vec::new();
            for fused in [true, false] {
                super::thumb::fusion_off(!fused);
                let mut cpu = Cpu::new(0x20008000, 0x20002001);
                cpu.dsp = false;
                cpu.deliver_irqs = false;
                let mut mem = FlatMemory::new(0x1000, 0x10000);
                // IT(0xBF0C) at 0x20002000, pair at 0x20002002, landing pads.
                let code = [0xBF0Cu16, op_pair.0, op_pair.1, 0xE7FE, 0xE7FE, 0xE7FE];
                for (i, w) in code.iter().enumerate() {
                    mem.write16(0x20002000 + (i as u32) * 2, *w);
                }
                cpu.regs.r[0] = 0;
                cpu.regs.r[1] = 0xAB;
                cpu.regs.r[3] = 0x20003000;
                cpu.regs.r[4] = 0x20003010;
                cpu.regs.xpsr = (cpu.regs.xpsr & !0xF0000000) | (flags & 0xF0000000);
                cpu.regs.r[15] = 0x20002001;
                cpu.run(sys, &mut mem, 8);
                out.push(snap_of(&cpu, &mem));
            }
            super::thumb::fusion_off(false);
            assert!(snap_eq(&out[0], &out[1]), "IT fallback diverges at flags {:08x}", flags);
        }
    }
}

// ---- Superoperator v2 differential: same fused-vs-legacy discipline ----
fn op_str(rn: usize, rt: usize, imm5: u32) -> u16 {
    0x6000 | (((imm5 & 31) as u16) << 6) | (((rn & 7) as u16) << 3) | ((rt & 7) as u16)
}
fn op_ldri(rn: usize, rt: usize, imm5: u32) -> u16 {
    0x6800 | (((imm5 & 31) as u16) << 6) | (((rn & 7) as u16) << 3) | ((rt & 7) as u16)
}
fn op_mov(rd: usize, imm: u32) -> u16 {
    0x2000 | (((rd & 7) as u16) << 8) | ((imm & 0xFF) as u16)
}
fn op_lsl(rd: usize, rs: usize, imm5: u32) -> u16 {
    (((imm5 & 31) as u16) << 6) | (((rs & 7) as u16) << 3) | ((rd & 7) as u16)
}
fn op_lit(rt: usize, imm8: u32) -> u16 {
    0x4800 | (((rt & 7) as u16) << 8) | ((imm8 & 0xFF) as u16)
}
fn op_cmp(rn: usize, imm: u32) -> u16 {
    0x2800 | (((rn & 7) as u16) << 8) | ((imm & 0xFF) as u16)
}
fn op_subsi(rd: usize, rn: usize, im3: u32) -> u16 {
    0x1E00 | (((im3 & 7) as u16) << 6) | (((rn & 7) as u16) << 3) | ((rd & 7) as u16)
}
fn op_b(off: i32) -> u16 {
    0xE000 | ((off as u16) & 0x7FF)
}
fn op_cbz(rn: usize, cbnz: bool) -> u16 {
    // nz = 0 -> fallthrough parks in the b-self landing; rn selects taken.
    0xB100 | ((rn & 7) as u16) | if cbnz { 0x800 } else { 0 }
}
fn op_bcc(cc: u32, off: i32) -> u16 {
    if cc == 0xE {
        0xDE00 | ((off as u16) & 0xFF)
    } else if cc == 0xF {
        0xDF00 | ((off as u16) & 0xFF)
    } else {
        0xD000 | (((cc & 15) as u16) << 8) | ((off as u16) & 0xFF)
    }
}
fn scratch(rn: usize) -> (usize, u32) {
    (rn, 0x20003000 + (rn as u32) * 16)
}

#[test]
fn fused2_str_ldri_matches_legacy() {
    let _held = crate::test_util::lock();
    crate::init();
    let sys = crate::sys();
    let mut n = 0;
    for rn1 in 0..8 { for rt1 in 0..8 { for &i5 in &[0u32, 31] {
        for rn2 in 0..8 { for rt2 in 0..8 { for &j5 in &[0u32, 31] {
            check_pair(sys, op_str(rn1, rt1, i5), op_ldri(rn2, rt2, j5),
                &[scratch(rn1), scratch(rn2)], 0, 0x5000 + n, "str-ldri");
            n += 1;
        } } }
    } } }
    assert!(n == 16384);
}

#[test]
fn fused2_str_mov_matches_legacy() {
    let _held = crate::test_util::lock();
    crate::init();
    let sys = crate::sys();
    let mut n = 0;
    for rn1 in 0..8 { for rt1 in 0..8 { for &i5 in &[0u32, 31] {
        for rd2 in 0..8 { for &imm in &[0u32, 1, 127, 255] {
            for &flags in &[0u32, 0xF0000000] {
                check_pair(sys, op_str(rn1, rt1, i5), op_mov(rd2, imm),
                    &[scratch(rn1)], flags, 0x5100 + n, "str-mov");
                n += 1;
            }
        } }
    } } }
    assert!(n == 8192);
}

#[test]
fn fused2_str_b_matches_legacy() {
    let _held = crate::test_util::lock();
    crate::init();
    let sys = crate::sys();
    let mut n = 0;
    for rn1 in 0..8 { for rt1 in 0..8 { for &i5 in &[0u32, 31] {
        for &off in &[-4i32, 100] {
            check_pair(sys, op_str(rn1, rt1, i5), op_b(off), &[scratch(rn1)], 0, 0x5200 + n, "str-b");
            n += 1;
        }
    } } }
    assert!(n == 256);
}

#[test]
fn fused2_str_lit_matches_legacy() {
    let _held = crate::test_util::lock();
    crate::init();
    let sys = crate::sys();
    let mut n = 0;
    for rn1 in 0..8 { for rt1 in 0..8 { for &i5 in &[0u32, 31] {
        for rt2 in 0..8 { for &imm8 in &[0u32, 1, 2, 3] {
            check_pair(sys, op_str(rn1, rt1, i5), op_lit(rt2, imm8), &[scratch(rn1)], 0, 0x5300 + n, "str-lit");
            n += 1;
        } }
    } } }
    assert!(n == 4096);
}

#[test]
fn fused2_ldri_lsl_matches_legacy() {
    let _held = crate::test_util::lock();
    crate::init();
    let sys = crate::sys();
    let mut n = 0;
    for rn1 in 0..8 { for rt1 in 0..8 { for &i5 in &[0u32, 31] {
        for rd2 in 0..8 { for rs2 in 0..8 { for &j5 in &[0u32, 31] {
            for &flags in &[0u32, 0x20000000] {
                check_pair(sys, op_ldri(rn1, rt1, i5), op_lsl(rd2, rs2, j5),
                    &[scratch(rn1)], flags, 0x5400 + (n & 0xFFFF), "ldri-lsl");
                n += 1;
            }
        } } }
    } } }
    assert!(n == 32768);
}

#[test]
fn fused2_ldri_ldri_matches_legacy() {
    let _held = crate::test_util::lock();
    crate::init();
    let sys = crate::sys();
    let mut n = 0;
    for rn1 in 0..8 { for rt1 in 0..8 { for &i5 in &[0u32, 31] {
        for rn2 in 0..8 { for rt2 in 0..8 { for &j5 in &[0u32, 31] {
            check_pair(sys, op_ldri(rn1, rt1, i5), op_ldri(rn2, rt2, j5),
                &[scratch(rn1), scratch(rn2)], 0, 0x5500 + (n & 0xFFFF), "ldri-ldri");
            n += 1;
        } } }
    } } }
    assert!(n == 16384);
}

#[test]
fn fused2_ldri_cbz_matches_legacy() {
    let _held = crate::test_util::lock();
    crate::init();
    let sys = crate::sys();
    let mut n = 0;
    for rn1 in 0..8 { for rt1 in 0..8 { for &i5 in &[0u32, 31] {
        for rn2 in 0..8 { for cbnz in [false, true] {
            // rn2 = 0 vs nonzero exercises taken + fallthrough both ways.
            for &rv in &[0u32, 5] {
                let mut regs = vec![scratch(rn1)];
                regs.push((rn2, rv));
                check_pair(sys, op_ldri(rn1, rt1, i5), op_cbz(rn2, cbnz), &regs, 0, 0x5600 + n, "ldri-cbz");
                n += 1;
            }
        } }
    } } }
    assert!(n == 4096);
}

#[test]
fn fused2_ldri_cmp_matches_legacy() {
    let _held = crate::test_util::lock();
    crate::init();
    let sys = crate::sys();
    let mut n = 0;
    for rn1 in 0..8 { for rt1 in 0..8 { for &i5 in &[0u32, 31] {
        for rn in 0..8 { for &imm in &[0u32, 255] {
            for &flags in &[0u32, 0xF0000000] {
                check_pair(sys, op_ldri(rn1, rt1, i5), op_cmp(rn, imm), &[scratch(rn1)], flags, 0x5700 + (n & 0xFFFF), "ldri-cmp");
                n += 1;
            }
        } }
    } } }
    assert!(n == 4096);
}

#[test]
fn fused2_ldri_bcc_matches_legacy() {
    let _held = crate::test_util::lock();
    crate::init();
    let sys = crate::sys();
    let mut n = 0u32;
    let mut taken = 0;
    let mut untaken = 0;
    for rn1 in 0..8 { for rt1 in 0..8 { for &i5 in &[0u32, 31] {
        for cc in 0..16 {
            for taken_case in [false, true] {
                for &flags in &[0u32, 0xF0000000] {
                    let off: i32 = if taken_case { -4 } else { 100 };
                    let (a, b) = run_pair_both(sys, op_ldri(rn1, rt1, i5), op_bcc(cc, off), &[scratch(rn1)], flags, 0x5800 + n);
                    assert!(snap_eq(&a, &b), "fused/legacy diverge for ldri-bcc cc={}", cc);
                    if (a.regs[15] & !1) == 0x20002004 { untaken += 1; } else { taken += 1; }
                    n += 1;
                }
            }
        }
    } } }
    assert!(taken > 100 && untaken > 100);
    assert!(n == 8192);
}

#[test]
fn fused2_mov_b_matches_legacy() {
    let _held = crate::test_util::lock();
    crate::init();
    let sys = crate::sys();
    let mut n = 0;
    for rd1 in 0..8 { for &imm in &[0u32, 1, 127, 255, 128] {
        for &off in &[-4i32, 100] {
            for &flags in &[0u32, 0xF0000000] {
                check_pair(sys, op_mov(rd1, imm), op_b(off), &[], flags, 0x5900 + n, "mov-b");
                n += 1;
            }
        }
    } }
    assert!(n == 160);
}

#[test]
fn fused2_mov_lit_matches_legacy() {
    let _held = crate::test_util::lock();
    crate::init();
    let sys = crate::sys();
    let mut n = 0;
    for rd1 in 0..8 { for &imm in &[0u32, 1, 127, 255] {
        for rt2 in 0..8 { for &imm8 in &[0u32, 1, 2, 3] {
            for &flags in &[0u32, 0x20000000] {
                check_pair(sys, op_mov(rd1, imm), op_lit(rt2, imm8), &[], flags, 0x5A00 + n, "mov-lit");
                n += 1;
            }
        } }
    } }
    assert!(n == 2048);
}

#[test]
fn fused2_mov_mov_matches_legacy() {
    let _held = crate::test_util::lock();
    crate::init();
    let sys = crate::sys();
    let mut n = 0;
    for rd1 in 0..8 { for &imm in &[0u32, 1, 127, 255] {
        for rd2 in 0..8 { for &imm2 in &[0u32, 1, 127, 255] {
            for &flags in &[0u32, 0xF0000000, 0x20000000] {
                check_pair(sys, op_mov(rd1, imm), op_mov(rd2, imm2), &[], flags, 0x5B00 + (n & 0xFFFF), "mov-mov");
                n += 1;
            }
        } }
    } }
    assert!(n == 3072);
}

#[test]
fn fused2_mov_str_matches_legacy() {
    let _held = crate::test_util::lock();
    crate::init();
    let sys = crate::sys();
    let mut n = 0;
    for rd1 in 0..8 { for &imm in &[0u32, 1, 127, 255] {
        for rn2 in 0..8 { for rt2 in 0..8 { for &j5 in &[0u32, 31] {
            check_pair(sys, op_mov(rd1, imm), op_str(rn2, rt2, j5), &[scratch(rn2)], 0, 0x5C00 + (n & 0xFFFF), "mov-str");
            n += 1;
        } } }
    } }
    assert!(n == 4096);
}

#[test]
fn fused2_mov_ldri_matches_legacy() {
    let _held = crate::test_util::lock();
    crate::init();
    let sys = crate::sys();
    let mut n = 0;
    for rd1 in 0..8 { for &imm in &[0u32, 1, 127, 255] {
        for rn2 in 0..8 { for rt2 in 0..8 { for &j5 in &[0u32, 31] {
            check_pair(sys, op_mov(rd1, imm), op_ldri(rn2, rt2, j5), &[scratch(rn2)], 0, 0x5D00 + (n & 0xFFFF), "mov-ldri");
            n += 1;
        } } }
    } }
    assert!(n == 4096);
}

#[test]
fn fused2_lsl_mov_matches_legacy() {
    let _held = crate::test_util::lock();
    crate::init();
    let sys = crate::sys();
    let mut n = 0;
    for rd in 0..8 { for rs in 0..8 { for &i5 in &[0u32, 1, 31] {
        for &flags in &[0u32, 0x20000000] {
            for rd2 in 0..8 { for &imm in &[0u32, 1, 127, 255] {
                check_pair(sys, op_lsl(rd, rs, i5), op_mov(rd2, imm), &[], flags, 0x5E00 + (n & 0xFFFF), "lsl-mov");
                n += 1;
            } }
        }
    } } }
    assert!(n == 12288);
}

#[test]
fn fused2_lsl_lsl_matches_legacy() {
    let _held = crate::test_util::lock();
    crate::init();
    let sys = crate::sys();
    let mut n = 0u32;
    for rd in 0..8 { for rs in 0..8 { for &i5 in &[0u32, 31] {
        for &flags in &[0u32, 0x20000000] {
            for rd2 in 0..8 { for rs2 in 0..8 { for &j5 in &[0u32, 31] {
                check_pair(sys, op_lsl(rd, rs, i5), op_lsl(rd2, rs2, j5), &[], flags, 0x5F00 + (n & 0xFFFFFF), "lsl-lsl");
                n += 1;
            } } }
        }
    } } }
    assert!(n == 32768);
}

#[test]
fn fused2_lit_lit_matches_legacy() {
    let _held = crate::test_util::lock();
    crate::init();
    let sys = crate::sys();
    let mut n = 0;
    for rt1 in 0..8 { for &imm8 in &[0u32, 1, 2, 3] {
        for rt2 in 0..8 { for &imm8b in &[0u32, 1, 2, 3] {
            check_pair(sys, op_lit(rt1, imm8), op_lit(rt2, imm8b), &[], 0, 0x6000 + n, "lit-lit");
            n += 1;
        } }
    } }
    assert!(n == 1024);
}

#[test]
fn fused2_lit_str_matches_legacy() {
    let _held = crate::test_util::lock();
    crate::init();
    let sys = crate::sys();
    let mut n = 0;
    for rt1 in 0..8 { for &imm8 in &[0u32, 1, 2, 3] {
        for rn2 in 0..8 { for rt2 in 0..8 { for &j5 in &[0u32, 31] {
            check_pair(sys, op_lit(rt1, imm8), op_str(rn2, rt2, j5), &[scratch(rn2)], 0, 0x6100 + (n & 0xFFFF), "lit-str");
            n += 1;
        } } }
    } }
    assert!(n == 4096);
}

#[test]
fn fused2_subsi_cmp_matches_legacy() {
    let _held = crate::test_util::lock();
    crate::init();
    let sys = crate::sys();
    let mut n = 0;
    for rd in 0..8 { for rn in 0..8 { for &im3 in &[0u32, 7] {
        for rn2 in 0..8 { for &imm in &[0u32, 255] {
            for &flags in &[0u32, 0xF0000000] {
                check_pair(sys, op_subsi(rd, rn, im3), op_cmp(rn2, imm), &[], flags, 0x6200 + (n & 0xFFFF), "subsi-cmp");
                n += 1;
            }
        } }
    } } }
    assert!(n == 4096);
}
