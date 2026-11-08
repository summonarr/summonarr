// The heatmap drill-down popover (src/components/admin/heatmap-cell-popover.tsx)
// and its read (src/components/admin/heatmap-cell-detail.ts).
//
//   - The answer is checked before CellBody reads its nested fields
//     (methods.directPlay, network.lan…); a body that isn't one fails the read.
//   - A failure shows the route's own reason when it gave one (a bad date), else
//     the catalog's generic text — never a transport message in browser English.
//   - Changing cell, retrying or closing aborts the read in flight.
//   - The outside-click/Escape/scroll/resize listeners are registered once: both
//     callers pass an inline onClose, which as a dependency re-registered four
//     listeners on every parent render.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cellLoadError, fetchHeatmapCell, joinParts, pct } from "../src/components/admin/heatmap-cell-detail.ts";

const src = readFileSync(new URL("../src/components/admin/heatmap-cell-popover.tsx", import.meta.url), "utf8");

const DETAIL = {
  totalPlays: 2, watchHours: 1.5, avgSessionMinutes: 45, completedCount: 1, completedPct: 50,
  methods: { directPlay: 1, directStream: 0, transcode: 1, other: 0 },
  topTranscodeReasons: [{ reason: "Video transcoded", count: 1 }],
  source: { plex: 2, jellyfin: 0 }, mediaType: { movie: 2, tv: 0, other: 0 },
  avgBitrateMbps: 8, dataTransferredGb: 2.5, topResolutions: [{ resolution: "1080p", count: 2 }],
  network: { lan: 1, wan: 1, relay: 0 },
  topTitles: [{ title: "Dune", tmdbId: 1, mediaType: "movie", count: 2 }],
  topUsers: [{ id: "u", username: "alice", count: 2 }],
};

async function read(status: number, body: unknown) {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as typeof fetch;
  try {
    return await fetchHeatmapCell("mode=day&date=2026-10-01", new AbortController().signal);
  } finally {
    globalThis.fetch = real;
  }
}

test("a well-formed cell is read whole; one missing a nested block is a failed read", async () => {
  const ok = await read(200, DETAIL);
  assert.ok(ok.ok);
  assert.deepEqual(ok.data, DETAIL);
  const broken = await read(200, { ...DETAIL, network: undefined });
  assert.equal(broken.ok ? "ok" : broken.kind, "invalid");
});

test("the failure text: the route's reason, else the catalog key", async () => {
  const bad = await read(400, { error: "Invalid date" });
  assert.ok(!bad.ok);
  if (!bad.ok) assert.deepEqual(cellLoadError(bad), { text: "Invalid date" });
  const proxy = await read(502, "<html>Bad gateway</html>");
  assert.ok(!proxy.ok);
  if (!proxy.ok) assert.deepEqual(cellLoadError(proxy), { key: "adminActivity.history.loadError" });
});

test("joinParts and pct", () => {
  assert.equal(joinParts(["LAN 1", false, null, "", undefined, "WAN 2"]), "LAN 1 · WAN 2");
  assert.equal(joinParts([false]), "");
  assert.equal(pct(1, 3), "33%");
  assert.equal(pct(5, 0), "0%");
});

test("the read is aborted when the cell changes, on Retry and on close", () => {
  const hook = src.slice(src.indexOf("function useCellDetail("), src.indexOf("function usePlacement("));
  assert.match(hook, /const controller = new AbortController\(\);/);
  assert.match(hook, /return \(\) => controller\.abort\(\);\s*\}, \[queryString, attempt\]\);/);
  assert.match(hook, /if \(res\.kind === "aborted"\) return;/, "an aborted read sets nothing");
});

test("the dismiss listeners are registered once and call the latest onClose", () => {
  const hook = src.slice(src.indexOf("function useDismiss("), src.indexOf("export function HeatmapCellPopover("));
  assert.match(hook, /const close = \(\) => onCloseRef\.current\(\);/);
  assert.match(hook, /\}, \[ref\]\);\s*\}\s*$/, "the listener effect never depends on onClose");
  assert.match(hook, /useEffect\(\(\) => \{\s*onCloseRef\.current = onClose;\s*\}\);/, "the ref follows the prop after each commit");
});

test("units and network/server labels go through the catalog", () => {
  const body = src.slice(src.indexOf("function CellBody("));
  for (const literal of ["Mbps`", " GB`", "`LAN ", "`WAN ", "`Plex ", "`Jellyfin "]) {
    assert.ok(!body.includes(literal), `no hardcoded ${literal}`);
  }
  assert.match(body, /t\("adminActivity\.popover\.bitrateValue"/);
  assert.match(body, /t\("adminActivity\.popover\.lanCount"/);
  assert.match(body, /t\("adminActivity\.popover\.serverCount", \{ server: mediaServerName\("plex"\)/);
});
