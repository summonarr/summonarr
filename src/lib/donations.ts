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

export type DonationSettingKey = (typeof DONATION_SETTING_KEYS)[number];

/**
 * The configured methods in display order, each value trimmed; a blank or
 * whitespace-only value is left out. The settings route stores the value as
 * typed, so " alice " must not become a link to "%20alice%20" and "   " must not
 * render an empty card.
 */
export function configuredDonations(
  cfg: Record<string, string | null | undefined>,
): { key: DonationSettingKey; value: string }[] {
  const out: { key: DonationSettingKey; value: string }[] = [];
  for (const key of DONATION_SETTING_KEYS) {
    const value = (cfg[key] ?? "").trim();
    if (value) out.push({ key, value });
  }
  return out;
}

/**
 * True when at least one donation method is configured (non-empty after trim),
 * given an already-loaded Setting map. Drives auto-hiding the Donate page + nav
 * link when there's nothing to link to — independent of the feature toggle.
 */
export function hasDonationLinks(cfg: Record<string, string | null | undefined>): boolean {
  return configuredDonations(cfg).length > 0;
}

// The https-only gate every donation link passes last: the stored values are
// admin text rendered as <a href>, so anything that is not an https URL
// (http:, javascript:, a parse failure) shows as plain text instead.
function httpsUrl(v: string): string | null {
  try {
    const u = new URL(v);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

// Methods that take a bare handle: the canonical profile base, and the host
// forms an admin may paste in front of the handle (matched case-insensitively,
// so "paypal.me/x" doesn't become "https://paypal.me/paypal.me/x").
const PROFILE_LINKS: Partial<Record<DonationSettingKey, { base: string; host: RegExp }>> = {
  donationPaypal: { base: "https://paypal.me/", host: /^(?:www\.)?paypal\.(?:me|com\/paypalme)\//i },
  donationVenmo: { base: "https://venmo.com/", host: /^(?:www\.)?venmo\.com\//i },
  donationPatreon: { base: "https://www.patreon.com/", host: /^(?:www\.)?patreon\.com\//i },
  donationBuyMeACoffee: { base: "https://www.buymeacoffee.com/", host: /^(?:www\.)?buymeacoffee\.com\//i },
};

/**
 * The link a donation method's card opens, or null to show the value as plain
 * text. A value with a URL scheme (any case — "Https://" is a URL) must itself
 * be https; otherwise a handle, with or without a leading "@" or a pasted host,
 * goes onto the method's canonical base. Zelle has no link (a phone number or
 * email), Amazon needs a full URL, and a PayPal email address has no profile
 * URL, so those show as text.
 */
export function donationHref(key: DonationSettingKey, raw: string): string | null {
  const v = raw.trim();
  if (!v || key === "donationZelle") return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(v)) return httpsUrl(v);
  const profile = PROFILE_LINKS[key];
  if (!profile) return null;
  if (key === "donationPaypal" && v.indexOf("@") > 0) return null;
  const handle = v.replace(profile.host, "").replace(/^@/, "");
  return handle ? httpsUrl(profile.base + handle) : null;
}

/** Query-backed variant for callers without a preloaded cfg map. */
export async function hasConfiguredDonationLinks(): Promise<boolean> {
  const rows = await prisma.setting.findMany({ where: { key: { in: [...DONATION_SETTING_KEYS] } } });
  return hasDonationLinks(Object.fromEntries(rows.map((r) => [r.key, r.value])));
}
