// The Discord quota message names the quota window ("3 requests per 1 day").
// A per-user override yields the label "<N> days" (quota.ts). The web path
// translates it with plural forms (translateQuotaWindow → apiUser.quota.window.days
// with a numeric count), but the Discord path used one non-plural key, so a
// 1-day window read "1 días" / "1 jours" / "1 Tage" on Discord and "1 día" on the
// website for the same quota. Both paths now agree in every language.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "discord-quota-window-test-secret-0123456789";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const { quotaWindowLabel } = await import("../src/lib/discord-interactions/reply.ts");
const { translateQuotaWindow } = await import("../src/lib/quota.ts");
const { translatorFor } = await import("../src/lib/i18n/server-locale.ts");
const { LOCALES } = await import("../src/lib/i18n/locales.ts");

test("a 1-day window is singular where the language has a singular", () => {
  assert.equal(quotaWindowLabel(translatorFor("es"), "1 days"), "1 día");
  assert.equal(quotaWindowLabel(translatorFor("fr"), "1 days"), "1 jour");
  assert.equal(quotaWindowLabel(translatorFor("de"), "1 days"), "1 Tag");
  assert.equal(quotaWindowLabel(translatorFor("pt"), "1 days"), "1 dia");
  assert.equal(quotaWindowLabel(translatorFor("it"), "1 days"), "1 giorno");
  assert.equal(quotaWindowLabel(translatorFor("es"), "7 days"), "7 días");
  // English keeps the label quota.ts builds, exactly as the web path does.
  assert.equal(quotaWindowLabel(translatorFor("en"), "1 days"), "1 days");
  assert.equal(quotaWindowLabel(translatorFor("en"), "30 days"), "30 days");
});

test("every language words an '<N> days' window exactly as the web path does", () => {
  for (const locale of LOCALES) {
    const t = translatorFor(locale);
    for (const label of ["0 days", "1 days", "2 days", "7 days", "21 days", "100000 days"]) {
      assert.equal(quotaWindowLabel(t, label), translateQuotaWindow(t, label), `${locale}: ${label}`);
    }
  }
});

test("the other window shapes are unchanged", () => {
  const t = translatorFor("es");
  assert.equal(quotaWindowLabel(t, "day"), "día");
  assert.equal(quotaWindowLabel(t, "week"), "semana");
  assert.equal(quotaWindowLabel(t, undefined), "periodo");
  assert.equal(quotaWindowLabel(t, "fortnight"), "fortnight", "an unknown label passes through");
});
