"use client";

import { useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";

interface LeaderboardEntry {
  id: string;
  username: string;
  source: string;
  hours?: number;
  count?: number;
}

interface ActivityLeaderboardProps {
  byHours: { id: string; username: string; source: string; hours: number }[];
  byPlays: { id: string; username: string; source: string; count: number }[];
  days: number;
}

function SourceBadge({ source }: { source: string }) {
  if (source === "plex") {
    return <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-500/15 text-amber-400">Plex</span>;
  }
  if (source === "jellyfin") {
    return <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-purple-500/15 text-purple-400">Jellyfin</span>;
  }
  return null;
}

export function ActivityLeaderboard({ byHours, byPlays, days }: ActivityLeaderboardProps) {
  const [tab, setTab] = useState<"hours" | "plays">("hours");

  const data = tab === "hours" ? byHours : byPlays;
  if (data.length === 0) return null;

  const maxValue = tab === "hours" ? (byHours[0]?.hours ?? 1) : (byPlays[0]?.count ?? 1);
  const label = tab === "hours" ? "h" : "plays";

  return (
    <Card className="bg-zinc-900 border-zinc-800 p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-white text-sm">User Leaderboard ({days}d)</h3>
        <div className="flex gap-1 bg-zinc-800 rounded p-0.5">
          <button
            onClick={() => setTab("hours")}
            className={`px-2 py-1 text-xs font-medium rounded transition-colors ${
              tab === "hours"
                ? "bg-indigo-600 text-white"
                : "text-zinc-400 hover:text-white"
            }`}
          >
            By Watch Time
          </button>
          <button
            onClick={() => setTab("plays")}
            className={`px-2 py-1 text-xs font-medium rounded transition-colors ${
              tab === "plays"
                ? "bg-indigo-600 text-white"
                : "text-zinc-400 hover:text-white"
            }`}
          >
            By Plays
          </button>
        </div>
      </div>

      <div className="space-y-2.5">
        {(tab === "hours" ? byHours : byPlays).map((u, i) => {
          const value = tab === "hours"
            ? (Math.round(Number((u as typeof byHours[0]).hours ?? 0) * 10) / 10)
            : (u as typeof byPlays[0]).count;
          const percentage = maxValue > 0 ? (Number(value) / maxValue) * 100 : 0;

          return (
            <div key={u.id} className="flex items-center gap-2.5">
              <span className="text-zinc-600 w-5 text-right text-xs font-medium">{i + 1}</span>
              <SourceBadge source={u.source} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between text-sm mb-0.5">
                  <Link
                    href={`/admin/activity/user/${u.id}`}
                    className="text-white hover:text-indigo-400 transition-colors truncate text-xs"
                  >
                    {u.username}
                  </Link>
                  <span className="text-zinc-400 tabular-nums shrink-0 ml-2 text-xs">
                    {tab === "hours" ? `${value}h` : `${value} plays`}
                  </span>
                </div>
                <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-emerald-600 rounded-full"
                    style={{ width: `${percentage}%` }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
