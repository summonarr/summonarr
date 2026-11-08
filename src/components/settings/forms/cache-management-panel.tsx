"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Loader2, RefreshCw, RefreshCcw, Trash2, Database } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { fetchJson, jsonInit } from "@/lib/client/fetch-json";
import { useDelayed } from "@/hooks/use-delayed";
import { useFocusReturn } from "@/hooks/use-focus-return";
import type { Translator } from "@/lib/i18n/translate";
import { useT } from "@/components/i18n/i18n-provider";

// Cache Management: a Clear and a Refetch button for each metadata source, plus
// one "Clear & Refetch All" button.
//
// "Clear" calls DELETE /api/admin/clear-cache?source=<id>. "Refetch" POSTs to the
// source's warm route, which re-downloads data for the whole library. The TMDB
// details cache holds most of the metadata (country, language, keywords, watch
// providers, genres).

type CacheSourceId = "tmdb" | "mdblist" | "omdb";

interface CacheSourceDef {
  id: CacheSourceId;
  label: string;
  // Catalog key, translated at render.
  descriptionKey: string;
  warmUrl: string;
  // Extra JSON body for the warm route. MDBList takes { force: true } to also
  // delete its saved "not found" markers first, so those titles are retried.
  warmBody?: Record<string, unknown>;
}

const CACHE_SOURCES: CacheSourceDef[] = [
  {
    id: "tmdb",
    label: "TMDB",
    descriptionKey: "settings.form.cache.desc.tmdb",
    warmUrl: "/api/admin/library-warm",
  },
  {
    id: "mdblist",
    label: "MDBList",
    descriptionKey: "settings.form.cache.desc.mdblist",
    warmUrl: "/api/admin/mdblist-warm",
    warmBody: { force: true },
  },
  {
    id: "omdb",
    label: "OMDB",
    descriptionKey: "settings.form.cache.desc.omdb",
    warmUrl: "/api/admin/omdb-warm",
  },
];

type WarmResult = { fetched?: number; skipped?: number; total?: number; failed?: number; purged?: number; cleared?: number };

// A clear also resets other tables that keep copies of the same data (the grid
// metadata table and the "For You" recommendation graph), so the cache-row count
// alone would under-report what the button did.
type ClearResult = WarmResult & { coreCleared?: number; edgesCleared?: number; verdictsCleared?: number };

function summarizeClear(t: Translator, d: ClearResult): string {
  const parts = [t("settings.form.cache.clear.entries", { count: d.cleared ?? 0 })];
  if ((d.coreCleared ?? 0) > 0) parts.push(t("settings.form.cache.clear.metadataRows", { count: d.coreCleared ?? 0 }));
  if ((d.edgesCleared ?? 0) > 0) parts.push(t("settings.form.cache.clear.suggestionLinks", { count: d.edgesCleared ?? 0 }));
  if ((d.verdictsCleared ?? 0) > 0) parts.push(t("settings.form.cache.clear.ratingVerdicts", { count: d.verdictsCleared ?? 0 }));
  return t("settings.form.cache.clear.summary", { parts: parts.join(", ") });
}

// The answer's counts, each read only when it is a number.
const COUNT_FIELDS = ["fetched", "skipped", "total", "failed", "purged", "cleared", "coreCleared", "edgesCleared", "verdictsCleared"] as const;

function readCounts(data: unknown): ClearResult {
  const d = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const out: ClearResult = {};
  for (const key of COUNT_FIELDS) {
    const n = d[key];
    if (typeof n === "number" && Number.isFinite(n)) out[key] = n;
  }
  return out;
}

// One step's outcome: its summary on success; on failure the route's own
// reason ("" when it gave none) and whether any answer came at all.
type StepOutcome = { ok: true; text: string } | { ok: false; reason: string; reached: boolean; status: number };

function readStep(
  res: Awaited<ReturnType<typeof fetchJson>>,
  summarize: (d: ClearResult) => string,
): StepOutcome {
  // A 2xx that still names an error (a warm that refused part-way) is a failure.
  const errorField = res.ok && res.data && typeof res.data === "object" ? (res.data as { error?: unknown }).error : undefined;
  if (res.ok && errorField === undefined) return { ok: true, text: summarize(readCounts(res.data)) };
  if (res.ok) return { ok: false, reason: typeof errorField === "string" ? errorField : "", reached: true, status: res.status };
  return { ok: false, reason: res.error, reached: res.kind === "http" || res.kind === "invalid", status: res.status };
}

