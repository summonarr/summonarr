import { requireAppSession } from "@/lib/require-app-session";
import { prisma } from "@/lib/prisma";
import { posterUrl } from "@/lib/tmdb";
import { Suspense, type ReactNode } from "react";
import { DesktopIssueThread } from "@/components/issues/desktop-issue-thread";
import {
  IssueDetailMobileDrawer,
  type IssueDrawerPayload,
} from "@/components/issues/issue-detail-mobile-drawer";
import Image from "next/image";
import Link from "next/link";
import { Film, Tv2, MessageSquare, ChevronRight } from "@/components/icons";
import { LiveRefresh } from "@/components/live-refresh";
import { FilterPills, SearchBox } from "@/components/user-list-filters";
import { PaginationBar } from "@/components/media/pagination-bar";
import { requireFeature } from "@/lib/features";
import type { IssueStatus, IssueType, Prisma } from "@/generated/prisma";
import { Chip, EmptyState, PageHeader } from "@/components/ui/design";
import { ISSUE_STATUS_LABEL_KEY, ISSUE_STATUS_TONE, ISSUE_TYPE_LABEL_KEY, issueDateFormat } from "@/lib/status-labels";
import { getLocale, getTranslator } from "@/lib/i18n/server";
import type { Translator } from "@/lib/i18n/translate";
import { sanitizeContainsSearch } from "@/lib/sanitize";
import { parsePageNumber } from "@/lib/pagination";
import { first, type PageSearchParams } from "@/lib/search-params";

export const dynamic = "force-dynamic";

// The filter pills, in display order. Keyed by the Prisma enums, so a new
// status or type is a compile error here rather than a value the pills miss;
// a ?status= / ?type= is valid exactly when it names a key.
const STATUS_PILL_KEY: Record<IssueStatus, string> = {
  OPEN: "personal.issues.status.open",
  IN_PROGRESS: "personal.issues.status.inProgress",
  RESOLVED: "personal.issues.status.resolved",
};
const TYPE_PILL_KEY: Record<IssueType, string> = {
  BAD_VIDEO: "personal.issues.filter.video",
  WRONG_AUDIO: "personal.issues.filter.audio",
  MISSING_SUBTITLES: "personal.issues.filter.subtitles",
  WRONG_MATCH: "personal.issues.type.wrongMatch",
  OTHER: "personal.issues.type.other",
};

function pickKey<K extends string>(map: Record<K, string>, value: string | undefined): K | null {
  return value !== undefined && Object.hasOwn(map, value) ? (value as K) : null;
}

const PAGE_SIZE = 20;

// Formats an issue's scope into a short label (SxxEyy for episodes, "Season N" for seasons); null for whole-title scope.
function scopeLabelFor(
  issue: { scope: string; seasonNumber: number | null; episodeNumber: number | null },
  t: Translator,
): string | null {
  if (issue.scope === "EPISODE" && issue.seasonNumber != null && issue.episodeNumber != null) {
    return `S${String(issue.seasonNumber).padStart(2, "0")}E${String(issue.episodeNumber).padStart(2, "0")}`;
  }
  if (issue.scope === "SEASON" && issue.seasonNumber != null) {
    return t("personal.issues.season", { number: issue.seasonNumber });
  }
  return null;
}

function toDrawerPayload(issue: {
  id: string; title: string; posterPath: string | null; mediaType: IssueDrawerPayload["mediaType"];
  status: IssueDrawerPayload["status"]; issueType: IssueDrawerPayload["issueType"]; scope: IssueDrawerPayload["scope"];
  seasonNumber: number | null; episodeNumber: number | null; note: string | null; resolution: string | null;
  createdAt: Date; _count: { messages: number };
}): IssueDrawerPayload {
  return {
    id: issue.id,
    title: issue.title,
    posterUrl: posterUrl(issue.posterPath, "w342"),
    mediaType: issue.mediaType,
    status: issue.status,
    issueType: issue.issueType,
    scope: issue.scope,
    seasonNumber: issue.seasonNumber,
    episodeNumber: issue.episodeNumber,
    note: issue.note,
    resolution: issue.resolution,
    createdAt: issue.createdAt.toISOString(),
    messageCount: issue._count.messages,
  };
}

