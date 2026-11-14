// mainRequestView (src/components/media/request-button-rules.ts): what the
// detail page's main Request button shows. Pure; no DB, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mainRequestView } from "../src/components/media/request-button-rules.ts";

const base = {
  isAvailable: false, showViewRequest: false, blacklisted: false,
  permanentlyDeclined: false, canRequest: true, canRequestOnBehalf: false,
};

test("a requestable title shows the request controls and nothing else", () => {
  assert.deepEqual(mainRequestView(base), { cta: true, blocked: false, onBehalfOnly: false });
  // The on-behalf control rides inside the request controls then.
  assert.deepEqual(mainRequestView({ ...base, canRequestOnBehalf: true }), { cta: true, blocked: false, onBehalfOnly: false });
});

test("a blacklist or the viewer's permanent decline shows the blocked status, never a request control", () => {
  assert.deepEqual(mainRequestView({ ...base, blacklisted: true }), { cta: false, blocked: true, onBehalfOnly: false });
  assert.deepEqual(mainRequestView({ ...base, permanentlyDeclined: true }), { cta: false, blocked: true, onBehalfOnly: false });
  // Availability and the viewer's live request are shown instead of the status.
  assert.equal(mainRequestView({ ...base, permanentlyDeclined: true, isAvailable: true }).blocked, false);
  assert.equal(mainRequestView({ ...base, blacklisted: true, showViewRequest: true }).blocked, false);
});

test("an on-behalf holder keeps 'Request for user' whatever their own state, except on a blacklisted title", () => {
  const holder = { ...base, canRequestOnBehalf: true };
  for (const own of [{ isAvailable: true }, { showViewRequest: true }, { permanentlyDeclined: true }, { canRequest: false }]) {
    const view = mainRequestView({ ...holder, ...own });
    assert.equal(view.cta, false, JSON.stringify(own));
    assert.equal(view.onBehalfOnly, true, JSON.stringify(own));
  }
  assert.equal(mainRequestView({ ...holder, blacklisted: true }).onBehalfOnly, false);
  assert.equal(mainRequestView({ ...holder, blacklisted: true, isAvailable: true }).onBehalfOnly, false);
  // Without the permission there is never an on-behalf control.
  assert.equal(mainRequestView({ ...base, isAvailable: true }).onBehalfOnly, false);
});

test("the buttons and the action row are wired to the rule and the page state", () => {
  const src = (rel: string) => readFileSync(rel, "utf8");
  const button = src("src/components/media/request-button.tsx");
  assert.match(button, /\{view\.blocked && \(/);
  assert.match(button, /\{view\.cta && \(/);
  assert.match(button, /\{view\.onBehalfOnly &&/);
  assert.match(src("src/components/media/variant-request-button.tsx"), /if \(blacklisted \|\| permanentlyDeclined\) \{/);
  const row = src("src/components/media/detail-actions.tsx");
  assert.match(row, /permanentlyDeclined=\{state\.permanentlyDeclined\.main\}/);
  assert.match(row, /permanentlyDeclined=\{state\.permanentlyDeclined\.fourK\}/);
  assert.match(row, /permanentlyDeclined=\{state\.permanentlyDeclined\.named\.includes\(target\.slug\)\}/);
  // The vote route refuses the title's own requester or filer; a cast vote can still be taken back.
  assert.match(row, /state\.votesEnabled && inVisibleLibrary && \(!state\.ownRequest \|\| state\.alreadyVoted\) && \(/);
  // The decline reason is on the /requests row itself, not only in the thread.
  assert.match(src("src/app/(app)/requests/page.tsx"), /r\.status === "DECLINED" && r\.adminNote && \(/);
});
