"use client";

import { useEffect } from "react";
import "./globals.css";

// Replaces the entire document on unrecoverable errors; must render its own <html>/<body> shell.
// globals.css is imported here directly because global-error.tsx bypasses the root layout,
// which is where globals.css is normally loaded — without this import, the --ds-* tokens
// below would be undefined and the page would render unstyled.
export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error("[global/error]", error);
  }, [error]);

  return (
    <html>
      <body>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "100vh",
            gap: "1rem",
            textAlign: "center",
            padding: "2rem",
            background: "var(--ds-bg)",
            color: "var(--ds-fg)",
            fontFamily: "sans-serif",
          }}
        >
          <h2 style={{ fontSize: "1.25rem", fontWeight: 600 }}>Something went wrong</h2>
          <p style={{ color: "var(--ds-fg-muted)", fontSize: "0.875rem", maxWidth: "24rem" }}>
            A critical error occurred. Please reload the page.
          </p>
          <button
            onClick={() => unstable_retry()}
            style={{
              padding: "0.5rem 1rem",
              borderRadius: "0.375rem",
              background: "var(--ds-accent)",
              color: "var(--ds-accent-fg)",
              fontSize: "0.875rem",
              fontWeight: 500,
              border: "none",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
