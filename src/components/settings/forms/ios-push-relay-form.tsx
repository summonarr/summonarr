"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Trash2 } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import { useSettingsSave } from "./shared";
import { useT } from "@/components/i18n/i18n-provider";
import { SECRET_MASK_SENTINEL } from "@/lib/secret-mask";

interface IosPushRelayFormProps {
  initialRelayUrl: string;
  initialRelayKey: string; // masked placeholder when set, "" when not
  initialRecommendedBuild: string;
}

// The apnsRelayKey part of the PATCH: a typed key, "" to delete the saved one,
// or nothing (keep it).
function relayKeyField(typed: string, remove: boolean): { apnsRelayKey?: string } {
  if (typed) return { apnsRelayKey: typed };
  return remove ? { apnsRelayKey: "" } : {};
}

export function IosPushRelayForm({ initialRelayUrl, initialRelayKey, initialRecommendedBuild }: IosPushRelayFormProps) {
  const t = useT();
  const [relayUrl, setRelayUrl] = useState(initialRelayUrl);
  // The field starts EMPTY even when a key is saved: the mask is only its
  // placeholder. As the field's value, an edit after it sent the mask plus the
  // typed text, which the route refuses. An empty field keeps the saved key;
  // Remove marks it to be deleted on Save.
  const [relayKey, setRelayKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [recommendedBuild, setRecommendedBuild] = useState(initialRecommendedBuild);
  // Only the "Saved" tick fades. A validation error (the 8–200 printable ASCII
  // key rule, the recommended-build range) is the only guidance the form gives,
  // so it stays until the next edit or save.
  const { status, message: errorMessage, save, edited } = useSettingsSave();

  // Whether a key is SAVED on the server right now. We can't rely on the prop:
  // it is set once when the page loads and never refreshes, so after Remove +
  // Save the hint would still describe a deleted key until a full reload.
  // Updated after every successful save below.
  const [keyIsSet, setKeyIsSet] = useState(initialRelayKey.length > 0);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const sentKey = relayKey;
    const sentRemove = removeKey;
    const result = await save({
      // A typed key replaces the saved one; "" deletes it (Remove); nothing
      // sent keeps it.
      ...relayKeyField(sentKey, sentRemove),
      // "" deletes the recommendation.
      recommendedIosBuild: recommendedBuild.trim(),
      // "" deletes the custom URL, so push goes back to the default relay
      // (which is what the "leave blank for the default" hint promises).
      apnsRelayUrl: relayUrl.trim(),
    });
    if (result.ok) {
      // A new key was saved, or the saved one removed, or (neither) kept.
      setKeyIsSet(sentKey.length > 0 || (keyIsSet && !sentRemove));
      // Clear only what was sent: a key typed or a Remove pressed while the
      // save ran is the admin's next edit.
      setRelayKey((k) => (k === sentKey ? "" : k));
      setRemoveKey((r) => (r === sentRemove ? false : r));
    }
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="apns-relay-url">{t("settings.form.iosPush.relayUrl")}</Label>
        <Input
          id="apns-relay-url"
          type="url"
          value={relayUrl}
          onChange={(e) => { setRelayUrl(e.target.value); edited(); }}
          placeholder="https://summonapns.gadgetusaf.com/push"
          className="bg-zinc-800 border-zinc-700 font-mono"
        />
        <p className="text-xs text-zinc-500">
          {t("settings.form.iosPush.relayUrlHelp")}
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="apns-relay-key">{t("settings.form.iosPush.relayKey")} <span className="text-zinc-500 font-normal">{t("settings.form.common.optional")}</span></Label>
        <div className="flex items-center gap-2">
          <Input
            id="apns-relay-key"
            type="password"
            autoComplete="new-password"
            data-1p-ignore
            data-lpignore="true"
            value={relayKey}
            onChange={(e) => { setRelayKey(e.target.value); setRemoveKey(false); edited(); }}
            placeholder={keyIsSet && !removeKey ? SECRET_MASK_SENTINEL : undefined}
            className="bg-zinc-800 border-zinc-700 font-mono"
          />
          {/* Remove clears the field and marks a saved key for deletion (the
              delete happens on Save), so it has nothing to do once both are
              done — hide it then rather than leave a button that does nothing. */}
          {(relayKey.length > 0 || (keyIsSet && !removeKey)) && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => { setRelayKey(""); setRemoveKey(keyIsSet); edited(); }}
              className="border-zinc-700 text-zinc-400 hover:text-zinc-100 shrink-0 gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5" aria-hidden />
              {t("settings.form.common.remove")}
            </Button>
          )}
        </div>
        <p className="text-xs text-zinc-500">
          {t("settings.form.iosPush.relayKeyHelp")}
          {keyIsSet && !removeKey && ` ${t("settings.form.iosPush.keyIsSet")}`}
          {removeKey && ` ${t("settings.form.iosPush.keyWillBeRemoved")}`}
        </p>
      </div>
      <div className="space-y-1.5 max-w-[220px]">
        <Label htmlFor="recommended-ios-build">{t("settings.form.iosPush.recommendedBuild")} <span className="text-zinc-500 font-normal">{t("settings.form.common.optional")}</span></Label>
        <Input
          id="recommended-ios-build"
          type="number"
          min="1"
          max="1000000"
          value={recommendedBuild}
          onChange={(e) => { setRecommendedBuild(e.target.value); edited(); }}
          placeholder={t("settings.form.iosPush.recommendedBuildPlaceholder")}
          className="bg-zinc-800 border-zinc-700"
        />
        <p className="text-xs text-zinc-500">
          {t("settings.form.iosPush.recommendedBuildHelp")}
        </p>
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <Button type="submit" disabled={status === "saving"} className="bg-indigo-600 hover:bg-indigo-500">
          {status === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("settings.form.common.saving")}</> : t("settings.form.common.save")}
        </Button>
        <SaveStatusMessage status={status} errorLabel={errorMessage || t("settings.form.common.saveFailed")} />
      </div>
    </form>
  );
}
