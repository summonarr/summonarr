// The message catalogs. English is the source of truth: every other catalog
// must carry exactly its keys with the same placeholders (pinned by
// tests/i18n.test.mts), and anything missing at runtime falls back to it.
//
// Statically imported (not lazily) because the active catalog is shipped to
// the client in the root layout anyway, and the catalogs are small.

import type { Locale } from "./locales";
import type { Messages } from "./translate";
import en from "./messages/en.json";
import es from "./messages/es.json";

export const CATALOGS: Record<Locale, Messages> = { en, es };

export const FALLBACK_MESSAGES: Messages = en;
