"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "@/components/icons";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { withBasePath } from "@/lib/base-path";
import { formatRelativeTimeLocalized } from "@/lib/relative-time";
import { runReplaceFileJob } from "@/lib/client/replace-file-job";
import { fixMatchErrorMessage, fixMatchWarningMessage, runFixMatch, type FixMatchProgressView } from "@/lib/client/fix-match";
import { folderYear, fixableFlag, type MatchCounts, type MatchFlag, type MatchFlagKind } from "@/lib/library-match";
import type { LibraryMatchSource } from "@/lib/library-match-data";

// Admin → Library's match check (src/lib/library-match.ts): every Plex and
// Jellyfin item judged against the folder Radarr/Sonarr say it is in, painted
// from the stored report at once; "Check now" re-runs it as a background job
// (the guardrail-37a pattern) and reloads the page. A Fix rematches ONE item
// (fix-match's item mode) — never every copy of a title.

export type ClientMatchFlag = Omit<MatchFlag, "path">;

export interface ClientMatchReport {
  checkedAt: string;
  sources: LibraryMatchSource[];
  counts: MatchCounts;
  flags: ClientMatchFlag[];
  truncated: number;
}

const CHECK_POLL_MS = 2_000;
// 450 × 2 s = 15 minutes — a whole Plex + Jellyfin listing plus every Radarr/Sonarr title.
const CHECK_MAX_POLLS = 450;
const RENDER_CAP = 300;

const KIND_KEYS: Record<MatchFlagKind, string> = {
  wrongMatch: "adminManage.library.match.kind.wrongMatch",
  noTmdbId: "adminManage.library.match.kind.noTmdbId",
  yearMismatch: "adminManage.library.match.kind.yearMismatch",
};

function serviceLabel(service: "plex" | "jellyfin" | "radarr" | "sonarr", instance: string): string {
  const base = { plex: "Plex", jellyfin: "Jellyfin", radarr: "Radarr", sonarr: "Sonarr" }[service];
  return instance ? `${base} (${instance})` : base;
}

const flagKey = (f: ClientMatchFlag) => `${f.server}:${f.serverInstance}:${f.itemKey}`;

// m:ss from a duration the poll already measured — no clock read in render (guardrail 16).
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function titleWithYear(title: string | null, year: number | null, fallback: string): string {
  const name = title ?? fallback;
  // Some servers keep the year in the name ("Show (2013)").
  return year && !name.endsWith(`(${year})`) ? `${name} (${year})` : name;
}

// `onFixed(key, warning)`: a fix that went through but carries a warning (a
// partial remap, a Plex metadata merge) keeps its row on screen with that
// warning — dropping the row at once threw the note away unread.
type OnFixed = (key: string, warning?: string) => void;