export default async function IssuesPage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  await requireFeature("feature.page.issues");
  const session = await requireAppSession();
  const [t, locale, sp] = await Promise.all([getTranslator(), getLocale(), searchParams]);
  const dateFormat = issueDateFormat(locale);
  const labels: IssueLabels = {
    status: (s) => (ISSUE_STATUS_LABEL_KEY[s] ? t(ISSUE_STATUS_LABEL_KEY[s]) : s),
    type: (s) => (ISSUE_TYPE_LABEL_KEY[s] ? t(ISSUE_TYPE_LABEL_KEY[s]) : s),
    date: (d) => dateFormat.format(d),
  };

  // A repeated query key arrives as an array at runtime: `.trim()` on it would
  // 500 the page, and an array `id` is a Prisma validation error. first() takes
  // the first value.
  const selectedId = first(sp.selected);
  const qParam = first(sp.q);
  // Clamped like every paged list (pagination.ts): a huge ?page= made skip a
  // number Postgres refuses, and an array ?page= is handled the same way.
  const pageParam = sp.page;
  const page = parsePageNumber(pageParam);
  const skip = (page - 1) * PAGE_SIZE;

  const status = pickKey(STATUS_PILL_KEY, first(sp.status));
  const issueType = pickKey(TYPE_PILL_KEY, first(sp.type));
  // Prisma's `contains` becomes a SQL ILIKE, where % and _ are wildcards.
  // sanitizeContainsSearch strips those and caps the length so a crafted
  // search can't make the query slow (same as /api/votes).
  const q = sanitizeContainsSearch((qParam ?? "").trim());

  // The list and the pills' counts share this, so they cannot disagree.
  const baseWhere: Prisma.IssueWhereInput = {
    reportedBy: session.user.id,
    ...(issueType ? { issueType } : {}),
    ...(q ? { title: { contains: q, mode: "insensitive" } } : {}),
  };
  const where: Prisma.IssueWhereInput = { ...baseWhere, ...(status ? { status } : {}) };

  const [issues, statusCountsRaw, totalForUser] = await Promise.all([
    prisma.issue.findMany({
      where,
      include: { _count: { select: { messages: true } } },
      orderBy: { updatedAt: "desc" },
      skip,
      take: PAGE_SIZE,
    }),
    // The pills' per-status counts. `where` is this filter plus the status, so
    // the list's total comes from these too (below) — no separate count query.
    prisma.issue.groupBy({
      by: ["status"],
      where: baseWhere,
      _count: { status: true },
    }),
    // UNFILTERED per-user count — gates the filter bar below and is the "of N"
    // in the count line. The groupBy above applies the type/search filters, so
    // its total hits 0 the moment a filter matches nothing, and gating on it
    // unmounted the bar (including the search box being typed into) with no
    // way to clear the filter short of Back.
    prisma.issue.count({ where: { reportedBy: session.user.id } }),
  ]);

  const statusCounts: Partial<Record<string, number>> = Object.fromEntries(
    statusCountsRaw.map((r) => [r.status, r._count.status]),
  );
  const totalAllStatuses = statusCountsRaw.reduce((s, r) => s + r._count.status, 0);
  const total = status ? (statusCounts[status] ?? 0) : totalAllStatuses;

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

  // "N of M" against everything the user filed, so a type or search filter
  // alone reads as a narrowing too.
  const countLine =
    hasFilters && totalForUser !== total
      ? t("personal.issues.countOfTotal", { count: total, total: totalForUser })
      : t("personal.issues.count", { count: total });

  // Shown when this page of the list is empty. Keyed on the paged slice, not
  // `total` (same as /requests): `?page=9` with 3 issues has total=3 and
  // issues=[], and the pager is hidden when totalPages <= 1, so a past-the-end
  // page rendered an empty list with no way back.
  const emptyState = (
    <EmptyState
      icon={MessageSquare}
      title={
        total > 0
          ? t("personal.common.nothingOnPage")
          : hasFilters
            ? t("personal.issues.emptyFilteredTitle")
            : t("personal.issues.emptyTitle")
      }
      description={
        total > 0
          ? t("personal.issues.emptyPageDescription")
          : hasFilters
            ? t("personal.issues.emptyFilteredDescription")
            : t("personal.issues.emptyDescription")
      }
      // A filter that matches nothing gets an in-page way out: every
      // param (status/type/q, plus page and selection) dropped.
      cta={
        total > 0
          ? { href: buildHref({ page: 1, selected: "" }), label: t("personal.common.backToFirst") }
          : hasFilters
            ? { href: "/issues", label: t("browse.clearFilters") }
            : undefined
      }
    />
  );

  return (
    <div className="ds-page-enter">
      <LiveRefresh
        on={["issue:updated", "issue:deleted", "issuemessage:created"]}
      />
      <PageHeader
        title={t("personal.issues.title")}
        subtitle={
          <>
            {countLine} · {t("personal.issues.hintBefore")}{" "}
            <span style={{ color: "var(--ds-fg-muted)", fontWeight: 500 }}>
              {t("personal.issues.reportIssue")}
            </span>{" "}
            {t("personal.issues.hintAfter")}
          </>
        }
      />

      {totalForUser > 0 && (
        <div className="flex flex-col gap-3 mb-5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <FilterPills
            param="status"
            active={status ?? ""}
            label={t("personal.issues.filter.statusLabel")}
            options={[
              { value: "", label: t("personal.common.all"), count: totalAllStatuses },
              ...Object.entries(STATUS_PILL_KEY).map(([value, key]) => ({ value, label: t(key), count: statusCounts[value] ?? 0 })),
            ]}
            preserve={["type", "q", "selected"]}
          />
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
            <FilterPills
              param="type"
              active={issueType ?? ""}
              label={t("personal.issues.filter.typeLabel")}
              options={[
                { value: "", label: t("personal.issues.filter.anyType") },
                ...Object.entries(TYPE_PILL_KEY).map(([value, key]) => ({ value, label: t(key) })),
              ]}
              preserve={["status", "q", "selected"]}
            />
            <SearchBox
              param="q"
              initial={q}
              placeholder={t("personal.common.searchTitles")}
              preserve={["status", "type", "selected"]}
            />
          </div>
        </div>
      )}

      {/* The grid (and its desktop pane) also renders over an empty page when
          an issue is selected: a filter or search that matches nothing keeps
          `selected`, and the phone drawer showed that issue while desktop
          showed only the empty state. */}
      {issues.length === 0 && !selectedIssue ? (
        emptyState
      ) : (
        <div className="xl:grid xl:grid-cols-[1fr_480px] xl:gap-6 xl:items-start">
          <div className="min-w-0">
            {issues.length === 0 && emptyState}
            <div className="flex flex-col" style={{ gap: 8 }}>
              {issues.map((issue) => (
                <IssueRow
                  key={issue.id}
                  issue={issue}
                  href={issueHref(issue.id)}
                  isSelected={issue.id === selectedId}
                  labels={labels}
                  t={t}
                />
              ))}
            </div>

            {issues.length > 0 && (
              <Suspense>
                <PaginationBar currentPage={page} totalPages={totalPages} />
              </Suspense>
            )}
          </div>

          <aside className="hidden xl:block sticky top-6 h-[calc(100dvh-52px-3rem)]">
            {selectedIssue ? (
              <div
                className="h-full flex flex-col overflow-hidden"
                style={{
                  background: "var(--ds-bg-2)",
                  border: "1px solid var(--ds-border)",
                  borderRadius: 8,
                }}
              >
                <IssueDetailHeader issue={selectedIssue} labels={labels} t={t} />
                <DesktopIssueThread key={selectedIssue.id} issueId={selectedIssue.id} />
              </div>
            ) : (
              <EmptyState
                className="h-full justify-center"
                icon={MessageSquare}
                title={t("personal.issues.selectTitle")}
                description={t("personal.issues.selectDescription")}
              />
            )}
          </aside>
        </div>
      )}

      <IssueDetailMobileDrawer
        selectedIssue={
          selectedIssue ? toDrawerPayload(selectedIssue) : null
        }
        closeHref={buildHref({ selected: "" })}
      />
    </div>
  );
}

