"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Download, Ban, ShieldCheck, Link, Loader2, RefreshCw } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { mediaInstanceLabel } from "@/lib/media-instances";
import { Switch } from "@/components/ui/switch";

interface ServerUser {
  id: string;
  source: string;
  // Multi-server support — "" is the default (and, for a single-server
  // deployment, only) instance. Distinguishes same-named users across two
  // independently-configured servers of the same provider.
  serverInstance: string;
  sourceUserId: string;
  username: string;
  email: string | null;
  thumbUrl: string | null;
  downloadsEnabled: boolean | null;
  isServerAdmin: boolean;
  userId: string | null;
  // An admin pinned this row's account binding by hand, so the automatic
  // linkers (the 5s poll and the hourly Jellyfin sync) leave it alone.
  manualUserLink: boolean;
  // false = departed from the media server (soft-deleted). Listed anyway when it
  // still holds play history, so that history stays attributable.
  active: boolean;
  user: { name: string | null; email: string } | null;
}

// A Summonarr account the identity can be attributed to.
interface LinkableAccount {
  id: string;
  name: string | null;
  email: string;
}

interface ServerUserTableProps {
  users: ServerUser[];
  hasJellyfin: boolean;
  autoDisableNew: boolean;
  accounts: LinkableAccount[];
}

// Sentinels for the picker's two non-account options. Prefixed so they can
// never collide with a real cuid.
const AUTO = "__auto__";
const NONE = "__none__";

const sourceStyles: Record<string, string> = {
  plex:     "border-yellow-600/30 bg-yellow-500/10 text-yellow-400",
  jellyfin: "border-purple-600/30 bg-purple-500/10 text-purple-400",
};

// Fixed (non-theme) fills, so the initials colour is fixed too: black on the
// light yellow-600 (white there is ~2.9:1), white on the dark purple-700.
const avatarColors: Record<string, string> = {
  plex:     "bg-yellow-600",
  jellyfin: "bg-purple-700",
};
const avatarText: Record<string, string> = {
  plex:     "text-black",
  jellyfin: "text-white",
};

// Manual account binding for one media-server identity. Automatic resolution
// (provider subject id, then email) covers the common case; this is the escape
// hatch for an identity that matched nothing or matched the WRONG account.
// Choosing an account or "Not linked" pins the row so the 5s poll and the hourly
// sync stop re-deriving it; "Automatic" hands it back.
function LinkPicker({
  row,
  accounts,
}: {
  row: ServerUser;
  accounts: LinkableAccount[];
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const value = !row.manualUserLink ? AUTO : (row.userId ?? NONE);

  async function change(next: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(withBasePath(`/api/admin/server-users/${row.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          next === AUTO ? { autoLink: true } : { userId: next === NONE ? null : next },
        ),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok || data?.error) {
        setError(data?.error ?? `Failed (${res.status})`);
        return;
      }
      router.refresh();
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        {loading ? (
          <Loader2 className="w-3 h-3 animate-spin text-zinc-500 shrink-0" />
        ) : (
          <Link className={`w-3 h-3 shrink-0 ${row.userId ? "text-zinc-400" : "text-zinc-600"}`} />
        )}
        <select
          value={value}
          disabled={loading}
          aria-label={`Summonarr account attributed for ${row.username}`}
          onChange={(e) => change(e.target.value)}
          className="max-w-[170px] truncate rounded-md border border-zinc-700 bg-zinc-800/60 px-1.5 py-0.5 text-xs text-zinc-200 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
        >
          <option value={AUTO}>
            Automatic{row.user ? ` — ${row.user.name ?? row.user.email}` : " — unmatched"}
          </option>
          <option value={NONE}>Not linked</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name ?? a.email}
            </option>
          ))}
        </select>
      </div>
      {row.manualUserLink && !error && (
        <span className="text-[10px] text-amber-400">pinned by admin</span>
      )}
      {error && <span className="text-[10px] text-red-400">{error}</span>}
    </div>
  );
}

function DownloadToggle({
  userId,
  enabled,
  disabled: isDisabled,
}: {
  userId: string;
  enabled: boolean | null;
  disabled: boolean;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [optimistic, setOptimistic] = useState(enabled);

  // Follow the server value when it changes. useState only reads `enabled`
  // on first mount, and router.refresh() keeps component state, so without
  // this a bulk "Disable all" would leave every switch showing its old value.
  // After the admin's own click the new prop already matches, so it's a no-op.
  useEffect(() => {
    setOptimistic(enabled);
  }, [enabled]);

  async function toggle() {
    // null means not-yet-synced — first click enables downloads
    const next = !(optimistic ?? false);
    setOptimistic(next);
    setLoading(true);
    try {
      const res = await fetch(withBasePath(`/api/admin/server-users/${userId}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ downloadsEnabled: next }),
      });
      if (!res.ok) {
        setOptimistic(optimistic);
      } else {
        router.refresh();
      }
    } catch {
      // Network failure — roll back the optimistic state too.
      setOptimistic(optimistic);
    } finally {
      setLoading(false);
    }
  }

  if (isDisabled) {
    return (
      <Badge className="border-zinc-700 bg-zinc-800 text-zinc-500 text-[10px]">
        Admin
      </Badge>
    );
  }

  // null = not yet synced from server — show as indeterminate, not enabled
  if (optimistic === null) {
    return (
      <span className="text-[11px] text-zinc-500 italic">not synced</span>
    );
  }

  const on = optimistic;

  return (
    <Switch
      variant="success"
      checked={on}
      aria-label="Toggle downloads for this user"
      disabled={loading}
      loading={loading}
      onCheckedChange={toggle}
      title={on ? "Downloads enabled — click to disable" : "Downloads disabled — click to enable"}
    />
  );
}

function SyncUsersButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  async function sync() {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(withBasePath("/api/cron/sync-download-policies"), { method: "POST" });
      if (!res.ok) {
        setError(true);
        return;
      }
      router.refresh();
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={sync}
        disabled={loading}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-zinc-700 bg-zinc-800/60 text-zinc-300 hover:bg-zinc-700/60 hover:text-zinc-100 transition-colors disabled:opacity-50"
      >
        {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
        {loading ? "Syncing…" : "Sync users from server"}
      </button>
      {error && <span className="text-xs text-red-400">Sync failed</span>}
    </div>
  );
}

function BulkBar({
  source,
  label,
}: {
  source: "jellyfin";
  label: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState<"disable" | "enable" | null>(null);
  const [error, setError] = useState(false);
  // A bulk write overwrites every per-user setting and can't be undone (the
  // opposite button restores a uniform state, not the previous mix), so each
  // one asks first — the same inline confirm as the library Resync button.
  const [confirming, setConfirming] = useState<"disable" | "enable" | null>(null);

  async function bulk(downloadsEnabled: boolean) {
    setConfirming(null);
    setLoading(downloadsEnabled ? "enable" : "disable");
    setError(false);
    try {
      const res = await fetch(withBasePath("/api/admin/server-users/bulk"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, downloadsEnabled }),
      });
      if (!res.ok) {
        setError(true);
        return;
      }
      router.refresh();
    } catch {
      setError(true);
    } finally {
      setLoading(null);
    }
  }

  if (confirming) {
    const enable = confirming === "enable";
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-zinc-300">
          {enable ? "Enable" : "Disable"} downloads for every {label} user?
        </span>
        <button
          onClick={() => bulk(enable)}
          className={`px-2 py-0.5 text-xs rounded border transition-colors ${
            enable
              ? "border-green-800/40 bg-green-500/10 text-green-400 hover:bg-green-500/20"
              : "border-red-800/40 bg-red-500/10 text-red-400 hover:bg-red-500/20"
          }`}
        >
          {enable ? "Enable all" : "Disable all"}
        </button>
        <button
          onClick={() => setConfirming(null)}
          className="px-2 py-0.5 text-xs rounded border border-zinc-700 text-zinc-400 hover:text-zinc-100 transition-colors"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-zinc-500">{label}:</span>
      <button
        onClick={() => setConfirming("disable")}
        disabled={loading !== null}
        className="flex items-center gap-1 px-2 py-0.5 text-xs rounded border border-red-800/40 bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors disabled:opacity-50"
      >
        {loading === "disable" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Ban className="w-3 h-3" />}
        Disable all
      </button>
      <button
        onClick={() => setConfirming("enable")}
        disabled={loading !== null}
        className="flex items-center gap-1 px-2 py-0.5 text-xs rounded border border-green-800/40 bg-green-500/10 text-green-400 hover:bg-green-500/20 transition-colors disabled:opacity-50"
      >
        {loading === "enable" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
        Enable all
      </button>
      {error && <span className="text-xs text-red-400">Failed</span>}
    </div>
  );
}

