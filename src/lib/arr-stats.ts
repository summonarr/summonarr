import { prisma } from "./prisma";
import { arrFetch, ArrResponseError } from "./arr";

interface DiskSpaceEntry {
  path: string;
  label: string;
  freeSpace: number;
  totalSpace: number;
}

export interface ArrDiskSpace {
  radarr: DiskSpaceEntry[] | null;
  sonarr: DiskSpaceEntry[] | null;
}

async function fetchDiskSpace(service: "radarr" | "sonarr"): Promise<DiskSpaceEntry[] | null> {
  const urlKey = service === "radarr" ? "radarrUrl" : "sonarrUrl";
  const keyKey = service === "radarr" ? "radarrApiKey" : "sonarrApiKey";
  const rows = await prisma.setting.findMany({
    where: { key: { in: [urlKey, keyKey] } },
  });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  if (!map[urlKey] || !map[keyKey]) return null;

  try {
    // Route through arrFetch (guardrail 5): 50 MB response cap, 30s timeout,
    // injects X-Api-Key, throws ArrResponseError on non-2xx.
    return await arrFetch<DiskSpaceEntry[]>(
      { url: map[urlKey].replace(/\/$/, ""), apiKey: map[keyKey] },
      "/api/v3/diskspace",
    );
  } catch (err) {
    if (!(err instanceof ArrResponseError)) {
      console.warn(`[arr-stats] ${service} diskspace failed:`, err);
    }
    return null;
  }
}

export async function getArrDiskSpace(): Promise<ArrDiskSpace> {
  const [radarr, sonarr] = await Promise.all([
    fetchDiskSpace("radarr"),
    fetchDiskSpace("sonarr"),
  ]);
  return { radarr, sonarr };
}
