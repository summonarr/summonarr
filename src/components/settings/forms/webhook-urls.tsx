"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { fetchJson } from "@/lib/client/fetch-json";
import { v } from "@/lib/validate";
import { Copy, Check, Loader2, X } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { useT } from "@/components/i18n/i18n-provider";

// What a copy click resolved to: the URL, no secret saved for that row (nothing
// to copy until one is set — retrying can't help), or a failed token fetch.
type CopyResolution = { kind: "url"; url: string } | { kind: "none" } | { kind: "error" };

function CopyRow({
  label,
  displayUrl,
  resolveCopyUrl,
}: {
  label: string;
  displayUrl: string;
  // Called on every click: the value carries a secret token, fetched on demand
  // rather than baked into props.
  resolveCopyUrl: () => Promise<CopyResolution>;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [problem, setProblem] = useState<"none" | "error" | null>(null);
  // True while the token fetch is in flight: shows a spinner and blocks repeat
  // clicks, each of which would otherwise fire another token fetch.
  const [pending, setPending] = useState(false);
  // The "copied" tick's and the error line's fades. Ref'd so a new click
  // cancels the previous click's timers (which would otherwise clear the new
  // result early); cleared on unmount.
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const problemTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    if (problemTimer.current) clearTimeout(problemTimer.current);
  }, []);

  async function copy() {
    if (pending) return;
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    if (problemTimer.current) clearTimeout(problemTimer.current);
    setCopied(false);
    setProblem(null);
    setRevealed(null);
    setPending(true);
    let result: CopyResolution;
    try {
      result = await resolveCopyUrl();
    } catch {
      // A resolver that throws is a failed fetch, never an unhandled rejection.
      result = { kind: "error" };
    } finally {
      setPending(false);
    }
    if (result.kind !== "url") {
      setProblem(result.kind);
      // A missing secret stays explained until the next click; a failed fetch
      // is worth a retry, so its line fades.
      if (result.kind === "error") problemTimer.current = setTimeout(() => setProblem(null), 2500);
      return;
    }
    try {
      await navigator.clipboard.writeText(result.url);
      setCopied(true);
      copiedTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (e.g. write-after-await loses the user gesture on some
      // browsers) — show the URL in a selectable field, whole (a truncated span
      // hid the token behind the ellipsis), until dismissed or the next click.
      setRevealed(result.url);
    }
  }

  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-zinc-400">{label}</p>
      <div className="flex items-center gap-2 rounded-md bg-zinc-800 border border-zinc-700 px-3 py-2">
        {revealed === null ? (
          <span className="flex-1 font-mono text-xs text-zinc-300 truncate">{displayUrl}</span>
        ) : (
          <input
            readOnly
            autoFocus
            value={revealed}
            onFocus={(e) => e.currentTarget.select()}
            aria-label={label}
            spellCheck={false}
            className="flex-1 min-w-0 bg-transparent font-mono text-xs text-zinc-100 outline-none"
          />
        )}
        {revealed !== null && (
          <button
            type="button"
            onClick={() => setRevealed(null)}
            className="shrink-0 p-3 -m-3 text-zinc-500 hover:text-zinc-100 transition-colors"
            aria-label={t("shared.common.dismiss")}
          >
            <X className="w-4 h-4" />
          </button>
        )}
        <button
          type="button"
          onClick={copy}
          disabled={pending}
          aria-busy={pending || undefined}
          className="shrink-0 p-3 -m-3 text-zinc-500 hover:text-zinc-100 transition-colors disabled:opacity-50"
          aria-label={t("settings.form.webhookUrls.copyLabel", { label })}
        >
          {pending
            ? <Loader2 className="w-4 h-4 animate-spin" />
            : copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
        </button>
      </div>
      {revealed !== null && <p className="text-xs text-zinc-500">{t("settings.form.webhookUrls.copyManually")}</p>}
      {problem === "error" && <p className="text-xs text-amber-500">{t("settings.form.webhookUrls.loadFailed")}</p>}
      {problem === "none" && <p className="text-xs text-amber-500">{t("settings.form.webhookUrls.noSecret")}</p>}
    </div>
  );
}

