"use client";

import { useState } from "react";
import { Loader2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface ChangePasswordProps {
  hasPassword: boolean;
}

export function ChangePassword({ hasPassword }: ChangePasswordProps) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword]         = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving]   = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    if (newPassword !== confirmPassword) {
      setError("New passwords do not match");
      return;
    }

    setSaving(true);
    try {
      const body: Record<string, string> = { newPassword };
      if (hasPassword) body.currentPassword = currentPassword;

      const res = await fetch("/api/profile/password", {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to update password");
        return;
      }
      const data = await res.json();
      if (data.requiresRelogin) {
        window.location.href = "/login";
        return;
      }
      setSuccess(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {hasPassword && (
        <div>
          <label className="block text-sm text-zinc-400 mb-1" htmlFor="current-password">
            Current password
          </label>
          <Input
            id="current-password"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className="bg-zinc-800 border-zinc-700"
            required
          />
        </div>
      )}

      <div>
        <label className="block text-sm text-zinc-400 mb-1" htmlFor="new-password">
          New password
        </label>
        <Input
          id="new-password"
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          className="bg-zinc-800 border-zinc-700"
          minLength={8}
          required
        />
      </div>

      <div>
        <label className="block text-sm text-zinc-400 mb-1" htmlFor="confirm-password">
          Confirm new password
        </label>
        <Input
          id="confirm-password"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          className="bg-zinc-800 border-zinc-700"
          minLength={8}
          required
        />
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {success && (
        <p className="flex items-center gap-1.5 text-sm text-emerald-400">
          <Check className="w-4 h-4" /> Password {hasPassword ? "updated" : "set"}
        </p>
      )}

      <Button
        type="submit"
        disabled={saving}
        className="w-full sm:w-auto"
      >
        {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
        {saving ? "Saving…" : hasPassword ? "Update password" : "Set password"}
      </Button>
    </form>
  );
}
