"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Loader2, Monitor, Smartphone, Tablet, MapPin, Clock, Check, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { useMinuteTick } from "@/hooks/use-minute-tick";
import { useAsyncAction } from "@/hooks/use-async-action";
import { withBasePath } from "@/lib/base-path";
import { fetchJson, jsonInit } from "@/lib/client/fetch-json";
import { stepUpNeedOf, withStepUpPassword } from "@/lib/client/step-up";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import type { Translator } from "@/lib/i18n/translate";
import { formatRelativeTimeLocalized } from "@/lib/relative-time";
import { isIndefiniteDeadline } from "@/lib/session-lifetime";
import { localizeDeviceLabel } from "@/lib/ua-fingerprint";

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

// The password row a revoke asks for when the server wants a step-up. Owns its
// own field; the parent owns the request. Inline beside the device (a full row
// below it on small screens), with the destructive Revoke as its submit.
function RevokePasswordForm({
  busy,
  error,
  onSubmit,
  onCancel,
  t,
}: {
  busy: boolean;
  error: string | null;
  onSubmit: (password: string) => void;
  onCancel: () => void;
  t: Translator;
}) {
  const [password, setPassword] = useState("");
  return (
    <form
      // On small screens this takes a full row below the device details;
      // squeezed beside them it crushed the device name.
      className="flex flex-wrap items-center gap-1.5 basis-full sm:basis-auto sm:shrink-0 mt-0.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (password && !busy) onSubmit(password);
      }}
    >
      <Input
        type="password"
        autoFocus
        autoComplete="current-password"
        aria-label={t("profile.sessions.passwordLabel")}
        placeholder={t("profile.sessions.passwordPlaceholder")}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        aria-invalid={error ? true : undefined}
        className="h-9 flex-1 min-w-0 sm:flex-none sm:w-40"
      />
      <Button
        type="submit"
        size="sm"
        variant="destructive"
        aria-label={t("profile.sessions.confirmRevoke")}
        className="h-9 px-2.5 gap-1"
        disabled={!password || busy}
      >
        {busy
          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
          : <Trash2 className="w-3.5 h-3.5" />}
        {t("profile.sessions.revokeButton")}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-label={t("profile.sessions.cancelRevoke")}
        className="h-10 w-10 px-0 text-zinc-400 hover:text-zinc-200"
        onClick={onCancel}
      >
        <X className="w-3.5 h-3.5" />
      </Button>
      {/* "Incorrect password" belongs beside the field that produced it,
          not below the whole session list. */}
      {error && <p role="alert" className="basis-full text-xs text-red-400">{error}</p>}
    </form>
  );
}

