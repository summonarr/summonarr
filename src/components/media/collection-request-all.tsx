"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Check, Loader2 } from "@/components/icons";
import type { TmdbMedia } from "@/lib/tmdb-types";
import { DetailActionButton } from "./detail-action-button";
import { useT } from "@/components/i18n/i18n-provider";
import { useAsyncAction } from "@/hooks/use-async-action";
import {
  collectionRequestOutcome,
  missingFromCollection,
  postBulkChunk,
  requestInChunks,
  toBulkItem,
  type CollectionRequestOutcome,
} from "./collection-request";

// "Request All (N)" button for a TMDB collection. The items already carry
// availability flags from the server, so we work out which are missing here
// (collection-request.ts); the server checks again when the request arrives.
export function CollectionRequestAllButton({
  items,
  declinedKeys = [],
  canRequest,
}: {
  items: TmdbMedia[];
  // `${mediaType}:${id}` of the viewer's permanently declined titles
  // (permanentlyDeclinedKeys): the route skips them on every click.
  declinedKeys?: string[];
  canRequest: boolean;
}) {
  const router = useRouter();
  const t = useT();
  const action = useAsyncAction();
  const [result, setResult] = useState<CollectionRequestOutcome | null>(null);
  const missing = missingFromCollection(items, declinedKeys);

  // After a full success the refresh empties `missing`; the outcome stays on
  // screen (and in the live region) instead of vanishing with the button.
  if (!canRequest || (missing.length === 0 && result === null)) return null;

  async function requestAll() {
    setResult(null);
    const payload = missing.map(toBulkItem);
    const summary = await action.run(
      "request-all",
      (signal) => requestInChunks(payload, (chunk) => postBulkChunk(chunk, signal, t("request.somethingWrong"))),
      { ifBusy: "skip" },
    );
    if (!summary) return; // the page went away mid-run
    const outcome = collectionRequestOutcome(summary, t);
    setResult(outcome);
    if (outcome.refresh) router.refresh();
  }

  const state = action.busy("request-all") ? "loading" : (result?.state ?? "idle");
  const msg = result?.message ?? "";
  const showMsg = (state === "done" || state === "error") && !!msg;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* sm (32px): it sits in the collection heading row, not the action row. */}
      <DetailActionButton
        variant={state === "done" ? "accent-soft" : "primary"}
        size="sm"
        onClick={requestAll}
        disabled={state === "loading" || state === "done" || missing.length === 0}
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
