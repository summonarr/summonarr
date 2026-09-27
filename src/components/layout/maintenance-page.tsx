"use client";

import { useState } from "react";
import { LogOut, RefreshCw, Wrench } from "@/components/icons";
import {
  StatePage,
  STATE_PAGE_CTA_CLASS,
  statePageCtaStyle,
} from "@/components/layout/state-page";
import { withBasePath } from "@/lib/base-path";

// Shown by (app)/layout.tsx INSTEAD of the whole app for non-admins while
// maintenance mode is on — header and account menu included. So besides
// "Try again" (a plain <a> with an empty href, i.e. a full reload of the
// current URL, which re-runs the layout's maintenance check) it offers
// "Sign out": someone signed in with the wrong account (an admin on their
// non-admin login) otherwise has no way off this wall short of clearing
// cookies by hand. That button is why this is a client component.
export function MaintenancePage({ message }: { message?: string }) {
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    try {
      await fetch(withBasePath("/api/auth/sign-out"), { method: "POST", credentials: "include" });
    } catch {
      // Best-effort: go to the login page even if the request failed.
    }
    window.location.href = withBasePath("/login");
  }

  const secondary = statePageCtaStyle("secondary");
  return (
    <StatePage
      frame="document"
      glyph={<Wrench style={{ width: 56, height: 56, color: "var(--ds-warning)" }} />}
      title="Under maintenance"
      description={message || "We're performing some maintenance. Please check back shortly."}
      primary={
        <>
          <a href={withBasePath("")} className={STATE_PAGE_CTA_CLASS} style={secondary}>
            <RefreshCw className="w-4 h-4" />
            Try again
          </a>
          <button
            type="button"
            onClick={signOut}
            disabled={signingOut}
            className={STATE_PAGE_CTA_CLASS}
            style={secondary}
          >
            <LogOut className="w-4 h-4" />
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </>
      }
    />
  );
}