// Lists the user's active auth sessions with per-device revoke (confirm-then-delete).
export function AuthSessions({ sessions }: AuthSessionsProps) {
  const t = useT();
  const locale = useLocale();
  const router  = useRouter();
  // One run per session, so revoking B while A is in flight leaves A's spinner
  // and disabled button alone (and a second click on one doesn't send twice).
  const action = useAsyncAction();
  const [confirmingRevoke, setConfirmingRevoke] = useState<string | null>(null);
  // Signing out ANOTHER device needs extra proof ("step-up") on the server:
  // password accounts must re-enter their password, and single-sign-on accounts
  // must have signed in recently. So we check the answer and ask for the
  // password when the server says so, instead of assuming the revoke worked.
  const [passwordFor, setPasswordFor] = useState<string | null>(null);
  // Bumped on every password prompt, so the form remounts empty (and
  // focused) after a wrong password instead of keeping it.
  const [prompt, setPrompt] = useState(0);
  // The last revoke's failure and the session it was for.
  const [revokeError, setRevokeError] = useState<{ sessionId: string; text: string } | null>(null);
  // Sessions this page revoked. They stay hidden while router.refresh() is in
  // flight, so a revoked row never comes back with a live button (a second
  // click answered "Not found").
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set());
  // `formatRelativeTime` and `toLocaleDateString` give different text on the
  // server and in the browser (the clock moves on, and the locale can differ),
  // so they only render once mounted. See CLAUDE.md guardrail 16. The tick
  // keeps "active 2 minutes ago" moving on a page left open.
  const mounted = useHasMounted();
  useMinuteTick();

  function deviceTypeLabel(deviceType: string): string {
    if (deviceType === "mobile") return t("profile.sessions.device.mobile");
    if (deviceType === "tablet") return t("profile.sessions.device.tablet");
    if (deviceType === "desktop") return t("profile.sessions.device.desktop");
    return t("profile.sessions.device.other", { type: deviceType });
  }

  // The stored label is English (native clients read it as-is); show it in the
  // viewer's language.
  function deviceName(s: AuthSessionRow): string {
    return localizeDeviceLabel(s.deviceLabel, t) ?? deviceTypeLabel(s.deviceType);
  }

  async function revoke(sessionId: string, confirmPassword?: string) {
    setConfirmingRevoke(null);
    setRevokeError(null);
    const res = await action.run(
      `revoke:${sessionId}`,
      (signal) =>
        fetchJson(withBasePath("/api/sessions"), {
          init: jsonInit("DELETE", withStepUpPassword({ sessionId }, confirmPassword)),
          signal,
          fallbackError: t("profile.sessions.error.revoke"),
        }),
      { ifBusy: "skip" },
    );
    if (!res) return;
    if (res.ok) {
      setPasswordFor((p) => (p === sessionId ? null : p));
      setRemoved((prev) => new Set(prev).add(sessionId));
      router.refresh();
      return;
    }
    const need = stepUpNeedOf(res.status, res.body);
    if (need) {
      // "password": expected on the first attempt for a credentials account —
      // ask, retry. "retry": the password was wrong; keep the prompt, say so.
      setPasswordFor(sessionId);
      setPrompt((n) => n + 1);
      if (need === "retry") setRevokeError({ sessionId, text: t("profile.sessions.error.incorrectPassword") });
      return;
    }
    setPasswordFor((p) => (p === sessionId ? null : p));
    setRevokeError({ sessionId, text: res.error });
  }

  const visible = sessions.filter((s) => !removed.has(s.sessionId));

  if (visible.length === 0) {
    return <p className="text-sm text-zinc-500">{t("profile.sessions.empty")}</p>;
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-zinc-500 mb-3">
        {t("profile.sessions.count", { count: visible.length })}
      </p>

      {visible.map((s) => {
        const revoking = action.busy(`revoke:${s.sessionId}`);
        return (
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
                    {deviceName(s)}
                  </p>
                  {s.isCurrent && (
                    <Badge>
                      <Check />
                      {t("profile.sessions.thisDevice")}
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-3 flex-wrap">
                  {s.ipAddress && (
                    <span className="flex items-center gap-1 text-xs text-zinc-500">
                      <MapPin className="w-3 h-3" />{s.ipAddress}
                    </span>
                  )}
                  <span className="flex items-center gap-1 text-xs text-zinc-500">
                    <Clock className="w-3 h-3" />{t("profile.sessions.active", { time: mounted ? formatRelativeTimeLocalized(s.lastSeenAt, locale) : "" })}
                  </span>
                </div>
                <p className="text-xs text-zinc-500">
                  {/* A native-app (iOS) session carries the never-reached sentinel
                      deadline (session-lifetime.ts) — it ends only when revoked. */}
                  {isIndefiniteDeadline(s.expiresAt)
                    ? t("profile.sessions.neverExpires")
                    : t("profile.sessions.expires", { date: mounted ? new Date(s.expiresAt).toLocaleDateString(locale) : "" })}
                </p>
              </div>
            </div>

            {!s.isCurrent && passwordFor !== s.sessionId && confirmingRevoke !== s.sessionId && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                // A 40x40 tap area, plus an aria-label so screen readers say
                // what this button does (sign that device out).
                aria-label={s.ipAddress
                  ? t("profile.sessions.revokeNamedFrom", { name: deviceName(s), ip: s.ipAddress })
                  : t("profile.sessions.revokeNamed", { name: deviceName(s) })}
                title={t("profile.sessions.revoke")}
                className="shrink-0 text-zinc-400 hover:text-red-400 hover:bg-red-400/10 h-10 w-10 px-0"
                disabled={revoking}
                onClick={() => setConfirmingRevoke(s.sessionId)}
              >
                {revoking
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <Trash2  className="w-3.5 h-3.5" />}
              </Button>
            )}
            {!s.isCurrent && passwordFor !== s.sessionId && confirmingRevoke === s.sessionId && (
              <div className="flex items-center gap-1.5 shrink-0 mt-0.5">
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  aria-label={t("profile.sessions.confirmRevoke")}
                  className="h-9 px-2.5 gap-1"
                  onClick={() => revoke(s.sessionId)}
                  autoFocus
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  {t("profile.sessions.revokeButton")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={t("profile.sessions.cancelRevoke")}
                  className="h-10 w-10 px-0 text-zinc-400 hover:text-zinc-200"
                  onClick={() => setConfirmingRevoke(null)}
                >
                  <X className="w-3.5 h-3.5" />
                </Button>
              </div>
            )}
            {!s.isCurrent && passwordFor === s.sessionId && (
              <RevokePasswordForm
                key={prompt}
                busy={revoking}
                error={revokeError?.sessionId === s.sessionId ? revokeError.text : null}
                onSubmit={(password) => revoke(s.sessionId, password)}
                onCancel={() => { setPasswordFor(null); setRevokeError(null); }}
                t={t}
              />
            )}
          </div>
        );
      })}
      {revokeError && passwordFor !== revokeError.sessionId && (
        <p role="alert" className="text-xs text-red-400">{revokeError.text}</p>
      )}
    </div>
  );
}
