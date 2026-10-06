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
  // Configured instances whose diskspace call failed this time. Additive. Without
  // it a failing instance's group just vanished, which read as "not configured".
  unreachable: Array<{ service: "radarr" | "sonarr"; slug: string; label: string }>;
}

// Thrown-away marker for a configured instance whose call failed — distinct from
// null, which means "not configured".
const FAILED = Symbol("diskspace-failed");

async function fetchDiskSpace(
  service: "radarr" | "sonarr",
  slug: string,
): Promise<DiskSpaceEntry[] | null | typeof FAILED> {
  const cfg = await getArrCfg(service, slug);
  if (!cfg) return null;

  try {
    // Route through arrFetch (guardrail 5): 50 MB response cap, 30s timeout,
    // injects X-Api-Key, throws ArrResponseError on non-2xx.
    return await arrFetch<DiskSpaceEntry[]>(cfg, "/api/v3/diskspace");
  } catch (err) {
    // arrFetch already logs a non-2xx (ArrResponseError); only a transport
    // failure needs attributing here. Either way the instance is reported as
    // unreachable to the caller instead of vanishing.
    if (!(err instanceof ArrResponseError)) {
      console.warn(`[arr-stats] ${service}${slug ? ` (${slug})` : ""} diskspace failed:`, err instanceof Error ? err.message : err);
    }
    return FAILED;
  }
}

export async function getArrDiskSpace(): Promise<ArrDiskSpace> {
  const [radarrInstances, sonarrInstances] = await Promise.all([
    getSyncableArrInstances("radarr"),
    getSyncableArrInstances("sonarr"),
  ]);

  const [radarrRaw, sonarrRaw] = await Promise.all([
    radarrInstances.some((i) => i.slug === "") ? fetchDiskSpace("radarr", "") : Promise.resolve(null),
    sonarrInstances.some((i) => i.slug === "") ? fetchDiskSpace("sonarr", "") : Promise.resolve(null),
  ]);

  const unreachable: ArrDiskSpace["unreachable"] = [];
  if (radarrRaw === FAILED) unreachable.push({ service: "radarr", slug: "", label: "Radarr" });
  if (sonarrRaw === FAILED) unreachable.push({ service: "sonarr", slug: "", label: "Sonarr" });

  const namedTargets = [
    ...radarrInstances.filter((i) => i.slug !== "").map((i) => ({ service: "radarr" as const, inst: i })),
    ...sonarrInstances.filter((i) => i.slug !== "").map((i) => ({ service: "sonarr" as const, inst: i })),
  ];
  const extraResults = await Promise.all(
    namedTargets.map(async ({ service, inst }) => {
      const entries = await fetchDiskSpace(service, inst.slug);
      const label = `${service === "radarr" ? "Radarr" : "Sonarr"} (${inst.name})`;
      if (entries === FAILED) {
        unreachable.push({ service, slug: inst.slug, label });
        return null;
      }
      if (!entries) return null;
      return { service, slug: inst.slug, label, entries } satisfies ArrInstanceDiskSpace;
    }),
  );

  return {
    radarr: radarrRaw === FAILED ? null : radarrRaw,
    sonarr: sonarrRaw === FAILED ? null : sonarrRaw,
    extra: extraResults.filter((r) => r !== null),
    unreachable,
  };
}
