"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle, XCircle, Loader2 } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import { withBasePath } from "@/lib/base-path";

// The placeholder /api/settings sends instead of a stored secret, and ignores
// when it comes back in a PATCH (route.ts `MASKED_VALUE` — keep the two equal).
// An untouched field still holds it, so Test there checks the saved key.
const MASKED_VALUE = "••••••••";

export function ApiKeySettingForm({
  initialApiKey,
  settingKey,
  testService,
  label,
  inputId,
  help,
}: {
  initialApiKey: string;
  settingKey: string;
  testService: string;
  label: string;
  inputId: string;
  help: React.ReactNode;
}) {
  const [apiKey, setApiKey] = useState(initialApiKey);
  // The value the server currently holds (as far as this form knows). The test
  // endpoint checks the SAVED key, not what's typed in the box — so testing an
  // edited, unsaved key would check the OLD one and could show "Connected" next
  // to a mistyped new key. So when the field has unsaved changes, Test saves
  // first and then tests (the same "Save & Test" approach as arr-form.tsx).
  const [savedKey, setSavedKey] = useState(initialApiKey);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [testMessage, setTestMessage] = useState("");

  // The server ignores an empty or placeholder value, so in those cases there
  // is nothing new to save before testing.
  const dirty = apiKey !== savedKey && apiKey.length > 0 && apiKey !== MASKED_VALUE;

  async function persistKey(): Promise<boolean> {
    setStatus("saving");
    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [settingKey]: apiKey }),
      });
      if (!res.ok) {
        setStatus("error");
        return false;
      }
      setSavedKey(apiKey);
      setStatus("saved");
      return true;
    } catch {
      setStatus("error");
      return false;
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    // Clear any old test result: it was for the previous key, not the one being saved.
    setTestStatus("idle");
    setTestMessage("");
    await persistKey();
  }

  async function handleTest() {
    setTestStatus("testing");
    setTestMessage("");
    if (dirty) {
      const saved = await persistKey();
      if (!saved) {
        setTestStatus("error");
        setTestMessage("Save failed — key not tested");
        return;
      }
    }
    try {
      const res = await fetch(withBasePath("/api/settings/test-ratings"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: testService }),
      });
      const data = (await res.json().catch(() => ({ ok: false }))) as { ok: boolean; message?: string; error?: string };
      setTestStatus(data.ok ? "ok" : "error");
      setTestMessage(data.ok ? (data.message ?? "Connected") : (data.error ?? "Test failed"));
    } catch {
      setTestStatus("error");
      setTestMessage("Test failed");
    }
  }

  const busy = status === "saving" || testStatus === "testing";

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor={inputId}>{label}</Label>
        <Input
          id={inputId}
          type="password"
          value={apiKey}
          onChange={(e) => { setApiKey(e.target.value); setStatus("idle"); setTestStatus("idle"); }}
          placeholder="••••••••"
          className="bg-zinc-800 border-zinc-700 font-mono text-sm"
        />
        <p className="text-xs text-zinc-500">
          {help}
        </p>
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <Button type="submit" disabled={busy} className="bg-indigo-600 hover:bg-indigo-500">
          {status === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</> : "Save"}
        </Button>
        <Button type="button" variant="outline" onClick={handleTest} disabled={busy} className="border-zinc-700 text-zinc-400 hover:text-zinc-100 gap-2">
          {testStatus === "testing" ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
          {dirty ? "Save & Test" : "Test API"}
        </Button>
        <SaveStatusMessage status={status === "saved" ? "ok" : status} />
        {testStatus === "ok"    && <span role="status" aria-live="polite" className="flex items-center gap-1.5 text-sm text-green-400"><CheckCircle className="w-4 h-4" />{testMessage}</span>}
        {testStatus === "error" && <span role="alert" aria-live="assertive" className="flex items-center gap-1.5 text-sm text-red-400"><XCircle className="w-4 h-4" />{testMessage}</span>}
      </div>
    </form>
  );
}
