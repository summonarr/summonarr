import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { posterUrl } from "@/lib/tmdb";
import { IssueThread } from "@/components/issues/issue-thread";
import Image from "next/image";
import Link from "next/link";
import { Film, Tv2, MessageSquare } from "lucide-react";
import { LiveRefresh } from "@/components/live-refresh";
import { FilterPills, SearchBox } from "@/components/user-list-filters";
import { requireFeature } from "@/lib/features";
import type { Prisma } from "@/generated/prisma";
import { Chip, PageHeader } from "@/components/ui/design";
import type { ChipTone } from "@/components/ui/design";

export const dynamic = "force-dynamic";

const VALID_ISSUE_STATUSES = ["OPEN", "IN_PROGRESS", "RESOLVED"] as const;
const VALID_ISSUE_TYPES = ["BAD_VIDEO", "WRONG_AUDIO", "MISSING_SUBTITLES", "WRONG_MATCH", "OTHER"] as const;

const STATUS_TONE: Record<string, ChipTone> = {
  OPEN: "declined",
  IN_PROGRESS: "pending",
  RESOLVED: "approved",
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

  const subtitle =
    `${total} issue${total !== 1 ? "s" : ""} reported` +
    (hasFilters && totalAllStatuses !== total
      ? ` (of ${totalAllStatuses} total)`
      : "");

  return (
    <div className="ds-page-enter">
      <LiveRefresh
        on={["issue:updated", "issue:deleted", "issuemessage:created"]}
      />
      <PageHeader title="My Issues" subtitle={subtitle} />
      <p
        className="ds-mono"
        style={{
          fontSize: 11,
          color: "var(--ds-fg-subtle)",
          marginTop: -12,
          marginBottom: 20,
        }}
      >
        To report a new issue, search for the movie or TV show using the
        search bar above, then click{" "}
        <span style={{ color: "var(--ds-fg-muted)", fontWeight: 500 }}>
          Report Issue
        </span>{" "}
        on its page.
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
          {hasFilters
            ? "No issues match these filters."
            : "No issues reported yet. Use the Report Issue button on any movie or TV show page."}
        </div>
      ) : (
        <div className="xl:grid xl:grid-cols-[1fr_480px] xl:gap-6 xl:items-start">
          <div className="min-w-0">
            <div className="flex flex-col" style={{ gap: 8 }}>
              {issues.map((issue) => {
                const poster = posterUrl(issue.posterPath, "w342");
                const scopeLabel = scopeLabelFor(issue);
                const isSelected = issue.id === selectedId;

                return (
                  <div
                    key={issue.id}
                    className="overflow-hidden"
                    style={{
                      background: "var(--ds-bg-2)",
                      border: `1px solid ${
                        isSelected
                          ? "var(--ds-accent-ring)"
                          : "var(--ds-border)"
                      }`,
                      borderRadius: 8,
                      boxShadow: isSelected
                        ? "0 0 0 1px var(--ds-accent-ring)"
                        : "none",
                      transition: "border-color 120ms var(--ds-ease)",
                    }}
                  >
                    <Link
                      href={issueHref(issue.id)}
                      scroll={false}
                      className="flex items-start transition-colors hover:bg-[var(--ds-bg-3)]"
                      style={{ gap: 14, padding: 14 }}
                    >
                      <div
                        className="relative shrink-0 overflow-hidden"
                        style={{
                          width: 44,
                          aspectRatio: "2 / 3",
                          borderRadius: 4,
                          background: "var(--ds-bg-3)",
                        }}
                      >
                        {poster ? (
                          <Image
                            src={poster}
                            alt={issue.title}
                            fill
                            className="object-cover"
                            sizes="44px"
                          />
                        ) : (
                          <div
                            className="absolute inset-0 flex items-center justify-center"
                            style={{ color: "var(--ds-fg-subtle)" }}
                          >
                            {issue.mediaType === "MOVIE" ? (
                              <Film style={{ width: 16, height: 16 }} />
                            ) : (
                              <Tv2 style={{ width: 16, height: 16 }} />
                            )}
                          </div>
                        )}
                      </div>

                      <div className="flex-1 min-w-0">
                        <p
                          className="font-medium truncate"
                          style={{ fontSize: 14, color: "var(--ds-fg)" }}
                        >
                          {issue.title}
                        </p>
                        <div
                          className="flex items-center flex-wrap"
                          style={{ gap: 6, marginTop: 4 }}
                        >
                          <span
                            className="ds-mono"
                            style={{
                              fontSize: 10.5,
                              color: "var(--ds-fg-subtle)",
                            }}
                          >
                            {issue.mediaType === "MOVIE" ? "MOVIE" : "TV"}
                          </span>
                          <Chip>
                            {ISSUE_TYPE_LABELS[issue.issueType] ??
                              issue.issueType}
                          </Chip>
                          {scopeLabel && <Chip>{scopeLabel}</Chip>}
                          <span
                            className="ds-mono"
                            style={{
                              fontSize: 10.5,
                              color: "var(--ds-fg-subtle)",
                            }}
                          >
                            {new Date(issue.updatedAt).toLocaleDateString()}
                          </span>
                        </div>
                        {issue.note && (
                          <p
                            style={{
                              marginTop: 8,
                              padding: "6px 10px",
                              borderRadius: 4,
                              background: "var(--ds-bg-1)",
                              borderLeft:
                                "2px solid color-mix(in oklab, var(--ds-warning) 40%, transparent)",
                              fontSize: 11.5,
                              color: "var(--ds-fg-muted)",
                            }}
                          >
                            {issue.note}
                          </p>
                        )}
                        {issue.resolution && (
                          <p
                            className="italic"
                            style={{
                              marginTop: 6,
                              fontSize: 11.5,
                              color:
                                "color-mix(in oklab, var(--ds-success) 85%, var(--ds-fg))",
                            }}
                          >
                            ↳ {issue.resolution}
                          </p>
                        )}
                        {issue._count.messages > 0 && (
                          <p
                            className="ds-mono"
                            style={{
                              marginTop: 6,
                              fontSize: 10.5,
                              color:
                                "color-mix(in oklab, var(--ds-accent) 80%, var(--ds-fg))",
                            }}
                          >
                            {issue._count.messages} message
                            {issue._count.messages !== 1 ? "s" : ""}
                          </p>
                        )}
                      </div>

                      <Chip tone={STATUS_TONE[issue.status]}>
                        {STATUS_LABEL[issue.status]}
                      </Chip>
                    </Link>

                    <div className="xl:hidden">
                      <IssueThread
                        issueId={issue.id}
                        initialCount={issue._count.messages}
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            {totalPages > 1 && (
              <div
                className="flex items-center justify-between"
                style={{ marginTop: 24 }}
              >
                <p
                  className="ds-mono"
                  style={{ fontSize: 11, color: "var(--ds-fg-subtle)" }}
                >
                  Page {page} of {totalPages}
                </p>
                <div className="flex items-center gap-2">
                  <IssuePagerLink
                    href={page > 1 ? buildHref({ page: page - 1 }) : undefined}
                  >
                    Previous
                  </IssuePagerLink>
                  <IssuePagerLink
                    href={
                      page < totalPages
                        ? buildHref({ page: page + 1 })
                        : undefined
                    }
                  >
                    Next
                  </IssuePagerLink>
                </div>
              </div>
            )}
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
                        style={{ fontSize: 14, color: "var(--ds-fg)" }}
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
                        {(() => {
                          const label = scopeLabelFor(selectedIssue);
                          return label ? <Chip>{label}</Chip> : null;
                        })()}
                      </div>
                      <p
                        className="ds-mono"
                        style={{
                          marginTop: 4,
                          fontSize: 10.5,
                          color: "var(--ds-fg-subtle)",
                        }}
                      >
                        Reported{" "}
                        {new Date(selectedIssue.createdAt).toLocaleDateString()}
                      </p>
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
                </div>
                <IssueThread
                  issueId={selectedIssue.id}
                  initialCount={selectedIssue._count.messages}
                  variant="panel"
                />
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

function IssuePagerLink({
  href,
  children,
}: {
  href?: string;
  children: React.ReactNode;
}) {
  const style: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0 12px",
    height: 28,
    borderRadius: 6,
    border: "1px solid var(--ds-border)",
    background: href ? "var(--ds-bg-2)" : "transparent",
    color: href ? "var(--ds-fg-muted)" : "var(--ds-fg-disabled)",
    fontSize: 11,
    fontWeight: 500,
  };
  if (!href) return <span style={style}>{children}</span>;
  return (
    <Link href={href} style={style}>
      {children}
    </Link>
  );
}
