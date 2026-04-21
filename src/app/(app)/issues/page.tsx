import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { posterUrl } from "@/lib/tmdb";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IssueThread } from "@/components/issues/issue-thread";
import Image from "next/image";
import Link from "next/link";
import { Film, Tv2, MessageSquare } from "lucide-react";
import { LiveRefresh } from "@/components/live-refresh";
import { FilterPills, SearchBox } from "@/components/user-list-filters";
import { requireFeature } from "@/lib/features";
import type { Prisma } from "@/generated/prisma";

export const dynamic = "force-dynamic";

const VALID_ISSUE_STATUSES = ["OPEN", "IN_PROGRESS", "RESOLVED"] as const;
const VALID_ISSUE_TYPES = ["BAD_VIDEO", "WRONG_AUDIO", "MISSING_SUBTITLES", "WRONG_MATCH", "OTHER"] as const;

const STATUS_STYLES: Record<string, string> = {
  OPEN:        "bg-red-500/10 text-red-400 border-red-500/20",
  IN_PROGRESS: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  RESOLVED:    "bg-green-500/10 text-green-400 border-green-500/20",
};

const STATUS_LABEL: Record<string, string> = {
  OPEN:        "Open",
  IN_PROGRESS: "In Progress",
  RESOLVED:    "Resolved",
};

const ISSUE_TYPE_LABELS: Record<string, string> = {
  BAD_VIDEO:         "Bad video quality",
  WRONG_AUDIO:       "Wrong / missing audio",
  MISSING_SUBTITLES: "Missing subtitles",
  WRONG_MATCH:       "Wrong match",
  OTHER:             "Other",
};

const PAGE_SIZE = 20;

function scopeLabelFor(issue: { scope: string; seasonNumber: number | null; episodeNumber: number | null }): string | null {
  if (issue.scope === "EPISODE" && issue.seasonNumber != null && issue.episodeNumber != null) {
    return `S${String(issue.seasonNumber).padStart(2, "0")}E${String(issue.episodeNumber).padStart(2, "0")}`;
  }
  if (issue.scope === "SEASON" && issue.seasonNumber != null) {
    return `Season ${issue.seasonNumber}`;
  }
  return null;
}

