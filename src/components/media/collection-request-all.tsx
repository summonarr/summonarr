"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Check, Loader2 } from "@/components/icons";
import type { TmdbMedia } from "@/lib/tmdb-types";
import { withBasePath } from "@/lib/base-path";
import { DetailActionButton } from "./detail-action-button";
import { useT } from "@/components/i18n/i18n-provider";
import { BULK_REQUEST_MAX_ITEMS } from "@/lib/request-limits";

// The bulk route rejects a batch larger than BULK_REQUEST_MAX_ITEMS outright
// (400 "Too many items"), so the list goes in chunks of that size, one after
// another. The route's limit of 10 calls per minute per user still allows 500
// items per click — far more than any TMDB collection has.

// Bulk outcomes (bulk/route.ts ItemResult) for a title this user can't request.
// They are counted in the result line; the already-* outcomes are not failures
// (there was nothing to do), and created/auto-approved are the `created` count.
const UNREQUESTABLE = new Set(["skipped-declined", "no-permission", "blacklisted", "rating-blocked"]);

// "Request All (N)" button for a TMDB collection. The items already carry
// availability flags from the server, so we work out which are missing here;
// the server checks again when the request arrives.
export function CollectionRequestAllButton({
  items,
  declinedKeys = [],
  canRequest = true,
}: {
  items: TmdbMedia[];
  // `${mediaType}:${id}` of the viewer's permanently declined titles
  // (permanentlyDeclinedKeys): the route skips them on every click.
  declinedKeys?: string[];
  canRequest?: boolean;
}) {
  const router = useRouter();
  const t = useT();
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");

  // Skip titles already in the library, ones THIS user already requested,
  // blacklisted ones and ones permanently declined for this user. Titles other
  // users requested are included on purpose: the bulk route copies their
  // status, so this user also gets the "now available" notification.
  const declined = new Set(declinedKeys);
  const missing = items.filter(
    (m) =>
      !m.plexAvailable &&
      !m.jellyfinAvailable &&
      !m.requestedByMe &&
      !m.blacklisted &&
      !declined.has(`${m.mediaType}:${m.id}`),
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
    let unrequestable = 0;
    // A partial failure (chunk k of n rejected) still refreshes: the rows the
    // earlier chunks created are what the click was for.
    const fail = (reason: string) => {
      setMsg(sent > 0 ? t("request.collection.partial", { created, total: missing.length, reason }) : reason);
      setState("error");
      if (sent > 0) router.refresh();
    };
    try {
      for (let i = 0; i < payload.length; i += BULK_REQUEST_MAX_ITEMS) {
        const chunk = payload.slice(i, i + BULK_REQUEST_MAX_ITEMS);
        const res = await fetch(withBasePath("/api/requests/bulk"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: chunk }),
        });
        const data: { created?: number; error?: string; results?: { result?: string }[] } =
          await res.json().catch(() => ({}));
        if (!res.ok) {
          fail(data.error ?? t("request.somethingWrong"));
          return;
        }
        created += data.created ?? 0;
        sent += chunk.length;
        for (const r of data.results ?? []) {
          if (r.result !== undefined && UNREQUESTABLE.has(r.result)) unrequestable++;
        }
      }
      // Say why fewer than all were requested, rather than a bare "2 of 5".
      setMsg(
        unrequestable > 0
          ? t("request.collection.doneSkipped", { created, total: missing.length, skipped: unrequestable })
          : t("request.collection.done", { created, total: missing.length }),
      );
      setState("done");
      router.refresh();
    } catch {
      fail(sent > 0 ? t("request.collection.networkErrorLower") : t("request.networkError"));
    }
  }

  const showMsg = (state === "done" || state === "error") && !!msg;

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
        {state === "done" ? t("request.collection.requested") : t("request.collection.requestAll", { count: missing.length })}
      </DetailActionButton>
      {/* The live region is always mounted (visually hidden, out of the flex
          flow), so it exists before the outcome lands and screen readers
          announce it. The visible line below is the same text. */}
      <span className="sr-only" role="status">
        {showMsg ? msg : ""}
      </span>
      {showMsg && (
        <span
          aria-hidden="true"
          className="ds-mono"
          style={{ fontSize: 11, color: state === "error" ? "var(--ds-danger)" : "var(--ds-fg-subtle)" }}
        >
          {msg}
        </span>
      )}
    </div>
  );
}
