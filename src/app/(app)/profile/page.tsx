import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { DiscordLinkSection } from "@/components/discord-link-ui";
import { NotificationPrefs } from "@/components/profile/notification-prefs";
import { PushDevices } from "@/components/profile/push-devices";
import { AuthSessions } from "@/components/profile/auth-sessions";
import { ChangePassword } from "@/components/profile/change-password";
import { User } from "lucide-react";
import { PageHeader } from "@/components/ui/design";

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
    <div className="ds-page-enter">
      <PageHeader
        title="Profile"
        subtitle="Manage your account and integrations"
      />

      <div className="max-w-2xl lg:max-w-6xl lg:grid lg:grid-cols-2 lg:gap-6">
        <div className="flex flex-col" style={{ gap: 20 }}>
          <ProfileCard>
            <div className="flex items-center" style={{ gap: 14 }}>
              <div
                className="flex shrink-0 items-center justify-center rounded-full"
                style={{
                  width: 44,
                  height: 44,
                  background: "var(--ds-bg-3)",
                  color: "var(--ds-fg-muted)",
                  border: "1px solid var(--ds-border)",
                }}
              >
                <User style={{ width: 18, height: 18 }} />
              </div>
              <div>
                {user?.name && (
                  <p
                    className="font-semibold"
                    style={{
                      fontSize: 14,
                      color: "var(--ds-fg)",
                      margin: 0,
                    }}
                  >
                    {user.name}
                  </p>
                )}
                <p
                  style={{
                    fontSize: 12,
                    color: "var(--ds-fg-muted)",
                    margin: 0,
                  }}
                >
                  {user?.email}
                </p>
              </div>
            </div>
          </ProfileCard>

          <ProfileCard
            title="Discord"
            description="Link your Discord account to request media directly from Discord."
          >
            <DiscordLinkSection
              linkedDiscordId={user?.discordId ?? null}
              discordInviteUrl={discordInviteUrl}
            />
          </ProfileCard>

          {session.user.provider === "credentials" && (
            <ProfileCard
              title="Change Password"
              description="Update your local login password."
            >
              <ChangePassword hasPassword={hasPassword} />
            </ProfileCard>
          )}

          <ProfileCard
            title="Active Sessions"
            description="Devices currently signed in. Revoke any session you don't recognise."
          >
            <AuthSessions
              sessions={authSessions.map((s) => ({
                ...s,
                isCurrent: s.sessionId === currentSessionId,
              }))}
            />
          </ProfileCard>
        </div>

        <div
          className="flex flex-col lg:mt-0"
          style={{ gap: 20, marginTop: 20 }}
        >
          <ProfileCard
            title="Notification Preferences"
            description="Choose which notifications you receive via Discord and email."
          >
            <NotificationPrefs
              discordLinked={!!user?.discordId}
              isAdminRole={
                user?.role === "ADMIN" || user?.role === "ISSUE_ADMIN"
              }
              isJellyfin={
                session.user.provider === "jellyfin" ||
                session.user.provider === "jellyfin-quickconnect"
              }
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
          </ProfileCard>

          <ProfileCard
            title="Push Devices"
            description="Devices registered for push notifications. Remove any you no longer use."
          >
            <PushDevices devices={pushDevices} cap={pushCap} />
          </ProfileCard>
        </div>
      </div>
    </div>
  );
}

function ProfileCard({
  title,
  description,
  children,
}: {
  title?: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        padding: 20,
        background: "var(--ds-bg-2)",
        border: "1px solid var(--ds-border)",
        borderRadius: 10,
      }}
    >
      {(title || description) && (
        <div style={{ marginBottom: 16 }}>
          {title && (
            <h2
              className="font-semibold"
              style={{
                fontSize: 15,
                letterSpacing: "-0.01em",
                color: "var(--ds-fg)",
                margin: 0,
              }}
            >
              {title}
            </h2>
          )}
          {description && (
            <p
              style={{
                fontSize: 12,
                color: "var(--ds-fg-muted)",
                margin: "4px 0 0",
              }}
            >
              {description}
            </p>
          )}
        </div>
      )}
      {children}
    </section>
  );
}
