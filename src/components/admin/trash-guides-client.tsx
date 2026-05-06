"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { stripTrashHtml } from "@/lib/trash-html";
import { useHasMounted } from "@/hooks/use-has-mounted";
import {
  Loader2,
  RefreshCw,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Play,
  Shield,
  ShieldOff,
  ChevronDown,
  ChevronRight,
  Sparkles,
  CircleDashed,
} from "lucide-react";

type TrashService = "RADARR" | "SONARR";
type TrashSpecKind = "CUSTOM_FORMAT" | "CUSTOM_FORMAT_GROUP" | "QUALITY_PROFILE" | "NAMING" | "QUALITY_SIZE";

export interface TrashSettings {
  enabled: boolean;
  syncCustomFormats: boolean;
  syncCustomFormatGroups: boolean;
  syncQualityProfiles: boolean;
  syncNaming: boolean;
  syncQualitySizes: boolean;
}

interface ApplicationStatus {
  id: string;
  enabled: boolean;
  remoteId: number | null;
  appliedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  errorCount: number;
}

interface SpecStatus {
  id: string;
  service: TrashService;
  kind: TrashSpecKind;
  trashId: string;
  name: string;
  description: string | null;
  fetchedAt: string;
  application: ApplicationStatus | null;
}

interface SpecDetail extends SpecStatus {
  upstreamPath: string;
  upstreamSha: string | null;
  payload: Record<string, unknown>;
}

interface ApplyResult {
  specId: string;
  kind: TrashSpecKind;
  trashId: string;
  name: string;
  ok: boolean;
  remoteId?: number;
  error?: string;
  recreated?: boolean;
}

type LoadState = "idle" | "loading" | "ready" | "error";
type ActionState = "idle" | "running" | "ok" | "error";

interface StarterPackItem {
  item: {
    service: TrashService;
    kind: TrashSpecKind;
    label: string;
    rationale: string;
    recommended: boolean;
  };
  spec: { id: string; name: string; trashId: string } | null;
  application: { enabled: boolean; appliedAt: string | null; lastError: string | null } | null;
}

const KIND_LABEL: Record<TrashSpecKind, string> = {
  CUSTOM_FORMAT: "Custom Format",
  CUSTOM_FORMAT_GROUP: "CF Group",
  QUALITY_PROFILE: "Quality Profile",
  NAMING: "Naming",
  QUALITY_SIZE: "Quality Size",
};

interface TrashGuidesClientProps {
  initialSettings: TrashSettings;
  radarrConfigured: boolean;
  sonarrConfigured: boolean;
  // Set by the server component when the last GitHub-tree fetch was truncated within the last 7 days.
  // Staleness is computed server-side (guardrail 16: no Date.now() in client render path).
  recentTruncation?: { at: string } | null;
}

