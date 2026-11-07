"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Trash2 } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import { useSettingsSave } from "./shared";
import { useT } from "@/components/i18n/i18n-provider";

interface IosPushRelayFormProps {
  initialRelayUrl: string;
  initialRelayKey: string; // masked placeholder when set, "" when not
  initialRecommendedBuild: string;
}

export function IosPushRelayForm({ initialRelayUrl, initialRelayKey, initialRecommendedBuild }: IosPushRelayFormProps) {
  const t = useT();
  const [relayUrl, setRelayUrl] = useState(initialRelayUrl);
  const [relayKey, setRelayKey] = useState(initialRelayKey);
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
    const result = await save({
      // If this is still the masked placeholder the server ignores it; "" deletes the key.
      apnsRelayKey: relayKey,
      // "" deletes the recommendation.
      recommendedIosBuild: recommendedBuild.trim(),
      // "" deletes the custom URL, so push goes back to the default relay
      // (which is what the "leave blank for the default" hint promises).
      apnsRelayUrl: relayUrl.trim(),
    });
    if (result.ok) {
      // Masked placeholder = key left as is (still set); "" = key removed;
      // anything else = a new key was saved.
      setKeyIsSet(relayKey.length > 0);
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
            onChange={(e) => { setRelayKey(e.target.value); edited(); }}
            placeholder="••••••••"
            className="bg-zinc-800 border-zinc-700 font-mono"
          />
          {/* Remove only clears the field (the delete happens on Save), so it
              has nothing to do once the field is already empty — hide it then
              rather than leave a button that does nothing. */}
          {relayKey.length > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => { setRelayKey(""); edited(); }}
              className="border-zinc-700 text-zinc-400 hover:text-zinc-100 shrink-0 gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5" aria-hidden />
              {t("settings.form.common.remove")}
            </Button>
          )}
        </div>
        <p className="text-xs text-zinc-500">
          {t("settings.form.iosPush.relayKeyHelp")}
          {keyIsSet && ` ${t("settings.form.iosPush.keyIsSet")}`}
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
