"use client";

// Personal "Wrapped" — a poster-forward, year-in-review canvas built entirely
// from the caller's own PlayHistory (getWrappedForServerUsers). Deliberately
// louder than the My Stats dashboard: a gradient hero, a #1 spotlight, and a
// grid of bold stat cards. Every label is derived deterministically from the
// data props (day/month/hour names from static tables, dates formatted in UTC)
// so there is NO Date.now()/locale drift in the client render path (guardrail
// 16). Screenshot-friendly; no interactivity, so nothing here holds state.

import type { ReactNode } from "react";
import Link from "next/link";
import { Poster, fmtDuration } from "@/components/admin/activity-ui";

export interface WrappedData {
  year: number;
  isCurrentYear: boolean;
  totals: { plays: number; hours: number; titles: number };
  movies: { titles: number; hours: number };
  tv: { shows: number; episodes: number; hours: number };
  topTitles: {
    title: string;
    tmdbId: number | null;
    mediaType: string | null;
    count: number;
    hours: number;
    posterSrc: string | null;
  }[];
  biggestDay: { day: string; plays: number; hours: number } | null;
  busiestMonth: { month: string; plays: number } | null;
  primeDow: number | null;
  primeHour: number | null;
  longestSitting: {
    title: string;
    tmdbId: number | null;
    mediaType: string | null;
    seconds: number;
    startedAt: string;
    posterSrc: string | null;
  } | null;
  completion: { watched: number; total: number };
  topPlatform: string | null;
  topDevice: string | null;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function hourLabel(h: number): string {
  const ampm = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12} ${ampm}`;
}
function partOfDay(h: number): string {
  if (h < 5) return "late nights";
  if (h < 12) return "mornings";
  if (h < 17) return "afternoons";
  if (h < 21) return "evenings";
  return "nights";
}
// 'YYYY-MM-DD' (or full ISO) → "Mar 3", pinned to UTC so SSR and client agree.
function fmtDay(s: string): string {
  const iso = s.length === 10 ? `${s}T00:00:00Z` : s;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
function monthName(ym: string): string {
  const m = parseInt(ym.slice(5, 7), 10);
  return MONTHS[m - 1] ?? ym;
}
function mediaHref(tmdbId: number | null, mediaType: string | null): string | null {
  if (tmdbId == null) return null;
  return mediaType === "TV" ? `/tv/${tmdbId}` : `/movie/${tmdbId}`;
}

// Gradient palette cycled across the stat cards for the "wrapped" vibrancy.
const GRADS = [
  "linear-gradient(135deg, oklch(0.55 0.2 275) 0%, oklch(0.5 0.22 320) 100%)",
  "linear-gradient(135deg, oklch(0.6 0.17 200) 0%, oklch(0.55 0.19 250) 100%)",
  "linear-gradient(135deg, oklch(0.62 0.19 150) 0%, oklch(0.58 0.17 195) 100%)",
  "linear-gradient(135deg, oklch(0.68 0.18 60) 0%, oklch(0.62 0.2 35) 100%)",
  "linear-gradient(135deg, oklch(0.62 0.2 350) 0%, oklch(0.55 0.21 300) 100%)",
  "linear-gradient(135deg, oklch(0.6 0.16 240) 0%, oklch(0.56 0.18 285) 100%)",
];

function StatCard({ grad, kicker, value, sub }: { grad: string; kicker: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div style={{ background: grad, borderRadius: 14, padding: "18px 18px 20px", color: "#fff", minHeight: 128, display: "flex", flexDirection: "column", justifyContent: "space-between", boxShadow: "0 1px 3px rgba(0,0,0,0.25)" }}>
      <div className="ds-mono uppercase" style={{ fontSize: 10, letterSpacing: "0.1em", opacity: 0.85 }}>{kicker}</div>
      <div>
        <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.1 }}>{value}</div>
        {sub && <div style={{ fontSize: 12, opacity: 0.9, marginTop: 4 }}>{sub}</div>}
      </div>
    </div>
  );
}

export function WrappedView({ data: w }: { data: WrappedData }) {
  const top = w.topTitles[0];
  const heroHref = top ? mediaHref(top.tmdbId, top.mediaType) : null;

  const primeLine =
    w.primeDow != null
      ? `${DAYS[w.primeDow]} ${w.primeHour != null ? partOfDay(w.primeHour) : ""}`.trim()
      : w.primeHour != null
        ? `${partOfDay(w.primeHour)}`
        : "—";

  const cards: { kicker: string; value: ReactNode; sub?: ReactNode }[] = [];
  cards.push({
    kicker: "Movies vs TV",
    value: `${w.movies.titles} · ${w.tv.episodes}`,
    sub: `${w.movies.titles} movies · ${w.tv.episodes} episodes (${w.tv.shows} shows)`,
  });
  if (w.biggestDay) {
    cards.push({
      kicker: "Biggest binge",
      value: fmtDay(w.biggestDay.day),
      sub: `${w.biggestDay.plays} plays · ${w.biggestDay.hours}h in one day`,
    });
  }
  if (w.primeDow != null || w.primeHour != null) {
    cards.push({
      kicker: "Prime time",
      value: primeLine,
      sub: w.primeHour != null ? `peak around ${hourLabel(w.primeHour)}` : undefined,
    });
  }
  if (w.longestSitting) {
    cards.push({
      kicker: "Longest sitting",
      value: fmtDuration(w.longestSitting.seconds),
      sub: w.longestSitting.title,
    });
  }
  if (w.completion.total > 0) {
    cards.push({
      kicker: "Finish rate",
      value: `${Math.round((w.completion.watched / w.completion.total) * 100)}%`,
      sub: `saw ${w.completion.watched} of ${w.completion.total} plays through`,
    });
  }
  if (w.busiestMonth) {
    cards.push({ kicker: "Busiest month", value: monthName(w.busiestMonth.month), sub: `${w.busiestMonth.plays} plays` });
  }
  if (w.topDevice || w.topPlatform) {
    cards.push({ kicker: "Go-to screen", value: w.topDevice ?? w.topPlatform!, sub: w.topDevice && w.topPlatform ? `on ${w.topPlatform}` : undefined });
  }

  return (
    <div className="ds-page-enter" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Hero */}
      <div
        style={{
          background: "linear-gradient(135deg, oklch(0.5 0.22 285) 0%, oklch(0.52 0.22 330) 55%, oklch(0.6 0.2 25) 100%)",
          borderRadius: 18,
          padding: "30px 26px",
          color: "#fff",
          boxShadow: "0 2px 10px rgba(0,0,0,0.3)",
        }}
      >
        <div className="ds-mono uppercase" style={{ fontSize: 11, letterSpacing: "0.16em", opacity: 0.85 }}>
          {w.isCurrentYear ? `${w.year} so far` : `${w.year} in review`}
        </div>
        <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-0.03em", marginTop: 6, marginBottom: 20 }}>
          Your Year in Review
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 16 }}>
          {[
            { n: w.totals.hours.toLocaleString("en-US"), l: "hours watched" },
            { n: w.totals.plays.toLocaleString("en-US"), l: "plays" },
            { n: w.totals.titles.toLocaleString("en-US"), l: "titles" },
          ].map((s) => (
            <div key={s.l}>
              <div style={{ fontSize: 38, fontWeight: 800, letterSpacing: "-0.03em", lineHeight: 1 }}>{s.n}</div>
              <div className="ds-mono uppercase" style={{ fontSize: 10.5, letterSpacing: "0.1em", opacity: 0.85, marginTop: 6 }}>{s.l}</div>
            </div>
          ))}
        </div>
      </div>

      {/* #1 spotlight */}
      {top && (
        <div style={{ display: "flex", gap: 18, alignItems: "center", background: "var(--ds-bg-2)", border: "1px solid var(--ds-border)", borderRadius: 14, padding: 18 }}>
          <Poster src={top.posterSrc} letter={(top.title[0] ?? "?").toUpperCase()} w={70} h={104} radius={6} />
          <div style={{ minWidth: 0 }}>
            <div className="ds-mono uppercase" style={{ fontSize: 10.5, letterSpacing: "0.12em", color: "var(--ds-accent)" }}>Your #1 this year</div>
            <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em", color: "var(--ds-fg)", margin: "4px 0 6px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {heroHref ? (
                <Link href={heroHref} style={{ color: "inherit", textDecoration: "none" }}>{top.title}</Link>
              ) : (
                top.title
              )}
            </div>
            <div className="ds-mono" style={{ fontSize: 12.5, color: "var(--ds-fg-subtle)" }}>
              {top.count} {top.count === 1 ? "play" : "plays"} · {top.hours}h watched
            </div>
          </div>
        </div>
      )}

      {/* Stat cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
        {cards.map((c, i) => (
          <StatCard key={c.kicker} grad={GRADS[i % GRADS.length]} kicker={c.kicker} value={c.value} sub={c.sub} />
        ))}
      </div>

      {/* Top 5 */}
      {w.topTitles.length > 0 && (
        <div style={{ background: "var(--ds-bg-2)", border: "1px solid var(--ds-border)", borderRadius: 14, padding: 18 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ds-fg)", marginBottom: 14 }}>
            Your top {w.topTitles.length} of {w.year}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {w.topTitles.map((t, i) => {
              const href = mediaHref(t.tmdbId, t.mediaType);
              return (
                <div key={`${t.title}-${i}`} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span className="ds-mono" style={{ width: 20, textAlign: "right", fontSize: 15, fontWeight: 700, color: "var(--ds-accent)" }}>{i + 1}</span>
                  <Poster src={t.posterSrc} letter={(t.title[0] ?? "?").toUpperCase()} w={32} h={46} radius={4} />
                  <div style={{ flex: 1, minWidth: 0, display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
                    {href ? (
                      <Link href={href} style={{ fontSize: 14, color: "var(--ds-fg)", textDecoration: "none", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.title}</Link>
                    ) : (
                      <span style={{ fontSize: 14, color: "var(--ds-fg)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.title}</span>
                    )}
                    <span className="ds-mono" style={{ fontSize: 12, color: "var(--ds-fg-subtle)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                      {t.count} {t.count === 1 ? "play" : "plays"}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="ds-mono" style={{ fontSize: 11, color: "var(--ds-fg-disabled)", textAlign: "center", paddingBottom: 4 }}>
        Summonarr · Year in Review — screenshot to share
      </div>
    </div>
  );
}
