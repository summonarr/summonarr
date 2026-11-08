import { authActive } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { readPushSubscriptionCap } from "@/lib/push-cap";
import { isNotificationEmailEnabled } from "@/lib/email";
import { resolveUserNotificationEmail } from "@/lib/notification-email";
import { canSetOwnNotificationEmail, parseVerifyIdentifier, verifyIdentifierPrefixFor } from "@/lib/notification-email-verify";
import { redirect } from "next/navigation";
import { DiscordLinkSection } from "@/components/discord-link-ui";
import { NotificationPrefs, type NotificationPrefValues } from "@/components/profile/notification-prefs";
import { PushDevices } from "@/components/profile/push-devices";
import { AuthSessions } from "@/components/profile/auth-sessions";
import { ChangePassword } from "@/components/profile/change-password";
import { DeleteAccount } from "@/components/profile/delete-account";
import { AutoRequestPrefs } from "@/components/profile/auto-request-prefs";
import { TraktConnect } from "@/components/profile/trakt-connect";
import { CalendarFeed } from "@/components/profile/calendar-feed";
import { isFeatureEnabled } from "@/lib/features";
import { canAutoRequest, hasPermission, Permission } from "@/lib/permissions";
import { WATCHLIST_AUTO_REQUEST_FEATURE_KEY } from "@/lib/auto-request";
import { getPlexWatchlistConnection } from "@/lib/plex-watchlist";
import { getTraktProfileState } from "@/lib/trakt-user";
import { CALENDAR_FEATURE_KEY } from "@/lib/calendar-feed";
import { TwoFactorSettings } from "@/components/profile/two-factor";
import { getMfaState } from "@/lib/mfa/mfa-store";
import { adminMfaPolicyApplies, REQUIRE_MFA_FOR_ADMINS_KEY } from "@/lib/mfa/policy";
import { webAuthnConfigFromEnv } from "@/lib/mfa/webauthn";
import { User } from "@/components/icons";
import { PageHeader } from "@/components/ui/design";
import { getTranslator } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

const NOTIFICATION_PREF_KEYS = [
  "notifyOnApproved", "notifyOnAvailable", "notifyOnDeclined", "notifyOnComment",
  "emailOnApproved", "emailOnAvailable", "emailOnDeclined", "emailOnComment",
  "pushOnApproved", "pushOnAvailable", "pushOnDeclined", "pushOnComment",
  "notifyOnIssue",
] as const satisfies readonly (keyof NotificationPrefValues)[];
type NotificationPrefKey = (typeof NOTIFICATION_PREF_KEYS)[number];

// The most sessions listed. Native sessions never expire (guardrail 6c), so a
// long-lived account's list only shrinks when the user revokes; newest first,
// so the current device is always on it.
const AUTH_SESSIONS_SHOWN = 100;

