"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import { withBasePath } from "@/lib/base-path";
import type { SaveStatus } from "./shared";
import { Switch } from "@/components/ui/switch";

interface MotdFormProps {
  initialEnabled: boolean;
  initialTitle: string;
  initialBody: string;
}

export function MotdForm({ initialEnabled, initialTitle, initialBody }: MotdFormProps) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [title,  setTitle]  = useState(initialTitle);
  const [body,   setBody]   = useState(initialBody);
  const [motdStatus, setMotdStatus] = useState<SaveStatus>("idle");

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setMotdStatus("saving");
    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ motdEnabled: enabled ? "true" : "false", motdTitle: title, motdBody: body }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
      setMotdStatus(res.ok && data.ok !== false ? "ok" : "error");
    } catch {
      setMotdStatus("error");
    }
    setTimeout(() => setMotdStatus("idle"), 3000);
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="flex items-center justify-between gap-4 pb-4 border-b border-zinc-800">
        <div>
          <p id="motd-enabled-label" className="text-sm font-medium text-zinc-200">Show popup to users</p>
          <p id="motd-enabled-desc" className="text-xs text-zinc-500 mt-0.5">Disable to hide the popup without clearing the message content.</p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={() => { setEnabled(!enabled); setMotdStatus("idle"); }}
          aria-labelledby="motd-enabled-label"
          aria-describedby="motd-enabled-desc"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="motd-title">Title <span className="text-zinc-500 font-normal">(optional)</span></Label>
        <Input
          id="motd-title"
          value={title}
          onChange={(e) => { setTitle(e.target.value); setMotdStatus("idle"); }}
          placeholder="Welcome!"
          className="bg-zinc-800 border-zinc-700 text-sm"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="motd-body">Message</Label>
        <textarea
          id="motd-body"
          value={body}
          onChange={(e) => { setBody(e.target.value); setMotdStatus("idle"); }}
          placeholder="Enter your message here."
          rows={4}
          className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
        />
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={motdStatus === "saving"} className="bg-indigo-600 hover:bg-indigo-500">
          {motdStatus === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</> : "Save"}
        </Button>
        <SaveStatusMessage status={motdStatus} />
      </div>
    </form>
  );
}
