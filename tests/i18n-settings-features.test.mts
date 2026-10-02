// The Settings → Features switches render their label/description from the
// catalogs, keyed by a slug of the registry key (features-form.tsx). A flag
// missing from a catalog silently falls back to the registry's English, so
// pin that every registered flag has both entries in every locale — and that
// the English entries still say what the registry says.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { FEATURE_DEFINITIONS } from "../src/lib/features.ts";
import { LOCALES } from "../src/lib/i18n/locales.ts";

const MESSAGES = join(new URL("..", import.meta.url).pathname, "src/lib/i18n/messages");

function catalog(locale: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of readdirSync(join(MESSAGES, locale)).filter((n) => n.endsWith(".json"))) {
    Object.assign(out, JSON.parse(readFileSync(join(MESSAGES, locale, f), "utf8")));
  }
  return out;
}

// Mirrors featureText() in src/components/settings/features-form.tsx.
const slugOf = (key: string) => key.replace(/^feature\./, "").replaceAll(".", "_");

test("every feature flag has a translated label and description in every locale", () => {
  for (const locale of LOCALES) {
    const cat = catalog(locale);
    for (const f of FEATURE_DEFINITIONS) {
      const slug = slugOf(f.key);
      assert.ok(cat[`settings.featureLabel.${slug}`], `${locale}: label for ${f.key}`);
      assert.ok(cat[`settings.featureDesc.${slug}`], `${locale}: description for ${f.key}`);
    }
  }
});

test("the English feature entries match the registry wording", () => {
  const en = catalog("en");
  for (const f of FEATURE_DEFINITIONS) {
    const slug = slugOf(f.key);
    assert.equal(en[`settings.featureLabel.${slug}`], f.label, f.key);
    assert.equal(en[`settings.featureDesc.${slug}`], f.description, f.key);
  }
});

test("no catalog carries a feature entry the registry no longer has", () => {
  const slugs = new Set(FEATURE_DEFINITIONS.map((f) => slugOf(f.key)));
  for (const key of Object.keys(catalog("en"))) {
    const m = /^settings\.feature(?:Label|Desc)\.(.+)$/.exec(key);
    if (m) assert.ok(slugs.has(m[1]), `stale ${key}`);
  }
});
