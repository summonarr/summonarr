"use client";

import { IssueThread } from "@/components/issues/issue-thread";
import { useMediaQuery } from "@/hooks/use-media-query";

// The desktop issue pane on /issues is hidden below `xl` with CSS only, so a
// bare <IssueThread> there still MOUNTED on phones/tablets — fetching the
// messages and subscribing to SSE alongside the mobile drawer's own thread
// (2x GET /api/issues/[id]/messages, 2x silent refetch per issuemessage:created).
// Gate the mount on the same breakpoint the drawer's gate is the complement of
// (`(max-width: 1279.98px)` in issue-detail-mobile-drawer.tsx) so exactly one
// thread exists per viewport. `null` (SSR/hydration) renders nothing so the
// server HTML and the first client render agree (guardrail 16).
export function DesktopIssueThread({ issueId }: { issueId: string }) {
  const isDesktop = useMediaQuery("(min-width: 1280px)");
  if (isDesktop !== true) return null;
  return <IssueThread issueId={issueId} variant="panel" />;
}
