"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { StyledSelect } from "@/components/ui/styled-select";
import { Textarea } from "@/components/ui/textarea";
import { Chip } from "@/components/ui/design";
import { CheckCircle, Loader2, Trash2, XCircle } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { fetchJson, jsonInit } from "@/lib/client/fetch-json";
import { useAsyncAction } from "@/hooks/use-async-action";
import { useT } from "@/components/i18n/i18n-provider";
import { AGENT_KINDS, NOTIFY_EVENT_KEYS, TEMPLATE_FIELDS, type AgentKind } from "@/lib/notify-events";
import {
  DEFAULT_PRIORITY,
  TestAnswer,
  allEventsSelected,
  bodyFrom,
  draftFrom,
  emptyDraft,
  readAgents,
  type AgentView,
  type Draft,
} from "./notification-agents-data";

// Admin UI for the outbound notification channels (webhook / ntfy / Gotify).
// Secrets are write-only: the list carries `hasSecret`, and a blank secret field
// on edit means "keep the saved value".

interface TestResult {
  ok: boolean;
  text: string;
}

// Literal keys so the i18n dead-string check can see them.
const EVENT_LABEL_KEYS: Record<(typeof NOTIFY_EVENT_KEYS)[number], string> = {
  "request.created": "settings.form.agents.event.request.created",
  "request.approved": "settings.form.agents.event.request.approved",
  "request.declined": "settings.form.agents.event.request.declined",
  "request.available": "settings.form.agents.event.request.available",
  "request.comment": "settings.form.agents.event.request.comment",
  "issue.created": "settings.form.agents.event.issue.created",
  "issue.reply": "settings.form.agents.event.issue.reply",
  "issue.resolved": "settings.form.agents.event.issue.resolved",
  "vote.threshold": "settings.form.agents.event.vote.threshold",
  "arr.manual_interaction": "settings.form.agents.event.arr.manual_interaction",
  "arr.grab_completed": "settings.form.agents.event.arr.grab_completed",
  "arr.health": "settings.form.agents.event.arr.health",
  "arr.health_restored": "settings.form.agents.event.arr.health_restored",
  "arr.disk_low": "settings.form.agents.event.arr.disk_low",
  "arr.disk_ok": "settings.form.agents.event.arr.disk_ok",
  "arr.download_failed": "settings.form.agents.event.arr.download_failed",
  "arr.queue_attention": "settings.form.agents.event.arr.queue_attention",
  "stream.concurrent": "settings.form.agents.event.stream.concurrent",
};

function withoutKey<T>(rec: Record<string, T>, key: string): Record<string, T> {
  if (!(key in rec)) return rec;
  const next = { ...rec };
  delete next[key];
  return next;
}

