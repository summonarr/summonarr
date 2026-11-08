"use client";

import { memo, useState, useDeferredValue, useMemo } from "react";
import Image from "next/image";
import { FixMatchButton } from "@/components/admin/fix-match-button";
import { posterUrl } from "@/lib/tmdb-types";
import { mediaInstanceLabel } from "@/lib/media-instances";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { rich } from "@/components/settings/forms/rich";
import { badMatchSideKey, fixAllEligible, suggestWrongSide, type DiffSource } from "@/lib/library-diff";
import type { FixAllEntry } from "@/lib/client/fix-all-sequence";
import { REQUEST_STATUS_LABEL_KEY } from "@/lib/status-labels";
import { arrServiceName } from "@/lib/arr-service-name";
import { FixAllControl, useFixAllRun, type FixAllRun } from "./fix-all-run";

interface RequestSummary {
  total: number;
  statuses: string[];
}

export interface DiffItem {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  // Which configured server this row came from — "" = the default/only server,
  // a slug = a named additional one. The same title can now appear once per
  // server, so this is part of the row's identity (React key, DOM id).
  serverInstance: string;
  title: string | null;
  posterPath: string | null;
  releaseYear: string | null;
  overview: string | null;
  voteAverage: number | null;

  relPath: string | null;
  // True when the file path came from Radarr/Sonarr rather than the library item itself
  relPathFromArr: boolean;
  // The TMDB ID Radarr/Sonarr resolved for this file (may differ from the library item's tmdbId)
  arrTmdbId: number | null;
  // Library's tmdbId disagrees with arrTmdbId — fix-match is needed
  arrMismatch: boolean;

  inArr: boolean;
  requests: RequestSummary;
  // Why the OTHER server lacks this title (mirrored libraries: never random).
  diffSource: DiffSource;
}

export interface BadMatchSideData {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  serverInstance: string;
  title: string | null;
  posterPath: string | null;
  releaseYear: string | null;
}

export interface ClientBadMatch {
  relativePath: string;
  plex: BadMatchSideData;
  plexRatingKey: string | null;
  jellyfin: BadMatchSideData;
  jellyfinItemId: string | null;
  arrTmdbId: number | null;
  arrVerdict: "plex" | "jellyfin" | null;
}

type ArrFilter     = "all" | "mismatch" | "not_in_arr" | "matches";
type RequestFilter = "all" | "has_requests";

type Server = "plex" | "jellyfin";

// One identity token per brand, the same ones the page's stat tiles use —
// the Jellyfin column/chips used to be purple while the tile beside them was
// the cyan brand token, so one product read as two. `tint` is a fill/border;
// as TEXT on the light theme it is ~2:1, so text on a tint chip takes the
// per-theme `text` colour (worst case 4.6:1 on a 14% chip in either theme) —
// guardrail 42. Keyed by server, so every chip gets both halves of one brand.
const SERVER_COLOURS: Record<Server, { tint: string; text: string }> = {
  plex:     { tint: "var(--ds-plex)",     text: "var(--ds-plex-text)" },
  jellyfin: { tint: "var(--ds-jellyfin)", text: "var(--ds-jellyfin-text)" },
};

function statusChip(status: string) {
  switch (status) {
    case "PENDING":   return "ds-chip ds-chip-pending";
    case "APPROVED":  return "ds-chip ds-chip-approved";
    case "AVAILABLE": return "ds-chip ds-chip-approved";
    case "DECLINED":  return "ds-chip ds-chip-declined";
    default:          return "ds-chip";
  }
}

// The card's styles that never change, built once.
const CARD_POSTER_STYLE = { border: "1px solid var(--ds-border)" } as const;
const CARD_POSTER_PLACEHOLDER_STYLE = {
  width: 56,
  height: 84,
  borderRadius: 4,
  background: "repeating-linear-gradient(135deg, var(--ds-bg-3) 0 10px, var(--ds-bg-2) 10px 20px)",
  border: "1px solid var(--ds-border)",
  color: "var(--ds-fg-subtle)",
  fontSize: 9,
} as const;
const CARD_BODY_STYLE = { display: "flex", flexDirection: "column", gap: 4 } as const;
const CARD_TITLE_STYLE = { fontSize: 13.5, color: "var(--ds-fg)", lineHeight: 1.3 } as const;
const CARD_MONO_SUBTLE_STYLE = { fontSize: 10.5, color: "var(--ds-fg-subtle)" } as const;
const CARD_TYPE_CHIP_STYLE = { fontSize: 9.5, textTransform: "uppercase", padding: "1px 6px" } as const;
const CARD_OVERVIEW_STYLE = { margin: 0, fontSize: 11.5, color: "var(--ds-fg-subtle)", lineHeight: 1.45 } as const;
const CARD_PATH_STYLE = { margin: 0, fontSize: 10, color: "var(--ds-fg-subtle)", lineHeight: 1.4 } as const;
const CARD_PATH_SOURCE_STYLE = { fontFamily: "inherit", color: "var(--ds-fg-disabled)", marginLeft: 6 } as const;
const STATUS_CHIP_STYLE = { fontSize: 9.5, padding: "1px 6px" } as const;

