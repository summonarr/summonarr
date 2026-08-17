// The NAMED Radarr/Sonarr instances a given viewer may request a given title on,
// with that title's per-instance request/availability state — the data behind
// every "Request on <instance>" button.
//
// One resolver, three consumers: the movie detail page, the TV detail page, and
// GET /api/requests/instances (the native mirror of those buttons). They must
// agree — a button the web hides but the app shows is a button that 400s — and
// the three had each open-coded the same eight steps.
//
// They had already drifted. The route enumerated `getArrInstances`, the pages
// `getSyncableArrInstances`: the former includes instances that are REGISTERED
// but have no url/apiKey, so a native client rendered a "Request on X" button
// for an unconfigured instance while the web page correctly hid it. Pressing it
// could only ever fail — /api/requests rejects an unconfigured named slug with
// 400 "that instance isn't configured" (requests/route.ts, the
// isInstanceConfigured gate). Configured-only is the correct set, and it is now
// impossible to pick the other one at a call site.
//
// Scope is deliberately NAMED slugs only. The default instance ("") is the plain
// Request button and "4k" is the dedicated 4K button; both are already modelled
// on the media payload, and folding them in would give callers two competing
// sources of truth for the same two actions.
//
// Query shape: TWO queries total, not two per instance. The per-instance
// findFirst/findUnique pair this replaces made the round-trip count scale with
// the number of named instances, on the two hottest pages in the app (guardrail
// 31's cap is about fan-out width; this is the same cost with a cheaper fix —
// the whole set is one `arrInstance: { in: [...] }` read against a key both
// tables are already indexed on, `@@id([tmdbId, arrInstance])`).

import { prisma } from "./prisma";
import { getSyncableArrInstances } from "./arr-instance-registry";
import { FOURK_ARR_INSTANCE, DEFAULT_ARR_INSTANCE } from "./arr-instances";
import { canRequestInstance, parseInstanceGrants } from "./permissions";

export interface NamedInstanceTarget {
  slug: string;
  name: string;
  // This viewer already has a live (non-DECLINED) request on this instance.
  requested: boolean;
  // The title is already present at this instance.
  available: boolean;
}

export async function resolveNamedInstanceTargets(params: {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  userId: string;
  permissions: bigint;
  // A blacklisted title has no requestable target at all (the request POST
  // 403s), so report none rather than offering buttons that cannot succeed.
  // Passed in because every caller has already resolved it for its own gating.
  blacklisted: boolean;
}): Promise<NamedInstanceTarget[]> {
  const { tmdbId, mediaType, userId, permissions, blacklisted } = params;
  if (blacklisted) return [];

  const service = mediaType === "MOVIE" ? "radarr" : "sonarr";
  const named = (await getSyncableArrInstances(service)).filter(
    (i) => i.slug !== DEFAULT_ARR_INSTANCE && i.slug !== FOURK_ARR_INSTANCE,
  );
  if (named.length === 0) return [];

  // Grants aren't in the session JWT, so this needs a DB read — only paid once a
  // named instance actually exists.
  const viewer = await prisma.user.findUnique({
    where: { id: userId },
    select: { instanceGrants: true },
  });
  const grants = parseInstanceGrants(viewer?.instanceGrants);
  const eligible = named.filter((inst) =>
    canRequestInstance(permissions, inst, grants, mediaType),
  );
  if (eligible.length === 0) return [];

  const slugs = eligible.map((i) => i.slug);
  const [requests, availables] = await Promise.all([
    prisma.mediaRequest.findMany({
      where: {
        tmdbId,
        mediaType,
        requestedBy: userId,
        arrInstance: { in: slugs },
        status: { not: "DECLINED" },
      },
      select: { arrInstance: true },
    }),
    mediaType === "MOVIE"
      ? prisma.radarrAvailableItem.findMany({
          where: { tmdbId, arrInstance: { in: slugs } },
          select: { arrInstance: true },
        })
      : prisma.sonarrAvailableItem.findMany({
          where: { tmdbId, arrInstance: { in: slugs } },
          select: { arrInstance: true },
        }),
  ]);

  const requestedSlugs = new Set(requests.map((r) => r.arrInstance));
  const availableSlugs = new Set(availables.map((r) => r.arrInstance));

  return eligible.map((inst) => ({
    slug: inst.slug,
    name: inst.name,
    requested: requestedSlugs.has(inst.slug),
    available: availableSlugs.has(inst.slug),
  }));
}
