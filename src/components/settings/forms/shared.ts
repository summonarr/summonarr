"use client";

import { useEffect, useState } from "react";
import { withBasePath } from "@/lib/base-path";
import { apiErrorText } from "@/lib/client/api-error";

// Status types shared by the settings form files.
export type SaveStatus = "idle" | "saving" | "ok" | "error";
export type LoadStatus = "idle" | "loading" | "loaded" | "error";

// ── PATCH /api/settings ──────────────────────────────────────────────────────

/** What PATCH /api/settings answered. Never thrown: a failure is `ok: false`. */
export interface SettingsPatchResult {
  ok: boolean;
  /** The HTTP status; 0 when no answer arrived (offline, a reset connection). */
  status: number;
  /** The JSON body ({} when there was none, or it wasn't a JSON object). */
  data: Record<string, unknown>;
  /** The route's own reason for a failure; "" when it gave none. */
  error: string;
}

/**
 * Saved means a 2xx that SAYS `ok: true`. The settings route sends `ok` with
 * every answer it gives, so a 2xx without it never came from the route — a
 * reverse proxy's sign-in page, say — and is not "Saved".
 */
export function settingsPatchSucceeded(res: { ok: boolean }, data: unknown): boolean {
  return res.ok && typeof data === "object" && data !== null && (data as { ok?: unknown }).ok === true;
}

export async function patchSettings(body: Record<string, unknown>): Promise<SettingsPatchResult> {
  let res: Response;
  try {
    res = await fetch(withBasePath("/api/settings"), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, data: {}, error: "" };
  }
  const parsed: unknown = await res.json().catch(() => null);
  const data = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
  return { ok: settingsPatchSucceeded(res, data), status: res.status, data, error: apiErrorText(data, "") };
}

// ── one form's save state ────────────────────────────────────────────────────

type StatusUpdate = SaveStatus | ((s: SaveStatus) => SaveStatus);

export interface SettingsSaver {
  /**
   * PATCH `body`. The status follows the answer, which is also returned. A
   * failure's message is the route's own reason, else `failureText(result)`
   * when given, else "" (the form shows its own "Failed to save").
   */
  save(
    body: Record<string, unknown>,
    failureText?: (result: SettingsPatchResult) => string,
  ): Promise<SettingsPatchResult>;
  /**
   * Every field edit calls this. It clears the last result, but never a save
   * in flight: that keeps Save locked (a second PATCH could finish first)
   * until the answer arrives, and the answer then reads "idle", not "Saved" —
   * the edit was not in the request.
   */
  edited(): void;
  /** Drops the pending fade (on unmount). */
  cancel(): void;
}

/**
 * The save state machine behind useSettingsSave, kept free of React so the
 * unit suite can drive it (tests/settings-save.test.mts).
 *
 * - A save cancels the previous save's fade timer: fired mid-flight it would
 *   unlock Save, or hide this save's result early.
 * - Only "Saved" fades (after `resetMs`); an error stays until the next edit
 *   or save, so the route's reason can be read.
 */
export function createSettingsSaver(opts: {
  setStatus: (update: StatusUpdate) => void;
  setMessage: (message: string) => void;
  resetMs?: number;
  patch?: (body: Record<string, unknown>) => Promise<SettingsPatchResult>;
}): SettingsSaver {
  const { setStatus, setMessage } = opts;
  const resetMs = opts.resetMs ?? 3000;
  const patch = opts.patch ?? patchSettings;
  // Bumped on every edit. A save compares it with the value it was sent at.
  let editSeq = 0;
  let fade: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (fade) clearTimeout(fade);
    fade = null;
  };
  return {
    async save(body, failureText) {
      cancel();
      setStatus("saving");
      setMessage("");
      const sentAt = editSeq;
      const result = await patch(body);
      if (result.ok) {
        // Edited since the click: the form now holds unsaved changes.
        setStatus(editSeq === sentAt ? "ok" : "idle");
      } else {
        setMessage(result.error || (failureText ? failureText(result) : ""));
        setStatus("error");
      }
      fade = setTimeout(() => setStatus((s) => (s === "ok" ? "idle" : s)), resetMs);
      return result;
    },
    edited() {
      editSeq += 1;
      setStatus((s) => (s === "saving" ? s : "idle"));
    },
    cancel,
  };
}

/**
 * A settings form's save: `status` and the route's `message` for
 * SaveStatusMessage, `save(body)` for the submit, `edited()` for every field
 * change. Render the error as `message || t("settings.form.common.saveFailed")`.
 */
export function useSettingsSave(resetMs = 3000) {
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [message, setMessage] = useState("");
  const [saver] = useState(() => createSettingsSaver({ setStatus, setMessage, resetMs }));
  useEffect(() => saver.cancel, [saver]);
  return { status, message, save: saver.save, edited: saver.edited };
}
