import { Home, Film, Tv } from "@/components/icons";
import { NOT_FOUND_COPY, StatePage } from "@/components/layout/state-page";

// Replaces Next.js's default "404 / This page could not be found." text-only
// page. Server Component (no props per Next.js 16 not-found convention). Renders
// inside (app) layout, so the mobile bottom tab bar and drawer remain available
// for recovery alongside these CTAs. Copy is shared with the root boundary
// (src/app/not-found.tsx) via NOT_FOUND_COPY — the two catch different cases
// but must read identically.
export default function NotFound() {
  return (
    <StatePage
      glyph="404"
      title={NOT_FOUND_COPY.title}
      description={NOT_FOUND_COPY.description}
      primary={{ label: "Go home", href: "/", icon: <Home className="w-4 h-4" /> }}
      secondary={[
        { label: "Browse movies", href: "/movies", icon: <Film className="w-4 h-4" /> },
        { label: "Browse TV", href: "/tv", icon: <Tv className="w-4 h-4" /> },
      ]}
    />
  );
}
