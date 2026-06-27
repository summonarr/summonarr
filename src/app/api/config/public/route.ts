import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { getFeatureFlags } from "@/lib/features";
import { safeExternalHref } from "@/lib/safe-url";

// User-readable slice of admin config for native clients. The web reads these
// from server components (donate links, MOTD) or the admin-only /api/settings
// (feature flags); a native client has neither, so this endpoint exposes the
// small, non-sensitive set it needs to render parity UI and — via the feature
// flags — gate page/nav visibility exactly like the web does (requireFeature).
//
// Keep this list to non-sensitive, already user-facing keys. NEVER add API
// keys, tokens, webhook secrets, or server URLs here.
const PUBLIC_SETTING_KEYS = [
  "siteTitle",
  "motdEnabled",
  "motdTitle",
  "motdBody",
  "donationPaypal",
  "donationVenmo",
  "donationZelle",
  "donationAmazon",
  "donationPatreon",
  "donationBuyMeACoffee",
] as const;

export const GET = withAuth(async () => {
  const rows = await prisma.setting.findMany({
    where: { key: { in: [...PUBLIC_SETTING_KEYS] } },
  });
  const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const features = await getFeatureFlags();

  return NextResponse.json({
    siteTitle: cfg.siteTitle ?? null,
    motd: {
      enabled: cfg.motdEnabled === "true",
      title: cfg.motdTitle ?? null,
      body: cfg.motdBody ?? null,
    },
    // Donation values are admin-stored but rendered as <a href> by native
    // clients. Sanitize each through safeExternalHref so a javascript:/data:/
    // vbscript: scheme can never reach a client link. Non-URL handles (e.g.
    // "@alice") parse as non-http and collapse to null here — that's acceptable
    // for the native surface, which only renders the http(s) link form.
    donate: {
      paypal: safeExternalHref(cfg.donationPaypal) ?? null,
      venmo: safeExternalHref(cfg.donationVenmo) ?? null,
      zelle: safeExternalHref(cfg.donationZelle) ?? null,
      amazon: safeExternalHref(cfg.donationAmazon) ?? null,
      patreon: safeExternalHref(cfg.donationPatreon) ?? null,
      buyMeACoffee: safeExternalHref(cfg.donationBuyMeACoffee) ?? null,
    },
    features,
  });
});
