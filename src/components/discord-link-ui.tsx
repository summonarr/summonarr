"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle, Loader2, ExternalLink, Copy, Check } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { fetchJson, jsonInit } from "@/lib/client/fetch-json";
import { v } from "@/lib/validate";
import { safeExternalHref } from "@/lib/safe-url";
import { useAsyncAction } from "@/hooks/use-async-action";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { rich } from "@/components/settings/forms/rich";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StepUpPasswordForm } from "@/components/profile/step-up-password-form";
import { useStepUpPost } from "@/components/use-step-up-post";
import { SecondFactorCodeField } from "@/components/profile/second-factor-code-field";
import type { KnownSecondFactor } from "@/components/profile/use-second-factor-step-up";

// POST /api/discord/generate-link: a 12-character code that lives 10 minutes.
const LinkToken = v.object({ token: v.string(), expiresAt: v.string() });
// POST /api/discord/confirm-merge: how many requests moved to this account.
const MergeDone = v.object({ migrated: v.optional(v.number()) });

function TokenLinkFlow({ secondFactor }: { secondFactor?: KnownSecondFactor }) {
  const t = useT();
  const locale = useLocale();
  const [token, setToken] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);
  // The server's link code lives 10 minutes; past its expiresAt it is dead, so
  // it stops being offered for copying.
  const [expired, setExpired] = useState(false);
  // Minting a link code needs a step-up (guardrail 6g): the server answers
  // "password-required" and this flow asks for the password inline — and, on
  // an account with two-factor, for a fresh code or passkey with it.
  const generate = useStepUpPost("/api/discord/generate-link", LinkToken, {
    failed: t("profile.discord.error.generate"),
    malformed: t("profile.discord.error.malformed"),
  }, secondFactor);
  const { copied, copy } = useCopyFeedback();
  // The clipboard refused (an insecure origin, a denied permission): the code
  // is selected for copying by hand, and the line below says so.
  const [copyFailed, setCopyFailed] = useState(false);
  const tokenRef = useRef<HTMLParagraphElement>(null);

  // Date.now() is read in the effect, never in render (guardrail 16).
  useEffect(() => {
    if (!expiresAt) return;
    const id = setTimeout(() => setExpired(true), Math.max(0, expiresAt.getTime() - Date.now()));
    return () => clearTimeout(id);
  }, [expiresAt]);

  async function copyToken() {
    if (!token || expired) return;
    const ok = await copy(token);
    setCopyFailed(!ok);
    if (!ok && tokenRef.current) window.getSelection()?.selectAllChildren(tokenRef.current);
  }

  async function generateToken(confirmPassword?: string) {
    const data = await generate.run({}, confirmPassword);
    if (!data) return;
    setToken(data.token);
    setExpiresAt(new Date(data.expiresAt));
    setExpired(false);
    setCopyFailed(false);
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-zinc-500 font-medium">{t("profile.discord.optionA")}</p>
      <ol className="text-sm text-zinc-400 space-y-1 list-decimal list-inside">
        <li>{rich(t("profile.discord.stepGenerate"), { button: <strong className="text-zinc-100">{t("profile.discord.generate")}</strong> })}</li>
        <li>{t("profile.discord.stepCopy")}</li>
        <li>
          {rich(t("profile.discord.stepRun"), { command: <code className="bg-zinc-800 px-1 rounded text-xs">{t("profile.discord.commandTemplate")}</code> })}
        </li>
      </ol>

      {generate.stepUp ? (
        <StepUpPasswordForm
          busy={generate.loading}
          error={generate.stepUpError}
          onSubmit={(password) => void generateToken(password)}
          onCancel={generate.cancelStepUp}
        >
          {generate.secondFactor.show && (
            <SecondFactorCodeField
              id="discord-link-stepup-code"
              value={generate.secondFactor.code}
              onChange={generate.secondFactor.setCode}
              passkeyPossible={generate.secondFactor.passkeyPossible}
            />
          )}
        </StepUpPasswordForm>
      ) : (
        <Button type="button" onClick={() => void generateToken()} disabled={generate.loading}>
          {generate.loading && <Loader2 className="w-4 h-4 animate-spin" />}
          {generate.loading ? t("profile.discord.generating") : t("profile.discord.generate")}
        </Button>
      )}

      {generate.error && <p role="alert" className="text-sm text-red-400">{generate.error}</p>}

      {token && expiresAt && (
        <div className="rounded-md bg-zinc-800 border border-zinc-700 p-4 space-y-3">
          <p className="text-xs text-zinc-500 uppercase tracking-wide font-semibold">{t("profile.discord.yourToken")}</p>
          <div className="flex items-center gap-2">
            <p ref={tokenRef} className={`ds-mono text-sm font-bold break-all flex-1 ${expired ? "text-zinc-500 line-through" : "text-zinc-100"}`}>
              {token}
            </p>
            {!expired && (
              <Button
                type="button"
                variant="ghost"
                onClick={copyToken}
                className="h-10 w-10 shrink-0 px-0 text-zinc-400 hover:text-zinc-100"
                title={t("profile.discord.copyToken")}
                aria-label={t("profile.discord.copyToken")}
              >
                {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
              </Button>
            )}
          </div>
          {!expired && copyFailed && (
            <p role="status" className="text-xs text-amber-400">{t("profile.discord.copyFailed")}</p>
          )}
          {expired ? (
            <p role="status" className="text-xs text-amber-400">
              {t("profile.discord.expired", { time: expiresAt.toLocaleTimeString(locale) })}
            </p>
          ) : (
            <p className="text-xs text-zinc-500">
              {rich(t("profile.discord.expiresRun", { time: expiresAt.toLocaleTimeString(locale) }), {
                command: <code className="ds-mono bg-zinc-700 px-1 rounded">/link token:{token}</code>,
              })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

type MergeStep = "idle" | "code-sent" | "done";

function WebMergeFlow({ secondFactor }: { secondFactor?: KnownSecondFactor }) {
  const t = useT();
  const router = useRouter();
  const [step, setStep] = useState<MergeStep>("idle");
  const [discordId, setDiscordId] = useState("");
  const [code, setCode] = useState("");
  const [migrated, setMigrated] = useState(0);
  // Sending a merge code from the web needs a step-up (guardrail 6g), with a
  // fresh second factor on an account that has one.
  const send = useStepUpPost("/api/discord/initiate-merge", v.unknown(), { failed: t("profile.discord.error.sendCode") }, secondFactor);
  const confirm = useAsyncAction();
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const loading = send.loading || confirm.busy("confirm");
  const error = send.error ?? confirmError;
  const clearErrors = () => {
    send.clearError();
    setConfirmError(null);
  };

  async function sendCode(confirmPassword?: string) {
    setConfirmError(null);
    if ((await send.run({ discordId: discordId.trim() }, confirmPassword)) === null) return;
    setStep("code-sent");
  }

  async function confirmCode() {
    clearErrors();
    const res = await confirm.run(
      "confirm",
      (signal) => fetchJson(withBasePath("/api/discord/confirm-merge"), {
        init: jsonInit("POST", { code: code.trim() }),
        schema: MergeDone,
        signal,
        // `message` first (apiErrorText): several routes answer { error:
        // "<slug>", message: "<sentence>" }, and `error` alone showed the raw
        // machine code — e.g. literally "rate_limit".
        fallbackError: t("profile.discord.error.verify"),
      }),
      { ifBusy: "skip" },
    );
    if (!res) return;
    if (!res.ok) {
      // The route's own reason; no answer (or a proxy page) has none.
      if (res.kind !== "aborted") setConfirmError(res.kind === "http" ? res.error : t("profile.error.generic"));
      return;
    }
    setMigrated(res.data.migrated ?? 0);
    setStep("done");
    router.refresh();
  }

  if (step === "done") {
    return (
      <div className="flex items-center gap-2 text-sm text-green-400">
        <CheckCircle className="w-4 h-4 shrink-0" />
        <span>
          {t("profile.discord.linkedSuccess")}
          {migrated > 0 && ` ${t("profile.discord.migrated", { count: migrated })}`}
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-zinc-500 font-medium">{t("profile.discord.optionB")}</p>

      {step === "idle" && (
        <>
          <p className="text-sm text-zinc-400">
            {t("profile.discord.enterId")}
            <span className="block text-zinc-500 text-xs mt-0.5">
              {rich(t("profile.discord.findId"), { copyId: <strong className="text-zinc-400">{t("profile.discord.copyUserId")}</strong> })}
            </span>
          </p>
          <div className="flex gap-2">
            <Input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={discordId}
              onChange={(e) => { setDiscordId(e.target.value.replace(/\D/g, "")); clearErrors(); }}
              placeholder="123456789012345678"
              aria-label={t("profile.discord.userIdLabel")}
              className="ds-mono flex-1"
            />
            <Button
              type="button"
              onClick={() => void sendCode()}
              disabled={loading || send.stepUp || !/^\d{17,20}$/.test(discordId.trim())}
              className="shrink-0"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              {t("profile.discord.sendCode")}
            </Button>
          </div>
          {send.stepUp && (
            <StepUpPasswordForm
              busy={loading}
              error={send.stepUpError}
              onSubmit={(password) => void sendCode(password)}
              onCancel={send.cancelStepUp}
            >
              {send.secondFactor.show && (
                <SecondFactorCodeField
                  id="discord-merge-stepup-code"
                  value={send.secondFactor.code}
                  onChange={send.secondFactor.setCode}
                  passkeyPossible={send.secondFactor.passkeyPossible}
                />
              )}
            </StepUpPasswordForm>
          )}
        </>
      )}

      {step === "code-sent" && (
        <>
          <div className="rounded-md bg-zinc-800 border border-zinc-700 px-4 py-3 text-sm text-zinc-300 space-y-1">
            <p>{t("profile.discord.codeSent")}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Input
              type="text"
              value={code}
              onChange={(e) => { setCode(e.target.value.replace(/[^a-fA-F0-9]/g, "").toUpperCase().slice(0, 12)); clearErrors(); }}
              placeholder="A1B2C3D4E5F6"
              aria-label={t("profile.discord.codeLabel")}
              maxLength={12}
              autoComplete="one-time-code"
              className="ds-mono w-48 text-center tracking-widest"
            />
            <Button type="button" onClick={() => void confirmCode()} disabled={loading || code.length !== 12}>
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              {t("profile.discord.verifyLink")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => { setStep("idle"); setCode(""); clearErrors(); }}
              disabled={loading}
              className="text-zinc-400 hover:text-zinc-100"
            >
              {t("profile.common.back")}
            </Button>
          </div>
          <p className="text-xs text-zinc-500">{t("profile.discord.codeExpires")}</p>
        </>
      )}

      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
    </div>
  );
}

export function DiscordLinkSection({ linkedDiscordId, discordInviteUrl, secondFactor }: {
  linkedDiscordId: string | null;
  discordInviteUrl?: string | null;
  // What the page knew about the account's two-factor setup when it rendered.
  secondFactor?: KnownSecondFactor;
}) {
  const t = useT();
  if (linkedDiscordId) {
    return (
      <div className="text-sm text-zinc-400">
        <span className="text-green-400 font-medium">{t("profile.discord.linked")}</span>
        <span className="text-zinc-500"> · {t("profile.discord.idLabel", { id: linkedDiscordId })}</span>
      </div>
    );
  }

  const inviteHref = safeExternalHref(discordInviteUrl);

  return (
    <div className="space-y-6">
      {inviteHref && (
        <div
          className="rounded-md px-4 py-3 space-y-2"
          style={{
            background: "var(--ds-accent-soft)",
            border: "1px solid var(--ds-accent-ring)",
            color: "var(--ds-fg)",
          }}
        >
          <p className="text-sm font-medium">{t("profile.discord.joinTitle")}</p>
          <p className="text-sm" style={{ color: "var(--ds-fg-muted)" }}>
            {t("profile.discord.joinBody")}
          </p>
          <a
            href={inviteHref}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm font-medium hover:underline"
            style={{ color: "var(--ds-accent-text)" }}
          >
            {t("profile.discord.join")} <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>
      )}
      {!inviteHref && <p className="text-sm text-zinc-400">{t("profile.discord.notLinked")}</p>}
      <TokenLinkFlow secondFactor={secondFactor} />
      <div className="border-t border-zinc-800 pt-4">
        <WebMergeFlow secondFactor={secondFactor} />
      </div>
    </div>
  );
}
