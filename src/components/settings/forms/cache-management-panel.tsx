"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Loader2, RefreshCw, RefreshCcw, Trash2, Database } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
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

type WarmResult = { fetched?: number; skipped?: number; total?: number; failed?: number; purged?: number; cleared?: number; error?: string };

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

function summarizeWarm(t: Translator, d: WarmResult): string {
  if (d.error) return d.error;
  const parts: string[] = [t("settings.form.cache.warm.fetched", { count: d.fetched ?? 0 }), t("settings.form.cache.warm.skipped", { count: d.skipped ?? 0 })];
  if ((d.purged ?? 0) > 0) parts.push(t("settings.form.cache.warm.purged", { count: d.purged ?? 0 }));
  if ((d.failed ?? 0) > 0) parts.push(t("settings.form.cache.warm.failed", { count: d.failed ?? 0 }));
  return parts.join(", ");
}

function CacheSourceRow({ source }: { source: CacheSourceDef }) {
  const t = useT();
  const [busy, setBusy] = useState<null | "clear" | "refetch">(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  // Kept in a ref so a new action cancels the previous action's timer (which
  // would otherwise wipe the newer result early) and unmount cancels it too.
  const msgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (msgTimer.current) clearTimeout(msgTimer.current); }, []);

  async function doClear() {
    setBusy("clear");
    setConfirmClear(false);
    if (msgTimer.current) clearTimeout(msgTimer.current);
    setMsg(null);
    try {
      const res = await fetch(withBasePath(`/api/admin/clear-cache?source=${source.id}`), { method: "DELETE" });
      const data: ClearResult = await res.json().catch(() => ({}));
      if (res.ok) setMsg({ kind: "ok", text: summarizeClear(t, data) });
      else setMsg({ kind: "err", text: data.error ?? t("settings.form.cache.clearFailed") });
    } catch {
      setMsg({ kind: "err", text: t("settings.form.common.requestFailed") });
    }
    setBusy(null);
    msgTimer.current = setTimeout(() => setMsg(null), 8000);
  }

  async function doRefetch() {
    setBusy("refetch");
    if (msgTimer.current) clearTimeout(msgTimer.current);
    setMsg(null);
    try {
      const res = await fetch(withBasePath(source.warmUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(source.warmBody ?? {}),
      });
      const data: WarmResult = await res.json().catch(() => ({}));
      if (res.ok && !data.error) setMsg({ kind: "ok", text: summarizeWarm(t, data) });
      else setMsg({ kind: "err", text: data.error ?? t("settings.form.cache.refetchFailed") });
    } catch {
      setMsg({ kind: "err", text: t("settings.form.common.requestFailed") });
    }
    setBusy(null);
    msgTimer.current = setTimeout(() => setMsg(null), 10000);
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
          <Button type="button" size="sm" onClick={doClear} className="bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)] h-8 px-3 text-xs">{t("settings.form.cache.clear")}</Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setConfirmClear(false)} className="border-zinc-600 text-zinc-400 hover:text-zinc-100 h-8 px-3 text-xs">{t("settings.form.common.cancel")}</Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setConfirmClear(true)}
            disabled={busy !== null}
            className="border-zinc-700 text-zinc-400 hover:text-zinc-100 gap-1.5 h-8 px-3 text-xs"
          >
            {busy === "clear" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            {t("settings.form.cache.clear")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={doRefetch}
            disabled={busy !== null}
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
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (resetTimer.current) clearTimeout(resetTimer.current); }, []);

  async function runAll() {
    if (resetTimer.current) clearTimeout(resetTimer.current);
    setStatus("running");
    setConfirmAll(false);
    setLines([]);
    const out: { text: string; ok: boolean }[] = [];
    let anyError = false;

    // Clear every source with one request, then refetch each source in turn.
    // Each refetch route has its own cooldown; if one answers 429 (too many
    // requests) it just shows as a failed line and the rest still run.
    try {
      const clearRes = await fetch(withBasePath("/api/admin/clear-cache?source=all"), { method: "DELETE" });
      const clearData: ClearResult = await clearRes.json().catch(() => ({}));
      if (clearRes.ok) out.push({ text: summarizeClear(t, clearData), ok: true });
      else { anyError = true; out.push({ text: t("settings.form.cache.clearFailedDetail", { detail: clearData.error ?? clearRes.status }), ok: false }); }
    } catch {
      anyError = true;
      out.push({ text: t("settings.form.cache.clearFailedRequest"), ok: false });
    }
    setLines([...out]);

    for (const source of CACHE_SOURCES) {
      try {
        const res = await fetch(withBasePath(source.warmUrl), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(source.warmBody ?? {}),
        });
        const data: WarmResult = await res.json().catch(() => ({}));
        if (res.ok && !data.error) out.push({ text: `${source.label}: ${summarizeWarm(t, data)}`, ok: true });
        else { anyError = true; out.push({ text: `${source.label}: ${data.error ?? t("settings.form.cache.refetchFailedLower")}`, ok: false }); }
      } catch {
        anyError = true;
        out.push({ text: `${source.label}: ${t("settings.form.cache.requestFailedLower")}`, ok: false });
      }
      setLines([...out]);
    }

    setStatus(anyError ? "error" : "done");
    resetTimer.current = setTimeout(() => { setStatus("idle"); setLines([]); }, 15000);
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
          <CacheSourceRow key={s.id} source={s} />
        ))}
      </div>

      <div className="pt-3 border-t border-zinc-800 space-y-2">
        {confirmAll ? (
          <div className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800/60 px-3 py-2.5 w-fit">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" aria-hidden />
            <p className="text-sm text-zinc-200">{t("settings.form.cache.confirmAll")}</p>
            <Button type="button" size="sm" onClick={runAll} className="bg-amber-600 text-black hover:bg-amber-600/90 h-8 px-3 text-xs">{t("settings.form.cache.run")}</Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setConfirmAll(false)} className="border-zinc-600 text-zinc-400 hover:text-zinc-100 h-8 px-3 text-xs">{t("settings.form.common.cancel")}</Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            onClick={() => setConfirmAll(true)}
            disabled={status === "running"}
            className="border-zinc-700 text-zinc-300 hover:text-zinc-100 gap-2"
          >
            {status === "running" ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCcw className="w-4 h-4" />}
            {status === "running" ? t("settings.form.cache.running") : t("settings.form.cache.all")}
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
