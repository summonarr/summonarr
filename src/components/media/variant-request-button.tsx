"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Check, Loader2, Ban } from "@/components/icons";
import { postMediaRequest } from "@/lib/client/media-request";
import { rateLimitMessage } from "@/lib/client/rate-limit";
import { useToast } from "@/components/ui/toast";
import { useT } from "@/components/i18n/i18n-provider";
import { DetailActionButton, DetailActionStatus } from "./detail-action-button";

// The shared body of the detail page's secondary request actions — "Request in
// 4K" (Request4kButton) and "Request on <instance>" (RequestInstanceButton).
// The two differ only in what they add to the POST and in their wording, so the
// request flow lives here once. Kept apart from RequestButton so the default
// instance's request state never entangles with these.
export interface VariantRequestLabels {
  // The CTA.
  request: string;
  // The status once this viewer's request exists.
  requested: string;
  // The status once the target already holds the title.
  available: string;
  // The toast after a request is created.
  requestedToast: string;
}

export function VariantRequestButton({
  tmdbId,
  mediaType,
  extras,
  labels,
  requestToken,
  requested,
  available,
  blacklisted,
}: {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  // Added to the POST body: `{ is4k: true }` or `{ arrInstance: slug }`.
  extras: Record<string, unknown>;
  labels: VariantRequestLabels;
  requestToken?: string;
  requested?: boolean;
  // The target already has the file — show an "Available" state instead of a CTA.
  available?: boolean;
  // The title is admin-blacklisted — no request either (the request POST 403s).
  blacklisted?: boolean;
}) {
  const { toast } = useToast();
  const t = useT();
  const router = useRouter();
  const [state, setState] = useState<"idle" | "loading" | "requested" | "error">(
    requested ? "requested" : "idle",
  );
  const [msg, setMsg] = useState("");
  // The route answers 200 { alreadyAvailable: true } and creates NOTHING when
  // the target's available cache already holds the title (auto-approvers
  // only) — reading that as "requested" showed a Requested state for a request
  // that does not exist.
  const [foundAvailable, setFoundAvailable] = useState(false);
  // Client nav reuses this instance across titles; `requested` is live so a
  // refresh after a request on this title flips the status without a remount.
  const [seenTmdbId, setSeenTmdbId] = useState(tmdbId);
  const titleChanged = seenTmdbId !== tmdbId;
  if (titleChanged) {
    setSeenTmdbId(tmdbId);
    setState(requested ? "requested" : "idle");
    setMsg("");
    setFoundAvailable(false);
  }

  async function submit() {
    setState("loading");
    setMsg("");
    try {
      // Refreshes the page-minted token once if it expired while the tab sat
      // open (postMediaRequest).
      const res = await postMediaRequest({ tmdbId, mediaType, ...extras }, requestToken);
      if (res.status === 409) {
        setState("requested");
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        // A 429 says when to retry (Retry-After), as RequestButton's does.
        setMsg(rateLimitMessage(res, t) ?? data.error ?? t("request.somethingWrong"));
        setState("error");
        return;
      }
      const body = (await res.json().catch(() => null)) as { alreadyAvailable?: boolean } | null;
      if (body?.alreadyAvailable) {
        setFoundAvailable(true);
        setState("idle");
        router.refresh();
        return;
      }
      setState("requested");
      toast({ title: labels.requestedToast, variant: "success" });
      router.refresh();
    } catch {
      setMsg(t("request.networkError"));
      setState("error");
    }
  }

  // Availability wins over request state — once the copy is fetched there's nothing to request.
  if (available || (!titleChanged && foundAvailable)) {
    return (
      <DetailActionStatus variant="accent-soft">
        <Check style={{ width: 14, height: 14 }} />
        {labels.available}
      </DetailActionStatus>
    );
  }

  if ((titleChanged ? !!requested : state === "requested" || requested)) {
    return (
      <DetailActionStatus variant="accent-soft">
        <Check style={{ width: 14, height: 14 }} />
        {labels.requested}
      </DetailActionStatus>
    );
  }

  // A copy queued by someone else does NOT block the CTA: the server mirrors
  // the approved request so this user gets the availability notification. The
  // queue state is communicated by the badges row.

  // Blacklisted blocks all requests (per tmdbId+mediaType, every instance).
  if (blacklisted) {
    return (
      <DetailActionStatus variant="muted">
        <Ban style={{ width: 14, height: 14 }} />
        {t("request.notAvailableToRequest")}
      </DetailActionStatus>
    );
  }

  // flex-col: the error renders UNDER the button (as RequestButton's does), never
  // squeezed beside a 34px control in the wrapping action row.
  return (
    <div className="flex flex-col items-start gap-2">
      <DetailActionButton
        variant="secondary"
        onClick={submit}
        disabled={!titleChanged && state === "loading"}
        busy={!titleChanged && state === "loading"}
      >
        {!titleChanged && state === "loading" ? (
          <Loader2 className="animate-spin" style={{ width: 14, height: 14 }} />
        ) : (
          <Plus style={{ width: 14, height: 14 }} />
        )}
        {labels.request}
      </DetailActionButton>
      {!titleChanged && state === "error" && msg && (
        <p
          className="ds-mono max-w-sm"
          role="alert"
          style={{ fontSize: 11, color: "var(--ds-danger)", margin: 0 }}
        >
          {msg}
        </p>
      )}
    </div>
  );
}
