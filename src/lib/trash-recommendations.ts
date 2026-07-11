

import { prisma } from "./prisma";
import { stripTrashHtml } from "./trash-html";
import type { TrashService, TrashSpecKind } from "@/generated/prisma";

export interface StarterPackItem {
  service: TrashService;
  kind: TrashSpecKind;

  match?: { trashId?: string; name?: string; slug?: string };
  label: string;
  rationale: string;
  recommended: boolean;
}

// STARTER_PACK items are resolved against the local TrashSpec cache — they are NOT fetched live from TRaSH on each request
export const STARTER_PACK: StarterPackItem[] = [

  {
    service: "RADARR",
    kind: "QUALITY_PROFILE",
    match: { trashId: "d1d67249d3890e49bc12e275d989a7e9", slug: "hd-bluray-web", name: "HD Bluray + WEB" },
    label: "Movies: HD Bluray + WEB (1080p)",
    rationale: "TRaSH's default for 1080p Blu-ray + WEB-DL movies. Pulls in the HQ release-group CFs, blocks low-quality sources, and sets sane scoring.",
    recommended: true,
  },
  {
    service: "RADARR",
    kind: "NAMING",
    match: { trashId: "default", name: "TRaSH Standard Naming" },
    label: "Movies: TRaSH standard naming",
    rationale: "TRaSH's canonical file + folder naming pattern for movies (standard format, Plex/Emby/Jellyfin variants kept as options).",
    recommended: true,
  },

  {
    service: "SONARR",
    kind: "QUALITY_PROFILE",
    match: { slug: "web-1080p", name: "WEB-1080p" },
    label: "TV: WEB-1080p",
    rationale: "TRaSH's default for 1080p WEB-DL TV. Works for everything streaming services release; add Bluray profile later if needed.",
    recommended: true,
  },
  {
    service: "SONARR",
    kind: "NAMING",
    match: { trashId: "default", name: "TRaSH Standard Naming" },
    label: "TV: TRaSH standard naming",
    rationale: "TRaSH's canonical episode + series + season folder naming pattern.",
    recommended: true,
  },
];

export interface StarterPackStatus {
  item: StarterPackItem;
  spec: {
    id: string;
    name: string;
    trashId: string;
  } | null;
  application: {
    enabled: boolean;
    appliedAt: string | null;
    lastError: string | null;
  } | null;
}

const SERVICE_PREFIX: Record<TrashService, string> = { RADARR: "Movies", SONARR: "TV" };

function deriveLabel(spec: { service: TrashService; kind: TrashSpecKind; name: string }): string {
  const prefix = SERVICE_PREFIX[spec.service];
  if (spec.kind === "NAMING") return `${prefix}: ${spec.name} naming`;
  if (spec.kind === "QUALITY_SIZE") return `${prefix}: ${spec.name} quality sizes`;
  return `${prefix}: ${spec.name}`;
}

function deriveRationale(spec: { kind: TrashSpecKind; payload: unknown }): string {
  if (spec.kind === "QUALITY_PROFILE") {
    const desc = (spec.payload as { trash_description?: string } | null)?.trash_description?.trim();
    if (desc) return stripTrashHtml(desc);
    return "TRaSH quality profile. Applying it cascades to every referenced custom format.";
  }
  if (spec.kind === "NAMING") return "TRaSH naming pattern — merged into Radarr/Sonarr's media-management config on apply.";
  if (spec.kind === "QUALITY_SIZE") return "TRaSH per-quality min/preferred/max MB-per-minute template — overlaid on the live quality definitions.";
  return "";
}

async function resolveCurated(item: StarterPackItem) {
  const { service, kind, match } = item;
  if (!match) return null;
  const candidates: string[] = [];
  if (match.trashId) candidates.push(match.trashId);
  if (match.slug) candidates.push(match.slug);

  let spec = null as Awaited<
    ReturnType<typeof prisma.trashSpec.findFirst<{ include: { applications: true } }>>
  > | null;
  for (const trashId of candidates) {
    spec = await prisma.trashSpec.findFirst({
      where: { service, kind, trashId },
      include: { applications: { where: { arrInstance: "" } } },
    });
    if (spec) break;
  }
  if (!spec && match.name) {
    spec = await prisma.trashSpec.findFirst({
      where: { service, kind, name: { equals: match.name, mode: "insensitive" } },
      include: { applications: { where: { arrInstance: "" } } },
    });
  }
  if (!spec && match.name) {
    // Fall back to partial name match so minor TRaSH upstream renames don't break the starter pack display
    spec = await prisma.trashSpec.findFirst({
      where: { service, kind, name: { contains: match.name, mode: "insensitive" } },
      include: { applications: { where: { arrInstance: "" } } },
    });
  }
  return spec;
}

export async function resolveStarterPack(): Promise<StarterPackStatus[]> {
  const curatedSpecIds = new Set<string>();

  // Resolve all starter-pack items in parallel — replaces a serial loop that ran
  // up to 3 queries per item back-to-back (12 round-trips for the 4-item pack).
  const specs = await Promise.all(STARTER_PACK.map((item) => resolveCurated(item)));

  const results: StarterPackStatus[] = STARTER_PACK.map((item, i) => {
    const spec = specs[i];
    if (spec) curatedSpecIds.add(spec.id);
    return {
      item,
      spec: spec ? { id: spec.id, name: spec.name, trashId: spec.trashId } : null,
      application: spec?.applications[0]
        ? {
            enabled: spec.applications[0].enabled,
            appliedAt: spec.applications[0].appliedAt?.toISOString() ?? null,
            lastError: spec.applications[0].lastError,
          }
        : null,
    };
  });

  const others = await prisma.trashSpec.findMany({
    where: {
      kind: { in: ["QUALITY_PROFILE", "NAMING", "QUALITY_SIZE"] },
      ...(curatedSpecIds.size > 0 ? { id: { notIn: [...curatedSpecIds] } } : {}),
    },
    include: { applications: { where: { arrInstance: "" } } },
    orderBy: [{ service: "asc" }, { kind: "asc" }, { name: "asc" }],
  });

  for (const spec of others) {
    results.push({
      item: {
        service: spec.service,
        kind: spec.kind,
        label: deriveLabel(spec),
        rationale: deriveRationale(spec),
        recommended: false,
      },
      spec: { id: spec.id, name: spec.name, trashId: spec.trashId },
      application: spec.applications[0]
        ? {
            enabled: spec.applications[0].enabled,
            appliedAt: spec.applications[0].appliedAt?.toISOString() ?? null,
            lastError: spec.applications[0].lastError,
          }
        : null,
    });
  }

  return results;
}
