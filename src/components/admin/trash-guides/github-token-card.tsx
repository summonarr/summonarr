"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle, Loader2, XCircle } from "@/components/icons";
import type { ActionState } from "./types";
import { withBasePath } from "@/lib/base-path";

export function GithubTokenCard() {
  const [masked, setMasked] = useState<string>("");
  const [value, setValue] = useState("");
  const [state, setState] = useState<ActionState>("idle");

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(withBasePath(`/api/settings`));
        if (!res.ok) return;
        const data = (await res.json()) as Record<string, string>;
        setMasked(data.trashGithubToken ?? "");
      } catch {

      }
    })();
  }, []);

  async function save() {
    if (!value) return;
    setState("running");
    try {
      const res = await fetch(withBasePath(`/api/settings`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trashGithubToken: value }),
      });
      if (!res.ok) throw new Error();
      setState("ok");
      setMasked("••••••••");
      setValue("");
    } catch {
      setState("error");
    }
    setTimeout(() => setState("idle"), 2000);
  }

  return (
    <Card className="bg-zinc-900 border-zinc-800 p-6">
      <div className="mb-3">
        <h2 className="font-semibold text-white text-lg">GitHub Token <span className="text-xs font-normal text-zinc-500">(optional)</span></h2>
        <p className="text-sm text-zinc-500 mt-0.5">
          GitHub limits unauthenticated API calls to 60/hour — enough for a few refreshes. Paste any{" "}
          <a href="https://github.com/settings/tokens?type=beta" target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline">fine-grained personal access token</a>{" "}
          (no scopes needed, public-repo read is the default) to raise it to 5 000/hour. Stored encrypted at rest when{" "}
          <code className="text-zinc-300">TOKEN_ENCRYPTION_KEY</code> is set.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={masked ? "Replace stored token…" : "ghp_… or github_pat_…"}
          className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-indigo-500 font-mono"
          autoComplete="off"
        />
        <Button
          type="button"
          onClick={save}
          disabled={!value || state === "running"}
          className="bg-indigo-600 hover:bg-indigo-500 text-white"
        >
          {state === "running" ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save"}
        </Button>
        {masked && !value && (
          <span className="text-xs text-zinc-500 inline-flex items-center gap-1.5">
            <CheckCircle className="w-3.5 h-3.5 text-green-400" />
            Configured
          </span>
        )}
        {state === "ok"    && <span className="text-xs text-green-400 flex items-center gap-1.5"><CheckCircle className="w-3.5 h-3.5" />Saved</span>}
        {state === "error" && <span className="text-xs text-red-400 flex items-center gap-1.5"><XCircle className="w-3.5 h-3.5" />Save failed</span>}
      </div>
    </Card>
  );
}
