"use client";

import { useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { RefreshCw, XCircle } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";

export function ResyncLibraryButton({
  plexConfigured,
  jellyfinConfigured,
}: {
  plexConfigured: boolean;
  jellyfinConfigured: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<"idle" | "confirm" | "loading" | "done" | "error">("idle");
  const [result, setResult] = useState<string | null>(null);

  async function handleResync() {
    setStatus("loading");
    setResult(null);
    try {
      // Call only the servers that exist. This used to POST to both
      // unconditionally and then fold the two answers into one `??` chain, so
      // the FIRST error won — and on a single-server deployment that error was
      // always the other server's `400 {"error":"… not configured"}`. The
      // configured server had just rewritten its whole library and the admin
      // was shown a red failure naming a server they do not run, with no counts
      // and no refresh.
      //
      // The booleans come from the page rather than from probing, so an absent
      // server costs no request at all. They describe the DEFAULT instance,
      // which is exactly right here: this button sends no `instance` slug, so
      // the default is all it ever syncs (guardrail 35).
      const targets = [
        ...(plexConfigured ? [{ name: "Plex", path: "/api/sync/plex" }] : []),
        ...(jellyfinConfigured ? [{ name: "Jellyfin", path: "/api/sync/jellyfin" }] : []),
      ];

      if (targets.length === 0) {
        // Not an error — nothing is misconfigured, there is simply nothing to
        // re-scan. Neutral styling says that; red would not.
        setStatus("done");
        setResult("No media servers configured");
        setTimeout(() => { setStatus("idle"); setResult(null); }, 10_000);
        return;
      }

      const outcomes = await Promise.all(
        targets.map(async ({ name, path }) => {
          try {
            const res = await fetch(withBasePath(path), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ full: true }),
            });
            const data = (await res.json().catch(() => null)) as
              | { scanned?: { movies: number; tv: number }; error?: string }
              | null;
            if (!res.ok || data?.error) {
              return { name, ok: false, text: `${name} ${data?.error ?? `failed (${res.status})`}` };
            }
            const count = (data?.scanned?.movies ?? 0) + (data?.scanned?.tv ?? 0);
            return { name, ok: true, text: `${name} ${count.toLocaleString("en-US")} items` };
          } catch {
            return { name, ok: false, text: `${name} network error` };
          }
        }),
      );

      const succeeded = outcomes.filter((o) => o.ok);
      // Red whenever a CONFIGURED server failed — that is a real fault and the
      // whole point of the distinction. But still refresh if any server did
      // sync: those rows are what the admin clicked for, and withholding the
      // refresh left the page showing pre-sync counts.
      setStatus(succeeded.length === outcomes.length ? "done" : "error");
      setResult(outcomes.map((o) => o.text).join(" · "));
      if (succeeded.length > 0) {
        const search = searchParams.toString();
        router.push(pathname + (search ? `?${search}` : ""));
      }
    } catch {
      setStatus("error");
      setResult("Sync failed");
    }
    setTimeout(() => { setStatus("idle"); setResult(null); }, 10_000);
  }

  if (status === "confirm") {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800/60 px-3 py-2 w-fit">
        <XCircle className="w-4 h-4 text-amber-400 shrink-0" />
        <p className="text-sm text-zinc-200">Re-scan all libraries?</p>
        <Button
          size="sm"
          onClick={handleResync}
          className="bg-amber-600 hover:bg-amber-500 h-7 px-3 text-xs"
        >
          Re-sync
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setStatus("idle")}
          className="border-zinc-600 text-zinc-400 hover:text-white h-7 px-3 text-xs"
        >
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setStatus("confirm")}
        disabled={status === "loading"}
        className="border-zinc-700 text-zinc-300 hover:text-white gap-2"
      >
        <RefreshCw className={`w-4 h-4 ${status === "loading" ? "animate-spin" : ""}`} />
        {status === "loading" ? "Syncing…" : "Re-sync Libraries"}
      </Button>
      {result && (
        <span className={`text-xs ${status === "error" ? "text-red-400" : "text-zinc-400"}`}>
          {result}
        </span>
      )}
    </div>
  );
}
