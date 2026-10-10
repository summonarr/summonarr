import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { arrErrorMessage } from "@/lib/arr";
import { normalizeWebhookBase } from "@/lib/arr-health";
import {
  setupArrWebhook,
  WebhookInstanceError,
  WebhookRefusedError,
  WebhookSchemaError,
} from "@/lib/arr-health-data";
import { parseQueueService } from "@/lib/arr-queue-data";
import { auditContext, logAudit } from "@/lib/audit";
import { readJsonCapped } from "@/lib/body-size";
import { calendarSiteUrl } from "@/lib/calendar-feed";
import { isFeatureEnabled } from "@/lib/features";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { sanitizeForLog } from "@/lib/sanitize";

const MAX_BODY_BYTES = 4 * 1024;
const SERVICE_LABEL = { radarr: "Radarr", sonarr: "Sonarr" } as const;

// One-click webhook setup (ADMIN): creates — or repairs in place — Summonarr's
// Webhook entry in one Radarr/Sonarr instance's Connect settings, pointing at
// /api/webhooks/<service>?token=<the instance's secret> (guardrail 2) with the
// events Summonarr handles switched on. `baseUrl` is Summonarr's address AS
// RADARR/SONARR REACH IT (default: AUTH_URL + BASE_PATH). Radarr/Sonarr test the
// URL before saving, so a 422 carries their own reason (the token masked). An
// instance with no webhook secret gets one generated. Audited after the write
// (guardrail 26), recording the base address — never the token.
export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const parsed = await readJsonCapped<Record<string, unknown>>(req, MAX_BODY_BYTES);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  const service = parseQueueService(body.service);
  const instance = body.instance === undefined ? "" : body.instance;
  if (!service || typeof instance !== "string" || instance.length > 100) {
    return NextResponse.json({ error: t("apiAdmin.arrHealth.webhookBodyInvalid") }, { status: 400 });
  }
  const rawBase = body.baseUrl === undefined || body.baseUrl === "" ? calendarSiteUrl() : body.baseUrl;
  const base = normalizeWebhookBase(rawBase);
  if (!base) {
    return NextResponse.json({ error: t("apiAdmin.arrHealth.baseInvalid") }, { status: 400 });
  }
  const label = SERVICE_LABEL[service];
  if (!(await isFeatureEnabled(`feature.integration.${service}`))) {
    return NextResponse.json({ error: t("apiAdmin.missing.integrationDisabled", { service: label }) }, { status: 404 });
  }
  const audit = (details: Record<string, unknown>) =>
    void logAudit({
      userId: session.user.id,
      userName: session.user.name ?? session.user.email ?? null,
      action: "SETTINGS_CHANGE",
      target: `arr-webhook:${service}:${instance}`,
      details: { service, instance, ...details },
      ...auditContext(req, session),
    });
  let result;
  try {
    // A generated secret is a committed settings change of its own: audited
    // the moment it lands, even if Radarr/Sonarr then refuse the webhook.
    result = await setupArrWebhook(service, instance, base, { onSecretGenerated: () => audit({ secretGenerated: true }) });
  } catch (err) {
    if (err instanceof WebhookInstanceError) {
      return NextResponse.json({ error: t("apiAdmin.missing.instanceUnknown", { service: label }) }, { status: 404 });
    }
    if (err instanceof WebhookRefusedError) {
      return NextResponse.json(
        { error: t("apiAdmin.arrHealth.webhookRefused", { service: label }), detail: err.detail },
        { status: 422 },
      );
    }
    if (err instanceof WebhookSchemaError) {
      return NextResponse.json({ error: t("apiAdmin.arrHealth.webhookSchema", { service: label }) }, { status: 502 });
    }
    console.warn(`[arr-health] ${service} instance "${sanitizeForLog(instance)}" webhook setup failed:`, arrErrorMessage(err));
    return NextResponse.json({ error: t("apiAdmin.arrHealth.webhookFailed", { service: label }) }, { status: 502 });
  }
  if (result.outcome !== "unchanged") audit({ outcome: result.outcome, baseUrl: base });
  return NextResponse.json(result);
});
