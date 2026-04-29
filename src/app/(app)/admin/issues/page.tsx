import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { posterUrl } from "@/lib/tmdb";
import { redirect } from "next/navigation";
import Link from "next/link";
import { IssueActions } from "@/components/admin/issue-actions";
import { IssueCardShell } from "@/components/admin/issue-card-shell";
import { IssueClaimButton } from "@/components/admin/issue-claim-button";
import { IssueThread } from "@/components/issues/issue-thread";
import Image from "next/image";
import { Film, Tv2, MessageSquare } from "lucide-react";
import { IssueFixMatchButton } from "@/components/admin/issue-fix-match-button";
import { LiveRefresh } from "@/components/live-refresh";
import { requireFeature } from "@/lib/features";
import { Chip, PageHeader } from "@/components/ui/design";
import type { ChipTone } from "@/components/ui/design";

const STATUS_TONE: Record<string, ChipTone> = {
  OPEN: "declined",
  IN_PROGRESS: "pending",
  RESOLVED: "approved",
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
        claimedUser: { select: { name: true, email: true } },
        _count: { select: { messages: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 500,
    }),
    prisma.issue.groupBy({ by: ["status"], _count: { status: true } }),
  ]);

  const countFor = (status: string) =>
    statusCounts.find((s) => s.status === status)?._count.status ?? 0;

  const filtered = filter === "ALL" ? allIssues : allIssues.filter((i) => i.status === filter);
  const groups = groupIssues(filtered);

  let selectedIssue = selectedId ? allIssues.find((i) => i.id === selectedId) ?? null : null;
  if (selectedId && !selectedIssue) {
    selectedIssue = await prisma.issue.findUnique({
      where: { id: selectedId },
      include: {
        user: { select: { name: true, email: true } },
        claimedUser: { select: { name: true, email: true } },
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
    <div className="ds-page-enter">
      <LiveRefresh
        on={[
          "issue:new",
          "issue:updated",
          "issue:deleted",
          "issuemessage:created",
        ]}
      />
      <PageHeader
        title="Issues"
        subtitle="User-reported media quality problems"
      />

      <div
        className="ds-no-scrollbar flex overflow-x-auto max-w-full"
        style={{
          padding: 2,
          background: "var(--ds-bg-1)",
          border: "1px solid var(--ds-border)",
          borderRadius: 8,
          marginBottom: 20,
        }}
      >
        {tabs.map((tab) => {
          const active = filter === tab.value;
          return (
            <Link
              key={tab.value}
              href={`?filter=${tab.value}`}
              className="inline-flex items-center gap-1.5 whitespace-nowrap font-medium transition-colors"
              style={{
                padding: "5px 12px",
                borderRadius: 6,
                fontSize: 12,
                background: active ? "var(--ds-bg-3)" : "transparent",
                color: active ? "var(--ds-fg)" : "var(--ds-fg-muted)",
              }}
            >
              {tab.label}
              <span
                className="ds-mono"
                style={{
                  fontSize: 10,
                  padding: "0 5px",
                  borderRadius: 3,
                  background: active
                    ? "var(--ds-accent-soft)"
                    : "var(--ds-bg-3)",
                  color: active ? "var(--ds-accent)" : "var(--ds-fg-subtle)",
                }}
              >
                {tab.count}
              </span>
            </Link>
          );
        })}
      </div>

      {groups.length === 0 ? (
        <div
          className="text-center ds-mono"
          style={{
            padding: "40px 20px",
            background: "var(--ds-bg-1)",
            border: "1px dashed var(--ds-border)",
            borderRadius: 8,
            fontSize: 12,
            color: "var(--ds-fg-subtle)",
          }}
        >
          No issues in this category.
        </div>
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

                      <Link
                        href={issueHref(issue.id)}
                        scroll={false}
                        className="flex-1 min-w-0 block rounded transition-colors"
                        style={{ margin: -4, padding: 4 }}
                      >
                        <div
                          className="flex items-center flex-wrap"
                          style={{ gap: 6 }}
                        >
                          <p
                            className="font-medium truncate"
                            style={{ color: "var(--ds-fg)", margin: 0 }}
                          >
                            {issue.title}
                          </p>
                          <Chip>
                            {ISSUE_TYPE_LABELS[issue.issueType] ??
                              issue.issueType}
                          </Chip>
                          {issue.mediaType === "TV" && issue.scope !== "FULL" && (
                            <Chip>
                              {SCOPE_LABELS[issue.scope]}
                              {issue.scope === "SEASON" &&
                                issue.seasonNumber != null &&
                                ` ${issue.seasonNumber}`}
                              {issue.scope === "EPISODE" &&
                                issue.seasonNumber != null &&
                                issue.episodeNumber != null &&
                                ` S${String(issue.seasonNumber).padStart(2, "0")}E${String(issue.episodeNumber).padStart(2, "0")}`}
                            </Chip>
                          )}
                          {count > 1 && (
                            <Chip tone="pending">{count} reports</Chip>
                          )}
                        </div>
                        <p
                          className="ds-mono"
                          style={{
                            fontSize: 10.5,
                            color: "var(--ds-fg-subtle)",
                            marginTop: 4,
                          }}
                        >
                          {issue.mediaType === "MOVIE" ? "MOVIE" : "TV"}
                          {" · "}
                          <span style={{ color: "var(--ds-fg-muted)" }}>
                            {count > 1
                              ? `${reporterNames.slice(0, 2).join(", ")}${count > 2 ? ` +${count - 2} more` : ""}`
                              : `by ${issue.user.name ?? issue.user.email}`}
                          </span>
                          {" · "}
                          {new Date(issue.createdAt).toLocaleDateString()}
                        </p>
                        {issue.note && (
                          <p
                            style={{
                              marginTop: 6,
                              padding: "6px 10px",
                              borderRadius: 4,
                              background: "var(--ds-bg-1)",
                              fontSize: 11.5,
                              color: "var(--ds-fg-muted)",
                              maxWidth: "32rem",
                            }}
                          >
                            {issue.note}
                          </p>
                        )}
                        {issue.resolution && (
                          <p
                            className="italic"
                            style={{
                              marginTop: 4,
                              fontSize: 11,
                              color:
                                "color-mix(in oklab, var(--ds-success) 80%, var(--ds-fg))",
                            }}
                          >
                            Resolution: {issue.resolution}
                          </p>
                        )}
                      </Link>

                      <div className="hidden sm:inline-flex shrink-0">
                        <Chip tone={STATUS_TONE[issue.status]}>
                          {issue.status === "IN_PROGRESS"
                            ? "In Progress"
                            : issue.status.charAt(0) +
                              issue.status.slice(1).toLowerCase()}
                        </Chip>
                      </div>

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
              <div
                className="h-full flex flex-col overflow-hidden"
                style={{
                  background: "var(--ds-bg-2)",
                  border: "1px solid var(--ds-border)",
                  borderRadius: 8,
                }}
              >
                <div
                  className="flex-shrink-0 overflow-y-auto"
                  style={{
                    padding: 18,
                    borderBottom: "1px solid var(--ds-border)",
                  }}
                >
                  <div className="flex items-start" style={{ gap: 14 }}>
                    <div
                      className="relative shrink-0 overflow-hidden"
                      style={{
                        width: 64,
                        aspectRatio: "2 / 3",
                        borderRadius: 4,
                        background: "var(--ds-bg-3)",
                      }}
                    >
                      {(() => {
                        const poster = posterUrl(
                          selectedIssue.posterPath,
                          "w342",
                        );
                        return poster ? (
                          <Image
                            src={poster}
                            alt={selectedIssue.title}
                            fill
                            className="object-cover"
                            sizes="64px"
                          />
                        ) : (
                          <div
                            className="absolute inset-0 flex items-center justify-center"
                            style={{ color: "var(--ds-fg-subtle)" }}
                          >
                            {selectedIssue.mediaType === "MOVIE" ? (
                              <Film style={{ width: 20, height: 20 }} />
                            ) : (
                              <Tv2 style={{ width: 20, height: 20 }} />
                            )}
                          </div>
                        );
                      })()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p
                        className="font-semibold"
                        style={{ fontSize: 14, color: "var(--ds-fg)", margin: 0 }}
                      >
                        {selectedIssue.title}
                      </p>
                      <div
                        className="flex items-center flex-wrap"
                        style={{ gap: 6, marginTop: 4 }}
                      >
                        <Chip tone={STATUS_TONE[selectedIssue.status]}>
                          {STATUS_LABEL[selectedIssue.status]}
                        </Chip>
                        <Chip>
                          {ISSUE_TYPE_LABELS[selectedIssue.issueType] ??
                            selectedIssue.issueType}
                        </Chip>
                        {selectedIssue.mediaType === "TV" &&
                          selectedIssue.scope !== "FULL" && (
                            <Chip>
                              {SCOPE_LABELS[selectedIssue.scope]}
                              {selectedIssue.scope === "SEASON" &&
                                selectedIssue.seasonNumber != null &&
                                ` ${selectedIssue.seasonNumber}`}
                              {selectedIssue.scope === "EPISODE" &&
                                selectedIssue.seasonNumber != null &&
                                selectedIssue.episodeNumber != null &&
                                ` S${String(selectedIssue.seasonNumber).padStart(2, "0")}E${String(selectedIssue.episodeNumber).padStart(2, "0")}`}
                            </Chip>
                          )}
                      </div>
                      <p
                        className="ds-mono"
                        style={{
                          marginTop: 4,
                          fontSize: 10.5,
                          color: "var(--ds-fg-subtle)",
                        }}
                      >
                        Reported by{" "}
                        {selectedIssue.user.name ?? selectedIssue.user.email} ·{" "}
                        {new Date(selectedIssue.createdAt).toLocaleDateString()}
                      </p>
                      {selectedIssue.claimedBy && (
                        <p
                          className="ds-mono"
                          style={{
                            marginTop: 2,
                            fontSize: 10.5,
                            color: "var(--ds-accent)",
                          }}
                        >
                          Claimed by{" "}
                          {selectedIssue.claimedUser?.name ??
                            selectedIssue.claimedUser?.email ??
                            "unknown"}
                        </p>
                      )}
                    </div>
                  </div>
                  {selectedIssue.note && (
                    <p
                      className="whitespace-pre-wrap"
                      style={{
                        marginTop: 12,
                        padding: "8px 12px",
                        borderRadius: 4,
                        background: "var(--ds-bg-1)",
                        borderLeft:
                          "2px solid color-mix(in oklab, var(--ds-warning) 40%, transparent)",
                        fontSize: 12,
                        color: "var(--ds-fg-muted)",
                      }}
                    >
                      {selectedIssue.note}
                    </p>
                  )}
                  {selectedIssue.resolution && (
                    <p
                      className="italic"
                      style={{
                        marginTop: 8,
                        fontSize: 12,
                        color:
                          "color-mix(in oklab, var(--ds-success) 85%, var(--ds-fg))",
                      }}
                    >
                      Resolution: {selectedIssue.resolution}
                    </p>
                  )}

                  <div
                    className="flex items-center flex-wrap"
                    style={{ gap: 8, marginTop: 16 }}
                  >
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
                    <IssueClaimButton
                      issueId={selectedIssue.id}
                      claimedBy={selectedIssue.claimedBy}
                      claimerName={selectedIssue.claimedUser?.name ?? selectedIssue.claimedUser?.email ?? null}
                      currentUserId={session.user.id}
                    />
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
              <div
                className="h-full flex flex-col items-center justify-center text-center"
                style={{
                  padding: 32,
                  background: "var(--ds-bg-1)",
                  border: "1px dashed var(--ds-border)",
                  borderRadius: 8,
                }}
              >
                <MessageSquare
                  style={{
                    width: 28,
                    height: 28,
                    color: "var(--ds-fg-disabled)",
                    marginBottom: 12,
                  }}
                />
                <p
                  className="ds-mono"
                  style={{ fontSize: 12, color: "var(--ds-fg-subtle)" }}
                >
                  Select an issue to view its thread
                </p>
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
