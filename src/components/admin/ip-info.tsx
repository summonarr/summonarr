"use client";

import { useEffect, useRef, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { ChevronDown, Globe, Loader2, MapPin, Network } from "@/components/icons";
import { useT } from "@/components/i18n/i18n-provider";
import { cacheSet, cachedView, ipLookupCache, isFreshMissing, lookupIp, type IpError, type Lookup } from "@/components/admin/ip-info-cache";

interface Props {
  ip: string;
  /** Render the toggle inline (next to the IP) instead of taking the full row. */
  inline?: boolean;
  /**
   * Trigger text size. Defaults to 12px (`xs`) to sit level with the 12px
   * detail-panel values and the 12.5px Known-IPs table it lives in; the play
   * detail page passes `sm` to match its 14px LabeledValue rows.
   */
  size?: "xs" | "sm";
}

export function IpInfo({ ip, inline = false, size = "xs" }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  // Initialize from cache at mount AND re-read on open: a sibling IpInfo for the
  // same IP may have populated the cache after this instance mounted, in which
  // case the useState initializer would have returned null and `cache.has(ip)`
  // would short-circuit the popover fetch — leaving the popover blank.
  const [data, setData] = useState<Lookup | null>(() => cachedView(ip).data);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<IpError | null>(() => cachedView(ip).error);
  // The ip this instance last fetched (null = none in flight / retry allowed).
  // Keyed by ip, not a boolean, so a changed `ip` prop is fetched afresh.
  const fetchedRef = useRef<string | null>(null);
  // The ip currently rendered — a response for an older ip must not land.
  const ipRef = useRef(ip);
  useEffect(() => {
    ipRef.current = ip;
  }, [ip]);

  // A live session's reported address can change between polls while this
  // instance stays mounted; drop the previous ip's lookup so the popover never
  // shows one ip's geolocation under another ip.
  const [prevIp, setPrevIp] = useState(ip);
  if (prevIp !== ip) {
    setPrevIp(ip);
    const view = cachedView(ip);
    setData(view.data);
    setError(view.error);
    setLoading(false);
  }

  async function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) return;
    // Re-read from cache on every open so a sibling-populated entry is reflected
    // even if this instance's useState initializer saw an empty cache at mount.
    const cached = ipLookupCache.get(ip);
    if (isFreshMissing(cached, Date.now())) {
      setError({ kind: "missing" });
      return;
    }
    if (cached && !("missingAt" in cached)) {
      setData(cached);
      setError(null);
      return;
    }
    if (fetchedRef.current === ip) return;
    fetchedRef.current = ip;
    const requested = ip;
    setLoading(true);
    setError(null);
    const outcome = await lookupIp(requested);
    // A transient failure, or a 404 (whose cache entry expires), releases the
    // guard so the next open asks again.
    if (outcome.kind !== "found" && fetchedRef.current === requested) fetchedRef.current = null;
    if (outcome.kind === "found") cacheSet(requested, outcome.lookup);
    else if (outcome.kind === "missing") cacheSet(requested, { missingAt: Date.now() });
    if (ipRef.current !== requested) return;
    if (outcome.kind === "found") setData(outcome.lookup);
    else setError(outcome.kind === "missing" ? { kind: "missing" } : { kind: "failed", message: outcome.message });
    setLoading(false);
  }

  const errorText = !error ? null : error.kind === "missing" ? t("adminActivity.ip.notAvailable") : error.message ?? t("adminActivity.ip.lookupFailed");

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger
        className={`${inline ? "inline-flex" : "flex"} items-center gap-1.5 text-zinc-400 hover:text-zinc-200 transition-colors ${size === "sm" ? "text-sm" : "text-xs"} tabular-nums font-mono outline-none focus-visible:text-zinc-200`}
      >
        <Globe className={`${size === "sm" ? "w-3.5 h-3.5" : "w-3 h-3"} text-zinc-500`} />
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
                  <span>{t("adminActivity.ip.lookingUp")}</span>
                </div>
              )}

              {!loading && errorText && <div className="text-zinc-500">{errorText}</div>}

              {!loading && !error && data && data.bogon && (
                <div className="text-zinc-500">{t("adminActivity.ip.private")}</div>
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
                    <div className="text-zinc-500 break-all">{t("adminActivity.ip.host", { host: data.hostname })}</div>
                  )}
                  {data.timezone && <div className="text-zinc-500">{t("adminActivity.ip.timezone", { tz: data.timezone })}</div>}
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
