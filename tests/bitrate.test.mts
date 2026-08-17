// Bitrate unit reconciliation — lib/bitrate.ts.
//
// Why this file exists: the `bitrate` column stores whatever the media server
// reported, verbatim, and the two servers disagree on units (Plex kbps,
// Jellyfin bps). Reconciling them by MAGNITUDE is impossible because the ranges
// overlap, and both possible thresholds have already shipped as live bugs:
//
//   > 100_000    a 128 Mbps Plex UHD remux (128000 kbps) is above the cutoff,
//                so it was divided by 1000 and read as 0.128 Mbps — the
//                heaviest sessions vanished from the bandwidth panel.
//   > 1_000_000  a sub-1-Mbps Jellyfin stream (music, or one of its stock
//                mobile transcode rungs) is below the cutoff, so it was read as
//                kbps and INFLATED 1000x — a 2-hour 720 kbps phone stream
//                reported 648 GB against a true 0.65 GB.
//
// Both cases are pinned below, in both directions, so a future "simplification"
// back to a threshold fails here rather than on someone's dashboard.
//
// The second pin is repo-wide and structural. It exists because this exact code
// drifted once already: the commit that raised the SQL threshold to 1_000_000
// updated all nine SQL copies and missed the two client-side helpers, which sat
// on the old 100_000 cutoff for several releases — the SQL and the UI on the
// same page disagreed about the same session. Nothing caught it, because there
// was no single definition to pin. There is now, so the pin is "nobody
// reintroduces a private copy."
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { bitrateToKbps, BITRATE_KBPS_SQL, DELIVERED_KBPS_SQL } from "../src/lib/bitrate.ts";

test("bitrateToKbps: Plex is kbps, Jellyfin is bps, and both land on the same kbps", () => {
  // The same 20 Mbps file as each server reports it.
  assert.equal(bitrateToKbps(20_000, "plex"), 20_000);
  assert.equal(bitrateToKbps(20_000_000, "jellyfin"), 20_000);
});

test("bitrateToKbps: the sub-1-Mbps Jellyfin case that a > 1_000_000 threshold inflates 1000x", () => {
  // 720 kbps mobile transcode. A magnitude threshold at 1_000_000 leaves this
  // unscaled and reads it as 720000 kbps = 720 Mbps.
  assert.equal(bitrateToKbps(720_000, "jellyfin"), 720);
  // 320 kbps music.
  assert.equal(bitrateToKbps(320_000, "jellyfin"), 320);
  // 120 kbps — the lowest rung, and the worst case for a threshold.
  assert.equal(bitrateToKbps(120_000, "jellyfin"), 120);
});

test("bitrateToKbps: the Plex UHD case that a > 100_000 threshold divides away", () => {
  // 128 Mbps Blu-ray remux, reported by Plex as 128000 kbps. A threshold at
  // 100_000 reads this as 128 kbps.
  assert.equal(bitrateToKbps(128_000, "plex"), 128_000);
  // 80 Mbps remux — under the old cutoff, so it survived even the old code.
  // Pinned so the boundary is covered on both sides.
  assert.equal(bitrateToKbps(80_000, "plex"), 80_000);
});

test("bitrateToKbps: absent / non-positive input collapses to 0, not NaN", () => {
  assert.equal(bitrateToKbps(null, "plex"), 0);
  assert.equal(bitrateToKbps(undefined, "jellyfin"), 0);
  assert.equal(bitrateToKbps(0, "plex"), 0);
  assert.equal(bitrateToKbps(-1, "jellyfin"), 0);
});

test("bitrateToKbps: an unknown source is read as kbps (no silent 1000x)", () => {
  // A source we do not recognise must not be assumed to be bps — guessing wrong
  // in that direction multiplies the value by 1000 on the bandwidth panel,
  // whereas guessing wrong the other way merely under-reports.
  assert.equal(bitrateToKbps(8_000, "emby"), 8_000);
  assert.equal(bitrateToKbps(8_000, null), 8_000);
  assert.equal(bitrateToKbps(8_000, ""), 8_000);
});

test("BITRATE_KBPS_SQL discriminates on source, and carries no magnitude threshold", () => {
  assert.match(
    BITRATE_KBPS_SQL,
    /"source"\s*=\s*'jellyfin'/,
    "the SQL fragment must key on the source column",
  );
  assert.doesNotMatch(
    BITRATE_KBPS_SQL,
    /"bitrate"\s*>\s*\d/,
    "a `bitrate > N` magnitude test cannot separate kbps from bps — the ranges overlap",
  );
});

