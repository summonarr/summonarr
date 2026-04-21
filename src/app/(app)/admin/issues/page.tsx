import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { posterUrl } from "@/lib/tmdb";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { IssueActions } from "@/components/admin/issue-actions";
import { IssueCardShell } from "@/components/admin/issue-card-shell";
import { IssueThread } from "@/components/issues/issue-thread";
import Image from "next/image";
import { Film, Tv2, MessageSquare } from "lucide-react";
import { IssueFixMatchButton } from "@/components/admin/issue-fix-match-button";
import { LiveRefresh } from "@/components/live-refresh";
import { requireFeature } from "@/lib/features";

const STATUS_STYLES: Record<string, string> = {
  OPEN: "bg-red-500/10 text-red-400 border-red-500/20",
  IN_PROGRESS: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  RESOLVED: "bg-green-500/10 text-green-400 border-green-500/20",
};

const STATUS_LABEL: Record<string, string> = {
  OPEN: "Open",
  IN_PROGRESS: "In Progress",
  RESOLVED: "Resolved",
};

const ISSUE_TYPE_LABELS: Record<string, string> = {
  BAD_VIDEO: "Bad video",
  WRONG_AUDIO: "Wrong audio",
  MISSING_SUBTITLES: "Missing subtitles",
  WRONG_MATCH: "Wrong match",
  OTHER: "Other",
};

const SCOPE_LABELS: Record<string, string> = {
  FULL: "Full",
  SEASON: "Season",
  EPISODE: "Episode",
};

const VALID_FILTERS = ["ALL", "OPEN", "IN_PROGRESS", "RESOLVED"] as const;
type FilterValue = (typeof VALID_FILTERS)[number];

function groupIssues<T extends {
  id: string;
  tmdbId: number;
  issueType: string;
  scope: string;
  seasonNumber: number | null;
  episodeNumber: number | null;
  createdAt: Date;
  _count: { messages: number };
}>(issues: T[]): { representative: T; count: number; reporterNames: string[] }[] {
  const map = new Map<string, T[]>();
  for (const issue of issues) {
    const key = `${issue.tmdbId}::${issue.issueType}::${issue.scope}::${issue.seasonNumber ?? ""}::${issue.episodeNumber ?? ""}`;
    const group = map.get(key) ?? [];
    group.push(issue);
    map.set(key, group);
  }
  return Array.from(map.values())
    .map((group) => {
      group.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const names = group.map((i) => (i as unknown as { user: { name: string | null; email: string } }).user?.name ?? (i as unknown as { user: { name: string | null; email: string } }).user?.email ?? "Unknown");
      return { representative: group[0], count: group.length, reporterNames: names };
    })
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return b.representative.createdAt.getTime() - a.representative.createdAt.getTime();
    });
}

