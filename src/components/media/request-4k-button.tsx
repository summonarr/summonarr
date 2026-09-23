"use client";

import { useState } from "react";
import { Plus, Check, Loader2, Ban } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { useToast } from "@/components/ui/toast";
import { DetailActionButton, DetailActionStatus } from "./detail-action-button";

// Secondary "Request in 4K" action shown on movie/TV detail pages when a 4K
// Radarr/Sonarr instance is configured and the viewer holds REQUEST_4K. Posts to
// the single request route with is4k:true; the server re-checks permission + that
// a 4K instance exists. Kept separate from RequestButton so the HD and 4K request
// states don't entangle.
export function Request4kButton({
  tmdbId,
  mediaType,
  requestToken,
  requested,
  available,
  blacklisted,
}: {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  requestToken?: string;
  requested?: boolean;
  // The 4K instance already has the file — show an "Available in 4K" state instead of a CTA.
  available?: boolean;
  // The title is admin-blacklisted — no 4K request either (the request POST 403s).
  blacklisted?: boolean;
}) {
  const { toast } = useToast();
  const [state, setState] = useState<"idle" | "loading" | "requested" | "error">(
    requested ? "requested" : "idle",
  );
  const [msg, setMsg] = useState("");
  // The route answers 200 { alreadyAvailable: true } and creates NOTHING when
  // this instance's available cache already holds the title (auto-approvers
  // only) — reading that as "requested" showed "4K Requested" for a request
  // that does not exist.
  const [foundAvailable, setFoundAvailable] = useState(false);

  async function submit() {
    setState("loading");
    setMsg("");
    try {
      const res = await fetch(withBasePath("/api/requests"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tmdbId, mediaType, is4k: true, _token: requestToken }),
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
      toast({ title: "Requested in 4K", variant: "success" });
    } catch {
      setMsg("Network error — please try again");
      setState("error");
    }
  }

  // Availability wins over request state — once the 4K copy is fetched there's nothing to request.
  if (available || foundAvailable) {
    return (
      <DetailActionStatus variant="accent-soft">
        <Check style={{ width: 14, height: 14 }} />
        Available in 4K
      </DetailActionStatus>
    );
  }

  if (state === "requested") {
    return (
      <DetailActionStatus variant="accent-soft">
        <Check style={{ width: 14, height: 14 }} />
        4K Requested
      </DetailActionStatus>
    );
  }

  // A 4K copy queued by someone else does NOT block the CTA: the server mirrors
  // the approved 4K request so this user gets the availability notification. The
  // queue state is communicated by the "4K Queued" chip in the badges row.

  // Blacklisted blocks all requests (per tmdbId+mediaType, both tiers).
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
        Request in 4K
      </DetailActionButton>
      {state === "error" && msg && (
        <span className="ds-mono" style={{ fontSize: 11, color: "var(--ds-danger)" }}>
          {msg}
        </span>
      )}
    </div>
  );
}
