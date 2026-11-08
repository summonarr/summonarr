// The Activity views' pure helpers: formatters, labels, colour maps and data
// folds. No "use client" and no React, so a SERVER component calls them as the
// functions they are: a server page that imports a function from a "use client"
// module gets a client reference, and calling one throws ("Attempted to call
// methodLabel() from the server"). The play detail page formats its bitrate and
// method through this module. activity-ui.tsx re-exports all of it, so the
// client views keep importing from there.

import type { ActivitySource } from "@/lib/activity-days";
import {
  streamMixSegments,
  type StreamMix,
  type StreamSegmentKey,
} from "@/lib/activity-stream-mix";
import { bitrateToKbps } from "@/lib/bitrate";
import { formatDurationHM } from "@/lib/format-duration";
import { UNKNOWN_REASON } from "@/lib/transcode-reasons";
import type { Translator } from "@/lib/i18n/translate";
import { SLOT } from "@/lib/i18n/slot";

// Mon-first weekday catalog keys, shared by the heatmaps. Translated at render.
export const WEEKDAY_KEYS = [
  "adminActivity.weekday.mon",
  "adminActivity.weekday.tue",
  "adminActivity.weekday.wed",
  "adminActivity.weekday.thu",
  "adminActivity.weekday.fri",
  "adminActivity.weekday.sat",
  "adminActivity.weekday.sun",
] as const;

/* ── Source ───────────────────────────────────────────────────── */

export interface SourceMeta {
  /** The server's brand name: never translated. */
  label: string;
  /** A fill colour (guardrail 42: brand colours stay fills). */
  color: string;
  /** The design-system chip tone. */
  tone: "plex" | "jellyfin" | "neutral";
}

// One label and colour per media server. Keyed by the union, so a new server
// type fails to compile here instead of being drawn as Jellyfin.
export const SOURCE_META: Record<ActivitySource, SourceMeta> = {
  plex: { label: "Plex", color: "var(--ds-plex)", tone: "plex" },
  jellyfin: { label: "Jellyfin", color: "var(--ds-jellyfin)", tone: "jellyfin" },
};

/**
 * The meta for a stored `source`. Rows carry it as a plain string; a value no
 * server type names is shown as itself in a neutral colour — never as Jellyfin,
 * which every unrecognised value used to read as.
 */
export function sourceMeta(source: string): SourceMeta {
  if (source === "plex" || source === "jellyfin") return SOURCE_META[source];
  return { label: source || "—", color: "var(--ds-fg-subtle)", tone: "neutral" };
}

export function sourceDotColor(source: string): string {
  return sourceMeta(source).color;
}

/* ── Stream method ────────────────────────────────────────────── */

export type MethodClass = "ok" | "info" | "warn" | "err" | "muted";

export function methodLabel(
  t: Translator,
  playMethod: string | null,
  videoDecision?: string | null,
  audioDecision?: string | null,
): { label: string; cls: MethodClass } {
  if (playMethod === "DirectPlay") return { label: t("adminActivity.method.directPlay"), cls: "ok" };
  if (playMethod === "DirectStream") return { label: t("adminActivity.method.remux"), cls: "info" };
  if (playMethod === "Transcode") {
    const v = videoDecision === "transcode";
    const a = audioDecision === "transcode";
    if (v && a) return { label: t("adminActivity.method.transcodeAV"), cls: "warn" };
    if (v) return { label: t("adminActivity.method.transcodeVideo"), cls: "warn" };
    if (a) return { label: t("adminActivity.method.transcodeAudio"), cls: "warn" };
    return { label: t("adminActivity.method.transcode"), cls: "warn" };
  }
  if (playMethod) return { label: playMethod, cls: "muted" };
  return { label: "—", cls: "muted" };
}

// The stream-type bars' label (a catalog key, translated at render) and colour
// per segment, shared by the Stats tab and the title and user detail views.
// Keyed by the segment union, so a missing entry fails to compile instead of
// throwing at render. Status tokens, never literals (guardrail 42).
export const STREAM_META: Record<StreamSegmentKey, { labelKey: string; color: string }> = {
  DirectPlay: { labelKey: "adminActivity.method.directPlay", color: "var(--ds-success)" },
  DirectStream: { labelKey: "adminActivity.method.remux", color: "var(--ds-info)" },
  Transcode: { labelKey: "adminActivity.method.transcode", color: "var(--ds-warning)" },
  Other: { labelKey: "adminActivity.method.other", color: "var(--ds-fg-disabled)" },
};

// StreamTypeBars data for a folded method mix: the named methods in order, then
// one "Other" segment for anything else the server recorded (streamMixSegments),
// so the bars and every share divide by one total.
export function streamTypeSegments(
  t: Translator,
  mix: StreamMix,
): { label: string; count: number; color: string }[] {
  return streamMixSegments(mix).map((s) => ({
    label: t(STREAM_META[s.key].labelKey),
    count: s.count,
    color: STREAM_META[s.key].color,
  }));
}

/* ── Buckets ──────────────────────────────────────────────────── */

// The aggregate SQL's catch-all buckets are English literals; translate them
// at render. Everything else in these charts is a codec, a client or a
// resolution name, shown as the server reported it.
export function bucketLabel(label: string, t: Translator): string {
  if (label === UNKNOWN_REASON || label === "unknown") return t("adminActivity.stats.unknown");
  if (label === "Other") return t("adminActivity.stats.other");
  return label;
}

