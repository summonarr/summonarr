"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle, XCircle, Loader2 } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import { withBasePath } from "@/lib/base-path";

// Mirrors the sentinel /api/settings substitutes for a stored secret on read
// and skips on PATCH (route.ts `MASKED_VALUE`). An untouched form still holds
// it, so a Test there correctly probes the persisted key.
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
  // The value the server currently holds (as far as this form knows). The
  // test-ratings probe reads the PERSISTED key (testOmdbConnection & co. call
  // getApiKey({ fresh: true }) with no argument), so a Test against an edited,
  // unsaved field would silently validate the OLD key and paint a green
  // "Connected" beside a mistyped new one. When the field is dirty, Test
  // saves first and then probes — the same Save & Test shape as arr-form.tsx.
  const [savedKey, setSavedKey] = useState(initialApiKey);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [testMessage, setTestMessage] = useState("");

  // An empty or masked value is skipped by the PATCH route, so there is
  // nothing new to persist before a probe.
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
    // A green result earned against the previous key must not survive a save
    // of a different one.
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
        <Button type="button" variant="outline" onClick={handleTest} disabled={busy} className="border-zinc-700 text-zinc-400 hover:text-white gap-2">
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
