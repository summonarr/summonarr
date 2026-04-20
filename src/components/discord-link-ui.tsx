"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle, Loader2, ExternalLink, Copy, Check } from "lucide-react";

function TokenLinkFlow() {
  const [token, setToken] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function copyToken() {
    if (!token) return;
    navigator.clipboard.writeText(token);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function generateToken() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/discord/generate-link", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to generate token");
      setToken(data.token);
      setExpiresAt(new Date(data.expiresAt));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-zinc-500 font-medium">Option A — Link from Discord</p>
      <ol className="text-sm text-zinc-400 space-y-1 list-decimal list-inside">
        <li>Click <strong className="text-white">Generate Token</strong> below</li>
        <li>Copy the token</li>
        <li>
          In Discord, run{" "}
          <code className="bg-zinc-800 px-1 rounded text-xs">/link token:&lt;your-code&gt;</code>
        </li>
      </ol>

      <button
        onClick={generateToken}
        disabled={loading}
        className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-md transition-colors"
      >
        {loading ? "Generating…" : "Generate Token"}
      </button>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {token && expiresAt && (
        <div className="rounded-md bg-zinc-800 border border-zinc-700 p-4 space-y-3">
          <p className="text-xs text-zinc-500 uppercase tracking-wide font-semibold">Your link token</p>
          <div className="flex items-center gap-2">
            <p className="font-mono text-sm font-bold text-white break-all flex-1">{token}</p>
            <button
              onClick={copyToken}
              className="shrink-0 p-1.5 rounded text-zinc-400 hover:text-white hover:bg-zinc-700 transition-colors"
              title="Copy token"
            >
              {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
            </button>
          </div>
          <p className="text-xs text-zinc-500">
            Expires at {expiresAt.toLocaleTimeString()} · Run{" "}
            <code className="bg-zinc-700 px-1 rounded">/link token:{token}</code> in Discord
          </p>
        </div>
      )}
    </div>
  );
}

type MergeStep = "idle" | "code-sent" | "done";

function WebMergeFlow() {
  const router = useRouter();
  const [step, setStep] = useState<MergeStep>("idle");
  const [discordId, setDiscordId] = useState("");
  const [code, setCode] = useState("");
  const [pendingCount, setPendingCount] = useState(0);
  const [migrated, setMigrated] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendCode() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/discord/initiate-merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ discordId: discordId.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to send code");
      setPendingCount(data.pendingCount ?? 0);
      setStep("code-sent");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function confirmCode() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/discord/confirm-merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Verification failed");
      setMigrated(data.migrated ?? 0);
      setStep("done");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  if (step === "done") {
    return (
      <div className="flex items-center gap-2 text-sm text-green-400">
        <CheckCircle className="w-4 h-4 shrink-0" />
        <span>
          Discord account linked!
          {migrated > 0 && ` ${migrated} request${migrated !== 1 ? "s" : ""} transferred to your account.`}
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-zinc-500 font-medium">Option B — Verify from this page</p>

      {step === "idle" && (
        <>
          <p className="text-sm text-zinc-400">
            Enter your Discord User ID and we&apos;ll send a verification code to your DMs.
            <span className="block text-zinc-500 text-xs mt-0.5">
              Find your ID in Discord: enable Developer Mode (Settings → Advanced), then right-click
              your username and select <strong className="text-zinc-400">Copy User ID</strong>.
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
              className="flex-1 min-w-0 rounded-md bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm font-mono text-white placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
            <button
              onClick={sendCode}
              disabled={loading || !/^\d{17,20}$/.test(discordId.trim())}
              className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-md transition-colors whitespace-nowrap flex items-center gap-2"
            >
              {loading && <Loader2 className="w-3 h-3 animate-spin" />}
              Send Code
            </button>
          </div>
        </>
      )}

      {step === "code-sent" && (
        <>
          <div className="rounded-md bg-zinc-800 border border-zinc-700 px-4 py-3 text-sm text-zinc-300 space-y-1">
            <p>A 6-digit code was sent to your Discord DMs.</p>
            {pendingCount > 0 && (
              <p className="text-indigo-400">
                {pendingCount} existing Discord request{pendingCount !== 1 ? "s" : ""} will be merged into your account.
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={code}
              onChange={(e) => { setCode(e.target.value.replace(/\D/g, "").slice(0, 6)); setError(null); }}
              placeholder="000000"
              maxLength={6}
              className="w-32 rounded-md bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm font-mono text-white placeholder-zinc-600 text-center tracking-widest focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
            <button
              onClick={confirmCode}
              disabled={loading || code.length !== 6}
              className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-md transition-colors flex items-center gap-2"
            >
              {loading && <Loader2 className="w-3 h-3 animate-spin" />}
              Verify & Link
            </button>
            <button
              onClick={() => { setStep("idle"); setCode(""); setError(null); }}
              disabled={loading}
              className="px-3 py-2 text-sm text-zinc-400 hover:text-white transition-colors"
            >
              Back
            </button>
          </div>
          <p className="text-xs text-zinc-500">Code expires in 10 minutes.</p>
        </>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}

export function DiscordLinkSection({ linkedDiscordId, discordInviteUrl }: { linkedDiscordId: string | null; discordInviteUrl?: string | null }) {
  if (linkedDiscordId) {
    return (
      <div className="text-sm text-zinc-400">
        <span className="text-green-400 font-medium">Linked</span>
        <span className="text-zinc-500"> · Discord ID: {linkedDiscordId}</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {discordInviteUrl && (
        <div className="rounded-md bg-indigo-950 border border-indigo-800 px-4 py-3 space-y-2">
          <p className="text-sm font-medium text-indigo-200">Join our Discord server</p>
          <p className="text-sm text-indigo-300">
            Join the Discord server and link your account to request media directly from Discord.
          </p>
          <a
            href={discordInviteUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-indigo-400 hover:text-indigo-300 transition-colors"
          >
            Join Discord <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>
      )}
      {!discordInviteUrl && <p className="text-sm text-zinc-400">No Discord account linked yet.</p>}
      <TokenLinkFlow />
      <div className="border-t border-zinc-800 pt-4">
        <WebMergeFlow />
      </div>
    </div>
  );
}
