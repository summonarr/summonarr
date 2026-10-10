// Radarr/Sonarr health + one-click webhook setup: the data half. Reads each
// configured instance's /system/status, /health and Connect list live
// (guardrail 32 — every instance, by slug; guardrail 5 — through arrFetch),
// and creates or repairs Summonarr's Webhook Connect entry on request. The
// pure rules live in arr-health.ts.
//
// The webhook secret never leaves the server: the report carries only the
// verdict, and the URL handed to Radarr/Sonarr is built here.
import { randomBytes } from "node:crypto";
import { ArrResponseError, arrErrorMessage, arrFetch, getArrCfg, type ArrCfg } from "./arr";
import { arrSettingKey, DEFAULT_ARR_INSTANCE } from "./arr-instances";
import { getSyncableArrInstances } from "./arr-instance-registry";
import { settleLimit } from "./concurrency";
import { isFeatureEnabled } from "./features";
import { prisma } from "./prisma";
import {
  arrValidationMessage,
  buildWebhookResource,
  buildWebhookUrl,
  evaluateWebhook,
  normalizeHealthChecks,
  webhookTemplate,
  type ArrHealthCheck,
  type ArrHealthService,
  type NotificationResource,
  type WebhookState,
} from "./arr-health";

export const HEALTH_SERVICES: readonly ArrHealthService[] = ["radarr", "sonarr"];

export interface ArrInstanceHealth {
  service: ArrHealthService;
  slug: string;
  name: string;
  /** False when /system/status could not be read — nothing else below is meaningful then. */
  reachable: boolean;
  error: string | null;
  version: string | null;
  checks: ArrHealthCheck[];
  /** "unknown" when the Connect list could not be read. */
  webhook: { state: WebhookState | "unknown"; missingEvents: string[] };
}

export interface ArrHealthReport {
  instances: ArrInstanceHealth[];
}

const HEALTH_CONCURRENCY = 4;

/**
 * The token /api/webhooks/<service> accepts for this instance: its own
 * WebhookSecret, or — for the DEFAULT instance only — the legacy shared
 * `webhookSecret`. The same resolution the webhook handlers make; "" = none.
 */
export async function effectiveWebhookSecret(service: ArrHealthService, slug: string): Promise<string> {
  const ownKey = arrSettingKey(service, slug, "WebhookSecret");
  const keys = slug === DEFAULT_ARR_INSTANCE ? [ownKey, "webhookSecret"] : [ownKey];
  const rows = await prisma.setting.findMany({ where: { key: { in: keys } } });
  const get = (k: string) => rows.find((r) => r.key === k)?.value || "";
  return get(ownKey) || (slug === DEFAULT_ARR_INSTANCE ? get("webhookSecret") : "");
}

async function enabledInstances(): Promise<Array<{ service: ArrHealthService; slug: string; name: string }>> {
  const out: Array<{ service: ArrHealthService; slug: string; name: string }> = [];
  for (const service of HEALTH_SERVICES) {
    if (!(await isFeatureEnabled(`feature.integration.${service}`))) continue;
    for (const inst of await getSyncableArrInstances(service)) out.push({ service, slug: inst.slug, name: inst.name });
  }
  return out;
}

async function readInstanceHealth(inst: { service: ArrHealthService; slug: string; name: string }): Promise<ArrInstanceHealth> {
  const base: ArrInstanceHealth = {
    ...inst,
    reachable: false,
    error: null,
    version: null,
    checks: [],
    webhook: { state: "unknown", missingEvents: [] },
  };
  const cfg = await getArrCfg(inst.service, inst.slug);
  if (!cfg) return { ...base, error: "not configured" };
  try {
    const status = await arrFetch<{ version?: unknown }>(cfg, "/api/v3/system/status");
    base.reachable = true;
    base.version = typeof status?.version === "string" ? status.version.slice(0, 50) : null;
  } catch (err) {
    return { ...base, error: arrErrorMessage(err) };
  }
  // Health and the Connect list are independent: one failing must not hide the other.
  const [health, notifications, secret] = await Promise.allSettled([
    arrFetch<unknown>(cfg, "/api/v3/health"),
    arrFetch<unknown>(cfg, "/api/v3/notification"),
    effectiveWebhookSecret(inst.service, inst.slug),
  ]);
  if (health.status === "fulfilled") base.checks = normalizeHealthChecks(health.value);
  else base.error = arrErrorMessage(health.reason);
  if (notifications.status === "fulfilled" && secret.status === "fulfilled") {
    const verdict = evaluateWebhook(notifications.value, inst.service, secret.value);
    base.webhook = { state: verdict.state, missingEvents: verdict.missingEvents };
  }
  return base;
}

/** Every configured Radarr/Sonarr instance's version, health checks and webhook verdict. */
export async function loadArrHealth(): Promise<ArrHealthReport> {
  const instances = await enabledInstances();
  const settled = await settleLimit(instances, HEALTH_CONCURRENCY, readInstanceHealth);
  return {
    instances: settled.map((s, i) =>
      s.status === "fulfilled"
        ? s.value
        : { ...instances[i], reachable: false, error: arrErrorMessage(s.reason), version: null, checks: [], webhook: { state: "unknown" as const, missingEvents: [] } },
    ),
  };
}