function tmdbHref(mediaType: "MOVIE" | "TV", tmdbId: number): string {
  return `https://www.themoviedb.org/${mediaType === "MOVIE" ? "movie" : "tv"}/${tmdbId}`;
}

function CardPoster({ thumb, alt }: { thumb: string | null; alt: string }) {
  const t = useT();
  return (
    <div className="shrink-0">
      {thumb ? (
        <Image src={thumb} alt={alt} width={56} height={84} className="rounded object-cover" style={CARD_POSTER_STYLE} sizes="56px" />
      ) : (
        <div className="ds-mono flex items-center justify-center" style={CARD_POSTER_PLACEHOLDER_STYLE}>
          {t("adminManage.library.diff.poster")}
        </div>
      )}
    </div>
  );
}

// The type, the server (named instances only), the rating and the TMDB link.
function CardChips({ item, server }: { item: DiffItem; server?: Server }) {
  const t = useT();
  const typeLabel = item.mediaType === "MOVIE" ? t("adminManage.library.diff.movie") : t("adminManage.library.diff.tv");
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="ds-chip" style={CARD_TYPE_CHIP_STYLE}>
        {typeLabel}
      </span>
      {/* Server badge — rendered ONLY for a named instance (e.g.
          "plex:remote"), so a single-server deployment keeps exactly the
          chip row it always had. Colour is keyed off the service; the slug
          lives in the text (same split as ServerUserTable's source badge). */}
      {server && item.serverInstance !== "" && (
        <span
          className="ds-chip"
          style={{
            background: `color-mix(in oklab, ${SERVER_COLOURS[server].tint} 14%, transparent)`,
            borderColor: `color-mix(in oklab, ${SERVER_COLOURS[server].tint} 35%, var(--ds-border))`,
            color: SERVER_COLOURS[server].text,
            fontSize: 9.5,
            padding: "1px 6px",
          }}
        >
          {mediaInstanceLabel(server, item.serverInstance)}
        </span>
      )}
      {item.voteAverage != null && item.voteAverage > 0 && (
        <span className="ds-mono" style={{ fontSize: 10.5, color: "var(--ds-fg-muted)" }}>
          ★ {item.voteAverage.toFixed(1)}
        </span>
      )}
      <a
        href={tmdbHref(item.mediaType, item.tmdbId)}
        target="_blank"
        rel="noopener noreferrer"
        className="ds-mono transition-colors"
        style={CARD_MONO_SUBTLE_STYLE}
      >
        TMDB #{item.tmdbId} ↗
      </a>
    </div>
  );
}

// What Radarr/Sonarr say about the file: a mismatch (with its fix), in the
// arr, or not in it; nothing when there is no path to judge.
function ArrStatusLine({ item, server }: { item: DiffItem; server?: Server }) {
  const t = useT();
  const arrName = arrServiceName(item.mediaType);
  if (item.arrMismatch && item.arrTmdbId !== null) {
    return (
      <div style={{ marginTop: 2 }} className="flex items-center gap-2 flex-wrap">
        <span className="ds-mono" style={{ fontSize: 10, color: "var(--ds-warning)" }}>
          {t("adminManage.library.diff.arrMismatch", { arr: arrName, id: item.arrTmdbId })}
        </span>
        {server && (
          <FixMatchButton
            server={server}
            serverInstance={item.serverInstance}
            tmdbId={item.tmdbId}
            mediaType={item.mediaType}
            correctTmdbId={item.arrTmdbId}
            arrTmdbId={item.arrTmdbId}
            label={t("adminManage.library.diff.fixShort", { server: server === "plex" ? "Plex" : "Jellyfin", id: item.arrTmdbId })}
          />
        )}
      </div>
    );
  }
  if (item.inArr) {
    return (
      <span className="ds-mono" style={{ marginTop: 2, fontSize: 10, color: "var(--ds-success)" }}>
        {arrName} ✓
      </span>
    );
  }
  if (item.relPath) {
    return (
      <span className="ds-mono" style={{ marginTop: 2, fontSize: 10, color: "var(--ds-fg-subtle)" }}>
        {t("adminManage.library.diff.notInArr", { arr: arrName })}
      </span>
    );
  }
  return null;
}

