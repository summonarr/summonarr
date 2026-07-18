"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import { withBasePath } from "@/lib/base-path";
import type { SaveStatus } from "./shared";

function generateSecret(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function WebhookSecretField({
  id,
  label,
  helpText,
  payloadKey,
  initialSecret,
}: {
  id: string;
  label: string;
  helpText: React.ReactNode;
  payloadKey: string;
  initialSecret: string;
}) {
  const [secret, setSecret] = useState(initialSecret);
  const [status, setStatus] = useState<SaveStatus>("idle");

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [payloadKey]: secret }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
      setStatus(res.ok && data.ok !== false ? "ok" : "error");
    } catch {
      setStatus("error");
    }
    setTimeout(() => setStatus("idle"), 3000);
  }

  return (
    <form onSubmit={handleSave} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor={id}>{label}</Label>
        <div className="flex gap-2">
          <Input
            id={id}
            type="password"
            value={secret}
            onChange={(e) => { setSecret(e.target.value); setStatus("idle"); }}
            placeholder="Leave blank to disable authentication"
            className="bg-zinc-800 border-zinc-700 font-mono text-sm"
          />
          <Button
            type="button"
            variant="outline"
            className="shrink-0 border-zinc-700 text-zinc-300 hover:text-white"
            onClick={() => { setSecret(generateSecret()); setStatus("idle"); }}
          >
            Generate
          </Button>
        </div>
        <p className="text-xs text-zinc-500">{helpText}</p>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={status === "saving"} className="bg-indigo-600 hover:bg-indigo-500">
          {status === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</> : "Save Token"}
        </Button>
        <SaveStatusMessage status={status} />
      </div>
    </form>
  );
}

export function WebhookSecretForm({
  initialSecret,
  initialSonarrSecret,
  initialRadarrSecret,
  initialSonarr4kSecret,
  initialRadarr4kSecret,
}: {
  initialSecret: string;
  initialSonarrSecret?: string;
  initialRadarrSecret?: string;
  initialSonarr4kSecret?: string;
  initialRadarr4kSecret?: string;
}) {
  return (
    <div className="space-y-6">
      <WebhookSecretField
        id="webhook-secret-sonarr"
        label="Sonarr webhook secret"
        payloadKey="sonarrWebhookSecret"
        initialSecret={initialSonarrSecret ?? ""}
        helpText={
          <>
            Used by the Sonarr webhook endpoint. Falls back to the legacy secret below if blank.
          </>
        }
      />
      <WebhookSecretField
        id="webhook-secret-radarr"
        label="Radarr webhook secret"
        payloadKey="radarrWebhookSecret"
        initialSecret={initialRadarrSecret ?? ""}
        helpText={
          <>
            Used by the Radarr webhook endpoint. Falls back to the legacy secret below if blank.
          </>
        }
      />
      <WebhookSecretField
        id="webhook-secret-radarr4k"
        label="Radarr 4K webhook secret"
        payloadKey="radarr4kWebhookSecret"
        initialSecret={initialRadarr4kSecret ?? ""}
        helpText={<>Used by the 4K Radarr instance&apos;s webhook. Set only if you run a separate 4K Radarr.</>}
      />
      <WebhookSecretField
        id="webhook-secret-sonarr4k"
        label="Sonarr 4K webhook secret"
        payloadKey="sonarr4kWebhookSecret"
        initialSecret={initialSonarr4kSecret ?? ""}
        helpText={<>Used by the 4K Sonarr instance&apos;s webhook. Set only if you run a separate 4K Sonarr.</>}
      />
      <div className="border-t border-zinc-800 pt-5">
        <WebhookSecretField
          id="webhook-secret-legacy"
          label="Legacy webhook secret (fallback — to be removed in a future release)"
          payloadKey="webhookSecret"
          initialSecret={initialSecret}
          helpText={
            <>
              Shared fallback used when a source-specific secret above is blank. Prefer the per-source
              secrets; this field will be removed in a future release.
            </>
          }
        />
      </div>
    </div>
  );
}
