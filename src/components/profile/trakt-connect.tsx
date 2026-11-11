"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink, LinkIcon, Loader2, Unlink } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import { withBasePath } from "@/lib/base-path";
import { fetchJson, jsonInit } from "@/lib/client/fetch-json";
import { formatRelativeTimeLocalized } from "@/lib/relative-time";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { StepUpPasswordForm } from "@/components/profile/step-up-password-form";
import { asksSecondFactor, stepUpNeedOf, withSecondFactor, withStepUpPassword, type SecondFactorProof } from "@/lib/client/step-up";
import { useSecondFactorStepUp, type KnownSecondFactor } from "./use-second-factor-step-up";
import { SecondFactorCodeField } from "./second-factor-code-field";
import { readDeviceCode, type DeviceCode } from "./trakt-device-poll";
import { useTraktDevicePoll, type PollEnd } from "./use-trakt-device-poll";

// The user's own Trakt connection (src/lib/trakt-user.ts, guardrail 34c).
// Connecting is a device-code flow: the server hands back a short code, the
// user enters it at trakt.tv/activate, and this component polls until Trakt
// answers (use-trakt-device-poll.ts). Each use is the user's own switch:
// watchlist auto-request (shown only while that feature is on and they may
// auto-request) and the For You history (shown only while For You is on).

export interface TraktConnectProps {
  connected: boolean;
  username: string | null;
  watchlistAutoRequest: boolean;
  historySeeds: boolean;
  status: "ok" | "error" | "reauth" | null;
  syncedAt: string | null;
  uses: { watchlist: boolean; history: boolean };
  // A Jellyfin user gets a line on why Trakt is their watchlist.
  isJellyfin: boolean;
  // What the page knew about the account's two-factor setup when it rendered.
  secondFactor?: KnownSecondFactor;
}

// fetchJson exposes no headers, and a second-factor refusal needs none.
const NO_HEADERS = { get: () => null };

type TraktStatus = TraktConnectProps["status"];

// The switch and status fields of the GET-shaped state /api/profile/trakt
// answers (getTraktProfileState). A field that isn't there is left as it is.
function readTraktState(data: unknown): {
  watchlistAutoRequest?: boolean;
  historySeeds?: boolean;
  status?: TraktStatus;
  syncedAt?: string | null;
} {
  if (!data || typeof data !== "object") return {};
  const d = data as Record<string, unknown>;
  const status = d.status;
  return {
    ...(typeof d.watchlistAutoRequest === "boolean" ? { watchlistAutoRequest: d.watchlistAutoRequest } : {}),
    ...(typeof d.historySeeds === "boolean" ? { historySeeds: d.historySeeds } : {}),
    ...(status === "ok" || status === "error" || status === "reauth" || status === null ? { status } : {}),
    ...(typeof d.syncedAt === "string" || d.syncedAt === null ? { syncedAt: d.syncedAt as string | null } : {}),
  };
}

