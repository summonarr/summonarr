"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle, XCircle, Loader2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import type { SaveStatus } from "./shared";

export function DeletionVoteThresholdForm({ initialThreshold }: { initialThreshold: string }) {
  const [threshold, setThreshold] = useState(initialThreshold);
  const [status, setStatus] = useState<SaveStatus>("idle");

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deletionVoteThreshold: threshold }),
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
      <div className="space-y-1.5">
        <Label htmlFor="deletion-vote-threshold">Vote threshold</Label>
        <Input
          id="deletion-vote-threshold"
          type="number"
          min="0"
          value={threshold}
          onChange={(e) => { setThreshold(e.target.value); setStatus("idle"); }}
          placeholder="0"
          className="bg-zinc-800 border-zinc-700 text-sm max-w-48"
        />
        <p className="text-xs text-zinc-500">
          When a library item reaches this many deletion votes, admins are notified via email, push, and Discord. Set to 0 to disable notifications.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={status === "saving"}>
          {status === "saving" ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save"}
        </Button>
        {status === "ok" && <CheckCircle className="w-4 h-4 text-green-400" />}
        {status === "error" && <XCircle className="w-4 h-4 text-red-400" />}
      </div>
    </form>
  );
}