type IssueListItem = Prisma.IssueGetPayload<{ include: { _count: { select: { messages: true } } } }>;

// The translated labels a row and the pane share.
interface IssueLabels {
  status: (status: string) => string;
  type: (issueType: string) => string;
  date: (d: Date) => string;
}

// The status, type and scope chips, in the row and the pane.
function IssueChips({ issue, labels, t, withStatus }: { issue: IssueListItem; labels: IssueLabels; t: Translator; withStatus: boolean }) {
  const scopeLabel = scopeLabelFor(issue, t);
  return (
    <>
      {withStatus && <Chip tone={ISSUE_STATUS_TONE[issue.status]}>{labels.status(issue.status)}</Chip>}
      <Chip>{labels.type(issue.issueType)}</Chip>
      {scopeLabel && <Chip>{scopeLabel}</Chip>}
    </>
  );
}

// One list row: a link that selects the issue (the pane on desktop, the
// drawer on a phone).
function IssueRow({
  issue,
  href,
  isSelected,
  labels,
  t,
}: {
  issue: IssueListItem;
  href: string;
  isSelected: boolean;
  labels: IssueLabels;
  t: Translator;
}) {
  return (
    <div
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
        href={href}
        scroll={false}
        aria-current={isSelected ? "true" : undefined}
        className="flex items-start transition-colors hover:bg-[var(--ds-bg-3)]"
        style={{ gap: 14, padding: 14 }}
      >
        <IssuePoster posterPath={issue.posterPath} title={issue.title} mediaType={issue.mediaType} size={44} iconSize={16} />

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
            <span className="ds-mono" style={META_STYLE}>
              {issue.mediaType === "MOVIE" ? t("personal.common.movie") : t("personal.common.tv")}
            </span>
            <IssueChips issue={issue} labels={labels} t={t} withStatus={false} />
            <span className="ds-mono" style={META_STYLE}>
              {labels.date(new Date(issue.updatedAt))}
            </span>
          </div>
          {issue.note && <IssueNote note={issue.note} compact />}
          {issue.resolution && (
            <IssueResolution compact>
              {t("personal.issues.resolution", { text: issue.resolution })}
            </IssueResolution>
          )}
          {issue._count.messages > 0 && (
            <p
              className="ds-mono"
              style={{
                marginTop: 6,
                fontSize: 10.5,
                color:
                  "color-mix(in oklab, var(--ds-accent-text) 80%, var(--ds-fg))",
              }}
            >
              {t("personal.issues.messages", { count: issue._count.messages })}
            </p>
          )}
        </div>

        <div className="flex items-center shrink-0" style={{ gap: 8 }}>
          <Chip tone={ISSUE_STATUS_TONE[issue.status]}>
            {labels.status(issue.status)}
          </Chip>
          <ChevronRight
            className="xl:hidden"
            aria-hidden
            style={{
              width: 16,
              height: 16,
              color: "var(--ds-fg-subtle)",
            }}
          />
        </div>
      </Link>
    </div>
  );
}

