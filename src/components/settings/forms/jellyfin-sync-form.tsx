"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, RefreshCcw } from "@/components/icons";
import { useT } from "@/components/i18n/i18n-provider";
import { SECRET_MASK_SENTINEL } from "@/lib/secret-mask";
import {
  LibraryImportResult,
  LibraryPicker,
  SaveAndTestLabel,
  SaveAndTestResult,
  useLibraryImport,
  useLibraryLoader,
  useServerSaveAndTest,
} from "./media-server-library";

interface JellyfinSyncFormProps {
  initialUrl: string;
  initialApiKey: string;
  initialJellyfinLibraries: string;
}

export function JellyfinSyncForm({ initialUrl, initialApiKey, initialJellyfinLibraries }: JellyfinSyncFormProps) {
  const t = useT();
  const [url,    setUrl]    = useState(initialUrl);
  // Write-only: the field starts EMPTY (the mask is only its placeholder, so a
  // typed edit can never be the mask plus text); blank means "keep the saved key".
  const [apiKey, setApiKey] = useState("");
  const [keySaved, setKeySaved] = useState(initialApiKey.length > 0);
  // Whether the server holds a SAVED Jellyfin URL + key. /api/sync/jellyfin
  // syncs the stored config, not what is typed in the fields, so the Sync
  // button must follow this and not the inputs: on a fresh install the typed,
  // unsaved credentials used to show a Sync button whose click answered
  // "server not configured" (guardrail 36 — decide configured-ness before the
  // request). Starts from the page-load props and flips after a successful save.
  const [configured, setConfigured] = useState(Boolean(initialUrl && initialApiKey));
  const libraries = useLibraryLoader("jellyfin", Boolean(initialUrl && initialApiKey));
  const server = useServerSaveAndTest("jellyfin", libraries.loadNewest);
  // { full: true } asks for a full sync: delete this server's library rows and
  // rebuild them (like the Plex form's "Import from Plex" button). Without it
  // the route only adds items changed in the last 2 hours and never removes old
  // rows, so it could not fix a library that is out of date.
  const sync = useLibraryImport("jellyfin");
  // The last library selection saved this session; a remounted picker starts
  // from it, not from the page-load value.
  const [savedLibraries, setSavedLibraries] = useState(initialJellyfinLibraries);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const sentKey = apiKey;
    const stored = await server.saveAndTest({ jellyfinUrl: url, jellyfinApiKey: apiKey || SECRET_MASK_SENTINEL }, (r) =>
      // A 422 with `jellyfinError` means the server tested the new URL/key
      // before writing and the test failed — nothing was saved.
      (typeof r.data.jellyfinError === "string" && r.data.jellyfinError) || r.error || t("settings.form.common.saveFailed"));
    // The route only answers ok after its own connection test passed and the
    // values were written, so the stored config is now usable by Sync.
    if (stored) {
      setConfigured(true);
      setKeySaved(true);
      setApiKey((k) => (k === sentKey ? "" : k));
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={handleSave} className="space-y-4">
        <div className="lg:grid lg:grid-cols-2 lg:gap-4 space-y-4 lg:space-y-0">
          <div className="space-y-1.5">
            <Label htmlFor="jellyfin-url">{t("settings.form.jellyfin.serverUrl")}</Label>
            <Input
              id="jellyfin-url"
              type="url"
              value={url}
              onChange={(e) => { setUrl(e.target.value); server.edited(); }}
              placeholder="http://192.168.1.100:8096"
              className="bg-zinc-800 border-zinc-700 font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="jellyfin-api-key">{t("settings.form.common.apiKey")}</Label>
            <Input
              id="jellyfin-api-key"
              type="password"
              autoComplete="new-password"
              data-1p-ignore
              data-lpignore="true"
              value={apiKey}
              onChange={(e) => { setApiKey(e.target.value); server.edited(); }}
              placeholder={keySaved ? SECRET_MASK_SENTINEL : t("settings.form.jellyfin.apiKeyPlaceholder")}
              className="bg-zinc-800 border-zinc-700 font-mono"
            />
            <p className="text-xs text-zinc-500">
              {t("settings.form.jellyfin.apiKeyHelp")}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <Button
            type="submit"
            disabled={server.status === "saving" || server.status === "testing" || !url || (!apiKey && !keySaved)}
            className="bg-indigo-600 hover:bg-indigo-500"
          >
            <SaveAndTestLabel status={server.status} />
          </Button>
          <SaveAndTestResult status={server.status} message={server.message} librariesCount={server.librariesCount} />

          {configured && (
            <Button
              type="button"
              onClick={() => void sync.runImport()}
              disabled={sync.running}
              variant="outline"
              className="border-zinc-700 text-zinc-300 hover:text-zinc-100"
            >
              {sync.running ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("settings.form.common.syncing")}</>
              ) : (
                <><RefreshCcw className="w-4 h-4 mr-2" />{t("settings.form.jellyfin.syncLibrary")}</>
              )}
            </Button>
          )}
        </div>

        <LibraryImportResult state={sync.state} failedText={t("settings.form.jellyfin.syncFailed")} />
      </form>

      {/* The picker lists the SAVED server's libraries, so it follows the saved
          config like the Sync button does — not the inputs, whose clearing (to
          retype the masked key) used to unmount it (guardrail 36). */}
      {configured && (
        <LibraryPicker
          service="jellyfin"
          initialSelected={savedLibraries}
          items={libraries.items}
          loadStatus={libraries.status}
          errorMessage={libraries.error}
          onSaved={setSavedLibraries}
        />
      )}
    </div>
  );
}
