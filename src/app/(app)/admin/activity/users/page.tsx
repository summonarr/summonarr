import { authActive } from "@/lib/auth";
import { redirect } from "next/navigation";
import { hasPermission, Permission } from "@/lib/permissions";
import { requireFeature } from "@/lib/features";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { getAllUsersStats } from "@/lib/play-history";
import { getCachedPlexMembersByInstance } from "@/lib/plex-membership";
import { getLiveJellyfinUsers } from "@/lib/jellyfin-live-members";
import { Chip, PageHeader } from "@/components/ui/design";
import { ActivityFilterBar } from "@/components/admin/activity-filter-bar";
import { ArrowDown, ArrowUp, ArrowUpDown } from "@/components/icons";
import { relativeWithDateFallback } from "../_relative";
import { getLocale, getTranslator } from "@/lib/i18n/server";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";

export const dynamic = "force-dynamic";

const SORT_FIELDS = ["user", "source", "plays", "hours", "lastActive"] as const;
type SortField = (typeof SORT_FIELDS)[number];
type SortDir = "asc" | "desc";

const STATUS_FILTERS = ["all", "active", "removed"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

const DEFAULT_DIR: Record<SortField, SortDir> = {
  user: "asc",
  source: "asc",
  plays: "desc",
  hours: "desc",
  lastActive: "desc",
};

function SortHeader({
  label,
  field,
  currentSort,
  currentDir,
  search,
  status,
  align = "left",
}: {
  label: string;
  field: SortField;
  currentSort: SortField;
  currentDir: SortDir;
  search: string | undefined;
  status: StatusFilter;
  align?: "left" | "right";
}) {
  const isActive = currentSort === field;
  const nextDir: SortDir = isActive
    ? currentDir === "asc"
      ? "desc"
      : "asc"
    : DEFAULT_DIR[field];

  const params = new URLSearchParams();
  if (search) params.set("search", search);
  if (status !== "all") params.set("status", status);
  params.set("sort", field);
  params.set("dir", nextDir);

  const alignClass = align === "right" ? "text-right" : "text-left";
  const flexAlign = align === "right" ? "justify-end" : "justify-start";

  // The Link is the hit target, not the <th>: py-1 on the cell + min-h-8 on the
  // link keeps the row at its previous 40px while making the whole 32px
  // tappable.
  return (
    <th scope="col" className={`py-1 px-4 ${alignClass}`}>
      <Link
        href={`/admin/activity/users?${params.toString()}`}
        className={`inline-flex items-center min-h-8 gap-1 select-none rounded hover:text-zinc-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent-ring)] ${flexAlign}`}
      >
        <span>{label}</span>
        {isActive ? (
          currentDir === "asc" ? (
            <ArrowUp className="w-3 h-3" />
          ) : (
            <ArrowDown className="w-3 h-3" />
          )
        ) : (
          <ArrowUpDown className="w-3 h-3 opacity-30" />
        )}
      </Link>
    </th>
  );
}

// A Plex row is one person on ONE server (rows are per serverInstance), so it is
// checked against that server's own share list — never the union across every
// Plex server, which kept a friend unshared from B "Active" there while A still
// shared with them. A server whose list can't be read (or a removed server,
// whose rows were soft-deleted) falls back to `active`, as Jellyfin does.
function plexOnServer(
  u: { active: boolean; isServerAdmin: boolean; serverInstance: string; sourceUserId: string },
  byInstance: Awaited<ReturnType<typeof getCachedPlexMembersByInstance>>,
): boolean {
  if (u.isServerAdmin) return true;
  const members = byInstance?.get(u.serverInstance);
  if (!members) return u.active;
  return members.ids.has(u.sourceUserId);
}

function jellyfinOnServer(
  u: { active: boolean; serverInstance: string; sourceUserId: string },
  live: Awaited<ReturnType<typeof getLiveJellyfinUsers>> | null,
): boolean {
  const users = live?.get(u.serverInstance);
  if (!users) return u.active;
  const disabled = users.get(u.sourceUserId);
  return disabled !== undefined && !disabled;
}

export default async function UsersActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string | string[]; sort?: string; dir?: string; status?: string | string[] }>;
}) {
  await requireFeature("feature.admin.activity");
  const session = await authActive();
  if (!session || !hasPermission(session.user.permissions, Permission.ADMIN)) redirect("/");

  const { search: searchRaw, sort: sortParam, dir: dirParam, status: statusRaw } = await searchParams;
  // A repeated ?search= arrives as an array at runtime; `.toLowerCase()` on it
  // would 500 the page. Take the first value.
  const search = Array.isArray(searchRaw) ? searchRaw[0] : searchRaw;
  const statusParam = Array.isArray(statusRaw) ? statusRaw[0] : statusRaw;
  const status: StatusFilter = (STATUS_FILTERS as readonly string[]).includes(statusParam ?? "")
    ? (statusParam as StatusFilter)
    : "all";
  const [t, locale] = await Promise.all([getTranslator(), getLocale()]);

  const sort: SortField = (SORT_FIELDS as readonly string[]).includes(sortParam ?? "")
    ? (sortParam as SortField)
    : "plays";
  const dir: SortDir = dirParam === "asc" ? "asc" : dirParam === "desc" ? "desc" : DEFAULT_DIR[sort];

  const allStats = await getAllUsersStats();

  // "Still on the server" is read live from each server, not from the stored
  // `active` flag alone: nothing marks a Plex user inactive, and the hourly
  // Jellyfin sync can lag or refuse a shrink. Each row is checked against ITS
  // OWN server: Plex rows against that server's plex.tv share list (the
  // per-instance sets the sign-in gate unions), Jellyfin rows against that
  // server's current /Users — both falling back to `active` for a server that
  // couldn't be read.
  const [plexMembers, jellyfinLive] =
    status === "all" ? [null, null] : await Promise.all([getCachedPlexMembersByInstance(), getLiveJellyfinUsers()]);
  let users = allStats.map((u) => ({
    ...u,
    onServer: u.source === "plex" ? plexOnServer(u, plexMembers) : jellyfinOnServer(u, jellyfinLive),
  }));

  if (status !== "all") users = users.filter((u) => u.onServer === (status === "active"));

  if (search) {
    const q = search.toLowerCase();
    users = users.filter((u) => u.username.toLowerCase().includes(q));
  }

  const mult = dir === "asc" ? 1 : -1;
  users = [...users].sort((a, b) => {
    switch (sort) {
      case "user":
        return a.username.localeCompare(b.username) * mult;
      case "source":
        return (a.source.localeCompare(b.source) || a.username.localeCompare(b.username)) * mult;
      case "plays":
        return (a.plays - b.plays) * mult;
      case "hours":
        return (a.hours - b.hours) * mult;
      case "lastActive": {
        const av = a.lastActive ? a.lastActive.getTime() : -Infinity;
        const bv = b.lastActive ? b.lastActive.getTime() : -Infinity;
        return (av - bv) * mult;
      }
    }
  });

  return (
    <div className="ds-page-enter">
      <PageHeader
        title={t("adminActivity.users.title")}
        subtitle={t("adminActivity.users.subtitle", { count: users.length })}
      />

      <ActivityFilterBar />

      <nav aria-label={t("adminActivity.users.statusAria")} className="mb-3 flex flex-wrap gap-2">
        {STATUS_FILTERS.map((f) => {
          const params = new URLSearchParams();
          if (search) params.set("search", search);
          if (f !== "all") params.set("status", f);
          params.set("sort", sort);
          params.set("dir", dir);
          const selected = f === status;
          return (
            <Link
              key={f}
              href={`/admin/activity/users?${params.toString()}`}
              aria-current={selected ? "true" : undefined}
              className={`px-3 py-1 text-xs rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent-ring)] ${
                selected
                  ? "bg-zinc-700 border-zinc-600 text-zinc-100"
                  : "border-zinc-700 text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {t(`adminActivity.users.status.${f}`)}
            </Link>
          );
        })}
      </nav>

      <form method="GET" className="mb-4">
        <input type="hidden" name="sort" value={sort} />
        <input type="hidden" name="dir" value={dir} />
        {status !== "all" && <input type="hidden" name="status" value={status} />}
        <input
          type="search"
          name="search"
          aria-label={t("adminActivity.users.searchAria")}
          defaultValue={search ?? ""}
          placeholder={t("adminActivity.users.searchPlaceholder")}
          className="w-full max-w-xs px-3 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-[var(--ds-accent-ring)]"
        />
      </form>

      <Card className="bg-zinc-900 border-zinc-800 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-zinc-500 uppercase tracking-wider border-b border-zinc-800">
                <SortHeader label={t("adminActivity.field.user")} field="user" currentSort={sort} currentDir={dir} search={search} status={status} />
                <SortHeader label={t("adminActivity.filter.source")} field="source" currentSort={sort} currentDir={dir} search={search} status={status} />
                <SortHeader label={t("adminActivity.stat.plays")} field="plays" currentSort={sort} currentDir={dir} search={search} status={status} align="right" />
                <SortHeader label={t("adminActivity.kpi.watchTime")} field="hours" currentSort={sort} currentDir={dir} search={search} status={status} align="right" />
                <SortHeader label={t("adminActivity.user.lastActive")} field="lastActive" currentSort={sort} currentDir={dir} search={search} status={status} />
                {/* Hide Fav Platform + Direct % below the sm breakpoint — the
                    7-col table sums to ~831 px (≈1.9× a 440 px viewport). The
                    two hidden columns are the lowest-information for a mobile
                    leaderboard view. */}
                <th scope="col" className="hidden sm:table-cell text-left py-3 px-4">{t("adminActivity.users.favPlatform")}</th>
                <th scope="col" className="hidden sm:table-cell text-right py-3 px-4">{t("adminActivity.users.directPct")}</th>
              </tr>
            </thead>
            <tbody>
              {users.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-zinc-500 text-sm">
                    {t("adminActivity.users.empty")}
                  </td>
                </tr>
              ) : (
                users.map((u) => (
                  <tr key={u.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors">
                    <td className="py-3 px-4">
                      <Link
                        href={`/admin/activity/user/${u.id}`}
                        className="flex items-center gap-2.5 group"
                      >
                        {/* Avatar URL is from an arbitrary upstream media-server host (can't be
                            allowlisted in next/image remotePatterns); the shared Avatar falls
                            back to initials when the thumb is missing or fails to load. */}
                        <Avatar className="size-7 shrink-0">
                          {u.thumbUrl && /^https?:\/\//i.test(u.thumbUrl) ? (
                            <AvatarImage src={u.thumbUrl} alt="" />
                          ) : null}
                          <AvatarFallback className="bg-zinc-700 text-[10px] text-zinc-400 font-medium">
                            {u.username.slice(0, 2).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <span className="text-zinc-100 group-hover:text-indigo-400 transition-colors font-medium">
                          {u.username}
                        </span>
                      </Link>
                    </td>
                    <td className="py-3 px-4">
                      {u.source === "plex" ? (
                        <Chip tone="plex">Plex</Chip>
                      ) : (
                        <Chip tone="jellyfin">Jellyfin</Chip>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right text-zinc-300 tabular-nums font-medium">
                      {u.plays > 0 ? u.plays.toLocaleString(locale) : <span className="text-zinc-500">0</span>}
                    </td>
                    <td className="py-3 px-4 text-right text-zinc-400 tabular-nums">
                      {u.hours > 0 ? `${u.hours}h` : <span className="text-zinc-500">—</span>}
                    </td>
                    <td className="py-3 px-4 text-zinc-400 text-xs">
                      {u.lastActive ? relativeWithDateFallback(u.lastActive, locale) : t("adminActivity.users.never")}
                    </td>
                    <td className="hidden sm:table-cell py-3 px-4 text-zinc-400 text-xs truncate max-w-[120px]">
                      {u.favPlatform ?? <span className="text-zinc-500">—</span>}
                    </td>
                    <td className="hidden sm:table-cell py-3 px-4 text-right">
                      {u.directPct !== null ? (
                        <div className="flex items-center justify-end gap-2">
                          <div className="w-16 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-green-500 rounded-full"
                              style={{ width: `${u.directPct}%` }}
                            />
                          </div>
                          <span className={`text-xs tabular-nums w-8 text-right ${
                            u.directPct >= 80 ? "text-green-400" : u.directPct >= 50 ? "text-zinc-300" : "text-orange-400"
                          }`}>
                            {u.directPct}%
                          </span>
                        </div>
                      ) : (
                        <span className="text-zinc-500 text-xs">—</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
