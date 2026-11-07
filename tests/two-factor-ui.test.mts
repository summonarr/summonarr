// The Profile → Two-factor section keeps ONE shared password field for every
// change (two-factor.tsx). After the server accepts a change, the password must
// be cleared: left in state and in the input, anyone at the unlocked tab could
// make the next change without retyping it — after 2FA is switched off that
// includes planting their own first factor, which needs the password alone
// (guardrails 6d, 6g). The component is a .tsx client module the unit loader
// can't import, so its handlers are pinned by a structural scan.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/components/profile/two-factor.tsx", import.meta.url), "utf8");

// Every `const name = (...) => run(…)` / `stepUpRun(…)` handler body.
function handlers(): Map<string, { body: string; stepUp: boolean }> {
  const out = new Map<string, { body: string; stepUp: boolean }>();
  const re = /const (\w+) = \([^)]*\) => (run|stepUpRun)\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const end = src.indexOf("\n  }", m.index);
    assert.ok(end > m.index, `handler ${m[1]} has a body`);
    out.set(m[1], { body: src.slice(m.index, end), stepUp: m[2] === "stepUpRun" });
  }
  return out;
}

test("every two-factor change goes through the one step-up prelude, which sends the password and clears the code first", () => {
  const all = handlers();
  // The seven password step-ups; confirmTotp sends only the setup code.
  assert.deepEqual(
    [...all].filter(([, h]) => h.stepUp).map(([name]) => name).sort(),
    ["addPasskey", "disableAll", "regenerateCodes", "removePasskey", "removeTotp", "renamePasskey", "startTotp"],
  );
  assert.equal(all.get("confirmTotp")?.stepUp, false);
  const start = src.indexOf("const stepUpRun = (");
  const prelude = src.slice(start, src.indexOf("\n  });\n", start));
  const needPw = prelude.indexOf("if (needPassword()) return;");
  const factor = prelude.indexOf("await secondFactorBody()");
  const clearCode = prelude.indexOf('setStepUpCode("")');
  const send = prelude.indexOf("await fn({ password, ...sf })");
  assert.ok(needPw > 0 && factor > needPw && clearCode > factor && send > clearCode,
    "password, then second factor, then the single-use code is cleared, then the request");
  // No handler re-implements the prelude.
  for (const [name, h] of all) {
    assert.ok(!h.body.includes("secondFactorBody()"), `${name} uses the shared prelude`);
  }
});

test("every two-factor handler that sends the account password clears it once the server accepted the change", () => {
  for (const [name, h] of handlers()) {
    if (!h.stepUp) {
      assert.ok(!/setPassword\(""\)/.test(h.body), `${name} sends no password`);
      continue;
    }
    const sent = h.body.search(/\bstepUp\b[),]/);
    const cleared = h.body.indexOf('setPassword("")');
    assert.ok(sent > 0 && cleared > sent, `${name} must call setPassword("") after its password request succeeded`);
    // After the success check, not before it: a refused change keeps the field
    // so the user can correct a typo without retyping everything.
    const okCheck = h.body.indexOf(".ok) return setError(", sent);
    assert.ok(okCheck > 0 && cleared > okCheck, `${name} clears the password only on success`);
  }
});

test("enrolled passkeys stay listed (rename/remove) when WebAuthn is unavailable; only the add row is gated", () => {
  const section = src.slice(src.indexOf("{/* Passkeys */}"), src.indexOf("{state.enabled && (", src.indexOf("{/* Passkeys */}")));
  const list = section.indexOf("{state.passkeys.map((p) =>");
  const gate = section.indexOf("{state.webauthnAvailable ? (");
  assert.ok(list > 0 && gate > list, "the passkey list renders before, and outside, the WebAuthn conditional");
  assert.ok(!section.slice(0, list).includes("webauthnAvailable"), "nothing gates the list on WebAuthn");
  const addRow = section.indexOf("onClick={addPasskey}");
  assert.ok(addRow > gate, "adding a passkey stays behind the WebAuthn gate");
});

test("a regenerate answer without the new codes is reported, not rendered as an empty list", () => {
  const body = handlers().get("regenerateCodes")?.body ?? "";
  const guard = body.indexOf("if (!Array.isArray(r.data.recoveryCodes))");
  const show = body.indexOf("setCodes(r.data.recoveryCodes");
  assert.ok(guard > 0 && show > guard);
});

// Closing the account kept its own copy of the code / passkey builder, which
// drifted from the shared one. Every profile step-up now goes through it.
test("Delete account builds its second factor with the shared buildSecondFactor", () => {
  const del = readFileSync(new URL("../src/components/profile/delete-account.tsx", import.meta.url), "utf8");
  assert.match(del, /const r = await buildSecondFactor\(\{\s*code: stepUpCode,\s*passkeyPossible,\s*t,\s*failedMessage: \(\) => t\("profile\.close\.error\.failed"\),/);
  assert.doesNotMatch(del, /\/api\/profile\/mfa\/challenge/, "no second copy of the challenge request");
});
