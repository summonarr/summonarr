"use client";

import { useState } from "react";
import Link from "next/link";
import { X, ExternalLink } from "@/components/icons";
import { safeExternalHref } from "@/lib/safe-url";
import { useT } from "@/components/i18n/i18n-provider";
import { rich } from "@/components/settings/forms/rich";

interface DiscordJoinModalProps {
  inviteUrl: string;
}

export function DiscordJoinModal({ inviteUrl }: DiscordJoinModalProps) {
  const t = useT();
  const [dismissed, setDismissed] = useState(false);

  const href = safeExternalHref(inviteUrl);
  if (dismissed || !href) return null;

  // bg-indigo-600 is remapped to the user's accent colour (--ds-accent), so all
  // text and icons here use --ds-accent-fg, the colour picked to stay readable
  // on that accent (guardrail 42). Hover uses opacity rather than a second
  // colour, which could clash with some accents.
  return (
    <div className="flex items-center gap-3 bg-indigo-600 px-4 py-2 text-sm text-[var(--ds-accent-fg)]">
      <span className="flex-1">
        {rich(t("shared.discordJoin.message"), {
          link: (
            <Link href="/profile" className="underline underline-offset-2 font-medium hover:opacity-80 transition-opacity">
              {t("shared.discordJoin.linkAccount")}
            </Link>
          ),
        })}
      </span>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="shrink-0 inline-flex items-center gap-1 font-medium underline underline-offset-2 hover:opacity-80 transition-opacity whitespace-nowrap"
      >
        {t("shared.discordJoin.join")} <ExternalLink className="w-3.5 h-3.5" />
      </a>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="shrink-0 inline-flex items-center justify-center rounded-md opacity-80 hover:opacity-100 transition-opacity"
        style={{ width: 32, height: 32, color: "var(--ds-accent-fg)" }}
        aria-label={t("shared.common.dismiss")}
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
