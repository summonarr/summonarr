"use client";

import { useT } from "@/components/i18n/i18n-provider";
import { VariantRequestButton } from "./variant-request-button";

// Secondary "Request in 4K" action shown on movie/TV detail pages when a 4K
// Radarr/Sonarr instance is configured and the viewer holds REQUEST_4K. Posts to
// the single request route with is4k:true (the API keeps that shorthand,
// guardrail 32); the server re-checks permission + that a 4K instance exists.
// The request flow is VariantRequestButton's, shared with RequestInstanceButton.
export function Request4kButton({
  tmdbId,
  mediaType,
  requestToken,
  requested,
  available,
  blacklisted,
  permanentlyDeclined,
}: {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  requestToken?: string;
  requested?: boolean;
  // The 4K instance already has the file — show an "Available in 4K" state instead of a CTA.
  available?: boolean;
  // The title is admin-blacklisted — no 4K request either (the request POST 403s).
  blacklisted?: boolean;
  // The viewer's request here was permanently declined (the POST 403s every time).
  permanentlyDeclined?: boolean;
}) {
  const t = useT();
  return (
    <VariantRequestButton
      tmdbId={tmdbId}
      mediaType={mediaType}
      extras={{ is4k: true }}
      labels={{
        request: t("request.requestIn4k"),
        requested: t("request.requested4k"),
        available: t("request.availableIn4k"),
        requestedToast: t("request.requested4kToast"),
      }}
      requestToken={requestToken}
      requested={requested}
      available={available}
      blacklisted={blacklisted}
      permanentlyDeclined={permanentlyDeclined}
    />
  );
}
