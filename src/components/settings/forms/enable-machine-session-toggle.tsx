"use client";

import { useState } from "react";
import { CheckCircle, XCircle, Loader2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import type { SaveStatus } from "./shared";

export function EnableMachineSessionToggle({
  initialEnabled,
  initialAllowedIps,
}: {
  initialEnabled: boolean;
  initialAllowedIps: string;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [status, setStatus] = useState<SaveStatus>("idle");

  const [allowedIps, setAllowedIps] = useState(initialAllowedIps);
  const [savedAllowedIps, setSavedAllowedIps] = useState(initialAllowedIps);
  const [ipStatus, setIpStatus] = useState<SaveStatus>("idle");
  const [ipError, setIpError] = useState<string | null>(null);

  async function toggle() {
    const next = !enabled;
    const prev = enabled;
    setEnabled(next);
    setStatus("saving");
    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enableMachineSession: next ? "true" : "false" }),
      });
      const data: { ok: boolean } = await res.json().catch(() => ({ ok: false }));
      if (!data.ok) {
        setEnabled(prev);
        setStatus("error");
      } else {
        setStatus("ok");
      }
    } catch {
      setEnabled(prev);
      setStatus("error");
    }
    setTimeout(() => setStatus("idle"), 3000);
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
          <p className="text-sm font-medium text-zinc-200">Machine session API</p>
          <p className="text-xs text-zinc-500 mt-0.5">
            Allow <code className="text-zinc-400">POST /api/auth/machine-session</code> to issue short-lived admin sessions via <code className="text-zinc-400">CRON_SECRET</code>. Used for automated screenshot capture and headless browser access.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {status === "saving" && <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-500" />}
          {status === "ok"     && <CheckCircle className="w-3.5 h-3.5 text-green-400" />}
          {status === "error"  && <XCircle className="w-3.5 h-3.5 text-red-400" />}
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={toggle}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-zinc-900 ${enabled ? "bg-indigo-600" : "bg-zinc-700"}`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${enabled ? "translate-x-4" : "translate-x-0.5"}`} />
          </button>
        </div>
      </div>

      {enabled && (
        <div className="mt-3 pl-0.5">
          <label htmlFor="machine-session-ips" className="block text-xs font-medium text-zinc-300">
            Allowed IP addresses
          </label>
          <p className="text-xs text-zinc-500 mt-0.5 mb-1.5">
            Restrict which client IPs may mint a session. One or more IPs or CIDR ranges, comma or newline separated (e.g. <code className="text-zinc-400">10.0.0.5, 192.168.1.0/24</code>). Leave blank to allow any IP. Requires <code className="text-zinc-400">TRUST_PROXY=true</code> and a reverse proxy that sets <code className="text-zinc-400">X-Forwarded-For</code> — otherwise every request is rejected.
          </p>
          <textarea
            id="machine-session-ips"
            value={allowedIps}
            onChange={(e) => setAllowedIps(e.target.value)}
            rows={2}
            spellCheck={false}
            placeholder="Any IP allowed"
            className="w-full rounded-md bg-zinc-900 border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-200 font-mono placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <div className="flex items-center gap-2 mt-1.5">
            <button
              type="button"
              onClick={saveAllowedIps}
              disabled={!ipsDirty || ipStatus === "saving"}
              className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-indigo-500"
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
