"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle, XCircle, Loader2, ChevronDown, ExternalLink } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import { withBasePath } from "@/lib/base-path";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { useDelayed } from "@/hooks/use-delayed";
import { useSettingsSave } from "./shared";
import { useT } from "@/components/i18n/i18n-provider";
import { SECRET_MASK_SENTINEL } from "@/lib/secret-mask";
import { rich } from "./rich";
import { pendingChanges, type DiscordFormInitial, type DiscordKey, type DiscordValues } from "./discord-bot-keys";

// The settings page builds the props with discordFormInitial
// (discord-bot-keys.ts), which lists the form's keys once.
type DiscordBotFormProps = DiscordFormInitial;

const SNOWFLAKE_PLACEHOLDER = "123456789012345678";

export function DiscordBotForm(props: DiscordBotFormProps) {
  const t = useT();
  const [values, setValues] = useState<DiscordValues>(props.values);
  // The last values we know the server has saved, one entry per setting key.
  // It starts as the page-load values and is updated after every successful
  // save. We can't just compare against the props: they never refresh, so
  // after one save an already-saved field would be sent again (and hit the
  // route's 10s per-key cooldown, a 429), and changing a field back to its
  // page-load value would look like "no change" and never be saved.
  const [saved, setSaved] = useState<DiscordValues>(props.values);
  // Whether a token is saved. The token is masked on GET, so the route can't
  // tell a blank field from an echo and never clears it: a blank is not sent.
  const [tokenSaved, setTokenSaved] = useState(props.tokenSaved);
  // Only a success fades (after 5 s); an error (a bad snowflake, the 10s write
  // cooldown) stays until the next edit or attempt, and an edit during a save
  // keeps Save locked until the answer arrives (useSettingsSave).
  const { status, message, save, edited } = useSettingsSave(5000);
  // "No changes to save": nothing was sent, so it is this form's own note.
  const [noChanges, setNoChanges] = useState(false);
  const fadeNote = useDelayed();
  const [tab, setTab] = useState<"core" | "channels" | "roles">("core");

  // Register Commands and Sync Roles act on the SAVED settings, so they wait
  // while the form holds unsaved edits rather than report success for values
  // the admin no longer sees.
  const dirty = Object.keys(pendingChanges(values, saved)).length > 0;

  // An edit clears the last result, but never a save in flight.
  function setField(key: DiscordKey, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setNoChanges(false);
    edited();
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const changed = pendingChanges(values, saved);
    if (Object.keys(changed).length === 0) {
      setNoChanges(true);
      fadeNote(() => setNoChanges(false), 5000);
      return;
    }
    setNoChanges(false);
    const result = await save(changed);
    if (!result.ok) return;
    setSaved((prev) => ({ ...prev, ...changed }));
    if (changed.discordBotToken) {
      // Saved: the field goes back to empty-over-a-saved-token.
      setTokenSaved(true);
      setValues((prev) => (prev.discordBotToken === changed.discordBotToken ? { ...prev, discordBotToken: "" } : prev));
      setSaved((prev) => ({ ...prev, discordBotToken: "" }));
    }
  }

  // A labelled text input bound to one setting key.
  const field = (key: DiscordKey, id: string, label: string, help: React.ReactNode, opts: { placeholder?: string; mono?: boolean } = {}) => (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={values[key]}
        onChange={(e) => setField(key, e.target.value)}
        placeholder={opts.placeholder ?? SNOWFLAKE_PLACEHOLDER}
        className={opts.mono === false ? "bg-zinc-800 border-zinc-700" : "bg-zinc-800 border-zinc-700 font-mono"}
      />
      <p className="text-xs text-zinc-500">{help}</p>
    </div>
  );
  // Two fields side by side on wide screens.
  const pair = (left: React.ReactNode, right: React.ReactNode) => (
    <div className="lg:grid lg:grid-cols-2 lg:gap-4 space-y-4 lg:space-y-0">
      {left}
      {right}
    </div>
  );
  const checkbox = (key: DiscordKey, id: string, label: string, help: React.ReactNode) => (
    <div className="flex items-start gap-3">
      <input
        type="checkbox"
        id={id}
        checked={values[key] === "true"}
        onChange={(e) => setField(key, e.target.checked ? "true" : "false")}
        className="mt-0.5 h-4 w-4 rounded border-zinc-600 bg-zinc-800 accent-indigo-500"
      />
      <div>
        <Label htmlFor={id} className="cursor-pointer">{label}</Label>
        <p className="text-xs text-zinc-500 mt-1">{help}</p>
      </div>
    </div>
  );
  const slashCommands = {
    link: <code className="text-zinc-400">/link</code>,
    request: <code className="text-zinc-400">/request</code>,
    status: <code className="text-zinc-400">/status</code>,
  };

  return (
    <div className="space-y-5">
      <DiscordSetupGuide />

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
            aria-controls="discord-panel"
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

      {/* One panel for every tab: the form (and its shared Save row) is the
          content each tab controls. Its id is fixed so every tab's
          aria-controls names an element that exists; the label follows the
          selected tab. */}
      <div role="tabpanel" id="discord-panel" aria-labelledby={`discord-tab-${tab}`}>
      <form onSubmit={handleSave} className="space-y-4">
        {tab === "core" && (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="discord-token">{t("settings.form.discord.botToken")}</Label>
              <Input
                id="discord-token"
                type="password"
                autoComplete="new-password"
                data-1p-ignore
                data-lpignore="true"
                value={values.discordBotToken}
                onChange={(e) => setField("discordBotToken", e.target.value)}
                placeholder={tokenSaved ? SECRET_MASK_SENTINEL : "••••••••••••••••"}
                className="bg-zinc-800 border-zinc-700 font-mono"
              />
              <p className="text-xs text-zinc-500">{t("settings.form.discord.botTokenHelp")}</p>
              {values.discordBotToken === "" && tokenSaved && (
                <p className="text-xs text-zinc-500">{t("settings.form.discord.botTokenKept")}</p>
              )}
            </div>
            {pair(
              field("discordClientId", "discord-client-id", t("settings.form.discord.clientId"), t("settings.form.discord.clientIdHelp")),
              field("discordGuildId", "discord-guild-id", t("settings.form.discord.guildId"), t("settings.form.discord.guildIdHelp")),
            )}
            {field("discordPublicKey", "discord-public-key", t("settings.form.discord.publicKey"), t("settings.form.discord.publicKeyHelp"), { placeholder: "f8cf3a985f811b4e…" })}
            {field("discordAutoApproveRoles", "discord-auto-approve-roles", t("settings.form.discord.autoApproveRoles"), t("settings.form.discord.autoApproveRolesHelp"), { placeholder: "123456789012345678, 987654321098765432" })}
            {checkbox(
              "discordRequireLinkedAccount",
              "discord-require-linked-account",
              t("settings.form.discord.requireLinked"),
              rich(t("settings.form.discord.requireLinkedHelp"), slashCommands),
            )}
            {checkbox(
              "discordRequireLinkedAccountSite",
              "discord-require-linked-account-site",
              t("settings.form.discord.requireLinkedSite"),
              t("settings.form.discord.requireLinkedSiteHelp"),
            )}
          </>
        )}

        {tab === "channels" && (
          <>
            {pair(
              field("discordAdminRequestChannelId", "discord-admin-request-channel", t("settings.form.discord.adminChannel"), rich(t("settings.form.discord.adminChannelHelp"), {
                approve: <strong className="text-zinc-400">{t("settings.form.discord.approve")}</strong>,
                decline: <strong className="text-zinc-400">{t("settings.form.discord.decline")}</strong>,
              })),
              field("discordWelcomeChannelId", "discord-welcome-channel", t("settings.form.discord.welcomeChannel"), rich(t("settings.form.discord.welcomeChannelHelp"), slashCommands)),
            )}
            {pair(
              field("discordNotifyChannelId", "discord-notify-channel", t("settings.form.discord.notifyChannel"), rich(t("settings.form.discord.notifyChannelHelp"), { mention: <code className="text-zinc-400">@mention</code> })),
              field("discordInviteUrl", "discord-invite-url", t("settings.form.discord.inviteUrl"), t("settings.form.discord.inviteUrlHelp"), { placeholder: "https://discord.gg/xxxxxxxxx", mono: false }),
            )}
          </>
        )}

        {tab === "roles" && (
          <>
            {pair(
              field("discordLinkedRoleId", "discord-linked-role-id", t("settings.form.discord.linkedRole"), t("settings.form.discord.linkedRoleHelp")),
              field("discordPlexRoleId", "discord-plex-role-id", t("settings.form.discord.plexRole"), t("settings.form.discord.plexRoleHelp")),
            )}
            {pair(
              field("discordJellyfinRoleId", "discord-jellyfin-role-id", t("settings.form.discord.jellyfinRole"), t("settings.form.discord.jellyfinRoleHelp")),
              field("discordAdminRoleId", "discord-admin-role-id", t("settings.form.discord.adminRole"), t("settings.form.discord.adminRoleHelp")),
            )}
            {field("discordIssueAdminRoleId", "discord-issue-admin-role-id", t("settings.form.discord.issueAdminRole"), t("settings.form.discord.issueAdminRoleHelp"))}
          </>
        )}

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={status === "saving"} className="bg-indigo-600 hover:bg-indigo-500">
            {status === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("settings.form.common.saving")}</> : t("settings.form.common.save")}
          </Button>
          {noChanges ? (
            <SaveStatusMessage status="ok" okLabel={t("settings.form.discord.noChanges")} />
          ) : (
            <SaveStatusMessage status={status} okLabel={t("settings.form.discord.savedRestart")} errorLabel={message || undefined} />
          )}
        </div>
      </form>
      </div>

      {dirty && (
        <p className="text-xs text-amber-400">{t("settings.form.discord.saveFirst")}</p>
      )}

      <DiscordActionButton
        endpoint="/api/discord/register-commands"
        label={t("settings.form.discord.register")}
        busyLabel={t("settings.form.discord.registering")}
        help={t("settings.form.discord.registerHelp")}
        blocked={dirty}
        succeeded={(data) => data.ok === true}
        okMessage={(data) => data.message ?? t("settings.form.discord.registered")}
      />

      <DiscordActionButton
        endpoint="/api/discord/sync-roles"
        label={t("settings.form.discord.syncRoles")}
        busyLabel={t("settings.form.common.syncing")}
        help={t("settings.form.discord.syncRolesHelp")}
        blocked={dirty}
        succeeded={(data) => data.error === undefined}
        okMessage={(data) => t("settings.form.discord.syncedUsers", { count: data.synced ?? 0 })}
      />
    </div>
  );
}