export function NotificationAgentsManager({ featureEnabled }: { featureEnabled: boolean }) {
  const t = useT();
  const [agents, setAgents] = useState<AgentView[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  // Set by an edit in the form (patchDraft), not by a list toggle mirrored into
  // it — only the admin's own edits are worth a "discard?" prompt.
  const [draftDirty, setDraftDirty] = useState(false);
  // An Edit clicked while the open form has unsaved edits: held here until the
  // admin confirms in the row's panel.
  const [pendingDraft, setPendingDraft] = useState<Draft | null>(null);
  // Bumped on every open, so the effect below can move focus into the form.
  const [draftOpenSeq, setDraftOpenSeq] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const [saving, setSaving] = useState(false);
  // The channel a Delete is in flight for: its open form can't save meanwhile
  // (the PATCH would 404 on a channel that is going away).
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [formError, setFormError] = useState("");
  // List-level actions (delete) have no form to report into.
  const [actionError, setActionError] = useState("");
  // Per channel: two tests can overlap, and one finishing must not clear the
  // other's result. The spinner is the action's own busy key (test:<id>).
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  // Per channel: a toggle answered after a newer toggle of the same channel
  // must not roll the switch back over it.
  const toggleSeq = useRef<Record<string, number>>({});
  // Id of the channel whose Delete is waiting for confirmation — the same
  // inline red panel the arr/media managers use, instead of window.confirm.
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // The form closes on save, so without this an edit leaves the list looking
  // exactly as before with no sign the change took.
  const [saved, setSaved] = useState(false);
  // Every reload goes through one key: a newer one aborts the older, so an
  // older list (still showing a deleted channel, or an older lastStatus) can
  // never land over a newer one.
  const action = useAsyncAction();
  // Nothing has come back yet (neither the list nor a failure).
  const loading = agents === null && !loadError;

  const load = useCallback(async () => {
    const res = await action.run("load", (signal) => fetchJson(withBasePath("/api/admin/notification-agents"), { signal }));
    if (res === undefined) return;
    const list = res.ok ? readAgents(res.data) : null;
    if (!list) {
      setLoadError(true);
      return;
    }
    setAgents(list);
    setLoadError(false);
  }, [action]);

  useEffect(() => { void load(); }, [load]);

  // The form renders below the whole list: move focus to its first editable
  // field (scrolling it into view) so keyboard and screen-reader users land in
  // the form they just opened.
  useEffect(() => {
    if (draftOpenSeq === 0) return;
    formRef.current?.querySelector<HTMLElement>("input:not([disabled]), select:not([disabled]), textarea:not([disabled])")?.focus();
  }, [draftOpenSeq]);

  function patchDraft(p: Partial<Draft>) {
    setDraft((d) => (d ? { ...d, ...p } : d));
    setDraftDirty(true);
    setFormError("");
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!draft || saving || (draft.id !== null && draft.id === deletingId)) return;
    setSaving(true);
    setFormError("");
    setSaved(false);
    const res = await fetchJson(withBasePath(draft.id ? `/api/admin/notification-agents/${draft.id}` : "/api/admin/notification-agents"), {
      init: jsonInit(draft.id ? "PATCH" : "POST", bodyFrom(draft)),
      fallbackError: t("settings.form.common.saveFailed"),
    });
    // A 2xx that isn't JSON still saved.
    if (!res.ok && res.kind !== "invalid") {
      setFormError(res.error || t("settings.form.common.saveFailed"));
      setSaving(false);
      return;
    }
    closeDraft();
    setSaving(false);
    await load();
    setSaved(true);
  }

  function openDraft(d: Draft, opts: { discard?: boolean } = {}) {
    setConfirmDelete(null);
    if (draft && draftDirty && !opts.discard) {
      // The same channel's form is already open with the edits: keep them.
      if (d.id !== null && d.id === draft.id) {
        setPendingDraft(null);
        setDraftOpenSeq((n) => n + 1);
        return;
      }
      setPendingDraft(d);
      return;
    }
    setPendingDraft(null);
    setDraft(d);
    setDraftDirty(false);
    setFormError("");
    setSaved(false);
    setDraftOpenSeq((n) => n + 1);
  }

  function closeDraft() {
    setDraft(null);
    setDraftDirty(false);
    setPendingDraft(null);
    setFormError("");
  }

  // The edit form is a snapshot taken at "Edit" and its save sends the full
  // field set, so a list toggle has to reach the open draft too — otherwise the
  // stale `enabled` there silently undoes the toggle on the next save.
  function mirrorEnabled(id: string, enabled: boolean) {
    setAgents((list) => list?.map((x) => (x.id === id ? { ...x, enabled } : x)) ?? list);
    setDraft((d) => (d && d.id === id ? { ...d, enabled } : d));
  }

  async function toggleEnabled(a: AgentView, next: boolean) {
    const seq = (toggleSeq.current[a.id] ?? 0) + 1;
    toggleSeq.current[a.id] = seq;
    setActionError("");
    mirrorEnabled(a.id, next);
    const res = await fetchJson(withBasePath(`/api/admin/notification-agents/${a.id}`), {
      init: jsonInit("PATCH", { enabled: next }),
      fallbackError: t("settings.form.common.requestFailed"),
    });
    if (res.ok || res.kind === "invalid") return;
    // A newer toggle of this channel owns the switch now; it reports its own outcome.
    if (toggleSeq.current[a.id] !== seq) return;
    // A switch that just flips back reads as a UI glitch; say why.
    setActionError(res.error || t("settings.form.common.requestFailed"));
    // Roll both back before the reload: load() can itself fail and would
    // otherwise leave the optimistic state standing.
    mirrorEnabled(a.id, !next);
    await load();
  }

  // Reached only from the confirm panel's Delete button — the row's trash
  // button just opens that panel.
  async function remove(a: AgentView) {
    setConfirmDelete(null);
    // Not while this channel's own form is saving: the delete would race the PATCH.
    if (saving && draft?.id === a.id) return;
    setDeletingId(a.id);
    setActionError("");
    setSaved(false);
    const res = await fetchJson(withBasePath(`/api/admin/notification-agents/${a.id}`), {
      init: { method: "DELETE" },
      fallbackError: t("settings.form.common.requestFailed"),
    });
    setDeletingId(null);
    if (res.ok || res.kind === "invalid") {
      if (draft?.id === a.id) closeDraft();
      setPendingDraft((d) => (d && d.id === a.id ? null : d));
    } else {
      // A silent failure reads as a UI glitch; say the delete did not happen.
      setActionError(res.error || t("settings.form.common.requestFailed"));
    }
    await load();
  }

  async function test(a: AgentView) {
    setTestResults((r) => withoutKey(r, a.id));
    const res = await action.run(`test:${a.id}`, (signal) => fetchJson(withBasePath(`/api/admin/notification-agents/${a.id}/test`), {
      init: { method: "POST" },
      schema: TestAnswer,
      signal,
    }), { ifBusy: "skip" });
    if (res === undefined) return;
    let result: TestResult;
    if (res.ok && res.data.ok) {
      result = { ok: true, text: t("settings.form.agents.testOk", { status: res.data.status ?? 200 }) };
    } else if (res.ok || res.kind === "http") {
      const err = (res.ok ? res.data.error : res.error) || t("settings.form.common.testFailed");
      result = { ok: false, text: t("settings.form.agents.testFailed", { error: err }) };
    } else {
      result = { ok: false, text: t("settings.form.common.testFailed") };
    }
    setTestResults((r) => ({ ...r, [a.id]: result }));
    void load();
  }

  return (
    <div className="space-y-4">
      {!featureEnabled && (
        <p className="text-sm rounded-md px-3 py-2 bg-amber-500/10 text-amber-400">{t("settings.form.agents.featureOff")}</p>
      )}

      {loadError && <p role="alert" className="text-sm text-red-400">{t("settings.form.agents.loadFailed")}</p>}
      {actionError && <p role="alert" className="text-sm text-red-400">{actionError}</p>}

      {/* Same loading line as the arr/media managers. Without it the card
          showed only "Add channel" until the GET resolved, which reads as
          "none configured", and the list then pushed the button down. */}
      {loading && (
        <p className="text-sm text-zinc-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />{t("settings.instances.loading")}</p>
      )}

      {agents && agents.length === 0 && !draft && (
        <p className="text-sm text-zinc-500">{t("settings.form.agents.empty")}</p>
      )}

      {agents && agents.length > 0 && (
        <ul className="divide-y divide-zinc-800 rounded-md border border-zinc-800">
          {agents.map((a) => (
            <AgentRow
              key={a.id}
              agent={a}
              testing={action.busy(`test:${a.id}`)}
              testResult={testResults[a.id]}
              confirmingDelete={confirmDelete === a.id}
              pendingDraft={pendingDraft?.id === a.id ? pendingDraft : null}
              onToggle={(next) => void toggleEnabled(a, next)}
              onTest={() => void test(a)}
              onEdit={() => openDraft(draftFrom(a))}
              onToggleDelete={() => { setPendingDraft(null); setConfirmDelete(confirmDelete === a.id ? null : a.id); }}
              onCancelDelete={() => setConfirmDelete(null)}
              onDelete={() => void remove(a)}
              onDiscardAndEdit={(d) => openDraft(d, { discard: true })}
              onKeepEditing={() => setPendingDraft(null)}
            />
          ))}
        </ul>
      )}

      {saved && !draft && (
        <p role="status" className="text-sm text-green-400 flex items-center gap-1.5"><CheckCircle className="w-4 h-4 shrink-0" />{t("settings.form.common.saved")}</p>
      )}

      {/* Hidden until the list is known, like the siblings — adding into an
          unloaded list put a new draft above channels that then popped in. */}
      {!draft && !loading && (
        <Button type="button" onClick={() => openDraft(emptyDraft())}>
          {t("settings.form.agents.add")}
        </Button>
      )}

      {/* noValidate: a malformed URL reaches the server and comes back as its
          own message in formError, the same inline red line the arr/media
          cards show — not the browser's unstyled "Please enter a URL" bubble. */}
      {draft && (
        <form ref={formRef} onSubmit={save} noValidate className="space-y-4 rounded-md border border-zinc-800 p-4">
          {/* Locked while the save is in flight: the form closes on success,
              so anything typed meanwhile would be silently dropped. */}
          <fieldset disabled={saving} className="min-w-0 space-y-4">
            <AgentFormFields draft={draft} patchDraft={patchDraft} />
          </fieldset>

          {formError && <p role="alert" className="text-sm text-red-400">{formError}</p>}

          <div className="flex items-center gap-2">
            <Button type="submit" disabled={saving || (draft.id !== null && draft.id === deletingId)}>
              {saving ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("settings.form.common.saving")}</> : t("settings.form.common.save")}
            </Button>
            <Button type="button" variant="outline" className="border-zinc-700" onClick={closeDraft}>
              {t("settings.form.common.cancel")}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

// One channel in the list: its switch, status, test result, actions and the
// two inline confirm panels (discard edits, delete).
function AgentRow({
  agent: a,
  testing,
  testResult,
  confirmingDelete,
  pendingDraft,
  onToggle,
  onTest,
  onEdit,
  onToggleDelete,
  onCancelDelete,
  onDelete,
  onDiscardAndEdit,
  onKeepEditing,
}: {
  agent: AgentView;
  testing: boolean;
  testResult: TestResult | undefined;
  confirmingDelete: boolean;
  pendingDraft: Draft | null;
  onToggle: (next: boolean) => void;
  onTest: () => void;
  onEdit: () => void;
  onToggleDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
  onDiscardAndEdit: (d: Draft) => void;
  onKeepEditing: () => void;
}) {
  const t = useT();
  return (
    <li className="flex flex-wrap items-center gap-3 px-3 py-2.5">
      <Switch
        checked={a.enabled}
        onCheckedChange={onToggle}
        size="sm"
        // Named per row — "Enabled" ×N tells a screen reader nothing
        // about which channel each switch belongs to.
        aria-label={t("settings.form.agents.enabledFor", { name: a.name })}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-zinc-100">{a.name}</span>
          <Chip tone="neutral">{t(`settings.form.agents.kind.${a.kind}`)}</Chip>
        </div>
        <p className="text-xs text-zinc-500">
          {t("settings.form.agents.eventsCount", { count: a.events.length })}
          {" · "}
          {a.lastStatus === "ok" && <span className="text-green-400">{t("settings.form.agents.status.ok")}</span>}
          {a.lastStatus === "failed" && <span className="text-red-400">{t("settings.form.agents.status.failed", { error: a.lastError ?? "" })}</span>}
          {!a.lastStatus && t("settings.form.agents.status.never")}
        </p>
        {a.configValid === false && (
          <p className="mt-1 flex items-center gap-1 text-xs text-red-400">
            <XCircle className="w-3.5 h-3.5 shrink-0" />
            {t("settings.form.agents.status.invalidConfig")}
          </p>
        )}
        {testResult && (
          <p role="status" className={`mt-1 flex items-center gap-1 text-xs ${testResult.ok ? "text-green-400" : "text-red-400"}`}>
            {testResult.ok ? <CheckCircle className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
            {testResult.text}
          </p>
        )}
      </div>
      {/* Own line under ~640px: the three buttons are ~175px, and with
          the switch and gaps the name column was squeezed to ~45px
          at 375px — the flex-1 text shrank instead of the row wrapping. */}
      <div className="flex basis-full items-center gap-2 sm:basis-auto">
        {/* The label stays while testing (spinner in front) so the
            button keeps its name and width instead of collapsing to
            an unnamed 14px icon. */}
        <Button type="button" variant="outline" size="sm" className="border-zinc-700" disabled={testing} aria-busy={testing} onClick={onTest}>
          {testing && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {t("settings.form.agents.test")}
        </Button>
        <Button type="button" variant="outline" size="sm" className="border-zinc-700" onClick={onEdit}>
          {t("settings.form.agents.edit")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="border-zinc-700 text-red-400 hover:text-[var(--ds-danger-hover)]"
          aria-label={t("settings.form.agents.delete")}
          aria-expanded={confirmingDelete}
          onClick={onToggleDelete}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
      </div>

      {/* Edit while the open form has unsaved edits: the same inline
          panel as Delete, instead of silently dropping them. */}
      {pendingDraft && (
        <div className="basis-full rounded-md border border-red-500/40 bg-red-500/10 p-3 space-y-2">
          <p className="text-xs text-red-400">{t("settings.form.agents.confirmDiscard")}</p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onDiscardAndEdit(pendingDraft)}
              autoFocus
              className="inline-flex items-center gap-1 rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)] transition-colors"
            >
              {t("settings.form.agents.discardAndEdit")}
            </button>
            <button
              type="button"
              onClick={onKeepEditing}
              className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
            >
              {t("settings.form.agents.keepEditing")}
            </button>
          </div>
        </div>
      )}

      {/* Unlike the arr/media managers' Remove (which lands on Save),
          this DELETE fires at once — the panel says so. */}
      {confirmingDelete && (
        <div className="basis-full rounded-md border border-red-500/40 bg-red-500/10 p-3 space-y-2">
          <p className="text-xs text-red-400">
            {t("settings.form.agents.confirmDelete", { name: a.name })}{" "}
            <strong>{t("settings.form.agents.confirmDeleteNow")}</strong>
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onDelete}
              autoFocus
              className="inline-flex items-center gap-1 rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)] transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />{t("settings.form.agents.delete")}
            </button>
            <button
              type="button"
              onClick={onCancelDelete}
              className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
            >
              {t("settings.form.common.cancel")}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

// The edit form's fields; which ones show depends on the channel's kind.
function AgentFormFields({ draft, patchDraft }: { draft: Draft; patchDraft: (p: Partial<Draft>) => void }) {
  const t = useT();
  const allSelected = allEventsSelected(draft.events);
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="agent-kind">{t("settings.form.agents.field.kind")}</Label>
          <StyledSelect
            id="agent-kind"
            value={draft.kind}
            disabled={!!draft.id}
            onChange={(e) => {
              const kind = AGENT_KINDS.find((k) => k === e.target.value);
              if (kind) patchDraft({ kind, priority: DEFAULT_PRIORITY[kind] });
            }}
          >
            {AGENT_KINDS.map((k: AgentKind) => (
              <option key={k} value={k}>{t(`settings.form.agents.kind.${k}`)}</option>
            ))}
          </StyledSelect>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="agent-name">{t("settings.form.agents.field.name")}</Label>
          <Input id="agent-name" value={draft.name} maxLength={100} onChange={(e) => patchDraft({ name: e.target.value })} className="bg-zinc-800 border-zinc-700" />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="agent-url">{t("settings.form.agents.field.url")}</Label>
        <Input id="agent-url" type="url" value={draft.url} onChange={(e) => patchDraft({ url: e.target.value })} placeholder={draft.kind === "ntfy" ? "https://ntfy.sh" : draft.kind === "gotify" ? "https://gotify.example.com" : "https://example.com/hook"} className="bg-zinc-800 border-zinc-700 font-mono" />
        <p className="text-xs text-zinc-500">{t(`settings.form.agents.urlHelp.${draft.kind}`)}</p>
      </div>

      {draft.kind === "ntfy" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="agent-topic">{t("settings.form.agents.field.topic")}</Label>
            <Input id="agent-topic" value={draft.topic} maxLength={64} onChange={(e) => patchDraft({ topic: e.target.value })} className="bg-zinc-800 border-zinc-700 font-mono" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="agent-priority">{t("settings.form.agents.field.priority")}</Label>
            <Input id="agent-priority" type="number" min={1} max={5} value={draft.priority} onChange={(e) => patchDraft({ priority: e.target.value })} className="bg-zinc-800 border-zinc-700" />
          </div>
          <label className="flex items-center gap-2 text-sm text-zinc-400 sm:col-span-2">
            <input type="checkbox" checked={draft.attachPoster} onChange={(e) => patchDraft({ attachPoster: e.target.checked })} />
            {t("settings.form.agents.field.attachPoster")}
          </label>
        </div>
      )}

      {draft.kind === "gotify" && (
        <div className="space-y-1.5 max-w-[220px]">
          <Label htmlFor="agent-priority">{t("settings.form.agents.field.priority")}</Label>
          <Input id="agent-priority" type="number" min={0} max={10} value={draft.priority} onChange={(e) => patchDraft({ priority: e.target.value })} className="bg-zinc-800 border-zinc-700" />
        </div>
      )}

      {draft.kind === "webhook" && (
        <div className="space-y-1.5 max-w-[320px]">
          <Label htmlFor="agent-header">{t("settings.form.agents.field.headerName")}</Label>
          <Input id="agent-header" value={draft.headerName} maxLength={64} onChange={(e) => patchDraft({ headerName: e.target.value })} className="bg-zinc-800 border-zinc-700 font-mono" />
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="agent-secret">
          {t(`settings.form.agents.field.secret.${draft.kind}`)}
          {draft.kind !== "gotify" && <span className="text-zinc-500 font-normal"> {t("settings.form.common.optional")}</span>}
        </Label>
        <div className="flex items-center gap-2">
          <Input
            id="agent-secret"
            type="password"
            // "off" is ignored on password fields; new-password is what keeps
            // a browser from filling the Summonarr login into a channel token.
            autoComplete="new-password"
            data-1p-ignore
            data-lpignore="true"
            value={draft.secret}
            disabled={draft.clearSecret}
            onChange={(e) => patchDraft({ secret: e.target.value })}
            placeholder={draft.hasSecret && !draft.clearSecret ? "••••••••" : ""}
            className="bg-zinc-800 border-zinc-700 font-mono"
          />
          {/* "Clear token", no trash glyph: the Trash2 + "Remove" look is
              the row's delete-the-channel affordance; this only drops the
              saved token on the next Save. */}
          {draft.hasSecret && draft.kind !== "gotify" && (
            <Button type="button" variant="outline" size="sm" className="border-zinc-700 text-zinc-400 hover:text-zinc-100 shrink-0" onClick={() => patchDraft({ clearSecret: !draft.clearSecret, secret: "" })}>
              {draft.clearSecret ? t("settings.form.common.cancel") : t("settings.form.agents.clearSecret")}
            </Button>
          )}
        </div>
        {draft.hasSecret && !draft.clearSecret && <p className="text-xs text-zinc-500">{t("settings.form.agents.secretKeep")}</p>}
      </div>

      {draft.kind === "webhook" && (
        <div className="space-y-1.5">
          <Label htmlFor="agent-template">{t("settings.form.agents.field.template")}</Label>
          <Textarea
            id="agent-template"
            value={draft.template}
            onChange={(e) => patchDraft({ template: e.target.value })}
            rows={5}
            spellCheck={false}
            placeholder={'{ "content": "{{title}} — {{message}}" }'}
            className="bg-zinc-800 border-zinc-700 font-mono md:text-xs"
          />
          <p className="text-xs text-zinc-500">{t("settings.form.agents.templateHelp", { fields: TEMPLATE_FIELDS.map((f) => `{{${f}}}`).join(" ") })}</p>
        </div>
      )}

      {/* <legend> must be the fieldset's FIRST child to name the checkbox
          group for AT; nested in a div it was plain text. Select all sits
          on its own row beneath it. */}
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-zinc-100">{t("settings.form.agents.field.events")}</legend>
        <div className="flex justify-end">
          <button
            type="button"
            className="min-h-8 px-2 -my-2 -mr-2 text-xs text-indigo-400 hover:underline"
            onClick={() => patchDraft({ events: allSelected ? [] : [...NOTIFY_EVENT_KEYS] })}
          >
            {allSelected ? t("settings.form.agents.selectNone") : t("settings.form.agents.selectAll")}
          </button>
        </div>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {NOTIFY_EVENT_KEYS.map((ev) => (
            <label key={ev} className="flex items-center gap-2 text-sm text-zinc-400">
              <input
                type="checkbox"
                checked={draft.events.includes(ev)}
                onChange={(e) => patchDraft({ events: e.target.checked ? [...draft.events, ev] : draft.events.filter((x) => x !== ev) })}
              />
              {t(EVENT_LABEL_KEYS[ev])}
            </label>
          ))}
        </div>
      </fieldset>

      <label className="flex items-center gap-2 text-sm text-zinc-400">
        <Switch checked={draft.enabled} onCheckedChange={(next) => patchDraft({ enabled: next })} size="sm" />
        {t("settings.form.agents.field.enabled")}
      </label>
    </>
  );
}
