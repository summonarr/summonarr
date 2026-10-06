"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CheckCircle, XCircle, Loader2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import type { SaveStatus } from "./shared";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/components/i18n/i18n-provider";
import { rich } from "./rich";

export function EnableMachineSessionToggle({
  initialEnabled,
  initialAllowedIps,
}: {
  initialEnabled: boolean;
  initialAllowedIps: string;
}) {
  const t = useT();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The IP list has its own save and its own fade timer. Only the ✓ fades; an
  // error (an unparseable CIDR, the write cooldown) stays until the next edit
  // or save. Both timers are cleared on unmount.
  const ipResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
    if (ipResetTimer.current) clearTimeout(ipResetTimer.current);
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
        setError(data.error ?? t("settings.form.common.saveFailed"));
        setStatus("error");
      } else {
        setStatus("ok");
        resetTimer.current = setTimeout(() => setStatus("idle"), 3000);
      }
    } catch {
      setEnabled(prev);
      setError(t("settings.form.common.saveFailed"));
      setStatus("error");
    }
  }

  async function saveAllowedIps() {
    if (ipResetTimer.current) clearTimeout(ipResetTimer.current);
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
        ipResetTimer.current = setTimeout(() => setIpStatus("idle"), 3000);
      } else {
        setIpError(data.error ?? t("settings.form.common.saveFailed"));
        setIpStatus("error");
      }
    } catch {
      setIpError(t("settings.form.common.saveFailed"));
      setIpStatus("error");
    }
  }

  const ipsDirty = allowedIps.trim() !== savedAllowedIps.trim();

  // Row recipe shared with the sibling toggles: the parent card owns the
  // dividers (divide-y), the row owns its padding, and a server error wraps
  // onto its own full-width line so it can't push the switch off-card at 375px.
  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <p id={titleId} className="text-sm font-medium text-zinc-200">{t("settings.form.machineSession.title")}</p>
          <p id={descId} className="text-xs text-zinc-500 mt-0.5">
            {rich(t("settings.form.machineSession.help"), {
              endpoint: <code className="text-zinc-400">POST /api/auth/machine-session</code>,
              secret: <code className="text-zinc-400">CRON_SECRET</code>,
            })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {status === "saving" && <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-500" />}
          {status === "ok"     && <CheckCircle className="w-3.5 h-3.5 text-green-400" />}
          <Switch
            checked={enabled}
            onCheckedChange={toggle}
            disabled={status === "saving"}
            aria-labelledby={titleId}
            aria-describedby={descId}
            className="shrink-0"
          />
        </div>
        {status === "error" && (
          <span role="alert" className="basis-full flex items-center gap-1 text-xs text-red-400">
            <XCircle className="w-3.5 h-3.5 shrink-0" aria-hidden />
            {error}
          </span>
        )}
      </div>

      {/*
        Always shown, even while the switch is off. The server refuses to turn
        the switch on while the IP list is empty, and `toggle()` then flips the
        switch back. If this editor only showed while the switch was on, it would
        vanish along with the failed toggle and a fresh install could never be
        enabled. So: set the IPs first, then flip the switch.
      */}
      <div className="mt-3 pl-0.5">
        <label htmlFor="machine-session-ips" className="block text-xs font-medium text-zinc-300">
          {t("settings.form.machineSession.ipsLabel")}
        </label>
        <p className="text-xs text-zinc-500 mt-0.5 mb-1.5">
          {rich(t("settings.form.machineSession.ipsHelp"), {
            example: <code className="text-zinc-400">10.0.0.5, 192.168.1.0/24</code>,
            required: <strong className="text-zinc-300">{t("settings.form.machineSession.required")}</strong>,
            trustProxy: <code className="text-zinc-400">TRUST_PROXY=true</code>,
            header: <code className="text-zinc-400">X-Forwarded-For</code>,
          })}
        </p>
        <Textarea
          id="machine-session-ips"
          value={allowedIps}
          onChange={(e) => { setAllowedIps(e.target.value); setIpStatus("idle"); setIpError(null); }}
          rows={2}
          spellCheck={false}
          placeholder={t("settings.form.machineSession.ipsPlaceholder", { example: "10.0.0.5, 192.168.1.0/24" })}
          className="font-mono"
        />
        <div className="flex flex-wrap items-center gap-2 mt-1.5">
          <Button
            type="button"
            size="xs"
            onClick={saveAllowedIps}
            disabled={!ipsDirty || ipStatus === "saving"}
          >
            {t("settings.form.machineSession.saveIps")}
          </Button>
          {ipStatus === "saving" && <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-500" />}
          {ipStatus === "ok"     && <CheckCircle className="w-3.5 h-3.5 text-green-400" />}
          {ipStatus === "error"  && (
            <span role="alert" className="flex items-center gap-1 text-xs text-red-400">
              <XCircle className="w-3.5 h-3.5 shrink-0" aria-hidden />
              {ipError}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
