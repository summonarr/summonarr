// Small, zero-import readers for the JSON Radarr/Sonarr send back. Every field
// of an upstream resource is `unknown` until one of these says otherwise, and
// every string that reaches the browser is bounded. Shared by the admin title
// manager, history/blocklist, calendar and system modules (arr-title.ts,
// arr-history.ts, arr-calendar.ts, arr-system.ts).

export const MAX_TEXT = 500;
const MAX_LABELS = 20;
const MAX_LABEL_LEN = 100;

export const posInt = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null);
export const nonNegInt = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);
export const int = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);
export const text = (v: unknown, max = MAX_TEXT): string => (typeof v === "string" ? v.slice(0, max) : "");
export const textOrNull = (v: unknown, max = MAX_TEXT): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.slice(0, max) : null;
export const bool = (v: unknown): boolean => v === true;
/** A non-negative byte count, else 0 (Radarr/Sonarr send sizes as JSON numbers). */
export const bytes = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
export const bytesOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** An ISO timestamp, normalised, or null when absent or unparseable. */
export function isoOrNull(v: unknown): string | null {
  if (typeof v !== "string" || v === "") return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** The `name`s of a list of {id, name} objects (languages, custom formats) — deduplicated, bounded. */
export function namesOf(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v as Array<{ name?: unknown } | null>) {
    const n = typeof x?.name === "string" ? x.name.trim().slice(0, MAX_LABEL_LEN) : "";
    if (n && !out.includes(n)) out.push(n);
    if (out.length >= MAX_LABELS) break;
  }
  return out;
}

/**
 * A resource's language names: its `languages` list, or — when that is empty
 * or absent — the ONE `language` object Sonarr v3 (episode files, queue,
 * history, releases) and older Radarr send instead.
 */
export function languageNamesOf(r: { languages?: unknown; language?: unknown }): string[] {
  const list = namesOf(r.languages);
  const single = r.language;
  return list.length > 0 || !single || typeof single !== "object" || Array.isArray(single) ? list : namesOf([single]);
}

/** A list of positive integer ids (tags, episode ids), deduplicated; anything else dropped. */
export function idsOf(v: unknown, max = 5_000): number[] {
  if (!Array.isArray(v)) return [];
  const out = new Set<number>();
  for (const x of v) {
    const id = posInt(x);
    if (id !== null) out.add(id);
    if (out.size >= max) break;
  }
  return [...out];
}

export type QualityTag = "proper" | "repack" | "real";

/** The quality name and its revision tags, from a {quality: {name}, revision} object. */
export function qualityOf(v: unknown): { quality: string | null; qualityTags: QualityTag[] } {
  const q = v && typeof v === "object" ? (v as { quality?: { name?: unknown } | null; revision?: unknown }) : null;
  const tags: QualityTag[] = [];
  const r = q?.revision && typeof q.revision === "object" ? (q.revision as { version?: unknown; real?: unknown; isRepack?: unknown }) : null;
  if (r?.isRepack === true) tags.push("repack");
  else if (typeof r?.version === "number" && r.version > 1) tags.push("proper");
  if (typeof r?.real === "number" && r.real > 0) tags.push("real");
  return { quality: textOrNull(q?.quality?.name, 100), qualityTags: tags };
}

export type Protocol = "torrent" | "usenet" | "unknown";

/**
 * A download protocol as Radarr/Sonarr spell it — "torrent"/"usenet" on a
 * resource, or the enum's number (1 usenet, 2 torrent) inside a history
 * record's string data.
 */
export function protocolOf(v: unknown): Protocol {
  const s = typeof v === "string" ? v.trim().toLowerCase() : typeof v === "number" ? String(v) : "";
  if (s === "torrent" || s === "2") return "torrent";
  if (s === "usenet" || s === "1") return "usenet";
  return "unknown";
}

/**
 * A credential that sits in a URL or a message Radarr/Sonarr (or an indexer,
 * or a download client) wrote: an `apikey=`, `api_key=`, `token=`, `passkey=`,
 * `password=`, `auth=`/`authkey=`, `rsskey=`, `secret=`, `sig=` parameter —
 * prefixed spellings too (`jackett_apikey=`, `torrent_pass=`, `x1apikey=`) —
 * and the user:password of a URL. Masked wherever free text from upstream is
 * relayed — an indexer's failure text can quote the request URL it tried.
 */
