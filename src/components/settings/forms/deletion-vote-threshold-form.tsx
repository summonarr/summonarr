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

export function DeletionVoteThresholdForm({ initialThreshold }: { initialThreshold: string }) {
  const t = useT();
  const [threshold, setThreshold] = useState(initialThreshold);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [error, setError] = useState("");
  // Only the "Saved" tick fades; a server error stays until the next edit or
  // save. Ref'd so a second save cancels the first save's timer and unmount
  // clears it.
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (resetTimer.current) clearTimeout(resetTimer.current); }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (resetTimer.current) clearTimeout(resetTimer.current);
    setStatus("saving");
    setError("");
    try {
      // A blank field is saved as blank, which the vote routes read as 0 (off) —
      // what the help text and the "0" placeholder promise.
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deletionVoteThreshold: threshold }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && data.ok !== false) {
        setStatus("ok");
        resetTimer.current = setTimeout(() => setStatus("idle"), 3000);
      } else {
        setError(data.error ?? t("settings.form.common.saveFailed"));
        setStatus("error");
      }
    } catch {
      setError(t("settings.form.common.saveFailed"));
      setStatus("error");
    }
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="deletion-vote-threshold">{t("settings.form.deletionVote.label")}</Label>
        <Input
          id="deletion-vote-threshold"
          type="number"
          // The route's range (0–10000); the browser says so before the request.
          min="0"
          max="10000"
          value={threshold}
          onChange={(e) => { setThreshold(e.target.value); setStatus("idle"); }}
          placeholder="0"
          className="bg-zinc-800 border-zinc-700 max-w-48"
        />
        <p className="text-xs text-zinc-500">
          {t("settings.form.deletionVote.help")}
        </p>
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <Button type="submit" size="sm" disabled={status === "saving"}>
          {status === "saving" ? <Loader2 className="w-4 h-4 animate-spin" /> : t("settings.form.common.save")}
        </Button>
        <SaveStatusMessage status={status} errorLabel={error || undefined} />
      </div>
    </form>
  );
}
