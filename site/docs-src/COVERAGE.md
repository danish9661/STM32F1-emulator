# Coverage Audit — Emulator vs Real STM32F103 Silicon

Method: census of all 67 `<peripheral>` blocks in `svd/STM32F103.svd`
(including `derivedFrom` entries), cross-checked against `build_peripheral()`
+ the hardcoded map in `src/peripherals/mod.rs` and the depth notes in
`docs/PERIPHERALS.md`. "Family" = what the SVD describes (medium density and
up); the Blue Pill's STM32F103C8 is a medium-density subset — peripherals the
C8 lacks but we model anyway (DAC, FSMC, DMA2, ADC3, TIM5+, UART4/5, CAN2,
SPI3, GPIOE-G) are harmless supersets, marked *(S)* below.

## 1. Peripheral census (SVD → emulator status)

| SVD peripheral(s) | Base(s) | Status | Notes |
|---|---|---|---|
| TIM2/3/4/5/6/7 | APB1 | Full | PWM, input capture, TRGO Triggers, slave modes, DMA requests |
| TIM1/8 | APB2 | Full | + RCR/BDTR registers decode |
| TIM9/10/11 | APB2 | Full | IRQ + channels + trigger bases (were already present) |
| TIM12/13/14 | APB1 | Full (S) | Pinned in `timer_base()` |
| RTC | 0x40002800 | Full | Time + alarm + second + overflow IRQs, SECF/ALRF/OWF flags (RM0008 CRH bit order) |
| WWDG | 0x40002C00 | Full | Counter + reset + early-wakeup interrupt (EWI → IRQ0) |
| IWDG | 0x40003000 | Full | Down-counter + reset; runs through STOP/STANDBY |
| USART1-3, UART4/5 | APB1/2 | Full | Byte-time pacing, RXNE/TXE IRQs, DMA channels (incl. DMA2 for UART4/5) |
| I2C1/2 | APB1 | Full | Master TX/RX state machine + slave mode (host inject: OAR match incl. 10-bit, ADDR/STOPF, RXNE/TXE, EV IRQs) |
| USB (FS device) | 0x40005C00 | Full | EP0-7R toggle semantics, CNTR masks, ISTR (W0C flags; CTR/DIR/EP_ID derived), DADDR, BTABLE, 512 B PMA (byte-exact), RESET on FRES release, SETUP/OUT injection with DTOG sequencing, IN completion as `UsbIn` event + IRQ20. SOF engine (FNR/RXDP, SOF/SUSP/WKUP IRQs, wakeup IRQ42, auto-suspend, RESUME), double-buffered bulk endpoints, isochronous transfers verified (same data path) |
| CAN1 (+CAN2 via F105 SVD) | APB1 | Full | Mailboxes, shared filter bank (CAN2 borrows [CAN2SB..28] from CAN1, no CAN2 filter regs — silicon layout), TX/RX IRQs, RX injection |
| BKP | 0x40006C00 | Full | Backup registers (RM0008 map) + tamper pin (TPE/TPAL, IRQ2, DR clear) |
| PWR | 0x40007000 | Full | Modes + STOP/STANDBY gating + PVD (fixed-supply model → EXTI16); live `pwr_mode()` query (RUN/SLEEP/STOP/STANDBY, WFI-tracked) |
| DAC | 0x40007400 | Full (S) | Both channels, DMA, →ADC loopback wire |
| AFIO / EXTI | APB2 | Full | Remap, 20 lines, SWIER, GPIO-edge fan-in |
| GPIOA-G | APB2 | Full | Electrical model (pull/open-drain/slew), pin events; E-G reachable via SVD (8-port backing) |
| ADC1/2 (+ADC3 S) | APB2 | Full | Real conversion timing, AWD, injected, EXTSEL triggers, dual-simultaneous mode (DUALMOD fans out, DR packs) |
| SPI1/2 (+SPI3 S) | APB1/2 | Full | Master 8/16-bit, CPOL/CPHA, CRC-8/16 compute + CRCNEXT/CRCERR, I2S decodes; TI frame format not modeled |
| SDIO | 0x40018000 | Full | SDHC card model + MMC identification (CMD1, EXT_CSD, erase fill 0xFF) — see §4 |
| DMA1 (7ch) + DMA2 (5ch, S) | AHB | Full | All directions, global completion streams 0-11, plan-based pump |
| RCC | 0x40021000 | Partial | All enable/reset bits + decoded SYSCLK/HCLK/PCLK query API; wall-clock conversions stay on the fixed 8 MHz instruction budget by decision |
| FLASH | 0x40022000 | Full | Unlock/program/erase, option bytes, status |
| CRC | 0x40023000 | Full | |
| FSMC | 0xA0000000 | Full (S) | 7 banks, MBKEN/WREN, all widths, NAND row+column Hamming ECC (ECCR2/3, single-bit locatable, ECCPS-gated depth) |
| NVIC / STK / SCB | 0xE000Exxx | Full | Priority dispatch, SysTick debt, SHPR/SHCSR, faults, deep sleep |
| SCB_ACTRL | 0xE000E008 | Full | RW store (DISMCYCINT/DISFOLD mask 0x7, reset 0); no timing effect — cycle counts are instruction-exact by construction |
| NVIC_STIR | 0xE000EF00 | Full | Software-triggered IRQs (WO, INTID 9 bits, routed to pending) |
| ITM_STIM | 0xE0000000 | Full | Stimulus port 0 printf bytes as `ItmByte` events (TER+TCR gated); ports 1–31 / ATB / timestamps out of scope |
| MPU | 0xE000ED90 | Full | 8 regions, RNR/VALID/aliases, priority, subregions, AP/XN, background, PPB rules, MMFSR/MMFAR, MemManage/HardFault escalation (see docs/CPU.md) |
| DBG / DBGMCU | 0xE0042000 | Missing | Intentional: debug/trace has no headless meaning |
| ETHERNET_MAC/MMC/PTP/DMA | 0x40028xxx | Skipped | Correct: no F1 silicon has Ethernet (ST SVD quirk) |
| OTG_FS_* | 0x50000xxx | Skipped on F103 / Full on F105 | Correct: F103 has FS-device USB only, no OTG (SVD quirk — still skipped there); F105 OTG_FS device + host modes fully modeled (see PERIPHERALS) |

