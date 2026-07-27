"use client";

import { useState } from "react";
import { Loader2 } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { withBasePath } from "@/lib/base-path";

// Self-service account deletion (App Store Guideline 5.1.1(v)). Calls
// DELETE /api/profile, which DISABLES the account: every session is revoked and
// sign-in is refused from then on, but nothing is scrubbed, so an admin can
// restore it. The copy below must not promise erasure — the irreversible scrub
// is a separate admin action (see src/lib/account-lifecycle.ts). The server
// already revoked the session, so we just bounce to /login.
export function DeleteAccount({ requiresPassword = false }: { requiresPassword?: boolean }) {
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
        setError(data.error ?? "Failed to delete account");
        setDeleting(false);
        return;
      }
      window.location.href = withBasePath("/login");
    } catch {
      setError("Failed to delete account. Please try again.");
      setDeleting(false);
    }
  }

  if (!confirming) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-zinc-400">
          Close your account and sign out everywhere. You won’t be able to sign
          back in — only an administrator can restore access. Your requests,
          votes, issues and watch history are kept. Ask an administrator if you
          also want your personal data erased.
        </p>
        <Button
          type="button"
          variant="destructive"
          onClick={() => setConfirming(true)}
          className="w-full sm:w-auto"
        >
          Close account
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-zinc-400">
        Type <span className="font-semibold text-zinc-200">DELETE</span> to confirm.
        This closes your account and signs you out of every device — you won’t be
        able to sign back in unless an administrator restores it.
      </p>
      <Input
        value={confirmText}
        onChange={(e) => setConfirmText(e.target.value)}
        placeholder="DELETE"
        autoComplete="off"
        aria-label="Type DELETE to confirm account deletion"
        className="bg-zinc-800 border-zinc-700"
      />
      {requiresPassword && (
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Current password"
          autoComplete="current-password"
          aria-label="Current password"
          className="bg-zinc-800 border-zinc-700"
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
          {deleting ? "Closing…" : "Close my account"}
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
          Cancel
        </Button>
      </div>
    </div>
  );
}
