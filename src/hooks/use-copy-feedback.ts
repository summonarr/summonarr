"use client";

import { useState } from "react";
import { useDelayed } from "@/hooks/use-delayed";

/**
 * A copy button's "copied" tick: `copy(text)` writes to the clipboard and shows
 * the tick for `ms`. The reset timer is the one `useDelayed` slot, so a second
 * click restarts the window instead of an earlier timer clearing it early, and
 * nothing fires after unmount. A blocked or unavailable clipboard (insecure
 * context, denied permission) leaves the tick off and resolves `false`.
 */
export function useCopyFeedback(ms = 2000): { copied: boolean; copy: (text: string) => Promise<boolean> } {
  const [copied, setCopied] = useState(false);
  const later = useDelayed();
  async function copy(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      later.cancel();
      setCopied(false);
      return false;
    }
    setCopied(true);
    later(() => setCopied(false), ms);
    return true;
  }
  return { copied, copy };
}