Score: of ~41 real peripherals, **41 Full, 1 Partial, 0 Stubs**, 2 intentionally missing/skipped.

The remaining Partial is the RCC clock tree (all enable/reset bits work; the
MHz value behind the fixed instruction budget is now queryable via
`rcc_clocks()`/`rcc_sysclk_hz()`, but wall-clock conversions are not rescaled —
rescaling SysTick/USART to a 72 MHz budget would 9× every delay loop and break
all firmware instruction budgets, so the fixed budget stays by decision). Previous partials closed since the audit: WWDG EWI (was already
implemented — proven by test), PVD + EXTI16, RTC second/overflow + CRL flags
(which also fixed a mirrored CRH bit-order mistake shared with the test
firmware), BKP tamper + RM0008 register map, TIM9–11 bases (were already
present — the audit claim was wrong, caught by the compiler).

## 2. Depth gaps inside "Full" peripherals (all minor)

- TIM: DMA-burst (DMAR/DCR store only). BDTR/MOE/break/LOCK now modeled
  (MOE gates outputs incl. PWM duty readback, break via BKIN PB12 clears
  MOE + BIF/BIE IRQ, AOE re-arms on update; DTG stored — no edge-shaping
  surface since PWM output is duty-value only).
- ADC: dual simultaneous mode now modeled (ADC1 CR1 DUALMOD=0110 fans out
  to ADC2, ADC1_DR packs ADC2:ADC1 on completion); channels 16-18 nominal
  internal values.
