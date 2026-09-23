"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Loader2, Monitor, Smartphone, Tablet, MapPin, Clock, Check, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { withBasePath } from "@/lib/base-path";
import { formatRelativeTime } from "@/lib/relative-time";
import { isIndefiniteDeadline } from "@/lib/session-lifetime";

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

// Lists the user's active auth sessions with per-device revoke (confirm-then-delete).
export function AuthSessions({ sessions }: AuthSessionsProps) {
  const router  = useRouter();
  const [revoking, setRevoking] = useState<string | null>(null);
  const [confirmingRevoke, setConfirmingRevoke] = useState<string | null>(null);
  // Signing out ANOTHER device needs extra proof ("step-up") on the server:
  // password accounts must re-enter their password, and single-sign-on accounts
  // must have signed in recently. So we check res.ok and ask for the password
  // when the server says so, instead of assuming the revoke worked.
  const [passwordFor, setPasswordFor] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [revokeError, setRevokeError] = useState<string | null>(null);
  // `formatRelativeTime` and `toLocaleDateString` give different text on the
  // server and in the browser (the clock moves on, and the locale can differ),
  // so they only render once mounted. See CLAUDE.md guardrail 16.
  const mounted = useHasMounted();

  async function revoke(sessionId: string, confirmPassword?: string) {
    setRevoking(sessionId);
    setConfirmingRevoke(null);
    setRevokeError(null);
    try {
      const res = await fetch(withBasePath("/api/sessions"), {
        method:  "DELETE",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(confirmPassword ? { sessionId, confirmPassword } : { sessionId }),
      });
      if (res.ok) {
        setPasswordFor(null);
        setPassword("");
        router.refresh();
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      if (data.error === "password-required") {
        // Expected on the first attempt for a credentials account — ask, retry.
        setPasswordFor(sessionId);
        setPassword("");
        setRevokeError(null);
      } else if (data.error === "invalid-password") {
        setPasswordFor(sessionId);
        setPassword("");
        setRevokeError("Incorrect password.");
      } else {
        setPasswordFor(null);
        setPassword("");
        setRevokeError(data.message ?? data.error ?? "Failed to revoke session.");
      }
    } catch {
      setRevokeError("Failed to revoke session.");
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
          className={`flex flex-wrap items-start justify-between gap-4 rounded-md border px-3 py-2.5 ${
            s.isCurrent
              ? "border-indigo-500/40 bg-indigo-500/5"
              : "border-[var(--ds-border)] bg-[var(--ds-bg-1)]"
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
                  <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-indigo-600 text-[var(--ds-accent-fg)] font-semibold shrink-0">
                    <Check className="w-3 h-3" />
                    This device
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
                  <Clock className="w-3 h-3" />Active {mounted ? formatRelativeTime(s.lastSeenAt) : ""}
                </span>
              </div>
              <p className="text-xs text-zinc-500">
                {/* A native-app (iOS) session carries the never-reached sentinel
                    deadline (session-lifetime.ts) — it ends only when revoked. */}
                {isIndefiniteDeadline(s.expiresAt)
                  ? "Never expires — until revoked"
                  : <>Expires {mounted ? new Date(s.expiresAt).toLocaleDateString() : ""}</>}
              </p>
            </div>
          </div>

          {!s.isCurrent && passwordFor !== s.sessionId && confirmingRevoke !== s.sessionId && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              // A 36x36 tap area, plus an aria-label so screen readers say
              // what this button does (sign that device out).
              aria-label={`Revoke session ${s.deviceLabel ?? `${s.deviceType} device`}${s.ipAddress ? ` from ${s.ipAddress}` : ""}`}
              title="Revoke session"
              className="shrink-0 text-zinc-400 hover:text-red-400 hover:bg-red-400/10 h-9 w-9 p-0 mt-0.5"
              disabled={revoking === s.sessionId}
              onClick={() => setConfirmingRevoke(s.sessionId)}
            >
              {revoking === s.sessionId
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Trash2  className="w-3.5 h-3.5" />}
            </Button>
          )}
          {!s.isCurrent && passwordFor !== s.sessionId && confirmingRevoke === s.sessionId && (
            <div className="flex items-center gap-1.5 shrink-0 mt-0.5">
              <Button
                type="button"
                size="sm"
                aria-label="Confirm revoke session"
                className="h-9 px-2.5 bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)] gap-1"
                onClick={() => revoke(s.sessionId)}
                autoFocus
              >
                <Trash2 className="w-3.5 h-3.5" />
                Revoke
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label="Cancel revoke"
                className="h-9 w-9 p-0 text-zinc-400 hover:text-zinc-200"
                onClick={() => setConfirmingRevoke(null)}
              >
                <X className="w-3.5 h-3.5" />
              </Button>
            </div>
          )}
          {!s.isCurrent && passwordFor === s.sessionId && (
            <form
              // On small screens this takes a full row below the device details;
              // squeezed beside them it crushed the device name.
              className="flex items-center gap-1.5 basis-full sm:basis-auto sm:shrink-0 mt-0.5"
              onSubmit={(e) => { e.preventDefault(); if (password) revoke(s.sessionId, password); }}
            >
              <input
                type="password"
                autoFocus
                autoComplete="current-password"
                aria-label="Confirm your password to revoke this device"
                placeholder="Your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-9 flex-1 min-w-0 sm:flex-none sm:w-40 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <Button
                type="submit"
                size="sm"
                aria-label="Confirm revoke session"
                className="h-9 px-2.5 bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)] gap-1"
                disabled={!password || revoking === s.sessionId}
              >
                {revoking === s.sessionId
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <Trash2 className="w-3.5 h-3.5" />}
                Revoke
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label="Cancel revoke"
                className="h-9 w-9 p-0 text-zinc-400 hover:text-zinc-200"
                onClick={() => { setPasswordFor(null); setPassword(""); setRevokeError(null); }}
              >
                <X className="w-3.5 h-3.5" />
              </Button>
            </form>
          )}
        </div>
      ))}
      {revokeError && <p className="text-xs text-red-400">{revokeError}</p>}
    </div>
  );
}
