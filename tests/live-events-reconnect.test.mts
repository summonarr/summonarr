// The live stream has no event ids and no replay: an event emitted while the
// connection is down (the server recycles it on a schedule) never arrives. The
// hook (src/hooks/use-live-events.ts) therefore tells its consumers when the
// stream is BACK after a drop, and the pages that show server data re-read
// once. "use client" modules the loader can't run, so the wiring is pinned in
// the source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const hook = read("src/hooks/use-live-events.ts");

test("a reconnect is a server 'connected' frame that follows a drop, never the first connect", () => {
  // Starts clear, set by a connection error, spent by the next connected frame.
  assert.match(hook, /let dropped = false;/);
  assert.match(hook, /dropped = true;\s*dispatch\(\{ type: "disconnected" \}\);/);
  assert.match(hook, /if \(event\.type === "connected" && dropped\) \{\s*dropped = false;\s*for \(const sub of reconnectSubscribers\)/);
  // The "connected" synthesized for a late joiner goes to that subscriber's
  // event callback alone: it is not a reconnect.
  const lateAt = hook.indexOf("if (singleton && singleton.readyState === EventSource.OPEN) {");
  assert.ok(lateAt > 0);
  const late = hook.slice(lateAt, hook.indexOf("return () => {", lateAt));
  assert.match(late, /sub\(\{ type: "connected" \}\);/);
  assert.doesNotMatch(late, /reconnect/i);
  // A stream closed with its last subscriber starts over: no drop carried along.
  const teardown = hook.slice(hook.indexOf("function teardownEventSource()"), hook.indexOf("export interface LiveEventsOptions"));
  assert.match(teardown, /dropped = false;/);
});

test("the reconnect callback is an optional second argument, subscribed and removed with the event callback", () => {
  assert.match(hook, /export function useLiveEvents\(onEvent: \(event: LiveEvent\) => void, options\?: LiveEventsOptions\)/);
  assert.match(hook, /onReconnect\?: \(\) => void;/);
  assert.match(hook, /reconnectSubscribers\.add\(reconnectSub\);/);
  assert.match(hook, /reconnectSubscribers\.delete\(reconnectSub\);/);
});

test("LiveRefresh and the admin request list re-read once the stream is back", () => {
  assert.match(read("src/components/live-refresh.tsx"), /onReconnect: \(\) => requestPageRefresh\(\(\) => router\.refresh\(\)\),/);
  assert.match(read("src/components/admin/admin-request-list.tsx"), /onReconnect: scheduleRefresh,/);
});