function FixOneButton({ flag, onFixed }: { flag: ClientMatchFlag & { arr: { tmdbId: number } }; onFixed: OnFixed }) {
  const t = useT();
  const [state, setState] = useState<"idle" | "confirm" | "running" | "error">("idle");
  const [progress, setProgress] = useState<FixMatchProgressView | null>(null);
  const [message, setMessage] = useState("");

  const run = useCallback(async () => {
    setState("running");
    setMessage("");
    try {
      const outcome = await runFixMatch(
        {
          server: flag.server,
          mediaType: flag.mediaType,
          correctTmdbId: flag.arr.tmdbId,
          itemKey: flag.itemKey,
          ...(flag.serverInstance ? { serverInstance: flag.serverInstance } : {}),
        },
        { onProgress: setProgress },
      );
      const warning = fixMatchWarningMessage(outcome, t);
      onFixed(flagKey(flag), warning ?? undefined);
    } catch (err) {
      setState("error");
      setMessage(fixMatchErrorMessage(err, t));
    }
  }, [flag, onFixed, t]);

  const button = "ds-tap inline-flex items-center gap-1.5 font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
  const style = { padding: "4px 10px", fontSize: 12, borderRadius: 6 } as const;
  if (state === "confirm") {
    return (
      <div className="flex flex-col items-start gap-1.5 sm:items-end" style={{ maxWidth: 240 }}>
        <span className="sm:text-right" style={{ fontSize: 12, color: "var(--ds-fg-muted)" }}>
          {t("adminManage.library.match.confirmOne", { server: serviceLabel(flag.server, flag.serverInstance) })}
        </span>
        <div className="flex gap-2">
          <button type="button" onClick={run} className={button} style={{ ...style, background: "var(--ds-accent)", color: "var(--ds-accent-fg)" }}>
            {t("adminManage.library.match.rematch")}
          </button>
          <button type="button" onClick={() => setState("idle")} className={`${button} ds-hover-tint`} style={{ ...style, border: "1px solid var(--ds-border)", color: "var(--ds-fg-muted)" }}>
            {t("adminManage.library.match.cancel")}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => setState("confirm")}
        disabled={state === "running"}
        className={button}
        style={{ ...style, background: "color-mix(in oklab, var(--ds-accent) 14%, transparent)", border: "1px solid color-mix(in oklab, var(--ds-accent) 35%, var(--ds-border))", color: "var(--ds-accent-text)" }}
      >
        {state === "running" && <Loader2 className="animate-spin" style={{ width: 12, height: 12 }} />}
        {state === "running"
          ? (progress?.phase === "confirming"
            ? t("adminManage.library.match.confirming", { elapsed: formatElapsed(progress.elapsedMs) })
            : t("adminManage.library.match.applying"))
          : t("adminManage.library.match.fixTo", { id: flag.arr.tmdbId })}
      </button>
      {message && (
        <span role="status" className={state === "error" ? "text-red-400" : "text-amber-400"} style={{ fontSize: 11, maxWidth: 360, textAlign: "right" }}>
          {message}
        </span>
      )}
    </div>
  );
}

