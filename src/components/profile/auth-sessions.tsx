"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Loader2, Monitor, Smartphone, Tablet, MapPin, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useHasMounted } from "@/hooks/use-has-mounted";

interface AuthSessionRow {
  id: string;
  sessionId: string;
  deviceType: string;
  deviceLabel: string | null;
  ipAddress: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  isCurrent: boolean;
}

interface AuthSessionsProps {
  sessions: AuthSessionRow[];
}

function DeviceIcon({ deviceType }: { deviceType: string }) {
  if (deviceType === "mobile")  return <Smartphone className="w-4 h-4 shrink-0 text-zinc-400" />;
  if (deviceType === "tablet")  return <Tablet      className="w-4 h-4 shrink-0 text-zinc-400" />;
  return                               <Monitor     className="w-4 h-4 shrink-0 text-zinc-400" />;
}

function timeAgo(date: Date): string {
  const secs = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (secs < 60)   return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

export function AuthSessions({ sessions }: AuthSessionsProps) {
  const router  = useRouter();
  const [revoking, setRevoking] = useState<string | null>(null);
  // `timeAgo` and `toLocaleDateString` both diverge between SSR and CSR
  // (Date.now drift and runtime locale differences). See CLAUDE.md guardrail 16.
  const mounted = useHasMounted();

  async function revoke(sessionId: string) {
    setRevoking(sessionId);
    try {
      await fetch("/api/sessions", {
        method:  "DELETE",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ sessionId }),
      });
      router.refresh();
    } finally {
      setRevoking(null);
    }
  }

  if (sessions.length === 0) {
    return <p className="text-sm text-zinc-500">No active sessions.</p>;
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-zinc-500 mb-3">
        {sessions.length} active session{sessions.length !== 1 ? "s" : ""}
      </p>

      {sessions.map((s) => (
        <div
          key={s.id}
          className={`flex items-start justify-between gap-4 rounded-md border px-3 py-2.5 ${
            s.isCurrent
              ? "border-indigo-500/40 bg-indigo-500/5"
              : "border-zinc-800 bg-zinc-800/50"
          }`}
        >
          <div className="flex items-start gap-2.5 min-w-0">
            <DeviceIcon deviceType={s.deviceType} />
            <div className="min-w-0 space-y-0.5">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm text-zinc-200 truncate">
                  {s.deviceLabel ?? `${s.deviceType.charAt(0).toUpperCase() + s.deviceType.slice(1)} device`}
                </p>
                {s.isCurrent && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300 font-medium shrink-0">
                    This session
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                {s.ipAddress && (
                  <span className="flex items-center gap-1 text-xs text-zinc-500">
                    <MapPin className="w-3 h-3" />{s.ipAddress}
                  </span>
                )}
                <span className="flex items-center gap-1 text-xs text-zinc-500">
                  <Clock className="w-3 h-3" />Active {mounted ? timeAgo(s.lastSeenAt) : ""}
                </span>
              </div>
              <p className="text-xs text-zinc-600">
                Expires {mounted ? new Date(s.expiresAt).toLocaleDateString() : ""}
              </p>
            </div>
          </div>

          {!s.isCurrent && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              // Mobile audit F-4.2: bumped from h-7 w-7 (28x28, below HIG) to
              // h-9 w-9 (36x36, matches the chrome-icon convention) and added
              // aria-label so screen readers announce purpose. The action is
              // destructive (sign out the device) so labelling matters.
              aria-label={`Revoke session ${s.deviceLabel ?? `${s.deviceType} device`}${s.ipAddress ? ` from ${s.ipAddress}` : ""}`}
              title="Revoke session"
              className="shrink-0 text-zinc-400 hover:text-red-400 hover:bg-red-400/10 h-9 w-9 p-0 mt-0.5"
              disabled={revoking === s.sessionId}
              onClick={() => revoke(s.sessionId)}
            >
              {revoking === s.sessionId
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Trash2  className="w-3.5 h-3.5" />}
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