// Placeholder row for a URL with no webhook secret yet: an HD row whose service
// has neither its own nor the legacy secret, or a configured 4K instance
// without its own. There is nothing to copy until one is saved.
//
// About the URLs below: the token rides in a ?token= query param because the Radarr/Sonarr
// webhook screens have no field for custom headers (guardrail 2). The default rows use the
// per-service secret and fall back to the legacy shared one, the same way the webhook handler
// does. The 4K rows point at the SAME endpoint with the 4K instance's own secret; the handler
// works out which instance fired by which secret matched (guardrail 32).
// GET /api/settings/webhook-urls: each row's token, or null when it has none.
const WEBHOOK_TOKENS = v.record(v.nullable(v.string()));

function SecretNeededRow({ label, message }: { label: string; message: string }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-zinc-400">{label}</p>
      <div className="flex items-center gap-2 rounded-md bg-zinc-800 border border-zinc-700 px-3 py-2">
        <span className="flex-1 text-xs text-amber-500">{message}</span>
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
  const t = useT();
  const radarrBase = `${baseUrl}/api/webhooks/radarr`;
  const sonarrBase = `${baseUrl}/api/webhooks/sonarr`;

  // Fetch the actual tokens on every copy click. Admin-only endpoint; responses
  // are `private, no-store`. Returns { radarr, sonarr, radarr4k, sonarr4k }
  // where radarr/sonarr already fold in the legacy shared secret server-side.
  // Do NOT cache these across clicks: the secret form above router.refresh()es
  // after a save so the flags here follow it, but a rotation from another tab
  // or admin never reaches this component, and a cached token would survive it
  // — the copied URL would carry a value the webhook handler now rejects.
  const resolver = useCallback(
    (key: string, base: string) => async (): Promise<CopyResolution> => {
      const res = await fetchJson(withBasePath("/api/settings/webhook-urls"), { schema: WEBHOOK_TOKENS });
      if (!res.ok) return { kind: "error" };
      const tok = res.data[key];
      // null: no secret saved for this row (removed since the page rendered).
      return typeof tok === "string" && tok ? { kind: "url", url: `${base}?token=${encodeURIComponent(tok)}` } : { kind: "none" };
    },
    [],
  );

  const masked = (base: string) => `${base}?token=••••••••`;
  const radarrTokenSet = radarrHasSecret || legacyHasSecret;
  const sonarrTokenSet = sonarrHasSecret || legacyHasSecret;
  const noHdSecret = !radarrTokenSet && !sonarrTokenSet;
  const label = (service: string) => t("settings.form.webhookUrls.label", { service });

  return (
    <div className="space-y-4">
      {radarrTokenSet
        ? <CopyRow label={label("Radarr")} displayUrl={masked(radarrBase)} resolveCopyUrl={resolver("radarr", radarrBase)} />
        : <SecretNeededRow label={label("Radarr")} message={t("settings.form.webhookUrls.secretNeededFor", { service: "Radarr" })} />}
      {sonarrTokenSet
        ? <CopyRow label={label("Sonarr")} displayUrl={masked(sonarrBase)} resolveCopyUrl={resolver("sonarr", sonarrBase)} />
        : <SecretNeededRow label={label("Sonarr")} message={t("settings.form.webhookUrls.secretNeededFor", { service: "Sonarr" })} />}
      {radarr4kConfigured && (
        radarr4kHasSecret
          ? <CopyRow label={label("Radarr 4K")} displayUrl={masked(radarrBase)} resolveCopyUrl={resolver("radarr4k", radarrBase)} />
          : <SecretNeededRow label={label("Radarr 4K")} message={t("settings.form.webhookUrls.secretNeeded")} />
      )}
      {sonarr4kConfigured && (
        sonarr4kHasSecret
          ? <CopyRow label={label("Sonarr 4K")} displayUrl={masked(sonarrBase)} resolveCopyUrl={resolver("sonarr4k", sonarrBase)} />
          : <SecretNeededRow label={label("Sonarr 4K")} message={t("settings.form.webhookUrls.secretNeeded")} />
      )}
      {noHdSecret && (
        <p className="text-xs text-amber-500">
          {t("settings.form.webhookUrls.noSecret")}
        </p>
      )}
      <p className="text-xs text-zinc-500">
        {t("settings.form.webhookUrls.help")}
      </p>
    </div>
  );
}