function FixAllButton({ flags, onFixed }: { flags: Array<ClientMatchFlag & { arr: { tmdbId: number } }>; onFixed: OnFixed }) {
  const t = useT();
  const router = useRouter();
  const [state, setState] = useState<"idle" | "confirm" | "running" | "done">("idle");
  const [progress, setProgress] = useState({ done: 0, failed: 0, total: 0 });
  const [failures, setFailures] = useState<Array<{ key: string; title: string; error: string }>>([]);

  const run = useCallback(async () => {
    setState("running");
    const total = flags.length;
    let done = 0;
    let failed = 0;
    const collected: Array<{ key: string; title: string; error: string }> = [];
    setProgress({ done, failed, total });
    setFailures([]);
    // One at a time: each remap finishes on the server before the next starts.
    for (const flag of flags) {
      try {
        const outcome = await runFixMatch({
          server: flag.server,
          mediaType: flag.mediaType,
          correctTmdbId: flag.arr.tmdbId,
          itemKey: flag.itemKey,
          ...(flag.serverInstance ? { serverInstance: flag.serverInstance } : {}),
        });
        // The row keeps the warning (FlagRow); a bulk run that dropped it read
        // "N/N fixed" over a remap that was only partial.
        onFixed(flagKey(flag), fixMatchWarningMessage(outcome, t) ?? undefined);
      } catch (err) {
        failed++;
        collected.push({ key: flagKey(flag), title: titleWithYear(flag.title, flag.year, flag.folder ?? flag.itemKey), error: fixMatchErrorMessage(err, t) });
      }
      done++;
      setProgress({ done, failed, total });
      setFailures([...collected]);
    }
    setState("done");
    if (done > failed) router.refresh();
  }, [flags, onFixed, router, t]);

  if (flags.length === 0 && state === "idle") return null;
  const button = "ds-tap inline-flex items-center font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
  const style = { padding: "5px 12px", fontSize: 12, borderRadius: 6 } as const;
  return (
    <div className="flex flex-col items-end gap-1" style={{ maxWidth: 460 }}>
      {state === "confirm" ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span style={{ fontSize: 12, color: "var(--ds-fg-muted)" }}>{t("adminManage.library.match.confirmAll", { count: flags.length })}</span>
          <button type="button" onClick={run} className={button} style={{ ...style, background: "var(--ds-accent)", color: "var(--ds-accent-fg)" }}>
            {t("adminManage.library.match.rematchAll")}
          </button>
          <button type="button" onClick={() => setState("idle")} className={`${button} ds-hover-tint`} style={{ ...style, border: "1px solid var(--ds-border)", color: "var(--ds-fg-muted)" }}>
            {t("adminManage.library.match.cancel")}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setState("confirm")}
          disabled={state === "running" || flags.length === 0}
          className={button}
          style={{ ...style, background: "color-mix(in oklab, var(--ds-success) 14%, transparent)", border: "1px solid color-mix(in oklab, var(--ds-success) 35%, var(--ds-border))", color: "var(--ds-success)" }}
        >
          {state === "running"
            ? t("adminManage.library.match.fixingAll", { done: progress.done, total: progress.total })
            : state === "done"
              ? t("adminManage.library.match.fixedAll", { fixed: progress.total - progress.failed, total: progress.total })
              : t("adminManage.library.match.fixAll", { count: flags.length })}
        </button>
      )}
      {failures.length > 0 && (
        <ul role="status" className="m-0 list-none p-0 text-right" style={{ fontSize: 11, lineHeight: 1.35 }}>
          {failures.map((f) => (
            <li key={f.key} className="text-red-400">
              <span className="font-medium">{f.title}</span>
              <span style={{ color: "var(--ds-fg-subtle)" }}> — </span>
              {f.error}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FlagRow({ flag, onFixed, fixedWarning }: { flag: ClientMatchFlag; onFixed: OnFixed; fixedWarning?: string }) {
  const t = useT();
  const server = serviceLabel(flag.server, flag.serverInstance);
  const stated = folderYear(flag.folder);
  let note: string | null = null;
  if (flag.sibling) note = t("adminManage.library.match.note.sibling");
  else if (flag.kind === "yearMismatch") note = t("adminManage.library.match.note.year", { folderYear: stated ?? "?", year: flag.year ?? "?", server });
  else if (!flag.arr) note = t("adminManage.library.match.note.unmanaged", { server });
  else if (flag.arr.tmdbId === null) note = t("adminManage.library.match.note.noArrTmdb", { arr: serviceLabel(flag.arr.service, flag.arr.instance) });

  return (
    <li
      className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between"
      style={{ padding: "10px 12px", borderTop: "1px solid var(--ds-border)" }}
    >
      <div className="min-w-0" style={{ fontSize: 12.5, lineHeight: 1.45 }}>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="ds-mono uppercase"
            style={{
              fontSize: 10, letterSpacing: "0.06em", padding: "1px 6px", borderRadius: 4,
              background: `color-mix(in oklab, var(${flag.kind === "wrongMatch" ? "--ds-danger" : "--ds-warning"}) 14%, transparent)`,
              color: `var(${flag.kind === "wrongMatch" ? "--ds-danger" : "--ds-warning"})`,
            }}
          >
            {t(KIND_KEYS[flag.kind])}
          </span>
          <span className="font-medium" style={{ color: "var(--ds-fg)" }}>
            {titleWithYear(flag.title, flag.year, t("adminManage.library.match.untitled"))}
          </span>
          <span style={{ color: "var(--ds-fg-subtle)" }}>
            {server} · {flag.mediaType === "MOVIE" ? t("adminManage.library.diff.movie") : t("adminManage.library.diff.tv")}
          </span>
        </div>
        {(flag.folder || flag.file) && (
          <div className="truncate" title={[flag.folder, flag.file].filter(Boolean).join("/")} style={{ color: "var(--ds-fg-muted)" }}>
            {t("adminManage.library.match.folder", { folder: [flag.folder, flag.file].filter(Boolean).join(" / ") })}
          </div>
        )}
        <div style={{ color: "var(--ds-fg-muted)" }}>
          {flag.serverTmdbId !== null
            ? t("adminManage.library.match.serverSays", { server, id: flag.serverTmdbId })
            : t("adminManage.library.match.serverNone", { server })}
          {flag.arr && (
            <>
              <span style={{ color: "var(--ds-fg-subtle)" }}> → </span>
              {flag.arr.tmdbId !== null
                ? t("adminManage.library.match.arrSays", {
                  arr: serviceLabel(flag.arr.service, flag.arr.instance),
                  title: titleWithYear(flag.arr.title, flag.arr.year, "?"),
                  id: flag.arr.tmdbId,
                })
                : t("adminManage.library.match.arrSaysTvdb", {
                  arr: serviceLabel(flag.arr.service, flag.arr.instance),
                  title: titleWithYear(flag.arr.title, flag.arr.year, "?"),
                  id: flag.arr.tvdbId ?? "?",
                })}
            </>
          )}
        </div>
        {note && <div style={{ color: "var(--ds-fg-subtle)", fontSize: 11.5 }}>{note}</div>}
        {fixedWarning !== undefined && (
          <div role="status" className="text-amber-400" style={{ fontSize: 11.5 }}>{fixedWarning}</div>
        )}
      </div>
      {fixedWarning === undefined && fixableFlag({ ...flag, path: null }) && flag.arr?.tmdbId != null && (
        <div className="shrink-0">
          <FixOneButton flag={flag as ClientMatchFlag & { arr: { tmdbId: number } }} onFixed={onFixed} />
        </div>
      )}
    </li>
  );
}

export function LibraryMatchCheck({ report, mediaType }: { report: ClientMatchReport | null; mediaType: "MOVIE" | "TV" | null }) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const mounted = useHasMounted();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [kind, setKind] = useState<MatchFlagKind | "all">("all");
  // Fixed this session: hidden at once; the stored report already dropped them.
  // key -> warning ("" = none). A fix with a warning keeps its row, showing it.
  const [fixed, setFixed] = useState<ReadonlyMap<string, string>>(new Map());
  const onFixed = useCallback<OnFixed>((key, warning) => setFixed((prev) => new Map(prev).set(key, warning ?? "")), []);

  const flags = useMemo(
    () => (report?.flags ?? []).filter((f) => (!mediaType || f.mediaType === mediaType) && fixed.get(flagKey(f)) !== ""),
    [report, mediaType, fixed],
  );
  const byKind = useMemo(() => {
    const out: Record<MatchFlagKind, number> = { wrongMatch: 0, noTmdbId: 0, yearMismatch: 0 };
    for (const f of flags) out[f.kind]++;
    return out;
  }, [flags]);
  const shown = kind === "all" ? flags : flags.filter((f) => f.kind === kind);
  const fixable = shown.filter((f): f is ClientMatchFlag & { arr: { tmdbId: number } } => !fixed.has(flagKey(f)) && fixableFlag({ ...f, path: null }));
  const unread = (report?.sources ?? []).filter((s) => !s.ok);

  async function check() {
    setChecking(true);
    setNote("");
    setError("");
    try {
      const answer = await runReplaceFileJob(fetch, withBasePath("/api/admin/library/match-check"), {}, {
        intervalMs: CHECK_POLL_MS,
        maxPolls: CHECK_MAX_POLLS,
        isAlive: () => alive.current,
      });
      if (!answer) return;
      if (answer.status === 0) {
        // No answer came: the check may still be running on the server — never call that a failure.
        setNote(t("adminManage.library.match.stillRunning"));
        return;
      }
      if (answer.status < 200 || answer.status >= 300) {
        const msg = (answer.data as { error?: unknown } | null)?.error;
        setError(typeof msg === "string" && msg ? msg : t("adminManage.library.match.checkFailed"));
        return;
      }
      setFixed(new Map());
      router.refresh();
    } catch {
      setError(t("adminManage.library.match.checkFailed"));
    } finally {
      if (alive.current) setChecking(false);
    }
  }

  const chip = (value: MatchFlagKind | "all", label: string) => (
    <button
      key={value}
      type="button"
      onClick={() => setKind(value)}
      aria-pressed={kind === value}
      className="ds-hover-tint inline-flex items-center whitespace-nowrap font-medium transition-colors"
      style={{
        padding: "4px 10px", borderRadius: 6, fontSize: 12,
        background: kind === value ? "var(--ds-bg-3)" : "transparent",
        color: kind === value ? "var(--ds-fg)" : "var(--ds-fg-muted)",
      }}
    >
      {label}
    </button>
  );

  return (
    <section
      aria-labelledby="library-match-check"
      style={{ marginBottom: 24, background: "var(--ds-bg-2)", border: "1px solid var(--ds-border)", borderRadius: 8 }}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between" style={{ padding: "14px 16px" }}>
        <div className="min-w-0">
          <h2 id="library-match-check" className="font-semibold" style={{ fontSize: 14, margin: 0, color: "var(--ds-fg)" }}>
            {t("adminManage.library.match.title")}
          </h2>
          <p style={{ fontSize: 12.5, margin: "4px 0 0", color: "var(--ds-fg-muted)" }}>{t("adminManage.library.match.subtitle")}</p>
          <p style={{ fontSize: 12, margin: "6px 0 0", color: "var(--ds-fg-subtle)" }}>
            {report
              ? t("adminManage.library.match.summary", {
                when: mounted ? formatRelativeTimeLocalized(report.checkedAt, locale) : "…",
                checked: report.counts.checked.toLocaleString(locale),
                agreed: report.counts.agreed.toLocaleString(locale),
                notManaged: report.counts.notManaged.toLocaleString(locale),
                // Items fixed on this page already left the stored report.
                flagged: Math.max(0, report.counts.flagged - fixed.size).toLocaleString(locale),
              })
              : t("adminManage.library.match.never")}
          </p>
          {unread.length > 0 && (
            <p className="text-amber-400" style={{ fontSize: 12, margin: "4px 0 0" }}>
              {t("adminManage.library.match.unread", { sources: unread.map((s) => serviceLabel(s.service, s.instance)).join(", ") })}
            </p>
          )}
          {report && report.truncated > 0 && (
            <p className="text-amber-400" style={{ fontSize: 12, margin: "4px 0 0" }}>
              {t("adminManage.library.match.truncated", { count: report.truncated.toLocaleString(locale) })}
            </p>
          )}
          {note && <p role="status" style={{ fontSize: 12, margin: "4px 0 0", color: "var(--ds-fg-muted)" }}>{note}</p>}
          {error && <p role="alert" className="text-red-400" style={{ fontSize: 12, margin: "4px 0 0" }}>{error}</p>}
        </div>
        <button
          type="button"
          onClick={check}
          disabled={checking}
          className="ds-tap inline-flex shrink-0 items-center gap-1.5 self-start font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ padding: "5px 12px", fontSize: 12, borderRadius: 6, background: "var(--ds-accent)", color: "var(--ds-accent-fg)" }}
        >
          {checking && <Loader2 className="animate-spin" style={{ width: 12, height: 12 }} />}
          {checking ? t("adminManage.library.match.checking") : t("adminManage.library.match.check")}
        </button>
      </div>

      {flags.length > 0 && (
        <>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between" style={{ padding: "0 16px 10px" }}>
            <div className="ds-no-scrollbar flex overflow-x-auto max-w-full" style={{ gap: 2 }}>
              {chip("all", t("adminManage.library.match.filter.all", { count: flags.length }))}
              {byKind.wrongMatch > 0 && chip("wrongMatch", t("adminManage.library.match.filter.wrongMatch", { count: byKind.wrongMatch }))}
              {byKind.noTmdbId > 0 && chip("noTmdbId", t("adminManage.library.match.filter.noTmdbId", { count: byKind.noTmdbId }))}
              {byKind.yearMismatch > 0 && chip("yearMismatch", t("adminManage.library.match.filter.yearMismatch", { count: byKind.yearMismatch }))}
            </div>
            <FixAllButton flags={fixable} onFixed={onFixed} />
          </div>
          <ul className="m-0 list-none p-0">
            {shown.slice(0, RENDER_CAP).map((f) => <FlagRow key={flagKey(f)} flag={f} onFixed={onFixed} fixedWarning={fixed.get(flagKey(f))} />)}
          </ul>
          {shown.length > RENDER_CAP && (
            <p style={{ fontSize: 12, margin: 0, padding: "10px 16px", color: "var(--ds-fg-subtle)", borderTop: "1px solid var(--ds-border)" }}>
              {t("adminManage.library.match.renderCap", { cap: RENDER_CAP, total: shown.length })}
            </p>
          )}
        </>
      )}
      {report && flags.length === 0 && (
        <p style={{ fontSize: 12.5, margin: 0, padding: "0 16px 14px", color: "var(--ds-success)" }}>{t("adminManage.library.match.clean")}</p>
      )}
    </section>
  );
}
