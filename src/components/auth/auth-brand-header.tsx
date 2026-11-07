import type { ReactNode } from "react";
import { Film } from "@/components/icons";

// The Playfair wordmark and accent Film tile heading the login and first-run
// setup screens. The restore path goes straight from /setup to /login, so the
// two must read as one surface; one component keeps them identical. Server-safe
// (no client hooks). `children` is each page's own title and subtitle.
export function AuthBrandHeader({
  wordmarkAs: Wordmark = "p",
  children,
}: {
  wordmarkAs?: "p" | "h1";
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center" style={{ marginBottom: 24 }}>
      <Wordmark
        className="m-0"
        style={{
          fontFamily: "var(--font-playfair)",
          fontSize: 28,
          fontWeight: 400,
          color: "var(--ds-fg)",
          letterSpacing: "0.02em",
          marginBottom: 14,
        }}
      >
        Summonarr
      </Wordmark>
      <div
        className="flex items-center justify-center"
        style={{
          width: 44,
          height: 44,
          borderRadius: 10,
          background: "var(--ds-accent)",
          color: "var(--ds-accent-fg)",
          boxShadow:
            "0 0 0 1px color-mix(in oklab, var(--ds-accent) 40%, transparent), inset 0 -1px 0 rgba(0,0,0,.15)",
          marginBottom: 12,
        }}
      >
        <Film style={{ width: 22, height: 22 }} />
      </div>
      {children}
    </div>
  );
}
