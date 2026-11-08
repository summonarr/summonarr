"use client";

// The issue Fix Match dialog's pieces (issue-fix-match-button.tsx holds its
// state and its requests), and the shapes it reads from its routes, checked
// before they render (src/lib/validate.ts) — a payload of another shape is the
// dialog's error state, never a crash inside a setState updater or the list.

import { Check } from "@/components/icons";
import { posterUrl } from "@/lib/tmdb-types";
import { withBasePath } from "@/lib/base-path";
import { mediaInstanceLabel } from "@/lib/media-instances";
import { useT } from "@/components/i18n/i18n-provider";
import type { CandidatesResponse } from "@/lib/fix-match-candidates";
import { rich } from "@/components/settings/forms/rich";
import { v, type Infer } from "@/lib/validate";
import type { CandidateMatch } from "@/lib/fix-match-scoring";

export type Side = "plex" | "jellyfin";

type ServerStatus = "idle" | "fetching" | "selecting" | "applying" | "done" | "error";

export interface ServerState {
  status: ServerStatus;
  error?: string;
  // A SUCCESSFUL remap can still warn (some copies failed to re-match, or an
  // identical job was already running) — shown beside "Fixed", never as an error.
  warning?: string;
}

// ── what the routes answer ───────────────────────────────────────────────────

// GET /api/admin/fix-match/file-info — every configured server holding the title.
const FileInfoInstanceSchema = v.object({ serverInstance: v.string(), filePath: v.nullable(v.string()) });
export const FileInfoSchema = v.object({
  plexFilePath: v.nullable(v.string()),
  jellyfinFilePath: v.nullable(v.string()),
  arrTmdbId: v.nullable(v.int()),
  arrTitle: v.nullable(v.string()),
  plexInstances: v.array(FileInfoInstanceSchema),
  jellyfinInstances: v.array(FileInfoInstanceSchema),
});
export type FileInfo = Infer<typeof FileInfoSchema>;
export type FileInfoRow = FileInfo["plexInstances"][number];

// GET /api/search — the fields a result row and the confirm step show. A field
// TMDB left out reads as empty rather than failing the whole list.
const SearchHitSchema = v.object({
  id: v.int(),
  title: v.string(),
  overview: v.optional(v.nullable(v.string())),
  posterPath: v.optional(v.nullable(v.string())),
  releaseYear: v.optional(v.nullable(v.string())),
});
export const SearchHitsSchema = v.array(SearchHitSchema);

/** A TMDB title the admin can pick as the correct match. */
export interface SearchHit {
  id: number;
  title: string;
  overview: string;
  posterPath: string | null;
  releaseYear: string | null;
}

export function searchHitsOf(hits: Infer<typeof SearchHitsSchema>): SearchHit[] {
  return hits.map((h) => ({
    id: h.id,
    title: h.title,
    overview: h.overview ?? "",
    posterPath: h.posterPath ?? null,
    releaseYear: h.releaseYear ?? null,
  }));
}

// GET /api/admin/fix-match/candidates (Plex) — the list and its cross-check,
// read and checked by the shared client (src/lib/client/fix-match-candidates.ts).
export type Candidates = CandidatesResponse;
export type CandidateView = Candidates["candidates"][number];

// ── the candidate list ──────────────────────────────────────────────────────

type LevelStyle = { border: string; bg: string; badge: string };

// Keyed by the scorer's own levels, so a new one is a compile error here
// rather than a silent "unknown" styling.
const LEVEL_STYLES = {
  exact:    { border: "border-l-2 border-green-500",       bg: "bg-green-500/5 hover:bg-green-500/10",     badge: "bg-green-500/20 text-green-400 border-green-500/40" },
  strong:   { border: "border-l-2 border-emerald-500/70",  bg: "bg-emerald-500/5 hover:bg-emerald-500/10", badge: "bg-emerald-500/20 text-emerald-400 border-emerald-500/40" },
  likely:   { border: "border-l-2 border-yellow-500/70",   bg: "bg-yellow-500/5 hover:bg-yellow-500/10",   badge: "bg-yellow-500/20 text-yellow-400 border-yellow-500/40" },
  possible: { border: "border-l-2 border-zinc-500/50",     bg: "hover:bg-zinc-800",                        badge: "bg-zinc-700 text-zinc-400 border-zinc-600" },
  wrong:    { border: "border-l-2 border-red-500/70",      bg: "bg-red-500/5 hover:bg-red-500/10",         badge: "bg-red-500/20 text-red-400 border-red-500/40" },
  unknown:  { border: "border-l-2 border-transparent",     bg: "hover:bg-zinc-800",                        badge: "bg-zinc-800 text-zinc-500 border-zinc-700" },
} satisfies Record<CandidateMatch, LevelStyle>;

