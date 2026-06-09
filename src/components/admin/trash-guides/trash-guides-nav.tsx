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

type Variant = "hd" | "4k";

const VARIANTS: { label: string; value: Variant }[] = [
  { label: "HD", value: "hd" },
  { label: "4K", value: "4k" },
];

interface TrashGuidesNavProps {
  radarrConfigured: boolean;
  sonarrConfigured: boolean;
  radarr4kConfigured: boolean;
  sonarr4kConfigured: boolean;
}

export function TrashGuidesNav({
  radarrConfigured,
  sonarrConfigured,
  radarr4kConfigured,
  sonarr4kConfigured,
}: TrashGuidesNavProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const rawService = searchParams.get("service");
  const currentService: TrashService = rawService === "sonarr"
    ? "SONARR"
    : "RADARR";

  const current4kConfigured = currentService === "RADARR" ? radarr4kConfigured : sonarr4kConfigured;
  const rawVariant = searchParams.get("variant");
  // Drop ?variant=4k when the active service has no 4K instance — keeps the view coherent.
  const currentVariant: Variant = rawVariant === "4k" && current4kConfigured ? "4k" : "hd";

  // Hide the service/variant toggles on tabs that don't depend on them.
  const showServiceToggle =
    pathname.startsWith("/admin/trash-guides/custom-formats") ||
    pathname.startsWith("/admin/trash-guides/quality-profiles") ||
    pathname.startsWith("/admin/trash-guides/naming-sizes");
  const showVariantToggle = showServiceToggle && current4kConfigured;

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
    // If the destination service has no 4K instance, a lingering ?variant=4k would be invalid.
    const next4kConfigured = next === "RADARR" ? radarr4kConfigured : sonarr4kConfigured;
    if (!next4kConfigured) params.delete("variant");
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
    router.refresh();
  }

  function setVariant(next: Variant) {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "hd") {
      params.delete("variant");
    } else {
      params.set("variant", "4k");
    }
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
    router.refresh();
  }

  // Build sub-page links so they preserve the current ?service= and ?variant= params.
  const queryWithParams = (() => {
    const params = new URLSearchParams();
    if (rawService) params.set("service", rawService);
    if (currentVariant === "4k") params.set("variant", "4k");
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
                {VARIANTS.map((v) => {
                  const active = currentVariant === v.value;
                  return (
                    <button
                      key={v.value}
                      onClick={() => setVariant(v.value)}
                      className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                        active
                          ? "bg-indigo-600 text-white"
                          : "bg-zinc-800 text-zinc-400 hover:text-white"
                      }`}
                    >
                      {v.label}
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