const META_STYLE = { fontSize: 10.5, color: "var(--ds-fg-subtle)" } as const;

// The desktop pane's header above the thread: poster, title, chips, the
// filing date, the note and the resolution.
function IssueDetailHeader({ issue, labels, t }: { issue: IssueListItem; labels: IssueLabels; t: Translator }) {
  return (
    <div
      // max-h is what lets overflow-y-auto engage: a flex-shrink-0
      // header with no height cap never scrolls, so a long multi-line
      // note grew it until the thread (and its reply box) collapsed
      // to 0 inside the pane's overflow-hidden.
      className="flex-shrink-0 max-h-[45%] overflow-y-auto"
      style={{
        padding: 18,
        borderBottom: "1px solid var(--ds-border)",
      }}
    >
      <div className="flex items-start" style={{ gap: 14 }}>
        <IssuePoster posterPath={issue.posterPath} title={issue.title} mediaType={issue.mediaType} size={64} iconSize={20} />
        <div className="flex-1 min-w-0">
          <p
            className="font-semibold"
            style={{ fontSize: 14, color: "var(--ds-fg)" }}
          >
            {issue.title}
          </p>
          <div
            className="flex items-center flex-wrap"
            style={{ gap: 6, marginTop: 4 }}
          >
            <IssueChips issue={issue} labels={labels} t={t} withStatus />
          </div>
          <p className="ds-mono" style={{ marginTop: 4, ...META_STYLE }}>
            {t("personal.issues.reported", { date: labels.date(new Date(issue.createdAt)) })}
          </p>
        </div>
      </div>
      {issue.note && <IssueNote note={issue.note} />}
      {issue.resolution && (
        <IssueResolution>
          {t("personal.issues.resolution", { text: issue.resolution })}
        </IssueResolution>
      )}
    </div>
  );
}

