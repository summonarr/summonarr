

import { prisma } from "./prisma";
import { stripTrashHtml } from "./trash-html";
import type { TrashService, TrashSpecKind } from "@/generated/prisma";

export interface StarterPackItem {
  service: TrashService;
  kind: TrashSpecKind;

  /**
   * Match descriptor resolved against the local TrashSpec cache by resolveCurated.
   * - `trashId` is the ONLY stable-id lookup key: the upstream hex trash_id for a
   *   QUALITY_PROFILE, the "default" pseudo-id for NAMING.
   * - `name` is the rename-tolerance fallback (exact, then UNIQUE partial,
   *   case-insensitive).
   * - `slug` is the upstream filename slug and is informational ONLY (it rides
   *   into the trash-diagnostic `missing` report). It is NEVER a lookup key:
   *   the sync stores `parsedRaw.trash_id`, which isQualityProfilePayload
   *   requires to be non-empty, so a stored trashId can never equal a slug and
   *   a slug lookup is a guaranteed-miss round-trip.
   */
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
  const include = { applications: { where: { arrInstance: "" } } } as const;

  let spec = null as Awaited<
    ReturnType<typeof prisma.trashSpec.findFirst<{ include: { applications: true } }>>
  > | null;
  // Stable-id path. Only match.trashId is a candidate — match.slug is not a key
  // the sync ever stores (see the StarterPackItem.match doc), so querying it
  // was one guaranteed-miss round-trip per slug-bearing entry on every call.
  if (match.trashId) {
    spec = await prisma.trashSpec.findFirst({
      where: { service, kind, trashId: match.trashId },
      include,
    });
  }
  if (!spec && match.name) {
    spec = await prisma.trashSpec.findFirst({
      where: { service, kind, name: { equals: match.name, mode: "insensitive" } },
      include,
    });
  }
  if (!spec && match.name) {
    // Partial-name fallback so a minor TRaSH upstream rename doesn't blank the
    // starter pack. This is APPLY-facing, not just display: POST starter-pack
    // pushes every resolved curated spec to Radarr/Sonarr, so the match must be
    // UNAMBIGUOUS. TRaSH ships supersets of these names in the same
    // (service, kind) — "UHD Bluray + WEB" / "German HD Bluray + WEB" contain
    // "HD Bluray + WEB", "WEB-1080p (Alternative)" contains "WEB-1080p" — and an
    // unordered findFirst would hand whichever row Postgres yields first to the
    // one-click apply under the 1080p label. Two or more hits ⇒ unresolved
    // (POST reports the label in `missing`, GET renders it unsynced).
    const hits = await prisma.trashSpec.findMany({
      where: { service, kind, name: { contains: match.name, mode: "insensitive" } },
      include,
      take: 2,
    });
    const [only] = hits;
    if (hits.length === 1 && only) spec = only;
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
