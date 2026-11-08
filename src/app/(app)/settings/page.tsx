import { authActive } from "@/lib/auth";
import { getSettingDecryptFailures } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { first, type PageSearchParams } from "@/lib/search-params";
import { hasPermission, Permission } from "@/lib/permissions";
import { PageHeader } from "@/components/ui/design";
import { SettingsTabNav, type TabId } from "@/components/settings/settings-tab-nav";
import { SettingsNav } from "@/components/settings/settings-nav";
import { getLocale, getTranslator } from "@/lib/i18n/server";
import type { Locale } from "@/lib/i18n/locales";
import type { Translator } from "@/lib/i18n/translate";
import { TAB_SECTIONS, settingsTab } from "./_tabs/sections";
import { readSettings, type SettingsOf } from "./_tabs/settings-data";
import { SITE_TAB_KEYS, SiteTab } from "./_tabs/site-tab";
import { MEDIA_TAB_KEYS, MediaTab } from "./_tabs/media-tab";
import { NOTIFICATIONS_TAB_KEYS, NotificationsTab } from "./_tabs/notifications-tab";
import { INTEGRATIONS_TAB_KEYS, IntegrationsTab } from "./_tabs/integrations-tab";
import { FeaturesTab } from "./_tabs/features-tab";
import { SYSTEM_TAB_KEYS, SystemTab } from "./_tabs/system-tab";

export const dynamic = "force-dynamic";

// The selected tab with the Setting rows it renders — only those.
type LoadedTab =
  | { tab: "site"; cfg: SettingsOf<typeof SITE_TAB_KEYS> }
  | { tab: "media"; cfg: SettingsOf<typeof MEDIA_TAB_KEYS> }
  | { tab: "notifications"; cfg: SettingsOf<typeof NOTIFICATIONS_TAB_KEYS> }
  | { tab: "integrations"; cfg: SettingsOf<typeof INTEGRATIONS_TAB_KEYS> }
  | { tab: "features" }
  | { tab: "system"; cfg: SettingsOf<typeof SYSTEM_TAB_KEYS> };

async function loadTab(tab: TabId): Promise<LoadedTab> {
  switch (tab) {
    case "site": return { tab, cfg: await readSettings(SITE_TAB_KEYS) };
    case "media": return { tab, cfg: await readSettings(MEDIA_TAB_KEYS) };
    case "notifications": return { tab, cfg: await readSettings(NOTIFICATIONS_TAB_KEYS) };
    case "integrations": return { tab, cfg: await readSettings(INTEGRATIONS_TAB_KEYS) };
    case "features": return { tab };
    case "system": return { tab, cfg: await readSettings(SYSTEM_TAB_KEYS) };
  }
}

// Each tab loads the rest of its own data itself.
function TabPanel({ loaded, t, locale }: { loaded: LoadedTab; t: Translator; locale: Locale }) {
  switch (loaded.tab) {
    case "site": return <SiteTab cfg={loaded.cfg} t={t} />;
    case "media": return <MediaTab cfg={loaded.cfg} t={t} />;
    case "notifications": return <NotificationsTab cfg={loaded.cfg} t={t} />;
    case "integrations": return <IntegrationsTab cfg={loaded.cfg} t={t} />;
    case "features": return <FeaturesTab t={t} />;
    case "system": return <SystemTab cfg={loaded.cfg} t={t} locale={locale} />;
  }
}

// Settings the server could not decrypt (a changed TOKEN_ENCRYPTION_KEY): the
// operator has to re-save each one.
function DecryptFailureBanner({ keys, t }: { keys: string[]; t: Translator }) {
  return (
    <div
      role="alert"
      style={{
        padding: 16,
        // Theme tokens, not raw rgba/hex: the old #fca5a5 text was a
        // dark-theme pink that read ~1.8:1 on the light theme (guardrail 42).
        background: "color-mix(in oklab, var(--ds-danger) 8%, transparent)",
        border: "1px solid color-mix(in oklab, var(--ds-danger) 35%, transparent)",
        borderRadius: 10,
        marginBottom: 16,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div
          aria-hidden
          style={{
            flexShrink: 0,
            width: 22,
            height: 22,
            borderRadius: 999,
            background: "color-mix(in oklab, var(--ds-danger) 18%, transparent)",
            color: "var(--ds-danger)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 13,
            fontWeight: 700,
            lineHeight: 1,
          }}
        >
          !
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--ds-danger)", margin: 0 }}>
            {t("settings.decrypt.title", { count: keys.length })}
          </h3>
          <p style={{ fontSize: 12, color: "var(--ds-fg-muted)", margin: "4px 0 8px", lineHeight: 1.5 }}>
            {t("settings.decrypt.bodyBefore", { count: keys.length })}{" "}
            <code style={{ fontFamily: "var(--font-mono, ui-monospace)" }}>TOKEN_ENCRYPTION_KEY</code>{" "}
            {t("settings.decrypt.bodyAfter")}
          </p>
          <ul style={{ fontSize: 12, color: "var(--ds-fg)", margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
            {keys.map((k) => (
              <li key={k}>
                <code style={{ fontFamily: "var(--font-mono, ui-monospace)" }}>{k}</code>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  const [sp, session] = await Promise.all([searchParams, authActive()]);
  if (!session || !hasPermission(session.user.permissions, Permission.ADMIN)) redirect("/");

  const tab = settingsTab(first(sp.tab));
  const [t, locale, loaded] = await Promise.all([getTranslator(), getLocale(), loadTab(tab)]);
  // Read AFTER the tab's settings, so the list reflects this render's decrypt
  // outcomes for them. safeDecryptSettingValue clears an entry on a successful
  // read, so the banner disappears on the next load after the operator
  // re-saves; a failure another read recorded stays listed until then.
  const decryptFailures = getSettingDecryptFailures();
  const sections = TAB_SECTIONS[tab];

  return (
    <div className="ds-page-enter">
      <PageHeader
        title={t("nav.settings")}
        subtitle={t("settings.subtitle")}
      />

      {decryptFailures.length > 0 && <DecryptFailureBanner keys={decryptFailures} t={t} />}

      <SettingsTabNav activeTab={tab} />

      <div className="lg:flex lg:gap-8" style={{ marginTop: 24 }}>
        {sections.length > 1 && (
          <aside className="hidden lg:block w-48 shrink-0">
            <div className="sticky top-4">
              <SettingsNav
                items={sections.map((sec) => ({ id: sec.id, label: t(sec.i18nKey), group: t(sec.group) }))}
              />
            </div>
          </aside>
        )}
        {/* `settings-sections` gives every direct child with an id a
            scroll-margin-top (globals.css) so the side-nav's plain #hash
            anchors land below the sticky chrome instead of flush against it. */}
        <div className="settings-sections max-w-3xl flex-1 flex flex-col" style={{ gap: 16 }}>
          <TabPanel loaded={loaded} t={t} locale={locale} />
        </div>
      </div>
    </div>
  );
}
