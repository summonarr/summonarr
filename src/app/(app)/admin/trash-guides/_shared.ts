import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import type { ArrVariant } from "@/lib/arr";
import type { TrashService } from "@/components/admin/trash-guides/types";

const SETTING_KEYS = [
  "radarrUrl",
  "radarrApiKey",
  "sonarrUrl",
  "sonarrApiKey",
  "radarr4kUrl",
  "radarr4kApiKey",
  "sonarr4kUrl",
  "sonarr4kApiKey",
] as const;

export type TrashPageSearchParams = Promise<{ service?: string; variant?: string }>;

export interface TrashPageContext {
  service: TrashService;
  // Which instance the page targets. "4k" only survives when the selected service has a 4K
  // instance configured (see fallback below).
  variant: ArrVariant;
  is4k: boolean;
  radarrConfigured: boolean;
  sonarrConfigured: boolean;
  radarr4kConfigured: boolean;
  sonarr4kConfigured: boolean;
  // True when the currently selected (service, variant) pair has its URL + API key set in Settings.
  serviceConfigured: boolean;
}

// Shared auth + service/variant-resolution for every TRaSH sub-page. The layout already enforces
// ADMIN, but each page is its own server component and Next won't run the layout's redirect inside
// it, so we re-check here as a defense-in-depth measure.
export async function loadTrashPageContext(
  searchParams: TrashPageSearchParams,
): Promise<TrashPageContext> {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") redirect("/");

  const { service: rawService, variant: rawVariant } = await searchParams;
  const service: TrashService = rawService === "sonarr" ? "SONARR" : "RADARR";

  const rows = await prisma.setting.findMany({
    where: { key: { in: [...SETTING_KEYS] } },
  });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  const radarrConfigured = !!(map.radarrUrl && map.radarrApiKey);
  const sonarrConfigured = !!(map.sonarrUrl && map.sonarrApiKey);
  const radarr4kConfigured = !!(map.radarr4kUrl && map.radarr4kApiKey);
  const sonarr4kConfigured = !!(map.sonarr4kUrl && map.sonarr4kApiKey);

  const service4kConfigured = service === "RADARR" ? radarr4kConfigured : sonarr4kConfigured;
  // A 4K view is only valid when the selected service actually has a 4K instance configured —
  // otherwise fall back to HD so a stale ?variant=4k can't strand the page on an empty instance.
  const variant: ArrVariant = rawVariant === "4k" && service4kConfigured ? "4k" : "hd";
  const is4k = variant === "4k";

  const serviceHdConfigured = service === "RADARR" ? radarrConfigured : sonarrConfigured;
  const serviceConfigured = is4k ? service4kConfigured : serviceHdConfigured;

  return {
    service,
    variant,
    is4k,
    radarrConfigured,
    sonarrConfigured,
    radarr4kConfigured,
    sonarr4kConfigured,
    serviceConfigured,
  };
}
