"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { XCircle, Loader2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { fetchJson, jsonInit } from "@/lib/client/fetch-json";
import { check, v } from "@/lib/validate";
import { formatAllowlistLines, parseDomainLines, parseGroupLines, type OidcAllowlist } from "@/lib/oidc-allowlist";
import { useSettingsSave, type SettingsPatchResult } from "./shared";
import { useT } from "@/components/i18n/i18n-provider";
import { rich } from "./rich";
import { SaveStatusMessage } from "./save-status";

// Admin → Settings → Authentication: who may sign in through OIDC (guardrail
// 34e, src/lib/oidc-allowlist.ts). Saved whole through PATCH
// /api/admin/oidc-allowlist; the server validates and answers with what it
// stored, which becomes the new baseline. The text boxes parse through the
// shared helpers: groups split on newlines only (a comma can be part of a name).

// What the route answers with: the allowlist it stored. Checked, because every
// field of the form is rewritten from it.
const StoredAllowlist = v.object({
  allowlist: v.object({
    groups: v.array(v.string()),
    groupsClaim: v.string(),
    requestGroupsScope: v.boolean(),
    emailDomains: v.array(v.string()),
    existingUsersOnly: v.boolean(),
  }),
});

// The shared save state machine (forms/shared.ts), over this form's own route.
// Saved means a 2xx that carries the stored allowlist.
async function patchAllowlist(body: Record<string, unknown>): Promise<SettingsPatchResult> {
  const res = await fetchJson(withBasePath("/api/admin/oidc-allowlist"), { init: jsonInit("PATCH", body) });
  if (!res.ok) {
    const data = typeof res.body === "object" && res.body !== null && !Array.isArray(res.body) ? (res.body as Record<string, unknown>) : {};
    return { ok: false, status: res.status, data, error: res.error };
  }
  const stored = check(StoredAllowlist, res.data);
  return stored.ok
    ? { ok: true, status: res.status, data: stored.value, error: "" }
    : { ok: false, status: res.status, data: {}, error: "" };
}

