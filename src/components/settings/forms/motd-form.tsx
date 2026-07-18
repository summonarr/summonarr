"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import { withBasePath } from "@/lib/base-path";
import type { SaveStatus } from "./shared";

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
          <p className="text-sm font-medium text-zinc-200">Show popup to users</p>
          <p className="text-xs text-zinc-500 mt-0.5">Disable to hide the popup without clearing the message content.</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={() => { setEnabled(!enabled); setMotdStatus("idle"); }}
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-zinc-900 ${enabled ? "bg-indigo-600" : "bg-zinc-700"}`}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${enabled ? "translate-x-4" : "translate-x-0.5"}`} />
        </button>
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
          className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
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
