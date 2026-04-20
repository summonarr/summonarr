

// OIDC sign-in redirects through the provider, so the UA fingerprint cannot be captured in authorize().
// Instead, the authorized() callback deposits the fingerprint here, and the next jwt() callback consumes it.
interface Entry { value: string; expiresAt: number; }

const pending = new Map<string, Entry>();
// 10-minute TTL gives plenty of time for the first authenticated request after the OAuth redirect
const TTL = 10 * 60 * 1000;

export function setPendingFingerprint(sessionId: string, fingerprint: string): void {
  pending.set(sessionId, { value: fingerprint, expiresAt: Date.now() + TTL });
}

// Consume is destructive — the fingerprint is removed immediately to prevent reuse across jwt() invocations
export function consumePendingFingerprint(sessionId: string): string | undefined {
  const entry = pending.get(sessionId);
  pending.delete(sessionId);
  return entry && entry.expiresAt > Date.now() ? entry.value : undefined;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, e] of pending) if (e.expiresAt < now) pending.delete(k);
}, 60_000).unref();
