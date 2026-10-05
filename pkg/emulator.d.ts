// TypeScript declarations for pkg/emulator.js
// The core STM32F1 WASM emulator API.

/** Parse Intel HEX text into bytes + lowest load address. */
export function parseIntelHex(text: string): { data: Uint8Array; base: number };

/** Parse GNU ld `.map` output into symbol entries. */
export function parseSymbolMap(text: string): Array<{ name: string; addr: number }>;

/** Parse ELF32 (ARM little-endian) into loadable regions + symbols. */
export function parseElf(buffer: ArrayBuffer | Uint8Array): {
  regions: Array<{ start: number; data: Uint8Array }>;
  symbols: Array<{ name: string; addr: number }>;
};

// ── createEmulator options ──────────────────────────────────────────────────

export interface ExtDevices {
  spi_flash?: Array<{
    peripheral: string | number;
    jedec_id: number | string;
    data?: Uint8Array;
    cs?: string | null;
  }>;
  i2c_eeprom?: Array<{
    peripheral: string | number;
    address: number | string;
    data?: Uint8Array;
  }>;
  i2c_oled?: Array<{
    peripheral: string | number;
    address?: number | string;
    width?: number | string;
    height?: number | string;
  }>;
  lcd?: Array<{
    peripheral: string | number;
    cs?: string | null;
  }>;
  touchscreen?: Array<{
    peripheral: string | number;
    touch_detected_pin?: string | null;
    cs?: string | null;
  }>;
  software_spi?: Array<{
    name: string;
    cs?: string | null;
    clk: string;
    miso: string;
    mosi: string;
  }>;
  fsmc_bank?: Array<{
    name: string;
    data?: Uint8Array;
    /** Blank-image size in bytes (alternative to data: zero-filled). */
    size?: number;
  }>;
  sd_card?: Array<{
    peripheral: string | number;
    data?: Uint8Array;
  }>;
}

export interface JsPeripheral {
  base: number;
  size: number;
  read: (addr: number, size: number) => number;
  write: (addr: number, value: number, size: number) => void;
}

export interface CreateEmulatorOptions {
  /** Firmware to load. Raw binary, ELF (auto-detected), or Intel HEX string. */
  firmware?: Uint8Array | ArrayBuffer | string;
  /** Flash region size in bytes (default 0x10000 = 64KB). */
  flash_size?: number;
  /** SRAM size in bytes (default 0x5000 = 20KB). */
  ram_size?: number;
  /** Vector table base address (default 0x08000000). */
  vector_table?: number;
  /** SVD XML string (optional; overrides the builtin F103C8 map). */
  svd?: string | null;
  /** Chip identifier, `{name, svd}` object, or builtin variant name
   *  (stm32f103cb, maple_mini, nucleo_f103rb, stm32f103rc,
   *  gd32f103c8/cb/rb — sizes + DBGMCU IDCODE from the table). */
  chip?: string | { name: string; svd?: string; flash?: number; ram?: number; idcode?: number };
  /** rp2040js-style custom peripherals. */
  js_peripherals?: JsPeripheral[];
  /** USART base address used by uartRx() (default 0x40013800 = USART1). */
  uart_addr?: number;
  /** External device attachments (SPI flash, I2C EEPROM, OLED, LCD, etc.). */
  ext_devices?: ExtDevices;
  /** Print init info to console. */
  verbose?: boolean;
  /** Fixed batch size (overrides the adaptive 20K/50K policy). */
  batch_size?: number;
}

// ── Register set returned by getRegisters() ─────────────────────────────────

export interface Registers {
  R0: number; R1: number; R2: number; R3: number;
  R4: number; R5: number; R6: number; R7: number;
  R8: number; R9: number; R10: number; R11: number; R12: number;
  SP: number; LR: number; PC: number; xPSR: number;
}

// ── BluepillEmulator (returned by createEmulator) ───────────────────────────

export interface RunResult {
  totalSteps: number;
  instCount: number;
  stopped: boolean;
}

export interface StepResult {
  pc: number;
  instCount: number;
  stopped: boolean;
}

