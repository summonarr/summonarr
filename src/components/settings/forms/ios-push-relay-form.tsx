"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle, XCircle, Loader2, Trash2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import type { SaveStatus } from "./shared";

interface IosPushRelayFormProps {
  initialRelayUrl: string;
  initialRelayKey: string; // masked placeholder when set, "" when not
  initialRecommendedBuild: string;
}

export function IosPushRelayForm({ initialRelayUrl, initialRelayKey, initialRecommendedBuild }: IosPushRelayFormProps) {
  const [relayUrl, setRelayUrl] = useState(initialRelayUrl);
  const [relayKey, setRelayKey] = useState(initialRelayKey);
  const [recommendedBuild, setRecommendedBuild] = useState(initialRecommendedBuild);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [errorMessage, setErrorMessage] = useState("");

  const keyIsSet = initialRelayKey.length > 0;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    setErrorMessage("");
    try {
      const body: Record<string, string> = {
        // Masked placeholder is skipped server-side; "" clears the key (clearable).
        apnsRelayKey: relayKey,
        // "" clears the recommendation (clearable).
        recommendedIosBuild: recommendedBuild.trim(),
        // "" clears the override (clearable) — push falls back to the default
        // relay, which keeps the "leave blank for the default" hint truthful.
        apnsRelayUrl: relayUrl.trim(),
      };
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && data.ok !== false) {
        setStatus("ok");
      } else {
        setStatus("error");
        setErrorMessage(typeof data.error === "string" ? data.error : "");
      }
    } catch {
      setStatus("error");
    }
    setTimeout(() => setStatus("idle"), 3000);
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="apns-relay-url">Relay URL</Label>
        <Input
          id="apns-relay-url"
          type="url"
          value={relayUrl}
          onChange={(e) => { setRelayUrl(e.target.value); setStatus("idle"); }}
          placeholder="https://summonapns.gadgetusaf.com/push"
          className="bg-zinc-800 border-zinc-700 font-mono text-sm"
        />
        <p className="text-xs text-zinc-500">
          Must be https://. Leave blank to use the default relay operated by the app publisher.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="apns-relay-key">Relay key <span className="text-zinc-500 font-normal">(optional)</span></Label>
        <div className="flex items-center gap-2">
          <Input
            id="apns-relay-key"
            type="password"
            value={relayKey}
            onChange={(e) => { setRelayKey(e.target.value); setStatus("idle"); }}
            placeholder="••••••••"
            className="bg-zinc-800 border-zinc-700 font-mono text-sm"
          />
          {(keyIsSet || relayKey.length > 0) && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => { setRelayKey(""); setStatus("idle"); }}
              className="border-zinc-700 text-zinc-400 hover:text-white shrink-0 gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Remove
            </Button>
          )}
        </div>
        <p className="text-xs text-zinc-500">
          Sent as a Bearer token on every relay request when the relay requires auth (8–200 characters, no spaces).
          {keyIsSet && " A key is currently set — click Remove and Save to clear it."}
        </p>
      </div>
      <div className="space-y-1.5 max-w-[220px]">
        <Label htmlFor="recommended-ios-build">Recommended iOS build <span className="text-zinc-500 font-normal">(optional)</span></Label>
        <Input
          id="recommended-ios-build"
          type="number"
          min="1"
          max="1000000"
          value={recommendedBuild}
          onChange={(e) => { setRecommendedBuild(e.target.value); setStatus("idle"); }}
          placeholder="e.g. 42"
          className="bg-zinc-800 border-zinc-700 text-sm"
        />
        <p className="text-xs text-zinc-500">
          iOS builds below this number show a dismissible update prompt after sign-in. Leave blank to disable.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={status === "saving"} className="bg-indigo-600 hover:bg-indigo-500">
          {status === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</> : "Save"}
        </Button>
        {status === "ok"    && <span className="flex items-center gap-1.5 text-sm text-green-400"><CheckCircle className="w-4 h-4" />Saved</span>}
        {status === "error" && <span className="flex items-center gap-1.5 text-sm text-red-400"><XCircle className="w-4 h-4" />{errorMessage || "Failed to save"}</span>}
      </div>
    </form>
  );
}
