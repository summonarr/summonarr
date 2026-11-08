// The hand-rolled modal's keyboard rule (src/hooks/use-modal-a11y.ts,
// modalKeyAction): Escape closes unless an inner control already handled it or
// it ends an IME composition; Tab wraps inside the dialog; anything else is
// left alone. Pure, so no DOM is needed.
import { test } from "node:test";
import assert from "node:assert/strict";

const { modalKeyAction, isTopModal } = await import("../src/hooks/use-modal-a11y.ts");

const key = (k: string, extra: Partial<{ shiftKey: boolean; isComposing: boolean; defaultPrevented: boolean }> = {}) => ({
  key: k, shiftKey: false, isComposing: false, defaultPrevented: false, ...extra,
});
const mid = { count: 3, atFirst: false, atLast: false, inside: true };

test("Escape closes, unless it was already handled or ends a composition", () => {
  assert.equal(modalKeyAction(key("Escape"), mid), "close");
  assert.equal(modalKeyAction(key("Escape", { defaultPrevented: true }), mid), null, "an inner popover handled it");
  assert.equal(modalKeyAction(key("Escape", { isComposing: true }), mid), null, "IME composition cancel");
});

test("Tab wraps at either end and pulls focus back in from outside", () => {
  assert.equal(modalKeyAction(key("Tab"), { ...mid, atLast: true }), "focusFirst");
  assert.equal(modalKeyAction(key("Tab", { shiftKey: true }), { ...mid, atFirst: true }), "focusLast");
  assert.equal(modalKeyAction(key("Tab"), mid), null, "the browser moves focus inside the dialog");
  assert.equal(modalKeyAction(key("Tab"), { ...mid, inside: false }), "focusFirst");
  assert.equal(modalKeyAction(key("Tab", { shiftKey: true }), { ...mid, inside: false }), "focusLast");
  assert.equal(modalKeyAction(key("Tab"), { count: 0, atFirst: false, atLast: false, inside: true }), "focusContainer");
  assert.equal(modalKeyAction(key("Enter"), mid), null);
});

test("no overlay is the top one until it opens", () => {
  assert.equal(isTopModal({}), false);
});

test("the page's scroll is locked while any overlay is open and restored after the last", async () => {
  const { lockPageScroll } = await import("../src/hooks/use-modal-a11y.ts");
  const root = { style: { overflow: "auto", paddingRight: "4px" } };
  const outer = lockPageScroll(root, 15);
  assert.deepEqual(root.style, { overflow: "hidden", paddingRight: "15px" });
  const inner = lockPageScroll(root, 0); // a stacked overlay
  inner();
  inner(); // idempotent: a double release must not unlock the outer one
  assert.deepEqual(root.style, { overflow: "hidden", paddingRight: "15px" }, "the outer overlay still holds the lock");
  outer();
  assert.deepEqual(root.style, { overflow: "auto", paddingRight: "4px" }, "put back exactly as it was");
});

test("no scrollbar, no padding", async () => {
  const { lockPageScroll } = await import("../src/hooks/use-modal-a11y.ts");
  const root = { style: { overflow: "", paddingRight: "" } };
  const release = lockPageScroll(root, 0);
  assert.deepEqual(root.style, { overflow: "hidden", paddingRight: "" });
  release();
  assert.deepEqual(root.style, { overflow: "", paddingRight: "" });
});
