"use client";

// Radarr/Sonarr health, per configured instance, plus the one-click webhook
// setup. Two shapes of the same data (GET /api/admin/arr-health):
//   "full"     — Admin → Download Queue: version, Radarr/Sonarr's own health
//                checks, and the webhook verdict with Set up / Repair.
//   "webhooks" — Settings → Webhooks: only the webhook verdict and the button.
// The webhook token never reaches the browser — the server builds the URL it
// hands to Radarr/Sonarr (POST /api/admin/arr-health/webhook). Nothing here
// reads the clock while rendering (guardrail 16).
//
// Instant, then live (use-arr-snapshot.ts): on open the last report the server
// kept paints at once, marked with when it was read, while the live read is
// out; the live answer replaces it. Setup always goes to the server, which
// re-reads the instance.
//
// Every call goes through arr-call.ts: a timeout (a stuck proxy can't hold the
// spinner or the setup form forever) and a shape check on the answer, the
// painted snapshot's included.

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Chip, type ChipTone } from "@/components/ui/design";
import { AlertTriangle, CheckCircle2, ExternalLink, LinkIcon, Loader2, RefreshCw, XCircle } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { useT } from "@/components/i18n/i18n-provider";
import type { ArrHealthCheck, WebhookState } from "@/lib/arr-health";
import { ARR_ERROR_KIND_KEYS, isArrErrorKind } from "@/lib/arr-error-kind";
import { arrCall } from "@/lib/client/arr-call";
import { HEALTH_REPORT, WEBHOOK_SETUP, type HealthReport, type InstanceHealth } from "@/lib/client/arr-answers";
import { check } from "@/lib/validate";
import { useAsyncAction } from "@/hooks/use-async-action";
import { useArrSnapshot } from "@/components/admin/use-arr-snapshot";
import { ArrSnapshotNote } from "@/components/admin/arr-snapshot-note";
import { arrInstanceKey, SERVICE_LABEL } from "@/components/admin/arr-title/shared";

/** What the last setup of an instance said. Its in-flight state is the `setup:<key>` action. */
type SetupState = { message: string; error: string; detail: string | null };

const WEBHOOK_TONE: Record<WebhookState | "unknown", ChipTone> = {
  ok: "approved",
  missing: "declined",
  tokenMismatch: "declined",
  eventsMissing: "pending",
  unknown: "neutral",
};

const LEVEL_TONE: Record<ArrHealthCheck["level"], ChipTone> = { error: "declined", warning: "pending", notice: "neutral" };

// The panel's one read. The live load and its snapshot must name the SAME url,
// or the server's snapshot key misses.
const healthUrl = () => withBasePath("/api/admin/arr-health");

export function ArrHealthPanel({ variant }: { variant: "full" | "webhooks" }) {
  const t = useT();
  const [report, setReport] = useState<HealthReport | null>(null);
  const [loadError, setLoadError] = useState("");
  const [openSetup, setOpenSetup] = useState<string | null>(null);
  const [base, setBase] = useState("");
  const [setup, setSetup] = useState<Record<string, SetupState>>({});
  // The load (key "load": a newer one aborts the one before, so an older
  // answer can't put back the report a setup just changed) and each
  // instance's setup (key "setup:<instance>").
  const action = useAsyncAction();
  const loading = action.busy("load");
  // The snapshot only paints an EMPTY panel: it never replaces a report already
  // on screen, and leaves the load error and any open setup form alone.
  const { staleAt: snapshotAt, markLive } = useArrSnapshot<unknown>(healthUrl(), (data) => {
    const parsed = check(HEALTH_REPORT, data);
    if (!parsed.ok || report !== null) return false;
    setReport(parsed.value);
    setBase((cur) => cur || parsed.value.webhookBase || "");
    return true;
  });

  const load = useCallback(async () => {
    setLoadError("");
    const res = await action.run("load", (signal) =>
      arrCall(healthUrl(), { schema: HEALTH_REPORT, signal, fallback: t("adminManage.arrHealth.loadError") }),
    );
    // Superseded by a newer load, or unmounted: that one writes.
    if (!res) return;
    if (!res.ok) {
      setLoadError(res.error);
      return;
    }
    setReport(res.data);
    setBase((cur) => cur || res.data.webhookBase || "");
    markLive();
  }, [action, t, markLive]);

  useEffect(() => {
    void load();
  }, [load]);

  async function runSetup(inst: InstanceHealth) {
    const k = arrInstanceKey(inst);
    setSetup((m) => ({ ...m, [k]: { message: "", error: "", detail: null } }));
    const res = await action.run(
      `setup:${k}`,
      (signal) =>
        arrCall(withBasePath("/api/admin/arr-health/webhook"), {
          method: "POST",
          body: { service: inst.service, instance: inst.slug, baseUrl: base.trim() },
          schema: WEBHOOK_SETUP,
          signal,
          fallback: t("adminManage.arrHealth.setupFailed"),
        }),
      { ifBusy: "skip" },
    );
    if (!res) return;
    if (!res.ok) {
      const detail = typeof res.body?.detail === "string" ? res.body.detail : null;
      setSetup((m) => ({ ...m, [k]: { message: "", error: res.error, detail } }));
      return;
    }
    const message =
      res.data.outcome === "created"
        ? t("adminManage.arrHealth.setupCreated", { service: SERVICE_LABEL[inst.service] })
        : res.data.outcome === "updated"
          ? t("adminManage.arrHealth.setupUpdated", { service: SERVICE_LABEL[inst.service] })
          : t("adminManage.arrHealth.setupUnchanged");
    setSetup((m) => ({ ...m, [k]: { message, error: "", detail: null } }));
    // Only this instance's form closes: one opened for another instance meanwhile stays.
    setOpenSetup((cur) => (cur === k ? null : cur));
    void load();
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
          const k = arrInstanceKey(inst);
          return (
            <InstanceHealthCard
              key={k}
              inst={inst}
              variant={variant}
              setup={setup[k]}
              setupBusy={action.busy(`setup:${k}`)}
              formOpen={openSetup === k}
              base={base}
              onBaseChange={setBase}
              onOpenForm={() => setOpenSetup(k)}
              onCloseForm={() => setOpenSetup(null)}
              onSubmit={() => void runSetup(inst)}
            />
          );
        })}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {header}
      <ArrSnapshotNote at={snapshotAt} refreshing={loading} />
      {body}
    </div>
  );
}

