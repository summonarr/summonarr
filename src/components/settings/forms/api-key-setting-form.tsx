"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle, XCircle, Loader2, Trash2 } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import { withBasePath } from "@/lib/base-path";
import { useT } from "@/components/i18n/i18n-provider";

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
  // The /api/settings/test-ratings service to check the saved key against. Omit
  // for a credential nothing can test on its own (a client secret) — the Test
  // button is then not rendered.
  testService?: string;
  label: string;
  inputId: string;
  help: React.ReactNode;
}) {
  const t = useT();
  const router = useRouter();
  const [apiKey, setApiKey] = useState(initialApiKey);
  // The value the server currently holds (as far as this form knows). The test
  // endpoint checks the SAVED key, not what's typed in the box — so testing an
  // edited, unsaved key would check the OLD one and could show "Connected" next
  // to a mistyped new key. So when the field has unsaved changes, Test saves
  // first and then tests (the same "Save & Test" approach as arr-form.tsx).
  const [savedKey, setSavedKey] = useState(initialApiKey);
  // Whether a key is SAVED on the server right now. The prop is set once at
  // page load and never refreshes, so after Remove it would still describe a
  // deleted key; this is updated after every successful PATCH instead (same
  // shape as ios-push-relay-form's `keyIsSet`).
  const [keyIsSet, setKeyIsSet] = useState(initialApiKey.length > 0);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "removed" | "error">("idle");
  const [saveError, setSaveError] = useState("");
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [testMessage, setTestMessage] = useState("");

  // The server ignores the placeholder value and an empty one only matters as
  // an explicit Remove, so neither counts as a change to save.
  const dirty = apiKey !== savedKey && apiKey.length > 0 && apiKey !== MASKED_VALUE;

  // PATCHes one value for this setting. "" deletes the stored key (the route
  // treats ipinfoToken / omdbApiKey / mdblistApiKey as clearable), anything
  // else replaces it.
  async function patchKey(value: string): Promise<boolean> {
    setStatus("saving");
    setSaveError("");
    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [settingKey]: value }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || data.ok === false) {
        setSaveError(data.error ?? t("settings.form.common.saveFailed"));
        setStatus("error");
        return false;
      }
      setSavedKey(value);
      setKeyIsSet(value.length > 0);
      setStatus(value.length > 0 ? "saved" : "removed");
      // The card's "Connected" badge is rendered by the server page from the
      // stored key; refresh the RSC payload so it follows the save or remove
      // without a full reload (client state in this form is preserved).
      router.refresh();
      return true;
    } catch {
      setSaveError(t("settings.form.common.saveFailed"));
      setStatus("error");
      return false;
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!dirty) return;
    // Clear any old test result: it was for the previous key, not the one being saved.
    setTestStatus("idle");
    setTestMessage("");
    await patchKey(apiKey);
  }

  async function handleRemove() {
    setTestStatus("idle");
    setTestMessage("");
    const removed = await patchKey("");
    if (removed) setApiKey("");
  }

  async function handleTest() {
    setTestStatus("testing");
    setTestMessage("");
    if (dirty) {
      const saved = await patchKey(apiKey);
      if (!saved) {
        setTestStatus("error");
        setTestMessage(t("settings.form.apiKey.saveFailedUntested"));
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
      setTestMessage(data.ok ? (data.message ?? t("settings.form.common.connected")) : (data.error ?? t("settings.form.common.testFailed")));
    } catch {
      setTestStatus("error");
      setTestMessage(t("settings.form.common.testFailed"));
    }
  }

  const busy = status === "saving" || testStatus === "testing";
  const saveStatus =
    status === "saved" || status === "removed" ? "ok"
    : status === "error" ? "error"
    : status === "saving" ? "saving"
    : "idle";

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor={inputId}>{label}</Label>
        <div className="flex items-center gap-2">
          <Input
            id={inputId}
            type="password"
            value={apiKey}
            onChange={(e) => { setApiKey(e.target.value); setStatus("idle"); setTestStatus("idle"); }}
            placeholder="••••••••"
            className="bg-zinc-800 border-zinc-700 font-mono"
          />
          {keyIsSet && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleRemove}
              disabled={busy}
              className="border-zinc-700 text-zinc-400 hover:text-zinc-100 shrink-0 gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5" aria-hidden />
              {t("settings.form.apiKey.removeKey")}
            </Button>
          )}
        </div>
        <p className="text-xs text-zinc-500">
          {help}
        </p>
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        {/* Disabled while there is nothing new to save: an empty field used to
            answer "Saved" while the key stayed stored (the route dropped the
            empty value). Removing is its own button above. */}
        <Button type="submit" disabled={busy || !dirty} className="bg-indigo-600 hover:bg-indigo-500">
          {status === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("settings.form.common.saving")}</> : t("settings.form.common.save")}
        </Button>
        {testService && (
          <Button type="button" variant="outline" onClick={handleTest} disabled={busy || (!dirty && !keyIsSet)} className="border-zinc-700 text-zinc-400 hover:text-zinc-100 gap-2">
            {testStatus === "testing" ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
            {dirty ? t("settings.form.common.saveAndTest") : t("settings.form.apiKey.test")}
          </Button>
        )}
        <SaveStatusMessage
          status={saveStatus}
          okLabel={status === "removed" ? t("settings.form.apiKey.removed") : undefined}
          errorLabel={saveError || undefined}
        />
        {testStatus === "ok"    && <span role="status" aria-live="polite" className="flex items-center gap-1.5 text-sm text-green-400"><CheckCircle className="w-4 h-4" />{testMessage}</span>}
        {testStatus === "error" && <span role="alert" aria-live="assertive" className="flex items-center gap-1.5 text-sm text-red-400"><XCircle className="w-4 h-4" />{testMessage}</span>}
      </div>
    </form>
  );
}
