// The statuses a reverse proxy or gateway answers with when the app behind it
// didn't (or took too long): 502 Bad Gateway, 503 Service Unavailable, 504
// Gateway Timeout. Pure and zero-import, so browser and server code share it.
// Whether such an answer is the app's own still depends on its body: callers
// pair this with "is it the route's JSON".
export const GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

export function isGatewayStatus(status: number): boolean {
  return GATEWAY_STATUSES.has(status);
}