export interface BluepillEmulator {
  /** Raw 32-bit word read (used by drivers for RAM flags). */
  read32: (addr: number) => number;
  /** Raw 32-bit word write. */
  write32: (addr: number, val: number) => void;

  // ── Execution ─────────────────────────────────────────────────────────────

  /** Run up to N instructions (0 = forever). Loops adaptive 20K/50K batches. */
  run(maxInstructions?: number): RunResult;
  /** Run one batch (default 20K instructions), process DMA/interrupts/pin events. */
  step(maxBatch?: number): StepResult;
  /** Request stop of a running run() loop. */
  stop(): void;
  /** Configured batch size (`batch_size` create opt, default 20000). */
  getBatchSize(): number;
  /** Cumulative retired-instruction counter. */
  getInstCount(): number;
  /** Tear down the emulator (no-op; state resets on init). */
  close(): void;

  // ── CPU state ─────────────────────────────────────────────────────────────

  /** Read all ARM registers. */
  getRegisters(): Registers;
  /** Read program counter. */
  getPc(): number;
  /** Read stack pointer. */
  getSp(): number;
  /** Write program counter. */
  setPc(pc: number): void;
  /** Write a core register by index (0-12, 13=SP bank-synced, 14=LR, 15=PC). */
  setReg(i: number, v: number): void;

  // ── Symbol resolution ─────────────────────────────────────────────────────

  /** Set symbol table for resolveSymbol(). Pass null to clear. */
  setSymbols(list: Array<{ name: string; addr: number }> | null): void;
  /** Number of loaded symbols. */
  getSymbolCount(): number;
  /** Resolve address to nearest symbol (e.g. 'main+0x1e'). */
  resolveSymbol(addr: number): string | null;

  // ── UART ──────────────────────────────────────────────────────────────────

  /** Collect USART1 TX output since last call. */
  getUartOutput(): string;
  /** Inject byte into UART RX (default USART1). */
  uartRx(byte: number): boolean;
  /** Inject byte into specific USART by base address. */
  uartRxAddr(addr: number, byte: number): boolean;
  /** Inject multiple bytes into UART RX. */
  uartRxBytes(bytes: Uint8Array | number[]): boolean;
  /** Inject a LIN break into a USART (LBD in LIN mode, framing error + 0x00 byte otherwise). */
  uartInjectBreak(addr: number): boolean;
  /** Unread bytes in UART RX buffer. */
  rxPending(): number;
  /** True while a DMA transfer is queued. */
  dmaPending(): boolean;

  // ── DMA (direct channel access, RM0008 DMA1 @0x40020000 / DMA2 @0x40020400) ──

  /** DMA ISR flags word for controller 1|2 (default 1). */
  dmaIsr(dma?: number): number;
  /** DMA channel config word (CCR). */
  dmaGetCcr(dma: number, ch: number): number;
  /** DMA remaining transfer count (CNDTR). */
  dmaGetNdtr(dma: number, ch: number): number;
  /** DMA peripheral address (CPAR). */
  dmaGetPar(dma: number, ch: number): number;
  /** DMA memory address (CMAR). */
  dmaGetMar(dma: number, ch: number): number;
  /** Program a DMA channel (CCR write of EN=1 queues the transfer). */
  dmaSetChannel(dma: number, ch: number, fields: { ccr?: number; ndtr?: number; par?: number; mar?: number }): void;
  /** Clear DMA ISR flags via IFCR (write-1-clears mask). */
  dmaClearFlags(dma: number, mask: number): void;
  /** Raw queued-transfer count (number of DMA plans awaiting the pump). */
  dmaQueueCount(): number;
  /** Raw queued transfer descriptors (flat u32s, 7 per plan). PEEK ONLY: consumes the queue. */
  dmaQueuePeek(): number[];
  /** Raw queued transfer descriptor at index (flat u32s, 7 per plan). PEEK ONLY: consumes that entry. */
  dmaQueueAt(index: number): number[];
  /** Manually run one DMA pump outside run()/step() (normally automatic per batch). */
  dmaPump(): number[];
  /** Bytes absorbed by the last pump from a periph→mem leg (offset, len). */
  dmaTakeAbsorbed(offset: number, len: number): Uint8Array;
  /** Absorb `size` bytes from a peripheral register (periph→mem leg helper). */
  dmaAbsorb(addr: number, size: number): Uint8Array;
  /** Push bytes into a peripheral register (mem→periph leg helper). */
  dmaPush(addr: number, bytes: Uint8Array | number[]): void;
  /** Signal completion for one stream (fires its TC IRQ when TCIE armed). */
  dmaComplete(stream: number): void;
  /** Signal transfer completion for stream bits (fires TC IRQs when TCIE armed). */
  dmaCompleteMany(bits: number): void;
  /** True while any IRQ (or SysTick debt) is pending delivery. */
  irqPending(): boolean;
  /** Pop the next pending IRQ number (-255 none, -1 SysTick, -14..-5 system). Pairs with irqReturn(). */
  irqNext(): number;
  /** Return from a taken IRQ (clears active-priority entry + IABR bit). */
  irqReturn(): void;
  /** Return from a taken IRQ with SysTick debt drain (driver dispatch path). */
  irqFinish(irq: number): void;

