import { authActive } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { hasPermission, Permission, parseInstanceGrants } from "@/lib/permissions";
import { UserTable, type NamedInstance } from "@/components/admin/user-table";
import { ServerUserTable } from "@/components/admin/server-user-table";
import { SyncRolesButton } from "@/components/admin/request-actions";
import { CreateUserButton } from "@/components/admin/create-user-button";
import { PageHeader } from "@/components/ui/design";
import { isArrConfigured } from "@/lib/arr";
import { getArrInstances } from "@/lib/arr-instance-registry";
import { FOURK_ARR_INSTANCE } from "@/lib/arr-instances";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const session = await authActive();
  if (!session || !hasPermission(session.user.permissions, Permission.MANAGE_USERS)) redirect("/");

  const [users, localAuthRows, serverUsers, autoDisableRow, radarr4kConfigured, sonarr4kConfigured] = await Promise.all([
    prisma.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
        discordId: true,
        permissions: true,
        movieQuotaLimit: true,
        movieQuotaDays: true,
        tvQuotaLimit: true,
        tvQuotaDays: true,
        mediaServer: true,
        maxContentRating: true,
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
        instanceGrants: true,
        _count: { select: { requests: true } },
      },
      orderBy: [{ name: "asc" }, { email: "asc" }],
      take: 1000,
    }),
    prisma.user.findMany({
      where: { passwordHash: { not: null } },
      select: { id: true },
    }),
    prisma.mediaServerUser.findMany({
      where: { active: true }, // hide soft-deleted (departed) server users
      select: {
        id: true,
        source: true,
        sourceUserId: true,
        username: true,
        email: true,
        thumbUrl: true,
        downloadsEnabled: true,
        isServerAdmin: true,
        userId: true,
        user: { select: { name: true, email: true } },
      },
      orderBy: [{ source: "asc" }, { username: "asc" }],
    }),
    prisma.setting.findUnique({ where: { key: "downloadAutoDisableNew" } }),
    isArrConfigured("radarr", "4k"),
    isArrConfigured("sonarr", "4k"),
  ]);
  const localAuthIds = new Set(localAuthRows.map((r) => r.id));

  const hasPlex = serverUsers.some((u) => u.source === "plex");
  const hasJellyfin = serverUsers.some((u) => u.source === "jellyfin");
  const autoDisableNew = autoDisableRow?.value === "true";
  // Show the 4K capability toggles in the permission editor only when a 4K
  // instance exists (no point granting REQUEST_4K with nowhere to route it).
  const has4k = radarr4kConfigured || sonarr4kConfigured;

  // Named (non-default, non-4K) instances for the per-user grants editor.
  // Union across both services; a slug on both keeps one entry. 4K stays on
  // its permission bits (REQUEST_4K*), so it is excluded here.
  const namedInstanceMap = new Map<string, NamedInstance>();
  for (const service of ["sonarr", "radarr"] as const) {
    for (const inst of await getArrInstances(service)) {
      if (inst.slug === "" || inst.slug === FOURK_ARR_INSTANCE) continue;
      namedInstanceMap.set(inst.slug, {
        slug: inst.slug,
        name: inst.name,
        restricted: inst.restricted,
        serverAll: inst.serverAll,
      });
    }
  }
  const namedInstances = [...namedInstanceMap.values()];

  return (
    <div className="ds-page-enter">
      <PageHeader
        title="Users"
        subtitle={`${users.length} registered user${users.length !== 1 ? "s" : ""}`}
        right={
          <div className="flex items-center gap-2">
            <CreateUserButton />
            <SyncRolesButton />
          </div>
        }
      />

      <div>
        <UserTable
          users={users.map((u) => ({
            id: u.id,
            name: u.name,
            email: u.email,
            role: u.role,
            createdAt: u.createdAt.toISOString(),
            discordId: u.discordId,
            permissions: u.permissions.toString(),
            movieQuotaLimit: u.movieQuotaLimit,
            movieQuotaDays: u.movieQuotaDays,
            tvQuotaLimit: u.tvQuotaLimit,
            tvQuotaDays: u.tvQuotaDays,
            _count: u._count,
            notifyOnApproved: u.notifyOnApproved,
            notifyOnAvailable: u.notifyOnAvailable,
            notifyOnDeclined: u.notifyOnDeclined,
            emailOnApproved: u.emailOnApproved,
            emailOnAvailable: u.emailOnAvailable,
            emailOnDeclined: u.emailOnDeclined,
            pushOnApproved: u.pushOnApproved,
            pushOnAvailable: u.pushOnAvailable,
            pushOnDeclined: u.pushOnDeclined,
            notifyOnIssue: u.notifyOnIssue,
            instanceGrants: parseInstanceGrants(u.instanceGrants),
            mediaServer: u.mediaServer as "plex" | "jellyfin" | null,
            maxContentRating: u.maxContentRating,
            source: localAuthIds.has(u.id)
              ? "local"
              : u.email.endsWith("@jellyfin.local")
              ? "jellyfin"
              : "plex",
          }))}
          currentUserId={session.user.id}
          has4k={has4k}
          namedInstances={namedInstances}
        />
      </div>

      {(hasPlex || hasJellyfin || serverUsers.length === 0) && (
        <div className="mt-10">
          <div className="mb-4">
            <h2 className="text-base font-semibold text-white">Media Server Users</h2>
            <p className="text-xs text-zinc-500 mt-0.5">
              All Plex and Jellyfin accounts. Jellyfin download permissions are synced and enforced each run; Plex permissions must be managed in Plex.
            </p>
          </div>
          <ServerUserTable
            users={serverUsers}
            hasJellyfin={hasJellyfin}
            autoDisableNew={autoDisableNew}
          />
        </div>
      )}
    </div>
  );
}
