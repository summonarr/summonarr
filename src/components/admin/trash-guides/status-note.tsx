"use client";

import { AlertTriangle, CheckCircle, Clock, XCircle } from "@/components/icons";

// The one-line result beside a TRaSH card's buttons: done (green), failed
// (red), skipped because a run already holds the lock (amber clock), or skipped
// because TRaSH is off on the server (amber warning).
const TONES = {
  ok: { className: "text-green-400", Icon: CheckCircle },
  error: { className: "text-red-400", Icon: XCircle },
  running: { className: "text-amber-400", Icon: Clock },
  disabled: { className: "text-amber-400", Icon: AlertTriangle },
} as const;

export type StatusNoteTone = keyof typeof TONES;

export function StatusNote({ tone, children }: { tone: StatusNoteTone; children: React.ReactNode }) {
  const { className, Icon } = TONES[tone];
  return (
    <span className={`text-xs ${className} flex items-center gap-1.5`}>
      <Icon className="w-3.5 h-3.5" />
      {children}
    </span>
  );
}