function RequestChips({ requests }: { requests: RequestSummary }) {
  const t = useT();
  if (requests.total <= 0) return null;
  return (
    <div className="flex items-center gap-1.5 flex-wrap" style={{ marginTop: 2 }}>
      <span className="ds-mono uppercase" style={{ fontSize: 10, color: "var(--ds-fg-subtle)", letterSpacing: "0.04em" }}>
        {t("adminManage.library.diff.requests", { count: requests.total })}
      </span>
      {requests.statuses.map((s) => {
        // One map from status to its catalog key; a status it doesn't know is shown as stored.
        const key = REQUEST_STATUS_LABEL_KEY[s];
        return (
          <span key={s} className={statusChip(s)} style={STATUS_CHIP_STYLE}>
            {key ? t(key) : s}
          </span>
        );
      })}
    </div>
  );
}

// Memoized: a search keystroke re-filters the lists but keeps each item's
// reference, so only cards whose props changed render again.
const MediaCard = memo(function MediaCard({
  item,
  highlight = false,
  server,
}: {
  item: DiffItem;
  highlight?: boolean;
  server?: Server;
}) {
  const t = useT();
  const displayTitle = item.title || `TMDB #${item.tmdbId}`;

  // The default instance keeps the exact legacy id so any existing
  // #item-<tmdbId>-<TYPE> deep link still resolves; a named server appends its
  // slug, because one title present on two servers otherwise emits the same
  // DOM id twice (breaking the anchor and the ?tmdbId= highlight scroll).
  const domId = item.serverInstance
    ? `item-${item.serverInstance}-${item.tmdbId}-${item.mediaType}`
    : `item-${item.tmdbId}-${item.mediaType}`;

  return (
    <div
      id={domId}
      className="flex gap-3"
      style={{
        padding: 12,
        background: "var(--ds-bg-2)",
        border: highlight
          ? `1px solid var(--ds-accent-ring)`
          : "1px solid var(--ds-border)",
        borderRadius: 8,
        boxShadow: highlight ? "0 0 0 1px var(--ds-accent-ring)" : undefined,
      }}
    >
      <CardPoster thumb={posterUrl(item.posterPath, "w342")} alt={displayTitle} />

      <div className="flex-1 min-w-0" style={CARD_BODY_STYLE}>
        <div className="flex items-baseline gap-1.5 flex-wrap">
          <span className="font-medium truncate" style={CARD_TITLE_STYLE}>
            {displayTitle}
          </span>
          {item.releaseYear && (
            <span className="ds-mono shrink-0" style={CARD_MONO_SUBTLE_STYLE}>
              {item.releaseYear}
            </span>
          )}
        </div>

        <CardChips item={item} server={server} />

        {item.overview && (
          <p className="line-clamp-2" style={CARD_OVERVIEW_STYLE}>
            {item.overview}
          </p>
        )}

        {item.relPath && (
          <p className="ds-mono break-all" style={CARD_PATH_STYLE}>
            {item.relPath}
            {item.relPathFromArr && (
              <span className="not-italic" style={CARD_PATH_SOURCE_STYLE}>
                {t("adminManage.library.diff.sonarrPath")}
              </span>
            )}
          </p>
        )}

        <DiffSourceNote source={item.diffSource} server={server} />

        <ArrStatusLine item={item} server={server} />

        <RequestChips requests={item.requests} />
      </div>
    </div>
  );
});

function DiffSourceNote({ source, server }: { source: DiffSource; server?: "plex" | "jellyfin" }) {
  const t = useT();
  const other = server === "plex" ? "Jellyfin" : "Plex";
  const warn = source.kind === "idMismatch" || source.kind === "unmatched";
  let text: string;
  switch (source.kind) {
    case "idMismatch":
      text = t("adminManage.library.diff.source.idMismatch", {
        server: other,
        title: source.otherTitle || `TMDB #${source.otherTmdbId}`,
        id: source.otherTmdbId ?? 0,
      });
      break;
    case "unmatched":   text = t("adminManage.library.diff.source.unmatched", { server: other }); break;
    case "notOnOther":  text = t("adminManage.library.diff.source.notOnOther", { server: other }); break;
    default:            text = t("adminManage.library.diff.source.noPath", { server: other }); break;
  }
  return (
    <span
      className="ds-mono"
      style={{ fontSize: 10, lineHeight: 1.4, color: warn ? "var(--ds-warning)" : "var(--ds-fg-subtle)" }}
    >
      {text}
    </span>
  );
}

