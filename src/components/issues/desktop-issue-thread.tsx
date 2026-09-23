"use client";

import { IssueThread } from "@/components/issues/issue-thread";
import { useMediaQuery } from "@/hooks/use-media-query";

// The desktop issue pane on /issues is only hidden with CSS below the `xl`
// width, so a plain <IssueThread> there would still mount on phones/tablets and
// fetch messages + listen for live events a second time, next to the mobile
// drawer's own thread. So we only mount it at 1280px and wider — the exact
// opposite of the drawer's `(max-width: 1279.98px)` check in
// issue-detail-mobile-drawer.tsx — and exactly one thread exists per screen.
// `null` means "not measured yet" (server render / hydration): render nothing
// so the server HTML and the first browser render match (guardrail 16).
export function DesktopIssueThread({ issueId }: { issueId: string }) {
  const isDesktop = useMediaQuery("(min-width: 1280px)");
  if (isDesktop !== true) return null;
  return <IssueThread issueId={issueId} variant="panel" />;
}
