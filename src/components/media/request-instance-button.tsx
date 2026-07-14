"use client";

import { useState } from "react";
import { Plus, Check, Loader2, Ban } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { useToast } from "@/components/ui/toast";

// Secondary "Request on <instance>" action shown on movie/TV detail pages for
// each configured NAMED Radarr/Sonarr instance the viewer may request on
// (canRequestInstance). Posts the explicit arrInstance slug; the server
// re-validates the instance and the caller's grant. The default instance stays
// on RequestButton and 4K on Request4kButton — this covers named slugs only.
export function RequestInstanceButton({
  tmdbId,
  mediaType,
  instance,
  instanceName,
  requestToken,
  requested,
  available,
  blacklisted,
}: {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  /** Named instance slug (never "" or "4k"). */
  instance: string;
  /** Display name from the instance registry. */
  instanceName: string;
  requestToken?: string;
  requested?: boolean;
  // The instance already has the file — show an "Available" state instead of a CTA.
  available?: boolean;
  // The title is admin-blacklisted — no request either (the request POST 403s).
  blacklisted?: boolean;
}) {
  const { toast } = useToast();
  const [state, setState] = useState<"idle" | "loading" | "requested" | "error">(
    requested ? "requested" : "idle",
  );
  const [msg, setMsg] = useState("");

  async function submit() {
    setState("loading");
    setMsg("");
    try {
      const res = await fetch(withBasePath("/api/requests"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tmdbId, mediaType, arrInstance: instance, _token: requestToken }),
      });
      if (res.status === 409) {
        setState("requested");
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setMsg(data.error ?? "Something went wrong");
        setState("error");
        return;
      }
      setState("requested");
      toast({ title: `Requested on ${instanceName}`, variant: "success" });
    } catch {
      setMsg("Network error — please try again");
      setState("error");
    }
  }

  const base: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    padding: "6px 14px",
    height: 34,
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 500,
    whiteSpace: "nowrap",
  };

  // Availability wins over request state — once the copy is fetched there's nothing to request.
  if (available) {
    return (
      <span
        style={{
          ...base,
          background: "var(--ds-accent-soft)",
          color: "var(--ds-accent)",
          border: "1px solid var(--ds-accent-ring)",
        }}
      >
        <Check style={{ width: 14, height: 14 }} />
        Available on {instanceName}
      </span>
    );
  }

  if (state === "requested") {
    return (
      <span
        style={{
          ...base,
          background: "var(--ds-accent-soft)",
          color: "var(--ds-accent)",
          border: "1px solid var(--ds-accent-ring)",
        }}
      >
        <Check style={{ width: 14, height: 14 }} />
        Requested on {instanceName}
      </span>
    );
  }

  // Blacklisted blocks all requests (per tmdbId+mediaType, every instance).
  if (blacklisted) {
    return (
      <span
        style={{
          ...base,
          background: "var(--ds-bg-2)",
          color: "var(--ds-fg-muted)",
          border: "1px solid var(--ds-border)",
        }}
      >
        <Ban style={{ width: 14, height: 14 }} />
        Not available to request
      </span>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={submit}
        disabled={state === "loading"}
        style={{
          ...base,
          background: "var(--ds-bg-2)",
          color: "var(--ds-fg)",
          border: "1px solid var(--ds-border)",
          cursor: state === "loading" ? "progress" : "pointer",
        }}
      >
        {state === "loading" ? (
          <Loader2 className="animate-spin" style={{ width: 14, height: 14 }} />
        ) : (
          <Plus style={{ width: 14, height: 14 }} />
        )}
        Request on {instanceName}
      </button>
      {state === "error" && msg && (
        <span className="ds-mono" style={{ fontSize: 11, color: "var(--ds-danger)" }}>
          {msg}
        </span>
      )}
    </div>
  );
}
