"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle, XCircle, Loader2, ChevronDown, ExternalLink } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import { withBasePath } from "@/lib/base-path";
import { useHasMounted } from "@/hooks/use-has-mounted";
import type { SaveStatus } from "./shared";
import { useT } from "@/components/i18n/i18n-provider";
import { rich } from "./rich";

interface DiscordBotFormProps {
  initialBotToken: string;
  initialClientId: string;
  initialGuildId: string;
  initialPublicKey: string;
  initialAutoApproveRoles: string;
  initialRequireLinkedAccount: boolean;
  initialRequireLinkedAccountSite: boolean;
  initialAdminRequestChannelId: string;
  initialWelcomeChannelId: string;
  initialNotifyChannelId: string;
  initialInviteUrl: string;
  initialLinkedRoleId: string;
  initialPlexRoleId: string;
  initialJellyfinRoleId: string;
  initialAdminRoleId: string;
  initialIssueAdminRoleId: string;
}

export function DiscordBotForm({ initialBotToken, initialClientId, initialGuildId, initialPublicKey, initialAutoApproveRoles, initialRequireLinkedAccount, initialRequireLinkedAccountSite, initialAdminRequestChannelId, initialWelcomeChannelId, initialNotifyChannelId, initialInviteUrl, initialLinkedRoleId, initialPlexRoleId, initialJellyfinRoleId, initialAdminRoleId, initialIssueAdminRoleId }: DiscordBotFormProps) {
  const t = useT();
  // Highlights a Discord UI term inside a translated guide sentence. The terms
  // themselves come from the catalog (settings.form.discord.portal.*): the
  // Developer Portal is localized, so a French admin follows French menu names.
  const hl = (node: React.ReactNode) => <span className="text-zinc-300">{node}</span>;
  const portal = (term: string) => hl(t(`settings.form.discord.portal.${term}`));
  const [botToken,          setBotToken]          = useState(initialBotToken);
  const [clientId,          setClientId]          = useState(initialClientId);
  const [guildId,           setGuildId]           = useState(initialGuildId);
  const [publicKey,         setPublicKey]         = useState(initialPublicKey);
  const [autoApproveRoles,       setAutoApproveRoles]       = useState(initialAutoApproveRoles);
  const [requireLinkedAccount,     setRequireLinkedAccount]     = useState(initialRequireLinkedAccount);
  const [requireLinkedAccountSite, setRequireLinkedAccountSite] = useState(initialRequireLinkedAccountSite);
  const [adminRequestChannelId,    setAdminRequestChannelId]    = useState(initialAdminRequestChannelId);
  const [welcomeChannelId,       setWelcomeChannelId]       = useState(initialWelcomeChannelId);
  const [notifyChannelId,        setNotifyChannelId]        = useState(initialNotifyChannelId);
  const [inviteUrl,         setInviteUrl]         = useState(initialInviteUrl);
  const [linkedRoleId,      setLinkedRoleId]      = useState(initialLinkedRoleId);
  const [plexRoleId,        setPlexRoleId]        = useState(initialPlexRoleId);
  const [jellyfinRoleId,    setJellyfinRoleId]    = useState(initialJellyfinRoleId);
  const [adminRoleId,       setAdminRoleId]       = useState(initialAdminRoleId);
  const [issueAdminRoleId,  setIssueAdminRoleId]  = useState(initialIssueAdminRoleId);
  const [status,           setStatus]           = useState<SaveStatus>("idle");
  const [message,          setMessage]          = useState("");
  const [guideOpen,        setGuideOpen]        = useState(false);
  const [regStatus,        setRegStatus]        = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [regMessage,       setRegMessage]       = useState("");
  const [syncRolesStatus,  setSyncRolesStatus]  = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [syncRolesMessage, setSyncRolesMessage] = useState("");
  const [tab, setTab] = useState<"core" | "channels" | "roles">("core");
  const mounted = useHasMounted();
  // The last values we know the server has saved, one entry per setting key.
  // It starts as the page-load values and is updated after every successful
  // save. We can't just compare against the `initial*` props: they never
  // refresh, so after one save an already-saved field would be sent again
  // (and hit the route's 10s per-key cooldown, a 429), and changing a field
  // back to its page-load value would look like "no change" and never be saved.
  const savedRef = useRef<Record<string, string> | null>(null);
  // Fade timers for the three result lines (save, register, sync roles). Only
  // a success fades; an error (a bad snowflake, the 10s write cooldown) stays
  // until the next edit or attempt. Ref'd so a new attempt cancels the previous
  // timer instead of letting it reset "saving" mid-flight; cleared on unmount.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const regTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    for (const timer of [saveTimer, regTimer, syncTimer]) {
      if (timer.current) clearTimeout(timer.current);
    }
  }, []);

  // Discord sends slash-command events to /api/interactions (with BASE_PATH added).
  // Show this site's real address so admins can paste it into the Developer Portal.
  // Until the component has mounted in the browser we show a placeholder instead,
  // because `window` doesn't exist during server rendering (guardrail 16).
  const interactionsEndpoint = mounted
    ? `${window.location.origin}${withBasePath("/api/interactions")}`
    : "https://<your-domain>/api/interactions";

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setStatus("saving");
    setMessage("");

    // Send only the fields that differ from the last saved values. Sending all 16
    // every time caused three problems: a Channels/Roles edit re-registered the
    // slash commands with Discord (the route does that whenever the ids are in
    // the body), every key got the 10s write cooldown (so saving another tab
    // within 10s failed with 429), and the audit log listed 16 "changed" keys
    // whose values hadn't changed.
    const fields: Array<[key: string, current: string, initial: string]> = [
      ["discordBotToken", botToken, initialBotToken],
      ["discordClientId", clientId, initialClientId],
      ["discordGuildId", guildId, initialGuildId],
      ["discordPublicKey", publicKey, initialPublicKey],
      ["discordAutoApproveRoles", autoApproveRoles, initialAutoApproveRoles],
      ["discordRequireLinkedAccount", requireLinkedAccount ? "true" : "false", initialRequireLinkedAccount ? "true" : "false"],
      ["discordRequireLinkedAccountSite", requireLinkedAccountSite ? "true" : "false", initialRequireLinkedAccountSite ? "true" : "false"],
      ["discordAdminRequestChannelId", adminRequestChannelId, initialAdminRequestChannelId],
      ["discordWelcomeChannelId", welcomeChannelId, initialWelcomeChannelId],
      ["discordNotifyChannelId", notifyChannelId, initialNotifyChannelId],
      ["discordInviteUrl", inviteUrl, initialInviteUrl],
      ["discordLinkedRoleId", linkedRoleId, initialLinkedRoleId],
      ["discordPlexRoleId", plexRoleId, initialPlexRoleId],
      ["discordJellyfinRoleId", jellyfinRoleId, initialJellyfinRoleId],
      ["discordAdminRoleId", adminRoleId, initialAdminRoleId],
      ["discordIssueAdminRoleId", issueAdminRoleId, initialIssueAdminRoleId],
    ];
    if (savedRef.current === null) {
      savedRef.current = Object.fromEntries(fields.map(([key, , initial]) => [key, initial]));
    }
    const saved = savedRef.current;
    const changed = Object.fromEntries(fields.filter(([key, current]) => current !== saved[key]).map(([key, current]) => [key, current]));
    if (Object.keys(changed).length === 0) {
      setMessage(t("settings.form.discord.noChanges"));
      setStatus("ok");
      saveTimer.current = setTimeout(() => setStatus("idle"), 5000);
      return;
    }

    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changed),
      });

      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };

      if (res.ok && data.ok) {
        Object.assign(saved, changed);
        setMessage(t("settings.form.discord.savedRestart"));
        setStatus("ok");
        saveTimer.current = setTimeout(() => setStatus("idle"), 5000);
      } else {
        setMessage(data.error ?? t("settings.form.common.saveFailed"));
        setStatus("error");
      }
    } catch {
      setMessage(t("settings.form.common.saveFailed"));
      setStatus("error");
    }
  }

  return (
    <div className="space-y-5">
      <div className="rounded-md border border-zinc-700 overflow-hidden">
        <button
          type="button"
          onClick={() => setGuideOpen((v) => !v)}
          aria-expanded={guideOpen}
          className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-zinc-300 hover:bg-zinc-800 transition-colors"
        >
          <span>{t("settings.form.discord.guide.title")}</span>
          <ChevronDown aria-hidden className={`w-4 h-4 text-zinc-500 transition-transform duration-200 ${guideOpen ? "rotate-180" : ""}`} />
        </button>

        {guideOpen && (
          <div className="px-4 pb-4 pt-1 border-t border-zinc-700 space-y-4 text-sm text-zinc-400">

            <div className="space-y-1">
              <p className="font-semibold text-zinc-200">{t("settings.form.discord.guide.s1.title")}</p>
              <p>{t("settings.form.discord.guide.s1.body")}</p>
              <a
                href="https://discord.com/developers/applications"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-indigo-400 hover:text-indigo-300 text-xs"
              >
                discord.com/developers/applications <ExternalLink className="w-3 h-3" />
              </a>
            </div>

            <div className="space-y-1">
              <p className="font-semibold text-zinc-200">{t("settings.form.discord.guide.s2.title")}</p>
              <p>
                {rich(t("settings.form.discord.guide.s2.body"), { bot: portal("bot"), reset: portal("resetToken"), field: hl(t("settings.form.discord.botToken")) })}
              </p>
              <p className="text-zinc-500 text-xs">
                {rich(t("settings.form.discord.guide.s2.note"), {
                  grant: <strong className="text-zinc-400">{t("settings.form.discord.portal.codeGrant")}</strong>,
                  off: <strong className="text-zinc-400">{t("settings.form.discord.portal.off")}</strong>,
                })}
              </p>
            </div>

            <div className="space-y-1">
              <p className="font-semibold text-zinc-200">{t("settings.form.discord.guide.s3.title")}</p>
              <p>
                {rich(t("settings.form.discord.guide.s3.body"), { page: portal("generalInformation"), appId: portal("applicationId"), publicKey: portal("publicKey") })}
              </p>
            </div>

            <div className="space-y-1">
              <p className="font-semibold text-zinc-200">{t("settings.form.discord.guide.s4.title")}</p>
              <p>
                {rich(t("settings.form.discord.guide.s4.body"), { devMode: portal("developerMode"), copyId: portal("copyServerId"), field: hl(t("settings.form.discord.guildId")) })}
              </p>
              <p className="text-zinc-500 text-xs">
                {t("settings.form.discord.guide.s4.note")}
              </p>
            </div>

            <div className="space-y-1">
              <p className="font-semibold text-zinc-200">{t("settings.form.discord.guide.s5.title")}</p>
              <p>{rich(t("settings.form.discord.guide.s5.body"), { register: hl(t("settings.form.discord.register")) })}</p>
            </div>

            <div className="space-y-1">
              <p className="font-semibold text-zinc-200">{t("settings.form.discord.guide.s6.title")}</p>
              <p>
                {rich(t("settings.form.discord.guide.s6.body"), { page: portal("generalInformation"), field: portal("interactionsEndpointUrl") })}
              </p>
              <code className="block break-all bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-xs font-mono text-zinc-300 mt-1">
                {interactionsEndpoint}
              </code>
              <p className="text-zinc-500 text-xs mt-1">
                {rich(t("settings.form.discord.guide.s6.note"), { save: <strong className="text-zinc-400">{t("settings.form.discord.portal.saveChanges")}</strong> })}
              </p>
            </div>

            <div className="space-y-1">
              <p className="font-semibold text-zinc-200">{t("settings.form.discord.guide.s7.title")}</p>
              <p>
                {rich(t("settings.form.discord.guide.s7.body"), {
                  generator: portal("urlGenerator"),
                  // `bot` / `applications.commands` are OAuth2 scope identifiers,
                  // not UI labels — they read the same in every portal language.
                  bot: hl("bot"),
                  commands: hl("applications.commands"),
                  send: portal("sendMessages"),
                  embed: portal("embedLinks"),
                  view: portal("viewChannels"),
                  url: <strong className="text-zinc-400">{t("settings.form.discord.portal.generatedUrl")}</strong>,
                })}
              </p>
              <p className="text-zinc-500 text-xs">
                {t("settings.form.discord.guide.s7.note")}
              </p>
            </div>

            <div className="space-y-1">
              <p className="font-semibold text-zinc-200">{t("settings.form.discord.guide.s8.title")} <span className="text-zinc-500 font-normal">{t("settings.form.common.optional")}</span></p>
              <p>
                {rich(t("settings.form.discord.guide.s8.body"), { mention: hl("@mention") })}
              </p>
              <ol className="list-decimal list-inside space-y-1 text-zinc-400 text-sm pl-1">
                <li>
                  {rich(t("settings.form.discord.guide.s8.step1"), { a: hl("#requests"), b: hl("#notifications") })}
                </li>
                <li>
                  {rich(t("settings.form.discord.guide.s8.step2"), { edit: portal("editChannel"), perms: portal("permissions"), view: portal("viewChannel"), send: portal("sendMessages") })}
                </li>
                <li>
                  {rich(t("settings.form.discord.guide.s8.step3"), { devMode: portal("developerMode"), path: portal("appSettingsAdvanced") })}
                </li>
                <li>
                  {rich(t("settings.form.discord.guide.s8.step4"), { copy: portal("copyChannelId") })}
                </li>
                <li>
                  {rich(t("settings.form.discord.guide.s8.step5"), { field: hl(t("settings.form.discord.notifyChannel")) })}
                </li>
              </ol>
              <p className="text-zinc-500 text-xs mt-1">
                {rich(t("settings.form.discord.guide.s8.note"), { format: <code className="text-zinc-400">@Username message</code> })}
              </p>
            </div>

            <div className="rounded-md bg-zinc-900 border border-zinc-700 px-3 py-3 space-y-1">
              <p className="font-semibold text-zinc-300 text-xs uppercase tracking-wide mb-2">{t("settings.form.discord.guide.commands")}</p>
              <div className="space-y-1.5 text-xs font-mono">
                <p><span className="text-indigo-400">/request</span> <span className="text-zinc-500">type:Movie|TV Show  query:&lt;title&gt;</span></p>
                <p className="text-zinc-500 pl-3">{t("settings.form.discord.guide.cmdRequest")}</p>
                <p className="mt-1"><span className="text-indigo-400">/status</span></p>
                <p className="text-zinc-500 pl-3">{t("settings.form.discord.guide.cmdStatus")}</p>
                <p className="mt-1"><span className="text-indigo-400">/link</span> <span className="text-zinc-500">token:&lt;8-char code&gt;</span></p>
                <p className="text-zinc-500 pl-3">{t("settings.form.discord.guide.cmdLink")}</p>
              </div>
            </div>

          </div>
        )}
      </div>

      <div
        role="tablist"
        aria-label={t("settings.form.discord.tabsLabel")}
        className="flex gap-1 border-b border-zinc-800"
        onKeyDown={(e) => {
          if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
          e.preventDefault();
          const tabs = ["core", "channels", "roles"] as const;
          const i = tabs.indexOf(tab);
          const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
          setTab(next);
          e.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus();
        }}
      >
        {(["core", "channels", "roles"] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`discord-tab-${id}`}
            aria-controls={`discord-panel-${id}`}
            data-tab={id}
            aria-selected={tab === id}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => setTab(id)}
            className={`px-4 py-2 text-sm font-medium capitalize transition-colors border-b-2 -mb-px ${
              tab === id
                ? "border-indigo-500 text-zinc-100"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {t(`settings.form.discord.tab.${id}`)}
          </button>
        ))}
      </div>

      {/* One panel element whose id follows the selected tab: the form (and its
          shared Save row) is the content every tab controls. */}
      <div role="tabpanel" id={`discord-panel-${tab}`} aria-labelledby={`discord-tab-${tab}`}>
      <form onSubmit={handleSave} className="space-y-4">
        {tab === "core" && (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="discord-token">{t("settings.form.discord.botToken")}</Label>
              <Input
                id="discord-token"
                type="password"
                value={botToken}
                onChange={(e) => { setBotToken(e.target.value); setStatus("idle"); }}
                placeholder="••••••••••••••••"
                className="bg-zinc-800 border-zinc-700 font-mono"
              />
              <p className="text-xs text-zinc-500">{t("settings.form.discord.botTokenHelp")}</p>
            </div>
            <div className="lg:grid lg:grid-cols-2 lg:gap-4 space-y-4 lg:space-y-0">
              <div className="space-y-1.5">
                <Label htmlFor="discord-client-id">{t("settings.form.discord.clientId")}</Label>
                <Input
                  id="discord-client-id"
                  value={clientId}
                  onChange={(e) => { setClientId(e.target.value); setStatus("idle"); }}
                  placeholder="123456789012345678"
                  className="bg-zinc-800 border-zinc-700 font-mono"
                />
                <p className="text-xs text-zinc-500">{t("settings.form.discord.clientIdHelp")}</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="discord-guild-id">{t("settings.form.discord.guildId")}</Label>
                <Input
                  id="discord-guild-id"
                  value={guildId}
                  onChange={(e) => { setGuildId(e.target.value); setStatus("idle"); }}
                  placeholder="123456789012345678"
                  className="bg-zinc-800 border-zinc-700 font-mono"
                />
                <p className="text-xs text-zinc-500">{t("settings.form.discord.guildIdHelp")}</p>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="discord-public-key">{t("settings.form.discord.publicKey")}</Label>
              <Input
                id="discord-public-key"
                value={publicKey}
                onChange={(e) => { setPublicKey(e.target.value); setStatus("idle"); }}
                placeholder="f8cf3a985f811b4e…"
                className="bg-zinc-800 border-zinc-700 font-mono"
              />
              <p className="text-xs text-zinc-500">{t("settings.form.discord.publicKeyHelp")}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="discord-auto-approve-roles">{t("settings.form.discord.autoApproveRoles")}</Label>
              <Input
                id="discord-auto-approve-roles"
                value={autoApproveRoles}
                onChange={(e) => { setAutoApproveRoles(e.target.value); setStatus("idle"); }}
                placeholder="123456789012345678, 987654321098765432"
                className="bg-zinc-800 border-zinc-700 font-mono"
              />
              <p className="text-xs text-zinc-500">
                {t("settings.form.discord.autoApproveRolesHelp")}
              </p>
            </div>
            <div className="flex items-start gap-3">
              <input
                type="checkbox"
                id="discord-require-linked-account"
                checked={requireLinkedAccount}
                onChange={(e) => { setRequireLinkedAccount(e.target.checked); setStatus("idle"); }}
                className="mt-0.5 h-4 w-4 rounded border-zinc-600 bg-zinc-800 accent-indigo-500"
              />
              <div>
                <Label htmlFor="discord-require-linked-account" className="cursor-pointer">{t("settings.form.discord.requireLinked")}</Label>
                <p className="text-xs text-zinc-500 mt-1">
                  {rich(t("settings.form.discord.requireLinkedHelp"), {
                    link: <code className="text-zinc-400">/link</code>,
                    request: <code className="text-zinc-400">/request</code>,
                    status: <code className="text-zinc-400">/status</code>,
                  })}
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <input
                type="checkbox"
                id="discord-require-linked-account-site"
                checked={requireLinkedAccountSite}
                onChange={(e) => { setRequireLinkedAccountSite(e.target.checked); setStatus("idle"); }}
                className="mt-0.5 h-4 w-4 rounded border-zinc-600 bg-zinc-800 accent-indigo-500"
              />
              <div>
                <Label htmlFor="discord-require-linked-account-site" className="cursor-pointer">{t("settings.form.discord.requireLinkedSite")}</Label>
                <p className="text-xs text-zinc-500 mt-1">
                  {t("settings.form.discord.requireLinkedSiteHelp")}
                </p>
              </div>
            </div>
          </>
        )}

        {tab === "channels" && (
          <>
            <div className="lg:grid lg:grid-cols-2 lg:gap-4 space-y-4 lg:space-y-0">
              <div className="space-y-1.5">
                <Label htmlFor="discord-admin-request-channel">{t("settings.form.discord.adminChannel")}</Label>
                <Input
                  id="discord-admin-request-channel"
                  value={adminRequestChannelId}
                  onChange={(e) => { setAdminRequestChannelId(e.target.value); setStatus("idle"); }}
                  placeholder="123456789012345678"
                  className="bg-zinc-800 border-zinc-700 font-mono"
                />
                <p className="text-xs text-zinc-500">
                  {rich(t("settings.form.discord.adminChannelHelp"), {
                    approve: <strong className="text-zinc-400">{t("settings.form.discord.approve")}</strong>,
                    decline: <strong className="text-zinc-400">{t("settings.form.discord.decline")}</strong>,
                  })}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="discord-welcome-channel">{t("settings.form.discord.welcomeChannel")}</Label>
                <Input
                  id="discord-welcome-channel"
                  value={welcomeChannelId}
                  onChange={(e) => { setWelcomeChannelId(e.target.value); setStatus("idle"); }}
                  placeholder="123456789012345678"
                  className="bg-zinc-800 border-zinc-700 font-mono"
                />
                <p className="text-xs text-zinc-500">
                  {rich(t("settings.form.discord.welcomeChannelHelp"), {
                    link: <code className="text-zinc-400">/link</code>,
                    request: <code className="text-zinc-400">/request</code>,
                    status: <code className="text-zinc-400">/status</code>,
                  })}
                </p>
              </div>
            </div>
            <div className="lg:grid lg:grid-cols-2 lg:gap-4 space-y-4 lg:space-y-0">
              <div className="space-y-1.5">
                <Label htmlFor="discord-notify-channel">{t("settings.form.discord.notifyChannel")}</Label>
                <Input
                  id="discord-notify-channel"
                  value={notifyChannelId}
                  onChange={(e) => { setNotifyChannelId(e.target.value); setStatus("idle"); }}
                  placeholder="123456789012345678"
                  className="bg-zinc-800 border-zinc-700 font-mono"
                />
                <p className="text-xs text-zinc-500">
                  {rich(t("settings.form.discord.notifyChannelHelp"), { mention: <code className="text-zinc-400">@mention</code> })}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="discord-invite-url">{t("settings.form.discord.inviteUrl")}</Label>
                <Input
                  id="discord-invite-url"
                  value={inviteUrl}
                  onChange={(e) => { setInviteUrl(e.target.value); setStatus("idle"); }}
                  placeholder="https://discord.gg/xxxxxxxxx"
                  className="bg-zinc-800 border-zinc-700"
                />
                <p className="text-xs text-zinc-500">
                  {t("settings.form.discord.inviteUrlHelp")}
                </p>
              </div>
            </div>
          </>
        )}

        {tab === "roles" && (
          <>
            <div className="lg:grid lg:grid-cols-2 lg:gap-4 space-y-4 lg:space-y-0">
              <div className="space-y-1.5">
                <Label htmlFor="discord-linked-role-id">{t("settings.form.discord.linkedRole")}</Label>
                <Input
                  id="discord-linked-role-id"
                  value={linkedRoleId}
                  onChange={(e) => { setLinkedRoleId(e.target.value); setStatus("idle"); }}
                  placeholder="123456789012345678"
                  className="bg-zinc-800 border-zinc-700 font-mono"
                />
                <p className="text-xs text-zinc-500">
                  {t("settings.form.discord.linkedRoleHelp")}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="discord-plex-role-id">{t("settings.form.discord.plexRole")}</Label>
                <Input
                  id="discord-plex-role-id"
                  value={plexRoleId}
                  onChange={(e) => { setPlexRoleId(e.target.value); setStatus("idle"); }}
                  placeholder="123456789012345678"
                  className="bg-zinc-800 border-zinc-700 font-mono"
                />
                <p className="text-xs text-zinc-500">{t("settings.form.discord.plexRoleHelp")}</p>
              </div>
            </div>
            <div className="lg:grid lg:grid-cols-2 lg:gap-4 space-y-4 lg:space-y-0">
              <div className="space-y-1.5">
                <Label htmlFor="discord-jellyfin-role-id">{t("settings.form.discord.jellyfinRole")}</Label>
                <Input
                  id="discord-jellyfin-role-id"
                  value={jellyfinRoleId}
                  onChange={(e) => { setJellyfinRoleId(e.target.value); setStatus("idle"); }}
                  placeholder="123456789012345678"
                  className="bg-zinc-800 border-zinc-700 font-mono"
                />
                <p className="text-xs text-zinc-500">{t("settings.form.discord.jellyfinRoleHelp")}</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="discord-admin-role-id">{t("settings.form.discord.adminRole")}</Label>
                <Input
                  id="discord-admin-role-id"
                  value={adminRoleId}
                  onChange={(e) => { setAdminRoleId(e.target.value); setStatus("idle"); }}
                  placeholder="123456789012345678"
                  className="bg-zinc-800 border-zinc-700 font-mono"
                />
                <p className="text-xs text-zinc-500">{t("settings.form.discord.adminRoleHelp")}</p>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="discord-issue-admin-role-id">{t("settings.form.discord.issueAdminRole")}</Label>
              <Input
                id="discord-issue-admin-role-id"
                value={issueAdminRoleId}
                onChange={(e) => { setIssueAdminRoleId(e.target.value); setStatus("idle"); }}
                placeholder="123456789012345678"
                className="bg-zinc-800 border-zinc-700 font-mono"
              />
              <p className="text-xs text-zinc-500">
                {t("settings.form.discord.issueAdminRoleHelp")}
              </p>
            </div>
          </>
        )}

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={status === "saving"} className="bg-indigo-600 hover:bg-indigo-500">
            {status === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("settings.form.common.saving")}</> : t("settings.form.common.save")}
          </Button>
          <SaveStatusMessage status={status} okLabel={message} errorLabel={message} />
        </div>
      </form>
      </div>

      <div className="border-t border-zinc-800 pt-4">
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            className="border-zinc-700 text-zinc-300 hover:bg-zinc-800"
            disabled={regStatus === "loading"}
            onClick={async () => {
              if (regTimer.current) clearTimeout(regTimer.current);
              setRegStatus("loading");
              setRegMessage("");
              try {
                const res = await fetch(withBasePath("/api/discord/register-commands"), { method: "POST" });
                const data: { ok?: boolean; error?: string; message?: string } = await res.json().catch(() => ({}));
                if (data.ok) {
                  setRegStatus("ok");
                  setRegMessage(data.message ?? t("settings.form.discord.registered"));
                  regTimer.current = setTimeout(() => setRegStatus("idle"), 6000);
                } else {
                  setRegStatus("error");
                  setRegMessage(data.error ?? t("settings.form.common.failed"));
                }
              } catch {
                setRegStatus("error");
                setRegMessage(t("settings.form.common.requestFailed"));
              }
            }}
          >
            {regStatus === "loading" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("settings.form.discord.registering")}</> : t("settings.form.discord.register")}
          </Button>
          {regStatus === "ok"    && <span role="status" aria-live="polite" className="flex items-center gap-1.5 text-sm text-green-400"><CheckCircle className="w-4 h-4" />{regMessage}</span>}
          {regStatus === "error" && <span role="alert" aria-live="assertive" className="flex items-center gap-1.5 text-sm text-red-400"><XCircle className="w-4 h-4" />{regMessage}</span>}
        </div>
        <p className="text-xs text-zinc-500 mt-1.5">{t("settings.form.discord.registerHelp")}</p>
      </div>

      <div className="border-t border-zinc-800 pt-4">
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            className="border-zinc-700 text-zinc-300 hover:bg-zinc-800"
            disabled={syncRolesStatus === "loading"}
            onClick={async () => {
              if (syncTimer.current) clearTimeout(syncTimer.current);
              setSyncRolesStatus("loading");
              setSyncRolesMessage("");
              try {
                const res = await fetch(withBasePath("/api/discord/sync-roles"), { method: "POST" });
                const data: { synced?: number; error?: string } = await res.json();
                if (data.error) {
                  setSyncRolesStatus("error");
                  setSyncRolesMessage(data.error);
                } else {
                  setSyncRolesStatus("ok");
                  setSyncRolesMessage(t("settings.form.discord.syncedUsers", { count: data.synced ?? 0 }));
                  syncTimer.current = setTimeout(() => setSyncRolesStatus("idle"), 6000);
                }
              } catch {
                setSyncRolesStatus("error");
                setSyncRolesMessage(t("settings.form.common.requestFailed"));
              }
            }}
          >
            {syncRolesStatus === "loading" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("settings.form.common.syncing")}</> : t("settings.form.discord.syncRoles")}
          </Button>
          {syncRolesStatus === "ok"    && <span role="status" aria-live="polite" className="flex items-center gap-1.5 text-sm text-green-400"><CheckCircle className="w-4 h-4" />{syncRolesMessage}</span>}
          {syncRolesStatus === "error" && <span role="alert" aria-live="assertive" className="flex items-center gap-1.5 text-sm text-red-400"><XCircle className="w-4 h-4" />{syncRolesMessage}</span>}
        </div>
        <p className="text-xs text-zinc-500 mt-1.5">{t("settings.form.discord.syncRolesHelp")}</p>
      </div>
    </div>
  );
}
