// The request queue's "Why?" panel (request-arr-status.tsx): the shape it reads
// from GET /api/requests/{id}/arr-status, and the words it shows for a verdict.
// Pure and directive-free (no React), so the unit suite loads it.
//
// The route's answer is coarse for MANAGE_REQUESTS delegates (guardrail 5g):
// phase, progress, time left, quality, counts and dates. Nothing here adds a
// field; the schema only names what the panel reads (v.object drops the rest),
// and a body the panel can't read is a failed check, not a crash on an unknown
// verdict or phase.
import type { QueuePhase } from "@/lib/arr-queue";
import { ARR_ERROR_KIND_KEYS, isArrErrorKind } from "@/lib/arr-error-kind";
import { ARR_STATUS_VERDICTS, unmonitoredEpisodesOnly, type ArrStatusVerdict } from "@/lib/request-arr-status";
import type { Translator } from "@/lib/i18n/translate";
import { v, type Infer } from "@/lib/validate";
import type { queueFormatters } from "./queue-format";

// Literal maps, never keys built from a value: the i18n dead-key check can't
// see a built key.
export const VERDICT_KEYS = {
  unreachable: "adminQueue.arrStatus.verdict.unreachable",
  notInArr: "adminQueue.arrStatus.verdict.notInArr",
  ready: "adminQueue.arrStatus.verdict.ready",
  inArrNotInLibrary: "adminQueue.arrStatus.verdict.inArrNotInLibrary",
  waitingForLibrary: "adminQueue.arrStatus.verdict.waitingForLibrary",
  importBlocked: "adminQueue.arrStatus.verdict.importBlocked",
  downloading: "adminQueue.arrStatus.verdict.downloading",
  unmonitored: "adminQueue.arrStatus.verdict.unmonitored",
  notReleased: "adminQueue.arrStatus.verdict.notReleased",
  downloadFailed: "adminQueue.arrStatus.verdict.downloadFailed",
  incomplete: "adminQueue.arrStatus.verdict.incomplete",
  waiting: "adminQueue.arrStatus.verdict.waiting",
} as const satisfies Record<ArrStatusVerdict, string>;

export const PHASE_KEYS = {
  downloading: "adminManage.queue.phase.downloading",
  queued: "adminManage.queue.phase.queued",
  paused: "adminManage.queue.phase.paused",
  delay: "adminManage.queue.phase.delay",
  importPending: "adminManage.queue.phase.importPending",
  importing: "adminManage.queue.phase.importing",
  importBlocked: "adminManage.queue.phase.importBlocked",
  failed: "adminManage.queue.phase.failed",
  clientUnavailable: "adminManage.queue.phase.clientUnavailable",
  unknown: "adminManage.queue.phase.unknown",
} as const satisfies Record<QueuePhase, string>;

// The keys of PHASE_KEYS are exactly QueuePhase (the `satisfies` above).
const QUEUE_PHASES = Object.keys(PHASE_KEYS) as QueuePhase[];

const DOWNLOAD = v.object({
  phase: v.literal(...QUEUE_PHASES),
  pending: v.boolean(),
  progress: v.number(),
  timeLeftSeconds: v.nullable(v.number()),
  estimatedCompletion: v.nullable(v.string()),
  attention: v.boolean(),
  messages: v.array(v.string()),
  quality: v.nullable(v.string()),
  episodes: v.number(),
});
export type StatusDownload = Infer<typeof DOWNLOAD>;

// `arrId` never reaches the browser (the route strips it); an admin gets
// `queue` instead — the title's own queue filter.
export const ARR_STATUS_ANSWER = v.object({
  verdict: v.literal(...ARR_STATUS_VERDICTS),
  service: v.literal("radarr", "sonarr"),
  errorKind: v.nullable(v.string()),
  monitored: v.nullable(v.boolean()),
  releasedAt: v.nullable(v.string()),
  expectedAt: v.nullable(v.string()),
  episodes: v.nullable(v.object({ withFile: v.number(), total: v.number() })),
  inLibrary: v.boolean(),
  downloads: v.array(DOWNLOAD),
  downloadCount: v.number(),
  failures: v.object({ count: v.number(), lastAt: v.nullable(v.string()), message: v.nullable(v.string()) }),
  canOpenQueue: v.optional(v.boolean()),
  queue: v.optional(v.nullable(v.object({ service: v.literal("radarr", "sonarr"), instance: v.string(), arrId: v.int() }))),
});
export type LoadedArrStatus = Infer<typeof ARR_STATUS_ANSWER>;

export interface VerdictTextContext {
  t: Translator;
  /** The instance's own name ("Radarr", "Radarr (4K)"): the route judged that instance. */
  service: string;
  fmt: ReturnType<typeof queueFormatters>;
  /** A calendar date (midnight UTC) as a day, or null when it doesn't parse. */
  calendarDay: (iso: string | null) => string | null;
}

