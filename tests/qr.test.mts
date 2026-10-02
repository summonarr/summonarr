// Structural tests for the in-repo QR encoder (src/lib/qr.ts) used to show the
// two-factor otpauth:// URI. End-to-end decodability was verified out-of-band
// with an independent reader (CoreImage CIDetector: 60 codes, versions 1–30,
// all four ECC levels, all eight masks, 0 failures); these pins keep the parts
// a scanner depends on from drifting: byte-mode capacity per version, the
// finder/timing patterns, the dark module, and BCH-valid format/version info
// that names the ECC level and mask actually used.
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeQr, qrToSvgPath, getNumDataCodewords, type QrEcl } from "../src/lib/qr.ts";

test("byte-mode capacity per version matches ISO 18004 Table 7 (level M)", () => {
  // Max bytes in byte mode at ECC level M for versions 1–5.
  const cap: Record<number, number> = { 1: 14, 2: 26, 3: 42, 4: 62, 5: 84 };
  for (const [ver, bytes] of Object.entries(cap)) {
    const v = Number(ver);
    assert.equal(encodeQr("a".repeat(bytes), "M").version, v, `${bytes} bytes fit version ${v}`);
    assert.equal(encodeQr("a".repeat(bytes + 1), "M").version, v + 1, `${bytes + 1} bytes spill to version ${v + 1}`);
  }
  assert.equal(getNumDataCodewords(1, "L"), 19);
  assert.equal(getNumDataCodewords(40, "H"), 1276);
});

function finderOk(m: boolean[][], x0: number, y0: number): boolean {
  for (let dy = 0; dy < 7; dy++) {
    for (let dx = 0; dx < 7; dx++) {
      const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
      if (m[y0 + dy][x0 + dx] !== (ring !== 2)) return false;
    }
  }
  return true;
}

function bchFormatValid(bits: number): boolean {
  let rem = bits;
  for (let i = 14; i >= 10; i--) if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
  return rem === 0;
}

test("finder patterns, timing patterns and the dark module are where a scanner looks", () => {
  for (const text of ["hi", "otpauth://totp/Summonarr:a%40b.c?secret=JBSWY3DPEHPK3PXP&issuer=Summonarr", "x".repeat(300)]) {
    const qr = encodeQr(text, "M");
    const m = qr.modules;
    assert.equal(qr.size, qr.version * 4 + 17);
    assert.ok(finderOk(m, 0, 0) && finderOk(m, qr.size - 7, 0) && finderOk(m, 0, qr.size - 7));
    for (let i = 8; i < qr.size - 8; i++) {
      assert.equal(m[6][i], i % 2 === 0, "horizontal timing");
      assert.equal(m[i][6], i % 2 === 0, "vertical timing");
    }
    assert.equal(m[qr.size - 8][8], true, "the always-dark module");
  }
});

test("format information is BCH-valid and names the ECC level and mask actually used (both copies)", () => {
  const eclBits: Record<QrEcl, number> = { L: 1, M: 0, Q: 3, H: 2 };
  for (const ecl of ["L", "M", "Q", "H"] as QrEcl[]) {
    for (let mask = 0; mask < 8; mask++) {
      const qr = encodeQr("Summonarr two-factor", ecl, mask);
      const m = qr.modules;
      const bit = (b: boolean, i: number) => (b ? 1 << i : 0);
      let a = 0;
      for (let i = 0; i <= 5; i++) a |= bit(m[i][8], i);
      a |= bit(m[7][8], 6) | bit(m[8][8], 7) | bit(m[8][7], 8);
      for (let i = 9; i < 15; i++) a |= bit(m[8][14 - i], i);
      let b = 0;
      for (let i = 0; i < 8; i++) b |= bit(m[8][qr.size - 1 - i], i);
      for (let i = 8; i < 15; i++) b |= bit(m[qr.size - 15 + i][8], i);
      assert.equal(a, b, "the two copies agree");
      const raw = a ^ 0x5412;
      assert.ok(bchFormatValid(raw), "BCH(15,5) remainder is zero");
      assert.equal(raw >>> 10, (eclBits[ecl] << 3) | mask, `${ecl}/${mask}`);
    }
  }
});

test("version information (v7+) is BCH-valid and encodes the version", () => {
  const qr = encodeQr("y".repeat(200), "M");
  assert.ok(qr.version >= 7);
  let bits = 0;
  for (let i = 0; i < 18; i++) if (qr.modules[Math.floor(i / 3)][qr.size - 11 + (i % 3)]) bits |= 1 << i;
  assert.equal(bits >>> 12, qr.version);
  let rem = bits;
  for (let i = 17; i >= 12; i--) if ((rem >>> i) & 1) rem ^= 0x1f25 << (i - 12);
  assert.equal(rem, 0);
});

test("encoding is deterministic, UTF-8 aware, and the SVG path has one square per dark module", () => {
  const a = encodeQr("héllo wörld", "Q");
  const b = encodeQr("héllo wörld", "Q");
  assert.deepEqual(a.modules, b.modules);
  const { path, viewBox } = qrToSvgPath(a, 4);
  const dark = a.modules.flat().filter(Boolean).length;
  assert.equal((path.match(/M/g) ?? []).length, dark);
  assert.equal(viewBox, `0 0 ${a.size + 8} ${a.size + 8}`);
  assert.throws(() => encodeQr("z".repeat(3000), "H"), RangeError);
});
