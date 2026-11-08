"use client";

// The overview's Recent plays table. Click a row (or its chevron) to show its
// details; "Load more" fetches the next page from /api/play-history. The list
// and its loading live in useRecentPlays (./recent-plays/use-recent-plays),
// each play is a memoized RecentPlayRow (./recent-plays/row), and the row
// shape and its one mapping are ./recent-plays/map (which the server page
// seeds page 1 with).

import { useCallback, useState } from "react";
import Link from "next/link";
import { Loader2 } from "@/components/icons";
import { useT } from "@/components/i18n/i18n-provider";
import { ActivityCard } from "@/components/admin/activity-ui";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/design";
import { RecentPlayRow, TH } from "./recent-plays/row";
import { useRecentPlays } from "./recent-plays/use-recent-plays";
import type { RecentPlay } from "./recent-plays/map";

export type { RecentPlay } from "./recent-plays/map";

// "View history" keeps the Source / Type / Period filters this card was
// rendered under — the history page honours all three, so dropping them
// turned a "Jellyfin · TV · 90d" card into an unfiltered 30-day history.
function historyHrefFor(source?: string, mediaType?: string, days?: number): string {
  const historyParams = new URLSearchParams();
  if (source) historyParams.set("source", source);
  if (mediaType) historyParams.set("mediaType", mediaType);
  if (days) historyParams.set("days", String(days));
  const historyQuery = historyParams.toString();
  return `/admin/activity/history${historyQuery ? `?${historyQuery}` : ""}`;
}

function RecentPlaysHead() {
  const t = useT();
  return (
    <thead>
      <tr style={{ background: "var(--ds-bg-1)" }}>
        {/* The chevron and progress columns have no visible
            heading; a screen reader still gets a name for each. */}
        <th
          scope="col"
          className="ds-mono uppercase"
          style={{ ...TH, width: 26 }}
        >
          <span className="sr-only">{t("adminActivity.field.details")}</span>
        </th>
        {[
          t("adminActivity.field.user"),
          t("adminActivity.field.title"),
          t("adminActivity.field.started"),
          t("adminActivity.field.duration"),
          t("adminActivity.field.stream"),
          t("adminActivity.field.quality"),
        ].map((h, i) => (
          <th key={i} scope="col" className="ds-mono uppercase" style={TH}>
            {h}
          </th>
        ))}
        <th
          scope="col"
          className="ds-mono uppercase"
          style={{ ...TH, textAlign: "right" }}
        >
          <span className="sr-only">{t("adminActivity.field.progress")}</span>
        </th>
      </tr>
    </thead>
  );
}

// The card's title, how many sessions it lists, and the way to the full history.
function RecentPlaysHeader({ count, historyHref }: { count: number; historyHref: string }) {
  const t = useT();
  return (
    <div
      style={{
        padding: "16px 18px 12px",
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        borderBottom: "1px solid var(--ds-border)",
        gap: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 12,
          minWidth: 0,
        }}
      >
        <h2
          style={{
            margin: 0,
            fontSize: 13,
            fontWeight: 600,
            letterSpacing: "-0.01em",
            color: "var(--ds-fg)",
            whiteSpace: "nowrap",
          }}
        >
          {t("adminActivity.recentPlays.title")}
        </h2>
        <span
          className="ds-mono"
          style={{
            fontSize: 11,
            color: "var(--ds-fg-subtle)",
            whiteSpace: "nowrap",
          }}
        >
          {t("adminActivity.recentPlays.lastSessions", { count })}
        </span>
      </div>
      <Link
        href={historyHref}
        className="ds-mono"
        style={{
          fontSize: 11,
          color: "var(--ds-fg-muted)",
          textDecoration: "none",
          whiteSpace: "nowrap",
        }}
      >
        {t("adminActivity.recentPlays.viewHistory")}
      </Link>
    </div>
  );
}

// "Load more", with the reason the last load failed beside it.
function LoadMoreFooter({ loading, loadError, onLoadMore }: { loading: boolean; loadError: boolean; onLoadMore: () => void }) {
  const t = useT();
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "center",
        alignItems: "center",
        gap: 10,
        padding: "14px 0 18px",
      }}
    >
      {loadError && !loading && (
        <span
          role="alert"
          style={{ fontSize: 11.5, color: "var(--ds-danger)" }}
        >
          {t("adminActivity.recentPlays.loadMoreError")}
        </span>
      )}
      <Button variant="ghost" size="sm" onClick={onLoadMore} disabled={loading}>
        {loading ? (
          <>
            <Loader2 className="animate-spin" />
            {t("adminActivity.common.loading")}
          </>
        ) : (
          t("adminActivity.common.loadMore")
        )}
      </Button>
    </div>
  );
}

export function ActivityRecentPlays({
  plays: initialPlays,
  source,
  mediaType,
  startDateIso,
  days,
  timeZone,
}: {
  plays: RecentPlay[];
  source?: string;
  mediaType?: string;
  // Period lower bound, computed once on the server so paginated client
  // fetches stay consistent with the server-rendered first page (guardrail 16).
  startDateIso?: string;
  // The overview's selected period, forwarded to the "View history" link so
  // the history page opens on the same window this card was filtered to.
  days?: number;
  // The statistics zone (guardrail 19g): the detail row's times are shown in
  // it, named, like every other time on the page.
  timeZone: string;
}) {
  const t = useT();
  const { plays, hasMore, loading, loadError, loadMore } = useRecentPlays({
    initialPlays,
    source,
    mediaType,
    startDateIso,
    unknownUser: t("adminActivity.common.unknownUser"),
  });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const toggle = useCallback((id: string) => setExpandedId((cur) => (cur === id ? null : id)), []);

  return (
    <section style={{ marginBottom: 22 }}>
      <ActivityCard style={{ padding: 0, overflow: "hidden" }}>
        <RecentPlaysHeader count={plays.length} historyHref={historyHrefFor(source, mediaType, days)} />

        {plays.length === 0 ? (
          // The card is padding-0 (the table runs edge to edge), so the shared
          // empty block gets its own gutter rather than touching the card edges.
          <div style={{ padding: 14 }}>
            <EmptyState description={t("adminActivity.recentPlays.empty")} />
          </div>
        ) : (
          <div className="resp-table-scroll">
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 12.5,
              }}
            >
              <RecentPlaysHead />
              <tbody>
                {plays.map((p, i) => (
                  <RecentPlayRow
                    key={p.id}
                    p={p}
                    isLast={i === plays.length - 1}
                    isExpanded={expandedId === p.id}
                    timeZone={timeZone}
                    onToggle={toggle}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {hasMore && <LoadMoreFooter loading={loading} loadError={loadError} onLoadMore={loadMore} />}
      </ActivityCard>
    </section>
  );
}
