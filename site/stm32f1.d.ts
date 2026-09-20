// TypeScript declarations for pkg/stm32f1.js
// Ergonomic STM32F1 wrapper with Wokwi-style virtual-peripheral events.
//
// Re-exports from emulator.js:
export { parseIntelHex, parseSymbolMap, parseElf } from './emulator.js';
export type { CreateEmulatorOptions, ExtDevices, BluepillEmulator } from './emulator.js';

// ── GPIO ────────────────────────────────────────────────────────────────────

export class GPIOPin {
  readonly port: string;  // 'A' | 'B' | 'C'
  readonly pin: number;   // 0..15

  constructor(mcu: STM32F1, port: string, pin: number);

  /** Subscribe to chip-driven output level changes. Returns unsubscribe fn. */
  on(event: 'change', cb: (high: boolean) => void): () => void;
  /** Driven output level (0 or 1). */
  read(): 0 | 1;
  /** Input level (from external driver or pull). */
  readInput(): 0 | 1;
  /** Drive an external input (e.g. simulate a button press). */
  setInput(high: boolean): void;
  /** Set analog voltage (0..4095). */
  setAnalog(val: number): void;
}

export class GPIO {
  constructor(mcu: STM32F1);
  /** Get a pin handle. port is 'A'|'B'|'C' or 0|1|2. */
  pin(port: string | number, pin: number): GPIOPin;
}

// ── USART ───────────────────────────────────────────────────────────────────

export class USART {
  readonly n: 1 | 2 | 3;
  /** Fires for every byte the MCU transmits (TX). Set to null to remove. */
  onData: ((byte: number) => void) | null;

  constructor(mcu: STM32F1, n: 1 | 2 | 3);

  /** Inject bytes into this USART's RX (host -> MCU). */
  send(data: string | Uint8Array | number[]): void;
  /** Accumulated TX output string for this USART. */
  get output(): string;
}

// ── SPI ─────────────────────────────────────────────────────────────────────

export class SPI {
  readonly ch: number;  // 1..6
  /** Fires on every SPI DR transfer. Set to null to remove. */
  onTransfer: ((channel: number, tx: number[], rx: number[]) => void) | null;

  constructor(mcu: STM32F1, ch: number);

  /** Queue MISO bytes the MCU will read on the next transfers. */
  injectMiso(bytes: Uint8Array | number[]): void;
}

// ── I2C ─────────────────────────────────────────────────────────────────────

export class I2C {
  readonly ch: number;  // 1..3
  /** Fires on START condition (7-bit address). Set to null to remove. */
  onStart: ((addr: number) => void) | null;
  /** Fires on byte written by master. Set to null to remove. */
  onWrite: ((byte: number) => void) | null;
  /** Fires on read request (master requests a byte). Set to null to remove. */
  onRead: (() => void) | null;
  /** Fires on STOP condition. Set to null to remove. */
  onStop: (() => void) | null;

  constructor(mcu: STM32F1, ch: number);

  /** Queue RX bytes the MCU reads during master-receiver transactions. */
  injectRx(bytes: Uint8Array | number[]): void;
}

// ── STM32F1 (main class) ────────────────────────────────────────────────────

export class STM32F1 {
  // ── Static factories ──────────────────────────────────────────────────────

  static create(opts?: CreateEmulatorOptions): Promise<STM32F1>;
  static fromELF(buf: Uint8Array | ArrayBuffer, opts?: CreateEmulatorOptions): Promise<STM32F1>;
  static fromBin(buf: Uint8Array | ArrayBuffer, opts?: CreateEmulatorOptions): Promise<STM32F1>;
  static fromHex(text: string, opts?: CreateEmulatorOptions): Promise<STM32F1>;

  // ── Bus accessors ─────────────────────────────────────────────────────────

  readonly gpio: GPIO;

  readonly usart1: USART;
  readonly usart2: USART;
  readonly usart3: USART;
  readonly usart: { 1: USART; 2: USART; 3: USART };

  readonly spi1: SPI;
  readonly spi2: SPI;
  readonly spi3: SPI;
  readonly spi: { 1: SPI; 2: SPI; 3: SPI };