// ── one-click setup ──────────────────────────────────────────────────────────

export class WebhookInstanceError extends Error {}
/** Radarr/Sonarr refused the entry — usually its own test POST to Summonarr failed. */
export class WebhookRefusedError extends Error {
  readonly detail: string | null;
  constructor(detail: string | null) {
    super("webhook refused");
    this.detail = detail;
  }
}
/** The instance's schema has no Webhook template Summonarr recognizes. */
export class WebhookSchemaError extends Error {}

export interface WebhookSetupResult {
  outcome: "created" | "updated" | "unchanged";
  /** A webhook secret was generated for the instance because it had none. */
  secretGenerated: boolean;
}

async function configuredCfg(service: ArrHealthService, slug: string): Promise<ArrCfg> {
  const configured = await getSyncableArrInstances(service);
  if (!configured.some((i) => i.slug === slug)) throw new WebhookInstanceError(slug);
  const cfg = await getArrCfg(service, slug);
  if (!cfg) throw new WebhookInstanceError(slug);
  return cfg;
}

async function saveOrRefuse<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ArrResponseError && err.status === 400) throw new WebhookRefusedError(arrValidationMessage(err.body));
    throw err;
  }
}

/**
 * Create — or repair — the Summonarr Webhook entry in one instance's Connect
 * settings. `base` is Summonarr's address AS RADARR/SONARR REACH IT (validated
 * by normalizeWebhookBase). Radarr/Sonarr test-POST the URL before saving, so a
 * success here means the instance reached Summonarr and authenticated.
 *
 *   • An instance with no secret gets one generated and stored (the Prisma
 *     extension encrypts it — guardrail 7a); the old copy-paste URL had nothing
 *     to authenticate with anyway.
 *   • An existing entry pointing at /api/webhooks/<service> is UPDATED in place
 *     (its URL and Summonarr's events), never duplicated; an entry that is
 *     already correct is left alone.
 */
export async function setupArrWebhook(
  service: ArrHealthService,
  slug: string,
  base: string,
  opts: { onSecretGenerated?: () => void } = {},
): Promise<WebhookSetupResult> {
  const cfg = await configuredCfg(service, slug);
  let secret = await effectiveWebhookSecret(service, slug);
  let secretGenerated = false;
  if (!secret) {
    const candidate = randomBytes(24).toString("hex");
    const key = arrSettingKey(service, slug, "WebhookSecret");
    // Create-if-absent (the guardrail-23 one-shot shape): two setups racing on
    // one instance each make a candidate, exactly one row lands, and the loser
    // uses the winner's — otherwise the second overwrite strands the first
    // hook's token. createMany is encrypted by the Prisma extension (7a).
    const created = await prisma.setting.createMany({ data: [{ key, value: candidate }], skipDuplicates: true });
    if (created.count === 1) {
      secret = candidate;
      secretGenerated = true;
    } else {
      secret = await effectiveWebhookSecret(service, slug);
      if (!secret) {
        // The row exists but is blank (a cleared secret): nothing authenticates
        // with it, so there is no token to strand by overwriting it.
        await prisma.setting.upsert({ where: { key }, create: { key, value: candidate }, update: { value: candidate } });
        secret = candidate;
        secretGenerated = true;
      }
    }
    if (secretGenerated) opts.onSecretGenerated?.();
  }
  const url = buildWebhookUrl(base, service, secret);
  const list = await arrFetch<unknown>(cfg, "/api/v3/notification");
  const verdict = evaluateWebhook(list, service, secret);
  const existing = verdict.id !== null && Array.isArray(list)
    ? (list as NotificationResource[]).find((n) => n && n.id === verdict.id) ?? null
    : null;

  if (existing) {
    // Correct token, every event on, and already pointing at this base: nothing to do.
    const currentUrl = Array.isArray(existing.fields)
      ? (existing.fields as Array<{ name?: unknown; value?: unknown }>).find((f) => f?.name === "url")?.value
      : undefined;
    if (verdict.state === "ok" && currentUrl === url) return { outcome: "unchanged", secretGenerated };
    const body = buildWebhookResource(existing, service, url, { isNew: false });
    if (!body) throw new WebhookSchemaError();
    await saveOrRefuse(() => arrFetch<unknown>(cfg, `/api/v3/notification/${verdict.id}`, { method: "PUT", body: JSON.stringify(body) }));
    return { outcome: "updated", secretGenerated };
  }

  const template = webhookTemplate(await arrFetch<unknown>(cfg, "/api/v3/notification/schema"));
  const body = template ? buildWebhookResource(template, service, url, { isNew: true }) : null;
  if (!body) throw new WebhookSchemaError();
  await saveOrRefuse(() => arrFetch<unknown>(cfg, "/api/v3/notification", { method: "POST", body: JSON.stringify(body) }));
  return { outcome: "created", secretGenerated };
}
