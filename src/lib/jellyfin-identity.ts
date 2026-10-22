import type { Prisma } from "@/generated/prisma";
import { prisma } from "@/lib/prisma";
import { isPrismaErrorCode } from "@/lib/prisma-errors";

// Which Jellyfin server a Summonarr account's Jellyfin identity belongs to
// (guardrail 34e), and the boot backfill that moves pre-34e rows onto the
// binding.
//
// Why a binding at all: `User.jellyfinUserId` is unique across every configured
// Jellyfin server, and sign-in used to accept it from ANY of them. Jellyfin ids
// are server-generated, but whoever runs a second registered server controls
// that server's database, so they could mint a user carrying another server's
// id — an admin's included — and sign in as that account.

// The instance a Jellyfin id was FIRST seen on: the oldest MediaServerUser row
// for it, active or not (a soft-deleted row is still evidence, guardrail 28).
// The library sync and the play-history poller write those rows for every user
// of every configured server, so the genuine server's row predates a twin
// planted on a server added later. Null when no server has reported the id.
export async function jellyfinFirstSeenInstance(jellyfinUserId: string): Promise<string | null> {
  const row = await prisma.mediaServerUser.findFirst({
    where: { source: "jellyfin", sourceUserId: jellyfinUserId },
    orderBy: [{ createdAt: "asc" }, { serverInstance: "asc" }],
    select: { serverInstance: true },
  });
  return row?.serverInstance ?? null;
}

const SYNTHETIC_JELLYFIN_EMAIL_RE = /^jellyfin-([^@\s]+)@jellyfin\.local$/;

// The Jellyfin id inside a `jellyfin-<id>@jellyfin.local` login address, or
// null for anything else.
export function jellyfinIdFromSyntheticEmail(email: string): string | null {
  return SYNTHETIC_JELLYFIN_EMAIL_RE.exec(email)?.[1] ?? null;
}

// Set once the synthetic-email backfill below has run. Read only by it.
export const JELLYFIN_SYNTHETIC_BACKFILL_KEY = "jellyfinSyntheticEmailBackfillAt";

export interface JellyfinIdentityBackfillResult {
  /** Rows given a jellyfinUserId from their synthetic address. */
  boundFromEmail: number;
  /** Synthetic-address rows left alone: they also carry a password, a Plex id or an OIDC binding, or another row already holds the id. */
  skippedFromEmail: number;
  /** Rows given a jellyfinInstance from their first-seen evidence. */
  boundInstance: number;
}

// Boot task (instrumentation.ts), two steps:
//
// 1. ONCE EVER (marker-guarded): rows that still identify as Jellyfin only by
//    the synthetic `jellyfin-<id>@jellyfin.local` address get that id written
//    to jellyfinUserId. Sign-in no longer falls back to the address, because it
//    bound a login to ANY row carrying it — a delegate- or OIDC-created one
//    included. Only rows shaped like a Jellyfin-provisioned account qualify (no
//    password, no Plex id, no OIDC binding); the rest are counted and logged
//    for an admin, never bound.
// 2. EVERY BOOT: rows with a jellyfinUserId but no jellyfinInstance take the
//    instance their id was first seen on. A row with no evidence stays null and
//    adopts the instance of its next sign-in (findOrCreateJellyfinUser).
export async function backfillJellyfinIdentities(): Promise<JellyfinIdentityBackfillResult> {
  const result: JellyfinIdentityBackfillResult = { boundFromEmail: 0, skippedFromEmail: 0, boundInstance: 0 };

  const marker = await prisma.setting.findUnique({ where: { key: JELLYFIN_SYNTHETIC_BACKFILL_KEY } });
  if (!marker?.value) {
    const syntheticWhere = { jellyfinUserId: null, email: { endsWith: "@jellyfin.local" } } satisfies Prisma.UserWhereInput;
    const [eligible, ineligible] = await Promise.all([
      prisma.user.findMany({
        where: { ...syntheticWhere, passwordHash: null, plexUserId: null, accounts: { none: { provider: "oidc" } } },
        select: { id: true, email: true },
      }),
      prisma.user.count({
        where: {
          ...syntheticWhere,
          OR: [{ passwordHash: { not: null } }, { plexUserId: { not: null } }, { accounts: { some: { provider: "oidc" } } }],
        },
      }),
    ]);
    result.skippedFromEmail += ineligible;
    for (const row of eligible) {
      const jellyfinUserId = jellyfinIdFromSyntheticEmail(row.email);
      if (!jellyfinUserId) {
        result.skippedFromEmail++;
        continue;
      }
      try {
        // Conditional on the column still being null, so a sign-in that bound
        // the row meanwhile is never overwritten.
        const { count } = await prisma.user.updateMany({
          where: { id: row.id, jellyfinUserId: null },
          data: { jellyfinUserId },
        });
        result.boundFromEmail += count;
      } catch (err) {
        // P2002: another row already holds this id. Leave both for an admin.
        if (isPrismaErrorCode(err, "P2002")) {
          result.skippedFromEmail++;
          continue;
        }
        throw err;
      }
    }
    if (result.skippedFromEmail > 0) {
      console.warn(
        `[jellyfin-identity] ${result.skippedFromEmail} account(s) carry a jellyfin-<id>@jellyfin.local address but were not bound to that Jellyfin id (they also have a password, a Plex id or an OIDC binding, or another account holds the id). That Jellyfin user's sign-in is refused until an admin resolves it.`,
      );
    }
    await prisma.setting.upsert({
      where: { key: JELLYFIN_SYNTHETIC_BACKFILL_KEY },
      create: { key: JELLYFIN_SYNTHETIC_BACKFILL_KEY, value: new Date().toISOString() },
      update: {},
    });
  }

  const unbound = await prisma.user.findMany({
    where: { jellyfinUserId: { not: null }, jellyfinInstance: null },
    select: { id: true, jellyfinUserId: true },
  });
  if (unbound.length === 0) return result;
  const evidence = await prisma.mediaServerUser.findMany({
    where: { source: "jellyfin", sourceUserId: { in: unbound.flatMap((u) => (u.jellyfinUserId ? [u.jellyfinUserId] : [])) } },
    orderBy: [{ createdAt: "asc" }, { serverInstance: "asc" }],
    select: { sourceUserId: true, serverInstance: true },
  });
  const firstSeen = new Map<string, string>();
  for (const row of evidence) {
    if (!firstSeen.has(row.sourceUserId)) firstSeen.set(row.sourceUserId, row.serverInstance);
  }
  const byInstance = new Map<string, string[]>();
  for (const u of unbound) {
    const instance = u.jellyfinUserId ? firstSeen.get(u.jellyfinUserId) : undefined;
    if (instance === undefined) continue;
    byInstance.set(instance, [...(byInstance.get(instance) ?? []), u.id]);
  }
  for (const [instance, ids] of byInstance) {
    const { count } = await prisma.user.updateMany({
      where: { id: { in: ids }, jellyfinInstance: null },
      data: { jellyfinInstance: instance },
    });
    result.boundInstance += count;
  }
  return result;
}
