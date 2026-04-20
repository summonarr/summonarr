"use client";

import { useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { RefreshCw, XCircle } from "lucide-react";

export function ResyncLibraryButton() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<"idle" | "confirm" | "loading" | "done" | "error">("idle");
  const [result, setResult] = useState<string | null>(null);

  async function handleResync() {
    setStatus("loading");
    setResult(null);
    try {
      const [plexRes, jellyfinRes] = await Promise.all([
        fetch("/api/sync/plex", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ full: true }) }),
        fetch("/api/sync/jellyfin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ full: true }) }),
      ]);

      const plexData   = await plexRes.json()   as { scanned?: { movies: number; tv: number }; error?: string };
      const jellyData  = await jellyfinRes.json() as { scanned?: { movies: number; tv: number }; error?: string };

      const err = plexData.error ?? jellyData.error;
      if (err) {
        setStatus("error");
        setResult(err);
      } else {
        const plexCount   = (plexData.scanned?.movies  ?? 0) + (plexData.scanned?.tv  ?? 0);
        const jellyCount  = (jellyData.scanned?.movies ?? 0) + (jellyData.scanned?.tv ?? 0);
        setStatus("done");
        setResult(`Plex ${plexCount}, Jellyfin ${jellyCount} items`);
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