  // ── GPIO ──────────────────────────────────────────────────────────────────

  /** Read driven output level (port: 0=A, 1=B, 2=C). */
  gpioReadOutput(port: number, pin: number): boolean;
  /** Read input level. */
  gpioReadInput(port: number, pin: number): boolean;
  /** Drive an external input into a pin. */
  gpioSetInput(port: number, pin: number, value: boolean): void;
  /** Set analog wire voltage (12-bit, 0xFFFF clears). */
  gpioSetAnalog(port: number, pin: number, level: number): void;
  /** PWM duty (0-100) of a timer channel. */
  pwmDuty(addr: number, channel?: number): number;

  // ── ADC / Analog ──────────────────────────────────────────────────────────

  /** Set ADC simulation value. */
  setSimAdc(value: number): void;
  /** Set RC sample-and-hold time constant in ADC cycles. */
  adcSetRcTau(cycles: number): void;

  // ── Touchscreen ───────────────────────────────────────────────────────────

  /** Set touch coordinates on a touchscreen device. */
  setTouch(peripheral: string, x: number, y: number, pressure: number): void;

  // ── CAN ───────────────────────────────────────────────────────────────────

  /** Inject CAN message; returns true if accepted. */
  canInjectMessage(addr: number, tir: number, tdtr: number, tdlr: number, tdhr: number): boolean;
  /** Inject a USB SETUP packet (8 bytes) into EP0. addr selects hardware address filtering (omit = correctly addressed). Returns false when NAKed/filtered. */
  usbInjectSetup(bytes: Uint8Array, addr?: number): boolean;
  /** Inject a USB OUT packet into an endpoint. addr selects hardware address filtering (omit = correctly addressed). Returns false when NAKed/filtered. */
  usbInjectOut(ep: number, bytes: Uint8Array, addr?: number): boolean;
  /** Real bus reset (SE0 on the wire): FRES release alone is NOT a reset. */
  usbBusReset(): boolean;
  /** Host disconnect (pull-up off): tokens stop, IN stalls, SOF freezes; next bus reset reattaches. */
  usbDetach(): boolean;
  /** Inject a USB OTG_FS SETUP packet (8 bytes) into EP0. addr selects DCFG.DAD filtering (omit = correctly addressed). Returns false when dropped. */
  otgInjectSetup(bytes: Uint8Array, addr?: number): boolean;
  /** Inject a USB OTG_FS OUT packet into an endpoint. addr selects DCFG.DAD filtering (omit = correctly addressed). Returns false when dropped. */
  otgInjectOut(ep: number, bytes: Uint8Array, addr?: number): boolean;
  /** Host-driven OTG_FS bus reset (SE0): endpoints + FIFOs + address reset, USBRST + ENUMDNE. */
  otgBusReset(): boolean;
  /** Host disconnect on OTG_FS (pull-up off); next bus reset reattaches. */
  otgDetach(): boolean;
  /** Answer a pending OTG_FS host IN token on ep with data (or STALL it). */
  otgHostFeedIn(ep: number, bytes: Uint8Array, stall?: boolean): boolean;
  /** Virtual-device attach/detach on the OTG_FS host port. */
  otgHostAttach(present: boolean): boolean;

