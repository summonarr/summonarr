"use client";

import { withBasePath } from "@/lib/base-path";
import { fetchJson, LONG_RUN_TIMEOUT_MS, jsonInit } from "@/lib/client/fetch-json";
import { useT } from "@/components/i18n/i18n-provider";
import { answerOf, refreshOutcome } from "./outcomes";
import { useTrashRun } from "./use-trash-run";

export type { RunError } from "./types";

// The Refresh Catalog round trip shared by the Profile Library and Sync
// Settings cards. `onDone` runs after any answer the route gave (not after a
// 409 or a network failure): each card reloads what it shows.
//
// The state rules are useTrashRun's: a success clears after 3 s, an error stays
// until dismissed or the next click, and a 409 (the trash lock is held) ran
// nothing — an amber "already running" that clears itself. A 403 (TRaSH off)
// or 429 (the per-admin limit) shows the route's own reason.
export function useCatalogRefresh(onDone: () => void | Promise<void>) {
  const t = useT();
  const run = useTrashRun();

  async function start() {
    if (run.busy()) return;
    run.begin();
    // A refresh pulls the whole catalog from GitHub and writes it: no client
    // timeout, or a slow success would read as a failure.
    const res = await run.request((signal) =>
      fetchJson(withBasePath(`/api/admin/trash-guides/refresh`), { init: jsonInit("POST", {}), timeoutMs: LONG_RUN_TIMEOUT_MS, signal }),
    );
    if (!res) return;
    const answer = answerOf(res);
    if (answer === undefined) return;
    if (answer === null) {
      run.fail(t("trash.spec.error.network"));
      return;
    }
    const outcome = refreshOutcome(answer.status, answer.body, t("trash.banner.stoppedEarly"));
    if (outcome.kind === "skipped") {
      run.skip("running");
      return;
    }
    const failed = outcome.failures.length > 0;
    run.done(failed, failed ? { errors: outcome.failures, schemaDiagnostic: outcome.schemaDiagnostic } : null);
    // The refresh itself is already recorded as done; a card's reload failing
    // must not escape as an unhandled rejection from the click handler.
    try {
      await onDone();
    } catch (err) {
      console.warn("[trash] reload after catalog refresh failed:", err instanceof Error ? err.message : err);
    }
  }

  return { state: run.state, skipped: run.skipped !== null, error: run.error, run: start, dismiss: run.dismissError };
}
