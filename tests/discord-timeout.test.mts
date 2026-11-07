// The deferred-reply plumbing of the Discord bot (src/lib/discord-interactions/
// timeout.ts + reply.ts):
//   - withDiscordTimeout's "taking longer" line must never REPLACE a result. A
//     handler's final edit is its last await, so the 25s timer could fire while
//     that edit was in flight and send the line after it — and on an admin card
//     it landed on the shared channel's message.
//   - The edits of one interaction's message go out in call order: an edit
//     starts only once the previous one on the same token settled.
//   - truncateText never splits a surrogate pair (an emoji) at the cut.
//
// No network: globalThis.fetch is scripted and dns.lookup is stubbed.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "discord-timeout-test-secret-0123456789ab";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

const errors: string[] = [];
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// Every PATCH to the original message: its content, and when it was sent and
// answered (a running counter, so order is exact).
type Edit = { content: unknown; sentAt: number; doneAt: number | null };
const edits: Edit[] = [];
let clock = 0;
// A test can hold an edit's answer until it releases it.
let hold: ((content: unknown) => Promise<void> | null) = () => null;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname !== "discord.com") throw new Error(`unexpected fetch ${url.href}`);
  const body = JSON.parse(String(init?.body)) as { content?: unknown };
  const edit: Edit = { content: body.content, sentAt: ++clock, doneAt: null };
  edits.push(edit);
  const gate = hold(body.content);
  if (gate) await gate;
  edit.doneAt = ++clock;
  return new Response(null, { status: 204 });
}) as unknown as typeof fetch;

const { withDiscordTimeout } = await import("../src/lib/discord-interactions/timeout.ts");
const { editOriginal, truncateText } = await import("../src/lib/discord-interactions/reply.ts");
const { translatorFor } = await import("../src/lib/i18n/server-locale.ts");

const t = translatorFor("en");
const SLOW = t("notify.bot.slow");
let tokenSeq = 0;
const nextToken = () => `token-${++tokenSeq}`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function drain(ms = 60): Promise<void> {
  await sleep(ms);
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  edits.length = 0;
  errors.length = 0;
  hold = () => null;
});

test("a final edit still in flight when the timer fires is NOT followed by the 'taking longer' line", async () => {
  let release!: () => void;
  const answered = new Promise<void>((r) => { release = r; });
  hold = (content) => (content === "final" ? answered : null);
  const token = nextToken();

  withDiscordTimeout(() => editOriginal("app", token, { content: "final" }), "app", token, t, 10);
  await sleep(40); // the timer fired while the final edit waited for its answer
  release();
  await drain();

  assert.deepEqual(edits.map((e) => e.content), ["final"], "the result is the last word");
});

test("a handler still working at the deadline gets the line, and its final edit lands after it", async () => {
  const token = nextToken();
  withDiscordTimeout(async () => {
    await sleep(40);
    await editOriginal("app", token, { content: "final" });
  }, "app", token, t, 10);
  await drain(80);

  assert.deepEqual(edits.map((e) => e.content), [SLOW, "final"]);
});

test("edits of one message go out in call order: the next starts only once the previous one was answered", async () => {
  let release!: () => void;
  const answered = new Promise<void>((r) => { release = r; });
  hold = (content) => (content === "first" ? answered : null);
  const token = nextToken();

  const first = editOriginal("app", token, { content: "first" });
  const second = editOriginal("app", token, { content: "second" });
  await drain(20);
  assert.deepEqual(edits.map((e) => e.content), ["first"], "the second edit waits for the first");
  release();
  await Promise.all([first, second]);

  assert.deepEqual(edits.map((e) => e.content), ["first", "second"]);
  assert.ok(edits[1].sentAt > (edits[0].doneAt ?? Infinity), "sent only after the first was answered");
});

test("a failed edit does not block the next one on the same message", async () => {
  const token = nextToken();
  hold = (content) => (content === "boom" ? Promise.reject(new Error("socket hang up")) : null);
  await assert.rejects(editOriginal("app", token, { content: "boom" }), /socket hang up/);
  await editOriginal("app", token, { content: "after" });
  assert.deepEqual(edits.map((e) => e.content), ["boom", "after"]);
});

test("edits of DIFFERENT messages are not serialized against each other", async () => {
  let release!: () => void;
  const answered = new Promise<void>((r) => { release = r; });
  hold = (content) => (content === "a" ? answered : null);
  const a = editOriginal("app", nextToken(), { content: "a" });
  await editOriginal("app", nextToken(), { content: "b" });
  assert.deepEqual(edits.map((e) => e.content), ["a", "b"]);
  release();
  await a;
});

// ── truncateText ─────────────────────────────────────────────────────────────

const LONE_HIGH = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;

test("truncateText never leaves half an emoji before the ellipsis", () => {
  const text = "a".repeat(78) + "😀" + "b"; // the cut at 79 falls inside the pair
  const out = truncateText(text, 80);
  assert.ok(out.length <= 80);
  assert.ok(!LONE_HIGH.test(out), JSON.stringify(out));
  assert.equal(out, "a".repeat(78) + "…");
});

test("truncateText keeps a whole emoji that fits, and leaves short text alone", () => {
  assert.equal(truncateText("a".repeat(77) + "😀" + "bcd", 80), "a".repeat(77) + "😀" + "…");
  assert.equal(truncateText("short 😀", 80), "short 😀");
});
