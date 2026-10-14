// The message catalogs. English is the source of truth: every other catalog
// must carry exactly its keys with the same placeholders (pinned by
// tests/i18n.test.mts), and anything missing at runtime falls back to it.
//
// Each locale is split into one file per screen area (messages/<locale>/<area>.json)
// so separate areas can be translated in parallel without colliding in one big
// file. Keys stay fully qualified ("nav.movies") inside each file, and a key
// may live in only one area — the test fails on a duplicate. Adding an area
// means adding its import to EVERY locale below.
//
// Statically imported (not lazily): the server translates from every area, and
// the root layout ships the client-visible subset (see clientCatalog).

import type { Locale } from "./locales";
import type { Messages } from "./translate";
import enAdminActivity from "./messages/en/adminActivity.json";
import enAdminArr from "./messages/en/adminArr.json";
import enAdminManage from "./messages/en/adminManage.json";
import enAdminQueue from "./messages/en/adminQueue.json";
import enApiAdmin from "./messages/en/apiAdmin.json";
import enApiAuth from "./messages/en/apiAuth.json";
import enApiUser from "./messages/en/apiUser.json";
import enAppearance from "./messages/en/appearance.json";
import enAuth from "./messages/en/auth.json";
import enBrowse from "./messages/en/browse.json";
import enDetail from "./messages/en/detail.json";
import enHome from "./messages/en/home.json";
import enMedia from "./messages/en/media.json";
import enNav from "./messages/en/nav.json";
import enNotify from "./messages/en/notify.json";
import enPersonal from "./messages/en/personal.json";
import enProfile from "./messages/en/profile.json";
import enRequest from "./messages/en/request.json";
import enRequests from "./messages/en/requests.json";
import enSearch from "./messages/en/search.json";
import enSettings from "./messages/en/settings.json";
import enSettingsForms from "./messages/en/settingsForms.json";
import enShared from "./messages/en/shared.json";
import enTrash from "./messages/en/trash.json";
import esAdminActivity from "./messages/es/adminActivity.json";
import esAdminArr from "./messages/es/adminArr.json";
import esAdminManage from "./messages/es/adminManage.json";
import esAdminQueue from "./messages/es/adminQueue.json";
import esApiAdmin from "./messages/es/apiAdmin.json";
import esApiAuth from "./messages/es/apiAuth.json";
import esApiUser from "./messages/es/apiUser.json";
import esAppearance from "./messages/es/appearance.json";
import esAuth from "./messages/es/auth.json";
import esBrowse from "./messages/es/browse.json";
import esDetail from "./messages/es/detail.json";
import esHome from "./messages/es/home.json";
import esMedia from "./messages/es/media.json";
import esNav from "./messages/es/nav.json";
import esNotify from "./messages/es/notify.json";
import esPersonal from "./messages/es/personal.json";
import esProfile from "./messages/es/profile.json";
import esRequest from "./messages/es/request.json";
import esRequests from "./messages/es/requests.json";
import esSearch from "./messages/es/search.json";
import esSettings from "./messages/es/settings.json";
import esSettingsForms from "./messages/es/settingsForms.json";
import esShared from "./messages/es/shared.json";
import esTrash from "./messages/es/trash.json";
import frAdminActivity from "./messages/fr/adminActivity.json";
import frAdminArr from "./messages/fr/adminArr.json";
import frAdminManage from "./messages/fr/adminManage.json";
import frAdminQueue from "./messages/fr/adminQueue.json";
import frApiAdmin from "./messages/fr/apiAdmin.json";
import frApiAuth from "./messages/fr/apiAuth.json";
import frApiUser from "./messages/fr/apiUser.json";
import frAppearance from "./messages/fr/appearance.json";
import frAuth from "./messages/fr/auth.json";
import frBrowse from "./messages/fr/browse.json";
import frDetail from "./messages/fr/detail.json";
import frHome from "./messages/fr/home.json";
import frMedia from "./messages/fr/media.json";
import frNav from "./messages/fr/nav.json";
import frNotify from "./messages/fr/notify.json";
import frPersonal from "./messages/fr/personal.json";
import frProfile from "./messages/fr/profile.json";
import frRequest from "./messages/fr/request.json";
import frRequests from "./messages/fr/requests.json";
import frSearch from "./messages/fr/search.json";
import frSettings from "./messages/fr/settings.json";
import frSettingsForms from "./messages/fr/settingsForms.json";
import frShared from "./messages/fr/shared.json";
import frTrash from "./messages/fr/trash.json";
import deAdminActivity from "./messages/de/adminActivity.json";
import deAdminArr from "./messages/de/adminArr.json";
import deAdminManage from "./messages/de/adminManage.json";
import deAdminQueue from "./messages/de/adminQueue.json";
import deApiAdmin from "./messages/de/apiAdmin.json";
import deApiAuth from "./messages/de/apiAuth.json";
import deApiUser from "./messages/de/apiUser.json";
import deAppearance from "./messages/de/appearance.json";
import deAuth from "./messages/de/auth.json";
import deBrowse from "./messages/de/browse.json";
import deDetail from "./messages/de/detail.json";
import deHome from "./messages/de/home.json";
import deMedia from "./messages/de/media.json";
import deNav from "./messages/de/nav.json";
import deNotify from "./messages/de/notify.json";
import dePersonal from "./messages/de/personal.json";
import deProfile from "./messages/de/profile.json";
import deRequest from "./messages/de/request.json";
import deRequests from "./messages/de/requests.json";
import deSearch from "./messages/de/search.json";
import deSettings from "./messages/de/settings.json";
import deSettingsForms from "./messages/de/settingsForms.json";
import deShared from "./messages/de/shared.json";
import deTrash from "./messages/de/trash.json";
import ptAdminActivity from "./messages/pt/adminActivity.json";
import ptAdminArr from "./messages/pt/adminArr.json";
import ptAdminManage from "./messages/pt/adminManage.json";
import ptAdminQueue from "./messages/pt/adminQueue.json";
import ptApiAdmin from "./messages/pt/apiAdmin.json";
import ptApiAuth from "./messages/pt/apiAuth.json";
import ptApiUser from "./messages/pt/apiUser.json";
import ptAppearance from "./messages/pt/appearance.json";
import ptAuth from "./messages/pt/auth.json";
import ptBrowse from "./messages/pt/browse.json";
import ptDetail from "./messages/pt/detail.json";
import ptHome from "./messages/pt/home.json";
import ptMedia from "./messages/pt/media.json";
import ptNav from "./messages/pt/nav.json";
import ptNotify from "./messages/pt/notify.json";
import ptPersonal from "./messages/pt/personal.json";
import ptProfile from "./messages/pt/profile.json";
import ptRequest from "./messages/pt/request.json";
import ptRequests from "./messages/pt/requests.json";
import ptSearch from "./messages/pt/search.json";
import ptSettings from "./messages/pt/settings.json";
import ptSettingsForms from "./messages/pt/settingsForms.json";
import ptShared from "./messages/pt/shared.json";
import ptTrash from "./messages/pt/trash.json";
import itAdminActivity from "./messages/it/adminActivity.json";
import itAdminArr from "./messages/it/adminArr.json";
import itAdminManage from "./messages/it/adminManage.json";
import itAdminQueue from "./messages/it/adminQueue.json";
import itApiAdmin from "./messages/it/apiAdmin.json";
import itApiAuth from "./messages/it/apiAuth.json";
import itApiUser from "./messages/it/apiUser.json";
import itAppearance from "./messages/it/appearance.json";
import itAuth from "./messages/it/auth.json";
import itBrowse from "./messages/it/browse.json";
import itDetail from "./messages/it/detail.json";
import itHome from "./messages/it/home.json";
import itMedia from "./messages/it/media.json";
import itNav from "./messages/it/nav.json";
import itNotify from "./messages/it/notify.json";
import itPersonal from "./messages/it/personal.json";
import itProfile from "./messages/it/profile.json";
import itRequest from "./messages/it/request.json";
import itRequests from "./messages/it/requests.json";
import itSearch from "./messages/it/search.json";
import itSettings from "./messages/it/settings.json";
import itSettingsForms from "./messages/it/settingsForms.json";
import itShared from "./messages/it/shared.json";
import itTrash from "./messages/it/trash.json";
import zhAdminActivity from "./messages/zh/adminActivity.json";
import zhAdminArr from "./messages/zh/adminArr.json";
import zhAdminManage from "./messages/zh/adminManage.json";
import zhAdminQueue from "./messages/zh/adminQueue.json";
import zhApiAdmin from "./messages/zh/apiAdmin.json";
import zhApiAuth from "./messages/zh/apiAuth.json";
import zhApiUser from "./messages/zh/apiUser.json";
import zhAppearance from "./messages/zh/appearance.json";
import zhAuth from "./messages/zh/auth.json";
import zhBrowse from "./messages/zh/browse.json";
import zhDetail from "./messages/zh/detail.json";
import zhHome from "./messages/zh/home.json";
import zhMedia from "./messages/zh/media.json";
import zhNav from "./messages/zh/nav.json";
import zhNotify from "./messages/zh/notify.json";
import zhPersonal from "./messages/zh/personal.json";
import zhProfile from "./messages/zh/profile.json";
import zhRequest from "./messages/zh/request.json";
import zhRequests from "./messages/zh/requests.json";
import zhSearch from "./messages/zh/search.json";
import zhSettings from "./messages/zh/settings.json";
import zhSettingsForms from "./messages/zh/settingsForms.json";
import zhShared from "./messages/zh/shared.json";
import zhTrash from "./messages/zh/trash.json";

