"use client";

import { useState } from "react";
import { Calendar, Check, Copy, Loader2, RefreshCw } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { withBasePath } from "@/lib/base-path";

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
        setError(data.error ?? "Couldn’t create a feed link — try again.");
        return;
      }
      setGenerated({ url: data.url, webcalUrl: data.webcalUrl, allUrl: data.allUrl ?? null });
      setActive(true);
      setSince(data.createdAt ?? null);
    } catch {
      setError("Couldn’t create a feed link — try again.");
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
        setError("Couldn’t turn off the feed — try again.");
        return;
      }
      setGenerated(null);
      setActive(false);
      setSince(null);
    } catch {
      setError("Couldn’t turn off the feed — try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-zinc-400">
        Subscribe in Google, Apple or Outlook calendar to see release dates for your
        requests and watchlist — theatrical, digital and physical releases for movies,
        and air dates for upcoming episodes. Anyone with the link can see these
        titles, so keep it private.
      </p>

      {generated && (
        <div className="space-y-3 rounded-md border border-[var(--ds-border)] bg-[var(--ds-bg-1)] p-3">
          <p className="text-xs text-amber-400">
            Copy this link now — it won’t be shown again. Generating a new one turns this one off.
          </p>
          <FeedUrl label="Your releases" url={generated.url} />
          {generated.allUrl && <FeedUrl label="All requests (request managers)" url={generated.allUrl} />}
          <div className="flex flex-wrap gap-2">
            <a
              href={generated.webcalUrl}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[var(--ds-border)] px-3 text-sm text-zinc-100 ds-hover-tint"
            >
              <Calendar className="w-4 h-4" />
              Open in calendar app
            </a>
          </div>
          <p className="text-xs text-zinc-500">
            Google Calendar: Other calendars → From URL → paste the link. Apple Calendar:
            File → New Calendar Subscription. Outlook: Add calendar → Subscribe from web.
            Calendar apps refresh on their own schedule, from every few minutes to about a day.
          </p>
        </div>
      )}

      {!generated && active && (
        <p className="text-sm text-zinc-300">
          A feed link is active{mounted && since ? ` (created ${new Date(since).toLocaleDateString()})` : ""}.
          {" "}Lost it? Generate a new one — the old link stops working.
        </p>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}

      {confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-zinc-300 w-full">
            {confirming === "regenerate"
              ? "Generate a new link? Calendars subscribed with the current link stop updating."
              : "Turn off the feed? Calendars subscribed with it stop updating."}
          </p>
          <Button
            type="button"
            variant={confirming === "revoke" ? "destructive" : "default"}
            onClick={confirming === "regenerate" ? generate : revoke}
            className="w-full sm:w-auto"
            autoFocus
          >
            {confirming === "regenerate" ? "Generate new link" : "Turn off feed"}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setConfirming(null)} className="w-full sm:w-auto">
            Cancel
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
            {active ? "Generate new link" : "Create feed link"}
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
              Turn off
            </Button>
          )}
        </div>
      )}
      {canSubscribeAll && !generated && (
        <p className="text-xs text-zinc-500">
          You manage requests, so a new link also comes with an all-requests feed.
        </p>
      )}
    </div>
  );
}

function FeedUrl({ label, url }: { label: string; url: string }) {
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
          aria-label={`${label} feed URL`}
          onFocus={(e) => e.currentTarget.select()}
          className="font-mono text-xs"
        />
        <Button
          type="button"
          variant="ghost"
          onClick={copy}
          aria-label={`Copy ${label} feed URL`}
          title="Copy link"
          className="h-9 w-9 shrink-0 p-0 text-zinc-400 hover:text-zinc-100"
        >
          {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
        </Button>
      </div>
    </div>
  );
}
