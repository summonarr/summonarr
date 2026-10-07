"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StyledSelect } from "@/components/ui/styled-select";
import { Dialog, DialogBackdrop, DialogPopup, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { Loader2, Check, UserPlus, AlertTriangle } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { useT } from "@/components/i18n/i18n-provider";

// Admin "Create user" — the only in-app path to a local username/password account
// (public registration closes after the first user). Posts to POST /api/admin/users
// and refreshes the server-rendered user table on success.
export function CreateUserButton() {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("USER");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  // 12 mirrors POST /api/admin/users (and register + profile/password).
  const canSubmit = email.trim().length > 0 && password.length >= 12 && !loading;

  function resetForm() {
    setName("");
    setEmail("");
    setPassword("");
    setRole("USER");
    setError(null);
  }

  async function submit() {
    if (!canSubmit) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(withBasePath("/api/admin/users"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password, name: name.trim() || undefined, role }),
      });
      const data: { email?: string; error?: string } = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? t("adminManage.createUser.failed"));
        return;
      }
      setCreated(data.email ?? email.trim());
      resetForm();
      setOpen(false);
      router.refresh();
    } catch {
      setError(t("adminManage.createUser.failed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setCreated(null);
          resetForm();
          setOpen(true);
        }}
        className="border-zinc-700 text-zinc-300 hover:text-zinc-100 gap-2"
      >
        <UserPlus className="w-4 h-4" />
        {t("adminManage.createUser.button")}
      </Button>
      {created && (
        <span role="status" aria-live="polite" className="flex items-center gap-1 text-xs text-green-400">
          <Check className="w-3 h-3" />
          {t("adminManage.createUser.created", { email: created })}
        </span>
      )}

      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setError(null);
        }}
      >
        <DialogPortal>
          <DialogBackdrop />
          <DialogPopup>
            {/* The popup caps at the viewport and clips overflow, so the body
                scrolls itself — otherwise a short viewport (landscape phone,
                on-screen keyboard) hides the submit button. */}
            <div className="min-h-0 flex-1 overflow-y-auto p-6">
            <DialogTitle>{t("adminManage.createUser.title")}</DialogTitle>
            <p className="mt-1 text-sm text-zinc-400">
              {t("adminManage.createUser.description")}
            </p>
            <form
              className="mt-4 flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cu-name">
                  {t("adminManage.createUser.name")} <span className="font-normal text-zinc-500">{t("adminManage.createUser.optional")}</span>
                </Label>
                <Input
                  id="cu-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t("adminManage.createUser.namePlaceholder")}
                  maxLength={100}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cu-email">{t("adminManage.createUser.email")}</Label>
                <Input
                  id="cu-email"
                  type="email"
                  autoComplete="off"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t("adminManage.createUser.emailPlaceholder")}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cu-password">
                  {t("adminManage.createUser.password")} <span className="font-normal text-zinc-500">{t("adminManage.createUser.passwordHint")}</span>
                </Label>
                <Input
                  id="cu-password"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cu-role">{t("adminManage.createUser.role")}</Label>
                <StyledSelect id="cu-role" value={role} onChange={(e) => setRole(e.target.value)}>
                  <option value="USER">{t("adminManage.users.role.USER")}</option>
                  <option value="ISSUE_ADMIN">{t("adminManage.users.role.ISSUE_ADMIN")}</option>
                  <option value="ADMIN">{t("adminManage.users.role.ADMIN")}</option>
                </StyledSelect>
              </div>
              {error && (
                <span role="alert" aria-live="assertive" className="flex items-center gap-1.5 text-sm text-red-400">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  {error}
                </span>
              )}
              <div className="mt-2 flex items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setOpen(false)}
                  disabled={loading}
                  className="border-zinc-700 text-zinc-400 hover:text-zinc-100"
                >
                  {t("adminManage.common.cancel")}
                </Button>
                <Button type="submit" size="sm" disabled={!canSubmit} className="gap-1.5">
                  {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                  {t("adminManage.createUser.button")}
                </Button>
              </div>
            </form>
            </div>
          </DialogPopup>
        </DialogPortal>
      </Dialog>
    </div>
  );
}
