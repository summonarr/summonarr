import { arrFetch, getArrCfg, ArrResponseError } from "./arr";
import { getSyncableArrInstances } from "./arr-instance-registry";
import { PROJECTION_SCAN_FACTOR } from "./arr-parse";
import { MAX_DISK_ENTRIES } from "./arr-system";
import { isFeatureEnabled } from "./features";

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

/**
 * /api/v3/diskspace as the arr answered it, kept to exactly the four fields
 * native clients decode (guardrail 25 — a well-formed entry passes through
 * unchanged, in the arr's order). Anything else — not an array, a null or
 * junk element, a missing path or a non-finite size — is skipped rather than
 * failing the whole storage card, and the list is linear and bounded
 * (guardrail 5i): at most MAX_DISK_ENTRIES kept, PROJECTION_SCAN_FACTOR times
 * that read.
 */
export function diskSpaceEntries(raw: unknown): DiskSpaceEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: DiskSpaceEntry[] = [];
  const scan = Math.min(raw.length, MAX_DISK_ENTRIES * PROJECTION_SCAN_FACTOR);
  for (let i = 0; i < scan && out.length < MAX_DISK_ENTRIES; i++) {
    const e = raw[i] as Record<string, unknown> | null;
    if (!e || typeof e !== "object" || Array.isArray(e)) continue;
    const { path, label, freeSpace, totalSpace } = e;
    if (typeof path !== "string" || path === "") continue;
    if (typeof freeSpace !== "number" || !Number.isFinite(freeSpace) || typeof totalSpace !== "number" || !Number.isFinite(totalSpace)) continue;
    out.push({ path, label: typeof label === "string" ? label : "", freeSpace, totalSpace });
  }
  return out;
}

async function fetchDiskSpace(
  service: "radarr" | "sonarr",
  slug: string,
): Promise<DiskSpaceEntry[] | null | typeof FAILED> {
  try {
    // Inside the try: a config read that throws (the database, a value that no
    // longer decrypts) marks THIS instance unreachable, like a failed call —
    // never the whole report.
    const cfg = await getArrCfg(service, slug);
    if (!cfg) return null;
    // Route through arrFetch (guardrail 5): 50 MB response cap, 30s timeout,
    // injects X-Api-Key, throws ArrResponseError on non-2xx.
    return diskSpaceEntries(await arrFetch<unknown>(cfg, "/api/v3/diskspace"));
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

const SERVICE_LABEL = { radarr: "Radarr", sonarr: "Sonarr" } as const;

export async function getArrDiskSpace(): Promise<ArrDiskSpace> {
  // A service whose integration is switched off is not called at all — as on
  // every other admin arr page (enabledArrInstances): `radarr`/`sonarr` null,
  // nothing for it in `extra` or `unreachable`.
  const [radarrOn, sonarrOn] = await Promise.all([
    isFeatureEnabled("feature.integration.radarr"),
    isFeatureEnabled("feature.integration.sonarr"),
  ]);
  const [radarrInstances, sonarrInstances] = await Promise.all([
    radarrOn ? getSyncableArrInstances("radarr") : [],
    sonarrOn ? getSyncableArrInstances("sonarr") : [],
  ]);
  // Every instance, the default included, through one list: radarr then
  // sonarr, each in registry order (the default first, 4K right after it).
  const targets = [
    ...radarrInstances.map((i) => ({ service: "radarr" as const, slug: i.slug, name: i.name })),
    ...sonarrInstances.map((i) => ({ service: "sonarr" as const, slug: i.slug, name: i.name })),
  ];
  const results = await Promise.all(targets.map((t) => fetchDiskSpace(t.service, t.slug)));

  const out: ArrDiskSpace = { radarr: null, sonarr: null, extra: [], unreachable: [] };
  targets.forEach((t, i) => {
    const entries = results[i];
    const label = t.slug === "" ? SERVICE_LABEL[t.service] : `${SERVICE_LABEL[t.service]} (${t.name})`;
    if (entries === FAILED) out.unreachable.push({ service: t.service, slug: t.slug, label });
    else if (entries === null) return;
    else if (t.slug === "") out[t.service] = entries;
    else out.extra.push({ service: t.service, slug: t.slug, label, entries });
  });
  return out;
}
