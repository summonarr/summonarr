"use client";

import { useEffect } from "react";

// Replaces the entire document on unrecoverable errors; must render its own <html>/<body> shell
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
            background: "#09090b",
            color: "#fff",
            fontFamily: "sans-serif",
          }}
        >
          <h2 style={{ fontSize: "1.25rem", fontWeight: 600 }}>Something went wrong</h2>
          <p style={{ color: "#a1a1aa", fontSize: "0.875rem", maxWidth: "24rem" }}>
            A critical error occurred. Please reload the page.
          </p>
          <button
            onClick={() => unstable_retry()}
            style={{
              padding: "0.5rem 1rem",
              borderRadius: "0.375rem",
              background: "#4f46e5",
              color: "#fff",
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