// The answer of either action route (register-commands: { ok, message };
// sync-roles: { synced, revoked, … }; both: { error } on a refusal), read
// field by field: a field of the wrong type is left out.
interface DiscordActionAnswer {
  ok?: boolean;
  message?: string;
  synced?: number;
  error?: string;
}

function readActionAnswer(data: unknown): DiscordActionAnswer {
  const d = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  return {
    ...(typeof d.ok === "boolean" ? { ok: d.ok } : {}),
    ...(typeof d.message === "string" ? { message: d.message } : {}),
    ...(typeof d.synced === "number" ? { synced: d.synced } : {}),
    ...(typeof d.error === "string" ? { error: d.error } : {}),
  };
}

// Register Commands / Sync Roles: a POST with no body to a route that reads the
// saved settings, with its own result line.
function DiscordActionButton({ endpoint, label, busyLabel, help, blocked, succeeded, okMessage }: {
  endpoint: string;
  label: string;
  busyLabel: string;
  help: string;
  // Unsaved edits: the route would act on the old values.
  blocked: boolean;
  succeeded: (data: DiscordActionAnswer) => boolean;
  okMessage: (data: DiscordActionAnswer) => string;
}) {
  const t = useT();
  const [status, setStatus] = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [message, setMessage] = useState("");
  // Only a success fades; a new attempt cancels the previous fade, and
  // nothing fires after unmount.
  const later = useDelayed();

  async function run() {
    later.cancel();
    setStatus("loading");
    setMessage("");
    // Plain fetch: a proxy's 502/504 page is not JSON, and its HTTP status is
    // still shown instead of a bare "request failed".
    try {
      const res = await fetch(withBasePath(endpoint), { method: "POST" });
      const data = readActionAnswer(await res.json().catch(() => null));
      if (res.ok && succeeded(data)) {
        setStatus("ok");
        setMessage(okMessage(data));
        later(() => setStatus("idle"), 6000);
        return;
      }
      setStatus("error");
      setMessage(
        data.error ??
          (res.ok ? t("settings.form.common.failed") : t("settings.form.common.requestFailedHttp", { status: res.status })),
      );
    } catch {
      setStatus("error");
      setMessage(t("settings.form.common.requestFailed"));
    }
  }

  return (
    <div className="border-t border-zinc-800 pt-4">
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          className="border-zinc-700 text-zinc-300 hover:bg-zinc-800"
          disabled={status === "loading" || blocked}
          onClick={run}
        >
          {status === "loading" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{busyLabel}</> : label}
        </Button>
        {status === "ok"    && <span role="status" aria-live="polite" className="flex items-center gap-1.5 text-sm text-green-400"><CheckCircle className="w-4 h-4" />{message}</span>}
        {status === "error" && <span role="alert" aria-live="assertive" className="flex items-center gap-1.5 text-sm text-red-400"><XCircle className="w-4 h-4" />{message}</span>}
      </div>
      <p className="text-xs text-zinc-500 mt-1.5">{help}</p>
    </div>
  );
}

