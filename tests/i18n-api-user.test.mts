// The user-facing API messages (catalog area apiUser.*).
//
// - Every literal t("apiUser.…") key in src/ exists in the English catalog. The
//   generic usage scan in i18n.test.mts only reads files that import a client/
//   page translator, so route handlers using translatorForRequest are covered
//   here instead — a typo would otherwise ship the raw dotted id as an error.
// - The quota window label: English output stays byte-identical to the label
//   quota.ts builds (including its "1 days"), Spanish gets real words.
// The route-level pins (Spanish with the cookie / Accept-Language, English with
// no hints or from a native client) live in requests-route.test.mts and
// auto-request.test.mts, beside the harnesses they need.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const { translatorFor } = await import("../src/lib/i18n/server-locale.ts");
const { translateQuotaWindow } = await import("../src/lib/quota.ts");

const ROOT = new URL("..", import.meta.url).pathname;
const en: Record<string, string> = JSON.parse(readFileSync(join(ROOT, "src/lib/i18n/messages/en/apiUser.json"), "utf8"));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "generated") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

test("every literal apiUser.* key used in src/ exists in the English catalog", () => {
  const missing: string[] = [];
  for (const file of walk(join(ROOT, "src"))) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/["'](apiUser\.[a-zA-Z0-9_.]+)["']/g)) {
      const key = m[1];
      const plural = Object.keys(en).some((k) => k.startsWith(`${key}_`));
      if (!(key in en) && !plural) missing.push(`${file.slice(ROOT.length)}: ${key}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("translateQuotaWindow: English is the label verbatim; Spanish translates every shape", () => {
  const tEn = translatorFor("en");
  for (const label of ["day", "week", "month", "1 days", "3 days", "30 days"]) {
    assert.equal(translateQuotaWindow(tEn, label), label);
  }
  assert.equal(translateQuotaWindow(tEn, undefined), "period");
  const tEs = translatorFor("es");
  assert.equal(translateQuotaWindow(tEs, "day"), "día");
  assert.equal(translateQuotaWindow(tEs, "week"), "semana");
  assert.equal(translateQuotaWindow(tEs, "month"), "mes");
  assert.equal(translateQuotaWindow(tEs, undefined), "periodo");
  assert.equal(translateQuotaWindow(tEs, "1 days"), "1 día");
  assert.equal(translateQuotaWindow(tEs, "7 days"), "7 días");
  assert.equal(translateQuotaWindow(tEs, "fortnight"), "fortnight", "an unknown label passes through");
});

test("the batch Arr-failure summary keeps its English wording per count", () => {
  const t = translatorFor("en");
  assert.equal(
    t("apiUser.requests.batch.arrFailed", { count: 1, list: '"A": x' }),
    "1 request couldn't be sent to Radarr/Sonarr and went back to Pending — \"A\": x",
  );
  assert.equal(
    t("apiUser.requests.batch.arrFailed", { count: 2, list: "L" }),
    "2 requests couldn't be sent to Radarr/Sonarr and went back to Pending — L",
  );
  assert.equal(
    t("apiUser.requests.batch.arrFailedMore", { count: 5, list: "L", more: 2 }),
    "5 requests couldn't be sent to Radarr/Sonarr and went back to Pending — L; and 2 more",
  );
  assert.equal(
    translatorFor("es")("apiUser.requests.batch.arrFailed", { count: 1, list: "L" }),
    "1 solicitud no se pudo enviar a Radarr/Sonarr y volvió a Pendiente — L",
  );
});
