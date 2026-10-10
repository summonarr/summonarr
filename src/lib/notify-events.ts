// Pure, zero-import rules for the admin-configured outbound notification
// channels (NotificationAgent rows): the event catalog, config validation, the
// versioned webhook payload, the {{field}} template renderer, and the ntfy /
// Gotify request bodies. Everything with I/O lives in notify-agents.ts.

export const AGENT_KINDS = ["webhook", "ntfy", "gotify"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

// Events an agent can subscribe to. `agent.test` is sent only by the Test
// button and can never be subscribed to.
export const NOTIFY_EVENT_KEYS = [
  "request.created",
  "request.approved",
  "request.declined",
  "request.available",
  "issue.created",
  "issue.reply",
  "issue.resolved",
  "vote.threshold",
  "arr.manual_interaction",
  "arr.grab_completed",
  "arr.health",
  "arr.health_restored",
] as const;
export type SubscribableEvent = (typeof NOTIFY_EVENT_KEYS)[number];
export type NotifyEventKey = SubscribableEvent | "agent.test";

export function isSubscribableEvent(v: unknown): v is SubscribableEvent {
  return typeof v === "string" && (NOTIFY_EVENT_KEYS as readonly string[]).includes(v);
}

export interface NotifyEvent {
  event: NotifyEventKey;
  media?: {
    type: "MOVIE" | "TV";
    tmdbId: number | null;
    // Stored (English) title — the sender localizes it at send time (guardrail 40a).
    title: string;
    year?: string | null;
    posterPath?: string | null;
  };
  request?: { id?: string | null; instance?: string | null };
  issue?: { id: string; type?: string | null };
  // The person the event is about: requester, reporter, reply author.
  actor?: { name: string } | null;
  // Free text attached to the event: request note, decline note, reply text,
  // resolution. User-supplied — always escaped by the renderers below.
  text?: string | null;
  votes?: number | null;
}

// ─── Config ─────────────────────────────────────────────────────────────────

export interface WebhookConfig { url: string; template: string | null; headerName: string }
export interface NtfyConfig { url: string; topic: string; priority: number; attachPoster: boolean }
export interface GotifyConfig { url: string; priority: number }
export type AgentConfig = WebhookConfig | NtfyConfig | GotifyConfig;

export const MAX_TEMPLATE_CHARS = 8_000;
const TOPIC_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;
// Headers the transport owns. Letting a template's auth header override one of
// these would break the request or smuggle a second value.
const RESERVED_HEADERS = new Set(["host", "content-type", "content-length", "transfer-encoding", "connection", "cookie", "user-agent"]);

/** Validates an admin-entered channel URL: absolute http(s), no credentials in it. */
export function validateAgentUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2_000) return null;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  // Credentials belong in the encrypted secret, never in a plaintext column.
  if (u.username || u.password) return null;
  return u.toString();
}

