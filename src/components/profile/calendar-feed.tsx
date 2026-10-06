"use client";

import { useState } from "react";
import { Calendar, Check, Copy, Loader2, RefreshCw } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { withBasePath } from "@/lib/base-path";
import { useLocale, useT } from "@/components/i18n/i18n-provider";

interface CalendarFeedProps {
  /** A feed token exists (its URL cannot be shown again — only its hash is stored). */
  enabled: boolean;
  createdAt: string | null;
  canSubscribeAll: boolean;
}

interface Generated {
  url: string;
  webcalUrl: string;
  allUrl: string | null;
}

// Personal iCal feed controls. The subscribe URL is shown ONLY in the response
// that generates it: the server stores a hash, never the token, so a lost URL is
// replaced (which revokes the old one) rather than re-displayed.
export function CalendarFeed({ enabled, createdAt, canSubscribeAll }: CalendarFeedProps) {
  const t = useT();
  const locale = useLocale();
  const mounted = useHasMounted();
  const [active, setActive] = useState(enabled);
  const [since, setSince] = useState<string | null>(createdAt);
  const [generated, setGenerated] = useState<Generated | null>(null);
  const [busy, setBusy] = useState<"generate" | "revoke" | null>(null);
  const [confirming, setConfirming] = useState<"regenerate" | "revoke" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setBusy("generate");
    setConfirming(null);
    setError(null);
    try {
      const res = await fetch(withBasePath("/api/profile/calendar"), { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? t("profile.calendar.error.create"));
        return;
      }
      setGenerated({ url: data.url, webcalUrl: data.webcalUrl, allUrl: data.allUrl ?? null });
      setActive(true);
      setSince(data.createdAt ?? null);
    } catch {
      setError(t("profile.calendar.error.create"));
    } finally {
      setBusy(null);
    }
  }

  async function revoke() {
    setBusy("revoke");
    setConfirming(null);
    setError(null);
    try {
      const res = await fetch(withBasePath("/api/profile/calendar"), { method: "DELETE" });
      if (!res.ok) {
        setError(t("profile.calendar.error.revoke"));
        return;
      }
      setGenerated(null);
      setActive(false);
      setSince(null);
    } catch {
      setError(t("profile.calendar.error.revoke"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-zinc-400">
        {t("profile.calendar.intro")}
      </p>

      {generated && (
        <div className="space-y-3 rounded-md border border-[var(--ds-border)] bg-[var(--ds-bg-1)] p-3">
          <p className="text-xs text-amber-400">
            {t("profile.calendar.copyNow")}
          </p>
          <FeedUrl label={t("profile.calendar.yourReleases")} url={generated.url} />
          {generated.allUrl && <FeedUrl label={t("profile.calendar.allRequests")} url={generated.allUrl} />}
          <div className="flex flex-wrap gap-2">
            <a
              href={generated.webcalUrl}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[var(--ds-border)] px-3 text-sm text-zinc-100 ds-hover-tint"
            >
              <Calendar className="w-4 h-4" />
              {t("profile.calendar.openApp")}
            </a>
          </div>
          <p className="text-xs text-zinc-500">
            {t("profile.calendar.howTo")}
          </p>
        </div>
      )}

      {!generated && active && (
        <p className="text-sm text-zinc-300">
          {mounted && since
            ? t("profile.calendar.activeSince", { date: new Date(since).toLocaleDateString(locale) })
            : t("profile.calendar.active")}
          {" "}{t("profile.calendar.lostIt")}
        </p>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}

      {confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-zinc-300 w-full">
            {confirming === "regenerate"
              ? t("profile.calendar.confirmRegenerate")
              : t("profile.calendar.confirmRevoke")}
          </p>
          <Button
            type="button"
            variant={confirming === "revoke" ? "destructive" : "default"}
            onClick={confirming === "regenerate" ? generate : revoke}
            className="w-full sm:w-auto"
            autoFocus
          >
            {confirming === "regenerate" ? t("profile.calendar.generateNew") : t("profile.calendar.turnOffFeed")}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setConfirming(null)} className="w-full sm:w-auto">
            {t("profile.common.cancel")}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            disabled={busy !== null}
            onClick={() => (active ? setConfirming("regenerate") : generate())}
            className="w-full sm:w-auto gap-1.5"
          >
            {busy === "generate" ? <Loader2 className="w-4 h-4 animate-spin" /> : active ? <RefreshCw className="w-4 h-4" /> : <Calendar className="w-4 h-4" />}
            {active ? t("profile.calendar.generateNew") : t("profile.calendar.create")}
          </Button>
          {active && (
            <Button
              type="button"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => setConfirming("revoke")}
              className="w-full sm:w-auto"
            >
              {busy === "revoke" ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : null}
              {t("profile.calendar.turnOff")}
            </Button>
          )}
        </div>
      )}
      {canSubscribeAll && !generated && (
        <p className="text-xs text-zinc-500">
          {t("profile.calendar.allFeedHint")}
        </p>
      )}
    </div>
  );
}

function FeedUrl({ label, url }: { label: string; url: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-zinc-400">{label}</p>
      <div className="flex gap-2">
        <Input
          readOnly
          value={url}
          aria-label={t("profile.calendar.feedUrlLabel", { label })}
          onFocus={(e) => e.currentTarget.select()}
          className="ds-mono md:text-xs"
        />
        <Button
          type="button"
          variant="ghost"
          onClick={copy}
          aria-label={t("profile.calendar.copyFeedUrl", { label })}
          title={t("profile.calendar.copyLink")}
          className="h-10 w-10 shrink-0 p-0 text-zinc-400 hover:text-zinc-100"
        >
          {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
        </Button>
      </div>
    </div>
  );
}
