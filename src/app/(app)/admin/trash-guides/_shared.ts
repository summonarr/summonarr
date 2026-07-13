import { authActive } from "@/lib/auth";
import { redirect } from "next/navigation";
import { hasPermission, Permission } from "@/lib/permissions";
import { getSyncableArrInstances } from "@/lib/arr-instance-registry";
import type { ArrVariant } from "@/lib/arr";
import type { TrashService } from "@/components/admin/trash-guides/types";

export type TrashPageSearchParams = Promise<{ service?: string; variant?: string }>;

// A configured instance the trash pages can target (drives the nav toggle).
export interface TrashInstanceOption {
  slug: string;
  name: string;
}

export interface TrashPageContext {
  service: TrashService;
  // Which instance the page targets — an instance SLUG ("" default, "4k", or a
  // named slug). Only survives when the selected service has that instance
  // configured (see fallback below).
  variant: ArrVariant;
  radarrConfigured: boolean;
  sonarrConfigured: boolean;
  // Configured instances for the SELECTED service, default first.
  instances: TrashInstanceOption[];
  // True when the currently selected (service, variant) pair has its URL + API key set in Settings.
  serviceConfigured: boolean;
}

// Shared auth + service/instance-resolution for every TRaSH sub-page. The layout already enforces
// ADMIN, but each page is its own server component and Next won't run the layout's redirect inside
// it, so we re-check here as a defense-in-depth measure.
export async function loadTrashPageContext(
  searchParams: TrashPageSearchParams,
): Promise<TrashPageContext> {
  const session = await authActive();
  if (!session || !hasPermission(session.user.permissions, Permission.ADMIN)) redirect("/");

  const { service: rawService, variant: rawVariant } = await searchParams;
  const service: TrashService = rawService === "sonarr" ? "SONARR" : "RADARR";

  const [radarrInstances, sonarrInstances] = await Promise.all([
    getSyncableArrInstances("radarr"),
    getSyncableArrInstances("sonarr"),
  ]);
  const serviceInstances = service === "RADARR" ? radarrInstances : sonarrInstances;

  // Accept the legacy "hd" spelling for the default instance; otherwise ?variant=
  // is an instance slug. An unknown/unconfigured slug falls back to the default so
  // a stale ?variant= can't strand the page on an empty instance.
  const requested = rawVariant == null || rawVariant === "hd" ? "" : rawVariant;
  const variant: ArrVariant = serviceInstances.some((i) => i.slug === requested) ? requested : "";

  return {
    service,
    variant,
    radarrConfigured: radarrInstances.some((i) => i.slug === ""),
    sonarrConfigured: sonarrInstances.some((i) => i.slug === ""),
    instances: serviceInstances.map((i) => ({ slug: i.slug, name: i.name })),
    serviceConfigured: serviceInstances.some((i) => i.slug === variant),
  };
}