// The clear and the warm requests, shared by each row and "Clear & Refetch All".
// Neither has a client-side time limit: a warm re-downloads data for the whole
// library before it answers (guardrail 37a: a slow success is not a failure).
async function clearCache(t: Translator, source: CacheSourceId | "all"): Promise<StepOutcome> {
  const res = await fetchJson(withBasePath(`/api/admin/clear-cache?source=${source}`), {
    init: { method: "DELETE" },
    timeoutMs: Infinity,
  });
  return readStep(res, (d) => summarizeClear(t, d));
}

async function warmSource(t: Translator, source: CacheSourceDef): Promise<StepOutcome> {
  const res = await fetchJson(withBasePath(source.warmUrl), {
    init: jsonInit("POST", source.warmBody ?? {}),
    timeoutMs: Infinity,
  });
  return readStep(res, (d) => summarizeWarm(t, d));
}

function summarizeWarm(t: Translator, d: WarmResult): string {
  const parts: string[] = [t("settings.form.cache.warm.fetched", { count: d.fetched ?? 0 }), t("settings.form.cache.warm.skipped", { count: d.skipped ?? 0 })];
  if ((d.purged ?? 0) > 0) parts.push(t("settings.form.cache.warm.purged", { count: d.purged ?? 0 }));
  if ((d.failed ?? 0) > 0) parts.push(t("settings.form.cache.warm.failed", { count: d.failed ?? 0 }));
  return parts.join(", ");
}