function intIn(raw: unknown, min: number, max: number, fallback: number): number | null {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

export type ConfigResult = { ok: true; config: AgentConfig } | { ok: false; error: string };

/** Error strings are i18n keys under settingsForms.agents.error.*. */
export function validateAgentConfig(kind: AgentKind, raw: unknown): ConfigResult {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const url = validateAgentUrl(r.url);
  if (!url) return { ok: false, error: "url" };
  // ntfy and Gotify URLs are a BASE the request path is appended to
  // (ntfyPublishUrl / gotifyMessageUrl), so a query or fragment would end up
  // in the middle of the final URL: `https://g.example/?token=x` becomes
  // `…/?token=x/message` — a 404 with no validation message pointing at the
  // cause, and a token stored in the plaintext config column. Generic webhooks
  // post to the URL as given and legitimately carry queries (Discord `?wait=true`).
  // The normalized URL has no credentials, so a `?`/`#` can only be the
  // delimiter itself (an escaped one is `%3F`/`%23`).
  if (kind !== "webhook" && /[?#]/.test(url)) return { ok: false, error: "url" };
  if (kind === "webhook") {
    const headerName = typeof r.headerName === "string" && r.headerName.trim() ? r.headerName.trim() : "Authorization";
    if (!HEADER_NAME_RE.test(headerName) || RESERVED_HEADERS.has(headerName.toLowerCase())) return { ok: false, error: "headerName" };
    let template: string | null = null;
    if (typeof r.template === "string" && r.template.trim()) {
      template = r.template;
      if (template.length > MAX_TEMPLATE_CHARS) return { ok: false, error: "templateTooLong" };
      // A template must render to valid JSON for BOTH samples, or some delivery
      // would be a malformed body the receiver rejects: the full sample catches a
      // placeholder outside any JSON string, the sparse one (every nullable field
      // null — `media` absent, no text, no votes) catches `{"id": {{media.tmdbId}}}`,
      // which the full sample renders as a bare number and the live
      // `arr.manual_interaction` event (no media) renders as `{"id": }`.
      try {
        for (const [ev, ctx] of TEMPLATE_SAMPLES) JSON.parse(renderTemplate(template, buildWebhookPayload(ev, ctx)));
      } catch {
        return { ok: false, error: "templateInvalid" };
      }
    }
    return { ok: true, config: { url, template, headerName } };
  }
  if (kind === "ntfy") {
    const topic = typeof r.topic === "string" ? r.topic.trim() : "";
    if (!TOPIC_RE.test(topic)) return { ok: false, error: "topic" };
    const priority = intIn(r.priority, 1, 5, 3);
    if (priority === null) return { ok: false, error: "priority" };
    return { ok: true, config: { url, topic, priority, attachPoster: r.attachPoster === true } };
  }
  const priority = intIn(r.priority, 0, 10, 5);
  if (priority === null) return { ok: false, error: "priority" };
  return { ok: true, config: { url, priority } };
}

/** Reads a stored config defensively; a row that no longer validates is skipped. */
export function parseStoredConfig(kind: string, raw: unknown): AgentConfig | null {
  if (!(AGENT_KINDS as readonly string[]).includes(kind)) return null;
  const r = validateAgentConfig(kind as AgentKind, raw);
  return r.ok ? r.config : null;
}

export function sanitizeEvents(raw: unknown): SubscribableEvent[] | null {
  if (!Array.isArray(raw)) return null;
  const out = new Set<SubscribableEvent>();
  for (const v of raw) {
    if (!isSubscribableEvent(v)) return null;
    out.add(v);
  }
  return NOTIFY_EVENT_KEYS.filter((k) => out.has(k));
}

// ─── Payload ────────────────────────────────────────────────────────────────

export const WEBHOOK_PAYLOAD_VERSION = 1;
const TMDB_POSTER_BASE = "https://image.tmdb.org/t/p/w500";

export interface PayloadContext {
  /** Absolute app root, no trailing slash; null when AUTH_URL is unusable. */
  siteUrl: string | null;
  /** Rendered, localized headline ("Now available: Dune"). */
  title: string;
  /** Rendered, localized body line. */
  message: string;
  /** The media title in the message's language. */
  mediaTitle: string | null;
  timestamp: string;
}

export interface WebhookPayload {
  version: number;
  event: NotifyEventKey;
  timestamp: string;
  title: string;
  message: string;
  url: string | null;
  media: { type: "movie" | "tv"; tmdbId: number | null; title: string; year: string | null; posterUrl: string | null } | null;
  request: { id: string | null; instance: string } | null;
  issue: { id: string; type: string | null } | null;
  actor: { name: string } | null;
  text: string | null;
  votes: number | null;
}

export function posterUrlOf(posterPath: string | null | undefined): string | null {
  if (!posterPath || !/^\/[A-Za-z0-9._-]+$/.test(posterPath)) return null;
  return `${TMDB_POSTER_BASE}${posterPath}`;
}

/** Where a click on the notification should land. */
export function eventLink(ev: NotifyEvent, siteUrl: string | null): string | null {
  if (!siteUrl) return null;
  if (ev.event.startsWith("issue.")) return `${siteUrl}/issues`;
  if (ev.media?.tmdbId) return `${siteUrl}/${ev.media.type === "MOVIE" ? "movie" : "tv"}/${ev.media.tmdbId}`;
  if (ev.event.startsWith("request.")) return `${siteUrl}/requests`;
  return siteUrl;
}

export function buildWebhookPayload(ev: NotifyEvent, ctx: PayloadContext): WebhookPayload {
  return {
    version: WEBHOOK_PAYLOAD_VERSION,
    event: ev.event,
    timestamp: ctx.timestamp,
    title: ctx.title,
    message: ctx.message,
    url: eventLink(ev, ctx.siteUrl),
    media: ev.media
      ? {
          type: ev.media.type === "MOVIE" ? "movie" : "tv",
          tmdbId: ev.media.tmdbId,
          title: ctx.mediaTitle ?? ev.media.title,
          year: ev.media.year ?? null,
          posterUrl: posterUrlOf(ev.media.posterPath),
        }
      : null,
    request: ev.request ? { id: ev.request.id ?? null, instance: ev.request.instance ?? "" } : null,
    issue: ev.issue ? { id: ev.issue.id, type: ev.issue.type ?? null } : null,
    actor: ev.actor ? { name: ev.actor.name } : null,
    text: ev.text ?? null,
    votes: ev.votes ?? null,
  };
}

// ─── Template ───────────────────────────────────────────────────────────────

// Every field a template may reference. Anything else renders as an empty string.
export const TEMPLATE_FIELDS = [
  "event", "timestamp", "title", "message", "url",
  "media.type", "media.tmdbId", "media.title", "media.year", "media.posterUrl",
  "request.id", "request.instance", "issue.id", "issue.type",
  "actor.name", "text", "votes",
] as const;

function fieldValue(p: WebhookPayload, path: string): string {
  const [head, tail] = path.split(".");
  const top = (p as unknown as Record<string, unknown>)[head];
  const v = tail === undefined ? top : top && typeof top === "object" ? (top as Record<string, unknown>)[tail] : undefined;
  if (v === null || v === undefined) return "";
  return String(v);
}

/**
 * Replaces `{{field}}` placeholders with the payload's values, each JSON-string
 * ESCAPED (no surrounding quotes) so a title containing `"` or a newline can't
 * break out of the string the admin placed it in. No expressions, no eval.
 */
export function renderTemplate(template: string, payload: WebhookPayload): string {
  return template.replace(/\{\{\s*([A-Za-z.]+)\s*\}\}/g, (_m, field: string) => {
    if (!(TEMPLATE_FIELDS as readonly string[]).includes(field)) return "";
    return JSON.stringify(fieldValue(payload, field)).slice(1, -1);
  });
}

// ─── Kind bodies ────────────────────────────────────────────────────────────

const NTFY_TAGS: Record<NotifyEventKey, string> = {
  "request.created": "inbox_tray",
  "request.approved": "white_check_mark",
  "request.declined": "x",
  "request.available": "tada",
  "issue.created": "warning",
  "issue.reply": "speech_balloon",
  "issue.resolved": "heavy_check_mark",
  "vote.threshold": "wastebasket",
  "arr.manual_interaction": "raised_hand",
  "arr.grab_completed": "arrow_down",
  "arr.health": "rotating_light",
  "arr.health_restored": "white_check_mark",
  "agent.test": "bell",
};

export function buildNtfyBody(cfg: NtfyConfig, p: WebhookPayload): Record<string, unknown> {
  const body: Record<string, unknown> = {
    topic: cfg.topic,
    title: p.title,
    message: p.message,
    tags: [NTFY_TAGS[p.event]],
    priority: cfg.priority,
  };
  if (p.url) body.click = p.url;
  if (cfg.attachPoster && p.media?.posterUrl) body.attach = p.media.posterUrl;
  return body;
}

export function buildGotifyBody(cfg: GotifyConfig, p: WebhookPayload): Record<string, unknown> {
  const body: Record<string, unknown> = {
    title: p.title,
    message: p.message,
    priority: cfg.priority,
    extras: { "client::display": { contentType: "text/plain" } } as Record<string, unknown>,
  };
  if (p.url) (body.extras as Record<string, unknown>)["client::notification"] = { click: { url: p.url } };
  return body;
}

/** ntfy publishes JSON to the server ROOT; keep any reverse-proxy path prefix. */
export function ntfyPublishUrl(base: string): string {
  return base.endsWith("/") ? base : `${base}/`;
}

export function gotifyMessageUrl(base: string): string {
  return `${base.replace(/\/+$/, "")}/message`;
}

// ─── Delivery policy ────────────────────────────────────────────────────────

export type DeliveryVerdict = "ok" | "retry" | "fail";

/** 2xx ok; 408/429/5xx are worth retrying; every other 4xx is a config error. */
export function classifyStatus(status: number): DeliveryVerdict {
  if (status >= 200 && status < 300) return "ok";
  if (status === 408 || status === 429 || status >= 500) return "retry";
  return "fail";
}

// Delay before each RETRY (attempt 1 is immediate). Three retries, then give up.
export const RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const;

// ─── Sample (template validation + the Test button) ─────────────────────────

export const SAMPLE_EVENT: NotifyEvent = {
  event: "agent.test",
  media: { type: "MOVIE", tmdbId: 603, title: "The Matrix", year: "1999", posterPath: "/f89U3ADr1oiB1s9GkdPOEpXUk5H.jpg" },
  request: { id: "sample", instance: "" },
  actor: { name: "Summonarr" },
  text: "Sample \"quoted\" text\nwith a newline",
};

const SAMPLE_CONTEXT: PayloadContext = {
  siteUrl: "https://summonarr.example",
  title: "Test notification",
  message: "Your channel is working.",
  mediaTitle: "The Matrix",
  timestamp: "2026-01-01T00:00:00.000Z",
};

// The sparse twin: every nullable/optional payload field null or absent. This
// is the shape of a real `arr.manual_interaction` event (no media, no request,
// no actor) and of any event whose title has no tmdbId. Template validation
// renders both — see validateAgentConfig.
const SPARSE_SAMPLE_EVENT: NotifyEvent = { event: "agent.test", actor: null, text: null, votes: null };
const SPARSE_SAMPLE_CONTEXT: PayloadContext = { siteUrl: null, title: "", message: "", mediaTitle: null, timestamp: "" };

const TEMPLATE_SAMPLES: ReadonlyArray<readonly [NotifyEvent, PayloadContext]> = [
  [SAMPLE_EVENT, SAMPLE_CONTEXT],
  [SPARSE_SAMPLE_EVENT, SPARSE_SAMPLE_CONTEXT],
];
