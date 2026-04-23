import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { ExternalLink, Heart } from "lucide-react";
import { requireFeature } from "@/lib/features";
import { PageHeader } from "@/components/ui/design";

export const dynamic = "force-dynamic";

export default async function DonatePage() {
  await requireFeature("feature.page.donate");
  const session = await auth();
  if (!session) redirect("/login");

  const keys = [
    "donationPaypal",
    "donationVenmo",
    "donationZelle",
    "donationAmazon",
  ] as const;
  const rows = await prisma.setting.findMany({
    where: { key: { in: [...keys] } },
  });
  const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  const methods = [
    {
      key: "donationPaypal",
      label: "PayPal",
      value: cfg.donationPaypal ?? "",
      pillBg: "#ffc439",
      pillColor: "#003087",
      href: (v: string) =>
        v.startsWith("http") ? v : `https://paypal.me/${v.replace(/^@/, "")}`,
      hint: "Click to donate via PayPal",
    },
    {
      key: "donationVenmo",
      label: "Venmo",
      value: cfg.donationVenmo ?? "",
      pillBg: "#3d95ce",
      pillColor: "#ffffff",
      href: (v: string) => `https://venmo.com/${v.replace(/^@/, "")}`,
      hint: "Click to pay via Venmo",
    },
    {
      key: "donationZelle",
      label: "Zelle",
      value: cfg.donationZelle ?? "",
      pillBg: "#6d1ed4",
      pillColor: "#ffffff",
      href: () => "https://www.zellepay.com/",
      hint: "Send via your bank's Zelle to:",
      noLink: true,
    },
    {
      key: "donationAmazon",
      label: "Amazon Wishlist",
      value: cfg.donationAmazon ?? "",
      pillBg: "#ff9900",
      pillColor: "#ffffff",
      href: (v: string) => v,
      hint: "View my Amazon Wishlist",
    },
  ].filter((m) => m.value);

  return (
    <div className="ds-page-enter max-w-lg">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <Heart
              style={{ width: 20, height: 20, color: "#f472b6", fill: "#f472b6" }}
            />
            Support Us
          </span>
        }
        subtitle="If you enjoy using this service, consider leaving a donation. Every contribution is appreciated."
      />

      {methods.length === 0 ? (
        <p
          className="ds-mono"
          style={{ fontSize: 12, color: "var(--ds-fg-subtle)" }}
        >
          No donation methods have been configured yet.
        </p>
      ) : (
        <div className="flex flex-col" style={{ gap: 10 }}>
          {methods.map((m) =>
            m.noLink ? (
              <div
                key={m.key}
                style={{
                  padding: 18,
                  background: "var(--ds-bg-2)",
                  border: "1px solid var(--ds-border)",
                  borderRadius: 10,
                }}
              >
                <div className="flex items-center" style={{ marginBottom: 10 }}>
                  <span
                    className="font-semibold inline-flex"
                    style={{
                      padding: "3px 12px",
                      borderRadius: 999,
                      fontSize: 12,
                      background: m.pillBg,
                      color: m.pillColor,
                    }}
                  >
                    {m.label}
                  </span>
                </div>
                <p
                  className="ds-mono"
                  style={{
                    fontSize: 10.5,
                    color: "var(--ds-fg-subtle)",
                    margin: "0 0 4px",
                  }}
                >
                  {m.hint}
                </p>
                <p
                  className="ds-mono"
                  style={{ fontSize: 13, color: "var(--ds-fg)", margin: 0 }}
                >
                  {m.value}
                </p>
              </div>
            ) : (
              <a
                key={m.key}
                href={m.href(m.value)}
                target="_blank"
                rel="noopener noreferrer"
                className="group flex items-center justify-between transition-colors"
                style={{
                  padding: 18,
                  background: "var(--ds-bg-2)",
                  border: "1px solid var(--ds-border)",
                  borderRadius: 10,
                  color: "var(--ds-fg)",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--ds-bg-3)";
                  e.currentTarget.style.borderColor = "var(--ds-border-strong)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "var(--ds-bg-2)";
                  e.currentTarget.style.borderColor = "var(--ds-border)";
                }}
              >
                <div>
                  <span
                    className="font-semibold inline-flex"
                    style={{
                      padding: "3px 12px",
                      borderRadius: 999,
                      fontSize: 12,
                      background: m.pillBg,
                      color: m.pillColor,
                    }}
                  >
                    {m.label}
                  </span>
                  <p
                    className="ds-mono"
                    style={{
                      fontSize: 10.5,
                      color: "var(--ds-fg-subtle)",
                      margin: "12px 0 0",
                    }}
                  >
                    {m.hint}
                  </p>
                </div>
                <ExternalLink
                  className="shrink-0 transition-colors"
                  style={{
                    width: 14,
                    height: 14,
                    color: "var(--ds-fg-subtle)",
                  }}
                />
              </a>
            ),
          )}
        </div>
      )}
    </div>
  );
}
