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
export const AGENT_BODY_CAP = 16 * 1024;
const MAX_SECRET_CHARS = 2_000;

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
  else if (typeof body.secret === "string" && body.secret.length <= MAX_SECRET_CHARS && !/[\r\n]/.test(body.secret)) secret = body.secret.trim();
  else return { ok: false, error: "secret" };

  // Gotify refuses every message without an application token.
  if (kind === "gotify" && (secret === null || (secret === undefined && !existing))) return { ok: false, error: "gotifyToken" };

  return { ok: true, input: { kind, name, enabled: enabledRaw, events, config: cfg.config, secret } };
}
