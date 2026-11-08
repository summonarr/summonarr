// What the admin Radarr/Sonarr pages expect back from their routes, checked
// before anything drives a render or a decision (arr-call.ts, validate.ts). A
// live answer and a painted snapshot (use-arr-snapshot.ts) go through the same
// check: a snapshot kept by an older build, or a 2xx that isn't the route's
// answer, is refused instead of crashing a `.map` or a `.length`.
//
// Lists are checked as lists and each row on the fields the page keys,
// compares, counts or iterates on (routeShape); the rest of a row is the
// route's own typed projection (src/lib/arr-*.ts), passed on whole.
//
// A write's answer is checked only for what makes it a success: a bad extra
// field (a command id) must never turn a change the arr made into "failed".
// Pure and zero-runtime-import beyond validate.ts and arr-call.ts, so the unit
// suite loads it (tests/arr-call.test.mts).
import { v, type Infer, type Schema } from "../validate";
import { routeShape } from "./arr-call";
import type { ArrTitle, RenamePreview, TitleEpisode, TitleFile } from "../arr-title";
import type { ArrHistoryEvent, ArrPage, BlocklistEntry } from "../arr-history";
import type { ArrCommandRow, ArrDisk, ArrDownloadClient, ArrIndexer, ArrRootFolder, ArrTag, ArrTask } from "../arr-system";
import type { ArrHealthCheck, WebhookState } from "../arr-health";
import type { ArrErrorKind } from "../arr-error-kind";

const isInt = (x: unknown): x is number => Number.isSafeInteger(x);
const isText = (x: unknown): x is string => typeof x === "string";
const isNumber = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const lists = (o: Record<string, unknown>, ...keys: string[]) => keys.every((k) => Array.isArray(o[k]));

/** The positive integer ids in an answer's id list (a command's ids); a malformed list is none. */
export function idsOf(raw: unknown): number[] {
  return Array.isArray(raw) ? raw.filter((x): x is number => isInt(x) && x > 0) : [];
}

// ── the title manager ────────────────────────────────────────────────────────

export const CHOICE = v.object({ id: v.int(), name: v.string() });
export const ROOT_FOLDER_CHOICE = v.object({ path: v.string(), freeSpace: v.nullable(v.number()), accessible: v.boolean() });

export const ARR_TITLE = routeShape<ArrTitle>(
  "a title",
  (t) => isInt(t.arrId) && isText(t.title) && lists(t, "tags", "seasons") && isNumber(t.sizeOnDisk),
);

/** GET /api/admin/arr/title — the title and the instance's choice lists (null: the instance didn't answer that list). */
export const TITLE_STATE = v.object({
  title: ARR_TITLE,
  qualityProfiles: v.nullable(v.array(CHOICE)),
  rootFolders: v.nullable(v.array(ROOT_FOLDER_CHOICE)),
  tags: v.nullable(v.array(CHOICE)),
});
export type TitleState = Infer<typeof TITLE_STATE>;

/** A write's answer that carries the title as the arr now has it — null when the write landed but its re-read failed. */
export const TITLE_WRITE = v.object({ title: v.nullable(ARR_TITLE) });

/** POST …/title/command — queued; its command ids (to follow) and Sonarr's part-way flag are read leniently. */
export const COMMAND_ANSWER = v.object({ commandIds: v.optional(v.unknown()), partial: v.optional(v.unknown()) });

export const EPISODE = routeShape<TitleEpisode>(
  "an episode",
  (e) => isInt(e.id) && isInt(e.seasonNumber) && isInt(e.episodeNumber) && typeof e.monitored === "boolean",
);
/** GET …/title/episodes — one season's episodes and the server's time they were read at (air-date verdicts). */
export const EPISODES_ANSWER = v.object({ episodes: v.array(EPISODE), now: v.string() });

export const TITLE_FILE = routeShape<TitleFile>(
  "a file",
  (f) => isInt(f.id) && isText(f.relativePath) && isNumber(f.size) && lists(f, "qualityTags", "languages", "customFormats", "episodes"),
);
export const FILES_ANSWER = v.object({ files: v.array(TITLE_FILE) });