export default async function IssuesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; selected?: string; status?: string; type?: string; q?: string }>;
}) {
  await requireFeature("feature.page.issues");
  const session = await auth();
  if (!session) return null;

  const {
    page: pageParam,
    selected: selectedId,
    status: statusParam,
    type: typeParam,
    q: qParam,
  } = await searchParams;
  const page = Math.max(1, parseInt(pageParam ?? "1", 10) || 1);
  const skip = (page - 1) * PAGE_SIZE;

  const status = VALID_ISSUE_STATUSES.includes(statusParam as typeof VALID_ISSUE_STATUSES[number])
    ? (statusParam as typeof VALID_ISSUE_STATUSES[number])
    : null;
  const issueType = VALID_ISSUE_TYPES.includes(typeParam as typeof VALID_ISSUE_TYPES[number])
    ? (typeParam as typeof VALID_ISSUE_TYPES[number])
    : null;
  const q = (qParam ?? "").trim();

  const where: Prisma.IssueWhereInput = {
    reportedBy: session.user.id,
    ...(status ? { status } : {}),
    ...(issueType ? { issueType } : {}),
    ...(q ? { title: { contains: q, mode: "insensitive" } } : {}),
  };

  const [issues, total, statusCountsRaw] = await Promise.all([
    prisma.issue.findMany({
      where,
      include: { _count: { select: { messages: true } } },
      orderBy: { updatedAt: "desc" },
      skip,
      take: PAGE_SIZE,
    }),
    prisma.issue.count({ where }),
    prisma.issue.groupBy({
      by: ["status"],
      where: {
        reportedBy: session.user.id,
        ...(issueType ? { issueType } : {}),
        ...(q ? { title: { contains: q, mode: "insensitive" } } : {}),
      },
      _count: { status: true },
    }),
  ]);

  const statusCounts = Object.fromEntries(statusCountsRaw.map((r) => [r.status, r._count.status]));
  const totalAllStatuses = statusCountsRaw.reduce((s, r) => s + r._count.status, 0);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  let selectedIssue = selectedId ? issues.find((i) => i.id === selectedId) ?? null : null;
  if (selectedId && !selectedIssue) {
    selectedIssue = await prisma.issue.findFirst({
      where: { id: selectedId, reportedBy: session.user.id },
      include: { _count: { select: { messages: true } } },
    });
  }

  function buildHref(overrides: { page?: number; selected?: string }): string {
    const params = new URLSearchParams();
    const nextPage = overrides.page ?? page;
    if (nextPage > 1) params.set("page", String(nextPage));
    if (status) params.set("status", status);
    if (issueType) params.set("type", issueType);
    if (q) params.set("q", q);
    const sel = overrides.selected ?? selectedId;
    if (sel) params.set("selected", sel);
    return `/issues${params.toString() ? `?${params.toString()}` : ""}`;
  }
  function issueHref(id: string): string {
    return buildHref({ selected: id });
  }

  const hasFilters = status !== null || issueType !== null || q !== "";

  return (
    <div>
      <LiveRefresh on={["issue:updated", "issue:deleted", "issuemessage:created"]} />
      <h1 className="text-2xl font-bold mb-1">My Issues</h1>
      <p className="text-zinc-400 text-sm mb-2">
        {total} issue{total !== 1 ? "s" : ""} reported
        {hasFilters && totalAllStatuses !== total ? ` (of ${totalAllStatuses} total)` : ""}
      </p>
      <p className="text-xs text-zinc-500 mb-6">
        To report a new issue, search for the movie or TV show using the search bar above, then click{" "}
        <span className="text-zinc-400 font-medium">Report Issue</span> on its page.
      </p>

      {totalAllStatuses > 0 && (
        <div className="flex flex-col gap-3 mb-6 lg:flex-row lg:items-center lg:justify-between">
          <FilterPills
            param="status"
            active={status ?? ""}
            options={[
              { value: "", label: "All", count: totalAllStatuses },
              { value: "OPEN", label: "Open", count: statusCounts.OPEN ?? 0 },
              { value: "IN_PROGRESS", label: "In Progress", count: statusCounts.IN_PROGRESS ?? 0 },
              { value: "RESOLVED", label: "Resolved", count: statusCounts.RESOLVED ?? 0 },
            ]}
            preserve={["type", "q", "selected"]}
          />
          <div className="flex items-center gap-3">
            <FilterPills
              param="type"
              active={issueType ?? ""}
              options={[
                { value: "", label: "Any type" },
                { value: "BAD_VIDEO", label: "Video" },
                { value: "WRONG_AUDIO", label: "Audio" },
                { value: "MISSING_SUBTITLES", label: "Subs" },
                { value: "WRONG_MATCH", label: "Match" },
                { value: "OTHER", label: "Other" },
              ]}
              preserve={["status", "q", "selected"]}
            />
            <SearchBox
              param="q"
              initial={q}
              placeholder="Search titles…"
              preserve={["status", "type", "selected"]}
            />
          </div>
        </div>
      )}

      {total === 0 ? (
        <div className="rounded-lg bg-zinc-900 border border-zinc-800 p-10 text-center text-zinc-500 text-sm">
          {hasFilters
            ? "No issues match these filters."
            : "No issues reported yet. Use the Report Issue button on any movie or TV show page."}
        </div>
      ) : (
        <div className="xl:grid xl:grid-cols-[1fr_480px] xl:gap-6 xl:items-start">
          <div className="min-w-0">
            <div className="flex flex-col gap-3">
              {issues.map((issue) => {
                const poster = posterUrl(issue.posterPath, "w342");
                const scopeLabel = scopeLabelFor(issue);
                const isSelected = issue.id === selectedId;

                return (
                  <div
                    key={issue.id}
                    className={`rounded-lg bg-zinc-900 border overflow-hidden transition-colors ${
                      isSelected ? "border-indigo-500/50 xl:ring-1 xl:ring-indigo-500/30" : "border-zinc-800"
                    }`}
                  >
                    <Link
                      href={issueHref(issue.id)}
                      scroll={false}
                      className="flex items-start gap-4 p-4 hover:bg-zinc-800/30 transition-colors"
                    >
                      <div className="relative w-12 h-16 shrink-0 rounded bg-zinc-700 overflow-hidden">
                        {poster ? (
                          <Image src={poster} alt={issue.title} fill className="object-cover" sizes="48px" />
                        ) : (
                          <div className="absolute inset-0 flex items-center justify-center text-zinc-600">
                            {issue.mediaType === "MOVIE" ? <Film className="w-5 h-5" /> : <Tv2 className="w-5 h-5" />}
                          </div>
                        )}
                      </div>

                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-white truncate">{issue.title}</p>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          <span className="text-xs text-zinc-400">
                            {issue.mediaType === "MOVIE" ? "Movie" : "TV Show"}
                          </span>
                          <Badge className="border text-[10px] font-medium bg-zinc-800 text-zinc-400 border-zinc-700">
                            {ISSUE_TYPE_LABELS[issue.issueType] ?? issue.issueType}
                          </Badge>
                          {scopeLabel && (
                            <Badge className="border text-[10px] font-medium bg-zinc-800 text-zinc-400 border-zinc-700">
                              {scopeLabel}
                            </Badge>
                          )}
                          <span className="text-xs text-zinc-600">
                            {new Date(issue.updatedAt).toLocaleDateString()}
                          </span>
                        </div>
                        {issue.note && (
                          <p className="mt-1.5 text-xs text-zinc-400 bg-zinc-800 rounded px-2 py-1 border-l-2 border-amber-500/40">
                            {issue.note}
                          </p>
                        )}
                        {issue.resolution && (
                          <p className="mt-1 text-xs text-green-400/80 italic">
                            ↳ {issue.resolution}
                          </p>
                        )}
                        {issue._count.messages > 0 && (
                          <p className="mt-1 text-xs text-indigo-400/70">
                            {issue._count.messages} message{issue._count.messages !== 1 ? "s" : ""}
                          </p>
                        )}
                      </div>

                      <Badge className={`shrink-0 border text-xs font-medium ${STATUS_STYLES[issue.status]}`}>
                        {STATUS_LABEL[issue.status]}
                      </Badge>
                    </Link>

                    <div className="xl:hidden">
                      <IssueThread issueId={issue.id} initialCount={issue._count.messages} />
                    </div>
                  </div>
                );
              })}
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-6">
                <p className="text-xs text-zinc-500">Page {page} of {totalPages}</p>
                <div className="flex items-center gap-2">
                  {page > 1 ? (
                    <Link href={buildHref({ page: page - 1 })}>
                      <Button size="sm" variant="outline" className="h-7 px-3 text-xs border-zinc-700 text-zinc-400 hover:text-white">
                        Previous
                      </Button>
                    </Link>
                  ) : (
                    <Button size="sm" variant="outline" disabled className="h-7 px-3 text-xs border-zinc-700 opacity-40">Previous</Button>
                  )}
                  {page < totalPages ? (
                    <Link href={buildHref({ page: page + 1 })}>
                      <Button size="sm" variant="outline" className="h-7 px-3 text-xs border-zinc-700 text-zinc-400 hover:text-white">
                        Next
                      </Button>
                    </Link>
                  ) : (
                    <Button size="sm" variant="outline" disabled className="h-7 px-3 text-xs border-zinc-700 opacity-40">Next</Button>
                  )}
                </div>
              </div>
            )}
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
                        {(() => {
                          const label = scopeLabelFor(selectedIssue);
                          return label ? (
                            <Badge className="border text-[10px] font-medium bg-zinc-800 text-zinc-400 border-zinc-700">
                              {label}
                            </Badge>
                          ) : null;
                        })()}
                      </div>
                      <p className="text-[11px] text-zinc-500 mt-1">
                        Reported {new Date(selectedIssue.createdAt).toLocaleDateString()}
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
