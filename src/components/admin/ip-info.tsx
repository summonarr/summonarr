"use client";

import { useRef, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { ChevronDown, Globe, Loader2, MapPin, Network } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";

type Lookup = {
  ip: string;
  hostname: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  postal: string | null;
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;
  org: string | null;
  bogon: boolean;
};

const cache = new Map<string, Lookup | "missing">();

interface Props {
  ip: string;
  /** Render the toggle inline (next to the IP) instead of taking the full row. */
  inline?: boolean;
}

export function IpInfo({ ip, inline = false }: Props) {
  const [open, setOpen] = useState(false);
  // Initialize from cache at mount AND re-read on open: a sibling IpInfo for the
  // same IP may have populated the cache after this instance mounted, in which
  // case the useState initializer would have returned null and `cache.has(ip)`
  // would short-circuit the popover fetch — leaving the popover blank.
  const [data, setData] = useState<Lookup | null>(() => {
    const c = cache.get(ip);
    return c && c !== "missing" ? c : null;
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(() => {
    return cache.get(ip) === "missing" ? "Not available" : null;
  });
  const fetchedRef = useRef(false);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) return;
    // Re-read from cache on every open so a sibling-populated entry is reflected
    // even if this instance's useState initializer saw an empty cache at mount.
    const cached = cache.get(ip);
    if (cached === "missing") {
      setError("Not available");
      return;
    }
    if (cached) {
      setData(cached);
      setError(null);
      return;
    }
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    setLoading(true);
    fetch(withBasePath(`/api/admin/ip-lookup?ip=${encodeURIComponent(ip)}`))
      .then(async (r) => {
        if (!r.ok) {
          cache.set(ip, "missing");
          setError("Not available");
          return;
        }
        const json = (await r.json()) as Lookup;
        cache.set(ip, json);
        setData(json);
      })
      .catch(() => {
        cache.set(ip, "missing");
        setError("Lookup failed");
      })
      .finally(() => setLoading(false));
  }

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger
        className={`${inline ? "inline-flex" : "flex"} items-center gap-1.5 text-zinc-400 hover:text-zinc-200 transition-colors text-sm tabular-nums font-mono outline-none focus-visible:text-zinc-200`}
      >
        <Globe className="w-3.5 h-3.5 text-zinc-500" />
        <span>{ip}</span>
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={6} className="isolate z-50 outline-none">
          <Popover.Popup className="z-50 w-72 max-w-[calc(100vw-1rem)] rounded-md border border-zinc-800 bg-zinc-900/95 backdrop-blur p-3 text-xs shadow-lg ring-1 ring-foreground/10 origin-(--transform-origin) data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 duration-100 outline-none">
            <div className="space-y-2">
              {loading && (
                <div className="flex items-center gap-1.5 text-zinc-400">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Looking up…</span>
                </div>
              )}

              {!loading && error && <div className="text-zinc-500">{error}</div>}

              {!loading && !error && data && data.bogon && (
                <div className="text-zinc-500">Local / private network — no public lookup.</div>
              )}

              {!loading && !error && data && !data.bogon && (
                <>
                  {(data.city || data.region || data.country) && (
                    <div className="flex items-start gap-1.5">
                      <MapPin className="w-3.5 h-3.5 text-zinc-500 mt-0.5 shrink-0" />
                      <div className="text-zinc-300 break-words">
                        {[data.city, data.region, data.country].filter(Boolean).join(", ")}
                        {data.postal && <span className="text-zinc-500"> · {data.postal}</span>}
                      </div>
                    </div>
                  )}
                  {data.org && (
                    <div className="flex items-start gap-1.5">
                      <Network className="w-3.5 h-3.5 text-zinc-500 mt-0.5 shrink-0" />
                      <span className="text-zinc-300 break-words">{data.org}</span>
                    </div>
                  )}
                  {data.hostname && (
                    <div className="text-zinc-500 break-all">Host: {data.hostname}</div>
                  )}
                  {data.timezone && <div className="text-zinc-500">TZ: {data.timezone}</div>}
                  {data.latitude != null && data.longitude != null && (
                    <a
                      href={`https://www.openstreetmap.org/?mlat=${data.latitude}&mlon=${data.longitude}&zoom=10`}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-block text-indigo-400 hover:text-indigo-300 tabular-nums"
                    >
                      {data.latitude.toFixed(3)}, {data.longitude.toFixed(3)} ↗
                    </a>
                  )}
                </>
              )}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
