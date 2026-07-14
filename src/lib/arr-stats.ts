import { arrFetch, getArrCfg, ArrResponseError } from "./arr";
import { getSyncableArrInstances } from "./arr-instance-registry";

interface DiskSpaceEntry {
  path: string;
  label: string;
  freeSpace: number;
  totalSpace: number;
}

export interface ArrInstanceDiskSpace {
  service: "radarr" | "sonarr";
  slug: string;
  // Display label, e.g. "Radarr (4K)" / "Sonarr (Anime)".
  label: string;
  entries: DiskSpaceEntry[];
}

export interface ArrDiskSpace {
  // Default-instance entries — field names kept for API back-compat (the admin
  // stats route serializes this shape to native clients).
  radarr: DiskSpaceEntry[] | null;
  sonarr: DiskSpaceEntry[] | null;
  // Non-default (4K/named) instances, additive so older consumers ignore it.
  extra: ArrInstanceDiskSpace[];
}

async function fetchDiskSpace(
  service: "radarr" | "sonarr",
  slug: string,
): Promise<DiskSpaceEntry[] | null> {
  const cfg = await getArrCfg(service, slug);
  if (!cfg) return null;

  try {
    // Route through arrFetch (guardrail 5): 50 MB response cap, 30s timeout,
    // injects X-Api-Key, throws ArrResponseError on non-2xx.
    return await arrFetch<DiskSpaceEntry[]>(cfg, "/api/v3/diskspace");
  } catch (err) {
    if (!(err instanceof ArrResponseError)) {
      console.warn(`[arr-stats] ${service}${slug ? ` (${slug})` : ""} diskspace failed:`, err);
    }
    return null;
  }
}

export async function getArrDiskSpace(): Promise<ArrDiskSpace> {
  const [radarrInstances, sonarrInstances] = await Promise.all([
    getSyncableArrInstances("radarr"),
    getSyncableArrInstances("sonarr"),
  ]);

  const [radarr, sonarr] = await Promise.all([
    radarrInstances.some((i) => i.slug === "") ? fetchDiskSpace("radarr", "") : Promise.resolve(null),
    sonarrInstances.some((i) => i.slug === "") ? fetchDiskSpace("sonarr", "") : Promise.resolve(null),
  ]);

  const namedTargets = [
    ...radarrInstances.filter((i) => i.slug !== "").map((i) => ({ service: "radarr" as const, inst: i })),
    ...sonarrInstances.filter((i) => i.slug !== "").map((i) => ({ service: "sonarr" as const, inst: i })),
  ];
  const extraResults = await Promise.all(
    namedTargets.map(async ({ service, inst }) => {
      const entries = await fetchDiskSpace(service, inst.slug);
      if (!entries) return null;
      return {
        service,
        slug: inst.slug,
        label: `${service === "radarr" ? "Radarr" : "Sonarr"} (${inst.name})`,
        entries,
      } satisfies ArrInstanceDiskSpace;
    }),
  );

  return { radarr, sonarr, extra: extraResults.filter((r) => r !== null) };
}
