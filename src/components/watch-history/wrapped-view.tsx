"use client";

// Personal "Wrapped" — a poster-forward, year-in-review canvas built entirely
// from the caller's own PlayHistory (getWrappedForServerUsers). Deliberately
// louder than the My Stats dashboard: a gradient hero, a #1 spotlight, and a
// grid of bold stat cards. Every label is derived deterministically from the
// data props (day/month/hour names via Intl in the ACTIVE UI locale — the same
// value on the server and the client — and dates formatted in UTC) so there is
// NO Date.now()/locale drift in the client render path (guardrail 16). Screenshot-friendly; no interactivity, so nothing here holds state.

import type { ReactNode } from "react";
import Link from "next/link";
import { Poster, fmtDuration } from "@/components/admin/activity-ui";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import type { Translator } from "@/lib/i18n/translate";

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

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// 0=Sunday..6=Saturday. 2023-01-01 was a Sunday; UTC-pinned so every runtime agrees.
function dayName(dow: number, locale: string): string {
  return capitalize(
    new Date(Date.UTC(2023, 0, 1 + dow)).toLocaleDateString(locale, { weekday: "long", timeZone: "UTC" }),
  );
}
function hourLabel(h: number, locale: string): string {
  if (locale === "en") {
    const ampm = h < 12 ? "AM" : "PM";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12} ${ampm}`;
  }
  return new Date(Date.UTC(2023, 0, 1, h)).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
  });
}
function partOfDay(h: number, t: Translator): string {
  if (h < 5) return t("personal.wrapped.part.lateNights");
  if (h < 12) return t("personal.wrapped.part.mornings");
  if (h < 17) return t("personal.wrapped.part.afternoons");
  if (h < 21) return t("personal.wrapped.part.evenings");
  return t("personal.wrapped.part.nights");
}
// 'YYYY-MM-DD' (or full ISO) → "Mar 3", pinned to UTC so SSR and client agree.
function fmtDay(s: string, locale: string): string {
  const iso = s.length === 10 ? `${s}T00:00:00Z` : s;
  return new Date(iso).toLocaleDateString(locale, { month: "short", day: "numeric", timeZone: "UTC" });
}
function monthName(ym: string, locale: string): string {
  const m = parseInt(ym.slice(5, 7), 10);
  if (!(m >= 1 && m <= 12)) return ym;
  return capitalize(new Date(Date.UTC(2023, m - 1, 1)).toLocaleDateString(locale, { month: "short", timeZone: "UTC" }));
}
function mediaHref(tmdbId: number | null, mediaType: string | null): string | null {
  if (tmdbId == null) return null;
  return mediaType === "TV" ? `/tv/${tmdbId}` : `/movie/${tmdbId}`;
}

// Gradient palette cycled across the stat cards for the "wrapped" vibrancy.
// Every stop sits at L ≤ .54 so the tile's white 10px kicker (opacity .85)
// clears 4.5:1 on each end of the gradient (worst stop 4.52:1).
const GRADS = [
  "linear-gradient(135deg, oklch(0.53 0.2 275) 0%, oklch(0.5 0.22 320) 100%)",
  "linear-gradient(135deg, oklch(0.47 0.11 200) 0%, oklch(0.5 0.15 250) 100%)",
  "linear-gradient(135deg, oklch(0.48 0.14 150) 0%, oklch(0.46 0.1 195) 100%)",
  "linear-gradient(135deg, oklch(0.52 0.12 60) 0%, oklch(0.53 0.18 35) 100%)",
  "linear-gradient(135deg, oklch(0.53 0.2 350) 0%, oklch(0.54 0.21 300) 100%)",
  "linear-gradient(135deg, oklch(0.5 0.14 240) 0%, oklch(0.53 0.18 285) 100%)",
];

// Named WrappedStat (not StatCard) so it can't be confused with the design
// system's StatCard — this one is the gradient "wrapped" tile.
function WrappedStat({ grad, kicker, value, sub }: { grad: string; kicker: string; value: ReactNode; sub?: ReactNode }) {
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
  const t = useT();
  const locale = useLocale();
  const top = w.topTitles[0];
  const heroHref = top ? mediaHref(top.tmdbId, top.mediaType) : null;

  const primeLine =
    w.primeDow != null
      ? w.primeHour != null
        ? t("personal.wrapped.primeLine", { day: dayName(w.primeDow, locale), part: partOfDay(w.primeHour, t) })
        : dayName(w.primeDow, locale)
      : w.primeHour != null
        ? capitalize(partOfDay(w.primeHour, t))
        : "—";

  const cards: { kicker: string; value: ReactNode; sub?: ReactNode }[] = [];
  cards.push({
    kicker: t("personal.wrapped.moviesVsTv"),
    value: `${w.movies.titles} · ${w.tv.episodes}`,
    sub: t("personal.wrapped.moviesVsTvSub", {
      movies: w.movies.titles,
      episodes: w.tv.episodes,
      shows: w.tv.shows,
    }),
  });
  if (w.biggestDay) {
    cards.push({
      kicker: t("personal.wrapped.biggestBinge"),
      value: fmtDay(w.biggestDay.day, locale),
      sub: t("personal.wrapped.biggestBingeSub", { plays: w.biggestDay.plays, hours: w.biggestDay.hours }),
    });
  }
  if (w.primeDow != null || w.primeHour != null) {
    cards.push({
      kicker: t("personal.wrapped.primeTime"),
      value: primeLine,
      sub: w.primeHour != null ? t("personal.wrapped.peakAround", { hour: hourLabel(w.primeHour, locale) }) : undefined,
    });
  }
  if (w.longestSitting) {
    cards.push({
      kicker: t("personal.wrapped.longestSitting"),
      value: fmtDuration(w.longestSitting.seconds),
      sub: w.longestSitting.title,
    });
  }
  if (w.completion.total > 0) {
    cards.push({
      kicker: t("personal.wrapped.finishRate"),
      value: `${Math.round((w.completion.watched / w.completion.total) * 100)}%`,
      sub: t("personal.wrapped.finishRateSub", { watched: w.completion.watched, total: w.completion.total }),
    });
  }
  if (w.busiestMonth) {
    cards.push({
      kicker: t("personal.wrapped.busiestMonth"),
      value: monthName(w.busiestMonth.month, locale),
      sub: t("personal.wrapped.playsCount", { count: w.busiestMonth.plays }),
    });
  }
  if (w.topDevice || w.topPlatform) {
    cards.push({
      kicker: t("personal.wrapped.goToScreen"),
      value: w.topDevice ?? w.topPlatform!,
      sub: w.topDevice && w.topPlatform ? t("personal.wrapped.onPlatform", { platform: w.topPlatform }) : undefined,
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Hero */}
      <div
        style={{
          background: "linear-gradient(135deg, oklch(0.5 0.22 285) 0%, oklch(0.52 0.22 330) 55%, oklch(0.53 0.2 25) 100%)",
          borderRadius: 18,
          padding: "30px 26px",
          color: "#fff",
          boxShadow: "0 2px 10px rgba(0,0,0,0.3)",
        }}
      >
        <div className="ds-mono uppercase" style={{ fontSize: 11, letterSpacing: "0.16em", opacity: 0.85 }}>
          {w.isCurrentYear
            ? t("personal.wrapped.soFar", { year: w.year })
            : t("personal.wrapped.inReview", { year: w.year })}
        </div>
        <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-0.03em", marginTop: 6, marginBottom: 20 }}>
          {t("personal.wrapped.heading")}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 16 }}>
          {[
            { n: w.totals.hours.toLocaleString(locale), l: t("personal.wrapped.hoursWatched") },
            { n: w.totals.plays.toLocaleString(locale), l: t("personal.wrapped.plays") },
            { n: w.totals.titles.toLocaleString(locale), l: t("personal.wrapped.titles") },
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
            <div className="ds-mono uppercase" style={{ fontSize: 10.5, letterSpacing: "0.12em", color: "var(--ds-accent-text)" }}>{t("personal.wrapped.number1")}</div>
            <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em", color: "var(--ds-fg)", margin: "4px 0 6px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {heroHref ? (
                <Link href={heroHref} className="hover:underline" style={{ color: "inherit", textDecoration: "none" }}>{top.title}</Link>
              ) : (
                top.title
              )}
            </div>
            <div className="ds-mono" style={{ fontSize: 12.5, color: "var(--ds-fg-subtle)" }}>
              {t("personal.wrapped.topSummary", { count: top.count, hours: top.hours })}
            </div>
          </div>
        </div>
      )}

      {/* Stat cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
        {cards.map((c, i) => (
          <WrappedStat key={c.kicker} grad={GRADS[i % GRADS.length]} kicker={c.kicker} value={c.value} sub={c.sub} />
        ))}
      </div>

      {/* Top titles list */}
      {w.topTitles.length > 0 && (
        <div style={{ background: "var(--ds-bg-2)", border: "1px solid var(--ds-border)", borderRadius: 14, padding: 18 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ds-fg)", marginBottom: 14 }}>
            {t("personal.wrapped.topList", { count: w.topTitles.length, year: w.year })}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {w.topTitles.map((item, i) => {
              const href = mediaHref(item.tmdbId, item.mediaType);
              return (
                <div key={`${item.title}-${i}`} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span className="ds-mono" style={{ width: 20, textAlign: "right", fontSize: 15, fontWeight: 700, color: "var(--ds-accent-text)" }}>{i + 1}</span>
                  <Poster src={item.posterSrc} letter={(item.title[0] ?? "?").toUpperCase()} w={32} h={46} radius={4} />
                  <div style={{ flex: 1, minWidth: 0, display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
                    {href ? (
                      <Link href={href} className="hover:underline" style={{ fontSize: 14, color: "var(--ds-fg)", textDecoration: "none", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.title}</Link>
                    ) : (
                      <span style={{ fontSize: 14, color: "var(--ds-fg)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.title}</span>
                    )}
                    <span className="ds-mono" style={{ fontSize: 12, color: "var(--ds-fg-subtle)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                      {t("personal.wrapped.playsCount", { count: item.count })}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="ds-mono" style={{ fontSize: 11, color: "var(--ds-fg-disabled)", textAlign: "center", paddingBottom: 4 }}>
        {t("personal.wrapped.footer")}
      </div>
    </div>
  );
}
