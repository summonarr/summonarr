"use client";

import { Wrench, X } from "lucide-react";
import { useState } from "react";

export function MaintenanceBanner({ message }: { message?: string }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  return (
    <div className="bg-yellow-900/30 border-b border-yellow-800/30 px-4 py-2.5 flex items-center gap-3">
      <Wrench className="w-4 h-4 text-yellow-400 shrink-0" />
      <p className="text-sm text-yellow-300 flex-1">
        <span className="font-medium">Maintenance mode is active.</span>
        {message && <span className="text-yellow-400/80 ml-1">{message}</span>}
        <span className="text-yellow-400/60 ml-1">Non-admin users are blocked.</span>
      </p>
      <button
        onClick={() => setDismissed(true)}
        className="text-yellow-500 hover:text-yellow-300 transition-colors"
        aria-label="Dismiss maintenance banner"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