  readonly i2c1: I2C;
  readonly i2c2: I2C;
  readonly i2c3: I2C;
  readonly i2c: { 1: I2C; 2: I2C; 3: I2C };

  // ── Top-level event callbacks (set directly on instance) ───────────────────

  /** GPIO input edge -> EXTI line 0..15. */
  onExtiEdge: ((line: number) => void) | null;
  /** ADC conversion complete (adc=1/2, ch=0..17). */
  onAdcDone: ((adc: number, chan: number) => void) | null;
  /** Timer overflow/update event (tim=1..14). */
  onTimUpdate: ((tim: number) => void) | null;
  /** DAC DHR write (chan=1/2, value=12-bit). */
  onDacWrite: ((chan: number, value: number) => void) | null;
  /** CRC_DR read -> computed 32-bit result. */
  onCrcResult: ((value: number) => void) | null;
  /** RTC alarm time reached. */
  onRtcAlarm: ((alarm: number) => void) | null;
  /** Watchdog reset requested (1=IWDG, 2=WWDG). */
  onWdogReset: ((which: number) => void) | null;
  /** CAN frame queued for transmit (can=1/2, data is 8-byte array). */
  onCanTx: ((can: number, id: number, len: number, data: number[]) => void) | null;
  /** CAN frame received into FIFO (can=1/2, data is 8-byte array). */
  onCanRx: ((can: number, id: number, len: number, data: number[]) => void) | null;
  /** TIM input-capture latch (tim=1..14, ch=0..3, value=captured CNT). */
  onTimCapture: ((tim: number, ch: number, value: number) => void) | null;
  /** FSMC memory transaction (bank=1..7). */
  onFsmcAccess: ((bank: number, offset: number, write: boolean, size: number, value: number) => void) | null;
  /** USB IN completion (device -> host bytes). */
  onUsbIn: ((ep: number, data: number[]) => void) | null;
  /** SMBus SMBA drive edge (firmware CR1 ALERT bit 13). */
  onI2cAlert: ((channel: number, asserted: boolean) => void) | null;
  /** OTG_FS host OUT/SETUP completion (host -> device bytes). */
  onHostTx: ((ch: number, ep: number, setup: boolean, data: number[]) => void) | null;
  /** OTG_FS host IN token request (feed via device -> host path). */
  onHostRx: ((ch: number, ep: number, len: number) => void) | null;
  /** ITM stimulus port 0 byte (firmware printf channel). */
  onItmByte: ((port: number, byte: number) => void) | null;

  // ── Instance methods ──────────────────────────────────────────────────────

  /** Run N instructions, drain events. */
  execute(cycles: number): { instCount: number; stopped: boolean };
  /** Single batch step, drain events. */
  step(cycles: number): { pc: number; instCount: number; stopped: boolean };
  /** Stop a running loop. */
  stop(): void;
  /** Tear down (unsubscribe all callbacks + close emulator). */
  close(): void;
  /** Re-run from reset vector (recreates emulator). */
  reset(): Promise<STM32F1>;
  /** Load new ELF firmware and reset. */
  loadELF(buf: Uint8Array | ArrayBuffer): Promise<STM32F1>;
  /** Load new raw binary and reset. */
  loadBin(buf: Uint8Array | ArrayBuffer): Promise<STM32F1>;
  /** Load new Intel HEX and reset. */
  loadHex(text: string): Promise<STM32F1>;

  /** Inject byte into USART1 RX. */
  uartRx(byte: number): boolean;
  /** Accumulated USART1 TX output. */
  get uartOutput(): string;

  /** Subscribe to peripheral bus writes; returns unsubscribe function. */
  onPeriphWrite(fn: (addr: number, width: number, value: number) => void): () => void;
  /** Load GNU ld .map symbol text. */
  setSymbols(symbolText: string): void;
  /** Resolve PC to symbol name. */
  resolveSymbol(pc: number): string | null;

  /** Write byte into FSMC backing image. */
  fsmcWriteByte(name: string, offset: number, value: number): boolean;
  /** Read byte from FSMC backing image (-1 on error). */
  fsmcReadByte(name: string, offset: number): number;
}
