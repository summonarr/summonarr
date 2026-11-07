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

// Every `const name = (...) => run("key", async () => { … });` handler body.
function handlers(): Map<string, string> {
  const out = new Map<string, string>();
  const re = /const (\w+) = \([^)]*\) => run\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const end = src.indexOf("\n  });\n", m.index);
    assert.ok(end > m.index, `handler ${m[1]} has a body`);
    out.set(m[1], src.slice(m.index, end));
  }
  return out;
}

test("every two-factor handler that sends the account password clears it once the server accepted the change", () => {
  const all = handlers();
  const sending = [...all].filter(([, body]) => /\{ password\b/.test(body));
  // The seven password step-ups; confirmTotp sends only the setup code.
  assert.deepEqual(
    sending.map(([name]) => name).sort(),
    ["addPasskey", "disableAll", "regenerateCodes", "removePasskey", "removeTotp", "renamePasskey", "startTotp"],
  );
  for (const [name, body] of sending) {
    const sent = body.search(/\{ password\b/);
    const cleared = body.indexOf('setPassword("")');
    assert.ok(cleared > sent, `${name} must call setPassword("") after its password request succeeded`);
    // After the success check, not before it: a refused change keeps the field
    // so the user can correct a typo without retyping everything.
    const okCheck = body.indexOf(".ok) return setError(", sent);
    assert.ok(okCheck > 0 && cleared > okCheck, `${name} clears the password only on success`);
  }
  assert.ok(!/setPassword\(""\)/.test(all.get("confirmTotp") ?? ""), "confirmTotp sends no password");
});
