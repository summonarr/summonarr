"use client";

// Live "Now playing" grid. It starts from the sessions the server rendered,
// then updates from activity:sessions / plex:reachability messages on the SSE
// stream (server-sent events: the server's one-way live push to the browser).
// Each stream is a SessionCard (./now-playing/session-card); the merge of a
// push into the grid and the subtitle are pure rules (./now-playing/rules).

import { useState } from "react";
import { useLiveEvents, type ActiveSessionLive } from "@/hooks/use-live-events";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { EmptyState } from "@/components/ui/design";
import { SectionHeader } from "@/components/admin/activity-ui";
import { SessionCard } from "./now-playing/session-card";
import { mergeLiveSessions, nowPlayingSubtitle } from "./now-playing/rules";

export interface PlexReachability {
  instance: string;
  name: string;
  reachable: boolean | null;
}

function StatusDot({ color }: { color: string }) {
  return (
    <span
      style={{
        width: 6,
        height: 6,
        borderRadius: 999,
        background: color,
      }}
    />
  );
}

// The header's right side: a warning per unreachable Plex server, then the
// live-connection state.
function LiveStatus({ reachability, connected }: { reachability: PlexReachability[]; connected: boolean }) {
  const t = useT();
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      {reachability
        .filter((r) => r.reachable === false)
        .map((r) => (
          <span
            key={r.instance}
            className="ds-mono"
            title={t("adminActivity.nowPlaying.unreachableTitle", { name: r.name })}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              fontSize: 10.5,
              color: "var(--ds-warning)",
              whiteSpace: "nowrap",
            }}
          >
            <StatusDot color="var(--ds-warning)" />
            {/* The default server's name is "Plex", so a single-server
                deployment renders exactly the string it always did. */}
            {t("adminActivity.nowPlaying.unreachable", { name: r.name })}
          </span>
        ))}
      <span
        className="ds-mono"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          fontSize: 10.5,
          color: connected ? "var(--ds-success)" : "var(--ds-fg-subtle)",
          whiteSpace: "nowrap",
        }}
      >
        <StatusDot color={connected ? "var(--ds-success)" : "var(--ds-fg-disabled)"} />
        {connected ? t("adminActivity.nowPlaying.live") : t("adminActivity.nowPlaying.connecting")}
      </span>
    </span>
  );
}

export function ActivityNowPlaying({
  initialSessions,
  source,
  mediaType,
  plexReachability = [],
}: {
  initialSessions: ActiveSessionLive[];
  source?: string;
  mediaType?: string;
  // One entry per configured Plex server. `reachable`: null = unknown (not
  // configured / not polled yet), true = Summonarr can reach it
  // (getPlexSessions succeeds), false = it cannot (poll/connect failing). This
  // tracks *local* reachability, not plex.tv remote access. Read server-side
  // from each instance's Setting; SSE updates flow via the plex:reachability
  // event below, matched on `instance`.
  plexReachability?: PlexReachability[];
}) {
  const t = useT();
  const locale = useLocale();
  const [sessions, setSessions] =
    useState<ActiveSessionLive[]>(initialSessions);
  const [connected, setConnected] = useState(false);
  // One entry per Plex server. An SSE event only updates the entry whose
  // `instance` slug matches, so one server's news never overwrites another's.
  const [reachability, setReachability] = useState(plexReachability);
  // The prop is the server's latest read (a router.refresh() brings a new one);
  // follow it when its CONTENT changes, so a refresh isn't ignored. Keyed on the
  // serialized value, not the array identity, so a re-render with an equal
  // array doesn't wipe a newer SSE update.
  const reachabilityKey = JSON.stringify(plexReachability);
  const [seenReachabilityKey, setSeenReachabilityKey] = useState(reachabilityKey);
  if (seenReachabilityKey !== reachabilityKey) {
    setSeenReachabilityKey(reachabilityKey);
    setReachability(plexReachability);
  }

  useLiveEvents((event) => {
    if (event.type === "connected") setConnected(true);
    if (event.type === "disconnected") setConnected(false);
    if (event.type === "activity:sessions") {
      setSessions((prev) => mergeLiveSessions(prev, event.sessions, { source, mediaType }));
    }
    if (event.type === "plex:reachability") {
      setReachability((prev) =>
        prev.map((r) => (r.instance === event.instance ? { ...r, reachable: event.reachable } : r)),
      );
    }
  });

  return (
    <section style={{ marginBottom: 28 }}>
      <SectionHeader
        label={t("adminActivity.nowPlaying.title")}
        sub={nowPlayingSubtitle(sessions, t, locale)}
        right={<LiveStatus reachability={reachability} connected={connected} />}
      />
      {sessions.length === 0 ? (
        <EmptyState description={t("adminActivity.nowPlaying.noActive")} />
      ) : (
        <div
          className="resp-grid-3"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
            gap: 10,
          }}
        >
          {sessions.map((s) => (
            <SessionCard key={s.id} s={s} />
          ))}
        </div>
      )}
    </section>
  );
}
