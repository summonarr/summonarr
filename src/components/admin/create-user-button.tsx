"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StyledSelect } from "@/components/ui/styled-select";
import { Dialog, DialogBackdrop, DialogPopup, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { Loader2, Check, UserPlus, AlertTriangle } from "@/components/icons";

// Admin "Create user" — the only in-app path to a local username/password account
// (public registration closes after the first user). Posts to POST /api/admin/users
// and refreshes the server-rendered user table on success.
export function CreateUserButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("USER");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  const canSubmit = email.trim().length > 0 && password.length >= 8 && !loading;

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
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password, name: name.trim() || undefined, role }),
      });
      const data: { email?: string; error?: string } = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Failed to create user");
        return;
      }
      setCreated(data.email ?? email.trim());
      resetForm();
      setOpen(false);
      router.refresh();
    } catch {
      setError("Failed to create user");
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
        className="border-zinc-700 text-zinc-300 hover:text-white gap-2"
      >
        <UserPlus className="w-4 h-4" />
        Create user
      </Button>
      {created && (
        <span role="status" aria-live="polite" className="flex items-center gap-1 text-xs text-green-400">
          <Check className="w-3 h-3" />
          Created {created}
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
          <DialogPopup className="p-6">
            <DialogTitle>Create local user</DialogTitle>
            <p className="mt-1 text-sm text-zinc-400">
              A username/password account. Registration is otherwise closed after the first user.
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
                  Name <span className="font-normal text-zinc-500">(optional)</span>
                </Label>
                <Input
                  id="cu-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Jane Doe"
                  maxLength={100}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cu-email">Email</Label>
                <Input
                  id="cu-email"
                  type="email"
                  autoComplete="off"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="user@example.com"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cu-password">
                  Password <span className="font-normal text-zinc-500">(min 8 characters)</span>
                </Label>
                <Input
                  id="cu-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cu-role">Role</Label>
                <StyledSelect id="cu-role" value={role} onChange={(e) => setRole(e.target.value)}>
                  <option value="USER">User</option>
                  <option value="ISSUE_ADMIN">Issue Admin</option>
                  <option value="ADMIN">Admin</option>
                </StyledSelect>
              </div>
              {error && (
                <span role="alert" aria-live="assertive" className="flex items-center gap-1.5 text-sm text-amber-400">
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
                  className="border-zinc-700 text-zinc-400 hover:text-white"
                >
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={!canSubmit} className="gap-1.5 bg-indigo-700 hover:bg-indigo-600">
                  {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                  Create user
                </Button>
              </div>
            </form>
          </DialogPopup>
        </DialogPortal>
      </Dialog>
    </div>
  );
}