// Literal keys — the i18n dead-string check can't see a built key.
const LEVEL_KEYS: Record<CandidateMatch, string> = {
  exact: "adminQueue.fixMatch.level.exact",
  strong: "adminQueue.fixMatch.level.strong",
  likely: "adminQueue.fixMatch.level.likely",
  possible: "adminQueue.fixMatch.level.possible",
  wrong: "adminQueue.fixMatch.level.wrong",
  unknown: "adminQueue.fixMatch.level.unknown",
};

export function isCandidateMatch(level: string): level is CandidateMatch {
  return Object.prototype.hasOwnProperty.call(LEVEL_STYLES, level);
}

/** A candidate's level, or "unknown" for one the scorer doesn't name. */
export function candidateLevel(level: string): CandidateMatch {
  return isCandidateMatch(level) ? level : "unknown";
}

// A row only PICKS its candidate; the footer's Apply sends it, so a misclick
// while scrolling the list never rematches the item.
export function PlexCandidateRow({
  candidate, onPick, picked, disabled, serverInstance,
}: {
  candidate:      CandidateView;
  onPick:         (guid: string) => void;
  picked:         boolean;
  disabled:       boolean;
  serverInstance: string;
}) {
  const t = useT();
  const level   = candidateLevel(candidate.matchLevel);
  const style   = LEVEL_STYLES[level];
  // Relative Plex thumb paths are server-local — proxy them against the same
  // instance the candidates came from. Omitted when default.
  const thumbSrc = candidate.thumb
    ? withBasePath(`/api/admin/fix-match/thumb?${new URLSearchParams({
        path: candidate.thumb,
        ...(serverInstance ? { serverInstance } : {}),
      })}`)
    : null;

  return (
    <button
      onClick={() => onPick(candidate.guid)}
      disabled={disabled}
      aria-pressed={picked}
      className={`w-full text-left px-5 py-3.5 flex items-start gap-4 transition-colors
        disabled:opacity-50 disabled:cursor-not-allowed ${style.border} ${style.bg}`}
      style={picked ? { boxShadow: "inset 0 0 0 2px var(--ds-accent-ring)" } : undefined}
    >
      <div className="flex-shrink-0 w-14 h-[84px] rounded overflow-hidden bg-zinc-800 flex items-center justify-center mt-0.5">
        {thumbSrc
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={thumbSrc} alt={candidate.name || t("adminQueue.fixMatch.thumb")} className="w-full h-full object-cover" />
          : <span className="text-zinc-500 text-xs">?</span>}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-base font-medium text-zinc-200 leading-tight">
            {(candidate.tmdbTitle ?? candidate.name) || t("adminQueue.fixMatch.untitled")}
          </span>
          {candidate.year && <span className="text-sm text-zinc-500">({candidate.year})</span>}
          <span className={`text-xs px-1.5 py-0.5 rounded border font-medium ${style.badge}`}>
            {level === "exact" ? t("adminQueue.fixMatch.exactCheck") : t(LEVEL_KEYS[level])}
          </span>
          {candidate.confidence > 0 && level !== "exact" && (
            <span className="text-xs text-zinc-500">{candidate.confidence}%</span>
          )}
        </div>
        <div className="flex items-center gap-3 mt-1 flex-wrap">
          {candidate.tmdbId && <span className="text-xs font-mono text-zinc-500">tmdb:{candidate.tmdbId}</span>}
          {candidate.imdbId && <span className="text-xs font-mono text-zinc-500">{candidate.imdbId}</span>}
          {/* TMDB answers runtime 0 for many unreleased titles: never a bare `0 &&`. */}
          {candidate.tmdbRuntime != null && candidate.tmdbRuntime > 0 && <span className="text-xs text-zinc-500">{t("adminQueue.fixMatch.minutes", { minutes: candidate.tmdbRuntime })}</span>}
        </div>
      </div>
      <div className="flex-shrink-0 text-xs text-zinc-500 mt-1">
        {picked ? <Check aria-hidden className="w-4 h-4 text-[var(--ds-accent-text)]" /> : t("adminQueue.fixMatch.select")}
      </div>
    </button>
  );
}

