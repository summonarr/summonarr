// Radarr/Sonarr health + the Summonarr webhook connection: the pure rules.
// Zero imports, zero I/O; the data half is arr-health-data.ts.
//
//   • HEALTH is Radarr/Sonarr's own /api/v3/health list (indexers down, a
//     download client unreachable, a missing root folder, …), reported as-is.
//     Summonarr adds nothing to it and judges nothing.
//   • The WEBHOOK check reads the instance's Connect list (/api/v3/notification)
//     and finds the Webhook entry pointing at /api/webhooks/<service>. It is
//     "ok" only when that entry is enabled for every event Summonarr handles AND
//     carries the token Summonarr currently accepts for the instance — a hook
//     with a rotated-away token is a hook that 401s every delivery.
//   • SETUP builds the Connect entry from the instance's own schema template
//     (/api/v3/notification/schema), so whatever fields and event flags this
//     Radarr/Sonarr version has are the ones sent. Only the events Summonarr
//     handles are switched on; an existing entry keeps every other setting.

export type ArrHealthService = "radarr" | "sonarr";

export interface ArrHealthCheck {
  /** The check's class name in Radarr/Sonarr (IndexerStatusCheck, …). */
  source: string;
  level: "notice" | "warning" | "error";
  message: string;
  /** Radarr/Sonarr's wiki page for the check — https only. */
  wikiUrl: string | null;
}

const MAX_CHECKS = 50;
const MAX_TEXT = 500;

const str = (v: unknown, max = MAX_TEXT): string => (typeof v === "string" ? v.slice(0, max) : "");

function httpsUrlOrNull(v: unknown): string | null {
  if (typeof v !== "string" || v === "") return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}

/** /api/v3/health → the checks that are not "ok", errors first. */
export function normalizeHealthChecks(raw: unknown): ArrHealthCheck[] {
  if (!Array.isArray(raw)) return [];
  const out: ArrHealthCheck[] = [];
  for (const r of raw as Array<Record<string, unknown> | null>) {
    if (!r || typeof r !== "object") continue;
    const type = typeof r.type === "string" ? r.type.toLowerCase() : "";
    if (type !== "notice" && type !== "warning" && type !== "error") continue;
    const message = str(r.message).trim();
    if (!message) continue;
    out.push({ source: str(r.source, 200), level: type, message, wikiUrl: httpsUrlOrNull(r.wikiUrl) });
  }
  const rank = { error: 0, warning: 1, notice: 2 } as const;
  return out.sort((a, b) => rank[a.level] - rank[b.level]).slice(0, MAX_CHECKS);
}

// ── the webhook connection ───────────────────────────────────────────────────

/**
 * The Connect event flags Summonarr acts on, per service — exactly the events
 * /api/webhooks/<service> handles:
 *   onDownload / onUpgrade          — the Download event (a first import flips a
 *                                     request; an upgrade completes an issue's
 *                                     replacement grab)
 *   onMovieDelete / onSeriesDelete  — evicts the wanted/available cache rows
 *   onMovieFileDelete (Radarr)      — the same eviction for a deleted file
 *   onHealthIssue / onHealthRestored — forwarded to the notification channels
 *   onManualInteractionRequired     — the admin "manual import needed" alert
 * Grab, rename, add and update events are not handled, so they are not asked for.
 */
export const WEBHOOK_EVENTS: Record<ArrHealthService, readonly string[]> = {
  radarr: ["onDownload", "onUpgrade", "onMovieDelete", "onMovieFileDelete", "onHealthIssue", "onHealthRestored", "onManualInteractionRequired"],
  sonarr: ["onDownload", "onUpgrade", "onSeriesDelete", "onHealthIssue", "onHealthRestored", "onManualInteractionRequired"],
};

/** The Connect entry name Summonarr creates. An existing entry keeps whatever name the admin gave it. */
export const WEBHOOK_NAME = "Summonarr";

export type NotificationField = { name?: unknown; value?: unknown } & Record<string, unknown>;
export type NotificationResource = {
  id?: unknown;
  name?: unknown;
  implementation?: unknown;
  fields?: unknown;
} & Record<string, unknown>;

export type WebhookState = "ok" | "missing" | "tokenMismatch" | "eventsMissing";

export interface WebhookStatus {
  state: WebhookState;
  /** Radarr/Sonarr's id for the Summonarr Connect entry, when one exists. */
  id: number | null;
  /** Events Summonarr handles that the entry does not send (supported by this version only). */
  missingEvents: string[];
}

function fieldValue(n: NotificationResource, name: string): unknown {
  if (!Array.isArray(n.fields)) return undefined;
  const f = (n.fields as NotificationField[]).find((x) => x && x.name === name);
  return f?.value;
}

function isWebhook(n: NotificationResource): boolean {
  return typeof n.implementation === "string" && n.implementation.toLowerCase() === "webhook";
}

// The path suffix every Summonarr webhook URL ends with, whatever host or base
// path the admin used to reach Summonarr.
function pointsAtSummonarr(url: unknown, service: ArrHealthService): URL | null {
  if (typeof url !== "string") return null;
  try {
    const u = new URL(url);
    return u.pathname.replace(/\/+$/, "").endsWith(`/api/webhooks/${service}`) ? u : null;
  } catch {
    return null;
  }
}