function formatRelative(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function TrashGuidesClient({
  initialSettings,
  radarrConfigured,
  sonarrConfigured,
  recentTruncation,
}: TrashGuidesClientProps) {
  const [activeTab, setActiveTab] = useState<TrashService>(
    radarrConfigured ? "RADARR" : sonarrConfigured ? "SONARR" : "RADARR",
  );
  const [settings, setSettings] = useState<TrashSettings>(initialSettings);
  const [specs, setSpecs] = useState<SpecStatus[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [refreshState, setRefreshState] = useState<ActionState>("idle");
  const [syncState, setSyncState] = useState<ActionState>("idle");
  const [applyLog, setApplyLog] = useState<ApplyResult[]>([]);
  const [starterPack, setStarterPack] = useState<StarterPackItem[]>([]);
  const [starterState, setStarterState] = useState<ActionState>("idle");
  const [refreshError, setRefreshError] = useState<{ errors: string[]; schemaDiagnostic?: string } | null>(null);
  const [schemaDiagnostic, setSchemaDiagnostic] = useState<string | null>(null);
  const [truncationDismissed, setTruncationDismissed] = useState(false);

  const loadStarterPack = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/trash-guides/starter-pack`);
      const data = (await res.json()) as { items: StarterPackItem[]; schemaDiagnostic?: string; error?: string };
      setStarterPack(data.items ?? []);
      if (data.schemaDiagnostic) setSchemaDiagnostic(data.schemaDiagnostic);
    } catch (err) {

      setStarterPack([]);
      setSchemaDiagnostic(err instanceof Error ? err.message : "Failed to load starter pack");
    }
  }, []);

  const loadSpecs = useCallback(async (service: TrashService) => {
    setLoadState("loading");
    try {
      const res = await fetch(`/api/admin/trash-guides/status?service=${service.toLowerCase()}`);
      const data = (await res.json()) as { specs?: SpecStatus[]; schemaDiagnostic?: string };
      setSpecs(data.specs ?? []);
      setLoadState("ready");
      if (data.schemaDiagnostic) setSchemaDiagnostic(data.schemaDiagnostic);
    } catch {
      setLoadState("error");
    }
  }, []);

  useEffect(() => {

    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadSpecs(activeTab);
  }, [activeTab, loadSpecs]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadStarterPack();
  }, [loadStarterPack]);

  async function handleRefresh(service?: TrashService) {
    setRefreshState("running");
    setApplyLog([]);
    setRefreshError(null);
    try {
      const payload = service ? { service: service.toLowerCase() } : {};
      const res = await fetch(`/api/admin/trash-guides/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      // 409 = lock contention with cron / another admin action. Surface as a non-error advisory.
      if (res.status === 409) {
        setRefreshState("error");
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setRefreshError({ errors: [data.error ?? "Trash sync already running. Try again in 30 seconds."] });
        setTimeout(() => setRefreshState((s) => (s === "error" ? s : "idle")), 3000);
        return;
      }
      const data = (await res.json()) as {
        ok?: boolean;
        errors?: string[];
        schemaDiagnostic?: string;
      };
      const hasErrors = !res.ok || !data.ok || (data.errors && data.errors.length > 0);
      setRefreshState(hasErrors ? "error" : "ok");
      if (hasErrors) {
        setRefreshError({ errors: data.errors ?? [`HTTP ${res.status}`], schemaDiagnostic: data.schemaDiagnostic });
      }
      await Promise.all([loadSpecs(activeTab), loadStarterPack()]);
    } catch (err) {
      setRefreshState("error");
      setRefreshError({ errors: [err instanceof Error ? err.message : String(err)] });
    }

    setTimeout(() => setRefreshState((s) => (s === "error" ? s : "idle")), 3000);
  }

  async function handleApplyStarterPack(specIds: string[]) {
    if (specIds.length === 0) return;
    setStarterState("running");
    setApplyLog([]);
    try {
      const res = await fetch(`/api/admin/trash-guides/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ specIds }),
      });
      if (res.status === 409) {
        setStarterState("error");
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setRefreshError({ errors: [data.error ?? "Trash sync already running. Try again in 30 seconds."] });
        setTimeout(() => setStarterState("idle"), 3000);
        return;
      }
      const data = (await res.json()) as { ok: boolean; results: ApplyResult[] };
      setStarterState(data.ok ? "ok" : "error");
      if (data.results) setApplyLog(data.results);
      await Promise.all([loadStarterPack(), loadSpecs(activeTab)]);
    } catch {
      setStarterState("error");
    }
    setTimeout(() => setStarterState("idle"), 3000);
  }

  async function handleSyncNow() {
    setSyncState("running");
    setApplyLog([]);
    try {
      const res = await fetch(`/api/cron/trash-sync`, { method: "POST" });
      const data = (await res.json()) as { ok?: boolean; applied?: ApplyResult[]; skipped?: boolean };
      setSyncState(res.ok ? "ok" : "error");
      if (data.applied) setApplyLog(data.applied);
      await loadSpecs(activeTab);
    } catch {
      setSyncState("error");
    }
    setTimeout(() => setSyncState("idle"), 3000);
  }

  const configured = activeTab === "RADARR" ? radarrConfigured : sonarrConfigured;

  // KPIs driven by the current service's specs
  const profilesAvailable = specs.filter((s) => s.kind === "QUALITY_PROFILE").length;
  const profilesApplied   = specs.filter((s) => s.kind === "QUALITY_PROFILE" && s.application?.enabled).length;
  const customFormatsTotal   = specs.filter((s) => s.kind === "CUSTOM_FORMAT").length;
  const customFormatsApplied = specs.filter((s) => s.kind === "CUSTOM_FORMAT" && s.application?.enabled).length;
  const driftCount = specs.filter((s) => s.application?.enabled && s.application.lastError).length;

  return (
    <div className="space-y-6 max-w-6xl">
      {schemaDiagnostic && <SchemaDiagnosticBanner message={schemaDiagnostic} onDismiss={() => setSchemaDiagnostic(null)} />}

      {recentTruncation && !truncationDismissed && (
        <TruncationBanner at={recentTruncation.at} onDismiss={() => setTruncationDismissed(true)} />
      )}

      <StarterPackCard
        items={starterPack}
        onApply={handleApplyStarterPack}
        state={starterState}
        onRefresh={() => handleRefresh()}
        refreshState={refreshState}
        radarrConfigured={radarrConfigured}
        sonarrConfigured={sonarrConfigured}
      />

      <TabBar
        activeTab={activeTab}
        onChange={setActiveTab}
        radarrConfigured={radarrConfigured}
        sonarrConfigured={sonarrConfigured}
        radarrProfileCount={activeTab === "RADARR" ? profilesAvailable : undefined}
        sonarrProfileCount={activeTab === "SONARR" ? profilesAvailable : undefined}
      />

      <KpiStrip
        profilesAvailable={profilesAvailable}
        profilesApplied={profilesApplied}
        customFormatsApplied={customFormatsApplied}
        customFormatsTotal={customFormatsTotal}
        drift={driftCount}
        loading={loadState === "loading"}
      />

      <SyncSettingsCard
        settings={settings}
        onChange={setSettings}
        onRefresh={() => handleRefresh(activeTab)}
        refreshState={refreshState}
        onSyncNow={handleSyncNow}
        syncState={syncState}
      />

      {refreshError && <RefreshErrorBanner error={refreshError} onDismiss={() => setRefreshError(null)} />}

      <GithubTokenCard />

      {!configured && (
        <Card className="bg-amber-500/10 border-amber-500/30 p-4 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <div className="text-sm text-amber-200">
            {activeTab === "RADARR" ? "Radarr" : "Sonarr"} is not configured. Set the URL and API key in{" "}
            <a href="/settings?tab=media" className="underline hover:text-amber-100">Settings</a> before applying specs.
          </div>
        </Card>
      )}

      {applyLog.length > 0 && <ApplyLog results={applyLog} onDismiss={() => setApplyLog([])} />}

      {loadState === "loading" && (
        <Card className="bg-zinc-900 border-zinc-800 p-6 text-sm text-zinc-400 flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading specs…
        </Card>
      )}
      {loadState === "error" && (
        <Card className="bg-red-500/10 border-red-500/30 p-4 text-sm text-red-300">
          Failed to load specs. Try Refresh Catalog above.
        </Card>
      )}
      {loadState === "ready" && (
        <>
          <SpecSection
            title="Custom Format Groups"
            description="TRaSH-curated bundles (HDR Formats, Release Groups HQ, Streaming Services, etc.). Applying a group applies every member custom format in one shot."
            specs={specs.filter((s) => s.kind === "CUSTOM_FORMAT_GROUP")}
            kind="CUSTOM_FORMAT_GROUP"
            service={activeTab}
            onChanged={() => loadSpecs(activeTab)}
            onApplied={(results) => {
              setApplyLog(results);
              void loadSpecs(activeTab);
            }}
            disabled={!configured}
          />
          <SpecSection
            title="Custom Formats"
            description="CFs that will be POSTed/PUT to Radarr/Sonarr. Unmanage to stop overwriting upstream changes."
            specs={specs.filter((s) => s.kind === "CUSTOM_FORMAT")}
            kind="CUSTOM_FORMAT"
            service={activeTab}
            onChanged={() => loadSpecs(activeTab)}
            onApplied={(results) => {
              setApplyLog(results);
              void loadSpecs(activeTab);
            }}
            disabled={!configured}
          />
          <SpecSection
            title="Quality Profiles"
            description="TRaSH quality profile templates. Applying a profile also applies any custom formats it references."
            specs={specs.filter((s) => s.kind === "QUALITY_PROFILE")}
            kind="QUALITY_PROFILE"
            service={activeTab}
            onChanged={() => loadSpecs(activeTab)}
            onApplied={(results) => {
              setApplyLog(results);
              void loadSpecs(activeTab);
            }}
            disabled={!configured}
          />
          <SpecSection
            title="Naming"
            description="Naming schemes. Applying merges selected templates into Radarr/Sonarr's media-management config."
            specs={specs.filter((s) => s.kind === "NAMING")}
            kind="NAMING"
            service={activeTab}
            onChanged={() => loadSpecs(activeTab)}
            onApplied={(results) => {
              setApplyLog(results);
              void loadSpecs(activeTab);
            }}
            disabled={!configured}
          />
          <SpecSection
            title="Quality Sizes"
            description="TRaSH's recommended min/preferred/max size per quality. Applying overlays these onto Radarr/Sonarr's quality definitions — untouched qualities keep their current values."
            specs={specs.filter((s) => s.kind === "QUALITY_SIZE")}
            kind="QUALITY_SIZE"
            service={activeTab}
            onChanged={() => loadSpecs(activeTab)}
            onApplied={(results) => {
              setApplyLog(results);
              void loadSpecs(activeTab);
            }}
            disabled={!configured}
          />
        </>
      )}
    </div>
  );
}

function SchemaDiagnosticBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <Card className="bg-amber-500/10 border-amber-500/40 p-4 text-sm">
      <div className="flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="font-medium text-amber-200">Database schema out of sync</p>
          <p className="mt-1 text-amber-100/90">{message}</p>
          <p className="mt-2 text-xs text-amber-300/80">
            Once the tables exist, click <span className="font-semibold">Refresh Catalog</span> below to populate them.
          </p>
        </div>
        <button onClick={onDismiss} className="text-xs text-amber-400 hover:text-amber-200">dismiss</button>
      </div>
    </Card>
  );
}

function RefreshErrorBanner({
  error,
  onDismiss,
}: {
  error: { errors: string[]; schemaDiagnostic?: string };
  onDismiss: () => void;
}) {
  return (
    <Card className="bg-red-500/10 border-red-500/40 p-4 text-sm">
      <div className="flex items-start gap-3">
        <XCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="font-medium text-red-200">Refresh Catalog failed</p>
          {error.schemaDiagnostic && (
            <div className="mt-2 p-2.5 bg-amber-500/10 border border-amber-500/30 rounded text-amber-200 text-xs">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium">Schema out of sync</p>
                  <p className="mt-0.5">{error.schemaDiagnostic}</p>
                </div>
              </div>
            </div>
          )}
          {error.errors.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs text-red-300 font-mono">
              {error.errors.map((e, i) => (
                <li key={i} className="break-all">{e}</li>
              ))}
            </ul>
          )}
        </div>
        <button onClick={onDismiss} className="text-xs text-red-400 hover:text-red-200">dismiss</button>
      </div>
    </Card>
  );
}

function TruncationBanner({ at, onDismiss }: { at: string; onDismiss: () => void }) {
  // The `at` timestamp is rendered as plain text (no relative-time math) — staleness is gated server-side
  // in page.tsx, so the banner only appears when the truncation is recent enough to act on.
  return (
    <Card className="bg-amber-500/10 border-amber-500/40 p-4 text-sm">
      <div className="flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="font-medium text-amber-200">GitHub tree response was truncated</p>
          <p className="mt-1 text-amber-100/90">
            The TRaSH-Guides repo exceeded GitHub&apos;s recursive-tree response cap on the last refresh
            ({new Date(at).toUTCString()}). Some specs may have been silently skipped.
          </p>
          <p className="mt-2 text-xs text-amber-300/80">
            Configure a GitHub personal access token below to lift rate limits, then click
            <span className="font-semibold"> Refresh Catalog</span>. If the issue persists, the upstream
            repo has outgrown the API page size — file an issue.
          </p>
        </div>
        <button onClick={onDismiss} className="text-xs text-amber-400 hover:text-amber-200">dismiss</button>
      </div>
    </Card>
  );
}

function GithubTokenCard() {
  const [masked, setMasked] = useState<string>("");
  const [value, setValue] = useState("");
  const [state, setState] = useState<ActionState>("idle");

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`/api/settings`);
        if (!res.ok) return;
        const data = (await res.json()) as Record<string, string>;
        setMasked(data.trashGithubToken ?? "");
      } catch {

      }
    })();
  }, []);

  async function save() {
    if (!value) return;
    setState("running");
    try {
      const res = await fetch(`/api/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trashGithubToken: value }),
      });
      if (!res.ok) throw new Error();
      setState("ok");
      setMasked("••••••••");
      setValue("");
    } catch {
      setState("error");
    }
    setTimeout(() => setState("idle"), 2000);
  }

  return (
    <Card className="bg-zinc-900 border-zinc-800 p-6">
      <div className="mb-3">
        <h2 className="font-semibold text-white text-lg">GitHub Token <span className="text-xs font-normal text-zinc-500">(optional)</span></h2>
        <p className="text-sm text-zinc-500 mt-0.5">
          GitHub limits unauthenticated API calls to 60/hour — enough for a few refreshes. Paste any{" "}
          <a href="https://github.com/settings/tokens?type=beta" target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline">fine-grained personal access token</a>{" "}
          (no scopes needed, public-repo read is the default) to raise it to 5 000/hour. Stored encrypted at rest when{" "}
          <code className="text-zinc-300">TOKEN_ENCRYPTION_KEY</code> is set.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={masked ? "Replace stored token…" : "ghp_… or github_pat_…"}
          className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-indigo-500 font-mono"
          autoComplete="off"
        />
        <Button
          type="button"
          onClick={save}
          disabled={!value || state === "running"}
          className="bg-indigo-600 hover:bg-indigo-500 text-white"
        >
          {state === "running" ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save"}
        </Button>
        {masked && !value && (
          <span className="text-xs text-zinc-500 inline-flex items-center gap-1.5">
            <CheckCircle className="w-3.5 h-3.5 text-green-400" />
            Configured
          </span>
        )}
        {state === "ok"    && <span className="text-xs text-green-400 flex items-center gap-1.5"><CheckCircle className="w-3.5 h-3.5" />Saved</span>}
        {state === "error" && <span className="text-xs text-red-400 flex items-center gap-1.5"><XCircle className="w-3.5 h-3.5" />Save failed</span>}
      </div>
    </Card>
  );
}

