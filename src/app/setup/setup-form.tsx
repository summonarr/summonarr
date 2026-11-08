"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { withBasePath } from "@/lib/base-path";
import { readApiError } from "@/lib/client/api-error";
import { rateLimitMessage } from "@/lib/client/rate-limit";
import type { Translator } from "@/lib/i18n/translate";
import { signInWithFetch } from "../login/sign-in-request";
import { useT } from "@/components/i18n/i18n-provider";
// The server's floor in /api/auth/register and the profile change-password form.
// The old minLength 8 + "Min. 8 characters" hint let a 9–11 character password
// pass the browser check and bounce off the server with "at least 12".
import { MIN_PASSWORD_LENGTH } from "@/lib/password-policy";

interface SetupFields {
  name: string;
  email: string;
  password: string;
  confirm: string;
}

// Creates the first account. The message on failure is the server's own
// (translated) refusal, or the rate-limit wait; never throws.
async function registerAdmin(
  fields: SetupFields,
  t: Translator,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch(withBasePath("/api/auth/register"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: fields.name, email: fields.email, password: fields.password }),
    });
  } catch {
    return { ok: false, error: t("auth.setup.error.generic") };
  }
  if (res.ok) return { ok: true };
  // The rate-limit message reads only the status and headers, and a proxy's
  // error page (HTML 413/429/502) is not JSON, so neither depends on the body.
  const limited = rateLimitMessage(res, t);
  return { ok: false, error: limited ?? (await readApiError(res, t("auth.setup.error.registrationFailed"))) };
}

// First-run admin account form; registers then auto-signs in. There is no
// self-registration variant — /register redirects to /setup or /login.
// `onBusyChange` mirrors the submit state so the shell can lock the
// create/restore switch while the account is being created.
export function SetupForm({ onBusyChange }: { onBusyChange?: (busy: boolean) => void }) {
  const t = useT();
  const [form, setForm] = useState<SetupFields>({ name: "", email: "", password: "", confirm: "" });
  const [error, setError] = useState("");
  const [loading, setLoadingState] = useState(false);

  function setLoading(value: boolean) {
    setLoadingState(value);
    onBusyChange?.(value);
  }

  function set(field: keyof SetupFields, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (form.password !== form.confirm) {
      setError(t("auth.setup.error.mismatch"));
      return;
    }

    setLoading(true);
    const registered = await registerAdmin(form, t);
    if (!registered.ok) {
      setError(registered.error);
      setLoading(false);
      return;
    }

    // Once the account exists, every way forward navigates: setup is closed,
    // so resubmitting this form could only be refused. A failed sign-in lands
    // on the login page, which says the account was created. Loading is never
    // cleared here — resetting it re-enabled the button mid-navigation and a
    // second click re-POSTed /api/auth/register. A brand-new account has no
    // second factor, so a correct password signs in directly (guardrail 6d).
    const signedIn = await signInWithFetch("credentials", { email: form.email, password: form.password });
    window.location.href = withBasePath(signedIn.ok ? "/" : "/login?created=1");
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="name">{t("auth.setup.displayName")}</Label>
        <Input
          id="name"
          value={form.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder={t("auth.setup.displayNamePlaceholder")}
          autoComplete="name"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="email">{t("auth.field.email")} <span className="text-red-400">*</span></Label>
        <Input
          id="email"
          type="email"
          value={form.email}
          onChange={(e) => set("email", e.target.value)}
          placeholder={t("auth.setup.emailPlaceholder")}
          autoComplete="email"
          required
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="password">{t("auth.field.password")} <span className="text-red-400">*</span></Label>
        <Input
          id="password"
          type="password"
          value={form.password}
          onChange={(e) => set("password", e.target.value)}
          placeholder={t("auth.setup.passwordPlaceholder")}
          // new-password: lets password managers offer to generate and save the
          // one password the operator most needs saved.
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          required
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="confirm">{t("auth.setup.confirmPassword")} <span className="text-red-400">*</span></Label>
        <Input
          id="confirm"
          type="password"
          value={form.confirm}
          onChange={(e) => set("confirm", e.target.value)}
          placeholder={t("auth.setup.confirmPlaceholder")}
          autoComplete="new-password"
          required
        />
      </div>

      {error && (
        <p role="alert" aria-live="assertive" className="text-sm text-red-400">
          {error}
        </p>
      )}

      <Button
        type="submit"
        disabled={loading}
        className="w-full min-h-11 mt-2"
      >
        {loading ? t("auth.setup.creating") : t("auth.setup.create")}
      </Button>
    </form>
  );
}
