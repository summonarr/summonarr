import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { UserTable } from "@/components/admin/user-table";
import { ServerUserTable } from "@/components/admin/server-user-table";
import { SyncRolesButton } from "@/components/admin/request-actions";
import { PageHeader } from "@/components/ui/design";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") redirect("/");

  const [users, localAuthRows, serverUsers, autoDisableRow] = await Promise.all([
    prisma.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
        discordId: true,
        autoApprove: true,
        quotaExempt: true,
        mediaServer: true,
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
  ]);
  const localAuthIds = new Set(localAuthRows.map((r) => r.id));

  const hasPlex = serverUsers.some((u) => u.source === "plex");
  const hasJellyfin = serverUsers.some((u) => u.source === "jellyfin");
  const autoDisableNew = autoDisableRow?.value === "true";

  return (
    <div className="ds-page-enter">
      <PageHeader
        title="Users"
        subtitle={`${users.length} registered user${users.length !== 1 ? "s" : ""}`}
        right={<SyncRolesButton />}
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
            autoApprove: u.autoApprove,
            quotaExempt: u.quotaExempt,
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
            mediaServer: u.mediaServer as "plex" | "jellyfin" | null,
            source: localAuthIds.has(u.id)
              ? "local"
              : u.email.endsWith("@jellyfin.local")
              ? "jellyfin"
              : "plex",
          }))}
          currentUserId={session.user.id}
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
