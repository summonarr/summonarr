"use client";

import { useEffect, useId, useRef, useState } from "react";
import { CheckCircle, XCircle, Loader2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import type { SaveStatus } from "./shared";
import { Switch } from "@/components/ui/switch";

export function EnableMachineSessionToggle({
  initialEnabled,
  initialAllowedIps,
}: {
  initialEnabled: boolean;
  initialAllowedIps: string;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }, []);

  const [allowedIps, setAllowedIps] = useState(initialAllowedIps);
  const [savedAllowedIps, setSavedAllowedIps] = useState(initialAllowedIps);
  const [ipStatus, setIpStatus] = useState<SaveStatus>("idle");
  const [ipError, setIpError] = useState<string | null>(null);

  async function toggle() {
    const next = !enabled;
    const prev = enabled;
    setEnabled(next);
    setStatus("saving");
    setError(null);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enableMachineSession: next ? "true" : "false" }),
      });
      const data: { ok?: boolean; error?: string } = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setEnabled(prev);
        setError(data.error ?? "Failed to save");
        setStatus("error");
      } else {
        setStatus("ok");
        resetTimer.current = setTimeout(() => setStatus("idle"), 3000);
      }
    } catch {
      setEnabled(prev);
      setError("Failed to save");
      setStatus("error");
    }
  }

  async function saveAllowedIps() {
    setIpStatus("saving");
    setIpError(null);
    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ machineSessionAllowedIps: allowedIps.trim() }),
      });
      const data: { ok?: boolean; error?: string } = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        setSavedAllowedIps(allowedIps.trim());
        setIpStatus("ok");
        setTimeout(() => setIpStatus("idle"), 3000);
      } else {
        setIpError(data.error ?? "Failed to save");
        setIpStatus("error");
      }
    } catch {
      setIpError("Failed to save");
      setIpStatus("error");
    }
  }

  const ipsDirty = allowedIps.trim() !== savedAllowedIps.trim();

  return (
    <div className="py-3 border-t border-zinc-800">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p id={titleId} className="text-sm font-medium text-zinc-200">Machine session API</p>
          <p id={descId} className="text-xs text-zinc-500 mt-0.5">
            Allow <code className="text-zinc-400">POST /api/auth/machine-session</code> to issue short-lived admin sessions via <code className="text-zinc-400">CRON_SECRET</code>. Used for automated screenshot capture and headless browser access.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {status === "saving" && <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-500" />}
          {status === "ok"     && <CheckCircle className="w-3.5 h-3.5 text-green-400" />}
          {status === "error"  && (
            <span role="alert" className="flex max-w-xs items-center gap-1 text-right text-xs text-red-400">
              <XCircle className="w-3.5 h-3.5" aria-hidden />
              {error}
            </span>
          )}
          <Switch
            checked={enabled}
            onCheckedChange={toggle}
            disabled={status === "saving"}
            aria-labelledby={titleId}
            aria-describedby={descId}
          />
        </div>
      </div>

      {/*
        Always shown, even while the switch is off. The server refuses to turn
        the switch on while the IP list is empty, and `toggle()` then flips the
        switch back. If this editor only showed while the switch was on, it would
        vanish along with the failed toggle and a fresh install could never be
        enabled. So: set the IPs first, then flip the switch.
      */}
      {(
        <div className="mt-3 pl-0.5">
          <label htmlFor="machine-session-ips" className="block text-xs font-medium text-zinc-300">
            Allowed IP addresses
          </label>
          <p className="text-xs text-zinc-500 mt-0.5 mb-1.5">
            Restrict which client IPs may mint a session. One or more IPs or CIDR ranges, comma or newline separated (e.g. <code className="text-zinc-400">10.0.0.5, 192.168.1.0/24</code>). <strong className="text-zinc-300">Required</strong> — the API cannot be enabled while this is empty, so set it before turning the switch on. Requires <code className="text-zinc-400">TRUST_PROXY=true</code> and a reverse proxy that sets <code className="text-zinc-400">X-Forwarded-For</code> — otherwise every request is rejected.
          </p>
          <textarea
            id="machine-session-ips"
            value={allowedIps}
            onChange={(e) => setAllowedIps(e.target.value)}
            rows={2}
            spellCheck={false}
            placeholder="e.g. 10.0.0.5, 192.168.1.0/24"
            className="w-full rounded-md bg-zinc-900 border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-200 font-mono placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <div className="flex items-center gap-2 mt-1.5">
            <button
              type="button"
              onClick={saveAllowedIps}
              disabled={!ipsDirty || ipStatus === "saving"}
              className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-[var(--ds-accent-fg)] disabled:opacity-40 disabled:cursor-not-allowed hover:bg-indigo-500"
            >
              Save IPs
            </button>
            {ipStatus === "saving" && <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-500" />}
            {ipStatus === "ok"     && <CheckCircle className="w-3.5 h-3.5 text-green-400" />}
            {ipStatus === "error"  && <XCircle className="w-3.5 h-3.5 text-red-400" />}
            {ipError && <span className="text-xs text-red-400">{ipError}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