/**
 * Whether this Radarr/Sonarr version has the event at all: the resource carries
 * the flag key, and does not say `supportsX: false`. An older version (Sonarr
 * v3 has no onHealthRestored / onManualInteractionRequired) has neither key —
 * demanding the event there would read "missing events" forever, and Repair
 * would re-PUT the entry on every click without changing anything.
 */
function hasEvent(n: NotificationResource, flag: string): boolean {
  if (!(flag in n)) return false;
  return n[`supports${flag[0].toUpperCase()}${flag.slice(1)}`] !== false;
}

/** A supported event flag the entry has switched off. */
function missingEventsOf(n: NotificationResource, service: ArrHealthService): string[] {
  return WEBHOOK_EVENTS[service].filter((flag) => hasEvent(n, flag) && n[flag] !== true);
}

/**
 * Judges the Connect list. `secret` is the token Summonarr currently accepts
 * for this instance ("" when it has none — then no hook can authenticate).
 * When several entries point at Summonarr, the one with the right token wins.
 */
export function evaluateWebhook(notifications: unknown, service: ArrHealthService, secret: string): WebhookStatus {
  const list = Array.isArray(notifications) ? (notifications as NotificationResource[]) : [];
  const hooks = list
    .filter((n) => n && typeof n === "object" && isWebhook(n))
    .map((n) => ({ n, url: pointsAtSummonarr(fieldValue(n, "url"), service) }))
    .filter((h): h is { n: NotificationResource; url: URL } => h.url !== null);
  if (hooks.length === 0) return { state: "missing", id: null, missingEvents: [...WEBHOOK_EVENTS[service]] };
  const withToken = secret ? hooks.find((h) => h.url.searchParams.get("token") === secret) : undefined;
  const chosen = withToken ?? hooks[0];
  const id = typeof chosen.n.id === "number" && Number.isInteger(chosen.n.id) ? chosen.n.id : null;
  const missingEvents = missingEventsOf(chosen.n, service);
  if (!withToken) return { state: "tokenMismatch", id, missingEvents };
  return { state: missingEvents.length > 0 ? "eventsMissing" : "ok", id, missingEvents };
}

/**
 * The URL Radarr/Sonarr will POST to. The token rides in `?token=` because the
 * arr webhook form has no header field (guardrail 2); the handler accepts it
 * there and compares it timing-safely.
 */
export function buildWebhookUrl(base: string, service: ArrHealthService, secret: string): string {
  const u = new URL(base);
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/api/webhooks/${service}`;
  u.search = new URLSearchParams({ token: secret }).toString();
  u.hash = "";
  return u.toString();
}

/**
 * Validates the Summonarr address the admin typed (how Radarr/Sonarr reach
 * Summonarr — often a LAN or Docker-network address, not the public one):
 * absolute http(s), no credentials, no query or fragment (the token query is
 * appended here). Returns the normalized base without a trailing slash, or null.
 */
export function normalizeWebhookBase(raw: unknown): string | null {
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
  if (u.username || u.password || u.search || u.hash) return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

/**
 * The Connect entry to POST (create) or PUT (update). Starts from the existing
 * entry when there is one — every setting the admin chose survives — or from the
 * Webhook schema template otherwise. Sets the URL field, switches on the events
 * Summonarr handles (where this version supports them), and nothing else.
 * Returns null when the template has no `url` field (an unrecognized schema;
 * guessing a body would be worse than refusing).
 */
export function buildWebhookResource(
  base: NotificationResource,
  service: ArrHealthService,
  url: string,
  opts: { isNew: boolean },
): NotificationResource | null {
  if (!Array.isArray(base.fields)) return null;
  const fields = (base.fields as NotificationField[]).map((f) => ({ ...f }));
  const urlField = fields.find((f) => f && f.name === "url");
  if (!urlField) return null;
  urlField.value = url;
  const out: NotificationResource = { ...base, fields };
  if (opts.isNew) {
    out.name = WEBHOOK_NAME;
    out.tags = [];
    delete out.id;
  }
  for (const flag of WEBHOOK_EVENTS[service]) {
    if (hasEvent(base, flag)) out[flag] = true;
  }
  return out;
}

/** The Webhook template out of /api/v3/notification/schema, or null. */
export function webhookTemplate(schema: unknown): NotificationResource | null {
  if (!Array.isArray(schema)) return null;
  const t = (schema as NotificationResource[]).find((n) => n && typeof n === "object" && isWebhook(n));
  return t ?? null;
}

/**
 * Radarr/Sonarr answer a refused save (its own test POST to Summonarr failed,
 * or a field did not validate) with a 400 whose body is a list of
 * `{ propertyName, errorMessage }`. The admin needs that message — it is the
 * arr saying it could not reach the URL. Bounded, single-line, and with any
 * `token=` value masked: the arr's HTTP error text quotes the request URL,
 * which carries the webhook secret.
 */
export function arrValidationMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const msgs = list
      .map((e) => (e && typeof e === "object" ? (e as { errorMessage?: unknown; message?: unknown }) : null))
      .map((e) => (typeof e?.errorMessage === "string" ? e.errorMessage : typeof e?.message === "string" ? e.message : ""))
      .filter((m) => m.trim() !== "");
    if (msgs.length === 0) return null;
    return [...new Set(msgs)]
      .join(" ")
      .replace(/[\r\n\t]+/g, " ")
      .replace(/token=[^&\s\]\)"']+/gi, "token=••••••••")
      .slice(0, 400);
  } catch {
    return null;
  }
}