export const RENAME_PREVIEW = routeShape<RenamePreview>("a rename", (r) => isInt(r.fileId) && isText(r.existingPath) && isText(r.newPath));
export const RENAME_PREVIEW_ANSWER = v.object({ files: v.array(RENAME_PREVIEW) });
/** POST …/title/rename — how many files it sent, and the RenameFiles command to follow. */
export const RENAME_ANSWER = v.object({ files: v.int(), commandIds: v.optional(v.unknown()) });

/** DELETE …/title/files — a background job (202 { job }), or a synchronous count. */
export const DELETE_START = v.object({ job: v.optional(v.string()), deleted: v.optional(v.int()) });

export const HISTORY_EVENT = routeShape<ArrHistoryEvent>(
  "a history record",
  (e) => isInt(e.id) && isText(e.kind) && isText(e.instance) && isText(e.service) && lists(e, "qualityTags", "languages", "customFormats"),
);
export const EVENTS_ANSWER = v.object({ events: v.array(HISTORY_EVENT) });

/** POST …/title/remove (dry run) — the title as it is, and the requests that name it. */
export const REMOVE_PLAN = v.object({
  title: ARR_TITLE,
  requests: v.object({ pending: v.int(), approved: v.int(), available: v.int() }),
});
export type RemovePlan = Infer<typeof REMOVE_PLAN>;

export const ADD_CHOICES = v.object({
  presentArrId: v.nullable(v.int()),
  preview: v.nullable(v.object({ tmdbId: v.int(), title: v.string(), year: v.nullable(v.int()) })),
  qualityProfiles: v.array(CHOICE),
  rootFolders: v.array(ROOT_FOLDER_CHOICE),
  tags: v.array(CHOICE),
  defaults: v.object({
    qualityProfileId: v.nullable(v.int()),
    rootFolderPath: v.nullable(v.string()),
    minimumAvailability: v.nullable(v.string()),
  }),
});
export type AddChoices = Infer<typeof ADD_CHOICES>;
/** POST …/title/add — the new arr id, null when the arr took the add but named none. */
export const ADD_ANSWER = v.object({ arrId: v.optional(v.nullable(v.unknown())) });

// ── Download History ─────────────────────────────────────────────────────────

const pageOf = <T extends object>(row: Schema<T>): Schema<ArrPage<T>> =>
  v.object({ page: v.int(), pageSize: v.int(), totalRecords: v.int(), records: v.array(row) });

export const BLOCKLIST_ENTRY = routeShape<BlocklistEntry>(
  "a blocklist entry",
  (r) => isInt(r.id) && isText(r.service) && isText(r.instance) && isText(r.sourceTitle) && lists(r, "languages"),
);
export const HISTORY_PAGE = pageOf(HISTORY_EVENT);
export const BLOCKLIST_PAGE = pageOf(BLOCKLIST_ENTRY);

/** DELETE /api/admin/arr/blocklist — how many it removed. */
export const BLOCKLIST_REMOVED = v.object({ removed: v.optional(v.unknown()) });
/** POST …/blocklist/clear — the ClearBlocklist command to follow. */
export const BLOCKLIST_CLEARED = v.object({ commandIds: v.optional(v.unknown()) });

// ── the health panel ─────────────────────────────────────────────────────────

export interface InstanceHealth {
  service: "radarr" | "sonarr";
  slug: string;
  name: string;
  reachable: boolean;
  error: string | null;
  /** Why it failed, for the translated line; the raw `error` is the fallback. */
  errorKind?: ArrErrorKind | null;
  version: string | null;
  checks: ArrHealthCheck[];
  webhook: { state: WebhookState | "unknown"; missingEvents: string[] };
}

const isWebhook = (w: unknown): boolean =>
  typeof w === "object" && w !== null && isText((w as { state?: unknown }).state) && Array.isArray((w as { missingEvents?: unknown }).missingEvents);

