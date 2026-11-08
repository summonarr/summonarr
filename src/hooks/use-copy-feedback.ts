"use client";

import { useCallback, useState } from "react";
import { useDelayed } from "@/hooks/use-delayed";

type ClipboardEnv = {
  navigator?: { clipboard?: { writeText?: (text: string) => Promise<void> } };
  document?: Pick<Document, "createElement" | "execCommand" | "body">;
};

// The legacy copy path for a page the Clipboard API isn't offered to: a
// plain-HTTP LAN install (http://192.168.x.x) is not a secure context, so
// navigator.clipboard is undefined there. A hidden textarea is selected and
// copied with execCommand, which still works in every current browser on a
// user gesture.
function execCommandCopy(text: string, doc: NonNullable<ClipboardEnv["document"]>): boolean {
  const area = doc.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  doc.body.appendChild(area);
  try {
    area.select();
    return doc.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

/**
 * Writes `text` to the clipboard: the Clipboard API where the page has it,
 * else the legacy execCommand path. Resolves whether the copy happened; never
 * throws. Exported (with an injectable environment) for its unit test.
 */
export async function writeClipboardText(text: string, env: ClipboardEnv = globalThis as ClipboardEnv): Promise<boolean> {
  const writeText = env.navigator?.clipboard?.writeText;
  if (typeof writeText === "function") {
    try {
      await writeText.call(env.navigator?.clipboard, text);
      return true;
    } catch {
      // Denied permission or an unfocused document: try the legacy path.
    }
  }
  return env.document ? execCommandCopy(text, env.document) : false;
}

/**
 * A copy button's feedback: `copy(text)` writes to the clipboard and shows the
 * "copied" tick — or, when no clipboard path worked, the `failed` flag — for
 * `ms`. The reset timer is the one `useDelayed` slot, so a second click
 * restarts the window instead of an earlier timer clearing it early, and
 * nothing fires after unmount. `copy` is stable across renders.
 */
export function useCopyFeedback(ms = 2000): { copied: boolean; failed: boolean; copy: (text: string) => Promise<boolean> } {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const later = useDelayed();
  const copy = useCallback(
    async (text: string): Promise<boolean> => {
      later.cancel();
      const ok = await writeClipboardText(text);
      setCopied(ok);
      setFailed(!ok);
      later(() => {
        setCopied(false);
        setFailed(false);
      }, ms);
      return ok;
    },
    [later, ms],
  );
  return { copied, failed, copy };
}
