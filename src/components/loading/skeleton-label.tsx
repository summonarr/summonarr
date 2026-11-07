"use client";

import { useT } from "@/components/i18n/i18n-provider";

// The screen-reader text inside SkeletonRoot. A client component only so it
// can translate: the skeletons render in server and client trees alike, and
// "shared" is an area every client is sent (guardrail 40b).
export function SkeletonLoadingLabel() {
  const t = useT();
  return <span className="sr-only">{t("shared.common.loading")}</span>;
}
