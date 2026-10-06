import type { Translator } from "@/lib/i18n/translate";

// "1–36 of 200" beside a ranked section's title — the ONE range label both
// ranked grids (/popular, /top) render. Each page used to carry its own copy,
// each commenting that it matched the other, and the two had already drifted
// ("… of 200 titles" vs "… of 200"). No hooks, so server components render it
// directly; the caller passes its request translator.
export function RangeLabel({
  t,
  from,
  to,
  total,
}: {
  t: Translator;
  from: number;
  to: number;
  total: number;
}) {
  return (
    <span
      className="ds-mono uppercase"
      style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)", letterSpacing: "0.06em" }}
    >
      {t("browse.rangeOf", { from, to, total })}
    </span>
  );
}
