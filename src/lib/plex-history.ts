// The server's own all-account watch history — READ-ONLY evidence for the
// never-watched report (src/lib/upstream-watch.ts explains the use and lists the
// UNVERIFIED response-shape assumptions), the For You import and watch sync.
// Newest first, so a walk stopped at `maxItems` keeps the most recent views.
// Parsed while paging, so the raw records never accumulate in memory.
//
// The cap counts WATCH RECORDS (countsAsPlexWatchRecord), not raw records: a
// music-heavy history would otherwise hit it on track plays and drop the
// oldest VIDEO views — the pre-install ones the snapshot exists for. Raw
// records get their own ceiling, kept below plexFetchAllPages' silent 2M one so
// that a walk stopped by it is still reported `truncated`.
import { countsAsPlexWatchRecord, parsePlexHistoryItem, type PlexHistoryEntry } from "./upstream-watch";
import { asRecord, STOP_PAGING } from "./media-server-payload";
import { plexFetchAllPages, plexUrl } from "./plex-http";

export const PLEX_WATCH_HISTORY_MAX_ITEMS = 500_000;
export const PLEX_WATCH_HISTORY_MAX_RAW = 1_500_000;

export interface PlexWatchHistory {
  // Every record the parser could place (movies and episodes with a key).
  entries: PlexHistoryEntry[];
  // Watch records the server returned — music/photo/extras excluded, records the
  // parser could NOT place included. More records than placeable entries (above
  // all, records > 0 with nothing matching the library) is how a changed
  // response shape shows up instead of reading as "nobody watched anything".
  records: number;
  // The walk stopped at a cap with older history still unread (a record past
  // the cap was seen); the caller must not read the result as complete.
  truncated: boolean;
  // The walk stopped because the caller's signal fired: the result is partial
  // and is returned, never thrown (guardrail 41). Callers discard it.
  aborted: boolean;
}

export interface PlexWatchHistoryOptions {
  signal?: AbortSignal;
  maxItems?: number;
  maxRaw?: number;
  // An incremental read (watch sync). The history is sorted newest first, so
  // the first DATED record older than this ends the walk — nothing past it is
  // kept — and the result is complete for (stopBefore, now]. It is also sent
  // to Plex as a `viewedAt>` filter (python-plexapi's history(mindate=)), so
  // the server can skip the rest.
  stopBefore?: Date;
  // One account's records only (python-plexapi's history(accountID=)) — the
  // LOCAL account id ("1" for the owner). Both filters are UNVERIFIED against
  // a live server; the caller still filters the answer itself, so a server
  // that ignores them is only slower, never wrong. A malformed id THROWS:
  // dropping the filter would widen a per-user read to the whole server.
  accountId?: string;
}

export async function getPlexWatchHistory(
  serverUrl: string,
  token: string,
  opts: PlexWatchHistoryOptions = {},
): Promise<PlexWatchHistory> {
  if (opts.accountId !== undefined && !/^\d{1,20}$/.test(opts.accountId)) {
    throw new Error("Invalid Plex account id for the history read");
  }
  const out: PlexWatchHistory = { entries: [], records: 0, truncated: false, aborted: false };
  if (opts.signal?.aborted) {
    out.aborted = true;
    return out;
  }
  const reader = historyReader(out, opts);
  try {
    await plexFetchAllPages(historyUrl(serverUrl, opts), token, reader, opts.signal);
  } catch (err) {
    // An abort that lands mid-page rejects that page: return what was read,
    // never throw (guardrail 41). Any other failure still throws.
    if (!opts.signal?.aborted) throw err;
    out.aborted = true;
  }
  return out;
}

function historyUrl(serverUrl: string, opts: PlexWatchHistoryOptions): string {
  const filters =
    (opts.accountId !== undefined ? `&accountID=${opts.accountId}` : "") +
    (opts.stopBefore ? `&viewedAt%3E=${Math.max(0, Math.floor(opts.stopBefore.getTime() / 1000) - 1)}` : "");
  return plexUrl(serverUrl, `/status/sessions/history/all?sort=viewedAt:desc${filters}`);
}

// The page callback: applies the stop bound, both caps and the abort, and
// drops a record the previous page already returned (see recordIdentity).
function historyReader(out: PlexWatchHistory, opts: PlexWatchHistoryOptions) {
  const maxItems = opts.maxItems ?? PLEX_WATCH_HISTORY_MAX_ITEMS;
  const maxRaw = opts.maxRaw ?? PLEX_WATCH_HISTORY_MAX_RAW;
  let seen = 0;
  let previousPage = new Set<string>();
  return (batch: unknown[]) => {
    const thisPage = new Set<string>();
    let reachedStop = false;
    for (const raw of batch) {
      if (opts.stopBefore && plexHistoryViewedBefore(raw, opts.stopBefore)) {
        reachedStop = true;
        break;
      }
      const id = recordIdentity(raw);
      if (id !== null) {
        if (previousPage.has(id)) continue;
        thisPage.add(id);
      }
      const counts = countsAsPlexWatchRecord(raw);
      // Truncated only when a record PAST a cap exists — a history of exactly
      // maxItems records is complete.
      if (seen >= maxRaw || (counts && out.records >= maxItems)) {
        out.truncated = true;
        break;
      }
      seen++;
      if (counts) out.records++;
      const entry = parsePlexHistoryItem(raw);
      if (entry) out.entries.push(entry);
    }
    previousPage = thisPage;
    if (out.truncated || reachedStop) return STOP_PAGING;
    // Stop paging on abort (guardrail 41 — the caller discards the result).
    // The signal also reaches the page in flight and its retry sleeps.
    if (opts.signal?.aborted) {
      out.aborted = true;
      return STOP_PAGING;
    }
  };
}

// The history is paged by OFFSET over a newest-first list that grows while it
// is read: a view recorded mid-walk shifts every older record one offset down,
// so the next page starts with the record(s) the previous page ended on, and
// each would count as one more play. A record seen on the previous page is
// skipped by its identity: Plex's own `historyKey` when present, else its
// item, account and second. An undated record without a historyKey has no
// identity and is never skipped. (A record DELETED mid-walk shifts the list the
// other way and one record is missed; offset paging can't see that.)
function recordIdentity(raw: unknown): string | null {
  const o = asRecord(raw);
  if (!o) return null;
  if (typeof o.historyKey === "string" && o.historyKey !== "") return `h:${o.historyKey}`;
  const item = typeof o.ratingKey === "string" || typeof o.ratingKey === "number" ? String(o.ratingKey) : typeof o.key === "string" ? o.key : null;
  const viewedAt = typeof o.viewedAt === "number" || typeof o.viewedAt === "string" ? String(o.viewedAt) : null;
  if (item === null || viewedAt === null) return null;
  const account = typeof o.accountID === "number" || typeof o.accountID === "string" ? String(o.accountID) : "";
  return `r:${item}|${account}|${viewedAt}`;
}

// A history record's viewedAt (epoch SECONDS) is strictly before `bound`. An
// undated or unreadable record is never "before" — it can't end the walk.
function plexHistoryViewedBefore(raw: unknown, bound: Date): boolean {
  const v = asRecord(raw)?.viewedAt;
  const n = typeof v === "number" ? v : typeof v === "string" && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 && n * 1000 < bound.getTime();
}
