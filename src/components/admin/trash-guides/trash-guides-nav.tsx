"use client";

import Link from "next/link";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import type { TrashService } from "./types";
import { useT } from "@/components/i18n/i18n-provider";
import { parseTrashService, parseTrashVariant, trashNavQuery } from "./nav-params";

// `labelKey` / `suffixKey` are catalog keys, translated at render. `scope` is
// what a page's view depends on, and so which toggles it shows: the spec tabs
// target one service AND instance; the Overview's KPI strip is service-scoped,
// but its starter pack and KPIs target the default instance by design
// (guardrail 32), so no instance toggle there; Settings depends on neither.
const SUB_PAGES: { labelKey: string; href: string; exact?: boolean; scope: "none" | "service" | "instance" }[] = [
  { labelKey: "trash.nav.overview", href: "/admin/trash-guides", exact: true, scope: "service" },
  { labelKey: "trash.section.customFormats.title", href: "/admin/trash-guides/custom-formats", scope: "instance" },
  { labelKey: "trash.section.qualityProfiles.title", href: "/admin/trash-guides/quality-profiles", scope: "instance" },
  { labelKey: "trash.nav.namingSizes", href: "/admin/trash-guides/naming-sizes", scope: "instance" },
  { labelKey: "trash.nav.settings", href: "/admin/trash-guides/settings", scope: "none" },
];

const SERVICES: { label: string; value: TrashService; suffixKey: string }[] = [
  { label: "Radarr", value: "RADARR", suffixKey: "trash.nav.movies" },
  { label: "Sonarr", value: "SONARR", suffixKey: "trash.nav.tv" },
];

export interface NavInstanceOption {
  slug: string;
  name: string;
}

interface TrashGuidesNavProps {
  radarrConfigured: boolean;
  sonarrConfigured: boolean;
  // Configured instances per service (default first, from the instance registry).
  radarrInstances: NavInstanceOption[];
  sonarrInstances: NavInstanceOption[];
}

function isPageActive(page: (typeof SUB_PAGES)[number], pathname: string) {
  if (page.exact) return pathname === page.href;
  return pathname === page.href || pathname.startsWith(page.href + "/");
}

// Sub-page tabs plus service (Radarr/Sonarr) and instance toggles for the
// trash-guides admin section; toggles drive the ?service= / ?variant= params.
// ?variant= holds an instance slug such as "4k" or a named instance; the
// default instance ("") is selected by leaving the param out.
export function TrashGuidesNav({
  radarrConfigured,
  sonarrConfigured,
  radarrInstances,
  sonarrInstances,
}: TrashGuidesNavProps) {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const currentService = parseTrashService(searchParams.get("service"));
  const configuredInstances = currentService === "RADARR" ? radarrInstances : sonarrInstances;
  // Always offer a Default entry so the user can navigate back to it even when
  // the default connection isn't configured (the page shows its banner there).
  const instanceOptions: NavInstanceOption[] = configuredInstances.some((i) => i.slug === "")
    ? configuredInstances
    : [{ slug: "", name: t("trash.nav.defaultInstance") }, ...configuredInstances];
  // Drop an unknown/unconfigured ?variant= slug — keeps the view coherent.
  const currentVariant = parseTrashVariant(searchParams.get("variant"), instanceOptions);

  // Hide the service/instance toggles on tabs that don't depend on them.
  const scope = SUB_PAGES.find((p) => isPageActive(p, pathname))?.scope ?? "none";
  const showServiceToggle = scope !== "none";
  const showVariantToggle = scope === "instance" && instanceOptions.length > 1;

  // No router.refresh() after a push: every trash-guides page is force-dynamic
  // and awaits searchParams, so a push to a new ?service= / ?variant= URL is
  // already a client-cache miss (dynamic staleTime is 0s) that fetches a fresh
  // server render. A trailing refresh re-rendered the same tree a second time
  // per toggle.
  function pushParams(edit: (params: URLSearchParams) => void) {
    const params = new URLSearchParams(searchParams.toString());
    edit(params);
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  function setService(next: TrashService) {
    pushParams((params) => {
      if (next === "RADARR") params.delete("service");
      else params.set("service", "sonarr");
      // If the destination service doesn't have the selected instance, a lingering
      // ?variant= would be invalid — drop it back to the default.
      const nextInstances = next === "RADARR" ? radarrInstances : sonarrInstances;
      const v = params.get("variant");
      if (v && !nextInstances.some((i) => i.slug === v)) params.delete("variant");
    });
  }

  function setVariant(next: string) {
    pushParams((params) => {
      if (next === "") params.delete("variant");
      else params.set("variant", next);
    });
  }

  // Sub-page links carry the view as read (not the raw params).
  const tabQuery = trashNavQuery(currentService, currentVariant);

  return (
    <div className="mb-6 space-y-3">
      <div className="flex items-center gap-1 border-b border-zinc-800 pb-3 overflow-x-auto">
        {SUB_PAGES.map((page) => {
          const active = isPageActive(page, pathname);
          return (
            <Link
              key={page.href}
              href={`${page.href}${tabQuery}`}
              className={`px-3 py-1.5 text-sm font-medium rounded-md whitespace-nowrap transition-colors ${
                active
                  ? "bg-zinc-700 text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {t(page.labelKey)}
            </Link>
          );
        })}
      </div>

      {showServiceToggle && (
        <div className="flex items-center gap-4 flex-wrap">
          <ToggleGroup label={t("trash.nav.service")}>
            {SERVICES.map((s) => {
              const cfg = s.value === "RADARR" ? radarrConfigured : sonarrConfigured;
              const active = currentService === s.value;
              return (
                <button
                  key={s.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setService(s.value)}
                  className={`px-2.5 py-1 text-xs font-medium transition-colors inline-flex items-center gap-1.5 ${toggleTone(active)}`}
                >
                  <span>
                    {s.label}
                    <span className={active ? "text-[var(--ds-accent-fg)] ml-1" : "text-zinc-500 ml-1"}>· {t(s.suffixKey)}</span>
                  </span>
                  {!cfg && (
                    <span className={`text-[10px] ${active ? "text-[var(--ds-accent-fg)]" : "text-amber-400"}`}>{t("trash.nav.notConfigured")}</span>
                  )}
                </button>
              );
            })}
          </ToggleGroup>

          {showVariantToggle && (
            <ToggleGroup label={t("trash.nav.instance")}>
              {instanceOptions.map((v) => {
                const active = currentVariant === v.slug;
                return (
                  <button
                    key={v.slug || "default"}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setVariant(v.slug)}
                    className={`px-2.5 py-1 text-xs font-medium transition-colors ${toggleTone(active)}`}
                  >
                    {v.name}
                  </button>
                );
              })}
            </ToggleGroup>
          )}
        </div>
      )}
    </div>
  );
}

const toggleTone = (active: boolean) =>
  active ? "bg-indigo-600 text-[var(--ds-accent-fg)]" : "bg-zinc-800 text-zinc-400 hover:text-zinc-100";

function ToggleGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-xs text-zinc-500 mr-1">{label}</span>
      <div className="flex rounded-lg border border-zinc-700 overflow-hidden">{children}</div>
    </div>
  );
}
