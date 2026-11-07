"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import { useSettingsSave } from "./shared";
import { useT } from "@/components/i18n/i18n-provider";

export function DeletionVoteThresholdForm({ initialThreshold }: { initialThreshold: string }) {
  const t = useT();
  const [threshold, setThreshold] = useState(initialThreshold);
  // `message` is set only by a failed save, and stays until the next edit or save.
  const { status, message, save, edited } = useSettingsSave();

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    // A blank field is saved as blank, which the vote routes read as 0 (off) —
    // what the help text and the "0" placeholder promise.
    await save({ deletionVoteThreshold: threshold });
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
          onChange={(e) => { setThreshold(e.target.value); edited(); }}
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
        <SaveStatusMessage status={status} errorLabel={message || t("settings.form.common.saveFailed")} />
      </div>
    </form>
  );
}
