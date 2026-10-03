"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { StyledSelect } from "@/components/ui/styled-select";
import { CheckCircle, Loader2, Trash2, XCircle } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { useT } from "@/components/i18n/i18n-provider";
import { AGENT_KINDS, NOTIFY_EVENT_KEYS, TEMPLATE_FIELDS, type AgentKind } from "@/lib/notify-events";

// Admin UI for the outbound notification channels (webhook / ntfy / Gotify).
// Secrets are write-only: the list carries `hasSecret`, and a blank secret field
// on edit means "keep the saved value".

interface AgentView {
  id: string;
  kind: AgentKind;
  name: string;
  enabled: boolean;
  events: string[];
  config: Record<string, unknown>;
  hasSecret: boolean;
  lastStatus: string | null;
  lastError: string | null;
}

interface Draft {
  id: string | null;
  kind: AgentKind;
  name: string;
  enabled: boolean;
  events: string[];
  url: string;
  topic: string;
  priority: string;
  attachPoster: boolean;
  headerName: string;
  template: string;
  secret: string;
  clearSecret: boolean;
  hasSecret: boolean;
}

// Literal keys so the i18n dead-string check can see them.
const EVENT_LABEL_KEYS: Record<(typeof NOTIFY_EVENT_KEYS)[number], string> = {
  "request.created": "settings.form.agents.event.request.created",
  "request.approved": "settings.form.agents.event.request.approved",
  "request.declined": "settings.form.agents.event.request.declined",
  "request.available": "settings.form.agents.event.request.available",
  "issue.created": "settings.form.agents.event.issue.created",
  "issue.reply": "settings.form.agents.event.issue.reply",
  "issue.resolved": "settings.form.agents.event.issue.resolved",
  "vote.threshold": "settings.form.agents.event.vote.threshold",
  "arr.manual_interaction": "settings.form.agents.event.arr.manual_interaction",
  "arr.grab_completed": "settings.form.agents.event.arr.grab_completed",
};

const DEFAULT_PRIORITY: Record<AgentKind, string> = { webhook: "", ntfy: "3", gotify: "5" };

function emptyDraft(kind: AgentKind = "webhook"): Draft {
  return {
    id: null, kind, name: "", enabled: true, events: [...NOTIFY_EVENT_KEYS], url: "", topic: "",
    priority: DEFAULT_PRIORITY[kind], attachPoster: false, headerName: "Authorization", template: "",
    secret: "", clearSecret: false, hasSecret: false,
  };
}

function draftFrom(a: AgentView): Draft {
  const c = a.config;
  return {
    id: a.id, kind: a.kind, name: a.name, enabled: a.enabled, events: a.events,
    url: typeof c.url === "string" ? c.url : "",
    topic: typeof c.topic === "string" ? c.topic : "",
    priority: typeof c.priority === "number" ? String(c.priority) : DEFAULT_PRIORITY[a.kind],
    attachPoster: c.attachPoster === true,
    headerName: typeof c.headerName === "string" ? c.headerName : "Authorization",
    template: typeof c.template === "string" ? c.template : "",
    secret: "", clearSecret: false, hasSecret: a.hasSecret,
  };
}

function bodyFrom(d: Draft): Record<string, unknown> {
  const config: Record<string, unknown> = { url: d.url.trim() };
  if (d.kind === "webhook") {
    config.headerName = d.headerName.trim() || "Authorization";
    config.template = d.template.trim() ? d.template : null;
  } else {
    // Blank ⇒ leave the key out so the server applies its default (ntfy 3,
    // Gotify 5). Number("") is 0, which Gotify would store and ntfy would 400 on.
    const priority = d.priority.trim();
    if (priority !== "") config.priority = Number(priority);
    if (d.kind === "ntfy") {
      config.topic = d.topic.trim();
      config.attachPoster = d.attachPoster;
    }
  }
  const body: Record<string, unknown> = { name: d.name.trim(), enabled: d.enabled, events: d.events, config };
  if (!d.id) body.kind = d.kind;
  if (d.clearSecret) body.secret = null;
  else if (d.secret) body.secret = d.secret;
  return body;
}