function AutoDisableToggle({ initial }: { initial: boolean }) {
  const router = useRouter();
  const [on, setOn] = useState(initial);
  const [loading, setLoading] = useState(false);

  async function toggle() {
    const next = !on;
    setOn(next);
    setLoading(true);
    try {
      const res = await fetch(withBasePath("/api/admin/server-users"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoDisableNew: next }),
      });
      if (!res.ok) setOn(on);
      else router.refresh();
    } catch {
      // Network failure — roll back the optimistic state too.
      setOn(on);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center gap-2.5 py-2 px-3 rounded-lg border border-zinc-800 bg-zinc-900/60">
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-zinc-200">Auto-disable downloads for new Jellyfin users</p>
        <p className="text-[11px] text-zinc-500 mt-0.5">
          New Jellyfin accounts discovered on sync have downloads disabled. Manually re-enabled users are left alone.
        </p>
      </div>
      <Switch
        checked={on}
        aria-label="Auto-disable downloads for new Jellyfin users"
        disabled={loading}
        loading={loading}
        onCheckedChange={toggle}
      />
    </div>
  );
}

export function ServerUserTable({ users, hasJellyfin, autoDisableNew, accounts }: ServerUserTableProps) {
  const [search, setSearch] = useState("");

  const query = search.trim().toLowerCase();
  const filtered = query
    ? users.filter(
        (u) =>
          u.username.toLowerCase().includes(query) ||
          (u.email ?? "").toLowerCase().includes(query),
      )
    : users;

  const plexUsers = filtered.filter((u) => u.source === "plex");
  const jellyfinUsers = filtered.filter((u) => u.source === "jellyfin");
  const disabledJellyfinCount = jellyfinUsers.filter(
    (u) => !u.isServerAdmin && u.downloadsEnabled === false,
  ).length;

  function renderGroup(group: ServerUser[], source: "plex" | "jellyfin") {
    if (group.length === 0) return null;
    return group.map((u) => {
      const initials = u.username.slice(0, 2).toUpperCase();

      return (
        <tr key={u.id} className="border-b border-zinc-800/50 last:border-0 hover:bg-zinc-800/20 transition-colors">
          {/* Avatar + name */}
          {/* max-w-0 + w-full is what lets `truncate` below engage in an
              auto-layout table: without a width bound a long email widened
              the table past its wrapper and clipped the Downloads column. */}
          <td className="py-2.5 pl-4 pr-3 max-w-0 w-full">
            <div className="flex items-center gap-2.5 min-w-0">
              {/* Plex/Jellyfin avatar URL comes from an arbitrary upstream host (can't be
                  added to next/image remotePatterns up front); the shared Avatar falls back
                  to initials when the thumb is missing or fails to load. */}
              <Avatar className={`size-7 shrink-0 ${avatarColors[source] ?? "bg-zinc-700"}`}>
                {u.thumbUrl ? <AvatarImage src={u.thumbUrl} alt={u.username} /> : null}
                <AvatarFallback className={`bg-transparent text-[10px] font-bold ${avatarText[source] ?? "text-zinc-100"}`}>
                  {initials}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-medium text-zinc-100 truncate">{u.username}</span>
                  {u.isServerAdmin && (
                    <ShieldCheck className="w-3 h-3 text-indigo-400 shrink-0" aria-label="Server admin" />
                  )}
                  {!u.active && (
                    <Badge
                      className="border-zinc-700 bg-zinc-800 text-zinc-400 text-[10px] shrink-0"
                      title="No longer on the media server. Listed because their watch history is still here and can be attributed."
                    >
                      departed
                    </Badge>
                  )}
                </div>
                {u.email && (
                  <span className="text-[11px] text-zinc-500 truncate block">{u.email}</span>
                )}
                {/* The Source and Linked-account columns are hidden on narrow
                    screens; stack them here so a phone can still tell Plex from
                    Jellyfin and fix a row's attribution. */}
                <div className="md:hidden mt-1 flex flex-wrap items-center gap-1.5">
                  <Badge className={`sm:hidden text-[10px] ${sourceStyles[source] ?? ""}`}>
                    {mediaInstanceLabel(source, u.serverInstance)}
                  </Badge>
                  <LinkPicker row={u} accounts={accounts} />
                </div>
              </div>
            </div>
          </td>

          {/* Source badge — includes the instance slug for a named server
              (e.g. "jellyfin:remote") so a same-named user on two servers of
              the same provider is distinguishable; unchanged ("jellyfin") for
              the default/only instance in a single-server deployment. */}
          <td className="py-2.5 px-3 hidden sm:table-cell">
            <Badge className={`text-[10px] ${sourceStyles[source] ?? ""}`}>
              {mediaInstanceLabel(source, u.serverInstance)}
            </Badge>
          </td>

          {/* Linked Summonarr account — whose watch history this identity feeds */}
          <td className="py-2.5 px-3 hidden md:table-cell">
            <LinkPicker row={u} accounts={accounts} />
          </td>

          {/* Downloads toggle (Jellyfin only — Plex sharing API does not support remote toggle) */}
          <td className="py-2.5 pl-3 pr-4 text-right">
            {source === "jellyfin" ? (
              <DownloadToggle
                userId={u.id}
                enabled={u.downloadsEnabled}
                disabled={u.isServerAdmin}
              />
            ) : (
              <span className="text-[11px] text-zinc-500">—</span>
            )}
          </td>
        </tr>
      );
    });
  }

  if (users.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3 py-2">
        {hasJellyfin && <AutoDisableToggle initial={autoDisableNew} />}
        <p className="text-sm text-zinc-500">No media server users synced yet.</p>
        <SyncUsersButton />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {hasJellyfin && <AutoDisableToggle initial={autoDisableNew} />}

      {/* Toolbar: bulk controls + sync button */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-4">
          {hasJellyfin && <BulkBar source="jellyfin" label="Jellyfin" />}
        </div>
        <SyncUsersButton />
      </div>

      {/* Search */}
      <input
        type="search"
        placeholder="Filter by username or email…"
        aria-label="Filter server users"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full sm:w-72 rounded-lg border border-zinc-700 bg-zinc-800/60 px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
      />

      <div className="rounded-xl border border-zinc-800 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 bg-zinc-900/60">
              <th scope="col" className="py-2 pl-4 pr-3 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500">User</th>
              <th scope="col" className="py-2 px-3 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500 hidden sm:table-cell">Source</th>
              <th scope="col" className="py-2 px-3 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500 hidden md:table-cell">Linked account</th>
              <th scope="col" className="py-2 pl-3 pr-4 text-right text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Downloads</th>
            </tr>
          </thead>
          <tbody className="bg-zinc-900/30">
            {renderGroup(plexUsers, "plex")}
            {renderGroup(jellyfinUsers, "jellyfin")}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={4} className="py-6 px-4 text-center text-sm text-zinc-500">
                  No users match &ldquo;{search.trim()}&rdquo;.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Both counts use the same search-filtered set, so they always agree. */}
      <p className="text-[11px] text-zinc-500">
        {filtered.length} server {filtered.length === 1 ? "user" : "users"}
        {search.trim() && ` of ${users.length}`}
        {hasJellyfin && (
          <>
            {" · "}
            {disabledJellyfinCount} Jellyfin user{disabledJellyfinCount === 1 ? "" : "s"} with downloads disabled
          </>
        )}
      </p>
    </div>
  );
}
