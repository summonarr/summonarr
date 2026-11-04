// Wording pins for four translation fixes from the post-v0.34.0 audit. The
// parity tests in tests/i18n.test.mts only check keys and placeholders, so a
// string can say the wrong thing in one language and still pass them. Each pin
// below checks the one property the fix restored.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { LOCALES } from "../src/lib/i18n/locales.ts";

const MESSAGES = join(new URL("..", import.meta.url).pathname, "src/lib/i18n/messages");

function readCatalog(locale: string): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const file of readdirSync(join(MESSAGES, locale)).filter((f) => f.endsWith(".json"))) {
    Object.assign(merged, JSON.parse(readFileSync(join(MESSAGES, locale, file), "utf8")));
  }
  return merged;
}

const catalogs = Object.fromEntries(LOCALES.map((l) => [l, readCatalog(l)])) as Record<string, Record<string, string>>;
const translated = LOCALES.filter((l) => l !== "en");

test("the Replace file panel names 'Unmonitor Deleted' in each language, like its sibling 'Redownload Failed'", () => {
  for (const locale of translated) {
    const text = catalogs[locale]["adminQueue.issueActions.replaceFileRemonitored"];
    assert.ok(text, `${locale}: key missing`);
    assert.doesNotMatch(text, /Unmonitor Deleted/, `${locale}: the setting name is left in English`);
  }
});

test("es/pt: a grab still in flight is 'being grabbed', never 'already downloading'", () => {
  for (const locale of ["es", "pt"]) {
    const text = catalogs[locale]["apiUser.requests.releases.grabInProgress"];
    // The in-flight grab can still be refused, so nothing is downloading yet.
    assert.doesNotMatch(text, /descarg|baixad/i, `${locale}: claims a download`);
    // The same verb the sibling grabRefused uses for "grab".
    assert.match(text, /captur/i, `${locale}: does not say "grab"`);
  }
  assert.doesNotMatch(catalogs.pt["apiUser.requests.releases.grabInProgress"], /vers[aã]o/i, "pt says 'release' elsewhere");
});

// "surveiller" is French for Radarr/Sonarr "Monitored" across the catalog, so a
// "needs attention" string that uses it reads as "to be monitored".
const needsAttention = Object.keys(catalogs.en).filter((k) => /needs? (your )?attention/i.test(catalogs.en[k]));
// Keys exempted while their fix was pending. Empty: the settingsForms key
// (cross-unit request C115) now reads "Téléchargement à traiter" in fr.
const LEAD_PENDING = new Set<string>();

test("fr: no 'needs attention' string says 'surveiller'", () => {
  assert.ok(needsAttention.length >= 6, "the English 'needs attention' keys were not found");
  assert.ok(needsAttention.includes("settings.form.agents.event.arr.queue_attention"), "the notification-agent event label is covered");
  const offenders = needsAttention.filter((k) => !LEAD_PENDING.has(k) && /surveill/i.test(catalogs.fr[k]));
  assert.deepEqual(offenders, []);
});

test("a 404 from Radarr/Sonarr points at the configured address first, in every language", () => {
  assert.match(catalogs.en["adminArr.error.notFound"], /address/);
  for (const locale of LOCALES) {
    // Each language's own "Settings → Media" path, as the unreachable error words it.
    const path = /\p{L}+ → \p{L}+/u.exec(catalogs[locale]["adminArr.error.unreachable"])?.[0];
    assert.ok(path, `${locale}: no settings path in adminArr.error.unreachable`);
    const text = catalogs[locale]["adminArr.error.notFound"];
    assert.ok(text.includes(path), `${locale}: notFound does not send the admin to ${path}`);
  }
});
