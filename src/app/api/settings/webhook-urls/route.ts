import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { tooManyRequests } from "@/lib/http";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import {
  arrSettingKey,
  DEFAULT_ARR_INSTANCE,
  effectiveWebhookSecretFrom,
  FOURK_ARR_INSTANCE,
  LEGACY_WEBHOOK_SECRET_KEY,
  type ArrService,
} from "@/lib/arr-instances";

// Returns the webhook tokens for the settings-page copy buttons. This exists as
// a separate admin-only endpoint — instead of passing the secrets as props on
// the /settings page — so the tokens cross the wire ONLY when the admin clicks
// "copy", never in the page's server-rendered (RSC) payload where they'd sit
// passively in the document/router cache. Responses are `private, no-store`
// (next.config.ts /api header). The Prisma extension decrypts Setting.value on
// read, so these are plaintext tokens.
//
// Each token is resolved the way the webhook handler resolves it
// (effectiveWebhookSecretFrom): radarr/sonarr fold in the legacy shared secret,
// the 4K keys do not (they're per-instance). One read for all of them.
const SLOTS: ReadonlyArray<{ field: string; service: ArrService; instance: string }> = [
  { field: "radarr", service: "radarr", instance: DEFAULT_ARR_INSTANCE },
  { field: "sonarr", service: "sonarr", instance: DEFAULT_ARR_INSTANCE },
  { field: "radarr4k", service: "radarr", instance: FOURK_ARR_INSTANCE },
  { field: "sonarr4k", service: "sonarr", instance: FOURK_ARR_INSTANCE },
];

// Each copy click reads every token once; a person copying a few URLs stays
// far under this. It bounds a stolen admin session (or a runaway script)
// pulling the secrets in a loop (guardrail 2a: the token leaves the server
// only on a deliberate copy).
const WEBHOOK_URLS_LIMIT = 30;
const WEBHOOK_URLS_WINDOW_MS = 60_000;

export const GET = withAdmin(async (req, _ctx, session) => {
  if (!checkRateLimit(`settings-webhook-urls:${session.user.id}`, WEBHOOK_URLS_LIMIT, WEBHOOK_URLS_WINDOW_MS)) {
    return tooManyRequests(WEBHOOK_URLS_WINDOW_MS / 1000, translatorForRequest(req)("apiAdmin.common.tooManyRequestsLater"));
  }
  const ownKey = (s: (typeof SLOTS)[number]) => arrSettingKey(s.service, s.instance, "WebhookSecret");
  // ?service=<field> narrows the answer to that one token, so a copy click
  // reveals only the secret it needs. Absent or unknown: every token, as before.
  const wanted = req.nextUrl.searchParams.get("service");
  const slots = SLOTS.filter((s) => wanted === null || s.field === wanted);
  const shown = slots.length > 0 ? slots : SLOTS;
  const rows = await prisma.setting.findMany({
    where: { key: { in: [LEGACY_WEBHOOK_SECRET_KEY, ...shown.map(ownKey)] } },
  });
  const value = new Map(rows.map((r) => [r.key, r.value]));
  const legacy = value.get(LEGACY_WEBHOOK_SECRET_KEY);
  return NextResponse.json(
    Object.fromEntries(shown.map((s) => [s.field, effectiveWebhookSecretFrom(s.instance, value.get(ownKey(s)), legacy) || null])),
  );
});