/** One instance: its reachability and version, its checks, the webhook verdict and its setup. */
function InstanceHealthCard({ inst, variant, setup, setupBusy, formOpen, base, onBaseChange, onOpenForm, onCloseForm, onSubmit }: {
  inst: InstanceHealth;
  variant: "full" | "webhooks";
  setup: SetupState | undefined;
  setupBusy: boolean;
  formOpen: boolean;
  base: string;
  onBaseChange: (base: string) => void;
  onOpenForm: () => void;
  onCloseForm: () => void;
  onSubmit: () => void;
}) {
  const t = useT();
  const k = arrInstanceKey(inst);
  const label = inst.slug === "" ? SERVICE_LABEL[inst.service] : `${SERVICE_LABEL[inst.service]} (${inst.name || inst.slug})`;
  const wh = inst.webhook.state;
  const needsSetup = inst.reachable && (wh === "missing" || wh === "tokenMismatch" || wh === "eventsMissing");
  return (
    <div
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
        <Chip tone={WEBHOOK_TONE[wh] ?? "neutral"} title={t("adminManage.arrHealth.webhookHint")}>
          <LinkIcon style={{ width: 11, height: 11 }} aria-hidden /> {t(`adminManage.arrHealth.webhook.${wh}`)}
        </Chip>
        {needsSetup && !formOpen && (
          <Button size="xs" variant="outline" onClick={onOpenForm}>
            {wh === "missing" ? t("adminManage.arrHealth.setup") : t("adminManage.arrHealth.repair")}
          </Button>
        )}
      </div>

      {inst.error && (
        <p className="m-0 text-xs" style={{ color: inst.reachable ? "var(--ds-fg-subtle)" : "var(--ds-danger)" }}>
          {isArrErrorKind(inst.errorKind) ? t(ARR_ERROR_KIND_KEYS[inst.errorKind], { name: label }) : inst.error}
        </p>
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

      {formOpen && (
        <form
          className="flex flex-col gap-2"
          style={{ borderTop: "1px solid var(--ds-border)", paddingTop: 10 }}
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          <Label htmlFor={`webhook-base-${k}`}>{t("adminManage.arrHealth.baseLabel", { service: SERVICE_LABEL[inst.service] })}</Label>
          <Input
            id={`webhook-base-${k}`}
            type="url"
            value={base}
            onChange={(e) => onBaseChange(e.target.value.slice(0, 2000))}
            placeholder="http://summonarr:3000"
            className="font-mono"
          />
          <p className="m-0 text-xs text-zinc-500">{t("adminManage.arrHealth.baseHelp", { service: SERVICE_LABEL[inst.service] })}</p>
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={setupBusy || !base.trim()}>
              {setupBusy ? <Loader2 className="animate-spin" /> : <LinkIcon />}
              {wh === "missing" ? t("adminManage.arrHealth.setupSubmit") : t("adminManage.arrHealth.repairSubmit")}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onCloseForm} disabled={setupBusy}>
              {t("shared.common.cancel")}
            </Button>
          </div>
        </form>
      )}

      {setup?.message && (
        <p role="status" className="m-0 text-xs flex items-center gap-1 text-green-400">
          <CheckCircle2 style={{ width: 12, height: 12 }} aria-hidden /> {setup.message}
        </p>
      )}
      {setup?.error && (
        <div role="alert" className="text-xs flex flex-col gap-0.5" style={{ color: "var(--ds-danger)" }}>
          <span className="flex items-center gap-1">
            <AlertTriangle style={{ width: 12, height: 12 }} aria-hidden /> {setup.error}
          </span>
          {setup.detail && <span className="text-zinc-400" style={{ overflowWrap: "anywhere" }}>{setup.detail}</span>}
        </div>
      )}
    </div>
  );
}