export default async function AdminIssuesPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; selected?: string }>;
}) {
  await requireFeature("feature.page.issues");
  const session = await auth();
  if (!session || (session.user.role !== "ADMIN" && session.user.role !== "ISSUE_ADMIN")) redirect("/");

  const { filter: rawFilter, selected: selectedId } = await searchParams;
  const filter: FilterValue = VALID_FILTERS.includes(rawFilter as FilterValue)
    ? (rawFilter as FilterValue)
    : "OPEN";

  const [allIssues, statusCounts] = await Promise.all([
    prisma.issue.findMany({
      include: {
        user: { select: { name: true, email: true } },
        _count: { select: { messages: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 500,
    }),
    prisma.issue.groupBy({ by: ["status"], _count: { status: true } }),
  ]);

  const countFor = (status: string) =>
    statusCounts.find((s) => s.status === status)?._count.status ?? 0;

  const stats = [
    { label: "Open", value: countFor("OPEN"), filter: "OPEN" as FilterValue },
    { label: "In Progress", value: countFor("IN_PROGRESS"), filter: "IN_PROGRESS" as FilterValue },
    { label: "Resolved", value: countFor("RESOLVED"), filter: "RESOLVED" as FilterValue },
    { label: "Total", value: allIssues.length, filter: "ALL" as FilterValue },
  ];

  const filtered = filter === "ALL" ? allIssues : allIssues.filter((i) => i.status === filter);
  const groups = groupIssues(filtered);

  let selectedIssue = selectedId ? allIssues.find((i) => i.id === selectedId) ?? null : null;
  if (selectedId && !selectedIssue) {
    selectedIssue = await prisma.issue.findUnique({
      where: { id: selectedId },
      include: {
        user: { select: { name: true, email: true } },
        _count: { select: { messages: true } },
      },
    });
  }

  const allTvTmdbIds = [...new Map(
    groups
      .filter(({ representative: i }) => i.mediaType === "TV")
      .map(({ representative: i }) => [`${i.tmdbId}:${i.mediaType}`, { tmdbId: i.tmdbId, mediaType: i.mediaType }])
  ).values()];
  const [plexItems, jellyfinItems] = allTvTmdbIds.length > 0
    ? await Promise.all([
        prisma.plexLibraryItem.findMany({
          where: { OR: allTvTmdbIds.map(({ tmdbId, mediaType }) => ({ tmdbId, mediaType })) },
          select: { tmdbId: true, mediaType: true },
        }),
        prisma.jellyfinLibraryItem.findMany({
          where: { OR: allTvTmdbIds.map(({ tmdbId, mediaType }) => ({ tmdbId, mediaType })) },
          select: { tmdbId: true, mediaType: true },
        }),
      ])
    : [[], []];
  const plexSet     = new Set(plexItems.map((i)     => `${i.tmdbId}:${i.mediaType}`));
  const jellyfinSet = new Set(jellyfinItems.map((i) => `${i.tmdbId}:${i.mediaType}`));

  const tabs: { label: string; value: FilterValue; count: number }[] = [
    { label: "Open", value: "OPEN", count: countFor("OPEN") },
    { label: "In Progress", value: "IN_PROGRESS", count: countFor("IN_PROGRESS") },
    { label: "Resolved", value: "RESOLVED", count: countFor("RESOLVED") },
    { label: "All", value: "ALL", count: allIssues.length },
  ];

  function issueHref(id: string): string {
    return `/admin/issues?filter=${filter}&selected=${id}`;
  }

  return (
    <div>
      <LiveRefresh on={["issue:new", "issue:updated", "issue:deleted", "issuemessage:created"]} />
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-1">Issues</h1>
        <p className="text-zinc-400 text-sm">User-reported media quality problems</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {stats.map((s) => (
          <Link key={s.label} href={`?filter=${s.filter}`}>
            <Card className={`bg-zinc-900 border-zinc-800 p-5 cursor-pointer transition-colors hover:border-zinc-600 ${filter === s.filter ? "border-zinc-600 ring-1 ring-zinc-600" : ""}`}>
              <p className="text-xs text-zinc-500 uppercase tracking-wide mb-1">{s.label}</p>
              <p className="text-3xl font-bold text-white">{s.value}</p>
            </Card>
          </Link>
        ))}
      </div>

      <div className="flex gap-1 mb-5 border-b border-zinc-800 pb-0">
        {tabs.map((tab) => (
          <Link
            key={tab.value}
            href={`?filter=${tab.value}`}
            className={`px-4 py-2 text-sm rounded-t transition-colors flex items-center gap-2 ${
              filter === tab.value
                ? "text-white border-b-2 border-white -mb-px"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {tab.label}
            <span className={`text-[11px] rounded-full px-1.5 py-0.5 ${filter === tab.value ? "bg-zinc-700 text-zinc-300" : "bg-zinc-800 text-zinc-500"}`}>
              {tab.count}
            </span>
          </Link>
        ))}
      </div>

      {groups.length === 0 ? (
        <Card className="bg-zinc-900 border-zinc-800">
          <div className="p-8 text-center text-zinc-500 text-sm">No issues in this category.</div>
        </Card>
      ) : (
        <div className="xl:grid xl:grid-cols-[1fr_480px] xl:gap-6 xl:items-start">
          <div className="min-w-0">
            <div className="flex flex-col gap-3">
              {groups.map(({ representative: issue, count, reporterNames }) => {
                const poster = posterUrl(issue.posterPath, "w342");
                const isSelected = issue.id === selectedId;
                return (
                  <div
                    key={issue.id}
                    className={isSelected ? "xl:ring-1 xl:ring-indigo-500/30 xl:rounded-lg" : undefined}
                  >
                    <IssueCardShell
                      issueId={issue.id}
                      messageCount={issue._count.messages}
                    >
                      <div className="relative w-10 h-14 shrink-0 rounded bg-zinc-700 overflow-hidden mt-0.5">
                        {poster ? (
                          <Image src={poster} alt={issue.title} fill className="object-cover" sizes="40px" />
                        ) : (
                          <div className="absolute inset-0 flex items-center justify-center text-zinc-600">
                            {issue.mediaType === "MOVIE" ? <Film className="w-4 h-4" /> : <Tv2 className="w-4 h-4" />}
                          </div>
                        )}
                      </div>

                      <Link href={issueHref(issue.id)} scroll={false} className="flex-1 min-w-0 block hover:bg-zinc-800/20 -m-1 p-1 rounded transition-colors">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-medium text-white truncate">{issue.title}</p>
                          <Badge className="border text-[10px] font-medium bg-zinc-800 text-zinc-400 border-zinc-700 shrink-0">
                            {ISSUE_TYPE_LABELS[issue.issueType] ?? issue.issueType}
                          </Badge>
                          {issue.mediaType === "TV" && issue.scope !== "FULL" && (
                            <Badge className="border text-[10px] font-medium bg-zinc-800 text-zinc-400 border-zinc-700 shrink-0">
                              {SCOPE_LABELS[issue.scope]}
                              {issue.scope === "SEASON" && issue.seasonNumber != null && ` ${issue.seasonNumber}`}
                              {issue.scope === "EPISODE" && issue.seasonNumber != null && issue.episodeNumber != null &&
                                ` S${String(issue.seasonNumber).padStart(2, "0")}E${String(issue.episodeNumber).padStart(2, "0")}`}
                            </Badge>
                          )}
                          {count > 1 && (
                            <Badge className="border text-[10px] font-medium bg-amber-500/10 text-amber-400 border-amber-500/20 shrink-0">
                              {count} reports
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-zinc-400 mt-0.5">
                          {issue.mediaType === "MOVIE" ? "Movie" : "TV Show"}
                          {" · "}
                          <span className="text-zinc-500">
                            {count > 1
                              ? `${reporterNames.slice(0, 2).join(", ")}${count > 2 ? ` +${count - 2} more` : ""}`
                              : `by ${issue.user.name ?? issue.user.email}`}
                          </span>
                          {" · "}
                          <span className="text-zinc-600">{new Date(issue.createdAt).toLocaleDateString()}</span>
                        </p>
                        {issue.note && (
                          <p className="text-xs text-zinc-400 mt-1.5 bg-zinc-800/60 rounded px-2 py-1 max-w-lg">
                            {issue.note}
                          </p>
                        )}
                        {issue.resolution && (
                          <p className="text-xs text-green-400/70 mt-1">
                            Resolution: {issue.resolution}
                          </p>
                        )}
                      </Link>

                      <Badge
                        className={`shrink-0 border text-xs font-medium hidden sm:inline-flex ${STATUS_STYLES[issue.status]}`}
                      >
                        {issue.status === "IN_PROGRESS" ? "In Progress" : issue.status.charAt(0) + issue.status.slice(1).toLowerCase()}
                      </Badge>

                      <div className="contents xl:hidden">
                        {issue.issueType === "WRONG_MATCH" && (() => {
                          const key = `${issue.tmdbId}:${issue.mediaType}`;
                          return (
                            <IssueFixMatchButton
                              issueId={issue.id}
                              tmdbId={issue.tmdbId}
                              mediaType={issue.mediaType}
                              title={issue.title}
                              onPlex={plexSet.has(key)}
                              onJellyfin={jellyfinSet.has(key)}
                              isAdmin={true}
                            />
                          );
                        })()}
                        <IssueActions
                          issueId={issue.id}
                          currentStatus={issue.status}
                          mediaType={issue.mediaType}
                          tmdbId={issue.tmdbId}
                          tvdbId={issue.tvdbId}
                          scope={issue.scope}
                          seasonNumber={issue.seasonNumber}
                          episodeNumber={issue.episodeNumber}
                          libraryConfirmed={plexSet.has(`${issue.tmdbId}:${issue.mediaType}`) || jellyfinSet.has(`${issue.tmdbId}:${issue.mediaType}`)}
                        />
                      </div>
                    </IssueCardShell>
                  </div>
                );
              })}
            </div>
          </div>

          <aside className="hidden xl:block sticky top-6 h-[calc(100vh-3rem)]">
            {selectedIssue ? (
              <div className="h-full rounded-lg bg-zinc-900 border border-zinc-800 flex flex-col overflow-hidden">
                <div className="flex-shrink-0 p-5 border-b border-zinc-800 overflow-y-auto">
                  <div className="flex items-start gap-4">
                    <div className="relative w-16 h-24 shrink-0 rounded bg-zinc-700 overflow-hidden">
                      {(() => {
                        const poster = posterUrl(selectedIssue.posterPath, "w342");
                        return poster ? (
                          <Image src={poster} alt={selectedIssue.title} fill className="object-cover" sizes="64px" />
                        ) : (
                          <div className="absolute inset-0 flex items-center justify-center text-zinc-600">
                            {selectedIssue.mediaType === "MOVIE" ? <Film className="w-6 h-6" /> : <Tv2 className="w-6 h-6" />}
                          </div>
                        );
                      })()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-white">{selectedIssue.title}</p>
                      <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                        <Badge className={`border text-[10px] font-medium ${STATUS_STYLES[selectedIssue.status]}`}>
                          {STATUS_LABEL[selectedIssue.status]}
                        </Badge>
                        <Badge className="border text-[10px] font-medium bg-zinc-800 text-zinc-400 border-zinc-700">
                          {ISSUE_TYPE_LABELS[selectedIssue.issueType] ?? selectedIssue.issueType}
                        </Badge>
                        {selectedIssue.mediaType === "TV" && selectedIssue.scope !== "FULL" && (
                          <Badge className="border text-[10px] font-medium bg-zinc-800 text-zinc-400 border-zinc-700">
                            {SCOPE_LABELS[selectedIssue.scope]}
                            {selectedIssue.scope === "SEASON" && selectedIssue.seasonNumber != null && ` ${selectedIssue.seasonNumber}`}
                            {selectedIssue.scope === "EPISODE" && selectedIssue.seasonNumber != null && selectedIssue.episodeNumber != null &&
                              ` S${String(selectedIssue.seasonNumber).padStart(2, "0")}E${String(selectedIssue.episodeNumber).padStart(2, "0")}`}
                          </Badge>
                        )}
                      </div>
                      <p className="text-[11px] text-zinc-500 mt-1">
                        Reported by {selectedIssue.user.name ?? selectedIssue.user.email} ·{" "}
                        {new Date(selectedIssue.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                  {selectedIssue.note && (
                    <p className="mt-3 text-xs text-zinc-300 bg-zinc-800/60 rounded px-3 py-2 border-l-2 border-amber-500/40 whitespace-pre-wrap">
                      {selectedIssue.note}
                    </p>
                  )}
                  {selectedIssue.resolution && (
                    <p className="mt-2 text-xs text-green-400/80 italic">
                      Resolution: {selectedIssue.resolution}
                    </p>
                  )}

                  <div className="mt-4 flex items-center gap-2 flex-wrap">
                    {selectedIssue.issueType === "WRONG_MATCH" && (() => {
                      const key = `${selectedIssue.tmdbId}:${selectedIssue.mediaType}`;
                      return (
                        <IssueFixMatchButton
                          issueId={selectedIssue.id}
                          tmdbId={selectedIssue.tmdbId}
                          mediaType={selectedIssue.mediaType}
                          title={selectedIssue.title}
                          onPlex={plexSet.has(key)}
                          onJellyfin={jellyfinSet.has(key)}
                          isAdmin={true}
                        />
                      );
                    })()}
                    <IssueActions
                      issueId={selectedIssue.id}
                      currentStatus={selectedIssue.status}
                      mediaType={selectedIssue.mediaType}
                      tmdbId={selectedIssue.tmdbId}
                      tvdbId={selectedIssue.tvdbId}
                      scope={selectedIssue.scope}
                      seasonNumber={selectedIssue.seasonNumber}
                      episodeNumber={selectedIssue.episodeNumber}
                      libraryConfirmed={plexSet.has(`${selectedIssue.tmdbId}:${selectedIssue.mediaType}`) || jellyfinSet.has(`${selectedIssue.tmdbId}:${selectedIssue.mediaType}`)}
                    />
                  </div>
                </div>
                <IssueThread issueId={selectedIssue.id} initialCount={selectedIssue._count.messages} variant="panel" />
              </div>
            ) : (
              <div className="h-full rounded-lg bg-zinc-900 border border-zinc-800 border-dashed flex flex-col items-center justify-center text-center p-8">
                <MessageSquare className="w-8 h-8 text-zinc-700 mb-3" />
                <p className="text-sm text-zinc-500">Select an issue to view its thread</p>
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
