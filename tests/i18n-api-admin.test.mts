// Admin/settings API messages (catalog area apiAdmin.*).
//
// The lib helpers that phrase client-facing messages for the admin routes take
// an optional Translator. Without one they must return exactly the English they
// always did (other callers and existing tests depend on it); with the ENGLISH
// translator they must return the same bytes — that is what pins the catalog's
// English to the literal it replaced; with Spanish they must come back Spanish.
// The route-level wiring (cookie / Accept-Language → Spanish, no hints →
// English) is pinned in admin-routes.test.mts and sync-routes.test.mts.

import { test } from "node:test";
import assert from "node:assert/strict";

const { translatorFor } = await import("../src/lib/i18n/server-locale.ts");
const { validateServerUrl } = await import("../src/lib/server-url.ts");
const { watchGradeSettingError, watchGradeCrossFieldError, WATCH_GRADE_DEFAULTS } = await import("../src/lib/watch-grade.ts");
const { validateCleanupSettingsPatch } = await import("../src/lib/library-cleanup.ts");
const { localizeBackupMessage } = await import("../src/lib/backup-messages.ts");
const { startFixMatchJob, FixMatchError, _resetFixMatchJobsForTests } = await import("../src/lib/fix-match-jobs.ts");

const en = translatorFor("en");
const es = translatorFor("es");

test("validateServerUrl: English unchanged without a translator, identical with the English one, Spanish with es", () => {
  const cases: Array<[string, { httpsOnly?: boolean; maxLen?: number }]> = [
    ["not a url", {}],
    ["ftp://host", {}],
    ["http://host", { httpsOnly: true }],
    ["http://user:pw@host", {}],
    ["http://host/long", { maxLen: 5 }],
  ];
  for (const [value, opts] of cases) {
    const plain = validateServerUrl(value, opts);
    assert.ok(plain, value);
    assert.equal(validateServerUrl(value, opts, en), plain, value);
    assert.notEqual(validateServerUrl(value, opts, es), plain, value);
  }
  assert.equal(validateServerUrl("not a url"), "must be a valid URL");
  assert.equal(validateServerUrl("not a url", {}, es), "debe ser una URL válida");
  assert.equal(validateServerUrl("http://ok.example", {}, es), null);
});

test("watch-grade validators: every branch is byte-identical in English and translated in Spanish", () => {
  const single: Array<[string, string]> = [
    ["watchGradeGraceDays", "0"],
    ["watchGradeWindowDays", "5"],
    ["watchGradeOtherViewers", "999"],
  ];
  for (const [key, value] of single) {
    const plain = watchGradeSettingError(key, value);
    assert.ok(plain, key);
    assert.equal(watchGradeSettingError(key, value, en), plain, key);
    assert.notEqual(watchGradeSettingError(key, value, es), plain, key);
  }
  assert.equal(
    watchGradeSettingError("watchGradeOtherViewers", "999", es),
    '"watchGradeOtherViewers" debe ser un número entero entre 1 y 100, o 0 para desactivarlo',
  );

  const windowInsideGrace = { ...WATCH_GRADE_DEFAULTS, graceDays: 60, windowDays: 30 };
  const outOfOrder = { ...WATCH_GRADE_DEFAULTS, bandA: 50, bandB: 60 };
  for (const s of [windowInsideGrace, outOfOrder]) {
    const plain = watchGradeCrossFieldError(s);
    assert.ok(plain);
    assert.equal(watchGradeCrossFieldError(s, en), plain);
    assert.notEqual(watchGradeCrossFieldError(s, es), plain);
  }
  assert.equal(
    watchGradeCrossFieldError(outOfOrder, es),
    "El umbral de la A (50 %) debe ser mayor que el de la B (60 %)",
  );
});

test("cleanup settings validator: English unchanged, Spanish with es", () => {
  const bad: unknown[] = [null, { unwatchedEnabled: "yes" }, { votesMin: 0 }, { bogus: 1 }, {}];
  for (const body of bad) {
    const plain = validateCleanupSettingsPatch(body);
    assert.ok("error" in plain, JSON.stringify(body));
    assert.deepEqual(validateCleanupSettingsPatch(body, en), plain, JSON.stringify(body));
    assert.notDeepEqual(validateCleanupSettingsPatch(body, es), plain, JSON.stringify(body));
  }
  assert.deepEqual(validateCleanupSettingsPatch({ bogus: 1 }, es), { error: "Ajuste desconocido: bogus" });
});

test("backup messages: known lib messages translate, English round-trips, unknown text passes through", () => {
  const known = "Invalid password or corrupted backup";
  assert.equal(localizeBackupMessage(known, en), known);
  assert.equal(localizeBackupMessage(known, es), "Contraseña incorrecta o copia de seguridad dañada");
  const dynamic = "Unsupported encrypted backup version: 9";
  assert.equal(localizeBackupMessage(dynamic, es), dynamic);
});

test("fix-match registry: the concurrency refusal speaks the starter's language, English without a translator", async () => {
  _resetFixMatchJobsForTests();
  const never = () => new Promise<never>(() => {});
  for (let i = 0; i < 4; i++) startFixMatchJob(`k${i}`, never);
  const refusal = (t?: typeof en) => {
    try {
      startFixMatchJob("k-extra", never, Date.now(), t);
    } catch (err) {
      assert.ok(err instanceof FixMatchError);
      assert.equal(err.status, 429);
      return err.message;
    }
    assert.fail("expected the running-job cap to refuse");
  };
  const plain = refusal();
  assert.equal(plain, "Too many fix-match operations are already running — wait for one to finish and try again.");
  assert.equal(refusal(en), plain);
  assert.match(refusal(es), /^Ya hay demasiadas correcciones/);
  _resetFixMatchJobsForTests();
});
