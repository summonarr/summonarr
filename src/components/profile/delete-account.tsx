"use client";

import { useState } from "react";
import { Loader2 } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { withBasePath } from "@/lib/base-path";
import { useT } from "@/components/i18n/i18n-provider";

// Self-service "close account" (required by App Store Guideline 5.1.1(v)).
// It calls DELETE /api/profile, which DISABLES the account: every session is
// signed out and sign-in is refused from then on, but no data is erased, so an
// admin can restore it. The text below must not promise erasure — permanently
// erasing data is a separate admin action (see src/lib/account-lifecycle.ts,
// guardrail 33). The server has already ended our session, so we just go to /login.
export function DeleteAccount({ requiresPassword = false }: { requiresPassword?: boolean }) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [password, setPassword] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setError(null);
    setDeleting(true);
    try {
      const res = await fetch(withBasePath("/api/profile"), {
        method: "DELETE",
        ...(requiresPassword
          ? {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ password }),
            }
          : {}),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? t("profile.close.error.failed"));
        setDeleting(false);
        return;
      }
      window.location.href = withBasePath("/login");
    } catch {
      setError(t("profile.close.error.retry"));
      setDeleting(false);
    }
  }

  if (!confirming) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-zinc-400">
          {t("profile.close.intro")}
        </p>
        <Button
          type="button"
          variant="destructive"
          onClick={() => setConfirming(true)}
          className="w-full sm:w-auto"
        >
          {t("profile.close.button")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-zinc-400">
        {t("profile.close.confirmPrompt").split("{word}").map((part, i) => (
          <span key={i}>{i > 0 && <span className="font-semibold text-zinc-200">DELETE</span>}{part}</span>
        ))}
      </p>
      <Input
        value={confirmText}
        onChange={(e) => setConfirmText(e.target.value)}
        placeholder="DELETE"
        autoComplete="off"
        aria-label={t("profile.close.confirmLabel", { word: "DELETE" })}
      />
      {requiresPassword && (
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t("profile.password.current")}
          autoComplete="current-password"
          aria-label={t("profile.password.current")}
        />
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="destructive"
          disabled={confirmText !== "DELETE" || (requiresPassword && password.length === 0) || deleting}
          onClick={handleDelete}
          className="w-full sm:w-auto"
        >
          {deleting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
          {deleting ? t("profile.close.closing") : t("profile.close.confirmButton")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={deleting}
          onClick={() => {
            setConfirming(false);
            setConfirmText("");
            setPassword("");
            setError(null);
          }}
          className="w-full sm:w-auto"
        >
          {t("profile.common.cancel")}
        </Button>
      </div>
    </div>
  );
}
