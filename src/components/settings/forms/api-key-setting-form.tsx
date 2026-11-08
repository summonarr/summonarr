"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle, XCircle, Loader2, Trash2 } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import { patchSettings } from "./shared";
import { withBasePath } from "@/lib/base-path";
import { apiErrorText } from "@/lib/client/api-error";
import { useFocusReturn } from "@/hooks/use-focus-return";
import { useT } from "@/components/i18n/i18n-provider";
import { SECRET_MASK_SENTINEL } from "@/lib/secret-mask";

export function ApiKeySettingForm({
  initialApiKey,
  settingKey,
  testService,
  label,
  inputId,
  help,
}: {
  // The settings page passes the mask when a key is saved, "" when none is.
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
  // The field starts EMPTY even when a key is saved: the mask is only its
  // placeholder. As the field's value, a key pasted with the caret after it was
  // saved as "••••••••<key>". An empty field with a saved key means "keep it",
  // and Test then checks the saved key.
  const [apiKey, setApiKey] = useState("");
  // The value this form last saved ("" until it saves one). The test endpoint
  // checks the SAVED key, not what's typed in the box — so testing an edited,
  // unsaved key would check the OLD one and could show "Connected" next to a
  // mistyped new key. So when the field has unsaved changes, Test saves first
  // and then tests (the same "Save & Test" approach as arr-form.tsx).
  const [savedKey, setSavedKey] = useState("");
  // Whether a key is SAVED on the server right now. The prop is set once at
  // page load and never refreshes, so after Remove it would still describe a
  // deleted key; this is updated after every successful PATCH instead (same
  // shape as ios-push-relay-form's `keyIsSet`).
  const [keyIsSet, setKeyIsSet] = useState(initialApiKey.length > 0);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "removed" | "error">("idle");
  const [saveError, setSaveError] = useState("");
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [testMessage, setTestMessage] = useState("");
  // Remove deletes the stored key at once, so it asks first (the cache panel's
  // inline confirm). Focus moves into the confirm row and back to Remove.
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const focus = useFocusReturn();
  // Bumped by every edit. A test that answers after an edit is for a key the
  // field no longer holds, so its verdict is dropped.
  const editSeq = useRef(0);

  // An empty field only matters as an explicit Remove, and the server ignores
  // the bare mask, so neither counts as a change to save.
  const dirty = apiKey !== savedKey && apiKey.length > 0 && apiKey !== SECRET_MASK_SENTINEL;

  // PATCHes one value for this setting. "" deletes the stored key (the route
  // treats ipinfoToken / omdbApiKey / mdblistApiKey as clearable), anything
  // else replaces it.
  async function patchKey(value: string): Promise<boolean> {
    setStatus("saving");
    setSaveError("");
    const result = await patchSettings({ [settingKey]: value });
    if (!result.ok) {
      setSaveError(result.error || t("settings.form.common.saveFailed"));
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
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!dirty || busy) return;
    // Clear any old test result: it was for the previous key, not the one being saved.
    setTestStatus("idle");
    setTestMessage("");
    await patchKey(apiKey);
  }

  async function handleRemove() {
    setConfirmingRemove(false);
    focus.returnToIfLost("key");
    setTestStatus("idle");
    setTestMessage("");
    const removed = await patchKey("");
    if (removed) setApiKey("");
  }

  async function handleTest() {
    const sentAt = editSeq.current;
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
    let ok = false;
    let text: string;
    try {
      const res = await fetch(withBasePath("/api/settings/test-ratings"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: testService }),
      });
      const data: unknown = await res.json().catch(() => null);
      const d = data && typeof data === "object" ? (data as { ok?: unknown; message?: unknown }) : {};
      ok = d.ok === true;
      text = ok
        ? (typeof d.message === "string" && d.message ? d.message : t("settings.form.common.connected"))
        : apiErrorText(data, t("settings.form.common.testFailed"));
    } catch {
      text = t("settings.form.common.testFailed");
    }
    // Edited meanwhile: the verdict is for a key the field no longer holds.
    if (editSeq.current !== sentAt) {
      setTestStatus("idle");
      return;
    }
    setTestStatus(ok ? "ok" : "error");
    setTestMessage(text);
  }

  // An edit clears the last results, never a request in flight: that keeps
  // Save, Remove and Test locked until the answer arrives.
  function onEdit(value: string) {
    editSeq.current += 1;
    setApiKey(value);
    setStatus((s) => (s === "saving" ? s : "idle"));
    setTestStatus((s) => (s === "testing" ? s : "idle"));
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
            autoComplete="new-password"
            data-1p-ignore
            data-lpignore="true"
            value={apiKey}
            onChange={(e) => onEdit(e.target.value)}
            placeholder={keyIsSet ? SECRET_MASK_SENTINEL : undefined}
            className="bg-zinc-800 border-zinc-700 font-mono"
          />
          {keyIsSet && !confirmingRemove && (
            <Button
              ref={focus.refFor("key")}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setConfirmingRemove(true)}
              disabled={busy}
              className="border-zinc-700 text-zinc-400 hover:text-zinc-100 shrink-0 gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5" aria-hidden />
              {t("settings.form.apiKey.removeKey")}
            </Button>
          )}
        </div>
        {keyIsSet && confirmingRemove && (
          <div role="group" aria-label={t("settings.form.apiKey.removeKey")} className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-zinc-400">{t("settings.form.apiKey.confirmRemove")}</span>
            <Button type="button" variant="destructive" size="sm" autoFocus disabled={busy} onClick={() => void handleRemove()}>
              {t("settings.form.common.remove")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => { focus.returnTo("key"); setConfirmingRemove(false); }}
            >
              {t("settings.form.common.cancel")}
            </Button>
          </div>
        )}
        {/* The placeholder alone doesn't say whether a blank field means
            "nothing saved" or "saved, write-only" (arr-instances-manager's hint). */}
        {keyIsSet && !apiKey && (
          <p className="text-xs text-zinc-500">{t("settings.form.agents.secretKeep")}</p>
        )}
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
