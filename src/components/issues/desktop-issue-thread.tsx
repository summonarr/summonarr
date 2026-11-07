"use client";

import { IssueThread } from "@/components/issues/issue-thread";
import { useMediaQuery } from "@/hooks/use-media-query";

// The desktop issue pane (/issues, /admin/issues) is only hidden with CSS below
// the `xl` width, so a plain <IssueThread> there would still mount on
// phones/tablets and fetch messages + listen for live events a second time,
// next to the below-xl thread (the /issues drawer, an admin issue card). So we
// only mount it at 1280px and wider — the exact opposite of the
// `(max-width: 1279.98px)` check below and in issue-detail-mobile-drawer.tsx —
// and exactly one thread exists per screen.
// `null` means "not measured yet" (server render / hydration): render nothing
// so the server HTML and the first browser render match (guardrail 16).
export function DesktopIssueThread({ issueId }: { issueId: string }) {
  const isDesktop = useMediaQuery("(min-width: 1280px)");
  if (isDesktop !== true) return null;
  return <IssueThread key={issueId} issueId={issueId} variant="panel" />;
}

// The below-xl twin: the inline thread of an admin issue card or of a selected
// issue the list doesn't show, which CSS alone hides beside the xl pane.
export function MobileIssueThread({ issueId }: { issueId: string }) {
  const isMobile = useMediaQuery("(max-width: 1279.98px)") === true;
  if (!isMobile) return null;
  return <IssueThread key={issueId} issueId={issueId} />;
}
