import { NextResponse } from "next/server";
import { API_VERSION, MIN_API_VERSION, MIN_CLIENT } from "@/lib/api-version";

// Public, unauthenticated compatibility descriptor. A native client fetches this
// BEFORE sign-in to decide whether it can talk to this server at all — and
// before sending its Keychain session token to an incompatible/hostile server.
//
// Intentionally COARSE: integers only. No marketing version, no secrets, no
// server URL — so an unauthenticated scanner learns the API contract level but
// not a precise version string to map to CVEs (defense-in-depth; the login page
// already leaks hints, so this is not treated as a secret). DB-free, so it
// cannot be used as a load amplifier. Exposed pre-auth via isPublicPath in
// src/proxy.ts.
export function GET() {
  return NextResponse.json({
    apiVersion: API_VERSION,
    minApiVersion: MIN_API_VERSION,
    minClient: MIN_CLIENT,
  });
}
