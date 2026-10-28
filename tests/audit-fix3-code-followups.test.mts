// Four follow-ups the second audit round could not apply from inside its
// slices, pinned here.
//
// 1. A Mark failed refused because ANOTHER mark of that download holds the
//    claim (in flight, or its outcome unknown for ~90 s) is MarkInProgressError
//    — a subclass of AlreadyFailedError, so arrFailure's AlreadyFailedError
//    branch answered "That download is already marked failed" for a mark that
//    may never have reached the arr. arrFailure maps the subclass FIRST.
// 2./4. PATCH /api/requests/[id] { search: true } — pinned in
//    tests/requests-mutation-routes.test.mts (a partial plan, a series no
//    longer on its instance, no lookup on an unregistered instance); only the
//    catalog half is here.
// 3. Replace file with NO answer (the polls failed or ran out, or the POST's
//    own network failed after sending) said "Network error — please try
//    again" on a destructive job that may still be running, with files maybe
//    already deleted. Both paths now say so and reload the list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.TOKEN_ENCRYPTION_KEY ??= "ab".repeat(32);
process.env.NEXTAUTH_SECRET ??= "audit-fix3-code-followups-secret-0123456789";

const { arrFailure } = await import("../src/lib/arr-admin-http.ts");
const { AlreadyFailedError, MarkInProgressError } = await import("../src/lib/arr-title-data.ts");
const { translatorFor } = await import("../src/lib/i18n/server-locale.ts");
const { functionBody, closingBracket, maskSource, stripComments } = await import("./audit-fix2-R8b-tests-vacuous-source.mts");

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, "..", rel), "utf8");
const t = translatorFor("en");
const target = { service: "sonarr" as const, instance: "" };

test("#1 arrFailure: a mark held by another mark is 409 'still in progress', never 'already failed'", async () => {
  const held = arrFailure(new MarkInProgressError(), target, t, "test");
  assert.equal(held.status, 409);
  const body = (await held.json()) as { error: string };
  assert.equal(body.error, "A mark for this download is still in progress — try again in a minute");
  assert.doesNotMatch(body.error, /already marked failed/);

  const failed = arrFailure(new AlreadyFailedError(), target, t, "test");
  assert.equal(failed.status, 409);
  assert.equal(((await failed.json()) as { error: string }).error, "That download is already marked failed", "a real failure still says so");
});

test("#3 Replace file: no answer is never 'network error, try again' — both paths say the replace may still be running, and reload", () => {
  const src = read("src/components/admin/issue-actions.tsx");
  const dialog = src.slice(src.indexOf("function FixFileDialog("));
  assert.ok(src.includes("function FixFileDialog("), "the Fix file window holds the delete");
  const code = stripComments(functionBody(dialog, "async function replace("));
  const NO_ANSWER = /setActionError\(t\("adminQueue\.issueActions\.replaceFileNoAnswer"\)\);\s*reload = true;/;

  const noAnswer = functionBody(code, "if (answer.status === 0)");
  assert.match(noAnswer, NO_ANSWER, "status 0 (no answer from the job) shows the no-answer text and reloads");

  const masked = maskSource(code, { blankText: true });
  const at = masked.search(/\bcatch\s*\{/);
  assert.ok(at >= 0, "replace() has a catch");
  const open = masked.indexOf("{", at);
  const caught = code.slice(open + 1, closingBracket(masked, open));
  assert.match(caught, NO_ANSWER, "a POST that failed on the network may have reached the server: the same text, and reload");

  assert.doesNotMatch(code, /shared\.thread\.networkError/, "no 'try again' wording anywhere in the destructive replace");
  assert.doesNotMatch(code, /throw new Error\(/, "status 0 is handled where it is read, not thrown into the catch");
});

// No translation pass follows these keys, so each locale must carry its OWN
// text — the helper seeds non-English catalogs with the English placeholder.
test("the four new keys are translated in every locale", () => {
  const keys: Array<[area: string, key: string]> = [
    ["apiAdmin", "apiAdmin.arr.markInProgress"],
    ["apiUser", "apiUser.requests.searchPartial"],
    ["apiUser", "apiUser.requests.searchSeriesNotInSonarr"],
    ["adminQueue", "adminQueue.issueActions.replaceFileNoAnswer"],
  ];
  const catalog = (locale: string, area: string) =>
    JSON.parse(read(`src/lib/i18n/messages/${locale}/${area}.json`)) as Record<string, string>;
  for (const [area, key] of keys) {
    const en = catalog("en", area)[key];
    assert.ok(typeof en === "string" && en.length > 0, `${key} is missing in en`);
    for (const locale of ["de", "es", "fr", "it", "pt", "zh"]) {
      const text = catalog(locale, area)[key];
      assert.ok(typeof text === "string" && text.length > 0, `${key} is missing in ${locale}`);
      assert.notEqual(text, en, `${key} is still the English placeholder in ${locale}`);
    }
  }
  assert.doesNotMatch(catalog("en", "adminQueue")["adminQueue.issueActions.replaceFileNoAnswer"], /try again/i);
});
