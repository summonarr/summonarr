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
