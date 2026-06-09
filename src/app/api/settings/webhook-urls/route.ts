import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";

// Returns the webhook tokens for the settings-page copy buttons. This exists as
// a separate admin-only endpoint — instead of passing the secrets as props on
// the /settings page — so the tokens cross the wire ONLY when the admin clicks
// "copy", never in the page's server-rendered (RSC) payload where they'd sit
// passively in the document/router cache. Responses are `private, no-store`
// (next.config.ts /api header). The Prisma extension decrypts Setting.value on
// read, so these are plaintext tokens.
//
// radarr/sonarr fold in the legacy shared secret (matching how the webhook
// handler resolves tokens); the 4K keys do not (they're per-instance).
export const GET = withAdmin(async () => {
  const keys = [
    "webhookSecret",
    "radarrWebhookSecret",
    "sonarrWebhookSecret",
    "radarr4kWebhookSecret",
    "sonarr4kWebhookSecret",
  ];
  const rows = await prisma.setting.findMany({ where: { key: { in: keys } } });
  const get = (k: string) => rows.find((r) => r.key === k)?.value || "";
  const legacy = get("webhookSecret");

  return NextResponse.json({
    radarr: get("radarrWebhookSecret") || legacy || null,
    sonarr: get("sonarrWebhookSecret") || legacy || null,
    radarr4k: get("radarr4kWebhookSecret") || null,
    sonarr4k: get("sonarr4kWebhookSecret") || null,
  });
});