// The poster (or a film/TV glyph) beside an issue, in the list row and the pane.
function IssuePoster({
  posterPath,
  title,
  mediaType,
  size,
  iconSize,
}: {
  posterPath: string | null;
  title: string;
  mediaType: string;
  size: number;
  iconSize: number;
}) {
  const poster = posterUrl(posterPath, "w342");
  return (
    <div
      className="relative shrink-0 overflow-hidden"
      style={{
        width: size,
        aspectRatio: "2 / 3",
        borderRadius: 4,
        background: "var(--ds-bg-3)",
      }}
    >
      {poster ? (
        <Image
          src={poster}
          alt={title}
          fill
          className="object-cover"
          sizes={`${size}px`}
        />
      ) : (
        <div
          className="absolute inset-0 flex items-center justify-center"
          style={{ color: "var(--ds-fg-subtle)" }}
        >
          {mediaType === "MOVIE" ? (
            <Film style={{ width: iconSize, height: iconSize }} />
          ) : (
            <Tv2 style={{ width: iconSize, height: iconSize }} />
          )}
        </div>
      )}
    </div>
  );
}

// The reporter's note. `compact` is the list row's: clamped (a 1000-char note
// is otherwise a ~17-line row); both keep its line breaks like the drawer.
function IssueNote({ note, compact = false }: { note: string; compact?: boolean }) {
  return (
    <p
      className={compact ? "line-clamp-3 whitespace-pre-wrap" : "whitespace-pre-wrap"}
      style={{
        marginTop: compact ? 8 : 12,
        padding: compact ? "6px 10px" : "8px 12px",
        borderRadius: 4,
        background: "var(--ds-bg-1)",
        borderLeft:
          "2px solid color-mix(in oklab, var(--ds-warning) 40%, transparent)",
        fontSize: compact ? 11.5 : 12,
        color: "var(--ds-fg-muted)",
      }}
    >
      {note}
    </p>
  );
}

// The admin's resolution line (already translated), in the row or the pane.
function IssueResolution({ compact = false, children }: { compact?: boolean; children: ReactNode }) {
  return (
    <p
      className="italic"
      style={{
        marginTop: compact ? 6 : 8,
        fontSize: compact ? 11.5 : 12,
        color:
          "color-mix(in oklab, var(--ds-success) 85%, var(--ds-fg))",
      }}
    >
      {children}
    </p>
  );
}
