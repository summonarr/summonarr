// arrFailure mapping + the polled-read warnOnChange rule (guardrail 7b) on the
// six admin arr read routes.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { arrFailure, readWarnKey } = await import("../src/lib/arr-admin-http.ts");
const { ArrItemNotFoundError, ArrResponseError } = await import("../src/lib/arr.ts");
const { resetLogDedup, forgetWarnOnChange } = await import("../src/lib/log-dedup.ts");

const t = ((key: string) => key) as never;
const target = { service: "radarr", instance: "" } as never;

const warns: string[] = [];
const realWarn = console.warn;
beforeEach(() => {
  resetLogDedup();
  warns.length = 0;
  console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };
});
test.afterEach(() => { console.warn = realWarn; });

test("arrFailure: a title the arr no longer holds (ArrItemNotFoundError) is a 409, not a 502", async () => {
  const res = arrFailure(new ArrItemNotFoundError("gone"), target, t, "title read");
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "apiUser.requests.releases.notInArr" });
  assert.equal(warns.length, 0, "an expected refusal is not logged");
});

test("arrFailure with a warnKey: the same failure on every poll logs ONCE; a changed failure, or one after a success, logs again", () => {
  const key = readWarnKey("history", { service: "radarr", instance: "hd" } as never);
  assert.equal(key, "arr-read:history:radarr:hd");
  const boom = () => new ArrResponseError(500, "boom");
  arrFailure(boom(), target, t, "history read", { warnKey: key });
  arrFailure(boom(), target, t, "history read", { warnKey: key });
  assert.equal(warns.length, 1, "an unchanged condition is not re-announced");
  arrFailure(new Error("different"), target, t, "history read", { warnKey: key });
  assert.equal(warns.length, 2, "a changed condition logs");
  forgetWarnOnChange(key); // what a successful read does
  arrFailure(new Error("different"), target, t, "history read", { warnKey: key });
  assert.equal(warns.length, 3, "after a recovery the same failure is news again");
  // Without a key (a write path) every failure logs.
  arrFailure(boom(), target, t, "x");
  arrFailure(boom(), target, t, "x");
  assert.equal(warns.length, 5);
});

const SIX = [
  ["src/app/api/admin/arr/blocklist/route.ts", "blocklist"],
  ["src/app/api/admin/arr/history/route.ts", "history"],
  ["src/app/api/admin/arr/title/episodes/route.ts", "title-episodes"],
  ["src/app/api/admin/arr/title/files/route.ts", "title-files"],
  ["src/app/api/admin/arr/title/history/route.ts", "title-history"],
  ["src/app/api/admin/arr/title/route.ts", "title"],
] as const;

for (const [file, name] of SIX) {
  test(`${file}: the polled GET keys its failure with readWarnKey and forgets the key on success`, () => {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.match(src, new RegExp(`const warnKey = readWarnKey\\("${name}", target\\)`));
    assert.match(src, /forgetWarnOnChange\(warnKey\)/);
    assert.match(src, /\{ warnKey \}\)/, "the GET's arrFailure carries the key");
  });
}