// `locked` is true while "Clear & Refetch All" runs, and the row reports its own
// busy state up, so the two can't overlap: the server would answer the loser
// with a 409/429, and a per-source Clear could wipe what run-all just refetched.
function CacheSourceRow({ source, locked, onBusyChange }: {
  source: CacheSourceDef;
  locked: boolean;
  onBusyChange: (id: CacheSourceId, busy: boolean) => void;
}) {
  const t = useT();
  const [busy, setBusyState] = useState<null | "clear" | "refetch">(null);
  const setBusy = (next: null | "clear" | "refetch") => {
    setBusyState(next);
    onBusyChange(source.id, next !== null);
  };
  const [confirmClear, setConfirmClear] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  // A new action cancels the previous action's fade (which would otherwise
  // wipe the newer result early); unmount cancels it too.
  const fade = useDelayed();
  // The confirm replaces the Clear button: focus moves into it (Cancel) and
  // back to Clear when it closes or the clear ends.
  const focus = useFocusReturn();

  async function run(kind: "clear" | "refetch") {
    setBusy(kind);
    fade.cancel();
    setMsg(null);
    const outcome = kind === "clear" ? await clearCache(t, source.id) : await warmSource(t, source);
    // The button was disabled while it ran, so focus fell to <body>.
    focus.returnToIfLost(kind);
    if (outcome.ok) setMsg({ kind: "ok", text: outcome.text });
    else if (!outcome.reached) setMsg({ kind: "err", text: t("settings.form.common.requestFailed") });
    else setMsg({ kind: "err", text: outcome.reason || t(kind === "clear" ? "settings.form.cache.clearFailed" : "settings.form.cache.refetchFailed") });
    setBusy(null);
    fade(() => setMsg(null), kind === "clear" ? 8000 : 10000);
  }

  function doClear() {
    setConfirmClear(false);
    void run("clear");
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2.5">
      <div className="min-w-[7rem] flex-1">
        <div className="text-sm font-medium text-zinc-200">{source.label}</div>
        <div className="text-xs text-zinc-500">{t(source.descriptionKey)}</div>
      </div>

      {confirmClear ? (
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-300">{t("settings.form.cache.confirmClear", { source: source.label })}</span>
          <Button type="button" size="sm" onClick={doClear} disabled={locked} className="bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)] h-8 px-3 text-xs">{t("settings.form.cache.clear")}</Button>
          <Button type="button" size="sm" variant="outline" autoFocus onClick={() => { focus.returnTo("clear"); setConfirmClear(false); }} className="border-zinc-600 text-zinc-400 hover:text-zinc-100 h-8 px-3 text-xs">{t("settings.form.common.cancel")}</Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Button
            ref={focus.refFor("clear")}
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setConfirmClear(true)}
            disabled={busy !== null || locked}
            className="border-zinc-700 text-zinc-400 hover:text-zinc-100 gap-1.5 h-8 px-3 text-xs"
          >
            {busy === "clear" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            {t("settings.form.cache.clear")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            ref={focus.refFor("refetch")}
            onClick={() => void run("refetch")}
            disabled={busy !== null || locked}
            className="border-zinc-700 text-zinc-300 hover:text-zinc-100 gap-1.5 h-8 px-3 text-xs"
          >
            {busy === "refetch" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            {t("settings.form.cache.refetch")}
          </Button>
        </div>
      )}

      {msg && (
        <span role={msg.kind === "err" ? "alert" : "status"} aria-live={msg.kind === "err" ? "assertive" : "polite"} className={`text-xs w-full sm:w-auto ${msg.kind === "err" ? "text-red-400" : "text-green-400"}`}>
          {msg.text}
        </span>
      )}
    </div>
  );
}

export function CacheManagementPanel() {
  const t = useT();
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [confirmAll, setConfirmAll] = useState(false);
  // Each line remembers whether its step succeeded so a failed source can be
  // coloured on its own; the panel-level status alone made a failed line look
  // identical to a successful one.
  const [lines, setLines] = useState<{ text: string; ok: boolean }[]>([]);
  const reset = useDelayed();
  const focus = useFocusReturn();
  // Rows with a clear or refetch in flight; run-all waits for them.
  const [busyRows, setBusyRows] = useState<ReadonlySet<CacheSourceId>>(() => new Set());
  const onRowBusy = useCallback((id: CacheSourceId, rowBusy: boolean) => {
    setBusyRows((prev) => {
      if (prev.has(id) === rowBusy) return prev;
      const next = new Set(prev);
      if (rowBusy) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const rowBusy = busyRows.size > 0;
  const running = status === "running";

  async function runAll() {
    if (rowBusy || running) return;
    reset.cancel();
    setStatus("running");
    setConfirmAll(false);
    setLines([]);
    const out: { text: string; ok: boolean }[] = [];
    let anyError = false;

    // Clear every source with one request, then refetch each source in turn.
    // Each refetch route has its own cooldown; if one answers 429 (too many
    // requests) it just shows as a failed line and the rest still run.
    const cleared = await clearCache(t, "all");
    if (cleared.ok) out.push({ text: cleared.text, ok: true });
    else {
      anyError = true;
      out.push({
        text: cleared.reached
          ? t("settings.form.cache.clearFailedDetail", { detail: cleared.reason || cleared.status })
          : t("settings.form.cache.clearFailedRequest"),
        ok: false,
      });
    }
    setLines([...out]);

    for (const source of CACHE_SOURCES) {
      const warmed = await warmSource(t, source);
      if (warmed.ok) out.push({ text: `${source.label}: ${warmed.text}`, ok: true });
      else {
        anyError = true;
        const why = warmed.reached ? warmed.reason || t("settings.form.cache.refetchFailedLower") : t("settings.form.cache.requestFailedLower");
        out.push({ text: `${source.label}: ${why}`, ok: false });
      }
      setLines([...out]);
    }

    // The trigger was disabled while running, so focus fell to <body>.
    focus.returnToIfLost("all");
    setStatus(anyError ? "error" : "done");
    reset(() => { setStatus("idle"); setLines([]); }, 15000);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Database className="w-4 h-4 text-zinc-400" />
        <h3 className="text-sm font-medium text-zinc-300">{t("settings.form.cache.title")}</h3>
      </div>
      <p className="text-xs text-zinc-500 -mt-1">
        {t("settings.form.cache.intro")}
      </p>

      <div className="space-y-2">
        {CACHE_SOURCES.map((s) => (
          <CacheSourceRow key={s.id} source={s} locked={running} onBusyChange={onRowBusy} />
        ))}
      </div>

      <div className="pt-3 border-t border-zinc-800 space-y-2">
        {confirmAll ? (
          <div className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800/60 px-3 py-2.5 w-fit">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" aria-hidden />
            <p className="text-sm text-zinc-200">{t("settings.form.cache.confirmAll")}</p>
            <Button type="button" size="sm" onClick={runAll} disabled={rowBusy} className="bg-amber-600 text-black hover:bg-amber-600/90 h-8 px-3 text-xs">{t("settings.form.cache.run")}</Button>
            <Button type="button" size="sm" variant="outline" autoFocus onClick={() => { focus.returnTo("all"); setConfirmAll(false); }} className="border-zinc-600 text-zinc-400 hover:text-zinc-100 h-8 px-3 text-xs">{t("settings.form.common.cancel")}</Button>
          </div>
        ) : (
          <Button
            ref={focus.refFor("all")}
            type="button"
            variant="outline"
            onClick={() => setConfirmAll(true)}
            disabled={running || rowBusy}
            className="border-zinc-700 text-zinc-300 hover:text-zinc-100 gap-2"
          >
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCcw className="w-4 h-4" />}
            {running ? t("settings.form.cache.running") : t("settings.form.cache.all")}
          </Button>
        )}

        {lines.length > 0 && (
          <div role={status === "error" ? "alert" : "status"} aria-live={status === "error" ? "assertive" : "polite"} className="flex flex-col gap-0.5 text-xs">
            {lines.map((l, i) => (
              <span key={i} className={l.ok ? "text-zinc-400" : "text-red-400"}>{l.text}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
