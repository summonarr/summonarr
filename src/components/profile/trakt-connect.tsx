"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, ExternalLink, Link, Loader2, Unlink } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { withBasePath } from "@/lib/base-path";
import { formatRelativeTimeLocalized } from "@/lib/relative-time";
import { useLocale, useT } from "@/components/i18n/i18n-provider";

// The user's own Trakt connection (src/lib/trakt-user.ts, guardrail 34c).
// Connecting is a device-code flow: the server hands back a short code, the
// user enters it at trakt.tv/activate, and this component polls until Trakt
// answers. Each use is the user's own switch: watchlist auto-request (shown
// only while that feature is on and they may auto-request) and the For You
// history (shown only while For You is on).

export interface TraktConnectProps {
  connected: boolean;
  username: string | null;
  watchlistAutoRequest: boolean;
  historySeeds: boolean;
  status: "ok" | "error" | "reauth" | null;
  syncedAt: string | null;
  uses: { watchlist: boolean; history: boolean };
  // A Jellyfin user gets a line on why Trakt is their watchlist.
  isJellyfin: boolean;
}

interface DeviceCode {
  userCode: string;
  verificationUrl: string;
  interval: number;
}

export function TraktConnect(props: TraktConnectProps) {
  const t = useT();
  const locale = useLocale();
  const mounted = useHasMounted();
  const [connected, setConnected] = useState(props.connected);
  const [username, setUsername] = useState(props.username);
  const [status, setStatus] = useState(props.status);
  const [syncedAt, setSyncedAt] = useState(props.syncedAt);
  const [watchlist, setWatchlist] = useState(props.watchlistAutoRequest);
  const [history, setHistory] = useState(props.historySeeds);
  const [device, setDevice] = useState<DeviceCode | null>(null);
  const [busy, setBusy] = useState<"start" | "disconnect" | "toggle" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The poll loop's timer, so a cancel or an unmount stops it.
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
  }, []);

  function stopPolling() {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = null;
  }

  function schedulePoll(intervalSeconds: number) {
    stopPolling();
    pollTimer.current = setTimeout(() => void poll(intervalSeconds), Math.max(intervalSeconds, 2) * 1000);
  }

  async function poll(intervalSeconds: number) {
    try {
      const res = await fetch(withBasePath("/api/profile/trakt/device/poll"), { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Transient (Trakt unreachable, rate limited): keep waiting.
        if (res.status === 429 || res.status >= 500) {
          schedulePoll(intervalSeconds * 2);
          return;
        }
        setDevice(null);
        setError(data?.error ?? t("profile.trakt.error.connect"));
        return;
      }
      switch (data?.state) {
        case "pending":
          schedulePoll(intervalSeconds);
          return;
        case "connected":
          setDevice(null);
          setConnected(true);
          setUsername(typeof data.username === "string" ? data.username : null);
          setStatus(null);
          setSyncedAt(null);
          return;
        case "denied":
          setDevice(null);
          setError(t("profile.trakt.error.denied"));
          return;
        case "conflict":
          setDevice(null);
          setError(t("profile.trakt.error.conflict"));
          return;
        default:
          setDevice(null);
          setError(t("profile.trakt.error.expired"));
      }
    } catch {
      schedulePoll(intervalSeconds * 2);
    }
  }

  async function start() {
    setBusy("start");
    setError(null);
    try {
      const res = await fetch(withBasePath("/api/profile/trakt/device"), { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || typeof data?.userCode !== "string") {
        setError(data?.error ?? t("profile.trakt.error.connect"));
        return;
      }
      const interval = typeof data.interval === "number" && data.interval > 0 ? data.interval : 5;
      setDevice({ userCode: data.userCode, verificationUrl: data.verificationUrl, interval });
      schedulePoll(interval);
    } catch {
      setError(t("profile.error.network"));
    } finally {
      setBusy(null);
    }
  }

  function cancel() {
    stopPolling();
    setDevice(null);
  }

  async function copyCode() {
    if (!device) return;
    try {
      await navigator.clipboard.writeText(device.userCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  async function disconnect() {
    setBusy("disconnect");
    setConfirming(false);
    setError(null);
    try {
      const res = await fetch(withBasePath("/api/profile/trakt"), { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error ?? t("profile.trakt.error.disconnect"));
        return;
      }
      setConnected(false);
      setUsername(null);
      setStatus(null);
      setSyncedAt(null);
    } catch {
      setError(t("profile.error.network"));
    } finally {
      setBusy(null);
    }
  }

  // Saves on flip and rolls back if the save fails.
  async function toggle(field: "watchlistAutoRequest" | "historySeeds", next: boolean) {
    if (busy) return;
    const set = field === "watchlistAutoRequest" ? setWatchlist : setHistory;
    set(next);
    setBusy("toggle");
    setError(null);
    try {
      const res = await fetch(withBasePath("/api/profile/trakt"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        set(!next);
        setError(data?.error ?? t("profile.error.saveFailed"));
      }
    } catch {
      set(!next);
      setError(t("profile.error.network"));
    } finally {
      setBusy(null);
    }
  }

  let statusLine: string | null = null;
  if (connected) {
    if (status === "error") statusLine = t("profile.trakt.status.error");
    else if (status === "ok" && syncedAt && mounted) statusLine = t("profile.trakt.status.synced", { when: formatRelativeTimeLocalized(syncedAt, locale) });
    else if (status === null) statusLine = t("profile.trakt.status.pending");
  }

  return (
    <div className="space-y-3">
      {!connected && status === "reauth" && !device && (
        <p role="alert" className="text-sm text-amber-400">{t("profile.trakt.reauth")}</p>
      )}

      {connected ? (
        <>
          <p className="text-sm text-zinc-300">
            {username ? t("profile.trakt.connectedAs", { username }) : t("profile.trakt.connected")}
          </p>
          {statusLine && <p className="text-xs text-zinc-500">{statusLine}</p>}
          {props.uses.watchlist && (
            <div className="flex items-start justify-between gap-4 py-2">
              <div>
                <p className="text-sm font-medium text-zinc-200">{t("profile.trakt.watchlistLabel")}</p>
                <p className="text-xs text-zinc-500 mt-0.5">{t("profile.trakt.watchlistHint")}</p>
              </div>
              <Switch
                checked={watchlist}
                disabled={busy !== null}
                onCheckedChange={(v) => void toggle("watchlistAutoRequest", v)}
                aria-label={t("profile.trakt.watchlistLabel")}
              />
            </div>
          )}
          {props.uses.history && (
            <div className="flex items-start justify-between gap-4 py-2">
              <div>
                <p className="text-sm font-medium text-zinc-200">{t("profile.trakt.historyLabel")}</p>
                <p className="text-xs text-zinc-500 mt-0.5">{t("profile.trakt.historyHint")}</p>
              </div>
              <Switch
                checked={history}
                disabled={busy !== null}
                onCheckedChange={(v) => void toggle("historySeeds", v)}
                aria-label={t("profile.trakt.historyLabel")}
              />
            </div>
          )}
          {confirming ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm text-zinc-300 w-full">{t("profile.trakt.confirmDisconnect")}</p>
              <Button type="button" variant="destructive" onClick={disconnect} className="w-full sm:w-auto" autoFocus>
                {t("profile.trakt.disconnect")}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setConfirming(false)} className="w-full sm:w-auto">
                {t("profile.common.cancel")}
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => setConfirming(true)}
              className="w-full sm:w-auto gap-1.5"
            >
              {busy === "disconnect" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Unlink className="w-4 h-4" />}
              {t("profile.trakt.disconnect")}
            </Button>
          )}
        </>
      ) : device ? (
        <div className="space-y-3 rounded-md border border-[var(--ds-border)] bg-[var(--ds-bg-1)] p-3">
          <p className="text-sm text-zinc-300">{t("profile.trakt.enterCode")}</p>
          <div className="flex flex-wrap items-center gap-2">
            <span className="ds-mono text-2xl font-semibold tracking-widest text-zinc-100" aria-label={t("profile.trakt.codeLabel")}>
              {device.userCode}
            </span>
            <Button type="button" variant="ghost" onClick={copyCode} aria-label={t("profile.trakt.copyCode")} title={t("profile.trakt.copyCode")}>
              {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <a
              href={device.verificationUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[var(--ds-border)] px-3 text-sm text-zinc-100 ds-hover-tint"
            >
              <ExternalLink className="w-4 h-4" />
              {t("profile.trakt.openActivate")}
            </a>
            <Button type="button" variant="ghost" onClick={cancel}>
              {t("profile.common.cancel")}
            </Button>
          </div>
          <p className="flex items-center gap-1.5 text-xs text-zinc-500" role="status" aria-live="polite">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            {t("profile.trakt.waiting")}
          </p>
        </div>
      ) : (
        <>
          <p className="text-sm text-zinc-400">
            {props.uses.watchlist && props.uses.history
              ? t("profile.trakt.introBoth")
              : props.uses.watchlist
                ? t("profile.trakt.introWatchlist")
                : t("profile.trakt.introHistory")}
          </p>
          {props.isJellyfin && props.uses.watchlist && (
            <p className="text-xs text-zinc-500">{t("profile.trakt.jellyfinHint")}</p>
          )}
          <Button type="button" disabled={busy !== null} onClick={start} className="w-full sm:w-auto gap-1.5">
            {busy === "start" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link className="w-4 h-4" />}
            {t("profile.trakt.connect")}
          </Button>
        </>
      )}

      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