// The Plex candidates step: the count, Radarr/Sonarr's own answer, and the list.
export function PlexCandidatesList({
  candidates,
  selectedId,
  instanceLabel,
  pick,
  applying,
  onPick,
}: {
  candidates: Candidates;
  selectedId: number;
  instanceLabel: string;
  pick: string | null;
  applying: boolean;
  onPick: (guid: string) => void;
}) {
  const t = useT();
  return (
    <>
      <div className="px-6 pt-4 pb-3 border-b border-zinc-700 flex-shrink-0">
        <p className="text-xs text-zinc-500 uppercase tracking-wide mb-1.5">
          {t("adminQueue.fixMatch.plexCandidatesFor", { id: selectedId, count: candidates.candidates.length })}
          {instanceLabel && (
            <span className="ml-1.5 normal-case text-orange-400">{t("adminQueue.fixMatch.onInstance", { instance: instanceLabel })}</span>
          )}
        </p>
        {candidates.arrConfirmedTmdbId !== null && (
          <p className={`text-sm ${candidates.arrConfirmedTmdbId === selectedId ? "text-emerald-400" : "text-yellow-400"}`}>
            {candidates.arrConfirmedTmdbId === selectedId
              ? t("adminQueue.fixMatch.arrConfirmsId")
              : t("adminQueue.fixMatch.arrHasId", { id: candidates.arrConfirmedTmdbId })}
          </p>
        )}
      </div>

      <div className="overflow-y-auto flex-1 divide-y divide-zinc-800/60">
        {candidates.candidates.length === 0 ? (
          <p className="px-6 py-8 text-sm text-zinc-500 text-center">{t("adminQueue.fixMatch.noCandidates")}</p>
        ) : (
          candidates.candidates.map((c) => (
            <PlexCandidateRow
              key={c.guid}
              candidate={c}
              onPick={onPick}
              picked={c.guid === pick}
              disabled={applying}
              serverInstance={candidates.serverInstance}
            />
          ))
        )}
      </div>
    </>
  );
}

// ── the servers ─────────────────────────────────────────────────────────────

// Minimal inline server picker — rendered only when more than one configured
// server holds the title, i.e. only when "fix the match" is genuinely ambiguous.
// A single-server deployment never sees it.
function InstancePicker({
  service, rows, value, onChange, disabled,
}: {
  service:  Side;
  rows:     FileInfoRow[];
  value:    string | null;
  onChange: (slug: string) => void;
  disabled: boolean;
}) {
  const t = useT();
  if (rows.length < 2) return null;
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-xs text-zinc-500 shrink-0">{t("adminQueue.fixMatch.server")}</span>
      {rows.map((r) => (
        <button
          key={r.serverInstance}
          onClick={() => onChange(r.serverInstance)}
          disabled={disabled}
          title={r.filePath ?? undefined}
          className={`text-xs px-2 py-0.5 rounded border font-medium transition-colors disabled:opacity-50
            ${r.serverInstance === value
              ? "bg-indigo-500/20 border-indigo-500/50 text-indigo-300"
              : "bg-zinc-900 border-zinc-700 text-zinc-400 hover:bg-zinc-800"}`}
        >
          {mediaInstanceLabel(service, r.serverInstance)}
        </button>
      ))}
    </div>
  );
}

