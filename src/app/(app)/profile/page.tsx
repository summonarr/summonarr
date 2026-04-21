import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui/card";
import { DiscordLinkSection } from "@/components/discord-link-ui";
import { NotificationPrefs } from "@/components/profile/notification-prefs";
import { PushDevices } from "@/components/profile/push-devices";
import { AuthSessions } from "@/components/profile/auth-sessions";
import { ChangePassword } from "@/components/profile/change-password";
import { User } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const session = await auth();
  if (!session) redirect("/login");

  const [user, hasPassword, discordInviteSetting, pushDevices, maxPushSetting, authSessions] = await Promise.all([
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: {
        name: true, email: true, discordId: true, role: true, mediaServer: true,
        notificationEmail: true,
        notifyOnApproved: true, notifyOnAvailable: true, notifyOnDeclined: true,
        emailOnApproved: true, emailOnAvailable: true, emailOnDeclined: true,
        pushOnApproved: true, pushOnAvailable: true, pushOnDeclined: true,
        notifyOnIssue: true,
      },
    }),
    prisma.user.count({
      where: { id: session.user.id, passwordHash: { not: null } },
    }).then((c) => c > 0),
    prisma.setting.findUnique({ where: { key: "discordInviteUrl" } }),
    prisma.pushSubscription.findMany({
      where: { userId: session.user.id },
      select: { id: true, endpoint: true, label: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.setting.findUnique({ where: { key: "maxPushSubscriptions" } }),
    prisma.authSession.findMany({
      where: { userId: session.user.id },
      orderBy: { lastSeenAt: "desc" },
      select: {
        id: true, sessionId: true, deviceType: true, deviceLabel: true,
        ipAddress: true, createdAt: true, lastSeenAt: true, expiresAt: true,
      },
    }),
  ]);
  const discordInviteUrl = discordInviteSetting?.value || null;
  const pushCap = maxPushSetting?.value ? parseInt(maxPushSetting.value, 10) || 5 : 5;
  const currentSessionId = session.sessionId;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Profile</h1>
      <p className="text-zinc-400 text-sm mb-8">Manage your account and integrations</p>

      <div className="max-w-2xl lg:max-w-6xl lg:grid lg:grid-cols-2 lg:gap-6">

        <div className="space-y-6">
          <Card className="bg-zinc-900 border-zinc-800 p-6">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-zinc-400">
                <User className="h-5 w-5" />
              </div>
              <div>
                {user?.name && <p className="font-semibold text-white">{user.name}</p>}
                <p className="text-sm text-zinc-400">{user?.email}</p>
              </div>
            </div>
          </Card>

          <Card className="bg-zinc-900 border-zinc-800 p-6">
            <div className="mb-5">
              <h2 className="font-semibold text-white text-lg">Discord</h2>
              <p className="text-sm text-zinc-500 mt-0.5">
                Link your Discord account to request media directly from Discord.
              </p>
            </div>
            <DiscordLinkSection linkedDiscordId={user?.discordId ?? null} discordInviteUrl={discordInviteUrl} />
          </Card>

          {session.user.provider === "credentials" && (
            <Card className="bg-zinc-900 border-zinc-800 p-6">
              <div className="mb-5">
                <h2 className="font-semibold text-white text-lg">Change Password</h2>
                <p className="text-sm text-zinc-500 mt-0.5">Update your local login password.</p>
              </div>
              <ChangePassword hasPassword={hasPassword} />
            </Card>
          )}

          <Card className="bg-zinc-900 border-zinc-800 p-6">
            <div className="mb-4">
              <h2 className="font-semibold text-white text-lg">Active Sessions</h2>
              <p className="text-sm text-zinc-500 mt-0.5">
                Devices currently signed in. Revoke any session you don&apos;t recognise.
              </p>
            </div>
            <AuthSessions
              sessions={authSessions.map((s) => ({
                ...s,
                isCurrent: s.sessionId === currentSessionId,
              }))}
            />
          </Card>
        </div>

        <div className="space-y-6 mt-6 lg:mt-0">
          <Card className="bg-zinc-900 border-zinc-800 p-6">
            <div className="mb-4">
              <h2 className="font-semibold text-white text-lg">Notification Preferences</h2>
              <p className="text-sm text-zinc-500 mt-0.5">
                Choose which notifications you receive via Discord and email.
              </p>
            </div>
            <NotificationPrefs
              discordLinked={!!user?.discordId}
              isAdminRole={user?.role === "ADMIN" || user?.role === "ISSUE_ADMIN"}
              isJellyfin={session.user.provider === "jellyfin" || session.user.provider === "jellyfin-quickconnect"}
              notificationEmail={user?.notificationEmail ?? null}
              notifyOnApproved={user?.notifyOnApproved ?? true}
              notifyOnAvailable={user?.notifyOnAvailable ?? true}
              notifyOnDeclined={user?.notifyOnDeclined ?? true}
              emailOnApproved={user?.emailOnApproved ?? false}
              emailOnAvailable={user?.emailOnAvailable ?? false}
              emailOnDeclined={user?.emailOnDeclined ?? false}
              pushOnApproved={user?.pushOnApproved ?? true}
              pushOnAvailable={user?.pushOnAvailable ?? true}
              pushOnDeclined={user?.pushOnDeclined ?? true}
              notifyOnIssue={user?.notifyOnIssue ?? true}
            />
          </Card>

          <Card className="bg-zinc-900 border-zinc-800 p-6">
            <div className="mb-4">
              <h2 className="font-semibold text-white text-lg">Push Devices</h2>
              <p className="text-sm text-zinc-500 mt-0.5">
                Devices registered for push notifications. Remove any you no longer use.
              </p>
            </div>
            <PushDevices devices={pushDevices} cap={pushCap} />
          </Card>
        </div>

      </div>
    </div>
  );
}
