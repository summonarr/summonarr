"use client";

import { useState } from "react";
import { X, ExternalLink } from "lucide-react";

interface DiscordJoinBannerProps {
  inviteUrl: string;
}

export function DiscordJoinModal({ inviteUrl }: DiscordJoinBannerProps) {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  return (
    <div className="flex items-center gap-3 bg-indigo-600 px-4 py-2.5 text-sm text-white">
      <span className="flex-1">
        Join our Discord server to request media directly from Discord, then{" "}
        <a href="/profile" className="underline underline-offset-2 font-medium hover:text-indigo-200">
          link your account
        </a>
        .
      </span>
      <a
        href={inviteUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="shrink-0 inline-flex items-center gap-1 font-medium underline underline-offset-2 hover:text-indigo-200 whitespace-nowrap"
      >
        Join Discord <ExternalLink className="w-3.5 h-3.5" />
      </a>
      <button
        onClick={() => setDismissed(true)}
        className="shrink-0 text-indigo-200 hover:text-white transition-colors"
        aria-label="Dismiss"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
