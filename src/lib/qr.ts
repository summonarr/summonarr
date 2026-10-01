// Minimal QR Code encoder (ISO/IEC 18004) — byte mode, all 40 versions, the
// four error-correction levels, automatic mask selection. Pure, zero-import,
// safe for "use client" modules. It exists so the two-factor setup screen can
// show the otpauth:// URI as a scannable code without a new dependency (and
// without sending the TOTP secret to any third-party QR service).
//
// The structure follows the well-known reference design by Project Nayuki
// (MIT): pick the smallest version that fits, build the data codewords, add
// Reed–Solomon ECC per block and interleave, draw function patterns, place the
// codewords in the zig-zag order, then try all eight masks and keep the one
// with the lowest penalty score. tests/qr.test.mts checks the structural
// invariants; the encoder was also verified end-to-end by decoding its output
// with an independent QR reader (CoreImage's CIDetector) across versions 1–30.

export type QrEcl = "L" | "M" | "Q" | "H";

const ECL_ORDINAL: Record<QrEcl, number> = { L: 0, M: 1, Q: 2, H: 3 };
const ECL_FORMAT_BITS: Record<QrEcl, number> = { L: 1, M: 0, Q: 3, H: 2 };

// Index [ecl ordinal][version]; index 0 of each row is unused.
const ECC_CODEWORDS_PER_BLOCK: number[][] = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];

const NUM_ERROR_CORRECTION_BLOCKS: number[][] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

const MIN_VERSION = 1;
const MAX_VERSION = 40;

export function getNumRawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

export function getNumDataCodewords(ver: number, ecl: QrEcl): number {
  const e = ECL_ORDINAL[ecl];
  return Math.floor(getNumRawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[e][ver] * NUM_ERROR_CORRECTION_BLOCKS[e][ver];
}

function getBit(x: number, i: number): boolean {
  return ((x >>> i) & 1) !== 0;
}

// ─── Reed–Solomon over GF(2^8), primitive polynomial 0x11D ──────────────────

function rsMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsComputeDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = rsMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = rsMultiply(root, 0x02);
  }
  return result;
}

function rsComputeRemainder(data: number[], divisor: number[]): number[] {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] ^= rsMultiply(coef, factor);
    });
  }
  return result;
}

// ─── encoder ────────────────────────────────────────────────────────────────

function utf8Bytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

function encodeDataCodewords(bytes: number[], ver: number, ecl: QrEcl): number[] {
  const capacityBits = getNumDataCodewords(ver, ecl) * 8;
  const bits: number[] = [];
  const append = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  append(0b0100, 4); // byte mode
  append(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) append(b, 8);
  append(0, Math.min(4, capacityBits - bits.length)); // terminator
  append(0, (8 - (bits.length % 8)) % 8); // byte-align
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) append(pad, 8);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    out.push(v);
  }
  return out;
}

function addEccAndInterleave(data: number[], ver: number, ecl: QrEcl): number[] {
  const e = ECL_ORDINAL[ecl];
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[e][ver];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[e][ver];
  const rawCodewords = Math.floor(getNumRawDataModules(ver) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsComputeDivisor(blockEccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = rsComputeRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const result: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
    });
  }
  return result;
}

function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const size = ver * 4 + 17;
  const numAlign = Math.floor(ver / 7) + 2;
  const step = Math.floor((ver * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

class Grid {
  size: number;
  modules: boolean[][];
  isFunction: boolean[][];
  constructor(size: number) {
    this.size = size;
    this.modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.isFunction = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }
  setFunction(x: number, y: number, dark: boolean): void {
    this.modules[y][x] = dark;
    this.isFunction[y][x] = true;
  }
}

function drawFinder(g: Grid, x: number, y: number): void {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      const xx = x + dx;
      const yy = y + dy;
      if (xx >= 0 && xx < g.size && yy >= 0 && yy < g.size) g.setFunction(xx, yy, dist !== 2 && dist !== 4);
    }
  }
}

function drawAlignment(g: Grid, x: number, y: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) g.setFunction(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
}

function drawFormatBits(g: Grid, ecl: QrEcl, mask: number): void {
  const data = (ECL_FORMAT_BITS[ecl] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const size = g.size;
  for (let i = 0; i <= 5; i++) g.setFunction(8, i, getBit(bits, i));
  g.setFunction(8, 7, getBit(bits, 6));
  g.setFunction(8, 8, getBit(bits, 7));
  g.setFunction(7, 8, getBit(bits, 8));
  for (let i = 9; i < 15; i++) g.setFunction(14 - i, 8, getBit(bits, i));
  for (let i = 0; i < 8; i++) g.setFunction(size - 1 - i, 8, getBit(bits, i));
  for (let i = 8; i < 15; i++) g.setFunction(8, size - 15 + i, getBit(bits, i));
  g.setFunction(8, size - 8, true); // the always-dark module
}

function drawVersion(g: Grid, ver: number): void {
  if (ver < 7) return;
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (ver << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const bit = getBit(bits, i);
    const a = g.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    g.setFunction(a, b, bit);
    g.setFunction(b, a, bit);
  }
}

function drawFunctionPatterns(g: Grid, ver: number, ecl: QrEcl): void {
  for (let i = 0; i < g.size; i++) {
    g.setFunction(6, i, i % 2 === 0);
    g.setFunction(i, 6, i % 2 === 0);
  }
  drawFinder(g, 3, 3);
  drawFinder(g, g.size - 4, 3);
  drawFinder(g, 3, g.size - 4);
  const pos = alignmentPositions(ver);
  const n = pos.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      drawAlignment(g, pos[i], pos[j]);
    }
  }
  drawFormatBits(g, ecl, 0); // placeholder; real bits drawn after masking
  drawVersion(g, ver);
}

