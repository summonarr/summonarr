import { authActive } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { hasPermission, mergeNamedInstanceAccess, Permission, parseInstanceGrants, parseMediaServerGrants } from "@/lib/permissions";
import type { Prisma } from "@/generated/prisma";
import { UserTable, type NamedInstance, type RestrictedMediaInstance } from "@/components/admin/user-table";
import { ServerUserTable } from "@/components/admin/server-user-table";
import { SyncRolesButton } from "@/components/admin/request-sync-buttons";
import { CreateUserButton } from "@/components/admin/create-user-button";
import { PageHeader, SectionHeader } from "@/components/ui/design";
import { getTranslator } from "@/lib/i18n/server";
import { isArrConfigured } from "@/lib/arr";
import { getArrInstances } from "@/lib/arr-instance-registry";
import { getMediaInstances } from "@/lib/media-instance-registry";
import { FOURK_ARR_INSTANCE } from "@/lib/arr-instances";
import { isPurgedRow } from "@/lib/account-lifecycle";
import { deriveUserSource } from "@/lib/user-source";
import { getWatchGradeSummaries } from "@/lib/watch-grade-data";
import { displayName } from "@/lib/display-name";
import { parsePageNumber } from "@/lib/pagination";
import { first, type PageSearchParams } from "@/lib/search-params";
import { PaginationBar } from "@/components/media/pagination-bar";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

// Row budget for one page of the table (`?page=` reaches the rest). When it is
// hit the UI says so rather than treating the slice length as the registered
// total (the subtitle and the on-behalf picker both used to). Auxiliary queries
// below are scoped to this page's ids.
const USER_LIST_CAP = 1000;
// The same budget for media-server identities: a large shared server keeps every
// departed account that still holds history, and every row is serialized into
// the client table.
const SERVER_USER_LIST_CAP = 1000;

// Active users, PLUS departed (soft-deleted) ones that still hold play history.
// A departed row's history outlives their removal from the server (guardrail
// 28), so it still needs to be attributable — hiding it here strands that
// history with no UI able to re-link it. A departed row with no history is
// genuinely irrelevant and stays hidden.
const SERVER_USER_WHERE: Prisma.MediaServerUserWhereInput = { OR: [{ active: true }, { playHistory: { some: {} } }] };

// Link targets for the manual account picker: a separate light read with its
// own, higher budget, so an account past the table's cap can still be picked.
const LINK_TARGET_CAP = 5000;
const USER_ORDER = [{ name: "asc" as const }, { email: "asc" as const }];

// The per-user notification switches the table edits, selected and handed to
// it as one group so a new preference is added in one place.
const NOTIFICATION_PREF_SELECT = {
  notifyOnApproved: true,
  notifyOnAvailable: true,
  notifyOnDeclined: true,
  emailOnApproved: true,
  emailOnAvailable: true,
  emailOnDeclined: true,
  pushOnApproved: true,
  pushOnAvailable: true,
  pushOnDeclined: true,
  notifyOnIssue: true,
  notifyOnComment: true,
  emailOnComment: true,
  pushOnComment: true,
} as const satisfies Prisma.UserSelect;

type NotificationPrefs = { -readonly [K in keyof typeof NOTIFICATION_PREF_SELECT]: boolean };

function notificationPrefs(u: NotificationPrefs): NotificationPrefs {
  const out = {} as NotificationPrefs;
  for (const k of Object.keys(NOTIFICATION_PREF_SELECT) as (keyof NotificationPrefs)[]) out[k] = u[k];
  return out;
}

// User.mediaServer is a free string column; only the two known providers
// reach the table, anything else reads as unpinned.
function mediaServerOf(value: string | null): "plex" | "jellyfin" | null {
  return value === "plex" || value === "jellyfin" ? value : null;
}

// The table's columns, shared by the page read and the past-the-end re-read.
const USER_ROW_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  createdAt: true,
  deactivatedAt: true,
  purgedAt: true,
  discordId: true,
  permissions: true,
  movieQuotaLimit: true,
  movieQuotaDays: true,
  tvQuotaLimit: true,
  tvQuotaDays: true,
  mediaServer: true,
  maxContentRating: true,
  // The provider SUBJECT columns are the authoritative binding for the
  // source chip (deriveUserSource); the email suffix is only a fallback.
  plexUserId: true,
  jellyfinUserId: true,
  ...NOTIFICATION_PREF_SELECT,
  instanceGrants: true,
  mediaServerGrants: true,
  _count: { select: { requests: true } },
} as const satisfies Prisma.UserSelect;

const userPage = (page: number) =>
  prisma.user.findMany({
    select: USER_ROW_SELECT,
    orderBy: USER_ORDER,
    skip: (page - 1) * USER_LIST_CAP,
    take: USER_LIST_CAP,
  });