export const INSTANCE_HEALTH = routeShape<InstanceHealth>(
  "an instance's health",
  (i) => (i.service === "radarr" || i.service === "sonarr") && isText(i.slug) && lists(i, "checks") && isWebhook(i.webhook),
);
/** GET /api/admin/arr-health. */
export const HEALTH_REPORT = v.object({ instances: v.array(INSTANCE_HEALTH), webhookBase: v.nullable(v.string()) });
export type HealthReport = Infer<typeof HEALTH_REPORT>;

/** POST /api/admin/arr-health/webhook — what setup did. */
export const WEBHOOK_SETUP = v.object({ outcome: v.literal("created", "updated", "unchanged") });

// ── Arr System ───────────────────────────────────────────────────────────────

export type ArrServiceName = "radarr" | "sonarr";
export interface InstanceRef { service: ArrServiceName; slug: string; name: string }
export interface Report<T> {
  instances: InstanceRef[];
  errors: Array<{ service: ArrServiceName; instance: string; error: string; kind?: ArrErrorKind }>;
  results: Array<{ service: ArrServiceName; instance: string } & T>;
}

const SERVICE = v.literal("radarr", "sonarr");
const INSTANCE_REF = v.object({ service: SERVICE, slug: v.string(), name: v.string() });
const INSTANCE_ERROR = v.object({ service: SERVICE, instance: v.string(), error: v.string(), kind: v.optional(v.unknown()) });

/** A system report whose every result carries the lists `keys` names. */
function reportOf<T extends object>(expected: string, keys: readonly string[]): Schema<Report<T>> {
  const result = routeShape<{ service: ArrServiceName; instance: string } & T>(
    expected,
    (r) => (r.service === "radarr" || r.service === "sonarr") && isText(r.instance) && lists(r, ...keys),
  );
  const schema = v.object({ instances: v.array(INSTANCE_REF), errors: v.array(INSTANCE_ERROR), results: v.array(result) });
  // `kind` is read through isArrErrorKind wherever it is shown, so unknown is its honest type here.
  return schema as Schema<Report<T>>;
}

export type TasksResult = { tasks: ArrTask[]; commands: ArrCommandRow[] };
export type ProvidersResult = { indexers: ArrIndexer[]; downloadClients: ArrDownloadClient[]; tags?: ArrTag[] };
export type StorageResult = { rootFolders: ArrRootFolder[]; disks: ArrDisk[] };

export const TASKS_REPORT = reportOf<TasksResult>("an instance's tasks", ["tasks", "commands"]);
export const PROVIDERS_REPORT = reportOf<ProvidersResult>("an instance's indexers and clients", ["indexers", "downloadClients"]);
export const STORAGE_REPORT = reportOf<StorageResult>("an instance's storage", ["rootFolders", "disks"]);

/** POST /api/admin/arr/tasks — the command it queued, when the arr named one. */
export const TASK_RUN = v.object({ id: v.optional(v.unknown()) });

export const INDEXER = routeShape<ArrIndexer>("an indexer", (p) => isInt(p.id) && isText(p.name) && typeof p.enableRss === "boolean" && lists(p, "tags"));
export const DOWNLOAD_CLIENT = routeShape<ArrDownloadClient>("a download client", (p) => isInt(p.id) && isText(p.name) && typeof p.enable === "boolean" && lists(p, "tags"));
/**
 * PATCH /api/admin/arr/providers — the provider as the arr now has it, by the
 * kind the page sent (an indexer's answer is never read as a client's). A
 * timed-out save's refusal carries one too.
 */
export const PROVIDER_SAVED = {
  indexer: v.object({ provider: INDEXER }),
  downloadClient: v.object({ provider: DOWNLOAD_CLIENT }),
} as const;

const TEST_RESULT = v.object({
  id: v.int(),
  ok: v.boolean(),
  warning: v.boolean(),
  messages: v.array(v.string()),
  uncertain: v.optional(v.literal(true)),
});
/** POST /api/admin/arr/providers/test. */
export const PROVIDER_TESTS = v.object({ results: v.array(TEST_RESULT) });
