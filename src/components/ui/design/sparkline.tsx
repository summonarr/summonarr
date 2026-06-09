export function Sparkline({
  data,
  color,
  height = 32,
  fill,
}: {
  data: readonly number[];
  color?: string;
  height?: number;
  fill?: boolean;
}) {
  if (data.length < 2) return null;
  const w = 160;
  const h = height;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const rng = Math.max(1, max - min);
  const pts: [number, number][] = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / rng) * (h - 2) - 1;
    return [x, y];
  });
  const path = pts
    .map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`)
    .join(" ");
  const area = `${path} L ${w} ${h} L 0 ${h} Z`;
  const stroke = color ?? "var(--ds-accent)";
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      width="100%"
      height={h}
      preserveAspectRatio="none"
    >
      {fill && <path d={area} fill={stroke} opacity="0.14" />}
      <path d={path} stroke={stroke} strokeWidth={1.5} fill="none" />
    </svg>
  );
}
