"use client";

import { useState } from "react";
import { Calendar, Check, Copy, Loader2, RefreshCw } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import { useAsyncAction } from "@/hooks/use-async-action";
import { withBasePath } from "@/lib/base-path";
import { fetchJson } from "@/lib/client/fetch-json";
import { v } from "@/lib/validate";
import { useLocale, useT } from "@/components/i18n/i18n-provider";

interface CalendarFeedProps {
  /** A feed token exists (its URL cannot be shown again — only its hash is stored). */
  enabled: boolean;
  createdAt: string | null;
  canSubscribeAll: boolean;
  /**
   * The calendar feature is switched off but a link is still stored: the card
   * offers only the revoke. The route keeps DELETE open for exactly this, so a
   * leaked link can be removed before the feature comes back on.
   */
  revokeOnly?: boolean;
}

interface Generated {
  url: string;
  webcalUrl: string;
  allUrl: string | null;
}

// POST /api/profile/calendar: the new feed's URLs, shown this once. A 2xx
// without them is a failure, never an empty field and a link to nowhere.
const CreatedAnswer = v.object({
  url: v.string(),
  webcalUrl: v.string(),
  allUrl: v.optional(v.nullable(v.string())),
  createdAt: v.optional(v.nullable(v.string())),
});

// Personal iCal feed controls. The subscribe URL is shown ONLY in the response
// that generates it: the server stores a hash, never the token, so a lost URL is
// replaced (which revokes the old one) rather than re-displayed.
export function CalendarFeed({ enabled, createdAt, canSubscribeAll, revokeOnly = false }: CalendarFeedProps) {
  const t = useT();
  const locale = useLocale();
  const mounted = useHasMounted();
  const [active, setActive] = useState(enabled);
  const [since, setSince] = useState<string | null>(createdAt);
  const [generated, setGenerated] = useState<Generated | null>(null);
  // "generate" or "revoke"; both buttons wait while either runs.
  const action = useAsyncAction();
  const [confirming, setConfirming] = useState<"regenerate" | "revoke" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setConfirming(null);
    setError(null);
    const res = await action.run(
      "generate",
      (signal) =>
        fetchJson(withBasePath("/api/profile/calendar"), {
          init: { method: "POST" },
          schema: CreatedAnswer,
          signal,
          fallbackError: t("profile.calendar.error.create"),
        }),
      { ifBusy: "skip" },
    );
    if (!res) return;
    if (!res.ok) {
      setError(res.error);
      return;
    }
    const data = res.data;
    setGenerated({ url: data.url, webcalUrl: data.webcalUrl, allUrl: data.allUrl ?? null });
    setActive(true);
    setSince(data.createdAt ?? null);
  }

  async function revoke() {
    setConfirming(null);
    setError(null);
    const res = await action.run(
      "revoke",
      (signal) => fetchJson(withBasePath("/api/profile/calendar"), { init: { method: "DELETE" }, signal }),
      { ifBusy: "skip" },
    );
    if (!res) return;
    // A 2xx is the feed turned off, whatever its body says.
    if (!res.ok && res.kind !== "invalid") {
      setError(t("profile.calendar.error.revoke"));
      return;
    }
    setGenerated(null);
    setActive(false);
    setSince(null);
  }

  const busy = action.anyBusy;

  return (
    <div className="space-y-3">
      <p className="text-sm text-zinc-400">
        {revokeOnly
          ? t(active ? "profile.calendar.featureOff" : "profile.calendar.featureOffRemoved")
          : t("profile.calendar.intro")}
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

      {!revokeOnly && !generated && active && (
        <p className="text-sm text-zinc-300">
          {mounted && since
            ? t("profile.calendar.activeSince", { date: new Date(since).toLocaleDateString(locale) })
            : t("profile.calendar.active")}
          {" "}{t("profile.calendar.lostIt")}
        </p>
      )}

      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}

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
          {!revokeOnly && (
            <Button
              type="button"
              disabled={busy}
              onClick={() => (active ? setConfirming("regenerate") : generate())}
              className="w-full sm:w-auto gap-1.5"
            >
              {action.busy("generate") ? <Loader2 className="w-4 h-4 animate-spin" /> : active ? <RefreshCw className="w-4 h-4" /> : <Calendar className="w-4 h-4" />}
              {active ? t("profile.calendar.generateNew") : t("profile.calendar.create")}
            </Button>
          )}
          {active && (
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => setConfirming("revoke")}
              className="w-full sm:w-auto"
            >
              {action.busy("revoke") ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : null}
              {t("profile.calendar.turnOff")}
            </Button>
          )}
        </div>
      )}
      {canSubscribeAll && !generated && !revokeOnly && (
        <p className="text-xs text-zinc-500">
          {t("profile.calendar.allFeedHint")}
        </p>
      )}
    </div>
  );
}

function FeedUrl({ label, url }: { label: string; url: string }) {
  const t = useT();
  // The URL is in the field beside the button for manual selection when the
  // clipboard is blocked.
  const { copied, failed, copy } = useCopyFeedback();
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
          onClick={() => void copy(url)}
          aria-label={t("profile.calendar.copyFeedUrl", { label })}
          title={t("profile.calendar.copyLink")}
          className="h-10 w-10 shrink-0 px-0 text-zinc-400 hover:text-zinc-100"
        >
          {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
        </Button>
      </div>
      {failed && <p role="alert" className="text-xs text-amber-400">{t("profile.common.copyFailed")}</p>}
    </div>
  );
}
