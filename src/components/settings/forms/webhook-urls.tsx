"use client";

import { useState, useCallback, useRef } from "react";
import { Copy, Check } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";

function CopyRow({
  label,
  displayUrl,
  copyUrl,
  resolveCopyUrl,
}: {
  label: string;
  displayUrl: string;
  // Static value to copy. Optional when resolveCopyUrl is provided.
  copyUrl?: string;
  // Async resolver, called on click — used when the value (e.g. a secret token)
  // must be fetched on demand rather than baked into props.
  resolveCopyUrl?: () => Promise<string | null>;
}) {
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  async function copy() {
    setFailed(false);
    const url = resolveCopyUrl ? await resolveCopyUrl() : (copyUrl ?? null);
    if (!url) {
      setFailed(true);
      setTimeout(() => setFailed(false), 2500);
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (e.g. write-after-await loses the user gesture on some
      // browsers) — reveal the URL so it can be selected and copied manually.
      setRevealed(url);
      setTimeout(() => setRevealed(null), 10000);
    }
  }

  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-zinc-400">{label}</p>
      <div className="flex items-center gap-2 rounded-md bg-zinc-800 border border-zinc-700 px-3 py-2">
        <span className="flex-1 font-mono text-xs text-zinc-300 truncate">{revealed ?? displayUrl}</span>
        <button onClick={copy} className="shrink-0 text-zinc-500 hover:text-white transition-colors" aria-label="Copy">
          {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
        </button>
      </div>
      {failed && <p className="text-xs text-amber-500">Couldn’t load the token — try again.</p>}
    </div>
  );
}

// The ?token= query param is the only auth option because Radarr/Sonarr webhook UIs have no header field.
// HD rows prefer the per-source secret and fall back to the legacy shared secret (matching how the
// webhook handler resolves tokens). The 4K rows point at the SAME endpoint with the 4K instance's own
// secret — the handler uses secret-as-discriminator to set is4k — and only appear once that secret is set.
function SecretNeededRow({ label }: { label: string }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-zinc-400">{label}</p>
      <div className="flex items-center gap-2 rounded-md bg-zinc-800 border border-zinc-700 px-3 py-2">
        <span className="flex-1 text-xs text-amber-500">Set the 4K webhook secret above to generate this URL.</span>
      </div>
    </div>
  );
}

export function WebhookUrls({
  baseUrl,
  radarrHasSecret,
  sonarrHasSecret,
  radarr4kHasSecret,
  sonarr4kHasSecret,
  radarr4kConfigured,
  sonarr4kConfigured,
  legacyHasSecret,
}: {
  baseUrl: string;
  // Whether each token EXISTS — booleans only. The token values themselves are
  // never sent in the page payload; they're fetched on demand from
  // /api/settings/webhook-urls when the admin clicks "copy" (see below), so the
  // secrets don't sit passively in the rendered HTML / RSC flight data.
  radarrHasSecret?: boolean;
  sonarrHasSecret?: boolean;
  radarr4kHasSecret?: boolean;
  sonarr4kHasSecret?: boolean;
  // The 4K rows appear once a 4K instance is configured (URL + API key) — same trigger as the HD
  // rows — not only once the 4K webhook secret is saved.
  radarr4kConfigured?: boolean;
  sonarr4kConfigured?: boolean;
  legacyHasSecret?: boolean;
}) {
  const radarrBase = `${baseUrl}/api/webhooks/radarr`;
  const sonarrBase = `${baseUrl}/api/webhooks/sonarr`;

  // Fetch the actual tokens only on the first copy click, then cache them in a
  // ref for the rest of the session. Admin-only endpoint; responses are
  // `private, no-store`. Returns { radarr, sonarr, radarr4k, sonarr4k } where
  // radarr/sonarr already fold in the legacy shared secret server-side.
  const tokensRef = useRef<Record<string, string | null> | null>(null);
  const loadTokens = useCallback(async (): Promise<Record<string, string | null>> => {
    if (tokensRef.current) return tokensRef.current;
    const res = await fetch(withBasePath("/api/settings/webhook-urls"));
    if (!res.ok) throw new Error("failed to load webhook tokens");
    const data = (await res.json()) as Record<string, string | null>;
    tokensRef.current = data;
    return data;
  }, []);
  const resolver = useCallback(
    (key: string, base: string) => async (): Promise<string | null> => {
      try {
        const tok = (await loadTokens())[key];
        return tok ? `${base}?token=${encodeURIComponent(tok)}` : null;
      } catch {
        return null;
      }
    },
    [loadTokens],
  );

  const maskSuffix = (has?: boolean) => (has ? "?token=••••••••" : "");
  const radarrTokenSet = radarrHasSecret || legacyHasSecret;
  const sonarrTokenSet = sonarrHasSecret || legacyHasSecret;
  const noHdSecret = !radarrTokenSet && !sonarrTokenSet;

  return (
    <div className="space-y-4">
      <CopyRow label="Radarr webhook URL" displayUrl={`${radarrBase}${maskSuffix(radarrTokenSet)}`} resolveCopyUrl={resolver("radarr", radarrBase)} />
      <CopyRow label="Sonarr webhook URL" displayUrl={`${sonarrBase}${maskSuffix(sonarrTokenSet)}`} resolveCopyUrl={resolver("sonarr", sonarrBase)} />
      {radarr4kConfigured && (
        radarr4kHasSecret
          ? <CopyRow label="Radarr 4K webhook URL" displayUrl={`${radarrBase}?token=••••••••`} resolveCopyUrl={resolver("radarr4k", radarrBase)} />
          : <SecretNeededRow label="Radarr 4K webhook URL" />
      )}
      {sonarr4kConfigured && (
        sonarr4kHasSecret
          ? <CopyRow label="Sonarr 4K webhook URL" displayUrl={`${sonarrBase}?token=••••••••`} resolveCopyUrl={resolver("sonarr4k", sonarrBase)} />
          : <SecretNeededRow label="Sonarr 4K webhook URL" />
      )}
      {noHdSecret && (
        <p className="text-xs text-amber-500">
          No secret token set — webhook endpoints are unauthenticated. Set a token above.
        </p>
      )}
      <p className="text-xs text-zinc-600">
        In Radarr/Sonarr: Settings → Connect → + → Webhook · Method: POST · Events: On Import + On Manual Interaction Required · Use the URLs above (token is included). 4K rows point at the same endpoint with the 4K instance&apos;s own token.
      </p>
    </div>
  );
}
