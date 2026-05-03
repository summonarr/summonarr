"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Download, Ban, ShieldCheck, Link, Loader2, RefreshCw } from "lucide-react";

interface ServerUser {
  id: string;
  source: string;
  sourceUserId: string;
  username: string;
  email: string | null;
  thumbUrl: string | null;
  downloadsEnabled: boolean | null;
  isServerAdmin: boolean;
  userId: string | null;
  user: { name: string | null; email: string } | null;
}

interface ServerUserTableProps {
  users: ServerUser[];
  hasPlex: boolean;
  hasJellyfin: boolean;
  autoDisableNew: boolean;
}

const sourceStyles: Record<string, string> = {
  plex:     "border-yellow-600/30 bg-yellow-500/10 text-yellow-400",
  jellyfin: "border-purple-600/30 bg-purple-500/10 text-purple-400",
};

const avatarColors: Record<string, string> = {
  plex:     "bg-yellow-600",
  jellyfin: "bg-purple-700",
};

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

  async function toggle() {
    // null means not-yet-synced — first click enables downloads
    const next = !(optimistic ?? false);
    setOptimistic(next);
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/server-users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ downloadsEnabled: next }),
      });
      if (!res.ok) {
        setOptimistic(optimistic);
      } else {
        router.refresh();
      }
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
      <span className="text-[11px] text-zinc-600 italic">not synced</span>
    );
  }

  const on = optimistic;

  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={loading}
      onClick={toggle}
      title={on ? "Downloads enabled — click to disable" : "Downloads disabled — click to enable"}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:opacity-50 ${on ? "bg-green-600" : "bg-zinc-700"}`}
    >
      {loading ? (
        <Loader2 className="w-3 h-3 text-white absolute left-1 animate-spin" />
      ) : (
        <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${on ? "translate-x-4" : "translate-x-0.5"}`} />
      )}
    </button>
  );
}

function SyncUsersButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function sync() {
    setLoading(true);
    try {
      await fetch("/api/cron/sync-download-policies", { method: "POST" });
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={sync}
      disabled={loading}
      className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-zinc-700 bg-zinc-800/60 text-zinc-300 hover:bg-zinc-700/60 hover:text-white transition-colors disabled:opacity-50"
    >
      {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
      {loading ? "Syncing…" : "Sync users from server"}
    </button>
  );
}

function BulkBar({
  source,
  label,
}: {
  source: "plex" | "jellyfin";
  label: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState<"disable" | "enable" | null>(null);

  async function bulk(downloadsEnabled: boolean) {
    setLoading(downloadsEnabled ? "enable" : "disable");
    try {
      await fetch("/api/admin/server-users/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, downloadsEnabled }),
      });
      router.refresh();
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-zinc-500">{label}:</span>
      <button
        onClick={() => bulk(false)}
        disabled={loading !== null}
        className="flex items-center gap-1 px-2 py-0.5 text-xs rounded border border-red-800/40 bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors disabled:opacity-50"
      >
        {loading === "disable" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Ban className="w-3 h-3" />}
        Disable all
      </button>
      <button
        onClick={() => bulk(true)}
        disabled={loading !== null}
        className="flex items-center gap-1 px-2 py-0.5 text-xs rounded border border-green-800/40 bg-green-500/10 text-green-400 hover:bg-green-500/20 transition-colors disabled:opacity-50"
      >
        {loading === "enable" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
        Enable all
      </button>
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
      const res = await fetch("/api/admin/server-users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoDisableNew: next }),
      });
      if (!res.ok) setOn(on);
      else router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center gap-2.5 py-2 px-3 rounded-lg border border-zinc-800 bg-zinc-900/60">
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-zinc-200">Auto-disable downloads for new users</p>
        <p className="text-[11px] text-zinc-500 mt-0.5">
          New accounts discovered on sync have downloads disabled. Manually re-enabled users are left alone.
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        disabled={loading}
        onClick={toggle}
        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:opacity-50 ${on ? "bg-indigo-600" : "bg-zinc-700"}`}
      >
        {loading
          ? <Loader2 className="w-3 h-3 text-white absolute left-1 animate-spin" />
          : <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${on ? "translate-x-4" : "translate-x-0.5"}`} />
        }
      </button>
    </div>
  );
}