// One numbered step of the guide: its title, then its lines.
function GuideStep({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="font-semibold text-zinc-200">{title}</p>
      {children}
    </div>
  );
}

// The collapsible step-by-step Developer Portal guide.
function DiscordSetupGuide() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const mounted = useHasMounted();
  // Highlights a Discord UI term inside a translated guide sentence. The terms
  // themselves come from the catalog (settings.form.discord.portal.*): the
  // Developer Portal is localized, so a French admin follows French menu names.
  const hl = (node: React.ReactNode) => <span className="text-zinc-300">{node}</span>;
  const portal = (term: string) => hl(t(`settings.form.discord.portal.${term}`));

  // Discord sends slash-command events to /api/interactions (with BASE_PATH added).
  // Show this site's real address so admins can paste it into the Developer Portal.
  // Until the component has mounted in the browser we show a placeholder instead,
  // because `window` doesn't exist during server rendering (guardrail 16).
  const interactionsEndpoint = mounted
    ? `${window.location.origin}${withBasePath("/api/interactions")}`
    : "https://<your-domain>/api/interactions";

  return (
    <div className="rounded-md border border-zinc-700 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-zinc-300 hover:bg-zinc-800 transition-colors"
      >
        <span>{t("settings.form.discord.guide.title")}</span>
        <ChevronDown aria-hidden className={`w-4 h-4 text-zinc-500 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="px-4 pb-4 pt-1 border-t border-zinc-700 space-y-4 text-sm text-zinc-400">

          <GuideStep title={t("settings.form.discord.guide.s1.title")}>
            <p>{t("settings.form.discord.guide.s1.body")}</p>
            <a
              href="https://discord.com/developers/applications"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-indigo-400 hover:text-indigo-300 text-xs"
            >
              discord.com/developers/applications <ExternalLink className="w-3 h-3" />
            </a>
          </GuideStep>

          <GuideStep title={t("settings.form.discord.guide.s2.title")}>
            <p>
              {rich(t("settings.form.discord.guide.s2.body"), { bot: portal("bot"), reset: portal("resetToken"), field: hl(t("settings.form.discord.botToken")) })}
            </p>
            <p className="text-zinc-500 text-xs">
              {rich(t("settings.form.discord.guide.s2.note"), {
                grant: <strong className="text-zinc-400">{t("settings.form.discord.portal.codeGrant")}</strong>,
                off: <strong className="text-zinc-400">{t("settings.form.discord.portal.off")}</strong>,
              })}
            </p>
          </GuideStep>

          <GuideStep title={t("settings.form.discord.guide.s3.title")}>
            <p>
              {rich(t("settings.form.discord.guide.s3.body"), { page: portal("generalInformation"), appId: portal("applicationId"), publicKey: portal("publicKey") })}
            </p>
          </GuideStep>

          <GuideStep title={t("settings.form.discord.guide.s4.title")}>
            <p>
              {rich(t("settings.form.discord.guide.s4.body"), { devMode: portal("developerMode"), copyId: portal("copyServerId"), field: hl(t("settings.form.discord.guildId")) })}
            </p>
            <p className="text-zinc-500 text-xs">
              {t("settings.form.discord.guide.s4.note")}
            </p>
          </GuideStep>

          <GuideStep title={t("settings.form.discord.guide.s5.title")}>
            <p>{rich(t("settings.form.discord.guide.s5.body"), { register: hl(t("settings.form.discord.register")) })}</p>
          </GuideStep>

          <GuideStep title={t("settings.form.discord.guide.s6.title")}>
            <p>
              {rich(t("settings.form.discord.guide.s6.body"), { page: portal("generalInformation"), field: portal("interactionsEndpointUrl") })}
            </p>
            <code className="block break-all bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-xs font-mono text-zinc-300 mt-1">
              {interactionsEndpoint}
            </code>
            <p className="text-zinc-500 text-xs mt-1">
              {rich(t("settings.form.discord.guide.s6.note"), { save: <strong className="text-zinc-400">{t("settings.form.discord.portal.saveChanges")}</strong> })}
            </p>
          </GuideStep>

          <GuideStep title={t("settings.form.discord.guide.s7.title")}>
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
          </GuideStep>

          <GuideStep title={<>{t("settings.form.discord.guide.s8.title")} <span className="text-zinc-500 font-normal">{t("settings.form.common.optional")}</span></>}>
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
          </GuideStep>

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
  );
}
