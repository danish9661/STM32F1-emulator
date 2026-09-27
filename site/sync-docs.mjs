// site/sync-docs.mjs — copy user-facing markdown into site/docs-src/ so the
// pages site (GitHub Pages serves ONLY site/) can render docs live.
// Run after editing any source doc, then commit the result together:
//   node site/sync-docs.mjs && git add -A
// CI re-runs it and fails on drift (like the pkg/site wasm guard).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'site', 'docs-src');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

// [source path (repo root), title, blurb]
const DOCS = [
  ['README.md', 'Readme', 'Project overview, quick start, supported peripherals'],
  ['docs/USAGE.md', 'Usage guide', 'createEmulator options, ext_devices, chips, plugins'],
  ['docs/PERIPHERALS.md', 'Peripheral coverage', 'What each peripheral models, flags, IRQs, gaps'],
  ['docs/BOARDS.md', 'Boards & chips', 'Variants, ID codes, pin aliases, bring-up'],
  ['docs/boards/blue-pill.md', 'Board: Blue Pill', 'F103C8 reference target notes'],
  ['docs/boards/gd32f103c8.md', 'Board: GD32F103C8', 'Clone-contract notes'],
  ['docs/boards/maple-mini.md', 'Board: Maple Mini', 'F103CB D33 LED, DFU note'],
  ['docs/boards/nucleo-f103rb.md', 'Board: Nucleo-F103RB', 'USART2 Serial, Arduino headers'],
  ['docs/boards/f103rc.md', 'Board: F103RC', 'High-density set (DAC/FSMC/ADC3)'],
  ['docs/boards/f105.md', 'Board: STM32F105', 'CAN2 + OTG notes, SVD map'],
  ['docs/GDB.md', 'Debugging with GDB', 'RSP stub walkthrough, fidelity notes'],
  ['docs/STM32F1_API.md', 'JavaScript API', 'STM32F1 wrapper, events, injection'],
  ['docs/STM32F1_Guide.md', 'User Guide (full manual)', 'Architecture to API: the whole emulator in one document'],
  ['docs/COVERAGE.md', 'Coverage audit', 'SVD census, depth gaps, test counts'],
  ['docs/CPU.md', 'CPU core', 'Decoder, memory protection, exceptions, banks'],
  ['docs/ARCHITECTURE.md', 'Architecture', 'Emulation loop, batching, performance'],
  ['docs/WEBSOCKET_BRIDGE.md', 'WebSocket bridge', 'Headless server + browser viewer'],
  ['docs/AUDIT.md', 'Audit (historical)', 'Memory, security and overhead notes'],
  ['docs/NEXT_PHASE.md', 'Next phase (historical)', 'Deferred optimization ideas'],
  ['docs/PATH_B.md', 'Path B: native CPU', 'Pure-Rust core cutover notes'],
  ['docs/summary.md', 'Summary (historical)', 'Frozen project summary'],
  ['CHANGELOG.md', 'Changelog', 'Release history'],
];

const manifest = [];
for (const [src, title, blurb] of DOCS) {
  const text = readFileSync(join(root, src), 'utf8');
  const base = src.split('/').pop();
  writeFileSync(join(outDir, base), text);
  manifest.push({ file: base, title, blurb });
}
writeFileSync(join(root, 'site', 'docs.json'), JSON.stringify(manifest, null, 1) + '\n');
console.log(`synced ${manifest.length} docs -> site/docs-src/ + site/docs.json`);
