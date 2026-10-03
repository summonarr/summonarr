import "server-only";
import { prisma } from "./prisma";
import { safeFetchAdminConfigured, SafeFetchError } from "./safe-fetch";
import { isFeatureEnabled } from "./features";
import { processSingleton } from "./process-singleton";
import { scheduleDelayed } from "./delayed-jobs";
import { settleLimit } from "./concurrency";
import { calendarSiteUrl } from "./calendar-feed";
import { instanceDefaultLocale, translatorFor } from "./i18n/server-locale";
import { titleResolver } from "./tmdb-localize";
import { mediaLabelT } from "./notify-i18n";
import {
  buildGotifyBody,
  buildNtfyBody,
  buildWebhookPayload,
  classifyStatus,
  gotifyMessageUrl,
  ntfyPublishUrl,
  parseStoredConfig,
  renderTemplate,
  RETRY_DELAYS_MS,
  type AgentConfig,
  type DeliveryVerdict,
  type GotifyConfig,
  type NotifyEvent,
  type NtfyConfig,
  type WebhookConfig,
  type WebhookPayload,
} from "./notify-events";

// Outbound notification channels (generic webhook / ntfy / Gotify), configured
// by admins as NotificationAgent rows. One entry point — emitNotificationEvent —
// which never throws and never blocks the caller: every event site calls it
// fire-and-forget beside the existing Discord/push/email fan-out.
//
// Language: these are instance-wide channels read by whoever runs them, so they
// are written in the instance default language, and media titles are localized
// for that language at send time (guardrail 40a) — the same rule as a shared
// Discord channel post.

export const AGENTS_FEATURE_KEY = "feature.integration.webhooks";
const AGENT_FETCH_TIMEOUT_MS = 10_000;
const AGENT_SEND_CONCURRENCY = 4;
const AGENT_CACHE_TTL_MS = 30_000;

export interface LoadedAgent {
  id: string;
  kind: "webhook" | "ntfy" | "gotify";
  name: string;
  events: string[];
  config: AgentConfig;
  secret: string | null;
}

// Process-wide (see process-singleton.ts): the admin CRUD route invalidates it,
// and a per-bundle copy would keep serving a deleted agent until its TTL ran out.
const agentState = processSingleton("notify-agents:cache", () => ({
  cache: null as { agents: LoadedAgent[]; expiresAt: number } | null,
  inflight: null as Promise<LoadedAgent[]> | null,
}));

export function invalidateAgentCache(): void {
  agentState.cache = null;
}

function toLoaded(row: { id: string; kind: string; name: string; events: string[]; config: unknown; secret: string | null }): LoadedAgent | null {
  const config = parseStoredConfig(row.kind, row.config);
  if (!config) return null;
  return { id: row.id, kind: row.kind as LoadedAgent["kind"], name: row.name, events: row.events, config, secret: row.secret || null };
}

async function loadEnabledAgents(): Promise<LoadedAgent[]> {
  const now = Date.now();
  if (agentState.cache && agentState.cache.expiresAt > now) return agentState.cache.agents;
  if (agentState.inflight) return agentState.inflight;
  agentState.inflight = (async () => {
    try {
      const rows = await prisma.notificationAgent.findMany({
        where: { enabled: true },
        select: { id: true, kind: true, name: true, events: true, config: true, secret: true },
      });
      const agents = rows.map(toLoaded).filter((a): a is LoadedAgent => a !== null);
      agentState.cache = { agents, expiresAt: Date.now() + AGENT_CACHE_TTL_MS };
      return agents;
    } finally {
      agentState.inflight = null;
    }
  })();
  return agentState.inflight;
}

// ─── Rendering ──────────────────────────────────────────────────────────────

