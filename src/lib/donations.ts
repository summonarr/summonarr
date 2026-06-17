import { prisma } from "@/lib/prisma";

// Donation methods exposed on the /donate page and the public config. Kept here
// as the single source of truth so the page, nav gate, and config endpoint don't
// drift on which keys count as a "donation link".
export const DONATION_SETTING_KEYS = [
  "donationPaypal",
  "donationVenmo",
  "donationZelle",
  "donationAmazon",
  "donationPatreon",
  "donationBuyMeACoffee",
] as const;

/**
 * True when at least one donation method is configured (non-empty after trim),
 * given an already-loaded Setting map. Drives auto-hiding the Donate page + nav
 * link when there's nothing to link to — independent of the feature toggle.
 */
export function hasDonationLinks(cfg: Record<string, string | null | undefined>): boolean {
  return DONATION_SETTING_KEYS.some((k) => (cfg[k] ?? "").trim().length > 0);
}

/** Query-backed variant for callers without a preloaded cfg map. */
export async function hasConfiguredDonationLinks(): Promise<boolean> {
  const rows = await prisma.setting.findMany({ where: { key: { in: [...DONATION_SETTING_KEYS] } } });
  return hasDonationLinks(Object.fromEntries(rows.map((r) => [r.key, r.value])));
}