function StarterPackCard({
  items,
  onApply,
  state,
  onRefresh,
  refreshState,
  radarrConfigured,
  sonarrConfigured,
}: {
  items: StarterPackItem[];
  onApply: (specIds: string[]) => Promise<void>;
  state: ActionState;
  onRefresh: () => Promise<void>;
  refreshState: ActionState;
  radarrConfigured: boolean;
  sonarrConfigured: boolean;
}) {

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lastResolvedKeyRef = useRef<string>("");
  const resolvedIds = useMemo(
    () => items.filter((i) => i.spec).map((i) => i.spec!.id),
    [items],
  );
  const recommendedIds = useMemo(
    () => items.filter((i) => i.spec && i.item.recommended).map((i) => i.spec!.id),
    [items],
  );
  useEffect(() => {
    const key = resolvedIds.slice().sort().join(",");
    if (key !== lastResolvedKeyRef.current) {
      lastResolvedKeyRef.current = key;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelected(new Set(recommendedIds));
    }
  }, [resolvedIds, recommendedIds]);

  const missing = items.filter((i) => !i.spec);
  const applied = items.filter((i) => i.application?.appliedAt && !i.application.lastError);
  const errored = items.filter((i) => i.application?.lastError);
  const catalogEmpty = items.length > 0 && missing.length === items.length;
  const configured = radarrConfigured || sonarrConfigured;
  const canApply = configured && selected.size > 0;
  const allSelected = resolvedIds.length > 0 && selected.size === resolvedIds.length;
  const recommendedSelected = recommendedIds.length > 0 && recommendedIds.every((id) => selected.has(id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function selectAll() { setSelected(new Set(resolvedIds)); }
  function selectRecommended() { setSelected(new Set(recommendedIds)); }
  function clearAll() { setSelected(new Set()); }

  const grouped = useMemo(() => {
    const radarr = items.filter((i) => i.item.service === "RADARR");
    const sonarr = items.filter((i) => i.item.service === "SONARR");
    return { radarr, sonarr };
  }, [items]);

  return (
    <Card className="bg-gradient-to-br from-indigo-900/40 to-zinc-900 border-indigo-500/30 p-6">
      <div className="flex items-start justify-between gap-4 mb-4 flex-wrap">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center shrink-0">
            <Sparkles className="w-5 h-5 text-indigo-300" />
          </div>
          <div>
            <h2 className="font-semibold text-white text-lg">Profile Library</h2>
            <p className="text-sm text-zinc-400 mt-0.5 max-w-2xl">
              Every TRaSH quality profile, naming scheme, and quality-size template in the catalog. The{" "}
              <span className="text-indigo-300">Recommended</span> baseline for 1080p movies and TV is pre-selected;
              applying any quality profile cascades to every custom format it references.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            onClick={onRefresh}
            disabled={refreshState === "running"}
            className="bg-zinc-800 hover:bg-zinc-700 text-white"
            title="Pull the latest catalog from TRaSH"
          >
            {refreshState === "running"
              ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Refreshing…</>
              : <><RefreshCw className="w-4 h-4 mr-2" />Refresh Catalog</>}
          </Button>
          <Button
            type="button"
            onClick={() => onApply([...selected])}
            disabled={!canApply || state === "running"}
            className="bg-indigo-600 hover:bg-indigo-500 text-white"
          >
            {state === "running"
              ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Applying…</>
              : <><Play className="w-4 h-4 mr-2" />Apply selected ({selected.size})</>}
          </Button>
        </div>
      </div>

      {catalogEmpty && (
        <div className="mb-4 p-3 rounded-md bg-amber-500/10 border border-amber-500/30 flex items-start gap-2 text-xs text-amber-200">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">Catalog is empty</p>
            <p className="mt-0.5 text-amber-300/80">
              Click <span className="font-semibold">Refresh Catalog</span> above to pull the TRaSH catalog into the database. This takes ~20 s the first time; subsequent refreshes only fetch changed specs.
            </p>
          </div>
        </div>
      )}

      {items.length === 0 ? (
        <p className="text-xs text-zinc-500 italic">Loading library…</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-3 text-xs">
            <span className="text-zinc-500">Quick select:</span>
            <button
              type="button"
              onClick={selectRecommended}
              disabled={recommendedIds.length === 0 || recommendedSelected}
              className="px-2 py-0.5 rounded bg-indigo-600/30 hover:bg-indigo-600/50 text-indigo-200 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Recommended ({recommendedIds.length})
            </button>
            <button
              type="button"
              onClick={selectAll}
              disabled={resolvedIds.length === 0 || allSelected}
              className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              All ({resolvedIds.length})
            </button>
            {selected.size > 0 && (
              <button
                type="button"
                onClick={clearAll}
                className="px-2 py-0.5 text-zinc-400 hover:text-white"
              >
                Clear ({selected.size})
              </button>
            )}
          </div>
          {(["RADARR", "SONARR"] as const).map((service) => {
            const rows = service === "RADARR" ? grouped.radarr : grouped.sonarr;
            if (rows.length === 0) return null;
            return (
              <div key={service} className="mb-4 last:mb-0">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">
                  {service === "RADARR" ? "Radarr (Movies)" : "Sonarr (TV)"}
                  <span className="ml-2 font-normal normal-case tracking-normal text-zinc-600">{rows.length}</span>
                </h3>
                <div className="grid sm:grid-cols-2 gap-3">
                  {rows.map((row, i) => (
                    <StarterPackRow
                      key={`${service}-${i}`}
                      row={row}
                      selected={!!row.spec && selected.has(row.spec.id)}
                      onToggle={() => row.spec && toggle(row.spec.id)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3 text-xs pt-4 border-t border-indigo-500/20">
        {missing.length > 0 && !catalogEmpty && (
          <span className="text-amber-400 flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5" />
            {missing.length} missing — try Refresh Catalog, then check upstream naming
          </span>
        )}
        {applied.length > 0 && (
          <span className="text-green-400 flex items-center gap-1.5">
            <CheckCircle className="w-3.5 h-3.5" />
            {applied.length} / {items.length} applied
          </span>
        )}
        {errored.length > 0 && (
          <span className="text-red-400 flex items-center gap-1.5">
            <XCircle className="w-3.5 h-3.5" />
            {errored.length} errored
          </span>
        )}
        {refreshState === "ok"    && <span className="text-green-400 flex items-center gap-1.5"><CheckCircle className="w-3.5 h-3.5" />Catalog refreshed</span>}
        {refreshState === "error" && <span className="text-red-400 flex items-center gap-1.5"><XCircle className="w-3.5 h-3.5" />Refresh failed — see banner below</span>}
        {state === "ok"    && <span className="text-green-400 flex items-center gap-1.5"><CheckCircle className="w-3.5 h-3.5" />Selection applied</span>}
        {state === "error" && <span className="text-red-400 flex items-center gap-1.5"><XCircle className="w-3.5 h-3.5" />One or more failed — see log below</span>}
      </div>
    </Card>
  );
}

function StarterPackRow({
  row,
  selected,
  onToggle,
}: {
  row: StarterPackItem;
  selected: boolean;
  onToggle: () => void;
}) {
  const { item, spec, application } = row;
  let status: { icon: React.ReactNode; label: string; tone: string };
  if (!spec) {
    status = { icon: <AlertTriangle className="w-3.5 h-3.5" />, label: "missing", tone: "text-amber-400" };
  } else if (application?.lastError) {
    status = { icon: <XCircle className="w-3.5 h-3.5" />, label: "error", tone: "text-red-400" };
  } else if (application?.appliedAt) {
    status = { icon: <CheckCircle className="w-3.5 h-3.5" />, label: "applied", tone: "text-green-400" };
  } else {
    status = { icon: <CircleDashed className="w-3.5 h-3.5" />, label: "ready", tone: "text-zinc-300" };
  }

  const interactive = !!spec;
  return (
    <label
      className={`block rounded-md border p-3 transition-colors ${
        interactive
          ? selected
            ? "border-indigo-500/50 bg-indigo-500/10 cursor-pointer hover:bg-indigo-500/15"
            : item.recommended
              ? "border-indigo-500/30 bg-zinc-950/60 cursor-pointer hover:bg-indigo-500/5"
              : "border-zinc-800 bg-zinc-950/60 cursor-pointer hover:bg-zinc-900/60"
          : "border-zinc-800 bg-zinc-950/40 opacity-60"
      }`}
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          disabled={!interactive}
          className="mt-0.5 w-4 h-4 rounded border-zinc-600 bg-zinc-800 accent-indigo-500 disabled:cursor-not-allowed"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <p className="text-sm text-zinc-100 font-medium">{item.label}</p>
                <span className="text-[10px] uppercase tracking-wider text-zinc-500 px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800">
                  {KIND_LABEL[item.kind]}
                </span>
                {item.recommended && (
                  <span className="text-[10px] uppercase tracking-wider text-indigo-300 px-1.5 py-0.5 rounded bg-indigo-500/20 border border-indigo-500/40">
                    Recommended
                  </span>
                )}
              </div>
            </div>
            <span className={`text-xs inline-flex items-center gap-1 whitespace-nowrap ${status.tone}`}>
              {status.icon}
              {status.label}
            </span>
          </div>
          <p className="text-xs text-zinc-500 mt-1 whitespace-pre-line">{item.rationale}</p>
          {spec && (
            <p className="text-[11px] text-zinc-600 mt-2 font-mono truncate" title={spec.trashId}>
              {spec.name} · {spec.trashId.slice(0, 14)}…
            </p>
          )}
          {application?.lastError && (
            <p className="text-[11px] text-red-400 mt-1 truncate" title={application.lastError}>
              {application.lastError}
            </p>
          )}
        </div>
      </div>
    </label>
  );
}

function TabBar({
  activeTab,
  onChange,
  radarrConfigured,
  sonarrConfigured,
  radarrProfileCount,
  sonarrProfileCount,
}: {
  activeTab: TrashService;
  onChange: (t: TrashService) => void;
  radarrConfigured: boolean;
  sonarrConfigured: boolean;
  radarrProfileCount?: number;
  sonarrProfileCount?: number;
}) {
  return (
    <div className="flex gap-1" style={{ borderBottom: "1px solid var(--ds-border)" }}>
      {(["RADARR", "SONARR"] as const).map((t) => {
        const active = activeTab === t;
        const cfg = t === "RADARR" ? radarrConfigured : sonarrConfigured;
        const count = t === "RADARR" ? radarrProfileCount : sonarrProfileCount;
        return (
          <button
            key={t}
            onClick={() => onChange(t)}
            className="font-medium transition-colors inline-flex items-center gap-2"
            style={{
              padding: "8px 14px",
              marginBottom: -1,
              fontSize: 13,
              background: "transparent",
              borderBottom: active ? "2px solid var(--ds-accent)" : "2px solid transparent",
              color: active ? "var(--ds-fg)" : "var(--ds-fg-muted)",
            }}
          >
            <span>
              {t === "RADARR" ? "Radarr" : "Sonarr"}
              <span style={{ color: "var(--ds-fg-subtle)", marginLeft: 6 }}>
                · {t === "RADARR" ? "Movies" : "TV"}
              </span>
            </span>
            {typeof count === "number" && count > 0 && (
              <span
                className="ds-mono"
                style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)" }}
              >
                {count}
              </span>
            )}
            {!cfg && (
              <span className="ds-mono" style={{ fontSize: 10, color: "var(--ds-fg-subtle)" }}>
                (not configured)
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function KpiStrip({
  profilesAvailable,
  profilesApplied,
  customFormatsApplied,
  customFormatsTotal,
  drift,
  loading,
}: {
  profilesAvailable: number;
  profilesApplied: number;
  customFormatsApplied: number;
  customFormatsTotal: number;
  drift: number;
  loading: boolean;
}) {
  const kpis = [
    {
      label: "Profiles available",
      value: loading ? "…" : String(profilesAvailable),
      hint: "from TRaSH-Guides",
      tint: "var(--ds-fg)",
    },
    {
      label: "Applied to instance",
      value: loading ? "…" : String(profilesApplied),
      hint: `of ${profilesAvailable}`,
      tint: profilesApplied > 0 ? "var(--ds-accent)" : "var(--ds-fg)",
    },
    {
      label: "Custom formats",
      value: loading ? "…" : String(customFormatsTotal),
      hint: `${customFormatsApplied} applied`,
      tint: "var(--ds-fg)",
    },
    {
      label: "Drift",
      value: loading ? "…" : drift === 0 ? "0 diffs" : `${drift} diff${drift !== 1 ? "s" : ""}`,
      hint: drift === 0 ? "In sync with upstream" : "Review errors",
      tint: drift === 0 ? "var(--ds-success)" : "var(--ds-warning)",
    },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4" style={{ gap: 10 }}>
      {kpis.map((k) => (
        <div
          key={k.label}
          style={{
            padding: "14px 16px",
            background: "var(--ds-bg-2)",
            border: "1px solid var(--ds-border)",
            borderRadius: 8,
          }}
        >
          <p
            className="ds-mono uppercase"
            style={{
              fontSize: 10.5,
              color: "var(--ds-fg-subtle)",
              letterSpacing: "0.08em",
              margin: "0 0 6px",
            }}
          >
            {k.label}
          </p>
          <p
            className="font-semibold"
            style={{ fontSize: 22, color: k.tint, margin: 0, letterSpacing: "-0.02em" }}
          >
            {k.value}
          </p>
          {k.hint && (
            <p
              className="ds-mono"
              style={{ margin: "4px 0 0", fontSize: 10, color: "var(--ds-fg-subtle)" }}
            >
              {k.hint}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

function SyncSettingsCard({
  settings,
  onChange,
  onRefresh,
  refreshState,
  onSyncNow,
  syncState,
}: {
  settings: TrashSettings;
  onChange: (next: TrashSettings) => void;
  onRefresh: () => Promise<void>;
  refreshState: ActionState;
  onSyncNow: () => Promise<void>;
  syncState: ActionState;
}) {
  const [saveState, setSaveState] = useState<ActionState>("idle");

  async function patchSettings(partial: Partial<TrashSettings>) {
    setSaveState("running");
    const body: Record<string, string> = {};
    if (partial.enabled !== undefined) body.trashGuidesEnabled = String(partial.enabled);
    if (partial.syncCustomFormats !== undefined) body.trashSyncCustomFormats = String(partial.syncCustomFormats);
    if (partial.syncCustomFormatGroups !== undefined) body.trashSyncCustomFormatGroups = String(partial.syncCustomFormatGroups);
    if (partial.syncQualityProfiles !== undefined) body.trashSyncQualityProfiles = String(partial.syncQualityProfiles);
    if (partial.syncNaming !== undefined) body.trashSyncNaming = String(partial.syncNaming);
    if (partial.syncQualitySizes !== undefined) body.trashSyncQualitySizes = String(partial.syncQualitySizes);

    try {
      const res = await fetch(`/api/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error();
      onChange({ ...settings, ...partial });
      setSaveState("ok");
    } catch {
      setSaveState("error");
    }
    setTimeout(() => setSaveState("idle"), 2000);
  }

  return (
    <Card className="bg-zinc-900 border-zinc-800 p-6">
      <div className="mb-5">
        <h2 className="font-semibold text-white text-lg">Sync Settings</h2>
        <p className="text-sm text-zinc-500 mt-0.5">
          Enable the master toggle, then pick which kinds of specs the cron job re-applies each run.
        </p>
      </div>

      <div className="space-y-3">
        <ToggleRow
          label="TRaSH Sync Enabled"
          description="Master switch. When off, the trash-sync cron job exits immediately."
          checked={settings.enabled}
          onChange={(v) => patchSettings({ enabled: v })}
        />
        <ToggleRow
          label="Sync Custom Formats"
          description="Re-apply managed CFs on every sync. Overwrites manual edits in Radarr/Sonarr."
          checked={settings.syncCustomFormats}
          onChange={(v) => patchSettings({ syncCustomFormats: v })}
          indent
          disabled={!settings.enabled}
        />
        <ToggleRow
          label="Sync Custom Format Groups"
          description="Re-apply managed TRaSH CF-Groups (HDR Formats, Release Groups HQ, etc.). Each group cascades to its member CFs."
          checked={settings.syncCustomFormatGroups}
          onChange={(v) => patchSettings({ syncCustomFormatGroups: v })}
          indent
          disabled={!settings.enabled}
        />
        <ToggleRow
          label="Sync Quality Profiles"
          description="Re-apply managed quality profiles."
          checked={settings.syncQualityProfiles}
          onChange={(v) => patchSettings({ syncQualityProfiles: v })}
          indent
          disabled={!settings.enabled}
        />
        <ToggleRow
          label="Sync Naming"
          description="Re-apply managed naming schemes."
          checked={settings.syncNaming}
          onChange={(v) => patchSettings({ syncNaming: v })}
          indent
          disabled={!settings.enabled}
        />
        <ToggleRow
          label="Sync Quality Sizes"
          description="Re-apply managed quality-size templates (Radarr/Sonarr quality definition sliders)."
          checked={settings.syncQualitySizes}
          onChange={(v) => patchSettings({ syncQualitySizes: v })}
          indent
          disabled={!settings.enabled}
        />
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-4">
        <Button
          type="button"
          onClick={onRefresh}
          disabled={refreshState === "running"}
          className="bg-zinc-800 hover:bg-zinc-700 text-white"
        >
          {refreshState === "running"
            ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Refreshing…</>
            : <><RefreshCw className="w-4 h-4 mr-2" />Refresh Catalog</>}
        </Button>
        <Button
          type="button"
          onClick={onSyncNow}
          disabled={syncState === "running" || !settings.enabled}
          className="bg-indigo-600 hover:bg-indigo-500 text-white"
        >
          {syncState === "running"
            ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Syncing…</>
            : <><Play className="w-4 h-4 mr-2" />Sync Now</>}
        </Button>

        {saveState === "ok"    && <span className="text-xs text-green-400 flex items-center gap-1.5"><CheckCircle className="w-3.5 h-3.5" />Saved</span>}
        {saveState === "error" && <span className="text-xs text-red-400 flex items-center gap-1.5"><XCircle className="w-3.5 h-3.5" />Save failed</span>}
        {refreshState === "ok"    && <span className="text-xs text-green-400 flex items-center gap-1.5"><CheckCircle className="w-3.5 h-3.5" />Catalog refreshed</span>}
        {refreshState === "error" && <span className="text-xs text-red-400 flex items-center gap-1.5"><XCircle className="w-3.5 h-3.5" />Refresh failed</span>}
        {syncState === "ok"    && <span className="text-xs text-green-400 flex items-center gap-1.5"><CheckCircle className="w-3.5 h-3.5" />Sync complete</span>}
        {syncState === "error" && <span className="text-xs text-red-400 flex items-center gap-1.5"><XCircle className="w-3.5 h-3.5" />Sync failed</span>}
      </div>
    </Card>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
  indent,
  disabled,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  indent?: boolean;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex items-start gap-3 cursor-pointer group ${indent ? "ml-6" : ""} ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="mt-0.5 w-4 h-4 rounded border-zinc-600 bg-zinc-800 accent-indigo-500"
      />
      <div>
        <p className="text-sm text-zinc-200 font-medium group-hover:text-white transition-colors">{label}</p>
        <p className="text-xs text-zinc-500">{description}</p>
      </div>
    </label>
  );
}

function SpecSection({
  title,
  description,
  specs,
  kind,
  service,
  onChanged,
  onApplied,
  disabled,
}: {
  title: string;
  description: string;
  specs: SpecStatus[];
  kind: TrashSpecKind;
  service: TrashService;
  onChanged: () => void;
  onApplied: (results: ApplyResult[]) => void;
  disabled: boolean;
}) {
  // Gate `formatRelative` (uses Date.now()) behind mounted to avoid React #418
  // text mismatches when SSR's "1m ago" disagrees with the client's "2m ago".
  const mounted = useHasMounted();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [details, setDetails] = useState<Map<string, SpecDetail>>(new Map());
  const [applyState, setApplyState] = useState<ActionState>("idle");
  const [filter, setFilter] = useState<"all" | "managed" | "unmanaged" | "errored">("all");
  const [search, setSearch] = useState("");

  const specsHere = useMemo(() => specs.filter((s) => s.service === service && s.kind === kind), [specs, service, kind]);

  const filtered = useMemo(() => {
    return specsHere.filter((s) => {
      if (filter === "managed" && !s.application) return false;
      if (filter === "unmanaged" && s.application) return false;
      if (filter === "errored" && !s.application?.lastError) return false;
      if (search && !s.name.toLowerCase().includes(search.toLowerCase()) && !s.trashId.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [specsHere, filter, search]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllFiltered() {
    setSelected(new Set(filtered.map((s) => s.id)));
  }
  function selectBy(pred: (s: SpecStatus) => boolean) {
    setSelected(new Set(filtered.filter(pred).map((s) => s.id)));
  }
  function clearSelection() {
    setSelected(new Set());
  }

  async function toggleRow(spec: SpecStatus) {
    const nextExpanded = new Set(expanded);
    if (nextExpanded.has(spec.id)) {
      nextExpanded.delete(spec.id);
      setExpanded(nextExpanded);
      return;
    }
    nextExpanded.add(spec.id);
    setExpanded(nextExpanded);
    if (!details.has(spec.id)) {
      try {
        const res = await fetch(`/api/admin/trash-guides/spec/${spec.id}`);
        if (res.ok) {
          const detail = (await res.json()) as SpecDetail;
          setDetails((prev) => new Map(prev).set(spec.id, detail));
        }
      } catch {

      }
    }
  }

  async function applySelected() {
    if (selected.size === 0) return;
    setApplyState("running");
    try {
      const res = await fetch(`/api/admin/trash-guides/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ specIds: [...selected] }),
      });
      // 409 = lock contention with cron / another admin action — keep selection intact so the user
      // can retry once the lock releases (Retry-After: 30s).
      if (res.status === 409) {
        setApplyState("error");
        setTimeout(() => setApplyState("idle"), 3000);
        return;
      }
      const data = (await res.json()) as { ok: boolean; results: ApplyResult[] };
      setApplyState(data.ok ? "ok" : "error");
      setSelected(new Set());
      onApplied(data.results ?? []);
    } catch {
      setApplyState("error");
    }
    setTimeout(() => setApplyState("idle"), 3000);
  }

  async function toggleManagement(appId: string, enabled: boolean) {
    await fetch(`/api/admin/trash-guides/applications/${appId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    onChanged();
  }

  async function deleteApplication(appId: string) {
    if (!confirm("Unmanage this spec entirely? The remote CF/profile in Radarr/Sonarr is not deleted.")) return;
    await fetch(`/api/admin/trash-guides/applications/${appId}`, {
      method: "DELETE",
    });
    onChanged();
  }

  const managedCount = specsHere.filter((s) => s.application?.enabled).length;
  const erroredCount = specsHere.filter((s) => s.application?.lastError).length;
  const allSelected = filtered.length > 0 && selected.size === filtered.length;
  const someSelected = selected.size > 0 && selected.size < filtered.length;

  return (
    <Card className="bg-zinc-900 border-zinc-800 p-6">
      <div className="flex items-start justify-between gap-4 mb-4 flex-wrap">
        <div>
          <h2 className="font-semibold text-white text-lg">{title}</h2>
          <p className="text-sm text-zinc-500 mt-0.5">{description}</p>
        </div>
        <div className="flex items-center gap-3 text-xs text-zinc-500">
          <span>{specsHere.length} total</span>
          <span className="text-green-400">{managedCount} managed</span>
          {erroredCount > 0 && <span className="text-red-400">{erroredCount} errored</span>}
        </div>
      </div>

      {}
      <div className="flex flex-wrap gap-2 mb-3">
        {(["all", "managed", "unmanaged", "errored"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
              filter === f
                ? "bg-indigo-600 text-white"
                : "bg-zinc-800 text-zinc-400 hover:text-white"
            }`}
          >
            {f}
          </button>
        ))}
        <input
          type="search"
          placeholder="Search name or trash_id…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="ml-auto bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-indigo-500 w-60"
        />
      </div>

      {}
      <div className="flex flex-wrap items-center gap-2 mb-3 text-xs">
        <span className="text-zinc-500">Quick select:</span>
        <BulkButton onClick={selectAllFiltered}>All visible ({filtered.length})</BulkButton>
        <BulkButton onClick={() => selectBy((s) => !s.application)}>Unmanaged</BulkButton>
        <BulkButton onClick={() => selectBy((s) => !!s.application?.enabled)}>Managed</BulkButton>
        <BulkButton onClick={() => selectBy((s) => !!s.application?.lastError)}>Errored</BulkButton>
        {selected.size > 0 && (
          <BulkButton onClick={clearSelection} tone="ghost">Clear ({selected.size})</BulkButton>
        )}
      </div>

      {specsHere.length === 0 ? (
        <p className="text-sm text-zinc-500 italic">No specs pulled yet — click Refresh Catalog above.</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-zinc-500 italic">No specs match the current filter.</p>
      ) : (
        <div className="overflow-x-auto -mx-6">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-left">
                <th className="py-2 px-6 w-8">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(el) => { if (el) el.indeterminate = someSelected; }}
                    onChange={() => (allSelected ? clearSelection() : selectAllFiltered())}
                    className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 accent-indigo-500"
                  />
                </th>
                <th className="py-2 pr-4 w-6" />
                <th className="py-2 pr-4 text-xs font-semibold uppercase tracking-wider text-zinc-500">Name</th>
                <th className="py-2 pr-4 text-xs font-semibold uppercase tracking-wider text-zinc-500">Status</th>
                <th className="py-2 pr-4 text-xs font-semibold uppercase tracking-wider text-zinc-500">Last applied</th>
                <th className="py-2 pr-6 text-xs font-semibold uppercase tracking-wider text-zinc-500 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((spec) => {
                const isOpen = expanded.has(spec.id);
                const detail = details.get(spec.id);
                return (
                  <Fragment key={spec.id}>
                    <tr className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
                      <td className="py-2.5 px-6">
                        <input
                          type="checkbox"
                          checked={selected.has(spec.id)}
                          onChange={() => toggle(spec.id)}
                          disabled={disabled}
                          className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 accent-indigo-500"
                        />
                      </td>
                      <td className="py-2.5 pr-2">
                        <button
                          onClick={() => toggleRow(spec)}
                          className="text-zinc-500 hover:text-white"
                          aria-label={isOpen ? "Collapse" : "Expand"}
                        >
                          {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        </button>
                      </td>
                      <td className="py-2.5 pr-4">
                        <div className="text-zinc-100">{spec.name}</div>
                        <div className="text-xs text-zinc-500 font-mono">{spec.trashId.slice(0, 12)}…</div>
                      </td>
                      <td className="py-2.5 pr-4">
                        <div className="flex items-center gap-1.5">
                          <StatusBadge spec={spec} />
                          {spec.application && spec.application.errorCount > 1 && (
                            <span
                              className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-300 font-mono"
                              title={
                                spec.application.lastErrorAt
                                  ? `${spec.application.errorCount} failures, last ${spec.application.lastErrorAt}`
                                  : `${spec.application.errorCount} failures`
                              }
                            >
                              ×{spec.application.errorCount}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-2.5 pr-4 text-zinc-400 text-xs">
                        {mounted ? formatRelative(spec.application?.appliedAt ?? null) : ""}
                        {spec.application?.lastError && (
                          <div className="text-red-400 text-xs mt-1 max-w-xs truncate" title={spec.application.lastError}>
                            {spec.application.lastError}
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 pr-6 text-right">
                        {spec.application ? (
                          <div className="flex items-center gap-2 justify-end">
                            <button
                              onClick={() => toggleManagement(spec.application!.id, !spec.application!.enabled)}
                              className="text-xs text-zinc-400 hover:text-white inline-flex items-center gap-1"
                              title={spec.application.enabled ? "Pause sync for this spec" : "Resume sync"}
                            >
                              {spec.application.enabled
                                ? <><Shield className="w-3.5 h-3.5" />Managed</>
                                : <><ShieldOff className="w-3.5 h-3.5" />Paused</>}
                            </button>
                            <button
                              onClick={() => deleteApplication(spec.application!.id)}
                              className="text-xs text-zinc-500 hover:text-red-400"
                            >
                              Forget
                            </button>
                          </div>
                        ) : (
                          <span className="text-xs text-zinc-600">—</span>
                        )}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-zinc-950/50 border-b border-zinc-800/50">
                        <td colSpan={6} className="px-10 py-4">
                          <SpecDetailView detail={detail ?? null} kind={kind} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4 flex items-center gap-3">
        <Button
          type="button"
          onClick={applySelected}
          disabled={disabled || selected.size === 0 || applyState === "running"}
          className="bg-indigo-600 hover:bg-indigo-500 text-white"
        >
          {applyState === "running"
            ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Applying…</>
            : <>Apply selected ({selected.size})</>}
        </Button>
        {applyState === "ok"    && <span className="text-xs text-green-400 flex items-center gap-1.5"><CheckCircle className="w-3.5 h-3.5" />Applied</span>}
        {applyState === "error" && <span className="text-xs text-red-400 flex items-center gap-1.5"><XCircle className="w-3.5 h-3.5" />One or more failed — see log above</span>}
      </div>
    </Card>
  );
}

function BulkButton({
  onClick,
  children,
  tone = "solid",
}: {
  onClick: () => void;
  children: React.ReactNode;
  tone?: "solid" | "ghost";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        tone === "ghost"
          ? "px-2 py-0.5 text-xs text-zinc-400 hover:text-white rounded"
          : "px-2 py-0.5 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white rounded"
      }
    >
      {children}
    </button>
  );
}

function StatusBadge({ spec }: { spec: SpecStatus }) {
  const app = spec.application;
  if (!app) {
    return <span className="text-xs px-2 py-0.5 rounded bg-zinc-800 text-zinc-500 font-medium">Unmanaged</span>;
  }
  if (app.lastError) {
    return <span className="text-xs px-2 py-0.5 rounded bg-red-500/20 text-red-300 font-medium">Error</span>;
  }
  if (!app.enabled) {
    return <span className="text-xs px-2 py-0.5 rounded bg-zinc-800 text-zinc-400 font-medium">Paused</span>;
  }
  if (app.appliedAt) {
    return <span className="text-xs px-2 py-0.5 rounded bg-green-500/20 text-green-300 font-medium">Managed</span>;
  }
  return <span className="text-xs px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 font-medium">Pending</span>;
}

function SpecDetailView({ detail, kind }: { detail: SpecDetail | null; kind: TrashSpecKind }) {
  if (!detail) {
    return (
      <div className="text-xs text-zinc-500 flex items-center gap-2">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading detail…
      </div>
    );
  }
  if (kind === "CUSTOM_FORMAT") return <CustomFormatDetail detail={detail} />;
  if (kind === "CUSTOM_FORMAT_GROUP") return <CustomFormatGroupDetail detail={detail} />;
  if (kind === "QUALITY_PROFILE") return <QualityProfileDetail detail={detail} />;
  if (kind === "NAMING") return <NamingDetail detail={detail} />;
  if (kind === "QUALITY_SIZE") return <QualitySizeDetail detail={detail} />;
  return null;
}

function CustomFormatGroupDetail({ detail }: { detail: SpecDetail }) {
  const payload = detail.payload as {
    trash_id?: string;
    trash_description?: string;
    default?: string;
    custom_formats?: Array<{ name: string; trash_id: string; required: boolean }>;
    quality_profiles?: { include?: Record<string, string> };
  };
  const members = payload.custom_formats ?? [];
  const requiredCount = members.filter((m) => m.required).length;
  const includedProfiles = Object.entries(payload.quality_profiles?.include ?? {});
  return (
    <div className="space-y-3 text-xs text-zinc-300">
      <div className="grid grid-cols-2 gap-x-6 gap-y-1">
        <div><span className="text-zinc-500">trash_id:</span> <span className="font-mono">{payload.trash_id ?? "—"}</span></div>
        <div><span className="text-zinc-500">default:</span> {payload.default ?? "false"}</div>
        <div className="col-span-2"><span className="text-zinc-500">Upstream path:</span> <span className="font-mono">{detail.upstreamPath}</span></div>
      </div>
      {payload.trash_description && (
        <p className="text-zinc-400 italic whitespace-pre-line">{stripTrashHtml(payload.trash_description)}</p>
      )}
      {members.length > 0 && (
        <div>
          <p className="text-zinc-400 font-medium mb-1">
            Member CFs ({members.length}{requiredCount > 0 ? ` · ${requiredCount} required` : ""})
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0.5 max-h-60 overflow-y-auto">
            {members.map((m) => (
              <div key={m.trash_id} className="flex items-center gap-2 min-w-0">
                <span className="font-mono text-[11px] text-zinc-500 shrink-0" title={m.trash_id}>{m.trash_id.slice(0, 10)}…</span>
                <span className="text-zinc-300 truncate">{m.name}</span>
                {m.required && <span className="text-blue-400 text-[10px] uppercase shrink-0">required</span>}
              </div>
            ))}
          </div>
        </div>
      )}
      {includedProfiles.length > 0 && (
        <div>
          <p className="text-zinc-400 font-medium mb-1">Auto-included by profiles ({includedProfiles.length})</p>
          <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto">
            {includedProfiles.map(([label, trashId]) => (
              <span key={trashId} className="px-2 py-0.5 bg-zinc-800 rounded">
                <span className="text-zinc-300">{label}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function QualitySizeDetail({ detail }: { detail: SpecDetail }) {
  const payload = detail.payload as {
    trash_id?: string;
    type?: string;
    qualities?: Array<{ quality: string; min: number; preferred?: number; max: number }>;
  };
  const rows = payload.qualities ?? [];
  return (
    <div className="space-y-3 text-xs text-zinc-300">
      <div className="grid grid-cols-2 gap-x-6 gap-y-1">
        <div><span className="text-zinc-500">trash_id:</span> <span className="font-mono">{payload.trash_id ?? "—"}</span></div>
        <div><span className="text-zinc-500">type:</span> {payload.type ?? "—"}</div>
      </div>
      <div>
        <p className="text-zinc-400 font-medium mb-1">Per-quality limits (MB/min)</p>
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-zinc-800 text-left text-zinc-500">
                <th className="py-1 pr-3 font-semibold">Quality</th>
                <th className="py-1 pr-3 font-semibold text-right">Min</th>
                <th className="py-1 pr-3 font-semibold text-right">Preferred</th>
                <th className="py-1 pr-3 font-semibold text-right">Max</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((q) => (
                <tr key={q.quality} className="border-b border-zinc-800/50">
                  <td className="py-1 pr-3 text-zinc-200">{q.quality}</td>
                  <td className="py-1 pr-3 text-right font-mono">{q.min}</td>
                  <td className="py-1 pr-3 text-right font-mono">{q.preferred ?? "—"}</td>
                  <td className="py-1 pr-3 text-right font-mono">{q.max}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function readSpecValue(fields: unknown): unknown {
  if (Array.isArray(fields)) {
    return (fields as Array<{ name?: string; value?: unknown }>)
      .find((f) => f.name === "value")?.value;
  }
  if (fields && typeof fields === "object") {
    return (fields as Record<string, unknown>).value;
  }
  return undefined;
}

function CustomFormatDetail({ detail }: { detail: SpecDetail }) {
  const payload = detail.payload as {
    trash_id?: string;
    trash_scores?: Record<string, number>;
    includeCustomFormatWhenRenaming?: boolean;
    specifications?: Array<{ name?: string; implementation?: string; negate?: boolean; required?: boolean; fields?: Array<{ name?: string; value?: unknown }> | Record<string, unknown> }>;
  };
  const scores = payload.trash_scores ?? {};
  const specs = payload.specifications ?? [];
  return (
    <div className="space-y-3 text-xs text-zinc-300">
      <div className="grid grid-cols-2 gap-x-6 gap-y-1">
        <div><span className="text-zinc-500">trash_id:</span> <span className="font-mono">{payload.trash_id}</span></div>
        <div><span className="text-zinc-500">includeCustomFormatWhenRenaming:</span> {String(payload.includeCustomFormatWhenRenaming ?? false)}</div>
        <div><span className="text-zinc-500">Upstream path:</span> <span className="font-mono">{detail.upstreamPath}</span></div>
        <div><span className="text-zinc-500">sha:</span> <span className="font-mono">{detail.upstreamSha?.slice(0, 12) ?? "—"}</span></div>
      </div>

      {Object.keys(scores).length > 0 && (
        <div>
          <p className="text-zinc-400 font-medium mb-1">Trash scores</p>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(scores).map(([set, score]) => (
              <span key={set} className="px-2 py-0.5 bg-zinc-800 rounded">
                <span className="text-zinc-500">{set}:</span> <span className="font-mono">{score > 0 ? "+" : ""}{score}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {specs.length > 0 && (
        <div>
          <p className="text-zinc-400 font-medium mb-1">Specifications ({specs.length})</p>
          <div className="space-y-1">
            {specs.map((s, i) => {
              const value = readSpecValue(s.fields);
              return (
                <div key={i} className="flex items-center gap-2 py-0.5">
                  <span className="font-medium text-zinc-200 min-w-0 truncate">{s.name}</span>
                  <span className="text-zinc-500">({s.implementation})</span>
                  {s.negate && <span className="text-amber-400 text-[10px] uppercase">negated</span>}
                  {s.required && <span className="text-blue-400 text-[10px] uppercase">required</span>}
                  {value != null && (
                    <span className="font-mono text-zinc-400 truncate text-[11px]">{String(value).slice(0, 60)}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function QualityProfileDetail({ detail }: { detail: SpecDetail }) {
  const payload = detail.payload as {
    upgradeAllowed?: boolean;
    cutoff?: string;
    cutoffFormatScore?: number;
    minFormatScore?: number;
    minUpgradeFormatScore?: number;
    score_set?: string;
    language?: string;
    items?: Array<{ name?: string; allowed?: boolean; items?: string[] }>;
    formatItems?: Record<string, string>;
  };
  const items = payload.items ?? [];
  const allowedItems = items.filter((q) => q.allowed);
  const formatItems = Object.entries(payload.formatItems ?? {});

  return (
    <div className="space-y-3 text-xs text-zinc-300">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-1">
        <div><span className="text-zinc-500">Upgrade allowed:</span> {String(payload.upgradeAllowed ?? true)}</div>
        <div><span className="text-zinc-500">Cutoff:</span> {payload.cutoff ?? "—"}</div>
        <div><span className="text-zinc-500">Cutoff format score:</span> {payload.cutoffFormatScore ?? 0}</div>
        <div><span className="text-zinc-500">Min format score:</span> {payload.minFormatScore ?? 0}</div>
        {payload.minUpgradeFormatScore != null && (
          <div><span className="text-zinc-500">Min upgrade score:</span> {payload.minUpgradeFormatScore}</div>
        )}
        <div><span className="text-zinc-500">Score set:</span> {payload.score_set ?? "default"}</div>
        <div><span className="text-zinc-500">Language:</span> {payload.language ?? "Original"}</div>
      </div>

      {allowedItems.length > 0 && (
        <div>
          <p className="text-zinc-400 font-medium mb-1">Allowed qualities ({allowedItems.length} of {items.length})</p>
          <div className="flex flex-wrap gap-1.5">
            {allowedItems.map((q, i) => (
              <span key={i} className="px-2 py-0.5 bg-zinc-800 rounded">
                {q.items?.length ? (
                  <>
                    <span className="font-medium">{q.name}</span>
                    <span className="text-zinc-500"> ({q.items.join(", ")})</span>
                  </>
                ) : (
                  <span>{q.name}</span>
                )}
              </span>
            ))}
          </div>
        </div>
      )}

      {formatItems.length > 0 && (
        <div>
          <p className="text-zinc-400 font-medium mb-1">Referenced custom formats ({formatItems.length})</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0.5 max-h-60 overflow-y-auto">
            {formatItems.map(([label, trashId]) => (
              <div key={trashId} className="flex items-center gap-2 min-w-0">
                <span className="font-mono text-[11px] text-zinc-500 shrink-0" title={trashId}>{trashId.slice(0, 10)}…</span>
                <span className="text-zinc-300 truncate">{label}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function NamingDetail({ detail }: { detail: SpecDetail }) {
  const payload = detail.payload as Record<string, unknown>;
  const entries = Object.entries(payload).filter(([k]) => k !== "name");
  return (
    <div className="space-y-2 text-xs">
      <div className="text-zinc-500">Upstream: <span className="font-mono text-zinc-400">{detail.upstreamPath}</span></div>
      <table className="w-full">
        <tbody>
          {entries.map(([key, value]) => (
            <tr key={key} className="align-top">
              <td className="py-1 pr-3 text-zinc-400 font-medium whitespace-nowrap">{key}</td>
              <td className="py-1 font-mono text-zinc-300 break-all">{typeof value === "string" ? value : JSON.stringify(value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ApplyLog({ results, onDismiss }: { results: ApplyResult[]; onDismiss: () => void }) {
  const failures = results.filter((r) => !r.ok);
  const successes = results.filter((r) => r.ok);
  return (
    <Card className="bg-zinc-900 border-zinc-800 p-4 text-sm">
      <div className="flex items-center gap-3 mb-2">
        <span className="text-green-400 flex items-center gap-1.5"><CheckCircle className="w-4 h-4" />{successes.length} ok</span>
        {failures.length > 0 && <span className="text-red-400 flex items-center gap-1.5"><XCircle className="w-4 h-4" />{failures.length} failed</span>}
        <button onClick={onDismiss} className="ml-auto text-xs text-zinc-500 hover:text-white">dismiss</button>
      </div>
      {failures.length > 0 && (
        <ul className="space-y-1 mt-2 max-h-40 overflow-y-auto">
          {failures.map((f) => (
            <li key={f.specId} className="text-xs text-red-300">
              <span className="font-medium">{f.name}</span>: {f.error}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
