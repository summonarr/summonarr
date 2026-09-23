"use client";

import { useState } from "react";
import { Plus, Check, Loader2, Ban } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { useToast } from "@/components/ui/toast";
import { DetailActionButton, DetailActionStatus } from "./detail-action-button";

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
  // The route answers 200 { alreadyAvailable: true } and creates NOTHING when
  // the server finds the title is already available for this instance. Same
  // handling as Request4kButton: show "Available", not a
  // "Requested" state for a request that does not exist.
  const [foundAvailable, setFoundAvailable] = useState(false);

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
      const body = (await res.json().catch(() => null)) as { alreadyAvailable?: boolean } | null;
      if (body?.alreadyAvailable) {
        setFoundAvailable(true);
        setState("idle");
        return;
      }
      setState("requested");
      toast({ title: `Requested on ${instanceName}`, variant: "success" });
    } catch {
      setMsg("Network error — please try again");
      setState("error");
    }
  }

  // Availability wins over request state — once the copy is fetched there's nothing to request.
  if (available || foundAvailable) {
    return (
      <DetailActionStatus variant="accent-soft">
        <Check style={{ width: 14, height: 14 }} />
        Available on {instanceName}
      </DetailActionStatus>
    );
  }

  if (state === "requested") {
    return (
      <DetailActionStatus variant="accent-soft">
        <Check style={{ width: 14, height: 14 }} />
        Requested on {instanceName}
      </DetailActionStatus>
    );
  }

  // Blacklisted blocks all requests (per tmdbId+mediaType, every instance).
  if (blacklisted) {
    return (
      <DetailActionStatus variant="muted">
        <Ban style={{ width: 14, height: 14 }} />
        Not available to request
      </DetailActionStatus>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <DetailActionButton
        variant="secondary"
        onClick={submit}
        disabled={state === "loading"}
        busy={state === "loading"}
      >
        {state === "loading" ? (
          <Loader2 className="animate-spin" style={{ width: 14, height: 14 }} />
        ) : (
          <Plus style={{ width: 14, height: 14 }} />
        )}
        Request on {instanceName}
      </DetailActionButton>
      {state === "error" && msg && (
        <span className="ds-mono" style={{ fontSize: 11, color: "var(--ds-danger)" }}>
          {msg}
        </span>
      )}
    </div>
  );
}