function BadMatchSide({
  item,
  label,
  server,
  filePath,
}: {
  item: BadMatchSideData;
  label: string;
  server: Server;
  filePath?: string | null;
}) {
  const { tint, text } = SERVER_COLOURS[server];
  const thumb        = posterUrl(item.posterPath, "w342");
  const displayTitle = item.title || `TMDB #${item.tmdbId}`;

  const fileName = filePath ? filePath.split("/").pop() : null;
  const dirPath  = filePath && fileName
    ? filePath.slice(0, filePath.length - fileName.length).replace(/\/$/, "")
    : null;

  return (
    <div
      className="flex-1 min-w-0 flex"
      style={{
        padding: 12,
        gap: 10,
        background: "var(--ds-bg-inset, var(--ds-bg))",
        border: `1px solid color-mix(in oklab, ${tint} 35%, var(--ds-border))`,
        borderRadius: 8,
      }}
    >
      <div className="shrink-0">
        {thumb ? (
          <Image
            src={thumb}
            alt={displayTitle}
            width={48}
            height={72}
            className="rounded object-cover"
            style={{ border: "1px solid var(--ds-border)" }}
            sizes="48px"
          />
        ) : (
          <div
            style={{
              width: 48,
              height: 72,
              borderRadius: 4,
              background:
                "repeating-linear-gradient(135deg, var(--ds-bg-3) 0 8px, var(--ds-bg-2) 8px 16px)",
              border: "1px solid var(--ds-border)",
            }}
          />
        )}
      </div>
      <div className="flex-1 min-w-0" style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        <span
          className="ds-chip self-start"
          style={{
            background: `color-mix(in oklab, ${tint} 14%, transparent)`,
            borderColor: `color-mix(in oklab, ${tint} 35%, var(--ds-border))`,
            color: text,
            fontSize: 9.5,
            padding: "1px 7px",
            fontWeight: 600,
          }}
        >
          {label}
        </span>
        <span className="font-medium truncate" style={{ fontSize: 13, color: "var(--ds-fg)" }}>
          {displayTitle}
        </span>
        <span className="ds-mono" style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)" }}>
          {item.releaseYear ? `${item.releaseYear} · ` : ""}
          <a
            href={tmdbHref(item.mediaType, item.tmdbId)}
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors"
            style={{ color: "var(--ds-fg-subtle)" }}
          >
            TMDB #{item.tmdbId} ↗
          </a>
        </span>
        {fileName && (
          <div style={{ marginTop: 4 }}>
            <p className="ds-mono break-all" style={{ margin: 0, fontSize: 10, color: "var(--ds-fg)", lineHeight: 1.35 }}>
              {fileName}
            </p>
            {dirPath && (
              <p className="ds-mono break-all" style={{ margin: 0, fontSize: 9.5, color: "var(--ds-fg-subtle)", lineHeight: 1.35 }}>
                {dirPath}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// "PLEX" for the default server, "PLEX:REMOTE" for a named one. This chip is
// the only place a bad-match card names its server, and with two Plex servers
// configured a bare "PLEX" no longer says which one holds the wrong match.
function sideLabel(service: "plex" | "jellyfin", serverInstance: string): string {
  return mediaInstanceLabel(service, serverInstance).toUpperCase();
}

// The key Fix all runs a bad match's WRONG side under — and the key its card
// checks to lock that side while the run still has it to do.
function badMatchFixKey(side: Server, item: BadMatchSideData): string {
  return `${side}:${item.serverInstance}:${item.mediaType}:${item.tmdbId}`;
}

// The Fix all entry for a match it may run (fixAllEligible: a verdict, the
// id, and the wrong side's item key): remap the wrong side on the server it
// actually lives on, like the card's own button does.
function badMatchFixEntry(match: ClientBadMatch & { arrVerdict: Server; arrTmdbId: number }): FixAllEntry {
  const wrongItem = match[match.arrVerdict];
  return {
    key: badMatchFixKey(match.arrVerdict, wrongItem),
    title: wrongItem.title ?? `TMDB #${wrongItem.tmdbId}`,
    request: {
      server: match.arrVerdict,
      tmdbId: wrongItem.tmdbId,
      mediaType: wrongItem.mediaType,
      correctTmdbId: match.arrTmdbId,
      // Without it the route would use the default server and remap the wrong
      // library. Omitted for the default server so that request body stays unchanged.
      ...(wrongItem.serverInstance ? { serverInstance: wrongItem.serverInstance } : {}),
    },
  };
}

const NOTE_STYLE = { fontSize: 9.5, color: "var(--ds-fg-subtle)" } as const;

// One server's half of a bad-match card: its item, and the fix it is offered —
// dimmed when Radarr/Sonarr say the OTHER side is the wrong one.
function BadMatchColumn({ match, side, locked }: { match: ClientBadMatch; side: Server; locked: boolean }) {
  const t = useT();
  const other: Server = side === "plex" ? "jellyfin" : "plex";
  const item = match[side];
  const correctId = match.arrTmdbId ?? match[other].tmdbId;
  const { arrVerdict } = match;
  let fix: React.ReactNode;
  if (arrVerdict !== side && arrVerdict !== null) {
    fix = (
      <span className="ds-mono" style={{ fontSize: 9.5, color: "var(--ds-success)" }}>
        {t("adminManage.library.diff.correctMatch")}
      </span>
    );
  } else if (locked) {
    // Fix all still has this side to do: a fix from here first would make the
    // run report it as failed ("not found") when it got there.
    fix = <span className="ds-mono" style={NOTE_STYLE}>{t("adminManage.library.fixAllQueued")}</span>;
  } else if (badMatchSideKey(match, side)) {
    fix = (
      <FixMatchButton
        server={side}
        serverInstance={item.serverInstance}
        tmdbId={item.tmdbId}
        mediaType={item.mediaType}
        correctTmdbId={correctId}
        arrTmdbId={match.arrTmdbId}
        label={t("adminManage.library.diff.fix", { server: side === "plex" ? "Plex" : "Jellyfin", id: correctId })}
      />
    );
  } else {
    fix = <span className="ds-mono" style={NOTE_STYLE}>{t("adminManage.library.diff.resyncToFix")}</span>;
  }
  return (
    <div
      className="flex-1 min-w-0"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        opacity: arrVerdict === other ? 0.4 : 1,
      }}
    >
      <BadMatchSide item={item} label={sideLabel(side, item.serverInstance)} server={side} filePath={match.relativePath} />
      {fix}
    </div>
  );
}

function BadMatchCard({ match, pending }: { match: ClientBadMatch; pending: ReadonlySet<string> }) {
  const t = useT();
  const { arrVerdict, arrTmdbId } = match;
  // No arr verdict: the folder's year may still say which side is off.
  const yearHint = suggestWrongSide(match.relativePath, match.plex.releaseYear, match.jellyfin.releaseYear);

  return (
    <div
      style={{
        padding: 14,
        background: "var(--ds-bg-2)",
        border: "1px solid color-mix(in oklab, var(--ds-warning) 30%, var(--ds-border))",
        borderRadius: 8,
      }}
    >
      <div className="flex items-start gap-2" style={{ marginBottom: 10 }}>
        <span style={{ color: "var(--ds-warning)", fontWeight: 600, fontSize: 12 }}>⚠</span>
        <p
          className="ds-mono break-all"
          style={{ margin: 0, fontSize: 11, color: "var(--ds-fg-muted)", lineHeight: 1.5 }}
        >
          {match.relativePath}
        </p>
      </div>

      {arrVerdict && arrTmdbId ? (
        <div
          className="flex items-center gap-2"
          style={{
            padding: "6px 10px",
            marginBottom: 12,
            borderRadius: 6,
            background: "color-mix(in oklab, var(--ds-success) 10%, transparent)",
            border: "1px solid color-mix(in oklab, var(--ds-success) 28%, var(--ds-border))",
          }}
        >
          <span style={{ color: "var(--ds-success)", fontSize: 12 }}>✓</span>
          <p style={{ margin: 0, fontSize: 11, color: "var(--ds-success)" }}>
            {/* One sentence with a {server} slot, so each language places the
                name (and its spacing) itself — fragments joined with " " put
                stray spaces into Chinese. */}
            {rich(t("adminManage.library.diff.arrConfirmsWrong", { id: arrTmdbId }), {
              server: <span className="font-semibold capitalize">{arrVerdict}</span>,
            })}
          </p>
        </div>
      ) : (
        <div
          className="flex items-center gap-2"
          style={{
            padding: "6px 10px",
            marginBottom: 12,
            borderRadius: 6,
            background: "var(--ds-bg-3)",
            border: "1px solid var(--ds-border)",
          }}
        >
          <span style={{ color: "var(--ds-fg-subtle)", fontSize: 12 }}>?</span>
          <p style={{ margin: 0, fontSize: 11, color: "var(--ds-fg-muted)" }}>
            {arrTmdbId === null
              ? t("adminManage.library.diff.arrMissing")
              : t("adminManage.library.diff.arrDisagree")}
          </p>
        </div>
      )}

      {!arrVerdict && yearHint && (
        <p className="ds-mono" style={{ margin: "0 0 10px", fontSize: 11, color: "var(--ds-warning)" }}>
          {t("adminManage.library.diff.yearHint", {
            year: yearHint.year,
            right: yearHint.wrong === "plex" ? "Jellyfin" : "Plex",
            wrong: yearHint.wrong === "plex" ? "Plex" : "Jellyfin",
          })}
        </p>
      )}

      <div className="flex gap-3 flex-wrap md:flex-nowrap">
        <BadMatchColumn match={match} side="plex" locked={pending.has(badMatchFixKey("plex", match.plex))} />
        <BadMatchColumn match={match} side="jellyfin" locked={pending.has(badMatchFixKey("jellyfin", match.jellyfin))} />
      </div>
    </div>
  );
}

function ArrFilterButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="ds-tap font-medium transition-colors"
      style={{
        padding: "5px 12px",
        fontSize: 12,
        borderRadius: 999,
        background: active ? "var(--ds-accent)" : "var(--ds-bg-2)",
        color: active ? "var(--ds-accent-fg)" : "var(--ds-fg-muted)",
        border: active ? "1px solid var(--ds-accent)" : "1px solid var(--ds-border)",
      }}
    >
      {children}
    </button>
  );
}

// Most cards drawn per column. A 5,000-row diff would otherwise put ~70k
// elements on the page. The cap is applied AFTER search and filters, so
// narrowing the search can still reach any row the cap hides. Real diffs are
// usually in the hundreds; this guards the spike while a newly added second
// server is still on its first sync.
const RENDER_CAP = 500;

function DiffColumn({
  label,
  items,
  totalBefore,
  configured,
  otherServer,
  filtersActive,
  server,
  highlightServer,
  highlightKey,
}: {
  label: string;
  items: DiffItem[];
  totalBefore: number;
  configured: boolean;
  otherServer: Server;
  filtersActive: boolean;
  server: Server;
  highlightServer: string | null;
  highlightKey: string | null;
}) {
  const t = useT();
  const locale = useLocale();
  const { tint, text } = SERVER_COLOURS[server];
  const otherConfiguredMsg = otherServer === "plex"
    ? t("adminManage.library.diff.plexHasAll")
    : t("adminManage.library.diff.jellyfinHasAll");
  // A ?tmdbId= deep link lands on a row; float it to the top so it is on screen
  // instead of buried under the render cap. Stable: the rest keep their order.
  const ordered = highlightServer === server && highlightKey
    ? [...items.filter((i) => `${i.tmdbId}:${i.mediaType}` === highlightKey), ...items.filter((i) => `${i.tmdbId}:${i.mediaType}` !== highlightKey)]
    : items;
  const emptyMsg = !configured
    ? t("adminManage.library.diff.notSynced", { server: server === "plex" ? "Plex" : "Jellyfin" })
    : otherConfiguredMsg;

  return (
    <div>
      <div className="flex items-center gap-2.5 flex-wrap" style={{ marginBottom: 12 }}>
        <span
          className="ds-chip"
          style={{
            background: `color-mix(in oklab, ${tint} 14%, transparent)`,
            borderColor: `color-mix(in oklab, ${tint} 35%, var(--ds-border))`,
            color: text,
            fontSize: 10,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            padding: "2px 8px",
            fontWeight: 600,
          }}
        >
          {label}
        </span>
        <span
          className="ds-mono"
          style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)", letterSpacing: "0.04em" }}
        >
          {items.length !== totalBefore
            ? t("adminManage.library.diff.itemsOf", { count: items.length, total: totalBefore })
            : t("adminManage.library.diff.items", { count: items.length })}
        </span>
      </div>

      {items.length > RENDER_CAP && (
        <p
          role="status"
          className="ds-mono"
          style={{ fontSize: 11, color: "var(--ds-fg-subtle)", marginBottom: 8 }}
        >
          {t("adminManage.library.diff.renderCap", { cap: RENDER_CAP.toLocaleString(locale), total: items.length.toLocaleString(locale) })}
        </p>
      )}
      {items.length === 0 ? (
        <div
          style={{
            padding: 18,
            background: "var(--ds-bg-1)",
            border: "1px dashed var(--ds-border)",
            borderRadius: 8,
            color: "var(--ds-fg-subtle)",
            fontSize: 13,
          }}
        >
          {filtersActive ? t("adminManage.library.diff.noFilterMatch") : emptyMsg}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {ordered.slice(0, RENDER_CAP).map((item) => (
            <MediaCard
              // serverInstance is part of the key: the same title present on two
              // configured servers is two rows here, and without it React sees a
              // duplicate key and renders only one of them.
              key={`${item.serverInstance}:${item.tmdbId}:${item.mediaType}`}
              item={item}
              server={server}
              // Deliberately matched on tmdbId:mediaType only — a ?tmdbId= deep
              // link names a title, not a server instance, so it rings that
              // title on every server holding it rather than needing a new param.
              highlight={
                highlightServer === server &&
                highlightKey === `${item.tmdbId}:${item.mediaType}`
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function applyFilters(items: DiffItem[], q: string, arrFilter: ArrFilter, requestFilter: RequestFilter): DiffItem[] {
  let result = items;
  if (q) {
    result = result.filter(
      (i) =>
        (i.title ?? "").toLowerCase().includes(q) ||
        (i.relPath ?? "").toLowerCase().includes(q),
    );
  }
  if (arrFilter === "mismatch")   result = result.filter((i) => i.arrMismatch);
  if (arrFilter === "not_in_arr") result = result.filter((i) => !i.inArr);
  if (arrFilter === "matches")    result = result.filter((i) => i.inArr && !i.arrMismatch);
  if (requestFilter === "has_requests") result = result.filter((i) => i.requests.total > 0);
  return result;
}

function filterBadMatches(items: ClientBadMatch[], q: string): ClientBadMatch[] {
  if (!q) return items;
  return items.filter(
    (m) =>
      m.relativePath.toLowerCase().includes(q) ||
      (m.plex.title     ?? "").toLowerCase().includes(q) ||
      (m.jellyfin.title ?? "").toLowerCase().includes(q),
  );
}

// The search box and the filter chips.
function DiffFilters({
  search,
  onSearch,
  arrFilter,
  onArrFilter,
  requestFilter,
  onToggleRequests,
}: {
  search: string;
  onSearch: (q: string) => void;
  arrFilter: ArrFilter;
  onArrFilter: (f: ArrFilter) => void;
  requestFilter: RequestFilter;
  onToggleRequests: () => void;
}) {
  const t = useT();
  const arrFilterOptions: { value: ArrFilter; label: string }[] = [
    { value: "all",        label: t("adminManage.library.diff.filter.all") },
    { value: "mismatch",   label: t("adminManage.library.diff.filter.mismatch") },
    { value: "not_in_arr", label: t("adminManage.library.diff.filter.notInArr") },
    { value: "matches",    label: t("adminManage.library.diff.filter.matches") },
  ];
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="search"
        placeholder={t("adminManage.library.diff.searchPlaceholder")}
        aria-label={t("adminManage.library.diff.search")}
        value={search}
        onChange={(e) => onSearch(e.target.value)}
        className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent-ring)]"
        style={{
          height: 32,
          width: 260,
          padding: "0 12px",
          fontSize: 13,
          borderRadius: 8,
          background: "var(--ds-bg-1)",
          border: "1px solid var(--ds-border)",
          color: "var(--ds-fg)",
        }}
      />

      <div className="flex items-center gap-1.5">
        {arrFilterOptions.map((opt) => (
          <ArrFilterButton
            key={opt.value}
            active={arrFilter === opt.value}
            onClick={() => onArrFilter(opt.value)}
          >
            {opt.label}
          </ArrFilterButton>
        ))}
      </div>

      <ArrFilterButton active={requestFilter === "has_requests"} onClick={onToggleRequests}>
        {t("adminManage.library.diff.filter.hasRequests")}
      </ArrFilterButton>
    </div>
  );
}

// Bad-match cards drawn at once. Each is two posters and up to two fix
// buttons, so a library with thousands of mismatches (an agent change) would
// put far more on the page than the columns' cap. Applied after the search,
// like the columns' cap, so narrowing the search reaches any of them.
const BAD_MATCH_RENDER_CAP = 200;

// The suspected bad matches and their bulk Fix all. `fixAll` is the page's,
// so the cards can lock what the run still has to do.
function BadMatchSection({
  matches,
  totalBefore,
  fixAll,
}: {
  matches: ClientBadMatch[];
  totalBefore: number;
  fixAll: FixAllRun;
}) {
  const t = useT();
  const locale = useLocale();
  // The cards' own rule: a side with no item key says "re-sync to fix".
  const fixable = matches.filter(fixAllEligible);
  const progress = fixAll.progress;
  const label = fixAll.state === "running"
    ? t("adminManage.library.diff.fixing", { done: progress.handled, total: progress.total })
    : fixAll.state === "done"
      ? (progress.stopped
        ? t("adminManage.library.diff.fixStopped", { fixed: progress.fixed, total: progress.total })
        : progress.partial > 0
          ? t("adminManage.library.diff.fixDonePartial", { fixed: progress.fixed, total: progress.total, partial: progress.partial })
          : t("adminManage.library.diff.fixDone", { fixed: progress.fixed, total: progress.total }))
      : t("adminManage.library.diff.fixAll", { count: fixable.length });

  return (
    <section>
      <div className="flex items-center gap-2.5 flex-wrap" style={{ marginBottom: 12 }}>
        <span
          className="ds-chip"
          style={{
            background: "color-mix(in oklab, var(--ds-warning) 14%, transparent)",
            borderColor: "color-mix(in oklab, var(--ds-warning) 35%, var(--ds-border))",
            color: "var(--ds-warning)",
            fontSize: 10,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            padding: "2px 8px",
            fontWeight: 600,
          }}
        >
          {t("adminManage.library.diff.badMatches")}
        </span>
        <span
          className="ds-mono"
          style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)", letterSpacing: "0.04em" }}
        >
          {matches.length !== totalBefore
            ? t("adminManage.library.diff.itemsOf", { count: matches.length, total: totalBefore })
            : t("adminManage.library.diff.items", { count: matches.length })}
          {" · "}{t("adminManage.library.diff.badMatchesHint")}
        </span>
        <div style={{ marginLeft: "auto" }}>
          <FixAllControl
            run={fixAll}
            count={fixable.length}
            label={label}
            onConfirm={() => void fixAll.start(fixable.map(badMatchFixEntry))}
            outcomes="all"
            maxWidth={440}
          />
        </div>
      </div>
      {matches.length > BAD_MATCH_RENDER_CAP && (
        <p role="status" className="ds-mono" style={{ fontSize: 11, color: "var(--ds-fg-subtle)", marginBottom: 8 }}>
          {t("adminManage.library.diff.renderCap", { cap: BAD_MATCH_RENDER_CAP.toLocaleString(locale), total: matches.length.toLocaleString(locale) })}
        </p>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {matches.slice(0, BAD_MATCH_RENDER_CAP).map((match) => (
          // Server slugs are part of the key: with several servers the same
          // relative path can appear in more than one bad-match pair.
          <BadMatchCard
            key={`${match.plex.serverInstance}:${match.jellyfin.serverInstance}:${match.relativePath}`}
            match={match}
            pending={fixAll.pending}
          />
        ))}
      </div>
    </section>
  );
}

// Client view for the admin library-diff page: searchable/filterable Plex-only, Jellyfin-only, and suspected-bad-match lists with inline fix-match actions.
export function LibraryDiffClient({
  onlyPlex,
  onlyJellyfin,
  badMatches,
  plexConfigured,
  jellyfinConfigured,
  highlightServer,
  highlightKey,
}: {
  onlyPlex:           DiffItem[];
  onlyJellyfin:       DiffItem[];
  badMatches:         ClientBadMatch[];
  plexConfigured:     boolean;
  jellyfinConfigured: boolean;
  highlightServer:    string | null;
  highlightKey:       string | null;
}) {
  const t = useT();
  const [search,        setSearch]        = useState("");
  const [arrFilter,     setArrFilter]     = useState<ArrFilter>("all");
  const [requestFilter, setRequestFilter] = useState<RequestFilter>("all");
  // The bulk Fix all's run lives here, above the section: once it starts, the
  // section stays — the progress and the per-title results must outlive the
  // list emptying, whether the search filters every match out mid-run or the
  // run fixed them all and the refresh brought an empty list.
  const fixAll = useFixAllRun();
  const fixAllStarted = fixAll.started;

  // Typing stays responsive: the lists (up to RENDER_CAP cards a column)
  // follow the deferred query.
  const deferredSearch = useDeferredValue(search);
  const q = deferredSearch.trim().toLowerCase();
  const filteredPlex       = useMemo(() => applyFilters(onlyPlex, q, arrFilter, requestFilter), [onlyPlex, q, arrFilter, requestFilter]);
  const filteredJellyfin   = useMemo(() => applyFilters(onlyJellyfin, q, arrFilter, requestFilter), [onlyJellyfin, q, arrFilter, requestFilter]);
  const filteredBadMatches = useMemo(() => filterBadMatches(badMatches, q), [badMatches, q]);

  const filtersActive = !!search.trim() || arrFilter !== "all" || requestFilter !== "all";

  return (
    <div className="space-y-6">
      <DiffFilters
        search={search}
        onSearch={setSearch}
        arrFilter={arrFilter}
        onArrFilter={setArrFilter}
        requestFilter={requestFilter}
        onToggleRequests={() => setRequestFilter((f) => (f === "all" ? "has_requests" : "all"))}
      />

      {(filteredBadMatches.length > 0 || fixAllStarted) && (
        <BadMatchSection matches={filteredBadMatches} totalBefore={badMatches.length} fixAll={fixAll} />
      )}

      <div className="ds-two-up" style={{ gap: 20 }}>
        <DiffColumn
          label={t("adminManage.library.diff.plexOnly")}
          items={filteredPlex}
          totalBefore={onlyPlex.length}
          configured={plexConfigured}
          otherServer="jellyfin"
          filtersActive={filtersActive}
          server="plex"
          highlightServer={highlightServer}
          highlightKey={highlightKey}
        />
        <DiffColumn
          label={t("adminManage.library.diff.jellyfinOnly")}
          items={filteredJellyfin}
          totalBefore={onlyJellyfin.length}
          configured={jellyfinConfigured}
          otherServer="plex"
          filtersActive={filtersActive}
          server="jellyfin"
          highlightServer={highlightServer}
          highlightKey={highlightKey}
        />
      </div>
    </div>
  );
}
