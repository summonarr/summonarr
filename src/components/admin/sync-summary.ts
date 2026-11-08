// What the admin "Sync now" and "Sync Discord Roles" buttons say about a run
// (request-sync-buttons.tsx). Pure, no "use client", so the unit suite reads
// it (tests/request-action-rules.test.mts).
import { v, type Infer } from "@/lib/validate";
import type { Translator } from "@/lib/i18n/translate";

/** POST /api/sync's answer, as far as the button reads it. Every field is optional: a skip carries none of the counts. */
export const SyncRunAnswer = v.object({
  skipped: v.optional(v.boolean()),
  windDown: v.optional(v.boolean()),
  error: v.optional(v.string()),
  plexMarked: v.optional(v.number()),
  jellyfinMarked: v.optional(v.number()),
  failedSources: v.optional(v.array(v.string())),
  skippedSources: v.optional(v.array(v.string())),
});
export type SyncRunAnswer = Infer<typeof SyncRunAnswer>;

/** POST /api/discord/sync-roles' answer. */
export const RoleSyncAnswer = v.object({
  synced: v.optional(v.number()),
  error: v.optional(v.string()),
});

export interface SyncNote {
  text: string;
  isError: boolean;
}

// The media servers, then the arrs, by display name — never the wire slug
// ("Plex 3 · radarr failed" read as a typo).
const SERVERS = [["Plex", "plex"], ["Jellyfin", "jellyfin"]] as const;
const ARRS = [["Radarr", "radarr"], ["Sonarr", "sonarr"]] as const;

/**
 * The line for a 200 from /api/sync.
 *
 * - `{ skipped: true }` (no counts) means another sync — the hourly cron or a
 *   Plex-triggered run — already holds the lock.
 * - A run that stopped at a phase boundary (`windDown`) says so, in red.
 * - Otherwise one part per server, never summed: a title on both servers is
 *   counted once by each (guardrail 36). A server the run skipped (not
 *   configured) is left out; one that failed says so. A degraded run answers
 *   200 WITH `error` set, and the parts say which source failed.
 */
export function syncRunNote(data: SyncRunAnswer, t: Translator): SyncNote {
  if (data.skipped) return { text: t("adminQueue.sync.alreadyRunning"), isError: false };
  if (data.windDown) return { text: data.error ?? t("adminQueue.sync.failed"), isError: true };
  const failed = new Set(data.failedSources ?? []);
  const skipped = new Set(data.skippedSources ?? []);
  const marked = { plex: data.plexMarked, jellyfin: data.jellyfinMarked };
  const parts = SERVERS.filter(([, key]) => !skipped.has(key)).map(([name, key]) =>
    failed.has(key) ? t("adminQueue.sync.sourceFailed", { name }) : t("adminQueue.sync.sourceMarked", { name, marked: marked[key] ?? 0 }),
  );
  // An arr outage is worth saying even though its count is not per server.
  for (const [name, key] of ARRS) {
    if (failed.has(key)) parts.push(t("adminQueue.sync.sourceFailed", { name }));
  }
  return { text: parts.length > 0 ? parts.join(" · ") : t("adminQueue.sync.noServers"), isError: failed.size > 0 };
}