// One brand colour per service: a fill/border tint and its per-theme text token
// (guardrail 42). Literal class names so Tailwind generates them.
export const BRAND: Record<Side, { name: string; tint: string; text: string; textClass: string }> = {
  plex:     { name: "Plex",     tint: "var(--ds-plex)",     text: "var(--ds-plex-text)",     textClass: "text-[var(--ds-plex-text)]" },
  jellyfin: { name: "Jellyfin", tint: "var(--ds-jellyfin)", text: "var(--ds-jellyfin-text)", textClass: "text-[var(--ds-jellyfin-text)]" },
};

// A service's card on the confirm step: its state, the server picker and the
// one action that starts its fix (Plex: search candidates; Jellyfin: apply).
export function ServerFixPanel({
  side, instanceLabel, state, rows, instance, onInstance, pickerDisabled, actionLabel, onAction,
}: {
  side:           Side;
  instanceLabel:  string;
  state:          ServerState;
  rows:           FileInfoRow[];
  instance:       string | null;
  onInstance:     (slug: string) => void;
  pickerDisabled: boolean;
  actionLabel:    string;
  onAction:       () => void;
}) {
  const t = useT();
  const brand = BRAND[side];
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 space-y-2.5">
      <div className="flex items-center justify-between">
        <span className={`text-sm font-semibold ${brand.textClass}`}>
          {brand.name}{instanceLabel && <span className="ml-1.5 text-xs font-normal text-zinc-400">{instanceLabel}</span>}
        </span>
        {state.status === "done" && (
          <span className="flex items-center gap-1.5 text-xs text-green-400"><Check className="w-3.5 h-3.5" /> {t("adminQueue.fixMatch.fixed")}</span>
        )}
        {state.status === "error" && (
          <span className="text-xs text-red-400">{state.error}</span>
        )}
      </div>
      {state.status === "done" && state.warning && (
        <p className="text-xs text-amber-400 leading-snug">{state.warning}</p>
      )}
      <InstancePicker service={side} rows={rows} value={instance} onChange={onInstance} disabled={pickerDisabled} />
      {state.status === "idle" || state.status === "error" ? (
        // Brand tint fill + brand text token; .ds-hover-tint supplies the
        // hover since the background is inline.
        <button
          onClick={onAction}
          className="ds-hover-tint w-full text-xs px-3 py-2 rounded border font-medium transition-colors"
          style={{
            background: `color-mix(in oklab, ${brand.tint} 12%, transparent)`,
            borderColor: `color-mix(in oklab, ${brand.tint} 35%, var(--ds-border))`,
            color: brand.text,
          }}
        >
          {actionLabel}
        </button>
      ) : state.status === "fetching" ? (
        <p className="text-xs text-zinc-500">{t("adminQueue.fixMatch.loadingPlex")}</p>
      ) : state.status === "applying" ? (
        <p className="text-xs text-zinc-500">{t("adminQueue.fixMatch.applying")}</p>
      ) : null}
    </div>
  );
}

// ── the header ──────────────────────────────────────────────────────────────

// The file a server holds the title as: the server's name, then the file name
// (the full path in its tooltip). Brand as TEXT → the per-theme brand text
// token, not the warning colour (guardrail 42).
export function FilePathRow({ side, label, path }: { side: Side; label: string; path: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`text-xs font-semibold ${BRAND[side].textClass} w-16 shrink-0`}>
        {label}
      </span>
      <p className="text-xs font-mono text-zinc-500 truncate" title={path}>
        {path.replace(/\\/g, "/").split("/").pop()}
      </p>
    </div>
  );
}

