"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import { withBasePath } from "@/lib/base-path";
import type { SaveStatus } from "./shared";
import { useT } from "@/components/i18n/i18n-provider";

interface RateLimitFormProps {
  initialRegister: string;
  initialRequests: string;
  initialIssues: string;
  initialMaxPushSubscriptions: string;
}

export function RateLimitForm({ initialRegister, initialRequests, initialIssues, initialMaxPushSubscriptions }: RateLimitFormProps) {
  const t = useT();
  const [register, setRegister] = useState(initialRegister);
  const [requests, setRequests] = useState(initialRequests);
  const [issues, setIssues] = useState(initialIssues);
  const [maxPushSubscriptions, setMaxPushSubscriptions] = useState(initialMaxPushSubscriptions);
  const [status, setStatus] = useState<SaveStatus>("idle");
  // An earlier save's idle timer must not fire into a later save (it would
  // re-enable Save mid-flight or hide the new result early).
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
  }, []);
  const [message, setMessage] = useState("");

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (idleTimer.current) clearTimeout(idleTimer.current);
    setStatus("saving");
    setMessage("");
    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rateLimitRegister: register,
          rateLimitRequests: requests,
          rateLimitIssues: issues,
          maxPushSubscriptions,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && data.ok !== false) {
        setStatus("ok");
      } else {
        setMessage(data.error ?? t("settings.form.common.saveFailed"));
        setStatus("error");
      }
    } catch {
      setStatus("error");
    }
    idleTimer.current = setTimeout(() => setStatus((s) => (s === "ok" ? "idle" : s)), 3000);
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="rl-register">{t("settings.form.rateLimit.registrations")} <span className="text-zinc-500 font-normal">{t("settings.form.rateLimit.per15Min")}</span></Label>
          <Input
            id="rl-register"
            type="number"
            min="1"
            value={register}
            onChange={(e) => { setRegister(e.target.value); setStatus("idle"); }}
            placeholder="5"
            className="bg-zinc-800 border-zinc-700 text-sm"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rl-requests">{t("settings.form.rateLimit.requests")} <span className="text-zinc-500 font-normal">{t("settings.form.rateLimit.perMin")}</span></Label>
          <Input
            id="rl-requests"
            type="number"
            min="1"
            value={requests}
            onChange={(e) => { setRequests(e.target.value); setStatus("idle"); }}
            placeholder="20"
            className="bg-zinc-800 border-zinc-700 text-sm"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rl-issues">{t("settings.form.rateLimit.issues")} <span className="text-zinc-500 font-normal">{t("settings.form.rateLimit.perMin")}</span></Label>
          <Input
            id="rl-issues"
            type="number"
            min="1"
            value={issues}
            onChange={(e) => { setIssues(e.target.value); setStatus("idle"); }}
            placeholder="10"
            className="bg-zinc-800 border-zinc-700 text-sm"
          />
        </div>
      </div>
      <p className="text-xs text-zinc-500">{t("settings.form.rateLimit.help")}</p>
      <div className="border-t border-zinc-800 pt-4">
        <div className="space-y-1.5 max-w-[180px]">
          <Label htmlFor="rl-push-subs">{t("settings.form.rateLimit.pushDevices")} <span className="text-zinc-500 font-normal">{t("settings.form.rateLimit.maxPerUser")}</span></Label>
          <Input
            id="rl-push-subs"
            type="number"
            min="0"
            value={maxPushSubscriptions}
            onChange={(e) => { setMaxPushSubscriptions(e.target.value); setStatus("idle"); }}
            placeholder="5"
            className="bg-zinc-800 border-zinc-700 text-sm"
          />
          <p className="text-xs text-zinc-500">{t("settings.form.rateLimit.pushHelp")}</p>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={status === "saving"} className="bg-indigo-600 hover:bg-indigo-500">
          {status === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("settings.form.common.saving")}</> : t("settings.form.common.save")}
        </Button>
        <SaveStatusMessage status={status} errorLabel={message || t("settings.form.common.saveFailed")} />
      </div>
    </form>
  );
}