  // ── Bus observers ─────────────────────────────────────────────────────────

  /** Watch every peripheral register write; returns unsubscribe function. */
  onPeriphWrite(fn: (addr: number, width: number, value: number) => void): () => void;
  /** Watch chip-driven GPIO level changes; returns unsubscribe function. */
  onPinChange(fn: (port: number, pin: number, level: number) => void): () => void;

  // ── Event queue ───────────────────────────────────────────────────────────

  /** Drain buffered pin-change events (flat [port, pin, level, ...]). */
  takePinEvents(): Uint32Array | number[];
  /** Drain virtual-peripheral transaction events as flat i32 array. */
  drainEvents(): number[] | Int32Array;
  /** Queue MISO bytes for a SPI channel. */
  spiInjectMiso(channel: number, bytes: Uint8Array): void;
  /** Queue RX bytes for an I2C channel. */
  i2cInjectRx(channel: number, bytes: Uint8Array): void;
  /** Host START + address this I2C peripheral as a slave (false = NACK). */
  i2cInjectStart(channel: number, addr: number, isRead: boolean): boolean;
  /** Host data byte to an addressed slave (false = NACK). */
  i2cInjectWrite(channel: number, byte: number): boolean;
  /** Host read from an addressed slave (-1 while DR empty). */
  i2cInjectRead(channel: number): number;
  /** Host STOP to an addressed slave. */
  i2cInjectStop(channel: number): boolean;
  /** SMBus ALERT input: peer pulled SMBA low → SR1 SMBALERT + ER IRQ (ITERREN). */
  i2cInjectAlert(channel: number): boolean;
  /** Enable/disable the AN3155 bootloader responder (claims USART1 RX while on). */
  bootloaderEnable(on: boolean): void;
  /** Last GO target address issued to the bootloader, or -1 when none. */
  bootloaderGoAddr(): number;
  /** Override internal ADC channel 16/17/18 (temp/VREF/VBAT); 65535 clears to nominal. */
  adcSetInternal(channel: number, value: number): void;
  /** Live power state: 0=RUN, 1=SLEEP, 2=STOP, 3=STANDBY. */
  pwrMode(): number;
  /** Live current-draw estimate in µA (DS5319-typical, uncalibrated). */
  pwrEstimate(): number;
  /** Set the PVD supply rail in mV (default 3300). Returns PVDO (true = below threshold). */
  pwrSetSupplyMv(mv: number): boolean;
  /** Decoded SYSCLK in Hz (follows CFGR SWS: HSI/HSE/PLL). */
  rccSysclkHz(): number;
  /** Full clock tree [sysclk, hclk, pclk1, pclk2] in Hz. */
  rccClocksHz(): number[];
  /** MCO pin output in Hz (0 = off). */
  rccMcoHz(): number;
  /** Fail the HSE oscillator (CSS: CSSF + NMI + HSI fallback when CSSON). */
  rccFailHse(): boolean;
  /** GPIO output slew in instructions (IDR settles this long after a drive). */
  gpioSetSlew(n: number): void;
  /** I2C OLED byte-write counter (display traffic probe). */
  i2cOledWrites(peripheral: string, address?: number): number;

  // ── OLED / LCD framebuffers ───────────────────────────────────────────────

  /** I2C OLED framebuffer (page-major, 1 byte/column). */
  i2cOledFb(peripheral: string, address?: number): Uint8Array | null;
  /** SPI LCD framebuffer (128x64, 1 byte/pixel). */
  lcdFb(peripheral: string): Uint8Array | null;

  // ── FSMC ──────────────────────────────────────────────────────────────────

  /** Write byte directly into FSMC backing image. */
  fsmcWriteByte(name: string, offset: number, value: number): boolean;
  /** Read byte from FSMC backing image (-1 on error). */
  fsmcReadByte(name: string, offset: number): number;

  // ── Low-level peripheral access ───────────────────────────────────────────

