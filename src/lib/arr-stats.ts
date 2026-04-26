import { prisma } from "./prisma";
import { safeFetchAdminConfigured } from "./safe-fetch";

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

  const baseUrl = map[urlKey].replace(/\/$/, "");

  try {
    const res = await safeFetchAdminConfigured(`${baseUrl}/api/v3/diskspace`, {
      cache: "no-store",
      timeoutMs: 30_000,
      headers: { "X-Api-Key": map[keyKey] },
    });
    if (!res.ok) return null;
    return await res.json() as DiskSpaceEntry[];
  } catch {
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