// The forms a credential takes in upstream text, each masked:
//   apikey=S · apikey%3DS · apikey%253DS (a URL quoted inside another URL, once
//     or twice) · IPTorrents' ;tp=S
//   "apiKey": "S" · api_key = S · X-Api-Key: S · passkey:S (JSON, headers, logs)
//   "password": "S with spaces; and, punctuation" — a QUOTED value is masked up
//     to its matching quote, escaped JSON (\"apiKey\":\"S\") included
//   Authorization: <any scheme> S · Bearer S / bearer S / Basic S
//   //user:S@host — userinfo up to the LAST @ before the path, so a password
//     containing @ is masked whole
//   /<32+ char token> or .<32+ char token> — a passkey carried as a path
//     segment (tracker RSS/announce, UNIT3D's /rss/<id>.<key>), ending at any
//     URL or bracket delimiter: the arrs quote a failing URL as `at [<url>]`
//   torrentleech.org/<key> — TorrentLeech's shorter path key (the arrs' own
//     log cleanser masks it the same way)
// The name prefix is bounded ({0,64}): unbounded, a long run of letters and
// `-`/`_` made every rule that uses it quadratic. A longer name still matches
// from its last `-`/`_`.
const SECRET_NAME = "[A-Za-z0-9_-]{0,64}(?:api[_-]?key|token|pass(?:key|word)?|auth(?:key)?|rsskey|secret|sig|key)";
const SECRET_PARAM = new RegExp(`(?<=^|[^A-Za-z0-9]|%[0-9A-Fa-f]{2})(${SECRET_NAME}|r|tp)(=|%3[dD]|%253[dD])([^&\\s\\]\\)"'<>]+)`, "gi");
// A quoted value, up to its matching (optionally backslash-escaped) quote; a
// backslash-escaped character inside it doesn't end it. The two value branches
// are DISJOINT — a backslash is only ever eaten by the escape branch. With a
// plain `.` beside `\\.`, a run of escapes with no closing quote could be split
// 2^n ways and the backtracking pinned the event loop for hours (a release or
// file name the arrs quote is enough). The optional `\\` before the close keeps
// a value ending in a lone backslash (`"pa ss\"`) masked — still linear.
const QUOTED_PAIR = new RegExp(`(?<![A-Za-z0-9])(\\\\?["']?)(${SECRET_NAME})\\1(\\s*[:=]\\s*)(\\\\?["'])((?:(?!\\4)(?:\\\\.|[^\\\\\\r\\n\\u2028\\u2029]))*\\\\?)\\4`, "gi");
const SECRET_PAIR = new RegExp(`(?<![A-Za-z0-9])(["']?)(${SECRET_NAME})\\1(\\s*[:=]\\s*)(["']?)([^"'&\\s,;\\]\\)}<>]+)\\4`, "gi");
const AUTH_HEADER = /(\bAuthorization\\?["']?\s*[:=]\s*\\?["']?)(?:[A-Za-z-]+\s+)?[A-Za-z0-9._~+/=-]+/gi;
const AUTH_SCHEME = /\b([Bb]earer|Basic)\s+[A-Za-z0-9._~+/=-]+/g;
const URL_USERINFO = /(\/\/)(?=[^/\s?#]*:)[^/\s?#]*@/g;
const PATH_TOKEN = /([/.])[A-Za-z0-9_-]{32,}(?=[/?#\s"'<>.,;\])}]|$)/g;
const TORRENTLEECH = /(torrentleech\.org\/(?:rss\/download\/\d+\/)?)(?!rss\b)[A-Za-z0-9]{10,}/gi;
export function maskSecrets(s: string): string {
  const pair = (_m: string, q: string, name: string, sep: string, vq: string) => `${q}${name}${q}${sep}${vq}••••••••${vq}`;
  return s
    .replace(SECRET_PARAM, (_m, name: string, eq: string) => `${name}${eq}••••••••`)
    .replace(QUOTED_PAIR, pair)
    .replace(SECRET_PAIR, pair)
    .replace(AUTH_HEADER, "$1••••••••")
    .replace(AUTH_SCHEME, "$1 ••••••••")
    .replace(URL_USERINFO, "$1••••••••@")
    .replace(PATH_TOKEN, "$1••••••••")
    .replace(TORRENTLEECH, "$1••••••••");
}

// safeMessage masks only a bounded prefix: its answer is cut to `max` anyway,
// and an upstream error body can be megabytes (arrFetch reads it whole, up to
// its 50 MB cap) — every message relayed went through every rule above.
const MASK_SLACK = 4_096;
// After a cut: the quoted credential the cut went through has no closing quote
// left, so no rule above sees it — masked to the end.
const OPEN_QUOTED_TAIL = new RegExp(`((?<![A-Za-z0-9])(\\\\?["']?)${SECRET_NAME}\\2\\s*[:=]\\s*(\\\\?["']))(?:(?!\\3).)*$`, "i");

/** Upstream free text for the browser: one line, credentials masked, bounded. */
export function safeMessage(v: unknown, max = MAX_TEXT): string | null {
  if (typeof v !== "string") return null;
  const cut = v.length > max + MASK_SLACK;
  let s = (cut ? v.slice(0, max + MASK_SLACK) : v).replace(/[\r\n\t]+/g, " ").trim();
  if (cut) {
    // The token the cut went through can be HALF a credential no rule would
    // recognise any more (a path key under 32 characters, userinfo with no @):
    // drop it. Masking can shorten the text, so what follows a long masked
    // value can still move into the first `max` characters.
    const whole = s.replace(/[^\s/?&#;,]+$/, "");
    if (whole.trim() !== "") s = whole;
    s = maskSecrets(s).replace(OPEN_QUOTED_TAIL, "$1••••••••").trim();
  } else {
    s = maskSecrets(s);
  }
  return s === "" ? null : s.slice(0, max);
}