export function ServerUserTable({ users, hasPlex, hasJellyfin, autoDisableNew }: ServerUserTableProps) {
  const [search, setSearch] = useState("");

  const filtered = search.trim()
    ? users.filter(
        (u) =>
          u.username.toLowerCase().includes(search.toLowerCase()) ||
          (u.email ?? "").toLowerCase().includes(search.toLowerCase()),
      )
    : users;

  const plexUsers = filtered.filter((u) => u.source === "plex");
  const jellyfinUsers = filtered.filter((u) => u.source === "jellyfin");

  function renderGroup(group: ServerUser[], source: string) {
    if (group.length === 0) return null;
    return group.map((u) => {
      const initials = u.username.slice(0, 2).toUpperCase();
      const linked = u.user ?? null;

      return (
        <tr key={u.id} className="border-b border-zinc-800/50 last:border-0 hover:bg-zinc-800/20 transition-colors">
          {/* Avatar + name */}
          <td className="py-2.5 pl-4 pr-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className={`w-7 h-7 shrink-0 rounded-full ${avatarColors[source] ?? "bg-zinc-700"} flex items-center justify-center`}>
                {u.thumbUrl ? (
                  <img src={u.thumbUrl} alt={u.username} className="w-7 h-7 rounded-full object-cover" />
                ) : (
                  <span className="text-[10px] font-bold text-white">{initials}</span>
                )}
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-medium text-white truncate">{u.username}</span>
                  {u.isServerAdmin && (
                    <ShieldCheck className="w-3 h-3 text-indigo-400 shrink-0" aria-label="Server admin" />
                  )}
                </div>
                {u.email && (
                  <span className="text-[11px] text-zinc-500 truncate block">{u.email}</span>
                )}
              </div>
            </div>
          </td>

          {/* Source badge */}
          <td className="py-2.5 px-3 hidden sm:table-cell">
            <Badge className={`text-[10px] ${sourceStyles[source] ?? ""}`}>
              {source}
            </Badge>
          </td>

          {/* Linked Summonarr account */}
          <td className="py-2.5 px-3 hidden md:table-cell">
            {linked ? (
              <div className="flex items-center gap-1 text-xs text-zinc-400">
                <Link className="w-3 h-3 text-zinc-500 shrink-0" />
                <span className="truncate max-w-[140px]">{linked.name ?? linked.email}</span>
              </div>
            ) : (
              <span className="text-xs text-zinc-600">—</span>
            )}
          </td>

          {/* Downloads toggle */}
          <td className="py-2.5 pl-3 pr-4 text-right">
            <DownloadToggle
              userId={u.id}
              enabled={u.downloadsEnabled}
              disabled={u.isServerAdmin}
            />
          </td>
        </tr>
      );
    });
  }

  if (users.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3 py-2">
        <AutoDisableToggle initial={autoDisableNew} />
        <p className="text-sm text-zinc-500">No media server users synced yet.</p>
        <SyncUsersButton />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <AutoDisableToggle initial={autoDisableNew} />

      {/* Toolbar: bulk controls + sync button */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-4">
          {hasPlex && <BulkBar source="plex" label="Plex" />}
          {hasJellyfin && <BulkBar source="jellyfin" label="Jellyfin" />}
        </div>
        <SyncUsersButton />
      </div>

      {/* Search */}
      <input
        type="search"
        placeholder="Filter by username or email…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full sm:w-72 rounded-lg border border-zinc-700 bg-zinc-800/60 px-3 py-1.5 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
      />

      <div className="rounded-xl border border-zinc-800 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 bg-zinc-900/60">
              <th className="py-2 pl-4 pr-3 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500">User</th>
              <th className="py-2 px-3 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500 hidden sm:table-cell">Source</th>
              <th className="py-2 px-3 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500 hidden md:table-cell">Linked account</th>
              <th className="py-2 pl-3 pr-4 text-right text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Downloads</th>
            </tr>
          </thead>
          <tbody className="bg-zinc-900/30">
            {renderGroup(plexUsers, "plex")}
            {renderGroup(jellyfinUsers, "jellyfin")}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-zinc-600">
        {users.length} server {users.length === 1 ? "user" : "users"} ·{" "}
        {users.filter((u) => !u.isServerAdmin && u.downloadsEnabled === false).length} with downloads disabled
      </p>
    </div>
  );
}
