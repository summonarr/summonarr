"use client";

// Radarr/Sonarr health, per configured instance, plus the one-click webhook
// setup. Two shapes of the same data (GET /api/admin/arr-health):
//   "full"     — Admin → Download Queue: version, Radarr/Sonarr's own health
//                checks, and the webhook verdict with Set up / Repair.
//   "webhooks" — Settings → Webhooks: only the webhook verdict and the button.
// The webhook token never reaches the browser — the server builds the URL it
// hands to Radarr/Sonarr (POST /api/admin/arr-health/webhook). Nothing here
// reads the clock while rendering (guardrail 16).

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Chip, type ChipTone } from "@/components/ui/design";
import { AlertTriangle, CheckCircle2, ExternalLink, Link, Loader2, RefreshCw, XCircle } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { useT } from "@/components/i18n/i18n-provider";
import type { ArrHealthCheck, WebhookState } from "@/lib/arr-health";

type Service = "radarr" | "sonarr";

interface InstanceHealth {
  service: Service;
  slug: string;
  name: string;
  reachable: boolean;
  error: string | null;
  version: string | null;
  checks: ArrHealthCheck[];
  webhook: { state: WebhookState | "unknown"; missingEvents: string[] };
}

interface HealthReport {
  instances: InstanceHealth[];
  webhookBase: string | null;
}

type SetupState = { busy: boolean; message: string; error: string; detail: string | null };

const SERVICE_LABEL: Record<Service, string> = { radarr: "Radarr", sonarr: "Sonarr" };
const key = (i: { service: Service; slug: string }) => `${i.service}:${i.slug}`;

const WEBHOOK_TONE: Record<WebhookState | "unknown", ChipTone> = {
  ok: "approved",
  missing: "declined",
  tokenMismatch: "declined",
  eventsMissing: "pending",
  unknown: "neutral",
};

const LEVEL_TONE: Record<ArrHealthCheck["level"], ChipTone> = { error: "declined", warning: "pending", notice: "neutral" };

async function readJson<T>(res: Response): Promise<T | null> {
  return (await res.json().catch(() => null)) as T | null;
}