async function errorOf(res: Response): Promise<string> {
  const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return data && typeof data.error === "string" ? data.error : "";
}

export function NotificationAgentsManager({ featureEnabled }: { featureEnabled: boolean }) {
  const t = useT();
  const [agents, setAgents] = useState<AgentView[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  // List-level actions (delete) have no form to report into.
  const [actionError, setActionError] = useState("");
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(withBasePath("/api/admin/notification-agents"));
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { agents: AgentView[] };
      setAgents(data.agents);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function patchDraft(p: Partial<Draft>) {
    setDraft((d) => (d ? { ...d, ...p } : d));
    setFormError("");
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!draft) return;
    setSaving(true);
    setFormError("");
    try {
      const res = await fetch(withBasePath(draft.id ? `/api/admin/notification-agents/${draft.id}` : "/api/admin/notification-agents"), {
        method: draft.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyFrom(draft)),
      });
      if (!res.ok) {
        setFormError((await errorOf(res)) || t("settings.form.common.saveFailed"));
        return;
      }
      setDraft(null);
      await load();
    } catch {
      setFormError(t("settings.form.common.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  // The edit form is a snapshot taken at "Edit" and its save sends the full
  // field set, so a list toggle has to reach the open draft too — otherwise the
  // stale `enabled` there silently undoes the toggle on the next save.
  function mirrorEnabled(id: string, enabled: boolean) {
    setAgents((list) => list?.map((x) => (x.id === id ? { ...x, enabled } : x)) ?? list);
    setDraft((d) => (d && d.id === id ? { ...d, enabled } : d));
  }

  async function toggleEnabled(a: AgentView, next: boolean) {
    mirrorEnabled(a.id, next);
    const res = await fetch(withBasePath(`/api/admin/notification-agents/${a.id}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    }).catch(() => null);
    if (!res?.ok) {
      // Roll both back before the reload: load() can itself fail and would
      // otherwise leave the optimistic state standing.
      mirrorEnabled(a.id, a.enabled);
      await load();
    }
  }

  async function remove(a: AgentView) {
    if (!window.confirm(t("settings.form.agents.confirmDelete", { name: a.name }))) return;
    setActionError("");
    const res = await fetch(withBasePath(`/api/admin/notification-agents/${a.id}`), { method: "DELETE" }).catch(() => null);
    if (res?.ok) {
      setDraft((d) => (d && d.id === a.id ? null : d));
    } else {
      // A silent failure reads as a UI glitch; say the delete did not happen.
      setActionError((res ? await errorOf(res) : "") || t("settings.form.common.requestFailed"));
    }
    await load();
  }

  async function test(a: AgentView) {
    setTesting(a.id);
    setTestResult(null);
    try {
      const res = await fetch(withBasePath(`/api/admin/notification-agents/${a.id}/test`), { method: "POST" });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; status?: number | null; error?: string | null } | null;
      if (res.ok && data?.ok) {
        setTestResult({ id: a.id, ok: true, text: t("settings.form.agents.testOk", { status: data.status ?? 200 }) });
      } else {
        const err = data?.error || t("settings.form.common.testFailed");
        setTestResult({ id: a.id, ok: false, text: t("settings.form.agents.testFailed", { error: err }) });
      }
    } catch {
      setTestResult({ id: a.id, ok: false, text: t("settings.form.common.testFailed") });
    } finally {
      setTesting(null);
      void load();
    }
  }

  return (
    <div className="space-y-4">
      {!featureEnabled && (
        <p className="text-sm rounded-md px-3 py-2 bg-amber-500/10 text-amber-400">{t("settings.form.agents.featureOff")}</p>
      )}

      {loadError && <p className="text-sm text-red-400">{t("settings.form.agents.loadFailed")}</p>}
      {actionError && <p className="text-sm text-red-400">{actionError}</p>}

      {agents && agents.length === 0 && !draft && (
        <p className="text-sm text-zinc-500">{t("settings.form.agents.empty")}</p>
      )}

      {agents && agents.length > 0 && (
        <ul className="divide-y divide-zinc-800 rounded-md border border-zinc-800">
          {agents.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <Switch
                checked={a.enabled}
                onCheckedChange={(next) => void toggleEnabled(a, next)}
                size="sm"
                aria-label={t("settings.form.agents.field.enabled")}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-zinc-100">{a.name}</span>
                  <span className="rounded px-1.5 py-0.5 text-[11px] bg-zinc-800 text-zinc-400">{t(`settings.form.agents.kind.${a.kind}`)}</span>
                </div>
                <p className="text-xs text-zinc-500">
                  {t("settings.form.agents.eventsCount", { count: a.events.length })}
                  {" · "}
                  {a.lastStatus === "ok" && <span className="text-green-400">{t("settings.form.agents.status.ok")}</span>}
                  {a.lastStatus === "failed" && <span className="text-red-400">{t("settings.form.agents.status.failed", { error: a.lastError ?? "" })}</span>}
                  {!a.lastStatus && t("settings.form.agents.status.never")}
                </p>
                {testResult?.id === a.id && (
                  <p className={`mt-1 flex items-center gap-1 text-xs ${testResult.ok ? "text-green-400" : "text-red-400"}`}>
                    {testResult.ok ? <CheckCircle className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                    {testResult.text}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" className="border-zinc-700" disabled={testing === a.id} onClick={() => void test(a)}>
                  {testing === a.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : t("settings.form.agents.test")}
                </Button>
                <Button type="button" variant="outline" size="sm" className="border-zinc-700" onClick={() => { setDraft(draftFrom(a)); setFormError(""); }}>
                  {t("settings.form.agents.edit")}
                </Button>
                <Button type="button" variant="outline" size="sm" className="border-zinc-700 text-zinc-400 hover:text-zinc-100" aria-label={t("settings.form.agents.delete")} onClick={() => void remove(a)}>
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {!draft && (
        <Button type="button" onClick={() => { setDraft(emptyDraft()); setFormError(""); }}>
          {t("settings.form.agents.add")}
        </Button>
      )}

      {draft && (
        <form onSubmit={save} className="space-y-4 rounded-md border border-zinc-800 p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="agent-kind">{t("settings.form.agents.field.kind")}</Label>
              <StyledSelect
                id="agent-kind"
                value={draft.kind}
                disabled={!!draft.id}
                onChange={(e) => {
                  const kind = e.target.value as AgentKind;
                  patchDraft({ kind, priority: DEFAULT_PRIORITY[kind] });
                }}
              >
                {AGENT_KINDS.map((k) => (
                  <option key={k} value={k}>{t(`settings.form.agents.kind.${k}`)}</option>
                ))}
              </StyledSelect>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="agent-name">{t("settings.form.agents.field.name")}</Label>
              <Input id="agent-name" value={draft.name} maxLength={100} onChange={(e) => patchDraft({ name: e.target.value })} className="bg-zinc-800 border-zinc-700 text-sm" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="agent-url">{t("settings.form.agents.field.url")}</Label>
            <Input id="agent-url" type="url" value={draft.url} onChange={(e) => patchDraft({ url: e.target.value })} placeholder={draft.kind === "ntfy" ? "https://ntfy.sh" : draft.kind === "gotify" ? "https://gotify.example.com" : "https://example.com/hook"} className="bg-zinc-800 border-zinc-700 font-mono text-sm" />
            <p className="text-xs text-zinc-500">{t(`settings.form.agents.urlHelp.${draft.kind}`)}</p>
          </div>

          {draft.kind === "ntfy" && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="agent-topic">{t("settings.form.agents.field.topic")}</Label>
                <Input id="agent-topic" value={draft.topic} maxLength={64} onChange={(e) => patchDraft({ topic: e.target.value })} className="bg-zinc-800 border-zinc-700 font-mono text-sm" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="agent-priority">{t("settings.form.agents.field.priority")}</Label>
                <Input id="agent-priority" type="number" min={1} max={5} value={draft.priority} onChange={(e) => patchDraft({ priority: e.target.value })} className="bg-zinc-800 border-zinc-700 text-sm" />
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
              <Input id="agent-priority" type="number" min={0} max={10} value={draft.priority} onChange={(e) => patchDraft({ priority: e.target.value })} className="bg-zinc-800 border-zinc-700 text-sm" />
            </div>
          )}

          {draft.kind === "webhook" && (
            <div className="space-y-1.5 max-w-[320px]">
              <Label htmlFor="agent-header">{t("settings.form.agents.field.headerName")}</Label>
              <Input id="agent-header" value={draft.headerName} maxLength={64} onChange={(e) => patchDraft({ headerName: e.target.value })} className="bg-zinc-800 border-zinc-700 font-mono text-sm" />
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
                autoComplete="off"
                value={draft.secret}
                disabled={draft.clearSecret}
                onChange={(e) => patchDraft({ secret: e.target.value })}
                placeholder={draft.hasSecret && !draft.clearSecret ? "••••••••" : ""}
                className="bg-zinc-800 border-zinc-700 font-mono text-sm"
              />
              {draft.hasSecret && draft.kind !== "gotify" && (
                <Button type="button" variant="outline" size="sm" className="border-zinc-700 text-zinc-400 hover:text-zinc-100 shrink-0 gap-1.5" onClick={() => patchDraft({ clearSecret: !draft.clearSecret, secret: "" })}>
                  <Trash2 className="w-3.5 h-3.5" />
                  {draft.clearSecret ? t("settings.form.common.cancel") : t("settings.form.common.remove")}
                </Button>
              )}
            </div>
            {draft.hasSecret && !draft.clearSecret && <p className="text-xs text-zinc-500">{t("settings.form.agents.secretKeep")}</p>}
          </div>

          {draft.kind === "webhook" && (
            <div className="space-y-1.5">
              <Label htmlFor="agent-template">{t("settings.form.agents.field.template")}</Label>
              <textarea
                id="agent-template"
                value={draft.template}
                onChange={(e) => patchDraft({ template: e.target.value })}
                rows={5}
                spellCheck={false}
                placeholder={'{ "content": "{{title}} — {{message}}" }'}
                className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 font-mono text-xs text-zinc-100"
              />
              <p className="text-xs text-zinc-500">{t("settings.form.agents.templateHelp", { fields: TEMPLATE_FIELDS.map((f) => `{{${f}}}`).join(" ") })}</p>
            </div>
          )}

          <fieldset className="space-y-2">
            <div className="flex items-center justify-between">
              <legend className="text-sm font-medium text-zinc-100">{t("settings.form.agents.field.events")}</legend>
              <button
                type="button"
                className="text-xs text-indigo-400 hover:underline"
                onClick={() => patchDraft({ events: draft.events.length === NOTIFY_EVENT_KEYS.length ? [] : [...NOTIFY_EVENT_KEYS] })}
              >
                {draft.events.length === NOTIFY_EVENT_KEYS.length ? t("settings.form.agents.selectNone") : t("settings.form.agents.selectAll")}
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

          {formError && <p className="text-sm text-red-400">{formError}</p>}

          <div className="flex items-center gap-2">
            <Button type="submit" disabled={saving}>
              {saving ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("settings.form.common.saving")}</> : t("settings.form.common.save")}
            </Button>
            <Button type="button" variant="outline" className="border-zinc-700" onClick={() => { setDraft(null); setFormError(""); }}>
              {t("settings.form.common.cancel")}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
