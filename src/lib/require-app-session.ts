import "server-only";
import { redirect } from "next/navigation";
import { authActive } from "@/lib/auth";
import type { SummonarrSession } from "@/lib/api-auth";

// DB-checked login gate for every (app) server-component PAGE.
//
// Why this exists AT THE PAGE LEVEL and not only in (app)/layout.tsx:
// Next.js skips a layout's render when the client supplies a Next-Router-State-Tree
// whose segment matches that level (the soft-navigation optimization — see
// node_modules/next/dist/server/app-render/walk-tree-with-flight-router-state.js:
// when `renderComponentsOnThisLevel` is false the level's createComponentTree is
// NOT called, only CSS/JS tags are collected and it recurses into children). The
// flight tree is client-supplied and only schema-validated (no signature), and
// proxy.ts's matcher separately skips any request carrying `purpose: prefetch`.
// Composing the two, an UNAUTHENTICATED request —
//   GET /votes  -H 'RSC: 1' -H 'purpose: prefetch'
//               -H 'Next-Router-State-Tree: ["",{"children":["(app)",{"children":["requests",…]}]}]'
// skips the proxy AND makes Next match "" and "(app)" (so the layout's authActive()
// gate never runs) while the target page's segment mismatches, forcing a full render
// of THAT page. Because the exploit can only skip the layout by matching down to the
// (app) segment and mismatching at the page, the page's own createComponentTree is
// always invoked — so a gate placed here always executes in exactly the scenario
// where the layout's gate was skipped. This is the guardrail-29 "verify close to the
// data, not the proxy/parent-layout alone" rule applied to the whole (app) subtree.
//
// authActive() is DB-checked (honors AuthSession revocation, sessionsRevokedAt /
// passwordChangedAt cutoffs, role demotion, and the UA-fingerprint binding), and is
// cheap on the hot path: a normal navigation already ran the layout's authActive(),
// so the dbCheckedAt fast-path in verifyAndRefreshSession skips the DB round-trip
// here. Returns the session for personalization reuse so callers need no second read.
//
// NOTE: the returned redirect() throws NEXT_REDIRECT — never wrap the call in a
// try/catch that swallows it.
export async function requireAppSession(): Promise<SummonarrSession> {
  const session = await authActive();
  if (!session) redirect("/login");
  return session;
}
