import "server-only";
import {
  AGENT_KINDS,
  sanitizeEvents,
  validateAgentConfig,
  type AgentConfig,
  type AgentKind,
  type SubscribableEvent,
} from "./notify-events";

// Shared input parsing + output shaping for the /api/admin/notification-agents
// routes. The secret NEVER leaves the server: the wire shape carries only
// `hasSecret`.

export const MAX_AGENTS = 25;
// Text-bearing tier (guardrail 30): an 8,000-char template expands under JSON
// encoding (escapes, 2–4 bytes per non-ASCII char) and rides beside a 2,000-char
// secret and URL — at 16 KB a CJK template 413'd before `templateTooLong` could
// name the real limit. The field-level caps remain the actual bound.
export const AGENT_BODY_CAP = 64 * 1024;
const MAX_SECRET_CHARS = 2_000;
// Anything undici's Headers rejects. CR/LF is header injection; NUL (and the
// other C0 controls / DEL) make `new Headers()` throw a TypeError whose message
// EMBEDS the value — refusing them here keeps the secret out of lastError/logs.
const SECRET_CONTROL_RE = /[\x00-\x1f\x7f]/;

export const AGENT_PUBLIC_SELECT = {
  id: true,
  kind: true,
  name: true,
  enabled: true,
  events: true,
  config: true,
  secret: true,
  lastStatus: true,
  lastError: true,
  lastAttemptAt: true,
  createdAt: true,
} as const;

export interface AgentRow {
  id: string;
  kind: string;
  name: string;
  enabled: boolean;
  events: string[];
  config: unknown;
  secret: string | null;
  lastStatus: string | null;
  lastError: string | null;
  lastAttemptAt: Date | null;
  createdAt: Date;
}

export function toPublicAgent(row: AgentRow) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    enabled: row.enabled,
    events: row.events,
    config: row.config,
    hasSecret: !!row.secret,
    lastStatus: row.lastStatus,
    lastError: row.lastError,
    lastAttemptAt: row.lastAttemptAt ? row.lastAttemptAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

// The audit row names the DESTINATION — where events are sent — so a channel
// re-pointed at another host can be read back after the fact. Never the secret:
// only whether it changed is recorded (guardrail 14c). Shared by the create and
// update routes so the two audit payloads cannot drift.
export function destinationDetails(config: AgentConfig): Record<string, unknown> {
  const out: Record<string, unknown> = { url: config.url };
  if ("headerName" in config) {
    out.headerName = config.headerName;
    out.hasTemplate = config.template !== null;
  }
  if ("topic" in config) out.topic = config.topic;
  return out;
}

export type AgentInput = {
  kind: AgentKind;
  name: string;
  enabled: boolean;
  events: SubscribableEvent[];
  config: AgentConfig;
  // undefined = leave as is (PATCH only); null = clear; string = set.
  secret: string | null | undefined;
};

/** Error values are i18n keys under apiAdmin.agents.error.*. */
export function parseAgentInput(
  body: Record<string, unknown>,
  existing: { kind: string; name: string; enabled: boolean; events: string[]; config: unknown } | null,
): { ok: true; input: AgentInput } | { ok: false; error: string } {
  const kindRaw = body.kind ?? existing?.kind;
  if (typeof kindRaw !== "string" || !(AGENT_KINDS as readonly string[]).includes(kindRaw)) return { ok: false, error: "kind" };
  // The kind is fixed at creation: a webhook's config means nothing to ntfy.
  if (existing && kindRaw !== existing.kind) return { ok: false, error: "kindChange" };
  const kind = kindRaw as AgentKind;

  const nameRaw = body.name ?? existing?.name;
  const name = typeof nameRaw === "string" ? nameRaw.trim() : "";
  if (!name || name.length > 100) return { ok: false, error: "name" };

  const enabledRaw = body.enabled ?? existing?.enabled ?? true;
  if (typeof enabledRaw !== "boolean") return { ok: false, error: "enabled" };

  const events = sanitizeEvents(body.events ?? existing?.events ?? []);
  if (!events) return { ok: false, error: "events" };

  const cfg = validateAgentConfig(kind, body.config ?? existing?.config);
  if (!cfg.ok) return { ok: false, error: cfg.error };

  let secret: string | null | undefined;
  if (body.secret === undefined) secret = existing ? undefined : null;
  else if (body.secret === null || body.secret === "") secret = null;
  // A whitespace-only secret trims to "" and is a CLEAR, not a value — otherwise
  // it is stored as an empty string and slips past the Gotify token guard below.
  else if (typeof body.secret === "string" && body.secret.length <= MAX_SECRET_CHARS && !SECRET_CONTROL_RE.test(body.secret)) secret = body.secret.trim() || null;
  else return { ok: false, error: "secret" };

  // Gotify refuses every message without an application token.
  if (kind === "gotify" && (secret === null || (secret === undefined && !existing))) return { ok: false, error: "gotifyToken" };

  return { ok: true, input: { kind, name, enabled: enabledRaw, events, config: cfg.config, secret } };
}
