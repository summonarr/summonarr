import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import type { TrashService } from "@/components/admin/trash-guides/types";

const SETTING_KEYS = [
  "radarrUrl",
  "radarrApiKey",
  "sonarrUrl",
  "sonarrApiKey",
] as const;

export type TrashPageSearchParams = Promise<{ service?: string }>;

export interface TrashPageContext {
  service: TrashService;
  radarrConfigured: boolean;
  sonarrConfigured: boolean;
  // True when the currently selected service has its URL + API key set in Settings.
  serviceConfigured: boolean;
}

// Shared auth + service-resolution for every TRaSH sub-page. The layout already enforces ADMIN,
// but each page is its own server component and Next won't run the layout's redirect inside it,
// so we re-check here as a defense-in-depth measure.
export async function loadTrashPageContext(
  searchParams: TrashPageSearchParams,
): Promise<TrashPageContext> {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") redirect("/");

  const { service: rawService } = await searchParams;
  const service: TrashService = rawService === "sonarr" ? "SONARR" : "RADARR";

  const rows = await prisma.setting.findMany({
    where: { key: { in: [...SETTING_KEYS] } },
  });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  const radarrConfigured = !!(map.radarrUrl && map.radarrApiKey);
  const sonarrConfigured = !!(map.sonarrUrl && map.sonarrApiKey);
  const serviceConfigured = service === "RADARR" ? radarrConfigured : sonarrConfigured;

  return { service, radarrConfigured, sonarrConfigured, serviceConfigured };
}