export function ArrHealthPanel({ variant }: { variant: "full" | "webhooks" }) {
  const t = useT();
  const [report, setReport] = useState<HealthReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [openSetup, setOpenSetup] = useState<string | null>(null);
  const [base, setBase] = useState("");
  const [setup, setSetup] = useState<Record<string, SetupState>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const res = await fetch(withBasePath("/api/admin/arr-health"));
      const data = await readJson<HealthReport & { error?: string }>(res);
      if (!res.ok || !data) {
        setLoadError(data?.error ?? t("adminManage.arrHealth.loadError"));
        return;
      }
      setReport(data);
      setBase((cur) => cur || data.webhookBase || "");
    } catch {
      setLoadError(t("adminManage.arrHealth.loadError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function runSetup(inst: InstanceHealth) {
    const k = key(inst);
    setSetup((m) => ({ ...m, [k]: { busy: true, message: "", error: "", detail: null } }));
    try {
      const res = await fetch(withBasePath("/api/admin/arr-health/webhook"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: inst.service, instance: inst.slug, baseUrl: base.trim() }),
      });
      const data = await readJson<{ outcome?: string; secretGenerated?: boolean; error?: string; detail?: string | null }>(res);
      if (!res.ok || !data?.outcome) {
        setSetup((m) => ({
          ...m,
          [k]: { busy: false, message: "", error: data?.error ?? t("adminManage.arrHealth.setupFailed"), detail: data?.detail ?? null },
        }));
        return;
      }
      const message =
        data.outcome === "created"
          ? t("adminManage.arrHealth.setupCreated", { service: SERVICE_LABEL[inst.service] })
          : data.outcome === "updated"
            ? t("adminManage.arrHealth.setupUpdated", { service: SERVICE_LABEL[inst.service] })
            : t("adminManage.arrHealth.setupUnchanged");
      setSetup((m) => ({ ...m, [k]: { busy: false, message, error: "", detail: null } }));
      setOpenSetup(null);
      void load();
    } catch {
      setSetup((m) => ({ ...m, [k]: { busy: false, message: "", error: t("adminManage.arrHealth.setupFailed"), detail: null } }));
    }
  }

  const instances = report?.instances ?? [];
  const header = (
    <div className="flex items-center gap-2 flex-wrap">
      <p className="m-0 text-sm font-medium text-zinc-300">
        {variant === "full" ? t("adminManage.arrHealth.title") : t("adminManage.arrHealth.webhooksTitle")}
      </p>
      <div className="flex-1" />
      <Button size="xs" variant="ghost" onClick={() => void load()} disabled={loading} className="text-zinc-500 hover:text-zinc-100">
        {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        {t("adminManage.arrHealth.refresh")}
      </Button>
    </div>
  );

  let body: React.ReactNode;
  if (!report) {
    body = loadError ? (
      <p role="alert" className="m-0 text-sm" style={{ color: "var(--ds-danger)" }}>{loadError}</p>
    ) : (
      <div className="flex items-center gap-2 text-zinc-500" style={{ fontSize: 13 }}>
        <Loader2 className="animate-spin" style={{ width: 14, height: 14 }} /> {t("adminManage.arrHealth.loading")}
      </div>
    );
  } else if (instances.length === 0) {
    body = <p className="m-0 text-sm text-zinc-500">{t("adminManage.arrHealth.none")}</p>;
  } else {
    body = (
      <div className="flex flex-col gap-3">
        {loadError && <p role="alert" className="m-0 text-xs" style={{ color: "var(--ds-danger)" }}>{loadError}</p>}
        {instances.map((inst) => {
          const k = key(inst);
          const st = setup[k];
          const label = inst.slug === "" ? SERVICE_LABEL[inst.service] : `${SERVICE_LABEL[inst.service]} (${inst.name || inst.slug})`;
          const wh = inst.webhook.state;
          const needsSetup = inst.reachable && (wh === "missing" || wh === "tokenMismatch" || wh === "eventsMissing");
          return (
            <div
              key={k}
              className="flex flex-col gap-2"
              style={{ padding: 12, border: "1px solid var(--ds-border)", borderRadius: 8, background: "var(--ds-bg-2)" }}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-zinc-100" style={{ fontSize: 13 }}>{label}</span>
                {inst.version && <span className="ds-mono text-zinc-500" style={{ fontSize: 11 }}>v{inst.version}</span>}
                {!inst.reachable && (
                  <Chip tone="declined">
                    <XCircle style={{ width: 11, height: 11 }} aria-hidden /> {t("adminManage.arrHealth.unreachable")}
                  </Chip>
                )}
                {variant === "full" && inst.reachable && inst.checks.length === 0 && !inst.error && (
                  <Chip tone="approved">
                    <CheckCircle2 style={{ width: 11, height: 11 }} aria-hidden /> {t("adminManage.arrHealth.allPassing")}
                  </Chip>
                )}
                <div className="flex-1" />
                <Chip tone={WEBHOOK_TONE[wh]} title={t("adminManage.arrHealth.webhookHint")}>
                  <Link style={{ width: 11, height: 11 }} aria-hidden /> {t(`adminManage.arrHealth.webhook.${wh}`)}
                </Chip>
                {needsSetup && openSetup !== k && (
                  <Button size="xs" variant="outline" onClick={() => setOpenSetup(k)}>
                    {wh === "missing" ? t("adminManage.arrHealth.setup") : t("adminManage.arrHealth.repair")}
                  </Button>
                )}
              </div>

              {inst.error && (
                <p className="m-0 text-xs" style={{ color: inst.reachable ? "var(--ds-fg-subtle)" : "var(--ds-danger)" }}>{inst.error}</p>
              )}

              {wh === "eventsMissing" && inst.webhook.missingEvents.length > 0 && (
                <p className="m-0 text-xs text-zinc-500">
                  {t("adminManage.arrHealth.missingEvents", {
                    list: inst.webhook.missingEvents.map((e) => t(`adminManage.arrHealth.event.${e}`)).join(", "),
                  })}
                </p>
              )}

              {variant === "full" && inst.checks.length > 0 && (
                <ul className="m-0 p-0 flex flex-col gap-1.5" style={{ listStyle: "none" }} aria-label={t("adminManage.arrHealth.checksLabel", { name: label })}>
                  {inst.checks.map((c, i) => (
                    <li key={`${c.source}:${i}`} className="flex items-start gap-2" style={{ fontSize: 12 }}>
                      <Chip tone={LEVEL_TONE[c.level]} className="shrink-0">{t(`adminManage.arrHealth.level.${c.level}`)}</Chip>
                      <span className="text-zinc-300 min-w-0" style={{ overflowWrap: "anywhere" }}>{c.message}</span>
                      {c.wikiUrl && (
                        <a
                          href={c.wikiUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="shrink-0 text-zinc-500 hover:text-zinc-100"
                          aria-label={t("adminManage.arrHealth.wiki")}
                          title={t("adminManage.arrHealth.wiki")}
                        >
                          <ExternalLink style={{ width: 12, height: 12 }} aria-hidden />
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {openSetup === k && (
                <form
                  className="flex flex-col gap-2"
                  style={{ borderTop: "1px solid var(--ds-border)", paddingTop: 10 }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void runSetup(inst);
                  }}
                >
                  <Label htmlFor={`webhook-base-${k}`}>{t("adminManage.arrHealth.baseLabel", { service: SERVICE_LABEL[inst.service] })}</Label>
                  <Input
                    id={`webhook-base-${k}`}
                    type="url"
                    value={base}
                    onChange={(e) => setBase(e.target.value.slice(0, 2000))}
                    placeholder="http://summonarr:3000"
                    className="font-mono"
                  />
                  <p className="m-0 text-xs text-zinc-500">{t("adminManage.arrHealth.baseHelp", { service: SERVICE_LABEL[inst.service] })}</p>
                  <div className="flex items-center gap-2">
                    <Button type="submit" size="sm" disabled={st?.busy || !base.trim()}>
                      {st?.busy ? <Loader2 className="animate-spin" /> : <Link />}
                      {wh === "missing" ? t("adminManage.arrHealth.setupSubmit") : t("adminManage.arrHealth.repairSubmit")}
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setOpenSetup(null)} disabled={st?.busy}>
                      {t("shared.common.cancel")}
                    </Button>
                  </div>
                </form>
              )}

              {st?.message && (
                <p role="status" className="m-0 text-xs flex items-center gap-1 text-green-400">
                  <CheckCircle2 style={{ width: 12, height: 12 }} aria-hidden /> {st.message}
                </p>
              )}
              {st?.error && (
                <div role="alert" className="text-xs flex flex-col gap-0.5" style={{ color: "var(--ds-danger)" }}>
                  <span className="flex items-center gap-1">
                    <AlertTriangle style={{ width: 12, height: 12 }} aria-hidden /> {st.error}
                  </span>
                  {st.detail && <span className="text-zinc-400" style={{ overflowWrap: "anywhere" }}>{st.detail}</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {header}
      {body}
    </div>
  );
}
