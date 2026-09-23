"use client";

import { useState } from "react";
import Link from "next/link";
import { X, ExternalLink } from "@/components/icons";
import { safeExternalHref } from "@/lib/safe-url";

interface DiscordJoinModalProps {
  inviteUrl: string;
}

export function DiscordJoinModal({ inviteUrl }: DiscordJoinModalProps) {
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
        Join our Discord server to request media directly from Discord, then{" "}
        <Link href="/profile" className="underline underline-offset-2 font-medium hover:opacity-80 transition-opacity">
          link your account
        </Link>
        .
      </span>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="shrink-0 inline-flex items-center gap-1 font-medium underline underline-offset-2 hover:opacity-80 transition-opacity whitespace-nowrap"
      >
        Join Discord <ExternalLink className="w-3.5 h-3.5" />
      </a>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="shrink-0 inline-flex items-center justify-center rounded-md opacity-80 hover:opacity-100 transition-opacity"
        style={{ width: 32, height: 32, color: "var(--ds-accent-fg)" }}
        aria-label="Dismiss"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