// What Radarr/Sonarr say the file is: another id (with a one-click "use
// this", disabled while a fix runs — picking then would re-offer the fix
// buttons for a new title over the one in flight), or the current one.
export function ArrMatchLine({
  arrName,
  arrTmdbId,
  arrTitle,
  currentTmdbId,
  busy,
  onUseThis,
}: {
  arrName: string;
  arrTmdbId: number;
  arrTitle: string | null;
  currentTmdbId: number;
  busy: boolean;
  onUseThis: () => void;
}) {
  const t = useT();
  if (arrTmdbId === currentTmdbId) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-zinc-500 w-16 shrink-0">
          {arrName}
        </span>
        <span className="text-xs text-emerald-400">{t("adminQueue.fixMatch.matchesCurrent")}</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 pt-0.5">
      <span className="text-xs font-semibold text-zinc-500 w-16 shrink-0">
        {arrName}
      </span>
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-xs text-orange-400 font-mono shrink-0">→ TMDB #{arrTmdbId}</span>
        {arrTitle && (
          <span className="text-xs text-orange-400 truncate">{arrTitle}</span>
        )}
        <button
          onClick={onUseThis}
          disabled={busy}
          className="text-xs px-2 py-0.5 rounded border border-orange-500/30 bg-orange-500/10
            text-orange-400 hover:bg-orange-500/20 transition-colors shrink-0 font-medium disabled:opacity-40"
        >
          {t("adminQueue.fixMatch.useThis")}
        </button>
      </div>
    </div>
  );
}

// The dialog's header block: the title as it is matched now, the file each
// server holds it as, and what Radarr/Sonarr say it is.
export function CurrentMatchInfo({
  title,
  tmdbId,
  fileInfoError,
  plexPath,
  plexLabel,
  jellyfinPath,
  jellyfinLabel,
  arrName,
  arrTmdbId,
  arrTitle,
  busy,
  onUseArr,
}: {
  title: string;
  tmdbId: number;
  fileInfoError: boolean;
  plexPath: string | null;
  plexLabel: string;
  jellyfinPath: string | null;
  jellyfinLabel: string;
  arrName: string;
  arrTmdbId: number | null;
  arrTitle: string | null;
  busy: boolean;
  /** Picks Radarr/Sonarr's title as the correct match. */
  onUseArr: (hit: SearchHit) => void;
}) {
  const t = useT();
  return (
    <div className="px-6 py-3 border-b border-zinc-800 flex-shrink-0 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-zinc-500 font-mono uppercase shrink-0">{t("adminQueue.fixMatch.current")}</span>
        <span className="text-sm text-zinc-400 truncate">{title}</span>
        <span className="text-xs font-mono text-zinc-500 shrink-0">#{tmdbId}</span>
      </div>
      {fileInfoError && (
        <p className="text-xs text-orange-400">
          {t("adminQueue.fixMatch.fileInfoFailed")}
        </p>
      )}
      {plexPath && <FilePathRow side="plex" label={plexLabel} path={plexPath} />}
      {jellyfinPath && <FilePathRow side="jellyfin" label={jellyfinLabel} path={jellyfinPath} />}
      {arrTmdbId !== null && (
        <ArrMatchLine
          arrName={arrName}
          arrTmdbId={arrTmdbId}
          arrTitle={arrTitle}
          currentTmdbId={tmdbId}
          busy={busy}
          onUseThis={() => onUseArr({
            id: arrTmdbId,
            title: arrTitle ?? `TMDB #${arrTmdbId}`,
            overview: "",
            posterPath: null,
            releaseYear: null,
          })}
        />
      )}
    </div>
  );
}

// ── the search and the confirm step ─────────────────────────────────────────

export function SearchResultRow({ result, isCurrent, onPick }: { result: SearchHit; isCurrent: boolean; onPick: (r: SearchHit) => void }) {
  const t = useT();
  const thumb = posterUrl(result.posterPath, "w342");
  return (
    <button
      onClick={() => onPick(result)}
      disabled={isCurrent}
      className={`w-full text-left px-6 py-4 flex items-start gap-4 transition-colors
        ${isCurrent
          ? "opacity-40 cursor-not-allowed"
          : "hover:bg-zinc-800/70"}`}
    >
      <div className="flex-shrink-0 w-12 h-[72px] rounded overflow-hidden bg-zinc-800">
        {thumb
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={thumb} alt={result.title} className="w-full h-full object-cover" />
          : <div className="w-full h-full flex items-center justify-center text-zinc-500 text-xs">?</div>}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-base font-medium text-zinc-200 leading-tight">{result.title}</span>
          {result.releaseYear && <span className="text-sm text-zinc-500">({result.releaseYear})</span>}
          {isCurrent && <span className="text-xs text-zinc-500">{t("adminQueue.fixMatch.currentBadge")}</span>}
        </div>
        <span className="text-xs font-mono text-zinc-500 mt-0.5 block">TMDB #{result.id}</span>
        {result.overview && (
          <p className="text-xs text-zinc-500 mt-1 line-clamp-2 leading-snug">{result.overview}</p>
        )}
      </div>
      <div className="flex-shrink-0 text-xs text-zinc-500 mt-1">{t("adminQueue.fixMatch.select")}</div>
    </button>
  );
}