// Postgres day-of-week is 0=Sun..6=Sat; the heatmap rows start on Monday, so
// (dow + 6) % 7 shifts Sunday to the last row. A cell outside the 7×24 grid is
// dropped. HourHeatmap reads its row back with the inverse, (row + 1) % 7.
export function toHeatmapMatrix(cells: readonly { dow: number; hour: number; count: number }[]): number[][] {
  const matrix: number[][] = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  for (const c of cells) {
    if (Number.isInteger(c.dow) && Number.isInteger(c.hour) && c.dow >= 0 && c.dow < 7 && c.hour >= 0 && c.hour < 24) {
      matrix[(c.dow + 6) % 7][c.hour] = c.count;
    }
  }
  return matrix;
}

// The 7×24 grid HourHeatmap draws, whatever it was handed: a short row or a
// missing one reads as zeros, extra rows and columns are dropped, and a count
// that isn't a finite number counts as none.
export function normalizeHeatmapMatrix(matrix: readonly (readonly number[] | undefined)[]): number[][] {
  return Array.from({ length: 7 }, (_, r) =>
    Array.from({ length: 24 }, (_, c) => {
      const v = matrix[r]?.[c];
      return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
    }),
  );
}

/* ── Posters ──────────────────────────────────────────────────── */

// next.config.ts lets next/image load only TMDB's image path; any other URL is
// a 400 from /_next/image (and a throw in dev), so it gets the letter tile.
const TMDB_IMAGE_PREFIX = "https://image.tmdb.org/t/p/";

export function isLoadablePoster(src: string | null | undefined): src is string {
  return typeof src === "string" && src.startsWith(TMDB_IMAGE_PREFIX) && src.length > TMDB_IMAGE_PREFIX.length;
}

/* ── Formatting ───────────────────────────────────────────────── */

export function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0)
    return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

// Seconds → "2h 15m" / "15m" / "45s", em-dash for non-positive. Delegates to
// the shared Intl-backed formatter (lib/format-duration.ts) so a non-English UI
// gets localized unit abbreviations. Without a `locale` it renders English —
// byte-identical to the old hand-rolled output — for the one-arg callers.
export function fmtDuration(seconds: number, locale = "en"): string {
  return formatDurationHM(seconds, locale);
}

// `source` is required, not optional: Plex reports kbps and Jellyfin bps, and
// the row is the only thing that can tell them apart (see lib/bitrate.ts). An
// optional param would silently default Jellyfin rows to the Plex reading and
// render them 1000x too high.
// `locale` localizes the decimal separator ("12,3 Mbps" for de/fr/pt/it); the
// unit stays "Mbps"/"kbps". Omitted, the legacy English output is unchanged.
export function fmtBitrate(raw: number | null, source: string | null, locale?: string): string {
  const kbps = bitrateToKbps(raw, source);
  if (kbps <= 0) return "—";
  if (kbps >= 1000) {
    const mbps = kbps / 1000;
    const text = locale
      ? new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(mbps)
      : mbps.toFixed(1);
    return `${text} Mbps`;
  }
  const whole = Math.round(kbps);
  return `${locale ? whole.toLocaleString(locale) : whole} kbps`;
}

// Renders a timestamp in the UI language, in `timeZone` when given (the
// statistics zone the server sends with the data, guardrail 19g) and else the
// viewer's own. The caller must pass `mounted` (from useHasMounted) —
// pre-hydration we return "" so SSR and the first client paint agree
// (guardrail 16).
export function fmtTimestamp(iso: string | null, mounted: boolean, locale: string, timeZone?: string): string {
  if (!mounted) return "";
  if (!iso) return "—";
  return new Date(iso).toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  });
}

// "May 13" for an instant or a "YYYY-MM-DD" day key, pinned to UTC so the
// server (its own zone) and the browser (the viewer's) print the same date —
// otherwise a play near midnight shows different days and React reports a
// hydration mismatch (guardrail 16). A day key is already the statistics
// zone's date, so UTC prints it unchanged. Build ONE per locale and reuse it:
// toLocaleDateString makes a fresh Intl formatter on every call.
export function utcShortDayFormatter(locale: string): (isoOrDay: string) => string {
  const fmt = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: "UTC" });
  return (isoOrDay) => fmt.format(new Date(/^\d{4}-\d{2}-\d{2}$/.test(isoOrDay) ? `${isoOrDay}T00:00:00Z` : isoOrDay));
}

/**
 * A translated sentence split around one placeholder, so the caller can style
 * what goes in it: `t(key, { …vars, [slot]: SLOT_MARK })` split on the mark.
 * Null when the sentence doesn't hold the slot exactly once (a translation that
 * dropped it): the caller then shows the sentence and the value side by side
 * instead of losing the value. Stricter than the shared splitAtSlot
 * (i18n/slot.ts) on purpose: the value here is data, not decoration, so a
 * mangled sentence must never hide it.
 */
export const SLOT_MARK = SLOT;

export function splitAtSlot(sentence: string): { before: string; after: string } | null {
  const parts = sentence.split(SLOT_MARK);
  return parts.length === 2 ? { before: parts[0], after: parts[1] } : null;
}
