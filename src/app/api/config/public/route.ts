import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { getFeatureFlags } from "@/lib/features";

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
    donate: {
      paypal: cfg.donationPaypal ?? null,
      venmo: cfg.donationVenmo ?? null,
      zelle: cfg.donationZelle ?? null,
      amazon: cfg.donationAmazon ?? null,
      patreon: cfg.donationPatreon ?? null,
      buyMeACoffee: cfg.donationBuyMeACoffee ?? null,
    },
    features,
  });
});
