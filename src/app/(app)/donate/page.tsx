import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { ExternalLink, Heart } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function DonatePage() {
  const session = await auth();
  if (!session) redirect("/login");

  const keys = ["donationPaypal", "donationVenmo", "donationZelle", "donationAmazon"] as const;
  const rows = await prisma.setting.findMany({ where: { key: { in: [...keys] } } });
  const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  const methods = [
    {
      key: "donationPaypal",
      label: "PayPal",
      value: cfg.donationPaypal ?? "",
      color: "text-[#003087]",
      bg: "bg-[#ffc439]",
      href: (v: string) =>
        v.startsWith("http") ? v : `https://paypal.me/${v.replace(/^@/, "")}`,
      hint: "Click to donate via PayPal",
    },
    {
      key: "donationVenmo",
      label: "Venmo",
      value: cfg.donationVenmo ?? "",
      color: "text-white",
      bg: "bg-[#3d95ce]",
      href: (v: string) =>
        `https://venmo.com/${v.replace(/^@/, "")}`,
      hint: "Click to pay via Venmo",
    },
    {
      key: "donationZelle",
      label: "Zelle",
      value: cfg.donationZelle ?? "",
      color: "text-white",
      bg: "bg-[#6d1ed4]",
      href: () => "https://www.zellepay.com/",
      hint: "Send via your bank's Zelle to:",
      noLink: true,
    },
    {
      key: "donationAmazon",
      label: "Amazon Wishlist",
      value: cfg.donationAmazon ?? "",
      color: "text-white",
      bg: "bg-[#ff9900]",
      href: (v: string) => v,
      hint: "View my Amazon Wishlist",
    },
  ].filter((m) => m.value);

  return (
    <div className="max-w-lg">
      <div className="flex items-center gap-3 mb-2">
        <Heart className="w-6 h-6 text-pink-500 fill-pink-500" />
        <h1 className="text-2xl font-bold">Support Us</h1>
      </div>
      <p className="text-zinc-400 text-sm mb-8">
        If you enjoy using this service, consider leaving a donation. Every contribution is appreciated!
      </p>

      {methods.length === 0 ? (
        <p className="text-zinc-500 text-sm">No donation methods have been configured yet.</p>
      ) : (
        <div className="space-y-4">
          {methods.map((m) =>
            m.noLink ? (
              <div key={m.key} className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
                <div className="flex items-center justify-between mb-3">
                  <span className={`text-sm font-semibold px-3 py-1 rounded-full ${m.bg} ${m.color}`}>
                    {m.label}
                  </span>
                </div>
                <p className="text-xs text-zinc-500 mb-1">{m.hint}</p>
                <p className="text-white font-mono text-sm">{m.value}</p>
              </div>
            ) : (
              <a
                key={m.key}
                href={m.href(m.value)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900 p-5 hover:bg-zinc-800 transition-colors group"
              >
                <div>
                  <span className={`text-sm font-semibold px-3 py-1 rounded-full ${m.bg} ${m.color}`}>
                    {m.label}
                  </span>
                  <p className="text-xs text-zinc-500 mt-3">{m.hint}</p>
                </div>
                <ExternalLink className="w-4 h-4 text-zinc-600 group-hover:text-zinc-400 transition-colors shrink-0" />
              </a>
            )
          )}
        </div>
      )}
    </div>
  );
}