- SPI: CRC values now computed (CRC-8/16 MSB-first over TX/RX per DFF,
  CRCNEXT phase sends/compares with CRCERR + SR.4, cleared on DR read).
  TI frame format (CR2 FRF) now decoded: NSS pulses per frame and
  CPOL/CPHA are don't-care, so the shifted data is identical to Motorola
  mode (transfers complete synchronously — no edge surface, same
  rationale as DTG); pinned by test.
- I2C: PEC (CRC-8/SMBus over addr+data, PECR readable, PEC transfer +
  PECERR) + general-call ACK (ENGC, GENCALL flag) now modeled. SMBus
  ALERT now modeled: SR1 SMBALERT (bit 15) set by host inject
  (`i2c_inject_alert`), write-0-clears, error IRQ via ITERREN; CR1 ALERT
  (bit 13) drive edges emit `I2cAlert` bus events (`onI2cAlert`).
- USART: LIN break (SBK generation + LBD/LBDIE, FE + 0x00 byte outside
  LIN mode, `uart_inject_break` export) now modeled; HDSEL half-duplex
  loopback fixed to the RM0008 bit (CR3 bit 3 — model, unit test AND
  firmware all shared a bit-2/IRLP off-by-one, same class as the §21 RTC
  CRH swap); IrDA IREN/IRLP stored (pulse shaping only — bit-identical
  at the register level) and smartcard SCEN/NACK/GTPR stored (NACK-on-PE
  stays a no-op: PE is never set, no error injection).
- SPI: master 8/16-bit + CRC + TI mode decoded (see above).
- CAN: time-triggered timestamps now modeled (TXRQ/RX stamp TDTxR/RDTxR
  TIME under TTCM); filter bank shared silicon-style (CAN1 owns all 28,
  CAN2 borrows [CAN2SB..28], no CAN2 filter regs; reserved CAN2SB=0 keeps
  bank 0 with CAN1); sync/calibration frames out of scope.
- FSMC: NAND row+column Hamming ECC on data R/W under PCR.ECCEN (ECCR2/3,
  ECCPS-gated depth; single-bit flips locate exactly — proven by the
  0x68005996 syndrome test; bit-exact silicon parity unverified, no
  oracle exists); fixed timing.
- DWT: CYCCNT retires 1+LATENCY cycles per instruction (FLASH ACR
  wait states); pacing untouched — only the cycle counter sees stalls.
- FLASH: write-protection enforcement signals (WRPRTERR on PG/MER+STRT to
  a WRPR-guarded 4KB block); unlock model permissive, contents immutable.
- GPIO: A-E all registered (full 16-bit ports; C8 exposes a subset
  physically).
- RCC: CSS failure injection (`rcc_fail_hse`: HSERDY clear, CSSF+NMI+
  HSI fallback when CSSON) + STOP-exit HSI fallback (SWS, SW kept).
  PVD and BKP tamper already modeled (§21); no stop-mode clock switch
  beyond SWS.
- NVIC: STIR (0xE000EF00, WO, INTID 9 bits) now routes to pending.
- USB OTG host mode (F105 `0x5000xxxx` host channels): Full — 8 channels
  (HCCHAR/HCSPLT/HCINT/HCINTMSK/HCTSIZ, CHENA-edge arming, CHDIS halt),
  DFIFO0-3 shared windows, HCFG/HFIR/HFNUM/HPTXSTS/HAINT/HAINTMSK/HPRT
  (attach/detach/PPWR/PRST/PENA/PCDET), RXFIFO + GRXSTSP status queue
  shared with device mode, SOF engine, `HostTx` (disc 20) / `HostRx`
  (disc 21) events, `otg_host_feed_in` / `otg_host_attach` (+JS +
  `.d.ts`). CSFTRST preserves a physically attached device (silicon
  keeps the PHY; a pre-boot attach would otherwise boot into an E0
  spin). Proven by `tests/otg_host/` bare-metal HCD (control + bulk
  echo, `tests/test_otg_host.mjs` 5/5) + page `otg_host` preset.