// The picked title at the top of the confirm step.
export function SelectedMatchHeader({ selected, arrName, arrConfirmed }: { selected: SearchHit; arrName: string; arrConfirmed: boolean }) {
  const t = useT();
  const thumb = posterUrl(selected.posterPath, "w342");
  return (
    <div className="px-6 py-4 border-b border-zinc-800 flex-shrink-0 flex gap-4 items-start">
      {thumb
        ? <div className="flex-shrink-0 w-16 h-[96px] rounded overflow-hidden">
            {/* eslint-disable-next-line @next/next/no-img-element -- tiny 64×96 picker thumbnail; next/image overhead isn't worth it here */}
            <img src={thumb} alt={selected.title} className="w-full h-full object-cover" />
          </div>
        : <div className="flex-shrink-0 w-16 h-[96px] rounded bg-zinc-800" />}
      <div className="flex-1 min-w-0">
        <p className="text-xs text-zinc-500 uppercase tracking-wide mb-1">{t("adminQueue.fixMatch.correctMatch")}</p>
        <p className="text-base font-semibold text-zinc-100 leading-tight">{selected.title}</p>
        {selected.releaseYear && <p className="text-sm text-zinc-400 mt-0.5">{selected.releaseYear}</p>}
        <p className="text-xs font-mono text-zinc-500 mt-0.5">TMDB #{selected.id}</p>
        {arrConfirmed && (
          <p className="text-xs text-emerald-500 mt-0.5">
            {t("adminQueue.fixMatch.arrConfirmed", { arr: arrName })}
          </p>
        )}
        {selected.overview && (
          <p className="text-xs text-zinc-500 mt-1.5 leading-snug line-clamp-3">{selected.overview}</p>
        )}
      </div>
    </div>
  );
}

export type AddWrongState = "idle" | "adding" | "done" | "conflict" | "error";

// After a fix: offer the previously wrong title as a request of its own.
export function AddWrongAsRequest({ title, tmdbId, state, onAdd }: { title: string; tmdbId: number; state: AddWrongState; onAdd: () => void }) {
  const t = useT();
  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-4 space-y-2">
      <p className="text-xs text-zinc-400 leading-snug">
        {/* One sentence with slots, so each language orders the words
            itself (a split before/after pair can't be reordered). */}
        {rich(t("adminQueue.fixMatch.wrongMatchPrompt"), {
          title: <span className="font-medium text-zinc-200">{title}</span>,
          id: <span className="font-mono text-zinc-500">#{tmdbId}</span>,
        })}
      </p>
      {state === "idle" && (
        <button
          onClick={onAdd}
          className="text-xs px-3 py-1.5 rounded border font-medium transition-colors
            bg-zinc-800 border-zinc-600 text-zinc-300 hover:bg-zinc-700 hover:border-zinc-500"
        >
          {t("adminQueue.fixMatch.addAsRequest", { title })}
        </button>
      )}
      {state === "adding" && (
        <p className="text-xs text-zinc-500">{t("adminQueue.fixMatch.adding")}</p>
      )}
      {state === "done" && (
        <p className="flex items-center gap-1.5 text-xs text-green-400">
          <Check className="w-3.5 h-3.5" /> {t("adminQueue.fixMatch.added")}
        </p>
      )}
      {state === "conflict" && (
        <p className="text-xs text-zinc-500">{t("adminQueue.fixMatch.alreadyRequested")}</p>
      )}
      {state === "error" && (
        <p className="text-xs text-red-400">{t("adminQueue.fixMatch.addFailed")}</p>
      )}
    </div>
  );
}
