"use client";

import { useEffect, useState } from "react";
import { useDelayed } from "@/hooks/use-delayed";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle, Loader2, XCircle } from "@/components/icons";
import type { ActionState } from "./types";
import { withBasePath } from "@/lib/base-path";
import { useT } from "@/components/i18n/i18n-provider";
import { rich } from "@/components/settings/forms/rich";

export function GithubTokenCard() {
  const t = useT();
  const [masked, setMasked] = useState<string>("");
  const [value, setValue] = useState("");
  const [state, setState] = useState<ActionState>("idle");
  // Which write the ok/error label is about, and the route's own refusal text
  // (the per-key cooldown, the settings rate limit) — "Save failed" alone hid why.
  const [action, setAction] = useState<"save" | "remove">("save");
  const [error, setError] = useState("");
  const later = useDelayed();

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(withBasePath(`/api/settings`));
        if (!res.ok) return;
        const data = (await res.json()) as Record<string, string>;
        setMasked(data.trashGithubToken ?? "");
      } catch {
        // Not fatal: without the current value the card just shows no "Configured" tag.
      }
    })();
  }, []);

  // An empty value removes the stored token: the settings route lets this key
  // be written empty, and the GitHub client reads "" as no token.
  async function write(next: string) {
    if (state === "running") return;
    later.cancel();
    setAction(next ? "save" : "remove");
    setState("running");
    setError("");
    try {
      const res = await fetch(withBasePath(`/api/settings`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trashGithubToken: next }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
        setError(typeof data?.error === "string" ? data.error : "");
        setState("error");
        // Long enough to read a reason ("wait N seconds").
        later(() => setState((s) => (s === "error" ? "idle" : s)), 6000);
        return;
      }
      setState("ok");
      setMasked(next ? "••••••••" : "");
      setValue("");
    } catch {
      setState("error");
      later(() => setState((s) => (s === "error" ? "idle" : s)), 6000);
      return;
    }
    later(() => setState((s) => (s === "ok" ? "idle" : s)), 2000);
  }

  return (
    <Card className="bg-zinc-900 border-zinc-800 p-6">
      <div className="mb-3">
        <h2 className="font-semibold text-zinc-100 text-lg">{t("trash.token.title")} <span className="text-xs font-normal text-zinc-500">{t("trash.token.optional")}</span></h2>
        <p className="text-sm text-zinc-500 mt-0.5">
          {rich(t("trash.token.description"), {
            link: (
              <a href="https://github.com/settings/tokens?type=beta" target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline">
                {t("trash.token.linkText")}
              </a>
            ),
            envVar: <code className="text-zinc-300">TOKEN_ENCRYPTION_KEY</code>,
          })}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="password"
          aria-label={t("trash.token.inputAria")}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={masked ? t("trash.token.replacePlaceholder") : t("trash.token.placeholder")}
          className="flex-1 min-w-40 bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-indigo-500 font-mono"
          autoComplete="off"
        />
        <Button
          type="button"
          onClick={() => { if (value) void write(value); }}
          disabled={!value || state === "running"}
          className="bg-indigo-600 hover:bg-indigo-500 text-[var(--ds-accent-fg)]"
        >
          {state === "running" && action === "save" ? <Loader2 className="w-4 h-4 animate-spin" /> : t("trash.common.save")}
        </Button>
        {masked && (
          <Button
            type="button"
            onClick={() => void write("")}
            disabled={state === "running"}
            className="bg-zinc-800 hover:bg-zinc-700 text-zinc-100"
          >
            {state === "running" && action === "remove" ? <Loader2 className="w-4 h-4 animate-spin" /> : t("trash.token.remove")}
          </Button>
        )}
        {masked && !value && (
          <span className="text-xs text-zinc-500 inline-flex items-center gap-1.5">
            <CheckCircle className="w-3.5 h-3.5 text-green-400" />
            {t("trash.token.configured")}
          </span>
        )}
        {state === "ok"    && <span className="text-xs text-green-400 flex items-center gap-1.5"><CheckCircle className="w-3.5 h-3.5" />{action === "remove" ? t("trash.token.removed") : t("trash.common.saved")}</span>}
        {state === "error" && <span className="text-xs text-red-400 flex items-center gap-1.5"><XCircle className="w-3.5 h-3.5" />{error || t("trash.common.saveFailed")}</span>}
      </div>
    </Card>
  );
}
