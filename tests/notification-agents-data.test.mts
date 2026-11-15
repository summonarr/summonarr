// The notification channel manager's data (src/components/settings/notification-agents-data.ts)
// and the manager's wiring: the list is shape-checked (a 200 without `agents`
// is a load error, not a silently empty card), an event key no longer offered
// is dropped from the draft, Select all reads the offered events themselves,
// reloads are sequenced, and a save in flight locks the form.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NOTIFY_EVENT_KEYS } from "../src/lib/notify-events.ts";
import { allEventsSelected, bodyFrom, draftFrom, emptyDraft, readAgents } from "../src/components/settings/notification-agents-data.ts";

const agent = {
  id: "a1", kind: "ntfy", name: "Phone", enabled: true, events: ["request.created", "gone.event"],
  config: { url: "https://ntfy.sh", topic: "t", priority: 4, attachPoster: true }, hasSecret: false,
  configValid: true, lastStatus: null, lastError: null, createdAt: "2026-01-01T00:00:00.000Z",
};

test("the list answer is checked: anything but a list of channels is a load error", () => {
  assert.equal(readAgents({ agents: [agent] })?.[0].name, "Phone");
  assert.equal(readAgents({}), null, "a 200 without agents");
  assert.equal(readAgents({ agents: [{ ...agent, events: "x" }] }), null, "a malformed entry");
  assert.equal(readAgents({ agents: [{ ...agent, kind: "smtp" }] }), null, "an unknown kind");
  assert.equal(readAgents(null), null);
});

test("an event no longer offered is dropped from the draft, so it isn't written back", () => {
  const [view] = readAgents({ agents: [agent] })!;
  const d = draftFrom(view);
  assert.deepEqual(d.events, ["request.created"]);
  assert.equal(d.priority, "4");
  assert.deepEqual(bodyFrom(d).events, ["request.created"]);
});

test("Select all is judged on the offered events, not on the count", () => {
  assert.equal(allEventsSelected([...NOTIFY_EVENT_KEYS]), true);
  const missingOne = [...NOTIFY_EVENT_KEYS.slice(1), "gone.event"];
  assert.equal(missingOne.length, NOTIFY_EVENT_KEYS.length, "same length");
  assert.equal(allEventsSelected(missingOne), false);
  assert.equal(allEventsSelected(emptyDraft().events), true);
});

test("the manager sequences reloads, locks the form while saving and announces its results", () => {
  const src = readFileSync(new URL("../src/components/settings/notification-agents-manager.tsx", import.meta.url), "utf8");
  assert.match(src, /action\.run\("load", \(signal\) => fetchJson\(withBasePath\("\/api\/admin\/notification-agents"\), \{ signal \}\)\)/);
  assert.match(src, /const list = res\.ok \? readAgents\(res\.data\) : null;/);
  assert.match(src, /<fieldset disabled=\{saving\} className="min-w-0 space-y-4">\s*<AgentFormFields/);
  assert.match(src, /const allSelected = allEventsSelected\(draft\.events\);/);
  assert.doesNotMatch(src, /draft\.events\.length === NOTIFY_EVENT_KEYS\.length/);
  assert.match(src, /\{formError && <p role="alert"/);
  assert.match(src, /\{actionError && <p role="alert"/);
  assert.match(src, /<p role="status" className=\{`mt-1 flex items-center gap-1 text-xs/);
});

test("a priority that is not a number is sent as typed, never as a null from NaN", () => {
  const d = { ...emptyDraft(), kind: "gotify" as const, url: "https://gotify.example", priority: "e" };
  const config = bodyFrom(d).config as Record<string, unknown>;
  assert.equal(config.priority, "e");
  assert.equal(JSON.parse(JSON.stringify(bodyFrom(d))).config.priority, "e");
  assert.equal((bodyFrom({ ...d, priority: "7" }).config as Record<string, unknown>).priority, 7);
});
