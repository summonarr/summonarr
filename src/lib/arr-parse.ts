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
 * prefixed spellings too (`jackett_apikey=`, `torrent_pass=`) — and the
 * user:password of a URL. Masked wherever free text from upstream is relayed —
 * an indexer's failure text can quote the request URL it tried.
 */
const SECRET_PARAM = /(?<![A-Za-z0-9])([A-Za-z_-]*(?:api[_-]?key|token|pass(?:key|word)?|auth(?:key)?|rsskey|secret|sig|key)|r)=([^&\s\]\)"'<>]+)/gi;
const URL_USERINFO = /(\/\/)[^/@\s:]+:[^/@\s]+@/g;
export function maskSecrets(s: string): string {
  return s.replace(SECRET_PARAM, (_m, name: string) => `${name}=••••••••`).replace(URL_USERINFO, "$1••••••••@");
}

/** Upstream free text for the browser: one line, credentials masked, bounded. */
export function safeMessage(v: unknown, max = MAX_TEXT): string | null {
  if (typeof v !== "string") return null;
  const s = maskSecrets(v.replace(/[\r\n\t]+/g, " ").trim());
  return s === "" ? null : s.slice(0, max);
}