// Every area of every locale, keyed by area name, so a caller can compose a
// catalog from the areas it needs. CATALOGS below is the union (server use).
const AREAS: Record<Locale, Record<string, Messages>> = {
  en: { adminActivity: enAdminActivity, adminArr: enAdminArr, adminManage: enAdminManage, adminQueue: enAdminQueue, apiAdmin: enApiAdmin, apiAuth: enApiAuth, apiUser: enApiUser, appearance: enAppearance, auth: enAuth, browse: enBrowse, detail: enDetail, home: enHome, media: enMedia, nav: enNav, notify: enNotify, personal: enPersonal, profile: enProfile, request: enRequest, requests: enRequests, search: enSearch, settings: enSettings, settingsForms: enSettingsForms, shared: enShared, trash: enTrash },
  es: { adminActivity: esAdminActivity, adminArr: esAdminArr, adminManage: esAdminManage, adminQueue: esAdminQueue, apiAdmin: esApiAdmin, apiAuth: esApiAuth, apiUser: esApiUser, appearance: esAppearance, auth: esAuth, browse: esBrowse, detail: esDetail, home: esHome, media: esMedia, nav: esNav, notify: esNotify, personal: esPersonal, profile: esProfile, request: esRequest, requests: esRequests, search: esSearch, settings: esSettings, settingsForms: esSettingsForms, shared: esShared, trash: esTrash },
  fr: { adminActivity: frAdminActivity, adminArr: frAdminArr, adminManage: frAdminManage, adminQueue: frAdminQueue, apiAdmin: frApiAdmin, apiAuth: frApiAuth, apiUser: frApiUser, appearance: frAppearance, auth: frAuth, browse: frBrowse, detail: frDetail, home: frHome, media: frMedia, nav: frNav, notify: frNotify, personal: frPersonal, profile: frProfile, request: frRequest, requests: frRequests, search: frSearch, settings: frSettings, settingsForms: frSettingsForms, shared: frShared, trash: frTrash },
  de: { adminActivity: deAdminActivity, adminArr: deAdminArr, adminManage: deAdminManage, adminQueue: deAdminQueue, apiAdmin: deApiAdmin, apiAuth: deApiAuth, apiUser: deApiUser, appearance: deAppearance, auth: deAuth, browse: deBrowse, detail: deDetail, home: deHome, media: deMedia, nav: deNav, notify: deNotify, personal: dePersonal, profile: deProfile, request: deRequest, requests: deRequests, search: deSearch, settings: deSettings, settingsForms: deSettingsForms, shared: deShared, trash: deTrash },
  pt: { adminActivity: ptAdminActivity, adminArr: ptAdminArr, adminManage: ptAdminManage, adminQueue: ptAdminQueue, apiAdmin: ptApiAdmin, apiAuth: ptApiAuth, apiUser: ptApiUser, appearance: ptAppearance, auth: ptAuth, browse: ptBrowse, detail: ptDetail, home: ptHome, media: ptMedia, nav: ptNav, notify: ptNotify, personal: ptPersonal, profile: ptProfile, request: ptRequest, requests: ptRequests, search: ptSearch, settings: ptSettings, settingsForms: ptSettingsForms, shared: ptShared, trash: ptTrash },
  it: { adminActivity: itAdminActivity, adminArr: itAdminArr, adminManage: itAdminManage, adminQueue: itAdminQueue, apiAdmin: itApiAdmin, apiAuth: itApiAuth, apiUser: itApiUser, appearance: itAppearance, auth: itAuth, browse: itBrowse, detail: itDetail, home: itHome, media: itMedia, nav: itNav, notify: itNotify, personal: itPersonal, profile: itProfile, request: itRequest, requests: itRequests, search: itSearch, settings: itSettings, settingsForms: itSettingsForms, shared: itShared, trash: itTrash },
  zh: { adminActivity: zhAdminActivity, adminArr: zhAdminArr, adminManage: zhAdminManage, adminQueue: zhAdminQueue, apiAdmin: zhApiAdmin, apiAuth: zhApiAuth, apiUser: zhApiUser, appearance: zhAppearance, auth: zhAuth, browse: zhBrowse, detail: zhDetail, home: zhHome, media: zhMedia, nav: zhNav, notify: zhNotify, personal: zhPersonal, profile: zhProfile, request: zhRequest, requests: zhRequests, search: zhSearch, settings: zhSettings, settingsForms: zhSettingsForms, shared: zhShared, trash: zhTrash },
};

