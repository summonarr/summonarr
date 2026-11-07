// The TRaSH admin cards clear a finished action's message on a timer. Those
// timers must never touch a RUNNING action: a reset from the previous click
// that set "running" back to "idle" re-enabled Apply / Sync Now / Refresh while
// the request was still in flight, and an unconditional reset also wiped an
// error the admin had not read yet. So every reset goes through useDelayed (one
// timer per message, cancelled when its action starts again) and only moves
// the state it was scheduled for ("ok", or a timed "error") back to "idle".
//
// A source pin, not a render test: the suite has no DOM (docs/testing.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const DIR = new URL("../src/components/admin/trash-guides/", import.meta.url);
const files = readdirSync(DIR).filter((f) => /\.tsx?$/.test(f));

test("no TRaSH card schedules a bare setTimeout (it can't be cancelled when the action restarts)", () => {
  for (const f of files) {
    const src = readFileSync(new URL(f, DIR), "utf8");
    assert.ok(!/\bsetTimeout\(/.test(src), `${f}: use useDelayed, not setTimeout`);
  }
});

test("every delayed action-state reset only moves its own state back to idle", () => {
  let seen = 0;
  for (const f of files) {
    const src = readFileSync(new URL(f, DIR), "utf8");
    for (const m of src.matchAll(/later\w*\(\(\) => (set\w*State)\(([^;]*?)\), \d+\)/g)) {
      seen++;
      assert.match(
        m[2],
        /^\(s\) => \(s === "(ok|error)" \? "idle" : s\)$/,
        `${f}: ${m[1]} reset must be (s) => (s === "ok" ? "idle" : s) — never clear "running"`,
      );
    }
  }
  // Non-vacuity: the cards' resets (token, save, sync, apply x2, refresh) were found.
  assert.ok(seen >= 8, `expected the cards' delayed resets, found ${seen}`);
});
