"use client";

import Link from "next/link";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import type { TrashService } from "./types";

const SUB_PAGES = [
  { label: "Overview", href: "/admin/trash-guides", exact: true },
  { label: "Custom Formats", href: "/admin/trash-guides/custom-formats" },
  { label: "Quality Profiles", href: "/admin/trash-guides/quality-profiles" },
  { label: "Naming & Sizes", href: "/admin/trash-guides/naming-sizes" },
  { label: "Settings", href: "/admin/trash-guides/settings" },
];

const SERVICES: { label: string; value: TrashService; suffix: string }[] = [
  { label: "Radarr", value: "RADARR", suffix: "Movies" },
  { label: "Sonarr", value: "SONARR", suffix: "TV" },
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

// Sub-page tabs plus service (Radarr/Sonarr) and instance toggles for the
// trash-guides admin section; toggles drive the ?service= / ?variant= params.
// ?variant= carries an instance SLUG ("" default via param absence, "4k", named).
export function TrashGuidesNav({
  radarrConfigured,
  sonarrConfigured,
  radarrInstances,
  sonarrInstances,
}: TrashGuidesNavProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const rawService = searchParams.get("service");
  const currentService: TrashService = rawService === "sonarr"
    ? "SONARR"
    : "RADARR";

  const configuredInstances = currentService === "RADARR" ? radarrInstances : sonarrInstances;
  // Always offer a Default entry so the user can navigate back to it even when
  // the default connection isn't configured (the page shows its banner there).
  const instanceOptions: NavInstanceOption[] = configuredInstances.some((i) => i.slug === "")
    ? configuredInstances
    : [{ slug: "", name: "Default" }, ...configuredInstances];

  const rawVariant = searchParams.get("variant");
  // Drop an unknown/unconfigured ?variant= slug — keeps the view coherent.
  const currentVariant =
    rawVariant && instanceOptions.some((i) => i.slug === rawVariant) ? rawVariant : "";

  // Hide the service/instance toggles on tabs that don't depend on them.
  const showServiceToggle =
    pathname.startsWith("/admin/trash-guides/custom-formats") ||
    pathname.startsWith("/admin/trash-guides/quality-profiles") ||
    pathname.startsWith("/admin/trash-guides/naming-sizes");
  const showVariantToggle = showServiceToggle && instanceOptions.length > 1;

  function isPageActive(page: typeof SUB_PAGES[0]) {
    if (page.exact) return pathname === page.href;
    return pathname === page.href || pathname.startsWith(page.href + "/");
  }

  function setService(next: TrashService) {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "RADARR") {
      params.delete("service");
    } else {
      params.set("service", "sonarr");
    }
    // If the destination service doesn't have the selected instance, a lingering
    // ?variant= would be invalid — drop it back to the default.
    const nextInstances = next === "RADARR" ? radarrInstances : sonarrInstances;
    const v = params.get("variant");
    if (v && !nextInstances.some((i) => i.slug === v)) params.delete("variant");
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
    router.refresh();
  }

  function setVariant(next: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "") {
      params.delete("variant");
    } else {
      params.set("variant", next);
    }
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
    router.refresh();
  }

  // Build sub-page links so they preserve the current ?service= and ?variant= params.
  const queryWithParams = (() => {
    const params = new URLSearchParams();
    if (rawService) params.set("service", rawService);
    if (currentVariant !== "") params.set("variant", currentVariant);
    const qs = params.toString();
    return qs ? `?${qs}` : "";
  })();

  return (
    <div className="mb-6 space-y-3">
      <div className="flex items-center gap-1 border-b border-zinc-800 pb-3 overflow-x-auto">
        {SUB_PAGES.map((page) => {
          const active = isPageActive(page);
          return (
            <Link
              key={page.label}
              href={`${page.href}${queryWithParams}`}
              className={`px-3 py-1.5 text-sm font-medium rounded-md whitespace-nowrap transition-colors ${
                active
                  ? "bg-zinc-800 text-white"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {page.label}
            </Link>
          );
        })}
      </div>

      {showServiceToggle && (
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-1">
            <span className="text-xs text-zinc-500 mr-1">Service</span>
            <div className="flex rounded-lg border border-zinc-700 overflow-hidden">
              {SERVICES.map((s) => {
                const cfg = s.value === "RADARR" ? radarrConfigured : sonarrConfigured;
                const active = currentService === s.value;
                return (
                  <button
                    key={s.value}
                    onClick={() => setService(s.value)}
                    className={`px-2.5 py-1 text-xs font-medium transition-colors inline-flex items-center gap-1.5 ${
                      active
                        ? "bg-indigo-600 text-white"
                        : "bg-zinc-800 text-zinc-400 hover:text-white"
                    }`}
                  >
                    <span>
                      {s.label}
                      <span className={active ? "text-indigo-100/80 ml-1" : "text-zinc-500 ml-1"}>· {s.suffix}</span>
                    </span>
                    {!cfg && (
                      <span className="text-[10px] text-amber-300/80">(not configured)</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {showVariantToggle && (
            <div className="flex items-center gap-1">
              <span className="text-xs text-zinc-500 mr-1">Instance</span>
              <div className="flex rounded-lg border border-zinc-700 overflow-hidden">
                {instanceOptions.map((v) => {
                  const active = currentVariant === v.slug;
                  return (
                    <button
                      key={v.slug || "default"}
                      onClick={() => setVariant(v.slug)}
                      className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                        active
                          ? "bg-indigo-600 text-white"
                          : "bg-zinc-800 text-zinc-400 hover:text-white"
                      }`}
                    >
                      {v.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