// Literal keys (not built from the event name) so the i18n dead-string check can
// see every one of them.
const AGENT_TEXT_KEYS: Record<NotifyEvent["event"], { title: string; body: string; withText?: string }> = {
  "request.created": { title: "notify.agent.request.created.title", body: "notify.agent.request.created.body", withText: "notify.agent.request.created.bodyWithText" },
  "request.approved": { title: "notify.agent.request.approved.title", body: "notify.agent.request.approved.body" },
  "request.declined": { title: "notify.agent.request.declined.title", body: "notify.agent.request.declined.body", withText: "notify.agent.request.declined.bodyWithText" },
  "request.available": { title: "notify.agent.request.available.title", body: "notify.agent.request.available.body" },
  "issue.created": { title: "notify.agent.issue.created.title", body: "notify.agent.issue.created.body", withText: "notify.agent.issue.created.bodyWithText" },
  "issue.reply": { title: "notify.agent.issue.reply.title", body: "notify.agent.issue.reply.body", withText: "notify.agent.issue.reply.bodyWithText" },
  "issue.resolved": { title: "notify.agent.issue.resolved.title", body: "notify.agent.issue.resolved.body", withText: "notify.agent.issue.resolved.bodyWithText" },
  "vote.threshold": { title: "notify.agent.vote.threshold.title", body: "notify.agent.vote.threshold.body" },
  "arr.manual_interaction": { title: "notify.agent.arr.manual_interaction.title", body: "notify.agent.arr.manual_interaction.body", withText: "notify.agent.arr.manual_interaction.bodyWithText" },
  "arr.grab_completed": { title: "notify.agent.arr.grab_completed.title", body: "notify.agent.arr.grab_completed.body" },
  "agent.test": { title: "notify.agent.agent.test.title", body: "notify.agent.agent.test.body" },
};

export function renderAgentText(ev: NotifyEvent, mediaTitle: string | null): { title: string; message: string } {
  const t = translatorFor(instanceDefaultLocale());
  const vars = {
    title: mediaTitle ?? "",
    media: ev.media ? mediaLabelT(t, ev.media.type) : "",
    user: ev.actor?.name ?? "",
    text: ev.text ?? "",
    votes: ev.votes ?? 0,
  };
  const keys = AGENT_TEXT_KEYS[ev.event];
  return { title: t(keys.title, vars), message: t(ev.text && keys.withText ? keys.withText : keys.body, vars) };
}

async function buildPayloads(events: NotifyEvent[]): Promise<WebhookPayload[]> {
  const locale = instanceDefaultLocale();
  const refs = events.flatMap((e) => (e.media ? [{ title: e.media.title, tmdbId: e.media.tmdbId ?? undefined, mediaType: e.media.type }] : []));
  const resolve = await titleResolver(refs, [locale]);
  const siteUrl = calendarSiteUrl();
  const timestamp = new Date().toISOString();
  return events.map((ev) => {
    const mediaTitle = ev.media ? resolve({ title: ev.media.title, tmdbId: ev.media.tmdbId ?? undefined, mediaType: ev.media.type }, locale) : null;
    const { title, message } = renderAgentText(ev, mediaTitle);
    return buildWebhookPayload(ev, { siteUrl, title, message, mediaTitle, timestamp });
  });
}

// ─── Delivery ───────────────────────────────────────────────────────────────

export interface DeliveryResult {
  verdict: DeliveryVerdict;
  status: number | null;
  error: string | null;
}

function requestFor(agent: LoadedAgent, p: WebhookPayload): { url: string; headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "Summonarr" };
  if (agent.kind === "webhook") {
    const cfg = agent.config as WebhookConfig;
    if (agent.secret) headers[cfg.headerName] = agent.secret;
    const body = cfg.template ? renderTemplate(cfg.template, p) : JSON.stringify(p);
    return { url: cfg.url, headers, body };
  }
  if (agent.kind === "ntfy") {
    const cfg = agent.config as NtfyConfig;
    if (agent.secret) headers.Authorization = `Bearer ${agent.secret}`;
    return { url: ntfyPublishUrl(cfg.url), headers, body: JSON.stringify(buildNtfyBody(cfg, p)) };
  }
  const cfg = agent.config as GotifyConfig;
  // Header, never the ?token= query string — a URL ends up in proxy access logs.
  if (agent.secret) headers["X-Gotify-Key"] = agent.secret;
  return { url: gotifyMessageUrl(cfg.url), headers, body: JSON.stringify(buildGotifyBody(cfg, p)) };
}

