import { test } from "node:test";
import assert from "node:assert/strict";
import { runWarmSteps } from "../src/lib/play-history-warm.ts";

test("a failing warm step does not leave the later ones cold, and the run still fails", async () => {
  const ran: string[] = [];
  const warn = console.warn;
  const warned: string[] = [];
  console.warn = (...a: unknown[]) => void warned.push(String(a[0]));
  try {
    await assert.rejects(
      runWarmSteps([
        { label: "a", run: async () => void ran.push("a") },
        { label: "b", run: async () => { throw new Error("first"); } },
        { label: "c", run: async () => void ran.push("c") },
        { label: "d", run: async () => { throw new Error("second"); } },
      ]),
      /first/,
    );
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(ran, ["a", "c"]);
  assert.equal(warned.filter((w) => w.startsWith("[play-history] warm")).length, 2);
});

test("every step succeeding reports the count", async () => {
  assert.deepEqual(await runWarmSteps([{ label: "a", run: async () => 1 }, { label: "b", run: async () => 2 }]), { warmed: 2 });
});
