"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Check, Loader2 } from "@/components/icons";
import type { TmdbMedia } from "@/lib/tmdb-types";
import { withBasePath } from "@/lib/base-path";
import { DetailActionButton } from "./detail-action-button";

// Must match MAX_ITEMS in src/app/api/requests/bulk/route.ts. The route rejects
// a larger batch outright (400 "Too many items"), so we send the list in
// chunks of this size, one after another. The route's limit of 10 calls per
// minute per user still allows 500 items per click — far more than any
// TMDB collection has.
const BULK_MAX_ITEMS = 50;

// "Request All (N)" button for a TMDB collection. The items already carry
// availability flags from the server, so we work out which are missing here;
// the server checks again when the request arrives.
export function CollectionRequestAllButton({
  items,
  canRequest = true,
}: {
  items: TmdbMedia[];
  canRequest?: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");

  // Skip titles already in the library, ones THIS user already requested, and
  // blacklisted ones. Titles other users requested are included on purpose:
  // the bulk route copies their status, so this user also gets the "now
  // available" notification.
  const missing = items.filter(
    (m) => !m.plexAvailable && !m.jellyfinAvailable && !m.requestedByMe && !m.blacklisted,
  );

  if (!canRequest || missing.length === 0) return null;

  async function requestAll() {
    setState("loading");
    setMsg("");
    const payload = missing.map((m) => ({
      tmdbId: m.id,
      mediaType: m.mediaType === "movie" ? "MOVIE" : "TV",
    }));
    let created = 0;
    let sent = 0;
    // A partial failure (chunk k of n rejected) still refreshes: the rows the
    // earlier chunks created are what the click was for.
    const fail = (reason: string) => {
      setMsg(sent > 0 ? `Requested ${created} of ${missing.length} — ${reason}` : reason);
      setState("error");
      if (sent > 0) router.refresh();
    };
    try {
      for (let i = 0; i < payload.length; i += BULK_MAX_ITEMS) {
        const chunk = payload.slice(i, i + BULK_MAX_ITEMS);
        const res = await fetch(withBasePath("/api/requests/bulk"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: chunk }),
        });
        const data: { created?: number; error?: string } = await res.json().catch(() => ({}));
        if (!res.ok) {
          fail(data.error ?? "Something went wrong");
          return;
        }
        created += data.created ?? 0;
        sent += chunk.length;
      }
      setMsg(`Requested ${created} of ${missing.length}`);
      setState("done");
      router.refresh();
    } catch {
      fail(sent > 0 ? "network error, please try again" : "Network error — please try again");
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* sm (32px): it sits in the collection heading row, not the action row. */}
      <DetailActionButton
        variant={state === "done" ? "accent-soft" : "primary"}
        size="sm"
        onClick={requestAll}
        disabled={state === "loading" || state === "done"}
        busy={state === "loading"}
      >
        {state === "loading" ? (
          <Loader2 className="animate-spin" style={{ width: 14, height: 14 }} />
        ) : state === "done" ? (
          <Check style={{ width: 14, height: 14 }} />
        ) : (
          <Plus style={{ width: 14, height: 14 }} />
        )}
        {state === "done" ? "Requested" : `Request All (${missing.length})`}
      </DetailActionButton>
      {(state === "done" || state === "error") && msg && (
        <span
          className="ds-mono"
          style={{ fontSize: 11, color: state === "error" ? "var(--ds-danger)" : "var(--ds-fg-subtle)" }}
        >
          {msg}
        </span>
      )}
    </div>
  );
}
