// Shared relative-time formatter: "just now" / "Xm ago" / "Xh ago" / "Xd ago".
// Pure — it reads Date.now() at call time, so "use client" components must keep
// gating calls behind useHasMounted at the callsite (CLAUDE.md guardrail 16).
export function formatRelativeTime(date: string | number | Date): string {
  const diff = Date.now() - new Date(date).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Variant that falls back to an absolute "Mon D, YYYY" date past 30 days — a
// months-old "142d ago" is less readable than the date itself. Locale is pinned
// to en-US so output never depends on the runtime's locale (guardrail 16); the
// same client-side useHasMounted gating requirement as above still applies.
export function formatRelativeTimeWithDateFallback(date: string | number | Date): string {
  const d = new Date(date);
  const diff = Date.now() - d.getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
