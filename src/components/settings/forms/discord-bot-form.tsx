"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle, XCircle, Loader2, ChevronDown, ExternalLink } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { useHasMounted } from "@/hooks/use-has-mounted";
import type { SaveStatus } from "./shared";

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

  // The app's Discord interactions handler lives at /api/interactions (respecting BASE_PATH).
  // Show the running instance's own origin so admins can paste it straight into the Developer Portal;
  // fall back to a placeholder pre-mount (window is unavailable during SSR — guardrail 16).
  const interactionsEndpoint = mounted
    ? `${window.location.origin}${withBasePath("/api/interactions")}`
    : "https://<your-domain>/api/interactions";

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    setMessage("");

    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ discordBotToken: botToken, discordClientId: clientId, discordGuildId: guildId, discordPublicKey: publicKey, discordAutoApproveRoles: autoApproveRoles, discordRequireLinkedAccount: requireLinkedAccount ? "true" : "false", discordRequireLinkedAccountSite: requireLinkedAccountSite ? "true" : "false", discordAdminRequestChannelId: adminRequestChannelId, discordWelcomeChannelId: welcomeChannelId, discordNotifyChannelId: notifyChannelId, discordInviteUrl: inviteUrl, discordLinkedRoleId: linkedRoleId, discordPlexRoleId: plexRoleId, discordJellyfinRoleId: jellyfinRoleId, discordAdminRoleId: adminRoleId, discordIssueAdminRoleId: issueAdminRoleId }),
      });

      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };

      if (res.ok && data.ok) {
        setMessage("Saved · Restart the bot for changes to take effect");
        setStatus("ok");
      } else {
        setMessage(data.error ?? "Failed to save");
        setStatus("error");
      }
    } catch {
      setMessage("Failed to save");
      setStatus("error");
    }
    setTimeout(() => setStatus("idle"), 5000);
  }

  return (
    <div className="space-y-5">
      <div className="rounded-md border border-zinc-700 overflow-hidden">
        <button
          type="button"
          onClick={() => setGuideOpen((v) => !v)}
          className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-zinc-300 hover:bg-zinc-800 transition-colors"
        >
          <span>Setup guide</span>
          <ChevronDown className={`w-4 h-4 text-zinc-500 transition-transform duration-200 ${guideOpen ? "rotate-180" : ""}`} />
        </button>

        {guideOpen && (
          <div className="px-4 pb-4 pt-1 border-t border-zinc-700 space-y-4 text-sm text-zinc-400">

            <div className="space-y-1">
              <p className="font-semibold text-zinc-200">1. Create a Discord application</p>
              <p>Go to the Discord Developer Portal and create a new application.</p>
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
              <p className="font-semibold text-zinc-200">2. Get the Bot Token</p>
              <p>
                Go to <span className="text-zinc-300">Bot</span> in the left sidebar. Click{" "}
                <span className="text-zinc-300">Reset Token</span> and copy the value — paste it into
                the <span className="text-zinc-300">Bot Token</span> field below.
              </p>
              <p className="text-zinc-500 text-xs">
                Also check that <strong className="text-zinc-400">Requires OAuth2 Code Grant</strong> is <strong className="text-zinc-400">OFF</strong> — if enabled, the invite URL will fail with a &quot;code grant&quot; error.
              </p>
            </div>

            <div className="space-y-1">
              <p className="font-semibold text-zinc-200">3. Copy the Client ID and Public Key</p>
              <p>
                Go to <span className="text-zinc-300">General Information</span>. Copy the{" "}
                <span className="text-zinc-300">Application ID</span> into the Client ID field below, and
                copy the <span className="text-zinc-300">Public Key</span> into the Public Key field below.
                The Public Key is required to verify that interactions come from Discord.
              </p>
            </div>

            <div className="space-y-1">
              <p className="font-semibold text-zinc-200">4. Set the Guild (Server) ID</p>
              <p>
                Enable <span className="text-zinc-300">Developer Mode</span> in Discord user settings
                (Appearance → Advanced). Right-click your server icon and select{" "}
                <span className="text-zinc-300">Copy Server ID</span>. Paste it in the{" "}
                <span className="text-zinc-300">Guild (Server) ID</span> field below.
              </p>
              <p className="text-zinc-500 text-xs">
                Required — without it, commands are registered globally and take up to 1 hour to appear.
              </p>
            </div>

            <div className="space-y-1">
              <p className="font-semibold text-zinc-200">5. Save settings &amp; register slash commands</p>
              <p>Save the fields below, then click <span className="text-zinc-300">Register Slash Commands</span> below. You should see a confirmation that commands were registered to your guild.</p>
            </div>

            <div className="space-y-1">
              <p className="font-semibold text-zinc-200">6. Set the Interactions Endpoint URL</p>
              <p>
                Go back to <span className="text-zinc-300">General Information</span> in the Developer Portal.
                Set the <span className="text-zinc-300">Interactions Endpoint URL</span> to:
              </p>
              <code className="block bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-xs font-mono text-zinc-300 mt-1">
                {interactionsEndpoint}
              </code>
              <p className="text-zinc-500 text-xs mt-1">
                Discord will send a verification ping — your app must respond with a valid PONG for the URL to be accepted. Make sure the Public Key is saved first (step 3). Click <strong className="text-zinc-400">Save Changes</strong>.
              </p>
            </div>

            <div className="space-y-1">
              <p className="font-semibold text-zinc-200">7. Invite the bot to your server</p>
              <p>
                Go to <span className="text-zinc-300">OAuth2 → URL Generator</span>. Check the{" "}
                <span className="text-zinc-300">bot</span> and{" "}
                <span className="text-zinc-300">applications.commands</span> scopes. Under Bot Permissions
                check <span className="text-zinc-300">Send Messages</span>,{" "}
                <span className="text-zinc-300">Embed Links</span>, and{" "}
                <span className="text-zinc-300">View Channels</span>.
                Copy the <strong className="text-zinc-400">Generated URL</strong> and open it to add the bot to your server.
              </p>
              <p className="text-zinc-500 text-xs">
                Use the OAuth2 URL Generator — do not use the &quot;Discord Provided Link&quot; from the Installation page.
              </p>
            </div>

            <div className="space-y-1">
              <p className="font-semibold text-zinc-200">8. Set up a notification channel <span className="text-zinc-500 font-normal">(optional)</span></p>
              <p>
                Instead of sending approval and download notifications as DMs, the bot can post them in a dedicated channel and ping the user with an <span className="text-zinc-300">@mention</span>.
              </p>
              <ol className="list-decimal list-inside space-y-1 text-zinc-400 text-sm pl-1">
                <li>
                  In Discord, create or choose a channel (e.g. <span className="text-zinc-300">#requests</span> or <span className="text-zinc-300">#notifications</span>).
                </li>
                <li>
                  Right-click the channel → <span className="text-zinc-300">Edit Channel</span> → <span className="text-zinc-300">Permissions</span>. Make sure the bot role has <span className="text-zinc-300">View Channel</span> and <span className="text-zinc-300">Send Messages</span> enabled. If the channel is private, you must explicitly add the bot role.
                </li>
                <li>
                  Enable <span className="text-zinc-300">Developer Mode</span> in Discord user settings (<span className="text-zinc-300">App Settings → Advanced</span>).
                </li>
                <li>
                  Right-click the channel name → <span className="text-zinc-300">Copy Channel ID</span>.
                </li>
                <li>
                  Paste it into the <span className="text-zinc-300">Notification Channel ID</span> field below and save.
                </li>
              </ol>
              <p className="text-zinc-500 text-xs mt-1">
                Leave the field blank to keep using DMs instead. When a channel is set, every notification is posted there as <code className="text-zinc-400">@Username message</code> so the user gets a ping.
              </p>
            </div>

            <div className="rounded-md bg-zinc-900 border border-zinc-700 px-3 py-3 space-y-1">
              <p className="font-semibold text-zinc-300 text-xs uppercase tracking-wide mb-2">Available slash commands</p>
              <div className="space-y-1.5 text-xs font-mono">
                <p><span className="text-indigo-400">/request</span> <span className="text-zinc-500">type:Movie|TV Show  query:&lt;title&gt;</span></p>
                <p className="text-zinc-500 pl-3">Search and request a movie or TV show — no account linking required</p>
                <p className="mt-1"><span className="text-indigo-400">/status</span></p>
                <p className="text-zinc-500 pl-3">Check your recent request statuses</p>
                <p className="mt-1"><span className="text-indigo-400">/link</span> <span className="text-zinc-500">token:&lt;8-char code&gt;</span></p>
                <p className="text-zinc-500 pl-3">Link your Discord account to your web account — generate the token on your Profile page</p>
              </div>
            </div>

          </div>
        )}
      </div>

      <div className="flex gap-1 border-b border-zinc-800">
        {(["core", "channels", "roles"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium capitalize transition-colors border-b-2 -mb-px ${
              tab === t
                ? "border-indigo-500 text-white"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {}
      <form onSubmit={handleSave} className="space-y-4">
        {tab === "core" && (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="discord-token">Bot Token</Label>
              <Input
                id="discord-token"
                type="password"
                value={botToken}
                onChange={(e) => { setBotToken(e.target.value); setStatus("idle"); }}
                placeholder="••••••••••••••••"
                className="bg-zinc-800 border-zinc-700 font-mono text-sm"
              />
              <p className="text-xs text-zinc-500">From the Bot page of your Discord application (step 2).</p>
            </div>
            <div className="lg:grid lg:grid-cols-2 lg:gap-4 space-y-4 lg:space-y-0">
              <div className="space-y-1.5">
                <Label htmlFor="discord-client-id">Application (Client) ID</Label>
                <Input
                  id="discord-client-id"
                  value={clientId}
                  onChange={(e) => { setClientId(e.target.value); setStatus("idle"); }}
                  placeholder="123456789012345678"
                  className="bg-zinc-800 border-zinc-700 font-mono text-sm"
                />
                <p className="text-xs text-zinc-500">From the General Information page (step 3).</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="discord-guild-id">Guild (Server) ID</Label>
                <Input
                  id="discord-guild-id"
                  value={guildId}
                  onChange={(e) => { setGuildId(e.target.value); setStatus("idle"); }}
                  placeholder="123456789012345678"
                  className="bg-zinc-800 border-zinc-700 font-mono text-sm"
                />
                <p className="text-xs text-zinc-500">Your Discord server ID (step 4). Required for instant slash command registration.</p>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="discord-public-key">Public Key</Label>
              <Input
                id="discord-public-key"
                value={publicKey}
                onChange={(e) => { setPublicKey(e.target.value); setStatus("idle"); }}
                placeholder="f8cf3a985f811b4e…"
                className="bg-zinc-800 border-zinc-700 font-mono text-sm"
              />
              <p className="text-xs text-zinc-500">From General Information → Public Key (step 3). Required for HTTP interaction signature verification.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="discord-auto-approve-roles">Auto-Approve Role IDs</Label>
              <Input
                id="discord-auto-approve-roles"
                value={autoApproveRoles}
                onChange={(e) => { setAutoApproveRoles(e.target.value); setStatus("idle"); }}
                placeholder="123456789012345678, 987654321098765432"
                className="bg-zinc-800 border-zinc-700 font-mono text-sm"
              />
              <p className="text-xs text-zinc-500">
                Comma-separated Discord role IDs. Members with any of these roles will have their requests auto-approved and sent to download — without admin review.
                Right-click a role in Discord (Developer Mode on) to copy its ID.
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
                <Label htmlFor="discord-require-linked-account" className="cursor-pointer">Require linked site account for Discord requests</Label>
                <p className="text-xs text-zinc-500 mt-1">
                  When enabled, Discord users must link their account via <code className="text-zinc-400">/link</code> before using <code className="text-zinc-400">/request</code> or <code className="text-zinc-400">/status</code>.
                  Members with an Auto-Approve role are exempt — they can request without linking.
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
                <Label htmlFor="discord-require-linked-account-site" className="cursor-pointer">Require linked Discord account for site requests</Label>
                <p className="text-xs text-zinc-500 mt-1">
                  When enabled, users logged into the site must also link a Discord account before they can submit requests.
                  Leave off to allow site users to request without Discord.
                </p>
              </div>
            </div>
          </>
        )}

        {tab === "channels" && (
          <>
            <div className="lg:grid lg:grid-cols-2 lg:gap-4 space-y-4 lg:space-y-0">
              <div className="space-y-1.5">
                <Label htmlFor="discord-admin-request-channel">Admin Request Channel ID</Label>
                <Input
                  id="discord-admin-request-channel"
                  value={adminRequestChannelId}
                  onChange={(e) => { setAdminRequestChannelId(e.target.value); setStatus("idle"); }}
                  placeholder="123456789012345678"
                  className="bg-zinc-800 border-zinc-700 font-mono text-sm"
                />
                <p className="text-xs text-zinc-500">
                  Optional. When set, every new pending request is posted to this channel as an embed with <strong className="text-zinc-400">Approve</strong> and <strong className="text-zinc-400">Decline</strong> buttons.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="discord-welcome-channel">Welcome Channel ID</Label>
                <Input
                  id="discord-welcome-channel"
                  value={welcomeChannelId}
                  onChange={(e) => { setWelcomeChannelId(e.target.value); setStatus("idle"); }}
                  placeholder="123456789012345678"
                  className="bg-zinc-800 border-zinc-700 font-mono text-sm"
                />
                <p className="text-xs text-zinc-500">
                  Optional. When set, <code className="text-zinc-400">/link</code> can only be used in this channel, and <code className="text-zinc-400">/request</code> / <code className="text-zinc-400">/status</code> are blocked there.
                </p>
              </div>
            </div>
            <div className="lg:grid lg:grid-cols-2 lg:gap-4 space-y-4 lg:space-y-0">
              <div className="space-y-1.5">
                <Label htmlFor="discord-notify-channel">Notification Channel ID</Label>
                <Input
                  id="discord-notify-channel"
                  value={notifyChannelId}
                  onChange={(e) => { setNotifyChannelId(e.target.value); setStatus("idle"); }}
                  placeholder="123456789012345678"
                  className="bg-zinc-800 border-zinc-700 font-mono text-sm"
                />
                <p className="text-xs text-zinc-500">
                  Optional. Approval and download notifications post here and the user is pinged with <code className="text-zinc-400">@mention</code>. Leave blank to send DMs.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="discord-invite-url">Server Invite URL</Label>
                <Input
                  id="discord-invite-url"
                  value={inviteUrl}
                  onChange={(e) => { setInviteUrl(e.target.value); setStatus("idle"); }}
                  placeholder="https://discord.gg/xxxxxxxxx"
                  className="bg-zinc-800 border-zinc-700 text-sm"
                />
                <p className="text-xs text-zinc-500">
                  Optional. Permanent invite link. When set, users without a linked Discord account are prompted to join.
                </p>
              </div>
            </div>
          </>
        )}

        {tab === "roles" && (
          <>
            <div className="lg:grid lg:grid-cols-2 lg:gap-4 space-y-4 lg:space-y-0">
              <div className="space-y-1.5">
                <Label htmlFor="discord-linked-role-id">Linked Role ID</Label>
                <Input
                  id="discord-linked-role-id"
                  value={linkedRoleId}
                  onChange={(e) => { setLinkedRoleId(e.target.value); setStatus("idle"); }}
                  placeholder="123456789012345678"
                  className="bg-zinc-800 border-zinc-700 font-mono text-sm"
                />
                <p className="text-xs text-zinc-500">
                  Optional. Assigned to every user when they link their Discord account — grants access to general server channels.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="discord-plex-role-id">Plex Role ID</Label>
                <Input
                  id="discord-plex-role-id"
                  value={plexRoleId}
                  onChange={(e) => { setPlexRoleId(e.target.value); setStatus("idle"); }}
                  placeholder="123456789012345678"
                  className="bg-zinc-800 border-zinc-700 font-mono text-sm"
                />
                <p className="text-xs text-zinc-500">Optional. Assigned to users who linked via a Plex account.</p>
              </div>
            </div>
            <div className="lg:grid lg:grid-cols-2 lg:gap-4 space-y-4 lg:space-y-0">
              <div className="space-y-1.5">
                <Label htmlFor="discord-jellyfin-role-id">Jellyfin Role ID</Label>
                <Input
                  id="discord-jellyfin-role-id"
                  value={jellyfinRoleId}
                  onChange={(e) => { setJellyfinRoleId(e.target.value); setStatus("idle"); }}
                  placeholder="123456789012345678"
                  className="bg-zinc-800 border-zinc-700 font-mono text-sm"
                />
                <p className="text-xs text-zinc-500">Optional. Assigned to users who linked via a Jellyfin account.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="discord-admin-role-id">Admin Role ID</Label>
                <Input
                  id="discord-admin-role-id"
                  value={adminRoleId}
                  onChange={(e) => { setAdminRoleId(e.target.value); setStatus("idle"); }}
                  placeholder="123456789012345678"
                  className="bg-zinc-800 border-zinc-700 font-mono text-sm"
                />
                <p className="text-xs text-zinc-500">Optional. Assigned to Admin-role users when they link.</p>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="discord-issue-admin-role-id">Issue Admin Role ID</Label>
              <Input
                id="discord-issue-admin-role-id"
                value={issueAdminRoleId}
                onChange={(e) => { setIssueAdminRoleId(e.target.value); setStatus("idle"); }}
                placeholder="123456789012345678"
                className="bg-zinc-800 border-zinc-700 font-mono text-sm"
              />
              <p className="text-xs text-zinc-500">
                Optional. Assigned to Issue Admin-role users when they link.
              </p>
            </div>
          </>
        )}

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={status === "saving"} className="bg-indigo-600 hover:bg-indigo-500">
            {status === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</> : "Save"}
          </Button>
          {status === "ok"    && <span className="flex items-center gap-1.5 text-sm text-green-400"><CheckCircle className="w-4 h-4" />{message}</span>}
          {status === "error" && <span className="flex items-center gap-1.5 text-sm text-red-400"><XCircle className="w-4 h-4" />{message}</span>}
        </div>
      </form>

      <div className="border-t border-zinc-800 pt-4">
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            className="border-zinc-700 text-zinc-300 hover:bg-zinc-800"
            disabled={regStatus === "loading"}
            onClick={async () => {
              setRegStatus("loading");
              setRegMessage("");
              try {
                const res = await fetch(withBasePath("/api/discord/register-commands"), { method: "POST" });
                const data: { ok?: boolean; error?: string; message?: string } = await res.json().catch(() => ({}));
                if (data.ok) {
                  setRegStatus("ok");
                  setRegMessage(data.message ?? "Commands registered");
                } else {
                  setRegStatus("error");
                  setRegMessage(data.error ?? "Failed");
                }
              } catch {
                setRegStatus("error");
                setRegMessage("Request failed");
              }
              setTimeout(() => setRegStatus("idle"), 6000);
            }}
          >
            {regStatus === "loading" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Registering…</> : "Register Slash Commands"}
          </Button>
          {regStatus === "ok"    && <span className="flex items-center gap-1.5 text-sm text-green-400"><CheckCircle className="w-4 h-4" />{regMessage}</span>}
          {regStatus === "error" && <span className="flex items-center gap-1.5 text-sm text-red-400"><XCircle className="w-4 h-4" />{regMessage}</span>}
        </div>
        <p className="text-xs text-zinc-500 mt-1.5">Re-registers slash commands with Discord. Run this after changing Guild ID or Bot Token.</p>
      </div>

      <div className="border-t border-zinc-800 pt-4">
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            className="border-zinc-700 text-zinc-300 hover:bg-zinc-800"
            disabled={syncRolesStatus === "loading"}
            onClick={async () => {
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
                  setSyncRolesMessage(`Synced ${data.synced ?? 0} user${data.synced !== 1 ? "s" : ""}`);
                }
              } catch {
                setSyncRolesStatus("error");
                setSyncRolesMessage("Request failed");
              }
              setTimeout(() => setSyncRolesStatus("idle"), 6000);
            }}
          >
            {syncRolesStatus === "loading" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Syncing…</> : "Sync Discord Roles"}
          </Button>
          {syncRolesStatus === "ok"    && <span className="flex items-center gap-1.5 text-sm text-green-400"><CheckCircle className="w-4 h-4" />{syncRolesMessage}</span>}
          {syncRolesStatus === "error" && <span className="flex items-center gap-1.5 text-sm text-red-400"><XCircle className="w-4 h-4" />{syncRolesMessage}</span>}
        </div>
        <p className="text-xs text-zinc-500 mt-1.5">Assigns the Linked, Plex, and Jellyfin roles to all users who have already linked their Discord account. Run this once after configuring role IDs to backfill existing users.</p>
      </div>
    </div>
  );
}
