import { requireAppSession } from "@/lib/require-app-session";
import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import { ExternalLink, Heart } from "@/components/icons";
import { requireFeature } from "@/lib/features";
import {
  DONATION_SETTING_KEYS,
  configuredDonations,
  donationHref,
  type DonationSettingKey,
} from "@/lib/donations";
import { PageHeader } from "@/components/ui/design";
import { getTranslator } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

// The brand pill: the hex pairs set BOTH background and text, so the pill reads
// the same on either theme (guardrail 42).
function MethodPill({ label, bg, color }: { label: string; bg: string; color: string }) {
  return (
    <span
      className="font-semibold inline-flex"
      style={{ padding: "3px 12px", borderRadius: 999, fontSize: 12, background: bg, color }}
    >
      {label}
    </span>
  );
}

function MethodHint({ hint, margin }: { hint: string; margin: string }) {
  return (
    <p className="ds-mono" style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)", margin }}>
      {hint}
    </p>
  );
}

export default async function DonatePage() {
  await requireFeature("feature.page.donate");
  // The shared per-page DB-checked login gate (guardrail 29) — every other
  // (app) page goes through it, so a future change there covers this one too.
  await requireAppSession();

  const rows = await prisma.setting.findMany({
    where: { key: { in: [...DONATION_SETTING_KEYS] } },
  });
  // Trimmed, blank ones dropped — the same rule as the nav gate.
  const configured = configuredDonations(Object.fromEntries(rows.map((r) => [r.key, r.value])));

  // With no donation methods configured, the nav link is hidden and this page
  // returns a 404, so a direct visit can't land on an empty Support Us page.
  if (configured.length === 0) notFound();

  const t = await getTranslator();

  const display: Record<DonationSettingKey, { label: string; pillBg: string; pillColor: string; hint: string }> = {
    donationPaypal: { label: "PayPal", pillBg: "#ffc439", pillColor: "#003087", hint: t("personal.donate.paypalHint") },
    donationVenmo: { label: "Venmo", pillBg: "#3d95ce", pillColor: "#000000", hint: t("personal.donate.venmoHint") },
    donationZelle: { label: "Zelle", pillBg: "#6d1ed4", pillColor: "#ffffff", hint: t("personal.donate.zelleHint") },
    donationAmazon: { label: t("personal.donate.amazonLabel"), pillBg: "#ff9900", pillColor: "#000000", hint: t("personal.donate.amazonHint") },
    donationPatreon: { label: "Patreon", pillBg: "#f96854", pillColor: "#000000", hint: t("personal.donate.patreonHint") },
    donationBuyMeACoffee: { label: "Buy Me a Coffee", pillBg: "#ffdd00", pillColor: "#000000", hint: t("personal.donate.coffeeHint") },
  };

  return (
    <div className="ds-page-enter max-w-lg">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            {/* Token, not a raw hex: this icon sits on the page surface, so it
                has to survive both themes (guardrail 42). */}
            <Heart
              aria-hidden
              style={{ width: 20, height: 20, color: "var(--ds-danger)", fill: "var(--ds-danger)" }}
            />
            {t("personal.donate.title")}
          </span>
        }
        subtitle={t("personal.donate.subtitle")}
      />

      <div className="flex flex-col" style={{ gap: 10 }}>
        {configured.map(({ key, value }) => {
          const m = display[key];
          // null: Zelle, a non-https value, or a PayPal email — shown as text.
          const resolved = donationHref(key, value);
          if (!resolved) {
            return (
              <div
                key={key}
                style={{
                  padding: 18,
                  background: "var(--ds-bg-2)",
                  border: "1px solid var(--ds-border)",
                  borderRadius: 10,
                }}
              >
                <div className="flex items-center" style={{ marginBottom: 10 }}>
                  <MethodPill label={m.label} bg={m.pillBg} color={m.pillColor} />
                </div>
                <MethodHint hint={m.hint} margin="0 0 4px" />
                <p
                  className="ds-mono"
                  style={{ fontSize: 13, color: "var(--ds-fg)", margin: 0, wordBreak: "break-all" }}
                >
                  {value}
                </p>
              </div>
            );
          }
          return (
            <a
              key={key}
              href={resolved}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex items-center justify-between transition-colors bg-[var(--ds-bg-2)] border border-[var(--ds-border)] hover:bg-[var(--ds-bg-3)] hover:border-[var(--ds-border-strong)]"
              style={{
                padding: 18,
                borderRadius: 10,
                color: "var(--ds-fg)",
              }}
            >
              <div>
                <MethodPill label={m.label} bg={m.pillBg} color={m.pillColor} />
                <MethodHint hint={m.hint} margin="12px 0 0" />
              </div>
              <ExternalLink
                className="shrink-0 transition-colors text-[var(--ds-fg-subtle)] group-hover:text-[var(--ds-fg)]"
                style={{
                  width: 14,
                  height: 14,
                }}
              />
            </a>
          );
        })}
      </div>
    </div>
  );
}