/** One attempt. Admin-entered URL ⇒ safeFetchAdminConfigured (guardrail 5a): LAN ok, metadata blocked. */
export async function deliverOnce(agent: LoadedAgent, p: WebhookPayload): Promise<DeliveryResult> {
  const { url, headers, body } = requestFor(agent, p);
  try {
    const res = await safeFetchAdminConfigured(url, { method: "POST", headers, body, timeoutMs: AGENT_FETCH_TIMEOUT_MS });
    // Drain so the socket is released; the body is never used.
    await res.body?.cancel().catch(() => {});
    const verdict = classifyStatus(res.status);
    return { verdict, status: res.status, error: verdict === "ok" ? null : `HTTP ${res.status}` };
  } catch (err) {
    // An SSRF-policy refusal is a configuration problem — retrying can't fix it.
    if (err instanceof SafeFetchError && err.reason !== "timeout" && err.reason !== "network") {
      return { verdict: "fail", status: null, error: err.message.slice(0, 300) };
    }
    return { verdict: "retry", status: null, error: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
  }
}

function recordOutcome(agentId: string, r: DeliveryResult): void {
  void prisma.notificationAgent
    .update({
      where: { id: agentId },
      data: { lastStatus: r.verdict === "ok" ? "ok" : "failed", lastError: r.error, lastAttemptAt: new Date() },
      select: { id: true },
    })
    .catch(() => {
      // Deleted between send and record, or a DB blip — bookkeeping only.
    });
}

async function deliverWithRetry(agent: LoadedAgent, p: WebhookPayload, attempt = 0): Promise<void> {
  const r = await deliverOnce(agent, p);
  if (r.verdict === "retry" && attempt < RETRY_DELAYS_MS.length) {
    // In-memory retry: a restart drops pending retries (accepted — guardrail 14c).
    scheduleDelayed(RETRY_DELAYS_MS[attempt], () => deliverWithRetry(agent, p, attempt + 1), { name: `notify-agent:${agent.id}` });
    return;
  }
  recordOutcome(agent.id, r);
  if (r.verdict !== "ok") {
    console.warn(`[notify-agents] "${agent.name}" (${agent.kind}) delivery of ${p.event} failed: ${r.error ?? "unknown error"}`);
  }
}

async function dispatch(events: NotifyEvent[]): Promise<void> {
  if (events.length === 0) return;
  if (!(await isFeatureEnabled(AGENTS_FEATURE_KEY))) return;
  const agents = await loadEnabledAgents();
  const interested = events.filter((e) => agents.some((a) => a.events.includes(e.event)));
  if (interested.length === 0) return;
  const payloads = await buildPayloads(interested);
  const jobs = payloads.flatMap((p) => agents.filter((a) => a.events.includes(p.event)).map((agent) => ({ agent, p })));
  // Bounded (guardrail 31): a backlog "now available" batch can be hundreds of events.
  await settleLimit(jobs, AGENT_SEND_CONCURRENCY, ({ agent, p }) => deliverWithRetry(agent, p));
}

/**
 * Fire-and-forget. Never throws, never awaited by the caller's response path.
 * Callers pass the STORED (English) media title; this localizes at send time.
 */
export function emitNotificationEvent(ev: NotifyEvent): void {
  emitNotificationEvents([ev]);
}

export function emitNotificationEvents(events: NotifyEvent[]): void {
  if (events.length === 0) return;
  void dispatch(events).catch((err) => console.error("[notify-agents] dispatch failed:", err instanceof Error ? err.message : err));
}

/** The Test button: one immediate attempt, no retry, outcome recorded and returned. */
export async function sendAgentTest(agent: LoadedAgent, ev: NotifyEvent): Promise<DeliveryResult> {
  const [p] = await buildPayloads([ev]);
  const r = await deliverOnce(agent, p);
  recordOutcome(agent.id, r);
  return r;
}

export function loadedAgentFromRow(row: { id: string; kind: string; name: string; events: string[]; config: unknown; secret: string | null }): LoadedAgent | null {
  return toLoaded(row);
}
