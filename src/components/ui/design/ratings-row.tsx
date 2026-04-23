import { cn } from "@/lib/utils";

export type RatingInput = { id?: number | string; score?: number | null };
export type RatingKey = "imdb" | "rt" | "mc" | "trakt";

export type ComputedRatings = {
  imdb: string;
  rt: string;
  mc: string;
  trakt: string;
  rtFresh: boolean;
};

/**
 * Derives deterministic cross-source ratings from a TMDB-style score.
 * Exists so the UI can render a consistent IMDb/RT/MC/Trakt row before a
 * real ratings aggregator is wired up — callers should pass authoritative
 * values (once available) instead of this derived shape.
 */
export function ratingsFor(m: RatingInput): ComputedRatings {
  const s = m.score ?? 7.5;
  const idPart =
    typeof m.id === "number" ? m.id : Number.parseInt(String(m.id ?? 0), 10) || 0;
  const seed = idPart * 13 + Math.round(s * 10);
  const jitter = (n: number) => ((seed + n * 97) % 11) - 5;
  const clamp = (v: number, lo: number, hi: number) =>
    Math.max(lo, Math.min(hi, v));

  const imdb = clamp(s + jitter(1) / 10, 1, 9.9);
  const rt = clamp(Math.round(s * 10 + jitter(2) * 2), 20, 99);
  const mc = clamp(Math.round(s * 9 + jitter(3) * 2), 30, 98);
  const trakt = clamp(Math.round(s * 10 + jitter(4) * 1.5), 40, 98);

  return {
    imdb: imdb.toFixed(1),
    rt: `${rt}%`,
    mc: String(mc),
    trakt: `${trakt}%`,
    rtFresh: rt >= 60,
  };
}

function ImdbGlyph() {
  return (
    <span
      className="ds-mono"
      style={{
        fontSize: 8.5,
        fontWeight: 800,
        letterSpacing: "-0.02em",
        background: "#f5c518",
        color: "#000",
        padding: "1px 3px",
        borderRadius: 2,
        lineHeight: 1,
      }}
    >
      IMDb
    </span>
  );
}

function McGlyph() {
  return (
    <span
      className="ds-mono"
      style={{
        fontSize: 8.5,
        fontWeight: 800,
        background: "#00ce7a",
        color: "#000",
        padding: "1px 3px",
        borderRadius: 2,
        lineHeight: 1,
      }}
    >
      M
    </span>
  );
}

function TraktGlyph() {
  return (
    <span
      aria-hidden
      style={{
        width: 10,
        height: 10,
        borderRadius: 2,
        background: "#ed1c24",
        display: "inline-block",
      }}
    />
  );
}

export function RatingsRow({
  m,
  size = "sm",
  variant = "mono",
  only,
  className,
}: {
  m: RatingInput;
  size?: "xs" | "sm" | "md";
  variant?: "mono" | "chip";
  only?: readonly RatingKey[];
  className?: string;
}) {
  const r = ratingsFor(m);
  const fs = size === "xs" ? 10 : size === "md" ? 13 : 11.5;
  const gap = size === "xs" ? 8 : size === "md" ? 14 : 10;

  const sources = (
    [
      {
        key: "imdb" as const,
        label: "IMDb",
        value: r.imdb,
        glyph: <ImdbGlyph />,
        color: "#f5c518",
      },
      {
        key: "rt" as const,
        label: "Rotten Tomatoes",
        value: r.rt,
        glyph: r.rtFresh ? (
          <span aria-hidden style={{ fontSize: 13, lineHeight: 1 }}>🍅</span>
        ) : (
          <span aria-hidden style={{ fontSize: 13, lineHeight: 1 }}>🟢</span>
        ),
        color: r.rtFresh ? "oklch(0.72 0.17 30)" : "oklch(0.68 0.14 140)",
      },
      {
        key: "mc" as const,
        label: "Metacritic",
        value: r.mc,
        glyph: <McGlyph />,
        color: "var(--ds-success)",
      },
      {
        key: "trakt" as const,
        label: "Trakt",
        value: r.trakt,
        glyph: <TraktGlyph />,
        color: "var(--ds-accent)",
      },
    ] as const
  ).filter((s) => !only || only.includes(s.key));

  if (variant === "chip") {
    return (
      <div className={cn("flex flex-wrap", className)} style={{ gap: 6 }}>
        {sources.map((s) => (
          <div
            key={s.key}
            title={`${s.label}: ${s.value}`}
            className="inline-flex items-center"
            style={{
              gap: 5,
              background: "var(--ds-bg-2)",
              border: "1px solid var(--ds-border)",
              borderRadius: 4,
              padding: size === "xs" ? "2px 5px" : "3px 7px",
            }}
          >
            {s.glyph}
            <span
              className="ds-mono"
              style={{
                fontSize: fs - 1,
                fontWeight: 600,
                color: "var(--ds-fg)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {s.value}
            </span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div
      className={cn("flex flex-wrap items-center", className)}
      style={{ gap }}
    >
      {sources.map((s) => (
        <div
          key={s.key}
          title={`${s.label}: ${s.value}`}
          className="inline-flex items-center"
          style={{ gap: 5 }}
        >
          {s.glyph}
          <span
            className="ds-mono"
            style={{
              fontSize: fs,
              fontWeight: 600,
              color: s.color,
              fontVariantNumeric: "tabular-nums",
              letterSpacing: "-0.01em",
            }}
          >
            {s.value}
          </span>
        </div>
      ))}
    </div>
  );
}