/** The one line under the verdict chip. */
export function verdictExplanation(s: LoadedArrStatus, { t, service, fmt, calendarDay }: VerdictTextContext): string {
  switch (s.verdict) {
    case "unreachable":
      return t(ARR_ERROR_KIND_KEYS[isArrErrorKind(s.errorKind) ? s.errorKind : "other"], { name: service });
    case "notInArr": return t("adminQueue.arrStatus.why.notInArr", { service });
    case "ready": return t("adminQueue.arrStatus.why.ready");
    case "inArrNotInLibrary": return t("adminQueue.arrStatus.why.inArrNotInLibrary", { service });
    case "waitingForLibrary": return t("adminQueue.arrStatus.why.waitingForLibrary", { service });
    case "importBlocked": return t("adminQueue.arrStatus.why.importBlocked", { service });
    case "downloading":
      return s.downloads.length > 0 && s.downloads.every((d) => d.pending)
        ? t("adminQueue.arrStatus.why.held", { service })
        : t("adminQueue.arrStatus.why.downloading", { service });
    case "unmonitored":
      return unmonitoredEpisodesOnly(s)
        ? t("adminQueue.arrStatus.why.unmonitoredEpisodes", { service })
        : t("adminQueue.arrStatus.why.unmonitored", { service });
    case "notReleased": {
      if (s.service === "radarr") {
        const date = calendarDay(s.expectedAt);
        return date ? t("adminQueue.arrStatus.why.notReleasedMovieOn", { date }) : t("adminQueue.arrStatus.why.notReleasedMovie");
      }
      return s.expectedAt
        ? t("adminQueue.arrStatus.why.notReleasedSeriesOn", { date: fmt.dateTime(s.expectedAt) })
        : t("adminQueue.arrStatus.why.notReleasedSeries");
    }
    case "downloadFailed": return t("adminQueue.arrStatus.why.downloadFailed", { service });
    case "incomplete":
      return t("adminQueue.arrStatus.why.incomplete", { withFile: s.episodes?.withFile ?? 0, total: s.episodes?.total ?? 0, service });
    case "waiting": return t("adminQueue.arrStatus.why.waiting", { service });
  }
}

/** The detail lines under the downloads, each one distinct. */
export function verdictDetails(s: LoadedArrStatus, { t, fmt, calendarDay }: VerdictTextContext): string[] {
  const out: string[] = [];
  if (s.episodes && s.verdict !== "incomplete" && s.verdict !== "notReleased" && s.episodes.total > 0) {
    out.push(t("adminQueue.arrStatus.episodesOnDisk", { withFile: s.episodes.withFile, total: s.episodes.total }));
  }
  // The release date only explains a title nothing is downloading.
  if (s.service === "radarr" && s.releasedAt && (s.verdict === "waiting" || s.verdict === "downloadFailed" || s.verdict === "unmonitored")) {
    const date = calendarDay(s.releasedAt);
    if (date) out.push(t("adminQueue.arrStatus.releasedOn", { date }));
  }
  if (s.service === "sonarr" && s.expectedAt && s.verdict !== "notReleased") {
    out.push(t("adminQueue.arrStatus.nextAiring", { date: fmt.dateTime(s.expectedAt) }));
  }
  if (s.failures.count > 0) {
    out.push(t("adminQueue.arrStatus.failureCount", { count: s.failures.count }));
    if (s.failures.lastAt) out.push(t("adminQueue.arrStatus.lastFailure", { date: fmt.dateTime(s.failures.lastAt) }));
  }
  if (s.inLibrary && s.verdict !== "ready") out.push(t("adminQueue.arrStatus.onMediaServer"));
  if (s.downloadCount > s.downloads.length) out.push(t("adminQueue.arrStatus.moreDownloads", { count: s.downloadCount - s.downloads.length }));
  return out;
}

/** One download's meta line: phase, progress, time left or ETA, quality, episodes. */
export function downloadMeta(d: StatusDownload, { t, fmt }: Pick<VerdictTextContext, "t" | "fmt">): string[] {
  // Time left only while there is something left to fetch.
  const fetching = d.progress < 1 && !d.pending;
  return [
    t(PHASE_KEYS[d.phase]),
    fmt.percent(d.progress),
    fetching && d.timeLeftSeconds !== null ? t("adminQueue.arrStatus.timeLeft", { time: fmt.duration(d.timeLeftSeconds) }) : null,
    fetching && d.timeLeftSeconds === null && d.estimatedCompletion ? t("adminQueue.arrStatus.eta", { date: fmt.dateTime(d.estimatedCompletion) }) : null,
    d.quality,
    d.episodes > 0 ? t("adminQueue.arrStatus.episodesInDownload", { count: d.episodes }) : null,
  ].filter((x): x is string => typeof x === "string" && x !== "");
}
