// The message catalogs. English is the source of truth: every other catalog
// must carry exactly its keys with the same placeholders (pinned by
// tests/i18n.test.mts), and anything missing at runtime falls back to it.
//
// Each locale is split into one file per screen area (messages/<locale>/<area>.json)
// so separate areas can be translated in parallel without colliding in one big
// file. Keys stay fully qualified ("nav.movies") inside each file, and a key
// may live in only one area — the test fails on a duplicate. Adding an area
// means adding its import to BOTH locales below.
//
// Statically imported (not lazily) because the active catalog is shipped to
// the client in the root layout anyway, and the catalogs are small.

import type { Locale } from "./locales";
import type { Messages } from "./translate";
import enAppearance from "./messages/en/appearance.json";
import enNav from "./messages/en/nav.json";
import enPersonal from "./messages/en/personal.json";
import enRequests from "./messages/en/requests.json";
import enSearch from "./messages/en/search.json";
import esAppearance from "./messages/es/appearance.json";
import esNav from "./messages/es/nav.json";
import esPersonal from "./messages/es/personal.json";
import esRequests from "./messages/es/requests.json";
import esSearch from "./messages/es/search.json";

export const CATALOGS: Record<Locale, Messages> = {
  en: { ...enAppearance, ...enNav, ...enPersonal, ...enRequests, ...enSearch },
  es: { ...esAppearance, ...esNav, ...esPersonal, ...esRequests, ...esSearch },
};

export const FALLBACK_MESSAGES: Messages = CATALOGS.en;
