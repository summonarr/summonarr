// The notification channel manager's data (notification-agents-manager.tsx):
// the list answer of /api/admin/notification-agents read through a shape check,
// the edit form's draft, and the body a save sends. Pure and React-free so the
// unit suite runs it directly (tests/notification-agents-data.test.mts).
import { check, v, type Infer } from "@/lib/validate";
import { AGENT_KINDS, NOTIFY_EVENT_KEYS, type AgentKind } from "@/lib/notify-events";

const AgentViewSchema = v.object({
  id: v.string(),
  kind: v.literal(...AGENT_KINDS),
  name: v.string(),
  enabled: v.boolean(),
  events: v.array(v.string()),
  config: v.record(v.unknown()),
  hasSecret: v.boolean(),
  // false: the stored config fails today's validation, so nothing is sent.
  configValid: v.optional(v.boolean()),
  lastStatus: v.nullable(v.string()),
  lastError: v.nullable(v.string()),
});

export type AgentView = Infer<typeof AgentViewSchema>;

const AgentList = v.object({ agents: v.array(AgentViewSchema) });

/** GET /api/admin/notification-agents: the channels, or null when the answer isn't that list. */
export function readAgents(data: unknown): AgentView[] | null {
  const r = check(AgentList, data);
  return r.ok ? r.value.agents : null;
}

export interface Draft {
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

export const DEFAULT_PRIORITY: Record<AgentKind, string> = { webhook: "", ntfy: "3", gotify: "5" };

const KNOWN_EVENTS: ReadonlySet<string> = new Set(NOTIFY_EVENT_KEYS);

export function emptyDraft(kind: AgentKind = "webhook"): Draft {
  return {
    id: null, kind, name: "", enabled: true, events: [...NOTIFY_EVENT_KEYS], url: "", topic: "",
    priority: DEFAULT_PRIORITY[kind], attachPoster: false, headerName: "Authorization", template: "",
    secret: "", clearSecret: false, hasSecret: false,
  };
}

export function draftFrom(a: AgentView): Draft {
  const c = a.config;
  return {
    // An event key no longer offered has no checkbox, so it could never be
    // unticked; it would be written back on every save.
    id: a.id, kind: a.kind, name: a.name, enabled: a.enabled, events: a.events.filter((e) => KNOWN_EVENTS.has(e)),
    url: typeof c.url === "string" ? c.url : "",
    topic: typeof c.topic === "string" ? c.topic : "",
    priority: typeof c.priority === "number" ? String(c.priority) : DEFAULT_PRIORITY[a.kind],
    attachPoster: c.attachPoster === true,
    headerName: typeof c.headerName === "string" ? c.headerName : "Authorization",
    template: typeof c.template === "string" ? c.template : "",
    secret: "", clearSecret: false, hasSecret: a.hasSecret,
  };
}

/** Whether every offered event is ticked (the Select all / Select none toggle). */
export function allEventsSelected(events: readonly string[]): boolean {
  return NOTIFY_EVENT_KEYS.every((k) => events.includes(k));
}

export function bodyFrom(d: Draft): Record<string, unknown> {
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

// POST /api/admin/notification-agents/[id]/test.
export const TestAnswer = v.object({
  ok: v.optional(v.boolean()),
  status: v.optional(v.nullable(v.number())),
  error: v.optional(v.nullable(v.string())),
});
