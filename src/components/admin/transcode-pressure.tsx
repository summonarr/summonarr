"use client";

// Transcode-pressure leaderboards for the activity overview. Transcodes are the
// expensive playback path (server CPU + bandwidth); this surfaces the users and
// titles driving the most of them in the selected period so an admin can spot
// heavy hitters. Data is fetched server-side (getTranscodeOffenders) and passed
// as serializable props. Marked "use client" because it composes client-only
// primitives from activity-ui (sourceDotColor can't be called from the server).

import { ActivityCard, SectionHeader, sourceDotColor } from "@/components/admin/activity-ui";
import type { TranscodeOffenders } from "@/lib/play-history";
import { useLocale, useT } from "@/components/i18n/i18n-provider";

function RankList({
  rows,
}: {
  rows: { key: string; label: string; source?: string; count: number }[];
}) {
  const locale = useLocale();
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 4 }}>
      {rows.map((r) => (
        <div key={r.key} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                minWidth: 0,
                fontSize: 12,
                color: "var(--ds-fg)",
              }}
            >
              {r.source && (
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 999,
                    background: sourceDotColor(r.source),
                    flexShrink: 0,
                  }}
                />
              )}
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {r.label}
              </span>
            </span>
            <span
              className="ds-mono"
              style={{ fontSize: 11, color: "var(--ds-fg-muted)", whiteSpace: "nowrap" }}
            >
              {r.count.toLocaleString(locale)}
            </span>
          </div>
          <div style={{ height: 3, background: "color-mix(in oklab, var(--ds-fg) 6%, transparent)", borderRadius: 999, overflow: "hidden" }}>
            <div
              style={{
                width: `${(r.count / max) * 100}%`,
                height: "100%",
                background: "var(--ds-warning)",
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export function TranscodePressure({ data, days }: { data: TranscodeOffenders; days: number }) {
  const t = useT();
  if (data.topUsers.length === 0 && data.topTitles.length === 0) return null;

  return (
    <section style={{ marginBottom: 22 }}>
      <div
        className="resp-grid-2"
        style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}
      >
        <ActivityCard>
          <SectionHeader label={t("adminActivity.transcode.users")} sub={t("adminActivity.transcode.usersSub", { days })} />
          {data.topUsers.length > 0 ? (
            <RankList
              rows={data.topUsers.map((u) => ({
                // MediaServerUser.id, not username — username is not unique
                // (same person on two instances, or a departed + re-created row).
                key: `${u.source}:${u.id}`,
                label: u.username,
                source: u.source,
                count: u.count,
              }))}
            />
          ) : (
            <p style={{ fontSize: 12, color: "var(--ds-fg-subtle)", margin: "6px 0 0" }}>
              {t("adminActivity.transcode.none")}
            </p>
          )}
        </ActivityCard>

        <ActivityCard>
          <SectionHeader label={t("adminActivity.transcode.titles")} sub={t("adminActivity.transcode.titlesSub", { days })} />
          {data.topTitles.length > 0 ? (
            <RankList
              rows={data.topTitles.map((tt) => ({
                // Key on the same tuple the SQL groups by — (tmdbId, mediaType),
                // falling back to the lowercased title when tmdbId is null. TMDB
                // movie and TV ids are separate namespaces that overlap
                // numerically, so a movie and a series sharing an integer are two
                // rows and must not collapse to one React key. The `id:`/`t:`
                // prefixes keep a numeric-looking title from colliding with an id.
                key: `${tt.mediaType ?? ""}:${
                  tt.tmdbId != null ? `id:${tt.tmdbId}` : `t:${tt.title.toLowerCase()}`
                }`,
                label: tt.title,
                count: tt.count,
              }))}
            />
          ) : (
            <p style={{ fontSize: 12, color: "var(--ds-fg-subtle)", margin: "6px 0 0" }}>
              {t("adminActivity.transcode.none")}
            </p>
          )}
        </ActivityCard>
      </div>
    </section>
  );
}
