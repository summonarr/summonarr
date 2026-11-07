"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { withBasePath } from "@/lib/base-path";
import { rateLimitMessage } from "@/lib/client/rate-limit";
import { useT } from "@/components/i18n/i18n-provider";
// The server's floor in /api/auth/register and the profile change-password form.
// The old minLength 8 + "Min. 8 characters" hint let a 9–11 character password
// pass the browser check and bounce off the server with "at least 12".
import { MIN_PASSWORD_LENGTH } from "@/lib/password-policy";

// First-run admin account form; registers then auto-signs in. There is no
// self-registration variant — /register redirects to /setup or /login.
// `onBusyChange` mirrors the submit state so the shell can lock the
// create/restore switch while the account is being created.
export function SetupForm({ onBusyChange }: { onBusyChange?: (busy: boolean) => void }) {
  const t = useT();
  const [form, setForm] = useState({ name: "", email: "", password: "", confirm: "" });
  const [error, setError] = useState("");
  const [loading, setLoadingState] = useState(false);

  function setLoading(value: boolean) {
    setLoadingState(value);
    onBusyChange?.(value);
  }

  function set(field: string, value: string) {
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

    // Once the account exists, every way forward is the sign-in page: setup is
    // closed, so resubmitting this form could only be refused.
    let registered = false;
    const toLogin = () => {
      window.location.href = withBasePath("/login?created=1");
    };

    try {
      const res = await fetch(withBasePath("/api/auth/register"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: form.name, email: form.email, password: form.password }),
      });

      if (!res.ok) {
        // The rate-limit message reads only the status and headers, and a proxy's
        // error page (HTML 413/429/502) is not JSON, so neither depends on the body.
        const limited = rateLimitMessage(res, t);
        const data = (await res.json().catch(() => ({}))) as { error?: unknown };
        setError(limited ?? (typeof data.error === "string" ? data.error : t("auth.setup.error.registrationFailed")));
        setLoading(false);
        return;
      }
      registered = true;

      const result = await fetch(withBasePath("/api/auth/sign-in/credentials"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          email: form.email,
          password: form.password,
        }),
      });

      if (!result.ok) {
        // The login page says the account was created.
        toLogin();
        return;
      }

      // Both success paths above navigate away, so loading is cleared only on
      // failure — resetting it in a finally re-enabled the button mid-navigation
      // and a second click re-POSTed /api/auth/register.
      window.location.href = withBasePath("/");
    } catch {
      if (registered) {
        toLogin();
        return;
      }
      setError(t("auth.setup.error.generic"));
      setLoading(false);
    }
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
