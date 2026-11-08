// What the Watch Sync page reads (GET /api/admin/watch-sync and the Run now
// job's answer), checked and narrowed ONCE here, so the panel never casts:
// a proxy page or a changed shape is a load failure, not a render crash.
// Pure, so the unit suite reads it directly (tests/watch-sync-overview.test.mts).
import { check, v, type Infer } from "@/lib/validate";

export type Direction = "both" | "toJellyfin" | "toPlex";
export type SyncTarget = "toJellyfin" | "toPlex";
export const DIRECTIONS: readonly Direction[] = ["both", "toJellyfin", "toPlex"];

/** A stored direction, or null for a value this client doesn't know (the server syncs nothing for it). */
export function directionOf(raw: string): Direction | null {
  return (DIRECTIONS as readonly string[]).includes(raw) ? (raw as Direction) : null;
}

/** Does a pair with `direction` sync toward `target`? An unknown one syncs nothing (syncsToward, guardrail 19e). */
export function toward(direction: Direction | null, target: SyncTarget): boolean {
  return direction === "both" || direction === target;
}

const ServerUserSchema = v.object({ id: v.string(), username: v.string(), server: v.string(), active: v.boolean() });
const CountsSchema = v.object({ pending: v.number(), marked: v.number(), already: v.number(), missing: v.number(), failed: v.number() });

// One direction's last result. Stored JSON (WatchSyncDirectionResult), read
// leniently: every field may be missing on an older row.
const DIR_RESULT_FIELDS = {
  queued: v.optional(v.number()),
  unresolved: v.optional(v.number()),
  unmatched: v.optional(v.number()),
  marked: v.optional(v.number()),
  failed: v.optional(v.number()),
  error: v.optional(v.string()),
};
const DirResultSchema = v.object(DIR_RESULT_FIELDS);
const ProgressSchema = v.object({
  toJellyfin: v.optional(v.number()),
  toPlex: v.optional(v.number()),
  failed: v.optional(v.number()),
  error: v.optional(v.string()),
});
// Results written before Jellyfin → Plex existed are flat (the Plex → Jellyfin
// numbers); newer ones carry a key per direction.
const LastResultSchema = v.object({
  ...DIR_RESULT_FIELDS,
  toJellyfin: v.optional(v.nullable(DirResultSchema)),
  toPlex: v.optional(v.nullable(DirResultSchema)),
  progress: v.optional(v.nullable(ProgressSchema)),
});

export type ServerUser = Infer<typeof ServerUserSchema>;
export type Counts = Infer<typeof CountsSchema>;
export type DirResult = Infer<typeof DirResultSchema>;
export type LastResult = Infer<typeof LastResultSchema> | null;

const PairSchema = v.object({
  id: v.string(),
  enabled: v.boolean(),
  direction: v.string(),
  syncProgress: v.boolean(),
  plex: ServerUserSchema,
  jellyfin: ServerUserSchema,
  historyReadTo: v.nullable(v.string()),
  jellyfinReadTo: v.nullable(v.string()),
  lastRunAt: v.nullable(v.string()),
  // A stored blob: checked on its own (readLastResult), so one odd row can't
  // fail the whole page.
  lastResult: v.unknown(),
  counts: v.optional(v.object({ toJellyfin: CountsSchema, toPlex: CountsSchema })),
});

export const OverviewSchema = v.object({
  pairs: v.array(PairSchema),
  plexUsers: v.array(ServerUserSchema),
  jellyfinUsers: v.array(ServerUserSchema),
  suggestions: v.array(v.object({ plexUserId: v.string(), jellyfinUserId: v.string(), account: v.string() })),
  run: v.optional(v.object({ running: v.boolean(), startedAt: v.nullable(v.string()), pairId: v.nullable(v.string()) })),
});

export type Pair = Omit<Infer<typeof PairSchema>, "direction" | "lastResult"> & {
  direction: Direction | null;
  lastResult: LastResult;
};
export type Overview = Omit<Infer<typeof OverviewSchema>, "pairs"> & { pairs: Pair[] };

/** A stored last result, or null when there is none or it isn't one. */
export function readLastResult(raw: unknown): LastResult {
  const parsed = check(LastResultSchema, raw);
  return parsed.ok ? parsed.value : null;
}

/** The checked answer with each pair's direction and last result narrowed. */
export function toOverview(raw: Infer<typeof OverviewSchema>): Overview {
  return {
    ...raw,
    pairs: raw.pairs.map((p) => ({ ...p, direction: directionOf(p.direction), lastResult: readLastResult(p.lastResult) })),
  };
}

/** One direction's part of a last result (a flat, older result is Plex → Jellyfin). */
export function lastFor(last: LastResult, dir: SyncTarget): DirResult | null {
  if (!last) return null;
  if ("toJellyfin" in last || "toPlex" in last) return last[dir] ?? null;
  return dir === "toJellyfin" ? last : null;
}

/** Whether a last result names a problem with the pair itself (a per-direction result, not a flat one). */
export function pairLevelError(last: LastResult): string | null {
  if (!last || !("toJellyfin" in last || "toPlex" in last)) return null;
  return last.error ?? null;
}

// The Run now job's answer (WatchSyncRunResult): items marked, and pairs with
// a problem in either direction.
const RunAnswerSchema = v.object({
  pairs: v.optional(v.array(v.object({
    error: v.optional(v.string()),
    toJellyfin: v.optional(v.nullable(DirResultSchema)),
    toPlex: v.optional(v.nullable(DirResultSchema)),
  }))),
});

export function runSummary(data: unknown): { marked: number; problems: number } {
  const parsed = check(RunAnswerSchema, data);
  const pairs = parsed.ok ? parsed.value.pairs ?? [] : [];
  let marked = 0;
  let problems = 0;
  const bad = (d: DirResult | null | undefined) => !!d && (!!d.error || (d.failed ?? 0) > 0);
  for (const p of pairs) {
    marked += (p.toJellyfin?.marked ?? 0) + (p.toPlex?.marked ?? 0);
    if (p.error || bad(p.toJellyfin) || bad(p.toPlex)) problems++;
  }
  return { marked, problems };
}
