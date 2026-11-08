// writeClipboardText (src/hooks/use-copy-feedback.ts): the Clipboard API where
// the page has it, else the legacy execCommand copy — a plain-HTTP LAN install
// is not a secure context and has no navigator.clipboard at all. It reports
// whether the copy happened and never throws, so the copy button can say so.
import { test } from "node:test";
import assert from "node:assert/strict";

const { writeClipboardText } = await import("../src/hooks/use-copy-feedback.ts");

function fakeDocument(copyResult: boolean | "throw") {
  const log: string[] = [];
  const doc = {
    body: { appendChild: (el: { value: string }) => { log.push(`append:${el.value}`); } },
    createElement: () => ({
      value: "",
      style: {} as Record<string, string>,
      setAttribute: () => {},
      select: () => { log.push("select"); },
      remove: () => { log.push("remove"); },
    }),
    execCommand: (cmd: string) => {
      log.push(`exec:${cmd}`);
      if (copyResult === "throw") throw new Error("blocked");
      return copyResult;
    },
  };
  return { doc: doc as never, log };
}

test("the Clipboard API is used when the page has it", async () => {
  const written: string[] = [];
  const { doc, log } = fakeDocument(true);
  const ok = await writeClipboardText("x", { navigator: { clipboard: { writeText: async (t: string) => { written.push(t); } } }, document: doc });
  assert.equal(ok, true);
  assert.deepEqual(written, ["x"]);
  assert.deepEqual(log, [], "no legacy copy when the API worked");
});

test("no navigator.clipboard (an insecure origin): the legacy copy runs and its answer is returned", async () => {
  const { doc, log } = fakeDocument(true);
  assert.equal(await writeClipboardText("http-url", { navigator: {}, document: doc }), true);
  assert.deepEqual(log, ["append:http-url", "select", "exec:copy", "remove"]);
  const refused = fakeDocument(false);
  assert.equal(await writeClipboardText("y", { navigator: {}, document: refused.doc }), false);
});

test("a refused Clipboard API falls back, and a failure everywhere is false, never a throw", async () => {
  const { doc, log } = fakeDocument("throw");
  const ok = await writeClipboardText("z", {
    navigator: { clipboard: { writeText: async () => { throw new Error("NotAllowedError"); } } },
    document: doc,
  });
  assert.equal(ok, false);
  assert.ok(log.includes("remove"), "the hidden field is always removed");
  assert.equal(await writeClipboardText("z", {}), false, "no clipboard and no document");
});
