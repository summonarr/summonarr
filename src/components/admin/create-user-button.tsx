"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StyledSelect } from "@/components/ui/styled-select";
import { Dialog, DialogBackdrop, DialogPopup, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { Loader2, Check, UserPlus, AlertTriangle } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { fetchJson, jsonInit } from "@/lib/client/fetch-json";
import { v } from "@/lib/validate";
import { useAsyncAction } from "@/hooks/use-async-action";
import { useT } from "@/components/i18n/i18n-provider";
import { MIN_PASSWORD_LENGTH } from "@/lib/password-policy";
import { roleLabelKey, type User } from "@/components/admin/user-modals/shared";

type Role = User["role"];

// Every role, in the order the dialog lists them. A Record, so a role added to
// User["role"] doesn't compile until it has a place here (and a label in
// roleLabelKey) — a hand-typed <option> list dropped it silently.
const ROLE_RANK: Record<Role, number> = { USER: 0, ISSUE_ADMIN: 1, ADMIN: 2 };
const ROLES = (Object.keys(ROLE_RANK) as Role[]).sort((a, b) => ROLE_RANK[a] - ROLE_RANK[b]);
const isRole = (value: string): value is Role => Object.prototype.hasOwnProperty.call(ROLE_RANK, value);

// The 201 answer is the created user; only its (normalised) email is shown.
const CreatedUser = v.object({ email: v.optional(v.string()) });

// How long the "created" line stays beside the button.
const CREATED_NOTICE_MS = 10_000;

// Admin "Create user" — the only in-app path to a local username/password account
// (public registration closes after the first user). Posts to POST /api/admin/users
// and refreshes the server-rendered user table on success.
export function CreateUserButton() {
  const t = useT();
  const router = useRouter();
  const action = useAsyncAction();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("USER");
  const loading = action.busy("create");
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  // The confirmation is a passing note, not state the page keeps.
  useEffect(() => {
    if (!created) return;
    const timer = setTimeout(() => setCreated(null), CREATED_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [created]);

  // 12 mirrors POST /api/admin/users (and register + profile/password).
  const canSubmit = email.trim().length > 0 && password.length >= MIN_PASSWORD_LENGTH && !loading;

  function resetForm() {
    setName("");
    setEmail("");
    setPassword("");
    setRole("USER");
    setError(null);
  }

  async function submit() {
    if (!canSubmit) return;
    setError(null);
    const typedEmail = email.trim();
    // "skip": a second Enter while the first create is out must not send a second account.
    const res = await action.run("create", (signal) =>
      fetchJson(withBasePath("/api/admin/users"), {
        init: jsonInit("POST", { email: typedEmail, password, name: name.trim() || undefined, role }),
        schema: CreatedUser,
        signal,
        // A password hash queues behind other sign-ins; give the create room.
        timeoutMs: 60_000,
        fallbackError: t("adminManage.createUser.failed"),
      }), { ifBusy: "skip" });
    if (!res) return;
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setCreated(res.data.email ?? typedEmail);
    resetForm();
    setOpen(false);
    router.refresh();
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
          // No dismissing (Escape, backdrop) mid-submit: a failure would land on
          // a closed dialog and be wiped on reopen, and a late success would
          // close a dialog the admin had reopened.
          if (!o && loading) return;
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
                  minLength={MIN_PASSWORD_LENGTH}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cu-role">{t("adminManage.createUser.role")}</Label>
                <StyledSelect id="cu-role" value={role} onChange={(e) => { if (isRole(e.target.value)) setRole(e.target.value); }}>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>{t(roleLabelKey[r])}</option>
                  ))}
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