function merge(areas: Record<string, Messages>, pick?: (area: string) => boolean): Messages {
  const out: Record<string, string> = {};
  for (const [name, messages] of Object.entries(areas)) {
    if (!pick || pick(name)) Object.assign(out, messages);
  }
  return out;
}

export const CATALOGS: Record<Locale, Messages> = Object.fromEntries(
  (Object.keys(AREAS) as Locale[]).map((l) => [l, merge(AREAS[l])]),
) as Record<Locale, Messages>;

// What the BROWSER needs is a subset of what the server needs. The root layout
// serialises the active catalog into every full page load, so shipping all 24
// areas cost ~100 KB gzipped on every document, the login page included.
//
//   SERVER_ONLY_AREAS — read only by route handlers and server libs. No client
//     module can reach a key in these (tests/i18n-client-catalog.test.mts walks
//     the client import graph to prove it), so they are never sent.
//   ADMIN_ONLY_AREAS — read only by admin-gated client UI (the admin pages, the
//     ADMIN-only /settings page, and the admin chips on the detail pages). Sent
//     only to a session that passes the same gate as the admin layout.
//
// Everything else ships to everyone. Server-side translation is unaffected: it
// reads CATALOGS, which still holds every area.
export const SERVER_ONLY_AREAS: readonly string[] = ["apiAdmin", "apiAuth", "apiUser"];
export const ADMIN_ONLY_AREAS: readonly string[] = [
  "adminArr",
  "adminManage",
  "adminQueue",
  "settings",
  "settingsForms",
  "trash",
];

const CLIENT_CACHE = new Map<string, Messages>();

/** The catalog to hand to the client provider. Memoised per (locale, admin) so
 *  the provider's useMemo sees a stable object across renders. */
export function clientCatalog(locale: Locale, includeAdmin: boolean): Messages {
  const cacheKey = `${locale}:${includeAdmin ? "admin" : "user"}`;
  let cached = CLIENT_CACHE.get(cacheKey);
  if (!cached) {
    cached = merge(
      AREAS[locale],
      (area) => !SERVER_ONLY_AREAS.includes(area) && (includeAdmin || !ADMIN_ONLY_AREAS.includes(area)),
    );
    CLIENT_CACHE.set(cacheKey, cached);
  }
  return cached;
}

/** Area names that exist for a locale — for tests pinning the two lists above. */
export function catalogAreas(locale: Locale): string[] {
  return Object.keys(AREAS[locale]);
}

export const FALLBACK_MESSAGES: Messages = CATALOGS.en;