export default async function UsersPage({ searchParams }: { searchParams: Promise<PageSearchParams> }) {
  const session = await authActive();
  if (!session || !hasPermission(session.user.permissions, Permission.MANAGE_USERS)) redirect("/");
  const sp = await searchParams;
  const requestedPage = parsePageNumber(first(sp.page));
  // Linking a media-server identity to an account is ADMIN-only (guardrail 34d);
  // a MANAGE_USERS delegate sees the bindings read-only.
  const canLinkServerUsers = hasPermission(session.user.permissions, Permission.ADMIN);

  const [
    requestedUsers, userCount, serverUsers, serverUserCount, autoDisableRow, radarr4kConfigured, sonarr4kConfigured,
    sonarrInstances, radarrInstances, plexInstances, jellyfinInstances, linkTargets,
  ] = await Promise.all([
    userPage(requestedPage),
    prisma.user.count(),
    prisma.mediaServerUser.findMany({
      where: SERVER_USER_WHERE,
      select: {
        id: true,
        source: true,
        // Multi-server support — distinguishes same-named/same-sourceUserId rows
        // across two independently-configured servers of the same provider.
        serverInstance: true,
        sourceUserId: true,
        username: true,
        email: true,
        thumbUrl: true,
        downloadsEnabled: true,
        isServerAdmin: true,
        userId: true,
        manualUserLink: true, // admin pinned this binding — automatic linking skips the row
        active: true,
        user: { select: { name: true, email: true } },
      },
      orderBy: [{ source: "asc" }, { username: "asc" }],
      take: SERVER_USER_LIST_CAP,
    }),
    prisma.mediaServerUser.count({ where: SERVER_USER_WHERE }),
    prisma.setting.findUnique({ where: { key: "downloadAutoDisableNew" } }),
    isArrConfigured("radarr", "4k"),
    isArrConfigured("sonarr", "4k"),
    getArrInstances("sonarr"),
    getArrInstances("radarr"),
    getMediaInstances("plex"),
    getMediaInstances("jellyfin"),
    // Purged accounts are excluded — they have no identity left to attribute
    // history to (the route rejects them too).
    canLinkServerUsers
      ? prisma.user.findMany({
          where: { purgedAt: null },
          select: { id: true, name: true, email: true, purgedAt: true },
          orderBy: USER_ORDER,
          take: LINK_TARGET_CAP,
        })
      : Promise.resolve([]),
  ]);
  // A page past the end (accounts removed since the link was made) shows the
  // last page instead of an empty table; only that case reads a second time.
  const lastPage = Math.max(1, Math.ceil(userCount / USER_LIST_CAP));
  const page = Math.min(requestedPage, lastPage);
  const users = page === requestedPage ? requestedUsers : await userPage(page);
  const userIds = users.map((u) => u.id);
  // Scoped to the listed slice — an unbounded related read of every local-auth /
  // OIDC / 2FA row was the other half of the silent 1000 cap.
  // No users ⇒ no rows to grade either, so no availability check.
  const [localAuthRows, oidcAccountRows, totpRows, passkeyRows, watchGrades] = userIds.length === 0
    ? [[], [], [], [], null]
    : await Promise.all([
      prisma.user.findMany({
        where: { id: { in: userIds }, passwordHash: { not: null } },
        select: { id: true },
      }),
      // The only Account rows this app writes are the OIDC bindings (auth.ts) —
      // Plex/Jellyfin store their id on the User row instead. Without this list,
      // deriveUserSource below would read an OIDC account (no passwordHash, IdP
      // email) as "plex" and hide the server-access controls it actually needs.
      prisma.account.findMany({
        where: { provider: "oidc", userId: { in: userIds } },
        select: { userId: true },
      }),
      // Which listed accounts have an active second factor — drives the Reset
      // two-factor action. Selects only userId: the TOTP secret never leaves the
      // extension.
      prisma.userTotp.findMany({ where: { userId: { in: userIds }, enabledAt: { not: null } }, select: { userId: true } }),
      prisma.webAuthnCredential.findMany({ where: { userId: { in: userIds } }, distinct: ["userId"], select: { userId: true } }),
      getWatchGradeSummaries(userIds),
    ]);
  const mfaUserIds = new Set([...totpRows, ...passkeyRows].map((r) => r.userId));
  const localAuthIds = new Set(localAuthRows.map((r) => r.id));
  const oidcAuthIds = new Set(oidcAccountRows.map((r) => r.userId));

  const hasJellyfin = serverUsers.some((u) => u.source === "jellyfin");
  const autoDisableNew = autoDisableRow?.value === "true";
  // Show the 4K capability toggles in the permission editor only when a 4K
  // instance exists (no point granting REQUEST_4K with nowhere to route it).
  const has4k = radarr4kConfigured || sonarr4kConfigured;

  // Named (non-default, non-4K) instances for the per-user grants editor.
  // Union across both services; a slug on both keeps one entry, open only when
  // both twins are (mergeNamedInstanceAccess). 4K stays on its permission bits
  // (REQUEST_4K*), so it is excluded here.
  const namedInstances: NamedInstance[] = mergeNamedInstanceAccess(
    [...sonarrInstances, ...radarrInstances]
      .filter((inst) => inst.slug !== "" && inst.slug !== FOURK_ARR_INSTANCE)
      .map((inst) => ({ slug: inst.slug, name: inst.name, restricted: inst.restricted, serverAll: inst.serverAll })),
  );

  // RESTRICTED Plex/Jellyfin servers for the per-user visibility editor. NOT
  // unioned by slug like the arr list above: grants are service-namespaced, so
  // plex "remote" and jellyfin "remote" are two different servers holding
  // different content and each needs its own row. Unrestricted servers are
  // omitted — they are visible to everyone, so there is nothing to grant, and an
  // empty list makes the whole section disappear (the case on any deployment
  // that has never restricted a server). The default ("") is never restricted.
  const mediaInstances: RestrictedMediaInstance[] = [];
  for (const [service, instances] of [["plex", plexInstances], ["jellyfin", jellyfinInstances]] as const) {
    for (const inst of instances) {
      if (!inst.restricted) continue;
      mediaInstances.push({ service, slug: inst.slug, name: inst.name });
    }
  }

  const t = await getTranslator();
  // /api/discord/sync-roles is withAdmin, which admits the ADMIN role only; a
  // MANAGE_USERS delegate would get a 403 on every click.
  const canSyncRoles = session.user.role === "ADMIN";

  return (
    <div className="ds-page-enter">
      <PageHeader
        title={t("adminManage.users.title")}
        subtitle={t("adminManage.users.registered", { count: userCount })}
        right={
          <div className="flex items-center gap-2">
            <CreateUserButton />
            {canSyncRoles && <SyncRolesButton />}
          </div>
        }
      />

      {userCount > users.length && (
        <p
          role="status"
          className="ds-mono"
          style={{ fontSize: 11, color: "var(--ds-fg-subtle)", marginBottom: 10 }}
        >
          {t("adminManage.users.capped", { cap: USER_LIST_CAP, total: userCount })}
        </p>
      )}

      <div>
        <UserTable
          users={users.map((u) => ({
            id: u.id,
            name: displayName(u.name),
            email: u.email,
            role: u.role,
            createdAt: u.createdAt.toISOString(),
            disabled: u.deactivatedAt != null,
            purged: isPurgedRow(u),
            mfaEnabled: mfaUserIds.has(u.id),
            discordId: u.discordId,
            permissions: u.permissions.toString(),
            movieQuotaLimit: u.movieQuotaLimit,
            movieQuotaDays: u.movieQuotaDays,
            tvQuotaLimit: u.tvQuotaLimit,
            tvQuotaDays: u.tvQuotaDays,
            _count: u._count,
            watchGrade: watchGrades?.get(u.id) ?? null,
            ...notificationPrefs(u),
            instanceGrants: parseInstanceGrants(u.instanceGrants),
            mediaServerGrants: parseMediaServerGrants(u.mediaServerGrants),
            mediaServer: mediaServerOf(u.mediaServer),
            maxContentRating: u.maxContentRating,
            source: deriveUserSource({
              email: u.email,
              plexUserId: u.plexUserId,
              jellyfinUserId: u.jellyfinUserId,
              hasLocalCredentials: localAuthIds.has(u.id),
              hasOidcAccount: oidcAuthIds.has(u.id),
            }),
          }))}
          currentUserId={session.user.id}
          has4k={has4k}
          namedInstances={namedInstances}
          mediaInstances={mediaInstances}
        />
        <Suspense>
          <PaginationBar currentPage={page} totalPages={lastPage} />
        </Suspense>
      </div>

      <div className="mt-10">
        <SectionHeader
          title={t("adminManage.serverUsers.title")}
          subtitle={t("adminManage.serverUsers.subtitle")}
        />
        {serverUserCount > serverUsers.length && (
          <p
            role="status"
            className="ds-mono"
            style={{ fontSize: 11, color: "var(--ds-fg-subtle)", marginBottom: 10 }}
          >
            {t("adminManage.serverUsers.capped", { cap: SERVER_USER_LIST_CAP, total: serverUserCount })}
          </p>
        )}
        {canLinkServerUsers && linkTargets.length >= LINK_TARGET_CAP && (
          <p
            role="status"
            className="ds-mono"
            style={{ fontSize: 11, color: "var(--ds-fg-subtle)", marginBottom: 10 }}
          >
            {t("adminManage.users.linkTargetsCapped", { cap: LINK_TARGET_CAP })}
          </p>
        )}
        <ServerUserTable
          users={serverUsers.map((u) => (u.user ? { ...u, user: { ...u.user, name: displayName(u.user.name) } } : u))}
          hasJellyfin={hasJellyfin}
          autoDisableNew={autoDisableNew}
          canLink={canLinkServerUsers}
          // /api/cron/sync-download-policies admits the ADMIN role only.
          canSync={session.user.role === "ADMIN"}
          // Link targets for the manual account picker (admins only).
          accounts={canLinkServerUsers
            ? linkTargets
                .filter((u) => !isPurgedRow(u))
                .map((u) => ({ id: u.id, name: displayName(u.name), email: u.email }))
            : []}
        />
      </div>
    </div>
  );
}
