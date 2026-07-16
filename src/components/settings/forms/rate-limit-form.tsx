"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle, XCircle, Loader2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import type { SaveStatus } from "./shared";

interface RateLimitFormProps {
  initialRegister: string;
  initialRequests: string;
  initialIssues: string;
  initialMaxPushSubscriptions: string;
}

export function RateLimitForm({ initialRegister, initialRequests, initialIssues, initialMaxPushSubscriptions }: RateLimitFormProps) {
  const [register, setRegister] = useState(initialRegister);
  const [requests, setRequests] = useState(initialRequests);
  const [issues, setIssues] = useState(initialIssues);
  const [maxPushSubscriptions, setMaxPushSubscriptions] = useState(initialMaxPushSubscriptions);
  const [status, setStatus] = useState<SaveStatus>("idle");

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
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
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
      setStatus(res.ok && data.ok !== false ? "ok" : "error");
    } catch {
      setStatus("error");
    }
    setTimeout(() => setStatus("idle"), 3000);
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="rl-register">Registrations <span className="text-zinc-500 font-normal">per 15 min</span></Label>
          <Input
            id="rl-register"
            type="number"
            min="0"
            value={register}
            onChange={(e) => { setRegister(e.target.value); setStatus("idle"); }}
            placeholder="5"
            className="bg-zinc-800 border-zinc-700 text-sm"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rl-requests">Requests <span className="text-zinc-500 font-normal">per min</span></Label>
          <Input
            id="rl-requests"
            type="number"
            min="0"
            value={requests}
            onChange={(e) => { setRequests(e.target.value); setStatus("idle"); }}
            placeholder="20"
            className="bg-zinc-800 border-zinc-700 text-sm"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rl-issues">Issue reports <span className="text-zinc-500 font-normal">per min</span></Label>
          <Input
            id="rl-issues"
            type="number"
            min="0"
            value={issues}
            onChange={(e) => { setIssues(e.target.value); setStatus("idle"); }}
            placeholder="10"
            className="bg-zinc-800 border-zinc-700 text-sm"
          />
        </div>
      </div>
      <p className="text-xs text-zinc-500">Set to 0 to disable rate limiting for that endpoint.</p>
      <div className="border-t border-zinc-800 pt-4">
        <div className="space-y-1.5 max-w-[180px]">
          <Label htmlFor="rl-push-subs">Push devices <span className="text-zinc-500 font-normal">max per user</span></Label>
          <Input
            id="rl-push-subs"
            type="number"
            min="0"
            value={maxPushSubscriptions}
            onChange={(e) => { setMaxPushSubscriptions(e.target.value); setStatus("idle"); }}
            placeholder="5"
            className="bg-zinc-800 border-zinc-700 text-sm"
          />
          <p className="text-xs text-zinc-500">Maximum push-notification devices per account. Oldest is evicted automatically. Set to 0 for no limit.</p>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={status === "saving"} className="bg-indigo-600 hover:bg-indigo-500">
          {status === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</> : "Save"}
        </Button>
        {status === "ok"    && <span className="flex items-center gap-1.5 text-sm text-green-400"><CheckCircle className="w-4 h-4" />Saved</span>}
        {status === "error" && <span className="flex items-center gap-1.5 text-sm text-red-400"><XCircle className="w-4 h-4" />Failed to save</span>}
      </div>
    </form>
  );
}