export function OidcAllowlistForm({
  initial,
  initialUnreadable,
  oidcConfigured,
}: {
  initial: OidcAllowlist;
  initialUnreadable: boolean;
  oidcConfigured: boolean;
}) {
  const t = useT();
  const [saved, setSaved] = useState(initial);
  const [unreadable, setUnreadable] = useState(initialUnreadable);
  const [groups, setGroups] = useState(formatAllowlistLines(initial.groups));
  const [groupsClaim, setGroupsClaim] = useState(initial.groupsClaim);
  const [requestGroupsScope, setRequestGroupsScope] = useState(initial.requestGroupsScope);
  const [emailDomains, setEmailDomains] = useState(formatAllowlistLines(initial.emailDomains));
  const [existingUsersOnly, setExistingUsersOnly] = useState(initial.existingUsersOnly);
  // The route's own reason for a refusal, else "Failed to save".
  const { status, message, save, edited } = useSettingsSave(3000, patchAllowlist);
  const titleId = useId();
  const descId = useId();
  const groupsId = useId();
  const claimId = useId();
  const scopeId = useId();
  const domainsId = useId();
  const existingId = useId();

  const draft: OidcAllowlist = {
    groups: parseGroupLines(groups),
    groupsClaim: groupsClaim.trim() || "groups",
    requestGroupsScope,
    emailDomains: parseDomainLines(emailDomains),
    existingUsersOnly,
  };
  // An unreadable stored value is always worth re-saving, edited or not.
  const dirty = unreadable || JSON.stringify(draft) !== JSON.stringify(saved);
  // The controls lock while a save is in flight: its answer replaces every
  // field with what the server stored, which would silently drop anything
  // typed meanwhile.
  const saving = status === "saving";

  async function handleSave() {
    const result = await save({ ...draft }, () => t("settings.form.common.saveFailed"));
    const answer = check(StoredAllowlist, result.data);
    if (!result.ok || !answer.ok) return;
    const stored = answer.value.allowlist;
    setSaved(stored);
    setUnreadable(false);
    setGroups(formatAllowlistLines(stored.groups));
    setGroupsClaim(stored.groupsClaim);
    setRequestGroupsScope(stored.requestGroupsScope);
    setEmailDomains(formatAllowlistLines(stored.emailDomains));
    setExistingUsersOnly(stored.existingUsersOnly);
  }

  // Same row recipe as the sibling rows in the Authentication card: the card
  // owns the dividers, the row owns its padding, and errors wrap onto their own
  // full-width line instead of pushing controls off-card at 375px.
  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <p id={titleId} className="text-sm font-medium text-zinc-200">{t("settings.form.oidcAllowlist.title")}</p>
        <p id={descId} className="text-xs text-zinc-500 mt-0.5">{t("settings.form.oidcAllowlist.help")}</p>
        {!oidcConfigured && (
          <p className="text-xs text-zinc-500 mt-1">{t("settings.form.oidcAllowlist.notConfigured")}</p>
        )}
        {unreadable && (
          <p role="alert" className="flex items-center gap-1 text-xs text-red-400 mt-1">
            <XCircle className="w-3.5 h-3.5 shrink-0" aria-hidden />
            {t("settings.form.oidcAllowlist.unreadable")}
          </p>
        )}
      </div>

      <div className="mt-3 grid gap-3 pl-0.5" role="group" aria-labelledby={titleId} aria-describedby={descId}>
        <div>
          <label htmlFor={groupsId} className="block text-xs font-medium text-zinc-300">
            {t("settings.form.oidcAllowlist.groups")}
          </label>
          <p className="text-xs text-zinc-500 mt-0.5 mb-1.5">{t("settings.form.oidcAllowlist.groupsHelp")}</p>
          <Textarea
            id={groupsId}
            value={groups}
            onChange={(e) => { setGroups(e.target.value); edited(); }}
            disabled={saving}
            rows={3}
            spellCheck={false}
            className="font-mono"
          />
        </div>

        <div>
          <label htmlFor={claimId} className="block text-xs font-medium text-zinc-300">
            {t("settings.form.oidcAllowlist.groupsClaim")}
          </label>
          <p className="text-xs text-zinc-500 mt-0.5 mb-1.5">{t("settings.form.oidcAllowlist.groupsClaimHelp")}</p>
          <Input
            id={claimId}
            value={groupsClaim}
            onChange={(e) => { setGroupsClaim(e.target.value); edited(); }}
            disabled={saving}
            placeholder="groups"
            spellCheck={false}
            autoComplete="off"
            className="font-mono max-w-xs"
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="min-w-0 flex-1">
            <p id={scopeId} className="text-xs font-medium text-zinc-300">{t("settings.form.oidcAllowlist.requestGroupsScope")}</p>
            <p className="text-xs text-zinc-500 mt-0.5">
              {rich(t("settings.form.oidcAllowlist.requestGroupsScopeHelp"), {
                scope: <code className="text-zinc-400">groups</code>,
              })}
            </p>
          </div>
          <Switch
            checked={requestGroupsScope}
            onCheckedChange={(v) => { setRequestGroupsScope(v); edited(); }}
            disabled={saving}
            aria-labelledby={scopeId}
            className="shrink-0"
          />
        </div>

        <div>
          <label htmlFor={domainsId} className="block text-xs font-medium text-zinc-300">
            {t("settings.form.oidcAllowlist.emailDomains")}
          </label>
          <p className="text-xs text-zinc-500 mt-0.5 mb-1.5">
            {rich(t("settings.form.oidcAllowlist.emailDomainsHelp"), {
              example: <code className="text-zinc-400">example.com</code>,
            })}
          </p>
          <Textarea
            id={domainsId}
            value={emailDomains}
            onChange={(e) => { setEmailDomains(e.target.value); edited(); }}
            disabled={saving}
            rows={2}
            spellCheck={false}
            className="font-mono"
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="min-w-0 flex-1">
            <p id={existingId} className="text-xs font-medium text-zinc-300">{t("settings.form.oidcAllowlist.existingUsersOnly")}</p>
            <p className="text-xs text-zinc-500 mt-0.5">{t("settings.form.oidcAllowlist.existingUsersOnlyHelp")}</p>
          </div>
          <Switch
            checked={existingUsersOnly}
            onCheckedChange={(v) => { setExistingUsersOnly(v); edited(); }}
            disabled={saving}
            aria-labelledby={existingId}
            className="shrink-0"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="xs" onClick={handleSave} disabled={!dirty || saving}>
            {t("settings.form.oidcAllowlist.save")}
          </Button>
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-500" />}
          {/* The live region: a screen reader hears the save land. */}
          {status === "ok" && <SaveStatusMessage status="ok" />}
          {status === "error" && (
            <span role="alert" className="basis-full flex items-center gap-1 text-xs text-red-400">
              <XCircle className="w-3.5 h-3.5 shrink-0" aria-hidden />
              {message}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