// ── DELIVERED_KBPS_SQL ──────────────────────────────────────────────────────
//
// The stats layer's Bandwidth figures answer "how many bytes left the server",
// which is NOT the source bitrate for a transcoded Plex session. Plex exposes no
// transcode output bitrate at all, so Session.bandwidth (the Streaming Brain's
// RESERVED estimate) is used — but only clamped by the source bitrate, since
// delivered can never exceed it. The clamp is the safety property: a garbage
// reading degrades to exactly the pre-clamp number, never worse.
//
// The arithmetic cannot be pinned here — it is raw SQL, and tests must never
// reach a real database. It was instead verified against a throwaway PostgreSQL
// 17 (the deployed version) across all four server×play-method cases plus the
// NULL-bandwidth and garbage-bandwidth paths; every row matched hand-computed
// values. What IS pinned below is the structure that verification depended on,
// so the shape cannot drift out from under it.

test("DELIVERED_KBPS_SQL clamps Plex transcodes by the source bitrate", () => {
  assert.match(
    DELIVERED_KBPS_SQL,
    /LEAST\(\s*"bandwidth"::float8/,
    "the reserved-bandwidth reading must be capped, never trusted outright — a bogus " +
      "10500 Mbps session would otherwise dominate the whole panel",
  );
});

test("DELIVERED_KBPS_SQL applies the estimate ONLY to transcoded Plex sessions", () => {
  // DirectPlay's source bitrate IS the delivered bitrate, exactly; substituting
  // an estimate there could only add error. Jellyfin transcodes already report
  // their true output bitrate via TranscodingInfo.
  assert.match(DELIVERED_KBPS_SQL, /"source"\s*=\s*'plex'/);
  assert.match(DELIVERED_KBPS_SQL, /"playMethod"\s*=\s*'Transcode'/);
});

test("DELIVERED_KBPS_SQL requires both operands present before clamping", () => {
  // LEAST() in Postgres IGNORES nulls, so LEAST(bandwidth, NULL) returns
  // bandwidth. Without these guards a row with a bandwidth but no bitrate would
  // silently enter the clamp branch and be counted, making the expression
  // non-null where the raw column is null.
  assert.match(DELIVERED_KBPS_SQL, /"bandwidth"\s*>\s*0/);
  assert.match(DELIVERED_KBPS_SQL, /"bitrate"\s*>\s*0/);
});

test("DELIVERED_KBPS_SQL still carries the unit normalization on both branches", () => {
  // Both the clamped and the fall-through branch must go through the kbps
  // normalization, or a Jellyfin row would be compared against, or emitted as,
  // a bps value.
  const branches = DELIVERED_KBPS_SQL.match(/"source" = 'jellyfin'/g) ?? [];
  assert.equal(
    branches.length,
    2,
    "both the LEAST() operand and the ELSE branch must be unit-normalized",
  );
});

// ── repo-wide drift pin ─────────────────────────────────────────────────────

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "generated" || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(entry.name)) yield full;
  }
}

test("no file under src/ reconciles bitrate units by magnitude", () => {
  const SRC = new URL("../src", import.meta.url).pathname;
  const offenders: string[] = [];

  for (const file of walk(SRC)) {
    // lib/bitrate.ts documents the rejected thresholds in prose; it is the one
    // file allowed to name them.
    if (file.endsWith("/lib/bitrate.ts")) continue;
    const src = readFileSync(file, "utf8");
    for (const [i, line] of src.split("\n").entries()) {
      // The antipattern in every shape it has taken: a comparison of a bitrate
      // value against a large literal, in SQL (`"bitrate" > 1000000`) or in TS
      // (`raw > 100000 ? raw / 1000 : raw`).
      if (/\b(?:"bitrate"|bitrate|raw|kbps)\b\s*>\s*\d{5,}/.test(line)) {
        offenders.push(`${file.slice(SRC.length + 1)}:${i + 1}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `bitrate must be normalized by \`source\` via lib/bitrate.ts, never by magnitude. ` +
      `Offending line(s): ${offenders.join(", ")}`,
  );
});
