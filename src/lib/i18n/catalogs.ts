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
import enAuth from "./messages/en/auth.json";
import enBrowse from "./messages/en/browse.json";
import enDetail from "./messages/en/detail.json";
import enHome from "./messages/en/home.json";
import enMedia from "./messages/en/media.json";
import enNav from "./messages/en/nav.json";
import enPersonal from "./messages/en/personal.json";
import enProfile from "./messages/en/profile.json";
import enRequest from "./messages/en/request.json";
import enRequests from "./messages/en/requests.json";
import enSearch from "./messages/en/search.json";
import enSettings from "./messages/en/settings.json";
import esAppearance from "./messages/es/appearance.json";
import esAuth from "./messages/es/auth.json";
import esBrowse from "./messages/es/browse.json";
import esDetail from "./messages/es/detail.json";
import esHome from "./messages/es/home.json";
import esMedia from "./messages/es/media.json";
import esNav from "./messages/es/nav.json";
import esPersonal from "./messages/es/personal.json";
import esProfile from "./messages/es/profile.json";
import esRequest from "./messages/es/request.json";
import esRequests from "./messages/es/requests.json";
import esSearch from "./messages/es/search.json";
import esSettings from "./messages/es/settings.json";

export const CATALOGS: Record<Locale, Messages> = {
  en: { ...enAppearance, ...enAuth, ...enBrowse, ...enDetail, ...enHome, ...enMedia, ...enNav, ...enPersonal, ...enProfile, ...enRequest, ...enRequests, ...enSearch, ...enSettings },
  es: { ...esAppearance, ...esAuth, ...esBrowse, ...esDetail, ...esHome, ...esMedia, ...esNav, ...esPersonal, ...esProfile, ...esRequest, ...esRequests, ...esSearch, ...esSettings },
};

export const FALLBACK_MESSAGES: Messages = CATALOGS.en;
