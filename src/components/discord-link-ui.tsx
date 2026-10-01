"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle, Loader2, ExternalLink, Copy, Check } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { safeExternalHref } from "@/lib/safe-url";
import { useLocale, useT } from "@/components/i18n/i18n-provider";

// Renders a translated template whose {name} placeholders are React nodes
// (inline <code>/<strong>), so word order stays with the translation.
function rich(template: string, nodes: Record<string, React.ReactNode>): React.ReactNode[] {
  return template.split(/(\{\w+\})/).map((part, i) => {
    const m = /^\{(\w+)\}$/.exec(part);
    return m && m[1] in nodes ? <span key={i}>{nodes[m[1]]}</span> : part;
  });
}

function TokenLinkFlow() {
  const t = useT();
  const locale = useLocale();
  const [token, setToken] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function copyToken() {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable (insecure context) or blocked — the token is
         rendered beside this button for manual selection */
    }
  }

  async function generateToken() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(withBasePath("/api/discord/generate-link"), { method: "POST" });
      // A proxy 502/504 answers with an HTML page (or nothing), and a bare
      // res.json() would surface the raw SyntaxError text to the user.
      const data = (await res.json().catch(() => ({}))) as { token?: string; expiresAt?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? t("profile.discord.error.generate"));
      if (!data.token || !data.expiresAt) throw new Error(t("profile.discord.error.malformed"));
      setToken(data.token);
      setExpiresAt(new Date(data.expiresAt));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("profile.error.generic"));
    } finally {
      setLoading(false);
    }
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

      <button
        onClick={generateToken}
        disabled={loading}
        className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-[var(--ds-accent-fg)] rounded-md transition-colors"
      >
        {loading ? t("profile.discord.generating") : t("profile.discord.generate")}
      </button>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {token && expiresAt && (
        <div className="rounded-md bg-zinc-800 border border-zinc-700 p-4 space-y-3">
          <p className="text-xs text-zinc-500 uppercase tracking-wide font-semibold">{t("profile.discord.yourToken")}</p>
          <div className="flex items-center gap-2">
            <p className="font-mono text-sm font-bold text-zinc-100 break-all flex-1">{token}</p>
            <button
              type="button"
              onClick={copyToken}
              className="shrink-0 p-1.5 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700 transition-colors"
              title={t("profile.discord.copyToken")}
              aria-label={t("profile.discord.copyToken")}
            >
              {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
            </button>
          </div>
          <p className="text-xs text-zinc-500">
            {rich(t("profile.discord.expiresRun", { time: expiresAt.toLocaleTimeString(locale) }), {
              command: <code className="bg-zinc-700 px-1 rounded">/link token:{token}</code>,
            })}
          </p>
        </div>
      )}
    </div>
  );
}

type MergeStep = "idle" | "code-sent" | "done";

function WebMergeFlow() {
  const t = useT();
  const router = useRouter();
  const [step, setStep] = useState<MergeStep>("idle");
  const [discordId, setDiscordId] = useState("");
  const [code, setCode] = useState("");
  const [migrated, setMigrated] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendCode() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(withBasePath("/api/discord/initiate-merge"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ discordId: discordId.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      if (!res.ok) throw new Error(data.message ?? data.error ?? t("profile.discord.error.sendCode"));
      setStep("code-sent");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("profile.error.generic"));
    } finally {
      setLoading(false);
    }
  }

  async function confirmCode() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(withBasePath("/api/discord/confirm-merge"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      });
      // `message` first: several routes answer { error: "<slug>", message: "<sentence>" },
      // and rendering `error` alone showed the raw machine code — e.g. literally
      // "rate_limit" instead of "Too many attempts. Wait 10 minutes and try again."
      const data = (await res.json().catch(() => ({}))) as { migrated?: number; error?: string; message?: string };
      if (!res.ok) throw new Error(data.message ?? data.error ?? t("profile.discord.error.verify"));
      setMigrated(data.migrated ?? 0);
      setStep("done");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("profile.error.generic"));
    } finally {
      setLoading(false);
    }
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
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={discordId}
              onChange={(e) => { setDiscordId(e.target.value.replace(/\D/g, "")); setError(null); }}
              placeholder="123456789012345678"
              aria-label={t("profile.discord.userIdLabel")}
              className="flex-1 min-w-0 rounded-md bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm font-mono text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
            <button
              onClick={sendCode}
              disabled={loading || !/^\d{17,20}$/.test(discordId.trim())}
              className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-[var(--ds-accent-fg)] rounded-md transition-colors whitespace-nowrap flex items-center gap-2"
            >
              {loading && <Loader2 className="w-3 h-3 animate-spin" />}
              {t("profile.discord.sendCode")}
            </button>
          </div>
        </>
      )}

      {step === "code-sent" && (
        <>
          <div className="rounded-md bg-zinc-800 border border-zinc-700 px-4 py-3 text-sm text-zinc-300 space-y-1">
            <p>{t("profile.discord.codeSent")}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              type="text"
              value={code}
              onChange={(e) => { setCode(e.target.value.replace(/[^a-fA-F0-9]/g, "").toUpperCase().slice(0, 12)); setError(null); }}
              placeholder="A1B2C3D4E5F6"
              aria-label={t("profile.discord.codeLabel")}
              maxLength={12}
              className="w-48 rounded-md bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm font-mono text-zinc-100 placeholder-zinc-600 text-center tracking-widest focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
            <button
              onClick={confirmCode}
              disabled={loading || code.length !== 12}
              className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-[var(--ds-accent-fg)] rounded-md transition-colors flex items-center gap-2"
            >
              {loading && <Loader2 className="w-3 h-3 animate-spin" />}
              {t("profile.discord.verifyLink")}
            </button>
            <button
              onClick={() => { setStep("idle"); setCode(""); setError(null); }}
              disabled={loading}
              className="px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100 transition-colors"
            >
              {t("profile.common.back")}
            </button>
          </div>
          <p className="text-xs text-zinc-500">{t("profile.discord.codeExpires")}</p>
        </>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}

export function DiscordLinkSection({ linkedDiscordId, discordInviteUrl }: { linkedDiscordId: string | null; discordInviteUrl?: string | null }) {
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
      <TokenLinkFlow />
      <div className="border-t border-zinc-800 pt-4">
        <WebMergeFlow />
      </div>
    </div>
  );
}
