import "server-only";
import { redactUrlForLog } from "./safe-fetch";
import {
  isAgentKind,
  parseStoredConfig,
  sanitizeEvents,
  validateAgentConfig,
  type AgentConfig,
  type AgentKind,
  type SubscribableEvent,
} from "./notify-events";
import { NOTIFICATION_AGENTS_MAX } from "./api-body-limits";

// Shared input parsing + output shaping for the /api/admin/notification-agents
// routes. The secret NEVER leaves the server: the wire shape carries only
// `hasSecret`.

export const MAX_AGENTS = NOTIFICATION_AGENTS_MAX;
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
    // Additive: false when the stored config fails today's validation, so the
    // dispatcher skips the channel even though it is enabled.
    configValid: parseStoredConfig(row.kind, row.config).ok,
    lastStatus: row.lastStatus,
    lastError: row.lastError,
    lastAttemptAt: row.lastAttemptAt ? row.lastAttemptAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

// The audit row names the DESTINATION — where events are sent — so a channel
// re-pointed at another host can be read back after the fact. Never the secret:
// only whether it changed is recorded (guardrail 14c). A webhook URL can carry a
// credential of its own (`?token=`, a Discord /webhooks/{id}/{token} path), and
// an audit row outlives the channel, so the URL is recorded redacted: host and
// path, no query, fragment or path token. Shared by the create and update
// routes so the two audit payloads cannot drift.
export function destinationDetails(config: AgentConfig): Record<string, unknown> {
  const out: Record<string, unknown> = { url: auditUrl(config.url) };
  if ("headerName" in config) {
    out.headerName = config.headerName;
    out.hasTemplate = config.template !== null;
  }
  if ("topic" in config) out.topic = config.topic;
  return out;
}

function auditUrl(raw: string): string {
  const redacted = redactUrlForLog(raw);
  try {
    const u = new URL(redacted);
    u.hash = "";
    return u.toString();
  } catch {
    return redacted;
  }
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

const INVALID_SECRET = Symbol("invalid-secret");

// undefined = leave as is (an update that omits it); null = clear (a create
// without one); a string = set. A whitespace-only secret trims to "" and is a
// CLEAR, not a value — otherwise it is stored as an empty string and slips past
// the Gotify token guard.
function parseSecretInput(raw: unknown, updating: boolean): string | null | undefined | typeof INVALID_SECRET {
  if (raw === undefined) return updating ? undefined : null;
  if (raw === null || raw === "") return null;
  if (typeof raw === "string" && raw.length <= MAX_SECRET_CHARS && !SECRET_CONTROL_RE.test(raw)) return raw.trim() || null;
  return INVALID_SECRET;
}

/** Error values are i18n keys under apiAdmin.agents.error.*. */
export function parseAgentInput(
  body: Record<string, unknown>,
  // `secret` (the stored one) when the caller read it: only whether it is set
  // matters here.
  existing: { kind: string; name: string; enabled: boolean; events: string[]; config: unknown; secret?: string | null } | null,
): { ok: true; input: AgentInput } | { ok: false; error: string } {
  const kind = body.kind ?? existing?.kind;
  if (!isAgentKind(kind)) return { ok: false, error: "kind" };
  // The kind is fixed at creation: a webhook's config means nothing to ntfy.
  if (existing && kind !== existing.kind) return { ok: false, error: "kindChange" };

  const nameRaw = body.name ?? existing?.name;
  const name = typeof nameRaw === "string" ? nameRaw.trim() : "";
  if (!name || name.length > 100) return { ok: false, error: "name" };

  const enabledRaw = body.enabled ?? existing?.enabled ?? true;
  if (typeof enabledRaw !== "boolean") return { ok: false, error: "enabled" };

  const events = sanitizeEvents(body.events ?? existing?.events ?? []);
  if (!events) return { ok: false, error: "events" };

  const cfg = validateAgentConfig(kind, body.config ?? existing?.config);
  if (!cfg.ok) return { ok: false, error: cfg.error };

  const secret = parseSecretInput(body.secret, existing !== null);
  if (secret === INVALID_SECRET) return { ok: false, error: "secret" };

  // Gotify refuses every message without an application token. A PATCH that
  // leaves the secret alone keeps the stored one, so an enabled channel needs
  // one there (a row from before this guard may have none); a disabled one may
  // stay as it is, so it can still be switched off or renamed.
  if (kind === "gotify") {
    const willHaveToken = secret === undefined ? existing?.secret !== null && existing?.secret !== "" : secret !== null;
    if (!willHaveToken && (enabledRaw || !existing)) return { ok: false, error: "gotifyToken" };
  }

  return { ok: true, input: { kind, name, enabled: enabledRaw, events, config: cfg.config, secret } };
}
