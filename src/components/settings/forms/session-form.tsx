"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle, XCircle, Loader2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import type { SaveStatus } from "./shared";

interface SessionFormProps {
  initialDefaultDuration: string;
  initialMobileDuration: string;
  initialMaxDuration: string;
}

export function SessionForm({ initialDefaultDuration, initialMobileDuration, initialMaxDuration }: SessionFormProps) {
  const [defaultDuration, setDefaultDuration] = useState(initialDefaultDuration);
  const [mobileDuration,  setMobileDuration]  = useState(initialMobileDuration);
  const [maxDuration,     setMaxDuration]     = useState(initialMaxDuration);
  const [status, setStatus] = useState<SaveStatus>("idle");

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionDefaultDuration: defaultDuration,
          sessionMobileDuration:  mobileDuration,
          sessionMaxDuration:     maxDuration,
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
          <Label htmlFor="session-default">Desktop session <span className="text-zinc-500 font-normal">seconds</span></Label>
          <Input
            id="session-default"
            type="number"
            min="60"
            value={defaultDuration}
            onChange={(e) => { setDefaultDuration(e.target.value); setStatus("idle"); }}
            placeholder="3600"
            className="bg-zinc-800 border-zinc-700 text-sm"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="session-mobile">Mobile session <span className="text-zinc-500 font-normal">seconds</span></Label>
          <Input
            id="session-mobile"
            type="number"
            min="60"
            value={mobileDuration}
            onChange={(e) => { setMobileDuration(e.target.value); setStatus("idle"); }}
            placeholder="604800"
            className="bg-zinc-800 border-zinc-700 text-sm"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="session-max">Remember me <span className="text-zinc-500 font-normal">seconds</span></Label>
          <Input
            id="session-max"
            type="number"
            min="60"
            value={maxDuration}
            onChange={(e) => { setMaxDuration(e.target.value); setStatus("idle"); }}
            placeholder="2592000"
            className="bg-zinc-800 border-zinc-700 text-sm"
          />
        </div>
      </div>
      <p className="text-xs text-zinc-500">
        Desktop default: 3600 (1 h). Mobile default: 604800 (7 days). Remember me: 2592000 (30 days). Changes apply to new logins only.
      </p>
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
