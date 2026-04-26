"use client";

import { useRef, useState } from "react";
import { ChevronDown, Globe, Loader2, MapPin, Network } from "lucide-react";

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
  const [data, setData] = useState<Lookup | null>(() => {
    const c = cache.get(ip);
    return c && c !== "missing" ? c : null;
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(() => {
    return cache.get(ip) === "missing" ? "Not available" : null;
  });
  const fetchedRef = useRef(false);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (!next || fetchedRef.current || cache.has(ip)) return;
    fetchedRef.current = true;
    setLoading(true);
    fetch(`/api/admin/ip-lookup?ip=${encodeURIComponent(ip)}`)
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
    <div className={inline ? "inline-flex flex-col" : "w-full"}>
      <button
        type="button"
        onClick={toggle}
        className="inline-flex items-center gap-1.5 text-zinc-400 hover:text-zinc-200 transition-colors text-sm tabular-nums font-mono"
        aria-expanded={open}
      >
        <Globe className="w-3.5 h-3.5 text-zinc-500" />
        <span>{ip}</span>
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="mt-2 rounded-md border border-zinc-800 bg-zinc-900/60 p-3 text-xs space-y-2 max-w-xs">
          {loading && (
            <div className="flex items-center gap-1.5 text-zinc-400">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>Looking up…</span>
            </div>
          )}

          {!loading && error && (
            <div className="text-zinc-500">{error}</div>
          )}

          {!loading && !error && data && data.bogon && (
            <div className="text-zinc-500">Local / private network — no public lookup.</div>
          )}

          {!loading && !error && data && !data.bogon && (
            <>
              {(data.city || data.region || data.country) && (
                <div className="flex items-start gap-1.5">
                  <MapPin className="w-3.5 h-3.5 text-zinc-500 mt-0.5 shrink-0" />
                  <div className="text-zinc-300">
                    {[data.city, data.region, data.country].filter(Boolean).join(", ")}
                    {data.postal && <span className="text-zinc-500"> · {data.postal}</span>}
                  </div>
                </div>
              )}
              {data.org && (
                <div className="flex items-start gap-1.5">
                  <Network className="w-3.5 h-3.5 text-zinc-500 mt-0.5 shrink-0" />
                  <span className="text-zinc-300">{data.org}</span>
                </div>
              )}
              {data.hostname && (
                <div className="text-zinc-500 truncate">Host: {data.hostname}</div>
              )}
              {data.timezone && (
                <div className="text-zinc-500">TZ: {data.timezone}</div>
              )}
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
      )}
    </div>
  );
}