export function TraktConnect(props: TraktConnectProps) {
  const t = useT();
  const locale = useLocale();
  const mounted = useHasMounted();
  const [connected, setConnected] = useState(props.connected);
  const [username, setUsername] = useState(props.username);
  const [status, setStatus] = useState(props.status);
  const [syncedAt, setSyncedAt] = useState(props.syncedAt);
  const [watchlist, setWatchlist] = useState(props.watchlistAutoRequest);
  const [history, setHistory] = useState(props.historySeeds);
  const [device, setDevice] = useState<DeviceCode | null>(null);
  const [busy, setBusy] = useState<"start" | "disconnect" | "toggle" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Connecting Trakt needs a step-up (guardrail 6g): the server answers
  // "password-required" and this asks for the password inline.
  const [stepUp, setStepUp] = useState(false);
  const [stepUpError, setStepUpError] = useState<string | null>(null);
  // An account with two-factor confirms with a fresh one too: the code field
  // shows inside the password prompt (from the start when the page knew, else
  // once the server answers `secondFactorRequired`).
  const factor = useSecondFactorStepUp({ known: props.secondFactor, failedMessage: t("profile.trakt.error.connect") });
  const poller = useTraktDevicePoll(endPoll);

  // A poll run's outcome: the code is done with either way.
  function endPoll(step: PollEnd) {
    setDevice(null);
    switch (step.kind) {
      case "connected":
        setConnected(true);
        setUsername(step.username);
        setStatus(null);
        setSyncedAt(null);
        void reloadState();
        return;
      case "denied":
        setError(t("profile.trakt.error.denied"));
        return;
      case "conflict":
        setError(t("profile.trakt.error.conflict"));
        return;
      case "failed":
        setError(step.error || t("profile.trakt.error.connect"));
        return;
      case "expired":
        setError(t("profile.trakt.error.expired"));
    }
  }

  // Apply the server's state for the switches and the sync line.
  function applyState(data: unknown) {
    const next = readTraktState(data);
    if (next.watchlistAutoRequest !== undefined) setWatchlist(next.watchlistAutoRequest);
    if (next.historySeeds !== undefined) setHistory(next.historySeeds);
    if (next.status !== undefined) setStatus(next.status);
    if (next.syncedAt !== undefined) setSyncedAt(next.syncedAt);
  }

  // A new connection starts from the server's switches, not the ones shown: a
  // disconnect deletes the connection row, so a reconnect gets the defaults
  // (both on) whatever the page still showed from before. A failure keeps what
  // is shown; the next page load reads it again.
  async function reloadState() {
    const res = await fetchJson(withBasePath("/api/profile/trakt"));
    if (res.ok && poller.alive()) applyState(res.data);
  }

  async function start(confirmPassword?: string) {
    setBusy("start");
    setError(null);
    // The proof rides with the password only, never the first password-less click.
    let proof: SecondFactorProof | undefined;
    if (confirmPassword && factor.needsSecondFactor) {
      const r = await factor.secondFactorProof();
      if (!poller.alive()) return;
      if (!("proof" in r)) {
        // No code and no passkey to use, or the passkey prompt failed or was
        // cancelled (null): nothing is sent.
        setBusy(null);
        setStepUpError(r.error);
        return;
      }
      proof = r.proof;
    }
    const res = await fetchJson(withBasePath("/api/profile/trakt/device"), {
      init: jsonInit("POST", withSecondFactor(withStepUpPassword({}, confirmPassword), proof)),
      fallbackError: t("profile.trakt.error.connect"),
    });
    // The page went while the code was being made: start no poll for it.
    if (!poller.alive()) return;
    setBusy(null);
    if (!res.ok && res.status === 0) {
      setError(t("profile.error.network"));
      return;
    }
    const data = res.ok ? res.data : res.body;
    const need = stepUpNeedOf(res.status, data);
    if (need) {
      setStepUp(true);
      setStepUpError(need === "retry" ? t("profile.sessions.error.incorrectPassword") : null);
      return;
    }
    // The password passed and the account has two-factor: keep the prompt open,
    // now with the code field, and say what to enter (or that the code was refused).
    if (!res.ok && asksSecondFactor(res.status, data)) {
      setStepUp(true);
      setStepUpError(factor.refusalMessage({ status: res.status, headers: NO_HEADERS }, data, proof !== undefined, t("profile.trakt.error.connect")));
      return;
    }
    const code = res.ok ? readDeviceCode(data) : null;
    if (!code) {
      setError(res.ok ? t("profile.trakt.error.connect") : res.error);
      return;
    }
    setStepUp(false);
    setStepUpError(null);
    setDevice(code);
    poller.begin(code.interval, code.expiresIn);
  }

  function cancel() {
    poller.stop();
    setDevice(null);
  }

  async function disconnect() {
    setBusy("disconnect");
    setConfirming(false);
    setError(null);
    const res = await fetchJson(withBasePath("/api/profile/trakt"), {
      init: { method: "DELETE" },
      fallbackError: t("profile.trakt.error.disconnect"),
    });
    if (!poller.alive()) return;
    setBusy(null);
    if (!res.ok) {
      setError(res.status === 0 ? t("profile.error.network") : res.error);
      return;
    }
    setConnected(false);
    setUsername(null);
    setStatus(null);
    setSyncedAt(null);
  }

  // Saves on flip and rolls back if the save fails.
  async function toggle(field: "watchlistAutoRequest" | "historySeeds", next: boolean) {
    if (busy) return;
    const set = field === "watchlistAutoRequest" ? setWatchlist : setHistory;
    set(next);
    setBusy("toggle");
    setError(null);
    const res = await fetchJson(withBasePath("/api/profile/trakt"), {
      init: jsonInit("PATCH", { [field]: next }),
      fallbackError: t("profile.error.saveFailed"),
    });
    if (!poller.alive()) return;
    setBusy(null);
    if (!res.ok) {
      set(!next);
      setError(res.status === 0 ? t("profile.error.network") : res.error);
      return;
    }
    // The saved state, both switches, as the server now has it.
    const data = res.data;
    applyState(data);
  }

  let statusLine: string | null = null;
  if (connected) {
    if (status === "error") statusLine = t("profile.trakt.status.error");
    else if (status === "ok" && syncedAt && mounted) statusLine = t("profile.trakt.status.synced", { when: formatRelativeTimeLocalized(syncedAt, locale) });
    else if (status === null) statusLine = t("profile.trakt.status.pending");
  }

  return (
    <div className="space-y-3">
      {!connected && status === "reauth" && !device && (
        <p role="alert" className="text-sm text-amber-400">{t("profile.trakt.reauth")}</p>
      )}

      {connected ? (
        <>
          <p className="text-sm text-zinc-300">
            {username ? t("profile.trakt.connectedAs", { username }) : t("profile.trakt.connected")}
          </p>
          {statusLine && <p className="text-xs text-zinc-500">{statusLine}</p>}
          {props.uses.watchlist && (
            <TraktSwitchRow
              label={t("profile.trakt.watchlistLabel")}
              hint={t("profile.trakt.watchlistHint")}
              checked={watchlist}
              busy={busy !== null}
              onFlip={(v) => void toggle("watchlistAutoRequest", v)}
            />
          )}
          {props.uses.history && (
            <TraktSwitchRow
              label={t("profile.trakt.historyLabel")}
              hint={t("profile.trakt.historyHint")}
              checked={history}
              busy={busy !== null}
              onFlip={(v) => void toggle("historySeeds", v)}
            />
          )}
          {confirming ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm text-zinc-300 w-full">{t("profile.trakt.confirmDisconnect")}</p>
              <Button type="button" variant="destructive" onClick={disconnect} className="w-full sm:w-auto" autoFocus>
                {t("profile.trakt.disconnect")}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setConfirming(false)} className="w-full sm:w-auto">
                {t("profile.common.cancel")}
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => setConfirming(true)}
              className="w-full sm:w-auto gap-1.5"
            >
              {busy === "disconnect" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Unlink className="w-4 h-4" />}
              {t("profile.trakt.disconnect")}
            </Button>
          )}
        </>
      ) : device ? (
        <DeviceCodePanel device={device} onCancel={cancel} />
      ) : (
        <>
          <p className="text-sm text-zinc-400">
            {props.uses.watchlist && props.uses.history
              ? t("profile.trakt.introBoth")
              : props.uses.watchlist
                ? t("profile.trakt.introWatchlist")
                : t("profile.trakt.introHistory")}
          </p>
          {props.isJellyfin && props.uses.watchlist && (
            <p className="text-xs text-zinc-500">{t("profile.trakt.jellyfinHint")}</p>
          )}
          {stepUp ? (
            <StepUpPasswordForm
              busy={busy === "start"}
              error={stepUpError}
              onSubmit={(password) => void start(password)}
              onCancel={() => { setStepUp(false); setStepUpError(null); }}
            >
              {factor.needsSecondFactor && (
                <SecondFactorCodeField
                  id="trakt-stepup-code"
                  value={factor.stepUpCode}
                  onChange={factor.setStepUpCode}
                  passkeyPossible={factor.passkeyPossible}
                />
              )}
            </StepUpPasswordForm>
          ) : (
            <Button type="button" disabled={busy !== null} onClick={() => void start()} className="w-full sm:w-auto gap-1.5">
              {busy === "start" ? <Loader2 className="w-4 h-4 animate-spin" /> : <LinkIcon className="w-4 h-4" />}
              {t("profile.trakt.connect")}
            </Button>
          )}
        </>
      )}

      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

