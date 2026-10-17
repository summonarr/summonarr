"use client";

import { useId, useState } from "react";
import { Loader2 } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/components/i18n/i18n-provider";

// The inline "confirm your password" row a step-up route asks for
// (src/lib/client/step-up.ts, guardrail 6g). The parent owns the request: it
// calls `onSubmit(password)` and passes back `busy` and any `error` (e.g.
// "Incorrect password.") to show beside the field that produced it.
export function StepUpPasswordForm({
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  error: string | null;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const id = useId();
  const [password, setPassword] = useState("");
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (password && !busy) onSubmit(password);
      }}
    >
      <label htmlFor={id} className="block text-sm text-zinc-400">
        {t("profile.stepUp.prompt")}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={id}
          type="password"
          autoFocus
          autoComplete="current-password"
          placeholder={t("profile.sessions.passwordPlaceholder")}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={error ? true : undefined}
          className="flex-1 min-w-0 sm:flex-none sm:w-56"
        />
        <Button type="submit" disabled={!password || busy}>
          {busy && <Loader2 className="w-4 h-4 animate-spin" />}
          {t("profile.stepUp.continue")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={onCancel}
          disabled={busy}
          className="text-zinc-400 hover:text-zinc-100"
        >
          {t("profile.common.cancel")}
        </Button>
      </div>
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
    </form>
  );
}