function drawCodewords(g: Grid, data: number[]): void {
  let i = 0;
  for (let right = g.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < g.size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? g.size - 1 - vert : vert;
        if (!g.isFunction[y][x] && i < data.length * 8) {
          g.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
          i++;
        }
      }
    }
  }
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function applyMask(g: Grid, mask: number): void {
  for (let y = 0; y < g.size; y++) {
    for (let x = 0; x < g.size; x++) {
      if (!g.isFunction[y][x] && maskBit(mask, x, y)) g.modules[y][x] = !g.modules[y][x];
    }
  }
}

// ISO 18004 §7.8.3 penalty rules N1–N4. Any mask yields a VALID code; the score
// only steers toward one that scans easily.
function penaltyScore(g: Grid): number {
  const size = g.size;
  const m = g.modules;
  let score = 0;
  const lineScore = (get: (i: number) => boolean) => {
    let s = 0;
    let runColor = get(0);
    let runLen = 1;
    for (let i = 1; i < size; i++) {
      const c = get(i);
      if (c === runColor) {
        runLen++;
      } else {
        if (runLen >= 5) s += 3 + (runLen - 5);
        runColor = c;
        runLen = 1;
      }
    }
    if (runLen >= 5) s += 3 + (runLen - 5);
    // N3: 1:1:3:1:1 finder-like pattern with 4 light modules on either side.
    for (let i = 0; i + 11 <= size; i++) {
      const p = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((k) => get(i + k));
      const a = p[0] && !p[1] && p[2] && p[3] && p[4] && !p[5] && p[6] && !p[7] && !p[8] && !p[9] && !p[10];
      const b = !p[0] && !p[1] && !p[2] && !p[3] && p[4] && !p[5] && p[6] && p[7] && p[8] && !p[9] && p[10];
      if (a || b) s += 40;
    }
    return s;
  };
  for (let y = 0; y < size; y++) score += lineScore((x) => m[y][x]);
  for (let x = 0; x < size; x++) score += lineScore((y) => m[y][x]);
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = m[y][x];
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
    }
  }
  let dark = 0;
  for (const row of m) for (const c of row) if (c) dark++;
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  score += Math.max(0, k) * 10;
  return score;
}

export interface QrCode {
  version: number;
  size: number;
  ecl: QrEcl;
  mask: number;
  // modules[y][x] — true = dark.
  modules: boolean[][];
}

export function encodeQr(text: string, ecl: QrEcl = "M", forceMask?: number): QrCode {
  const bytes = utf8Bytes(text);
  let ver = MIN_VERSION;
  for (; ver <= MAX_VERSION; ver++) {
    const ccBits = ver <= 9 ? 8 : 16;
    if (bytes.length < 1 << ccBits && 4 + ccBits + bytes.length * 8 <= getNumDataCodewords(ver, ecl) * 8) break;
  }
  if (ver > MAX_VERSION) throw new RangeError("Text is too long for a QR code");

  const g = new Grid(ver * 4 + 17);
  drawFunctionPatterns(g, ver, ecl);
  drawCodewords(g, addEccAndInterleave(encodeDataCodewords(bytes, ver, ecl), ver, ecl));

  let best = forceMask ?? 0;
  if (forceMask === undefined) {
    let bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      applyMask(g, mask);
      drawFormatBits(g, ecl, mask);
      const s = penaltyScore(g);
      if (s < bestScore) {
        bestScore = s;
        best = mask;
      }
      applyMask(g, mask); // XOR undo
    }
  }
  applyMask(g, best);
  drawFormatBits(g, ecl, best);
  return { version: ver, size: g.size, ecl, mask: best, modules: g.modules };
}

// One SVG path for every dark module, with a `quiet`-module light border.
export function qrToSvgPath(qr: QrCode, quiet = 4): { path: string; viewBox: string } {
  let path = "";
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y][x]) path += `M${x + quiet},${y + quiet}h1v1h-1z`;
    }
  }
  const dim = qr.size + quiet * 2;
  return { path, viewBox: `0 0 ${dim} ${dim}` };
}
