// "Open in Radarr / Sonarr" — a plain link (no hooks), so server pages and
// client tables render the same element. It always points at
// /api/admin/arr/open, which resolves the title on click and redirects to the
// instance's own web UI (its External URL, else its connection URL). ADMIN-only
// on the server; callers render it only for admins so nobody gets a dead link.
import { ExternalLink } from "@/components/icons";
import { arrOpenHref, type ArrLinkService } from "@/lib/arr-links";
import { withBasePath } from "@/lib/base-path";

export function OpenInArrLink({
  service,
  instance,
  target,
  label,
  iconOnly = false,
}: {
  service: ArrLinkService;
  instance: string;
  target: { tmdbId: number } | { arrId: number };
  /** Already translated: "Open in Radarr" / "Open in Sonarr (4K)". */
  label: string;
  /** A bare icon for dense tables; the label becomes its accessible name. */
  iconOnly?: boolean;
}) {
  return (
    <a
      href={withBasePath(arrOpenHref(service, instance, target))}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={iconOnly ? label : undefined}
      title={label}
      className={
        iconOnly
          ? "inline-flex items-center justify-center rounded p-1 text-zinc-500 hover:text-zinc-100 transition-colors"
          : "ds-hover-tint inline-flex items-center gap-1.5 rounded-md text-zinc-400 hover:text-zinc-100 transition-colors"
      }
      style={
        iconOnly
          ? undefined
          : { fontSize: 12, padding: "5px 10px", border: "1px solid var(--ds-border)", background: "var(--ds-bg-2)" }
      }
    >
      <ExternalLink style={{ width: iconOnly ? 13 : 12, height: iconOnly ? 13 : 12 }} aria-hidden />
      {!iconOnly && label}
    </a>
  );
}

/** "Radarr", "Radarr (4K)" — the default instance carries no suffix. */
export function arrInstanceLabel(service: ArrLinkService, instanceName: string | null | undefined, slug: string): string {
  const base = service === "radarr" ? "Radarr" : "Sonarr";
  if (slug === "") return base;
  return `${base} (${instanceName || slug})`;
}
