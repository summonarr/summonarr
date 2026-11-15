"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle, Loader2, X } from "@/components/icons";
import { Dialog, DialogBackdrop, DialogClose, DialogPopup, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { StyledSelect } from "@/components/ui/styled-select";
import { Textarea } from "@/components/ui/textarea";
import type { TVAvailabilityResponse, TVSeasonInfo } from "@/app/api/tv-availability/route";
import { withBasePath } from "@/lib/base-path";
import { rateLimitMessage } from "@/lib/client/rate-limit";
import { readApiError } from "@/lib/client/api-error";
import { fetchJson, timedFetch } from "@/lib/client/fetch-json";
import { useAsyncAction } from "@/hooks/use-async-action";
import { v } from "@/lib/validate";
import { SLOT } from "@/lib/i18n/slot";
import { SlotText } from "@/components/i18n/slot-text";
import { useToast } from "@/components/ui/toast";
import { useT } from "@/components/i18n/i18n-provider";
import { DetailActionButton } from "./detail-action-button";

type IssueType = "BAD_VIDEO" | "WRONG_AUDIO" | "MISSING_SUBTITLES" | "WRONG_MATCH" | "OTHER";
type IssueScope = "FULL" | "SEASON" | "EPISODE";

// i18n keys (request.json), translated at render.
const ISSUE_TYPE_LABELS: Record<IssueType, string> = {
  BAD_VIDEO: "request.report.type.badVideo",
  WRONG_AUDIO: "request.report.type.wrongAudio",
  MISSING_SUBTITLES: "request.report.type.missingSubtitles",
  WRONG_MATCH: "request.report.type.wrongMatch",
  OTHER: "request.report.type.other",
};

const SCOPE_LABELS: Record<IssueScope, string> = {
  FULL: "request.report.scope.full",
  SEASON: "request.report.scope.season",
  EPISODE: "request.report.scope.episode",
};

interface ReportIssueButtonProps {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  title: string;
  posterPath?: string | null;
  // Optional prefill — used by watch-history rows to open the dialog already
  // scoped to the episode the entry represents. Ignored for movies; falls back
  // to the library-availability defaults when the values aren't in the lists.
  initialScope?: IssueScope;
  initialSeasonNumber?: number | null;
  initialEpisodeNumber?: number | null;
  // Icon-only trigger for dense row layouts (full labelled button otherwise).
  compact?: boolean;
}

type DialogState = "idle" | "loading" | "open" | "submitting" | "submitted" | "error";

// The form is mounted for BOTH `open` and `submitting` (see the render below),
// so the season/episode control type must be decided on the same predicate.
// Keying this on `dialogState === "open"` alone made a not-in-library show
// (`/api/tv-availability` answers 200 `{ seasons: [] }`, so `availabilityFailed`
// stays false) swap its manual number inputs for an empty, disabled <select>
// for the duration of every submit — and flip back on a server error. Kept as
// a module-level pure function so tests/report-issue-manual-inputs.test.mts
// can pin it without rendering the component.
function shouldUseManualInputs(
  isTV: boolean,
  availabilityFailed: boolean,
  dialogState: DialogState,
  seasonCount: number,
): boolean {
  if (!isTV) return false;
  if (availabilityFailed) return true;
  const formVisible = dialogState === "open" || dialogState === "submitting";
  return formVisible && seasonCount === 0;
}

// A season/episode pick carried across a change of the lists or the scope:
// the current season stays when the list still has it (else the first season),
// and the current episode stays when that season still lists it (else the
// season's first episode). Never a null episode while the chosen season has
// episodes — see withScope for why. Module-level and pure so
// tests/report-issue-manual-inputs.test.mts can pin it.
function keepSeasonEpisode(
  seasons: TVSeasonInfo[],
  season: number | null,
  episode: number | null,
): { season: number | null; episode: number | null } {
  const kept = season != null ? seasons.find((s) => s.seasonNumber === season) : undefined;
  const chosen = kept ?? seasons[0];
  if (!chosen) return { season: null, episode: null };
  const keepEpisode = kept !== undefined && episode != null && chosen.episodes.includes(episode);
  return { season: chosen.seasonNumber, episode: keepEpisode ? episode : chosen.episodes[0] ?? null };
}

// The library lists can miss what a watch-history row reports: tv-availability
// lists only the sign-in provider's sources, and TVEpisodeCache lags live play
// history. A seeded season/episode is the one the viewer actually played, so it
// JOINS the options instead of being swapped for the first season's first
// episode, which the selects (no manual inputs once a list exists) left
// unreachable. An empty list stays empty: that keeps the manual inputs, already
// seeded with the same numbers.
function withSeedOptions(
  seasons: TVSeasonInfo[],
  seedSeason: number | null,
  seedEpisode: number | null,
): TVSeasonInfo[] {
  if (seasons.length === 0 || seedSeason == null) return seasons;
  const existing = seasons.find((s) => s.seasonNumber === seedSeason);
  if (!existing) {
    const added = { seasonNumber: seedSeason, episodes: seedEpisode != null ? [seedEpisode] : [] };
    return [...seasons, added].sort((a, b) => a.seasonNumber - b.seasonNumber);
  }
  if (seedEpisode == null || existing.episodes.includes(seedEpisode)) return seasons;
  return seasons.map((s) =>
    s === existing ? { ...s, episodes: [...s.episodes, seedEpisode].sort((a, b) => a - b) } : s,
  );
}

// Everything the user fills in. One object, so opening the dialog resets the
// whole form in one place (freshForm) and a new field can't be missed there.
interface IssueForm {
  issueType: IssueType;
  scope: IssueScope;
  note: string;
  selectedSeason: number | null;
  selectedEpisode: number | null;
  manualSeason: string;
  manualEpisode: string;
}

// The scope a seeded open starts on. The server files a season or an episode
// only by a number of 1 or more (issue-create.ts numberField), so a special
// (season 0) can only be reported against the whole show: a seed below 1 opens
// on "Whole show" instead of a "Season 0" pick the server answers 400 for.
// Module-level and pure so tests/report-issue-manual-inputs.test.mts can pin it.
function seededScope(
  isTV: boolean,
  initialScope: IssueScope | undefined,
  initialSeason: number | null | undefined,
  initialEpisode: number | null | undefined,
): IssueScope {
  if (!isTV) return "FULL";
  const scope = initialScope ?? "FULL";
  if (scope !== "FULL" && initialSeason != null && initialSeason < 1) return "FULL";
  if (scope === "EPISODE" && initialEpisode != null && initialEpisode < 1) return "SEASON";
  return scope;
}

// Only what the server accepts is offered: specials (season 0) and an
// episode 0 are dropped from the library lists.
function reportableSeasons(seasons: TVSeasonInfo[]): TVSeasonInfo[] {
  return seasons
    .filter((s) => s.seasonNumber >= 1)
    .map((s) => (s.episodes.some((e) => e < 1) ? { ...s, episodes: s.episodes.filter((e) => e >= 1) } : s));
}

// The form a fresh open starts from. A watch-history row seeds the scope and
// the episode it represents; movies always report the whole title.
function freshForm(
  isTV: boolean,
  initialScope: IssueScope | undefined,
  initialSeason: number | null | undefined,
  initialEpisode: number | null | undefined,
): IssueForm {
  const scope = seededScope(isTV, initialScope, initialSeason, initialEpisode);
  const season = isTV && scope !== "FULL" ? initialSeason ?? null : null;
  const episode = isTV && scope === "EPISODE" ? initialEpisode ?? null : null;
  return {
    issueType: "BAD_VIDEO",
    scope,
    note: "",
    selectedSeason: season,
    selectedEpisode: episode,
    manualSeason: season != null ? String(season) : "",
    manualEpisode: episode != null ? String(episode) : "",
  };
}

// A scope change re-validates the season/episode pick against the lists. A
// pick the lists still hold is KEPT — Season 3 chosen under SEASON stays
// Season 3 under EPISODE — and the manual inputs keep their values
// (resolveNumbers ignores the episode outside EPISODE scope). The episode is
// seeded too, never left null while the season has episodes. A null did NOT
// leave the field blank — a controlled <select> whose value matches no option
// falls back to displaying the first one, so the dropdown read "Episode 1"
// while the state was null. The user saw a complete form, submitted, and got
// the server's raw `episodeNumber is required for EPISODE scope` back about a
// field they were looking at.
function withScope(form: IssueForm, seasons: TVSeasonInfo[], scope: IssueScope): IssueForm {
  if (scope === form.scope) return form;
  const next = keepSeasonEpisode(seasons, form.selectedSeason, form.selectedEpisode);
  return { ...form, scope, selectedSeason: next.season, selectedEpisode: next.episode };
}

// The season/episode numbers to send for the form as shown.
function resolveNumbers(
  form: IssueForm,
  isTV: boolean,
  useManualInputs: boolean,
): { season: number | undefined; episode: number | undefined } {
  if (!isTV || form.scope === "FULL") return { season: undefined, episode: undefined };
  const { scope, manualSeason, manualEpisode, selectedSeason, selectedEpisode } = form;

  if (useManualInputs) {
    return {
      season: manualSeason ? parseInt(manualSeason, 10) : undefined,
      episode: scope === "EPISODE" && manualEpisode ? parseInt(manualEpisode, 10) : undefined,
    };
  }

  // A season with no listed episodes (a seeded one the library doesn't know)
  // shows the manual episode input instead of an empty select.
  return {
    season: selectedSeason ?? undefined,
    episode: scope === "EPISODE"
      ? (selectedEpisode ?? (manualEpisode ? parseInt(manualEpisode, 10) : undefined))
      : undefined,
  };
}

// What /api/tv-availability said for this open. `failed`: it didn't answer, so
// the form falls back to manual inputs and says why.
interface LibraryLists {
  seasons: TVSeasonInfo[];
  source: TVAvailabilityResponse["source"];
  failed: boolean;
}

const NO_LISTS: LibraryLists = { seasons: [], source: null, failed: false };

const AvailabilityAnswer = v.object({
  source: v.nullable(v.literal("plex", "jellyfin", "both")),
  seasons: v.array(v.object({ seasonNumber: v.int(), episodes: v.array(v.int()) })),
});

type Translate = ReturnType<typeof useT>;

const LABEL_CLASS = "text-xs font-medium text-zinc-400 uppercase tracking-wide";

function DialogHeader({ title, closeDisabled, t }: { title: string; closeDisabled: boolean; t: Translate }) {
  return (
    <div
      className="flex items-center justify-between"
      style={{
        padding: "14px 20px",
        borderBottom: "1px solid var(--ds-border)",
      }}
    >
      <div>
        <DialogTitle
          className="font-semibold"
          style={{ fontSize: 15, color: "var(--ds-fg)", margin: 0 }}
        >
          {t("request.report.dialogTitle")}
        </DialogTitle>
        <p
          className="ds-mono truncate max-w-72"
          style={{
            fontSize: 11,
            color: "var(--ds-fg-subtle)",
            margin: "2px 0 0",
          }}
        >
          {title}
        </p>
      </div>
      <DialogClose
        aria-label={t("request.close")}
        disabled={closeDisabled}
        className="ds-hover-tint inline-flex items-center justify-center rounded-full disabled:opacity-40"
        style={{
          width: 32,
          height: 32,
          background: "transparent",
          border: 0,
          color: "var(--ds-fg-muted)",
        }}
      >
        <X style={{ width: 14, height: 14 }} />
      </DialogClose>
    </div>
  );
}

function LoadingBody({ t }: { t: Translate }) {
  return (
    <div
      className="ds-mono flex items-center justify-center"
      style={{
        gap: 8,
        padding: "32px 20px",
        fontSize: 12,
        color: "var(--ds-fg-subtle)",
      }}
    >
      <Loader2
        className="animate-spin"
        style={{
          width: 14,
          height: 14,
          color: "var(--ds-accent-text)",
        }}
      />
      {t("request.report.loadingLibrary")}
    </div>
  );
}

function SubmittedBody({ onClose, t }: { onClose: () => void; t: Translate }) {
  return (
    <div
      className="text-center"
      style={{ padding: "32px 20px" }}
    >
      <div
        className="mx-auto flex items-center justify-center rounded-full"
        style={{
          width: 40,
          height: 40,
          marginBottom: 12,
          background:
            "color-mix(in oklab, var(--ds-success) 12%, transparent)",
        }}
      >
        <CheckCircle
          style={{
            width: 20,
            height: 20,
            color: "var(--ds-success)",
          }}
        />
      </div>
      <p
        className="font-medium"
        style={{ fontSize: 13, color: "var(--ds-fg)", margin: "0 0 4px" }}
      >
        {t("request.report.reported")}
      </p>
      <p
        style={{ fontSize: 12, color: "var(--ds-fg-muted)", margin: 0 }}
      >
        {t("request.report.adminWillReview")}
      </p>
      <DetailActionButton
        variant="secondary"
        size="sm"
        onClick={onClose}
        style={{ marginTop: 18 }}
      >
        {t("request.close")}
      </DetailActionButton>
    </div>
  );
}

// The season (and, for one episode, episode) pickers: selects over the library
// lists, or number inputs when there are no lists to pick from.
function SeasonEpisodeFields({
  form,
  update,
  seasons,
  useManualInputs,
  disabled,
  t,
}: {
  form: IssueForm;
  update: (patch: Partial<IssueForm>) => void;
  seasons: TVSeasonInfo[];
  useManualInputs: boolean;
  disabled: boolean;
  t: Translate;
}) {
  const currentSeason = seasons.find((s) => s.seasonNumber === form.selectedSeason);

  function handleSeasonChange(seasonNum: number) {
    const season = seasons.find((s) => s.seasonNumber === seasonNum);
    update({ selectedSeason: seasonNum, selectedEpisode: season?.episodes[0] ?? null });
  }

  return (
    <div className="flex gap-3">
      <div className="flex-1 space-y-1.5">
        <label htmlFor="report-issue-season" className={LABEL_CLASS}>{t("request.report.season")}</label>
        {!useManualInputs ? (
          <StyledSelect
            id="report-issue-season"
            value={String(form.selectedSeason ?? "")}
            onChange={(e) => handleSeasonChange(Number(e.target.value))}
            disabled={disabled}
          >
            {seasons.map((s) => (
              <option key={s.seasonNumber} value={String(s.seasonNumber)}>
                {t("request.report.seasonN", { number: s.seasonNumber })}
              </option>
            ))}
          </StyledSelect>
        ) : (
          <Input
            id="report-issue-season"
            type="number"
            min={1}
            value={form.manualSeason}
            onChange={(e) => update({ manualSeason: e.target.value })}
            placeholder={t("request.report.examplePlaceholder", { number: 2 })}
            required
            disabled={disabled}
          />
        )}
      </div>

      {form.scope === "EPISODE" && (
        <div className="flex-1 space-y-1.5">
          <label htmlFor="report-issue-episode" className={LABEL_CLASS}>{t("request.report.episode")}</label>
          {!useManualInputs && currentSeason && currentSeason.episodes.length > 0 ? (
            <StyledSelect
              id="report-issue-episode"
              value={String(form.selectedEpisode ?? "")}
              onChange={(e) => update({ selectedEpisode: Number(e.target.value) })}
              disabled={disabled}
            >
              {currentSeason.episodes.map((ep) => (
                <option key={ep} value={String(ep)}>
                  {t("request.report.episodeN", { number: ep })}
                </option>
              ))}
            </StyledSelect>
          ) : (
            <Input
              id="report-issue-episode"
              type="number"
              min={1}
              value={form.manualEpisode}
              onChange={(e) => update({ manualEpisode: e.target.value })}
              placeholder={t("request.report.examplePlaceholder", { number: 4 })}
              required
              disabled={disabled}
            />
          )}
        </div>
      )}
    </div>
  );
}

// POST /api/issues: null on success, else the text to show. Never throws.
async function postIssue(body: Record<string, unknown>, signal: AbortSignal, t: Translate): Promise<{ error: string } | null> {
  try {
    const res = await timedFetch(withBasePath("/api/issues"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (res.ok) return null;
    return { error: rateLimitMessage(res, t) ?? (await readApiError(res, t("request.somethingWrong"))) };
  } catch {
    return { error: t("request.networkError") };
  }
}

export function ReportIssueButton({
  tmdbId,
  mediaType,
  title,
  posterPath,
  initialScope,
  initialSeasonNumber,
  initialEpisodeNumber,
  compact,
}: ReportIssueButtonProps) {
  const [dialogState, setDialogState] = useState<DialogState>("idle");
  const { toast } = useToast();
  const t = useT();
  const action = useAsyncAction();
  const isTV = mediaType === "TV";
  const [form, setForm] = useState<IssueForm>(() => freshForm(isTV, initialScope, initialSeasonNumber, initialEpisodeNumber));
  const [lists, setLists] = useState<LibraryLists>(NO_LISTS);
  const [errorMsg, setErrorMsg] = useState("");
  const update = (patch: Partial<IssueForm>) => setForm((f) => ({ ...f, ...patch }));

  const tvSeasons = lists.seasons;
  const availabilityFailed = lists.failed;
  const useManualInputs = shouldUseManualInputs(isTV, availabilityFailed, dialogState, tvSeasons.length);

  async function openDialog() {
    const seeded = freshForm(isTV, initialScope, initialSeasonNumber, initialEpisodeNumber);
    setDialogState("loading");
    setForm(seeded);
    setErrorMsg("");
    // The previous open's lists: left in place, a failed re-load showed its
    // "Showing from Plex" next to the load-failed warning.
    setLists(NO_LISTS);

    if (isTV) {
      // Under the "open" key: closing the dialog aborts it, and a newer open
      // replaces it, so an answer for an open the user already dismissed never
      // writes back (run resolves undefined).
      const res = await action.run("open", (signal) =>
        fetchJson(withBasePath(`/api/tv-availability?tmdbId=${tmdbId}`), { schema: AvailabilityAnswer, signal }),
      );
      if (!res) return;
      if (!res.ok) {
        setLists({ ...NO_LISTS, failed: true });
      } else {
        const seasons = withSeedOptions(reportableSeasons(res.data.seasons), seeded.selectedSeason, seeded.selectedEpisode);
        setLists({ seasons, source: res.data.source, failed: false });
        if (seasons.length > 0) {
          // The seed when given (now always in the list), else the first.
          const pick = keepSeasonEpisode(seasons, seeded.selectedSeason, seeded.selectedEpisode);
          setForm((f) => ({ ...f, selectedSeason: pick.season, selectedEpisode: pick.episode }));
        }
      }
    }
    setDialogState("open");
  }

  function closeDialog() {
    if (dialogState === "submitting") return;
    // Escape, an outside click and the X all land here, the load included:
    // aborting it is what keeps a late answer from reopening the dialog.
    action.abort("open");
    setDialogState("idle");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (action.busy("submit")) return;
    setDialogState("submitting");
    setErrorMsg("");

    const { season, episode } = resolveNumbers(form, isTV, useManualInputs);

    const out = await action.run(
      "submit",
      (signal) =>
        postIssue(
          {
            tmdbId,
            mediaType,
            title,
            posterPath,
            issueType: form.issueType,
            scope: mediaType === "MOVIE" ? "FULL" : form.scope,
            seasonNumber: season,
            episodeNumber: episode,
            note: form.note.trim() || undefined,
          },
          signal,
          t,
        ),
      { ifBusy: "skip" },
    );
    if (out === undefined) return;
    if (out) {
      setErrorMsg(out.error);
      setDialogState("open");
      return;
    }
    setDialogState("submitted");
    toast({ title: t("request.report.reportedToast"), variant: "success" });
  }

  const isSubmitting = dialogState === "submitting";

  const sourceLabel = lists.source === "plex"
    ? "Plex"
    : lists.source === "jellyfin"
    ? "Jellyfin"
    : lists.source === "both"
    ? t("request.report.bothSources")
    : null;

  return (
    <>
      {compact ? (
        // Icon-only trigger for dense rows (watch history). Hover is the shared
        // inset tint — the old onMouseEnter/onMouseLeave repaint stuck after a
        // tap on touch.
        <button
          type="button"
          onClick={openDialog}
          aria-label={t("request.report.reportWith", { title })}
          title={t("request.report.reportAnIssue")}
          className="ds-hover-tint relative inline-flex items-center justify-center shrink-0"
          style={{
            width: 28,
            height: 28,
            borderRadius: 6,
            background: "transparent",
            color: "var(--ds-fg-subtle)",
            border: "1px solid transparent",
          }}
        >
          {/* Extends the hit area to 40×40 while the visual stays 28px — the
              same recipe as NotInterestedButton's corner control. A tap on the
              span targets the button. */}
          <span aria-hidden="true" style={{ position: "absolute", inset: -6 }} />
          <AlertTriangle style={{ width: 14, height: 14 }} />
        </button>
      ) : (
        <DetailActionButton variant="secondary" onClick={openDialog}>
          <AlertTriangle style={{ width: 14, height: 14 }} />
          {t("request.report.reportIssue")}
        </DetailActionButton>
      )}

      {dialogState !== "idle" && (
        <Dialog open onOpenChange={(open) => { if (!open) closeDialog(); }}>
          <DialogPortal>
            <DialogBackdrop />
            <DialogPopup
              className="max-w-md overflow-y-auto"
              style={{
                background: "var(--ds-bg-1)",
                border: "1px solid var(--ds-border)",
                borderRadius: 12,
                boxShadow: "var(--ds-shadow-lg)",
              }}
            >
            {/* The X stays usable while the library loads, like Escape and an
                outside click: only a submit in flight holds the dialog open. */}
            <DialogHeader title={title} closeDisabled={isSubmitting} t={t} />

            {dialogState === "loading" && <LoadingBody t={t} />}

            {dialogState === "submitted" && <SubmittedBody onClose={closeDialog} t={t} />}

            {(dialogState === "open" || dialogState === "submitting") && (
              <form onSubmit={handleSubmit} className="px-5 py-4 space-y-4">
                {isTV && sourceLabel && (
                  <p className="text-[11px] text-zinc-500">
                    {/* Split around the source so the name keeps its emphasis in any word order. */}
                    <SlotText text={t("request.report.showingFrom", { source: SLOT })}>
                      <span className="text-zinc-400 font-medium">{sourceLabel}</span>
                    </SlotText>
                  </p>
                )}
                {isTV && availabilityFailed && (
                  <p className="text-[11px] text-amber-400">
                    {t("request.report.libraryLoadFailed")}
                  </p>
                )}

                <div className="space-y-1.5">
                  <label htmlFor="report-issue-type" className={LABEL_CLASS}>{t("request.report.issueType")}</label>
                  <StyledSelect
                    id="report-issue-type"
                    value={form.issueType}
                    onChange={(e) => update({ issueType: e.target.value as IssueType })}
                    disabled={isSubmitting}
                  >
                    {Object.entries(ISSUE_TYPE_LABELS).map(([k, key]) => (
                      <option key={k} value={k}>{t(key)}</option>
                    ))}
                  </StyledSelect>
                </div>

                {isTV && (
                  <div className="space-y-1.5">
                    <label htmlFor="report-issue-scope" className={LABEL_CLASS}>{t("request.report.affects")}</label>
                    <StyledSelect
                      id="report-issue-scope"
                      value={form.scope}
                      onChange={(e) => setForm((f) => withScope(f, tvSeasons, e.target.value as IssueScope))}
                      disabled={isSubmitting}
                    >
                      {Object.entries(SCOPE_LABELS).map(([k, key]) => (
                        <option key={k} value={k}>{t(key)}</option>
                      ))}
                    </StyledSelect>
                  </div>
                )}

                {isTV && form.scope !== "FULL" && (
                  <SeasonEpisodeFields
                    form={form}
                    update={update}
                    seasons={tvSeasons}
                    useManualInputs={useManualInputs}
                    disabled={isSubmitting}
                    t={t}
                  />
                )}

                <div className="space-y-1.5">
                  <label htmlFor="report-issue-note" className={LABEL_CLASS}>
                    {t("request.report.details")} <span className="text-zinc-500 normal-case">{t("request.report.optional")}</span>
                  </label>
                  <Textarea
                    id="report-issue-note"
                    value={form.note}
                    onChange={(e) => update({ note: e.target.value })}
                    placeholder={form.issueType === "WRONG_MATCH" ? t("request.report.wrongMatchPlaceholder") : t("request.report.describePlaceholder")}
                    maxLength={1000}
                    rows={3}
                    disabled={isSubmitting}
                    className="resize-none"
                  />
                  {/* Same counter as the request note's n/500 — the cap used
                      to truncate a pasted description silently. */}
                  <p
                    className="ds-mono"
                    style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)", margin: 0 }}
                  >
                    {form.note.length}/1000
                  </p>
                </div>

                {errorMsg && (
                  <p role="alert" className="text-xs text-red-400">{errorMsg}</p>
                )}

                <div className="flex justify-end gap-2 pt-1">
                  <DetailActionButton
                    variant="ghost"
                    size="sm"
                    onClick={closeDialog}
                    disabled={isSubmitting}
                  >
                    {t("request.cancel")}
                  </DetailActionButton>
                  <DetailActionButton
                    type="submit"
                    variant="primary"
                    size="sm"
                    disabled={isSubmitting}
                    busy={isSubmitting}
                  >
                    {isSubmitting && (
                      <Loader2
                        className="animate-spin"
                        style={{ width: 14, height: 14 }}
                      />
                    )}
                    {t("request.report.submit")}
                  </DetailActionButton>
                </div>
              </form>
            )}
            </DialogPopup>
          </DialogPortal>
        </Dialog>
      )}
    </>
  );
}