export default async function ProfilePage() {
  const session = await authActive();
  if (!session) redirect("/login");

  const [user, hasPassword, discordInviteSetting, pushDevices, pushCap, authSessions, emailEnabled, calendarEnabled] = await Promise.all([
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: {
        name: true, email: true, discordId: true, role: true, mediaServer: true,
        notificationEmail: true,
        notifyOnApproved: true, notifyOnAvailable: true, notifyOnDeclined: true,
        emailOnApproved: true, emailOnAvailable: true, emailOnDeclined: true,
        pushOnApproved: true, pushOnAvailable: true, pushOnDeclined: true,
        notifyOnIssue: true,
        notifyOnComment: true, emailOnComment: true, pushOnComment: true,
        plexWatchlistAutoRequest: true, plexWatchlistOptInAt: true,
        calendarTokenHash: true, calendarTokenCreatedAt: true,
      },
    }),
    prisma.user.count({
      where: { id: session.user.id, passwordHash: { not: null } },
    }).then((c) => c > 0),
    prisma.setting.findUnique({ where: { key: "discordInviteUrl" } }),
    prisma.pushSubscription.findMany({
      where: { userId: session.user.id },
      // Deliberately NOT selecting `endpoint`: nothing here needs it (device
      // management keys off `id`), a web row's is the browser's push-service
      // capability URL, and an iOS row's is a hash of its APNs token
      // (apns-endpoint.ts) — older rows carried the raw token until migrated.
      select: { id: true, label: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
    // The cap the push routes enforce, through the same reader (push-cap.ts).
    readPushSubscriptionCap(),
    // A row past its deadline is dead but stays until the purge cron sweeps it
    // (guardrail 6c) — list only live devices, as GET /api/sessions does.
    prisma.authSession.findMany({
      where: { userId: session.user.id, expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: "desc" },
      take: AUTH_SESSIONS_SHOWN + 1,
      select: {
        id: true, sessionId: true, deviceType: true, deviceLabel: true,
        ipAddress: true, createdAt: true, lastSeenAt: true, expiresAt: true,
      },
    }),
    isNotificationEmailEnabled(),
    isFeatureEnabled(CALENDAR_FEATURE_KEY),
  ]);
  // The row is gone (the account was deleted mid-request): nothing to show.
  // Outside any try/catch, so the redirect is never swallowed (guardrail 29).
  if (!user) redirect("/login");
  // Watchlist auto-request section: only for a user who can use it. The
  // permission check is free; the flag and token reads only run for them.
  const autoRequestPermitted =
    canAutoRequest(session.user.permissions, "MOVIE") || canAutoRequest(session.user.permissions, "TV");
  const loadAutoRequest = async () => {
    if (!autoRequestPermitted) return { autoRequestEnabled: false, plexConnected: false, plexWatchlistConnection: null };
    const [autoRequestEnabled, plexAccount] = await Promise.all([
      isFeatureEnabled(WATCHLIST_AUTO_REQUEST_FEATURE_KEY),
      prisma.account.findFirst({ where: { userId: session.user.id, provider: "plex" }, select: { id: true } }),
    ]);
    const plexWatchlistConnection = autoRequestEnabled
      ? await getPlexWatchlistConnection(
          {
            id: session.user.id,
            plexWatchlistOptInAt: user.plexWatchlistOptInAt,
            plexWatchlistAutoRequest: user.plexWatchlistAutoRequest,
          },
          plexAccount !== null,
        )
      : null;
    return { autoRequestEnabled, plexConnected: plexAccount !== null, plexWatchlistConnection };
  };
  const discordInviteUrl = discordInviteSetting?.value || null;

  // Jellyfin users verify a notification address by emailed link; the pending
  // address lives only in the VerificationToken row (/api/profile/notification-email
  // keeps one per user under `verifyIdentifierPrefixFor`). Surface it so a reload
  // shows "verification pending" with a resend instead of a blank field.
  const isJellyfinUser = canSetOwnNotificationEmail(session.user.provider);

  // Two-factor is offered only to local-credentials accounts (guardrail 6d).
  const mfaAvailable = session.user.provider === "credentials" && hasPassword;

  // The sections below read independently of each other, so they load together.
  const [
    { autoRequestEnabled, plexConnected, plexWatchlistConnection },
    trakt,
    pendingVerification,
    [mfaState, requireMfaRow],
    t,
  ] = await Promise.all([
    loadAutoRequest(),
    // The Trakt card: shown while the admin's Trakt app is configured and the
    // user has a use for it — or while they are connected, so they can always
    // disconnect even after the admin switched the uses off.
    getTraktProfileState(session.user.id, session.user.permissions),
    isJellyfinUser && emailEnabled
      ? prisma.verificationToken.findFirst({
          where: {
            identifier: { startsWith: verifyIdentifierPrefixFor(session.user.id) },
            expires: { gt: new Date() },
          },
          select: { identifier: true },
        })
      : null,
    mfaAvailable
      ? Promise.all([
          getMfaState(session.user.id),
          prisma.setting.findUnique({ where: { key: REQUIRE_MFA_FOR_ADMINS_KEY } }),
        ])
      : ([null, null] as const),
    getTranslator(),
  ]);
  const showTrakt = trakt.available || trakt.connected || trakt.status === "reauth";
  const pendingEmail = pendingVerification ? (parseVerifyIdentifier(pendingVerification.identifier)?.email ?? null) : null;
  const mfaRequired =
    !!mfaState &&
    !mfaState.enabled &&
    adminMfaPolicyApplies({ role: session.user.role, provider: session.user.provider, settingValue: requireMfaRow?.value });
  const currentSessionId = session.sessionId;
  const webauthnAvailable = webAuthnConfigFromEnv() !== null;
  // The step-up the password change and the account deletion both ask for.
  const secondFactor = mfaState
    ? { enabled: mfaState.enabled, hasPasskeys: mfaState.passkeys.length > 0, webauthnAvailable }
    : undefined;

  return (
    <div className="ds-page-enter">
      <PageHeader
        title={t("profile.title")}
        subtitle={t("profile.subtitle")}
      />

      <div className="max-w-2xl lg:max-w-6xl lg:grid lg:grid-cols-2 lg:gap-6">
        <div className="flex flex-col" style={{ gap: 20 }}>
          <ProfileIdentity name={user.name} email={user.email} />

          <ProfileCard
            title="Discord"
            description={t("profile.discord.description")}
          >
            <DiscordLinkSection
              linkedDiscordId={user.discordId}
              discordInviteUrl={discordInviteUrl}
            />
          </ProfileCard>

          {session.user.provider === "credentials" && (
            <ProfileCard
              title={t("profile.password.title")}
              description={t("profile.password.description")}
            >
              <ChangePassword
                hasPassword={hasPassword}
                secondFactor={secondFactor}
              />
            </ProfileCard>
          )}

          {mfaState && (
            <ProfileCard
              id="two-factor"
              title={t("profile.mfa.title")}
              description={t("profile.mfa.description")}
            >
              <TwoFactorSettings
                required={mfaRequired}
                initial={{
                  enabled: mfaState.enabled,
                  totpEnabled: mfaState.totpEnabled,
                  passkeys: mfaState.passkeys.map((p) => ({
                    id: p.id,
                    name: p.name,
                    backedUp: p.backedUp,
                    createdAt: p.createdAt.toISOString(),
                    lastUsedAt: p.lastUsedAt?.toISOString() ?? null,
                  })),
                  recoveryCodesRemaining: mfaState.recoveryRemaining,
                  webauthnAvailable,
                }}
              />
            </ProfileCard>
          )}

          <ProfileCard
            id="sessions"
            title={t("profile.sessions.title")}
            description={t("profile.sessions.description")}
          >
            {authSessions.length > AUTH_SESSIONS_SHOWN && (
              <p role="status" className="mb-3 text-xs" style={{ color: "var(--ds-fg-subtle)" }}>
                {t("profile.sessions.capped", { cap: AUTH_SESSIONS_SHOWN })}
              </p>
            )}
            <AuthSessions
              sessions={authSessions.slice(0, AUTH_SESSIONS_SHOWN).map((s) => ({
                ...s,
                isCurrent: s.sessionId === currentSessionId,
              }))}
            />
          </ProfileCard>

          <ProfileCard
            title={t("profile.close.title")}
            description={t("profile.close.description")}
          >
            <DeleteAccount
              requiresPassword={hasPassword}
              secondFactor={secondFactor}
            />
          </ProfileCard>
        </div>

        <div
          className="flex flex-col mt-5 lg:mt-0"
          style={{ gap: 20 }}
        >
          <ProfileCard
            title={t("profile.notifications.title")}
            description={t("profile.notifications.description")}
          >
            <NotificationPrefs
              emailEnabled={emailEnabled}
              discordLinked={!!user.discordId}
              isAdminRole={user.role === "ADMIN" || user.role === "ISSUE_ADMIN"}
              isJellyfin={isJellyfinUser}
              pendingEmail={pendingEmail}
              notificationEmail={resolveUserNotificationEmail({
                email: user.email,
                notificationEmail: user.notificationEmail,
              })}
              prefs={notificationPrefsOf(user)}
            />
          </ProfileCard>

          {autoRequestEnabled && (
            <ProfileCard
              title={t("profile.autoRequest.title")}
              description={t("profile.autoRequest.description")}
            >
              <AutoRequestPrefs
                initialPlexWatchlist={user.plexWatchlistAutoRequest}
                plexConnected={plexConnected}
                serverSource={plexWatchlistConnection?.serverSource ?? false}
                serverOptedIn={plexWatchlistConnection?.serverOptedIn ?? false}
                serverStatus={plexWatchlistConnection?.serverStatus ?? null}
              />
            </ProfileCard>
          )}

          {showTrakt && (
            <ProfileCard
              id="trakt"
              title={t("profile.trakt.title")}
              description={t("profile.trakt.description")}
            >
              <TraktConnect
                connected={trakt.connected}
                username={trakt.username}
                watchlistAutoRequest={trakt.watchlistAutoRequest}
                historySeeds={trakt.historySeeds}
                status={trakt.status}
                syncedAt={trakt.syncedAt}
                uses={trakt.uses}
                isJellyfin={isJellyfinUser || user.mediaServer === "jellyfin"}
              />
            </ProfileCard>
          )}

          <ProfileCard
            title={t("profile.push.title")}
            description={t("profile.push.description")}
          >
            <PushDevices devices={pushDevices} cap={pushCap} />
          </ProfileCard>

          {calendarEnabled && (
            <ProfileCard
              id="calendar-feed"
              title={t("profile.calendar.title")}
              description={t("profile.calendar.description")}
            >
              <CalendarFeed
                enabled={!!user.calendarTokenHash}
                createdAt={user.calendarTokenHash ? (user.calendarTokenCreatedAt?.toISOString() ?? null) : null}
                canSubscribeAll={hasPermission(session.user.permissions, Permission.MANAGE_REQUESTS)}
              />
            </ProfileCard>
          )}
        </div>
      </div>
    </div>
  );
}

// The notification switches the prefs form starts from.
function notificationPrefsOf(user: Record<NotificationPrefKey, boolean>): NotificationPrefValues {
  const out = {} as Record<NotificationPrefKey, boolean>;
  for (const key of NOTIFICATION_PREF_KEYS) out[key] = user[key];
  return out;
}

// The account's name and sign-in email, at the top of the page.
function ProfileIdentity({ name, email }: { name: string | null; email: string }) {
  return (
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
        <div className="min-w-0">
          {name && (
            <p
              className="font-semibold"
              style={{
                fontSize: 14,
                color: "var(--ds-fg)",
                margin: 0,
              }}
            >
              {name}
            </p>
          )}
          <p
            className="break-all"
            style={{
              fontSize: 12,
              color: "var(--ds-fg-muted)",
              margin: 0,
            }}
          >
            {email}
          </p>
        </div>
      </div>
    </ProfileCard>
  );
}

function ProfileCard({
  id,
  title,
  description,
  children,
}: {
  id?: string;
  title?: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      style={{
        scrollMarginTop: 80,
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
