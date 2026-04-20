import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { getAllUsersStats } from "@/lib/play-history";
import { ActivityFilterBar } from "@/components/admin/activity-filter-bar";
import { Users } from "lucide-react";

export const dynamic = "force-dynamic";

function formatRelativeTime(date: Date | null): string {
  if (!date) return "Never";
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default async function UsersActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string }>;
}) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") redirect("/");

  const { search } = await searchParams;

  let users = await getAllUsersStats();

  if (search) {
    const q = search.toLowerCase();
    users = users.filter((u) => u.username.toLowerCase().includes(q));
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-1 flex items-center gap-2">
          <Users className="w-6 h-6 text-zinc-400" />
          Server Users
        </h1>
        <p className="text-zinc-400 text-sm">{users.length} user{users.length !== 1 ? "s" : ""} with play history</p>
      </div>

      <ActivityFilterBar />

      {}
      <form method="GET" className="mb-4">
        <input
          type="text"
          name="search"
          defaultValue={search ?? ""}
          placeholder="Search by username…"
          className="w-full max-w-xs px-3 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded-lg text-white placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500"
        />
      </form>

      <Card className="bg-zinc-900 border-zinc-800 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-zinc-500 uppercase tracking-wider border-b border-zinc-800">
                <th className="text-left py-3 px-4">User</th>
                <th className="text-left py-3 px-4">Source</th>
                <th className="text-right py-3 px-4">Plays</th>
                <th className="text-right py-3 px-4">Watch Time</th>
                <th className="text-left py-3 px-4">Last Active</th>
                <th className="text-left py-3 px-4">Fav Platform</th>
                <th className="text-right py-3 px-4">Direct %</th>
              </tr>
            </thead>
            <tbody>
              {users.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-zinc-500 text-sm">
                    No users found
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
                        {u.thumbUrl && /^https?:\/\//i.test(u.thumbUrl) ? (
                          <img src={u.thumbUrl} alt="" className="w-7 h-7 rounded-full object-cover shrink-0" />
                        ) : (
                          <div className="w-7 h-7 rounded-full bg-zinc-700 flex items-center justify-center shrink-0">
                            <span className="text-[10px] text-zinc-400 font-medium">
                              {u.username.slice(0, 2).toUpperCase()}
                            </span>
                          </div>
                        )}
                        <span className="text-white group-hover:text-indigo-400 transition-colors font-medium">
                          {u.username}
                        </span>
                      </Link>
                    </td>
                    <td className="py-3 px-4">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                        u.source === "plex" ? "bg-amber-500/15 text-amber-400" : "bg-purple-500/15 text-purple-400"
                      }`}>
                        {u.source === "plex" ? "Plex" : "Jellyfin"}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right text-zinc-300 tabular-nums font-medium">
                      {u.plays > 0 ? u.plays.toLocaleString() : <span className="text-zinc-600">0</span>}
                    </td>
                    <td className="py-3 px-4 text-right text-zinc-400 tabular-nums">
                      {u.hours > 0 ? `${u.hours}h` : <span className="text-zinc-600">—</span>}
                    </td>
                    <td className="py-3 px-4 text-zinc-400 text-xs">
                      {formatRelativeTime(u.lastActive)}
                    </td>
                    <td className="py-3 px-4 text-zinc-400 text-xs truncate max-w-[120px]">
                      {u.favPlatform ?? <span className="text-zinc-600">—</span>}
                    </td>
                    <td className="py-3 px-4 text-right">
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
                        <span className="text-zinc-600 text-xs">—</span>
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
