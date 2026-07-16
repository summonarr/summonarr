"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle, XCircle, Loader2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import type { SaveStatus } from "./shared";

interface QuotaFormProps {
  initialLimit: string;
  initialPeriod: string;
}

export function QuotaForm({ initialLimit, initialPeriod }: QuotaFormProps) {
  const [limit, setLimit] = useState(initialLimit);
  const [period, setPeriod] = useState(initialPeriod || "week");
  const [status, setStatus] = useState<SaveStatus>("idle");

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quotaLimit: limit, quotaPeriod: period }),
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
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="quota-limit">Request limit</Label>
          <Input
            id="quota-limit"
            type="number"
            min="0"
            value={limit}
            onChange={(e) => { setLimit(e.target.value); setStatus("idle"); }}
            placeholder="0"
            className="bg-zinc-800 border-zinc-700 text-sm"
          />
          <p className="text-xs text-zinc-500">Maximum requests per user in the period. Set to 0 to disable.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="quota-period">Period</Label>
          <select
            id="quota-period"
            value={period}
            onChange={(e) => { setPeriod(e.target.value); setStatus("idle"); }}
            className="w-full h-9 rounded-md border border-zinc-700 bg-zinc-800 px-3 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <option value="day">Per day</option>
            <option value="week">Per week</option>
            <option value="month">Per month</option>
          </select>
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
