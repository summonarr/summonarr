"use client";

import { useT } from "@/components/i18n/i18n-provider";
import { VariantRequestButton } from "./variant-request-button";

// Secondary "Request on <instance>" action shown on movie/TV detail pages for
// each configured NAMED Radarr/Sonarr instance the viewer may request on
// (canRequestInstance). Posts the explicit arrInstance slug; the server
// re-validates the instance and the caller's grant. The default instance stays
// on RequestButton and 4K on Request4kButton — this covers named slugs only.
// The request flow is VariantRequestButton's, shared with Request4kButton.
export function RequestInstanceButton({
  tmdbId,
  mediaType,
  instance,
  instanceName,
  requestToken,
  requested,
  available,
  blacklisted,
}: {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  /** Named instance slug (never "" or "4k"). */
  instance: string;
  /** Display name from the instance registry. */
  instanceName: string;
  requestToken?: string;
  requested?: boolean;
  // The instance already has the file — show an "Available" state instead of a CTA.
  available?: boolean;
  // The title is admin-blacklisted — no request either (the request POST 403s).
  blacklisted?: boolean;
}) {
  const t = useT();
  return (
    <VariantRequestButton
      tmdbId={tmdbId}
      mediaType={mediaType}
      extras={{ arrInstance: instance }}
      labels={{
        request: t("request.requestOn", { instance: instanceName }),
        requested: t("request.requestedOn", { instance: instanceName }),
        available: t("request.availableOnInstance", { instance: instanceName }),
        requestedToast: t("request.requestedOn", { instance: instanceName }),
      }}
      requestToken={requestToken}
      requested={requested}
      available={available}
      blacklisted={blacklisted}
    />
  );
}
