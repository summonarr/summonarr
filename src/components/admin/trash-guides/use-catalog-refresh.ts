"use client";

import { useState } from "react";
import { useDelayed } from "@/hooks/use-delayed";
import { withBasePath } from "@/lib/base-path";
import { useT } from "@/components/i18n/i18n-provider";
import { refreshOutcome } from "./outcomes";
import type { ActionState } from "./types";

export interface RunError {
  errors: string[];
  schemaDiagnostic?: string;
}

// The Refresh Catalog round trip shared by the Profile Library and Sync
// Settings cards. `onDone` runs after any answer the route gave (not after a
// 409 or a network failure): each card reloads what it shows.
//
// A success message clears after 3s; an error stays until dismissed or the
// next click. A 409 (the trash lock is held) ran nothing, so it is neither: an
// amber "already running" that clears itself.
export function useCatalogRefresh(onDone: () => void | Promise<void>) {
  const t = useT();
  const [state, setState] = useState<ActionState>("idle");
  const [skipped, setSkipped] = useState(false);
  const [error, setError] = useState<RunError | null>(null);
  const laterState = useDelayed();
  const laterSkipped = useDelayed();

  async function run() {
    // The previous run's resets must not fire into this one.
    laterState.cancel();
    laterSkipped.cancel();
    setState("running");
    setSkipped(false);
    setError(null);
    try {
      const res = await fetch(withBasePath(`/api/admin/trash-guides/refresh`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = (await res.json().catch(() => null)) as unknown;
      const outcome = refreshOutcome(res.status, body, t("trash.banner.stoppedEarly"));
      if (outcome.kind === "skipped") {
        setState("idle");
        setSkipped(true);
        laterSkipped(() => setSkipped(false), 3000);
        return;
      }
      if (outcome.failures.length > 0) {
        setState("error");
        setError({ errors: outcome.failures, schemaDiagnostic: outcome.schemaDiagnostic });
      } else {
        setState("ok");
      }
      await onDone();
    } catch (err) {
      setState("error");
      setError({ errors: [err instanceof Error ? err.message : String(err)] });
    }
    laterState(() => setState((s) => (s === "ok" ? "idle" : s)), 3000);
  }

  function dismiss() {
    setError(null);
    setState((s) => (s === "error" ? "idle" : s));
  }

  return { state, skipped, error, run, dismiss };
}