function TraktSwitchRow({ label, hint, checked, busy, onFlip }: {
  label: string;
  hint: string;
  checked: boolean;
  busy: boolean;
  onFlip: (next: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div>
        <p className="text-sm font-medium text-zinc-200">{label}</p>
        <p className="text-xs text-zinc-500 mt-0.5">{hint}</p>
      </div>
      {/* aria-disabled, not disabled: a natively disabled switch drops the
          focus of the keyboard user who just flipped it. toggle() ignores a
          flip while busy. */}
      <Switch
        checked={checked}
        aria-disabled={busy || undefined}
        className="aria-disabled:opacity-50"
        onCheckedChange={onFlip}
        aria-label={label}
      />
    </div>
  );
}

// The pending code, the link to enter it at, and the waiting line.
function DeviceCodePanel({ device, onCancel }: { device: DeviceCode; onCancel: () => void }) {
  const t = useT();
  // One tracked timer: a second click restarts the tick, nothing fires after unmount.
  const { copied, failed, copy } = useCopyFeedback();
  async function copyCode() {
    await copy(device.userCode);
  }
  return (
    <div className="space-y-3 rounded-md border border-[var(--ds-border)] bg-[var(--ds-bg-1)] p-3">
      <p className="text-sm text-zinc-300">{t("profile.trakt.enterCode")}</p>
      <div className="flex flex-wrap items-center gap-2">
        <span className="ds-mono text-2xl font-semibold tracking-widest text-zinc-100" aria-label={t("profile.trakt.codeLabel")}>
          {device.userCode}
        </span>
        <Button type="button" variant="ghost" onClick={copyCode} aria-label={t("profile.trakt.copyCode")} title={t("profile.trakt.copyCode")}>
          {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
        </Button>
      </div>
      {/* No clipboard path worked (an insecure page, a denied permission). */}
      {failed && <p role="alert" className="text-xs text-amber-400">{t("profile.common.copyFailed")}</p>}
      <div className="flex flex-wrap gap-2">
        <a
          href={device.verificationUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[var(--ds-border)] px-3 text-sm text-zinc-100 ds-hover-tint"
        >
          <ExternalLink className="w-4 h-4" />
          {t("profile.trakt.openActivate")}
        </a>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t("profile.common.cancel")}
        </Button>
      </div>
      <p className="flex items-center gap-1.5 text-xs text-zinc-500" role="status" aria-live="polite">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        {t("profile.trakt.waiting")}
      </p>
    </div>
  );
}
