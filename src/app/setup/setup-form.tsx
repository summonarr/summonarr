"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
  variant?: "setup" | "register";
}

export function SetupForm({ variant = "setup" }: Props) {
  const isSetup = variant === "setup";
  const [form, setForm] = useState({ name: "", email: "", password: "", confirm: "" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  function set(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (form.password !== form.confirm) {
      setError("Passwords do not match");
      return;
    }

    setLoading(true);

    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: form.name, email: form.email, password: form.password }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Registration failed");
        return;
      }

      const result = await signIn("credentials", {
        email: form.email,
        password: form.password,
        redirect: false,
      });

      if (result?.error) {
        setError("Account created — please sign in");
        window.location.href = "/login";
        return;
      }

      window.location.href = "/";
    } catch {
      setError("Something went wrong, please try again");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="name">Display name</Label>
        <Input
          id="name"
          value={form.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="Your name"
          className="bg-zinc-800 border-zinc-700"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="email">Email <span className="text-red-400">*</span></Label>
        <Input
          id="email"
          type="email"
          value={form.email}
          onChange={(e) => set("email", e.target.value)}
          placeholder={isSetup ? "admin@example.com" : "you@example.com"}
          className="bg-zinc-800 border-zinc-700"
          required
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="password">Password <span className="text-red-400">*</span></Label>
        <Input
          id="password"
          type="password"
          value={form.password}
          onChange={(e) => set("password", e.target.value)}
          placeholder="Min. 8 characters"
          className="bg-zinc-800 border-zinc-700"
          minLength={8}
          required
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="confirm">Confirm password <span className="text-red-400">*</span></Label>
        <Input
          id="confirm"
          type="password"
          value={form.confirm}
          onChange={(e) => set("confirm", e.target.value)}
          placeholder="Repeat your password"
          className="bg-zinc-800 border-zinc-700"
          required
        />
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <Button
        type="submit"
        disabled={loading}
        className={`w-full bg-indigo-600 hover:bg-indigo-500${isSetup ? " mt-2" : ""}`}
      >
        {loading ? "Creating account..." : isSetup ? "Create admin account" : "Create account"}
      </Button>
    </form>
  );
}
