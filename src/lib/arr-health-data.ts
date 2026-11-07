// Radarr/Sonarr health + one-click webhook setup: the data half. Reads each
// configured instance's /system/status, /health and Connect list live
// (guardrail 32 — every instance, by slug; guardrail 5 — through arrFetch),
// and creates or repairs Summonarr's Webhook Connect entry on request. The
// pure rules live in arr-health.ts.
//
// The webhook secret never leaves the server: the report carries only the
// verdict, and the URL handed to Radarr/Sonarr is built here.
import { randomBytes } from "node:crypto";
import { ArrResponseError, arrErrorKind, arrErrorMessage, arrFetch, getArrCfg, type ArrCfg } from "./arr";
import { ArrInstanceError, configuredArrCfg, enabledArrInstances } from "./arr-admin";
import type { ArrErrorKind } from "./arr-error-kind";
import { arrSettingKey, DEFAULT_ARR_INSTANCE } from "./arr-instances";
import { settleLimit } from "./concurrency";
import { prisma } from "./prisma";
import { isPrismaErrorCode } from "./prisma-errors";
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
  webhookSetupTarget,
} from "./arr-health";

export const HEALTH_SERVICES: readonly ArrHealthService[] = ["radarr", "sonarr"];

export interface ArrInstanceHealth {
  service: ArrHealthService;
  slug: string;
  name: string;
  /** False when /system/status could not be read — nothing else below is meaningful then. */
  reachable: boolean;
  error: string | null;
  /** Why it failed, for translated display; null with no error. */
  errorKind: ArrErrorKind | null;
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

async function readInstanceHealth(inst: { service: ArrHealthService; slug: string; name: string }): Promise<ArrInstanceHealth> {
  const base: ArrInstanceHealth = {
    ...inst,
    reachable: false,
    error: null,
    errorKind: null,
    version: null,
    checks: [],
    webhook: { state: "unknown", missingEvents: [] },
  };
  const cfg = await getArrCfg(inst.service, inst.slug);
  if (!cfg) return { ...base, error: "not configured", errorKind: "other" };
  try {
    const status = await arrFetch<{ version?: unknown }>(cfg, "/api/v3/system/status");
    base.reachable = true;
    base.version = typeof status?.version === "string" ? status.version.slice(0, 50) : null;
  } catch (err) {
    return { ...base, error: arrErrorMessage(err), errorKind: arrErrorKind(err) };
  }
  // Health and the Connect list are independent: one failing must not hide the other.
  const [health, notifications, secret] = await Promise.allSettled([
    arrFetch<unknown>(cfg, "/api/v3/health"),
    arrFetch<unknown>(cfg, "/api/v3/notification"),
    effectiveWebhookSecret(inst.service, inst.slug),
  ]);
  if (health.status === "fulfilled") base.checks = normalizeHealthChecks(health.value);
  else {
    base.error = arrErrorMessage(health.reason);
    base.errorKind = arrErrorKind(health.reason);
  }
  if (notifications.status === "fulfilled" && secret.status === "fulfilled") {
    const verdict = evaluateWebhook(notifications.value, inst.service, secret.value);
    base.webhook = { state: verdict.state, missingEvents: verdict.missingEvents };
  }
  return base;
}

/** Every configured Radarr/Sonarr instance's version, health checks and webhook verdict. */
export async function loadArrHealth(): Promise<ArrHealthReport> {
  const instances = await enabledArrInstances();
  const settled = await settleLimit(instances, HEALTH_CONCURRENCY, readInstanceHealth);
  return {
    instances: settled.map((s, i) =>
      s.status === "fulfilled"
        ? s.value
        : { ...instances[i], reachable: false, error: arrErrorMessage(s.reason), errorKind: arrErrorKind(s.reason), version: null, checks: [], webhook: { state: "unknown" as const, missingEvents: [] } },
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

// A configured instance only (guardrail 32 — configuredArrCfg), refused as this module's own error.
async function configuredCfg(service: ArrHealthService, slug: string): Promise<ArrCfg> {
  try {
    return await configuredArrCfg(service, slug);
  } catch (err) {
    if (err instanceof ArrInstanceError) throw new WebhookInstanceError(slug);
    throw err;
  }
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
 *   • This deployment's existing entry (webhookSetupTarget: our token, else our
 *     address, else the only Summonarr entry there is) is UPDATED in place
 *     (its URL and Summonarr's events), never duplicated; an entry that is
 *     already correct is left alone. Entries of another Summonarr sharing the
 *     arr are not touched — a new entry is created beside them.
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
        // with it, so there is no token to strand by filling it. Filled only
        // WHILE blank — two setups racing here would otherwise each write their
        // own candidate and push it to the arr, and the arr would keep a token
        // the database no longer holds. The loser (P2025: no blank row left)
        // uses the winner's. `update` runs the encryption extension (7a).
        try {
          await prisma.setting.update({ where: { key, value: "" }, data: { value: candidate } });
          secret = candidate;
          secretGenerated = true;
        } catch (err) {
          if (!isPrismaErrorCode(err, "P2025")) throw err;
          secret = await effectiveWebhookSecret(service, slug);
          if (!secret) {
            // Not blank, yet it reads as nothing: a value that no longer
            // decrypts. Nothing can authenticate with it either.
            await prisma.setting.upsert({ where: { key }, create: { key, value: candidate }, update: { value: candidate } });
            secret = candidate;
            secretGenerated = true;
          }
        }
      }
    }
    if (secretGenerated) opts.onSecretGenerated?.();
  }
  const url = buildWebhookUrl(base, service, secret);
  const list = await arrFetch<unknown>(cfg, "/api/v3/notification");
  const verdict = evaluateWebhook(list, service, secret);
  // Only an entry that is THIS deployment's is rewritten — another Summonarr
  // sharing the arr keeps its own (webhookSetupTarget).
  const targetId = webhookSetupTarget(list, service, secret, url);
  const existing = targetId !== null && Array.isArray(list)
    ? (list as NotificationResource[]).find((n) => n && n.id === targetId) ?? null
    : null;

  if (existing) {
    // Correct token, every event on, and already pointing at this base: nothing to do.
    const currentUrl = Array.isArray(existing.fields)
      ? (existing.fields as Array<{ name?: unknown; value?: unknown }>).find((f) => f?.name === "url")?.value
      : undefined;
    if (verdict.state === "ok" && verdict.id === targetId && currentUrl === url) return { outcome: "unchanged", secretGenerated };
    const body = buildWebhookResource(existing, service, url, { isNew: false });
    if (!body) throw new WebhookSchemaError();
    await saveOrRefuse(() => arrFetch<unknown>(cfg, `/api/v3/notification/${targetId}`, { method: "PUT", body: JSON.stringify(body) }));
    return { outcome: "updated", secretGenerated };
  }

  const template = webhookTemplate(await arrFetch<unknown>(cfg, "/api/v3/notification/schema"));
  const body = template ? buildWebhookResource(template, service, url, { isNew: true }) : null;
  if (!body) throw new WebhookSchemaError();
  await saveOrRefuse(() => arrFetch<unknown>(cfg, "/api/v3/notification", { method: "POST", body: JSON.stringify(body) }));
  return { outcome: "created", secretGenerated };
}
