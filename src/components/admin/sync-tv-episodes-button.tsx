"use client";

import { useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Tv2 } from "lucide-react";

interface SyncResult {
  plex?: number;
  jellyfin?: number;
  errors?: string[];
}

export function SyncTVEpisodesButton() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [result, setResult] = useState<string | null>(null);

  async function handleSync() {
    setStatus("loading");
    setResult(null);
    try {
      const res = await fetch("/api/sync/tv-episodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = (await res.json()) as SyncResult & { error?: string };

      if (data.error) {
        setStatus("error");
        setResult(data.error);
      } else if (data.errors && data.errors.length > 0) {
        setStatus("error");
        setResult(data.errors.join("; "));
      } else {
        const total = (data.plex ?? 0) + (data.jellyfin ?? 0);
        const parts: string[] = [];
        if ((data.plex ?? 0) > 0) parts.push(`Plex ${data.plex}`);
        if ((data.jellyfin ?? 0) > 0) parts.push(`Jellyfin ${data.jellyfin}`);
        setStatus("done");
        setResult(parts.length > 0 ? `${total.toLocaleString()} episodes (${parts.join(", ")})` : "0 episodes");
        const search = searchParams.toString();
        router.push(pathname + (search ? `?${search}` : ""));
      }
    } catch {
      setStatus("error");
      setResult("Sync failed");
    }
    setTimeout(() => { setStatus("idle"); setResult(null); }, 10_000);
  }

  return (
    <div className="flex items-center gap-3">
      <Button
        variant="outline"
        size="sm"
        onClick={handleSync}
        disabled={status === "loading"}
        className="border-zinc-700 text-zinc-300 hover:text-white gap-2"
      >
        <Tv2 className={`w-4 h-4 ${status === "loading" ? "animate-pulse" : ""}`} />
        {status === "loading" ? "Syncing Episodes…" : "Sync TV Episodes"}
      </Button>
      {result && (
        <span className={`text-xs ${status === "error" ? "text-red-400" : "text-zinc-400"}`}>
          {result}
        </span>
      )}
    </div>
  );
}