  /** Read peripheral register (width: 1, 2, or 4 bytes; default 4). */
  periphRead(addr: number, width?: number): number;
  /** Write peripheral register. */
  periphWrite(addr: number, width: number, value: number): void;
  /** Read 32-bit word from emulated memory. */
  memRead32(addr: number): number;
  /** Raw guest-memory write (bypasses flash protection + MPU, like a probe). */
  memWriteBytes(addr: number, bytes: Uint8Array | number[]): void;
  /** Last CPU fault ([pc, op]) since the previous call, if any. */
  takeFault(): [number, number] | null;

  // ── Board hardware: NRST / BOOT0 / LED identity ──────────────────────────

  /** NRST press: model reset + CPU/RAM reloaded, counters zeroed. Returns true when BOOT0 claims the bootloader path. */
  reset(): boolean;
  /** Strap the BOOT0 jumper (true = boot system memory / bootloader). */
  setBoot0(high: boolean): void;
  /** Read back the BOOT0 strap level. */
  getBoot0(): boolean;
  /** Wiring facts for the current chip: LED, user button (null when the board has none), BOOT0/NRST presence, clocks. */
  boardInfo(): { led: { port: number; pin: number; name: string }; button: { port: number; pin: number; level: string; name: string } | null; boot0: boolean; nrst: boolean; crystalHz: number; maxSysclkMhz: number };

  // ── ARM debug-port slice (SWD + JTAG-DP + watchpoints) ────────────────────

  /** True while the core is halted (DHCSR C_HALT / watchpoint / VC). */
  swdHalted(): boolean;
  /** External halt request (sets C_DEBUGEN+C_HALT, like a probe). */
  swdHalt(): void;
  /** Debugger resume (clears C_HALT; C_DEBUGEN stays, like silicon). */
  swdResume(): void;
  /** Single-step the halted core once (returns 0/1 executed). */
  swdStep(): number;
  /** Install a data watchpoint (kind 1=write/Z2, 2=read/Z3, 3=access/Z4). Returns slot or -1. */
  swdAddWatch(kind: number, addr: number, len: number): number;
  /** Remove a data watchpoint by slot. */
  swdRemoveWatch(slot: number): void;
  /** Pending watch trip ([] clean, else [addr, dir 1=write/2=read]). */
  swdTakeTrip(): number[];
  /** SWD DP register read/write (0x0 DPIDR, 0x4 CTRL/STAT, 0x8 SELECT, 0xC RDBUFF). */
  swdDpRead(addr: number): number;
  swdDpWrite(addr: number, value: number): void;
  /** MEM-AP register read/write (bank, reg); bank-0 reg 0xC (DRW) moves TAR-width data. */
  swdApRead(bank: number, reg: number): number;
  swdApWrite(bank: number, reg: number, value: number): void;
  /** DCRSR-style core register access (0-12, 13 SP, 14 LR, 15 PC, 16 xPSR, 17 MSP, 18 PSP). */
  swdRegRead(idx: number): number;
  swdRegWrite(idx: number, value: number): void;
  /** Minimal JTAG TAP sharing the DP (probe helper). */
  jtagReset(): void;
  jtagIr(ir: number): void;
  jtagIdcode(): number;
  jtagDp(addr: number, rnw: boolean, wdata: number): number;
  jtagAp(bank: number, reg: number, rnw: boolean, wdata: number): number;

  // ── Custom peripherals / Interrupt control ────────────────────────────────

  /** Register rp2040js-style custom peripheral. */
  addJsPeripheral(base: number, size: number, read: (addr: number, size: number) => number, write: (addr: number, value: number, size: number) => void): boolean;
}

/** Create a full STM32F103C8 emulator instance. */
export function createEmulator(opts?: CreateEmulatorOptions): Promise<BluepillEmulator>;

/** Builtin chip table (flash/RAM sizes, DBGMCU IDCODE, label). */
export const CHIPS: Record<string, { flash: number; ram: number; idcode: number; label: string }>;

/** Chip descriptor for a `chip` name (default: stm32f103c8 entry). */
export function chipInfo(name?: string): { flash: number; ram: number; idcode: number; label: string };
