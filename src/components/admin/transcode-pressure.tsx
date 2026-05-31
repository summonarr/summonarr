// Transcode-pressure leaderboards for the activity overview. Transcodes are the
// expensive playback path (server CPU + bandwidth); this surfaces the users and
// titles driving the most of them in the selected period so an admin can spot
// heavy hitters. Static markup — data is fetched server-side (getTranscodeOffenders).

import { ActivityCard, SectionHeader, sourceDotColor } from "@/components/admin/activity-ui";
import type { TranscodeOffenders } from "@/lib/play-history";

function RankList({
  rows,
}: {
  rows: { key: string; label: string; source?: string; count: number }[];
}) {
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
              {r.count.toLocaleString("en-US")}
            </span>
          </div>
          <div style={{ height: 3, background: "oklch(1 0 0 / 0.06)", borderRadius: 999, overflow: "hidden" }}>
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
  if (data.topUsers.length === 0 && data.topTitles.length === 0) return null;

  return (
    <section style={{ marginBottom: 22 }}>
      <div
        className="resp-grid-2"
        style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}
      >
        <ActivityCard>
          <SectionHeader label="Transcode pressure · users" sub={`most transcodes · last ${days}d`} />
          {data.topUsers.length > 0 ? (
            <RankList
              rows={data.topUsers.map((u) => ({
                key: `${u.source}:${u.username}`,
                label: u.username,
                source: u.source,
                count: u.count,
              }))}
            />
          ) : (
            <p style={{ fontSize: 12, color: "var(--ds-fg-subtle)", margin: "6px 0 0" }}>
              No transcodes in this period.
            </p>
          )}
        </ActivityCard>

        <ActivityCard>
          <SectionHeader label="Transcode pressure · titles" sub={`most transcoded · last ${days}d`} />
          {data.topTitles.length > 0 ? (
            <RankList
              rows={data.topTitles.map((t) => ({
                key: `${t.tmdbId ?? t.title}`,
                label: t.title,
                count: t.count,
              }))}
            />
          ) : (
            <p style={{ fontSize: 12, color: "var(--ds-fg-subtle)", margin: "6px 0 0" }}>
              No transcodes in this period.
            </p>
          )}
        </ActivityCard>
      </div>
    </section>
  );
}