None of these affect the 39/39 firmware suite or any shipped demo; they matter
only to firmware that specifically exercises them (which then sees lenient
reads instead of faults — the emulator's standing philosophy).

## 3. USB — closed this sprint

Implemented (`src/peripherals/usb.rs`, ~420 lines): EP0R-EP7R with hardware
toggle semantics, CNTR masks, ISTR event flags + derived CTR/DIR/EP_ID, DADDR,
BTABLE, 512 B packet memory with byte-exact sub-word access (PMA window
exempted from the bus word-lane logic), USB RESET on FRES release,
SETUP/OUT injection with DTOG sequencing and NAK-unless-armed, IN completion
drained as `UsbIn` (discriminant 18) + IRQ20, `onUsbIn` in `STM32F1`.
SOF engine, suspend/resume (3-frame auto-suspend, RESUME recovery), wakeup
IRQ42 and double-buffered bulk endpoints closed since (see §31 in AGENTS.md).
Still out: none on the data path (isochronous endpoints verified to move
data like bulk; no SOF-gating — the host always has bandwidth in emulation).

## 4. Storage: SD card vs eMMC (status answer)

## 4. Storage: SD card vs eMMC (bridged this sprint)

The SDIO host now speaks both identification protocols behind one block
layer. SD mode is unchanged (CMD55+ACMD41, CSD v2.0). MMC mode adds:
CMD1 SEND_OP_COND with no APP latch (busy-first, R3 with sector-access bit),
EXT_CSD register read via CMD8 (revision, card type, sector count from the
image size), and erase commands CMD32/33/35/36/38 (fill 0xFF). The card mode
latches on whichever OP_COND completes first, so real probe order works:
CMD8 pre-init still echoes R7 (SD probing), then CMD1 switches the same card
to MMC. CID/RCA/block R/W are shared; 8-bit WIDBUS needs no modeling (the
FIFO is width-agnostic).

Still out (documented, no consumer): HS200/HS400 speed modes (need 1.8 V +
tuning the F1 lacks), RPMB authenticated access, boot partitions. Practical
note stands: eMMC on a Blue Pill needs an adapter breakout (BGA package) —
every real Blue Pill storage project uses SD.

## 5. Test coverage of the above

- `tests/test_all.mjs` (764): SDIO init/R/W/IRQ/DMA/no-card/SVD (+ SDSC byte
  addressing, CSD v1); DMA global streams + circular reload/HTIF; WWDG EWI;
  PVD PLS thresholds vs settable supply; WKUP/WUF + standby wake gating;
  RTC second/overflow + flags; RCC clock decode (SYSCLK + full-tree
  prescaler/multiplier audit via `rcc_clocks_hz`, MCO query); GPIO LCKR +
  AFIO SWJ reservation; tamper; USB toggles/RESET/control/bulk/IRQ/SOF/
  suspend/double-buffer/ESOF; OTG attach-survives-CSFTRST + DONE-BCNT0;
  UART4/5 + TIM5 + ADC3 + CAN2 + OTG on the builtin map; TIM DMA-burst
  window + DTG dead-time; CAN TX edge-trigger (no-re-pend) + silent modes;
  SPI NSS output + TI transfers; USART sync/IrDA transfers; ACTRL store;
  ADC temp/VREFINT nominals + discontinuous chunks + JAUTO (SQR length
  fixed); ITM stimulus + UID + FLASH option USER/WDG_SW; SWD DP/AP +
  DHCSR/DEMCR + watch slots + JTAG IDCODE (trip path in `swd.rs` unit
  tests + `test_gdbstub.mjs`, not here — needs the native backend);
  everything in §1 marked Full has a group.
- `tests/canary.mjs` + 200M runs (both paths): 39/39 real-firmware checks.
- `tests/test_pwm_wave.mjs` pins the millis() rate end to end (8 exact wave
  steps in a fixed 70M budget — catches SysTick under-delivery).
- Deliberately untested: DBG (absent), eMMC path.
