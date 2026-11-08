"use client";

// Admin → Arr System → Indexers & clients: which indexers and download clients
// each instance has and which are on (failing ones are in the health panel
// above); switch them, test them. Their settings (API keys, passwords) never
// leave the server.
//
// A provider test or a testing save waits on the arr for up to two minutes —
// longer than a reverse proxy holds a request open (nginx ~60 s, Cloudflare
// ~100 s), which answered the browser with a proxy error while the save landed.
// So they run as background jobs (arrCallJob, arr-call.ts): sent with
// `async: true`, answered 202 { job }, `?job=` polled until the route's own
// answer arrives. Time is counted in polls, never read off the clock
// (guardrail 16). What each test or save leaves behind lives per provider, in
// its instance's indexer or client section (arr-system-state.ts).

import { useState, type Dispatch, type SetStateAction } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Chip } from "@/components/ui/design";
import { AlertTriangle, Check, CircleDashed, Clock, Loader2, XCircle } from "@/components/icons";
import { useT } from "@/components/i18n/i18n-provider";
import { withBasePath } from "@/lib/base-path";
import type { ArrDownloadClient, ArrIndexer, ArrTag, ProviderKind } from "@/lib/arr-system";
import { arrCallJob, isStillRunning } from "@/lib/client/arr-call";
import { PROVIDER_SAVED, PROVIDER_TESTS, PROVIDERS_REPORT, type ArrServiceName, type ProvidersResult } from "@/lib/client/arr-answers";
import { check, type Schema } from "@/lib/validate";
import { SERVICE_LABEL } from "@/components/admin/arr-title/shared";
import { Card, InstanceErrors, labelOf, Loading, Toolbar, useLifetimeSignal, useReport } from "./arr-system-parts";
import {
  cardKey, dropHeld, failureView, heldBack, listSignature, providerSignature, pruneAfterReload, saved, saveFailed, sectionKey, sectionOf,
  singleTestAnswered, singleTestFailed, testAllAnswered, testAllFailed, updateSection, visibleSummary, visibleVerdict,
  type Change, type Held, type Sections, type SectionState, type Summary, type TestView,
} from "./arr-system-state";

// The background jobs' poll: every 2 s, for ~5 minutes — past the server's
// longest wait (a 120 s test, then a minute of read-backs).
const JOB_POLL_MS = 2_000;
const JOB_MAX_POLLS = 150;

type Provider = ArrIndexer | ArrDownloadClient;
type ToggleOpts = { acceptWarnings?: boolean; confirmed?: boolean };
type SetSections<P> = Dispatch<SetStateAction<Sections<P>>>;

export function ProvidersTab() {
  const t = useT();
  const { report, loading, error, load, staleAt } = useReport<ProvidersResult>("/api/admin/arr/providers", PROVIDERS_REPORT, t("adminArr.system.loadFailed"), null);
  // Per section (one kind of provider on one instance card): the test or save
  // in flight there. One at a time keeps a Test All and a single test of that
  // kind from racing the results; a dead indexer hanging ~100 s must not lock
  // the instance's download clients, nor any other instance.
  const [busy, setBusy] = useState<Record<string, string>>({});
  // What each test or save left behind, per provider — indexers and clients apart.
  const [indexers, setIndexers] = useState<Sections<ArrIndexer>>({});
  const [clients, setClients] = useState<Sections<ArrDownloadClient>>({});
  // A Prowlarr-managed indexer's switch, until the admin confirms it.
  const [prowlarrAsk, setProwlarrAsk] = useState<{ card: string; id: number; change: Change } | null>(null);
  // A test or save still being polled when the tab goes away is dropped.
  const lifetime = useLifetimeSignal();

  const startBusy = (section: string, what: string) => setBusy((m) => ({ ...m, [section]: what }));
  const endBusy = (section: string) => setBusy((m) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== section)));

  /** Test one provider, or every one of the kind (`id` null). `list` is the kind as the report has it now. */
  async function test<P extends Provider>(kind: ProviderKind, setSections: SetSections<P>, service: ArrServiceName, instance: string, list: readonly P[], id: number | null) {
    const section = sectionKey(cardKey(service, instance), kind);
    startBusy(section, `test:${id ?? "all"}`);
    const signatures = new Map(list.map((p) => [p.id, providerSignature(p)]));
    const listAgainst = listSignature(list);
    const res = await arrCallJob(withBasePath("/api/admin/arr/providers/test"), {
      method: "POST",
      body: { service, instance, kind, ...(id !== null ? { id } : {}) },
      schema: PROVIDER_TESTS,
      signal: lifetime(),
      fallback: t("adminArr.system.testFailed"),
      stillRunning: t("adminArr.system.stillRunning", { service: SERVICE_LABEL[service] }),
      intervalMs: JOB_POLL_MS,
      maxPolls: JOB_MAX_POLLS,
    });
    if (res === null) return;
    endBusy(section);
    if (res.ok) {
      const answered = res.data.results;
      setSections((m) => updateSection(m, section, (s) => (id === null ? testAllAnswered(s, answered, signatures, listAgainst) : singleTestAnswered(s, answered, signatures))));
      return;
    }
    const view = failureView(res.error, isStillRunning(res));
    setSections((m) => updateSection(m, section, (s) => (id === null ? testAllFailed(s, view, listAgainst) : singleTestFailed(s, id, view, signatures.get(id) ?? ""))));
  }

  /**
   * Switch a provider's uses. `against` is the provider as the report has it
   * (the outcome line belongs to that); `provider` is what the row shows now.
   */
  async function toggle<P extends Provider>(
    kind: ProviderKind,
    schema: Schema<{ provider: P }>,
    setSections: SetSections<P>,
    service: ArrServiceName,
    instance: string,
    provider: P,
    against: string,
    change: Change,
    opts: ToggleOpts = {},
  ) {
    const card = cardKey(service, instance);
    // Prowlarr's next full sync turns a change made here back — say so first.
    if ("managedByProwlarr" in provider && provider.managedByProwlarr && !opts.confirmed) {
      setProwlarrAsk({ card, id: provider.id, change });
      return;
    }
    setProwlarrAsk(null);
    const section = sectionKey(card, kind);
    startBusy(section, `toggle:${provider.id}`);
    const res = await arrCallJob(withBasePath("/api/admin/arr/providers"), {
      method: "PATCH",
      body: { service, instance, kind, id: provider.id, ...change, ...(opts.acceptWarnings ? { acceptWarnings: true } : {}) },
      schema,
      signal: lifetime(),
      fallback: t("adminArr.system.saveFailed"),
      stillRunning: t("adminArr.system.stillRunning", { service: SERVICE_LABEL[service] }),
      intervalMs: JOB_POLL_MS,
      maxPolls: JOB_MAX_POLLS,
    });
    if (res === null) return;
    endBusy(section);
    if (res.ok) {
      setSections((m) => updateSection(m, section, (s) => saved(s, provider.id, res.data.provider)));
      return;
    }
    // Held back for warnings alone: show them, and let the admin switch it on anyway.
    if (res.status === 409 && res.body?.warningsOnly === true) {
      const messages = Array.isArray(res.body.messages) ? res.body.messages.filter((x): x is string => typeof x === "string") : [];
      setSections((m) => updateSection(m, section, (s) => heldBack(s, provider.id, { change, messages })));
      return;
    }
    // A save that timed out still says what the arr holds now — read as THIS
    // kind's provider, or not at all.
    const now = check(schema, res.body);
    const view = failureView(res.error, isStillRunning(res));
    setSections((m) => updateSection(m, section, (s) => saveFailed(s, provider.id, view, against, now.ok ? now.value.provider : null)));
  }

  // Reload: the switches keep what this page saved until the NEW report lands —
  // a failed reload keeps the old report, and dropping them first showed every
  // switched provider back in its pre-change state beside the error. Only the
  // overrides and held-warnings prompts already there at the click are
  // replaced: one a save writes while the reload is out may be newer than what
  // the reload read — a "switch anyway" prompt that arrived meanwhile stays.
  function reload() {
    setProwlarrAsk(null);
    const indexersBefore = indexers;
    const clientsBefore = clients;
    void load().then((ok) => {
      if (!ok) return;
      setIndexers((m) => pruneAfterReload(m, indexersBefore));
      setClients((m) => pruneAfterReload(m, clientsBefore));
    });
  }

  if (!report) return <Loading error={error} loading={loading} onRetry={() => void load()} />;
  const anyProwlarr = report.results.some((r) => r.indexers.some((ix) => ix.managedByProwlarr));
  return (
    <div className="grid gap-4">
      <Toolbar loading={loading} onReload={reload} error={error} staleAt={staleAt} />
      {anyProwlarr && <p className="m-0 text-xs text-zinc-500">{t("adminArr.system.prowlarrHint")}</p>}
      <InstanceErrors report={report} />
      {report.results.map((r) => {
        const card = cardKey(r.service, r.instance);
        const ixKey = sectionKey(card, "indexer");
        const dcKey = sectionKey(card, "downloadClient");
        return (
          <ProviderCard
            key={card}
            result={r}
            title={labelOf(report, r.service, r.instance)}
            indexers={sectionOf(indexers, ixKey)}
            clients={sectionOf(clients, dcKey)}
            indexerBusy={busy[ixKey]}
            clientBusy={busy[dcKey]}
            prowlarrAsk={prowlarrAsk?.card === card ? prowlarrAsk : null}
            onTestIndexers={(id) => void test("indexer", setIndexers, r.service, r.instance, r.indexers, id)}
            onTestClients={(id) => void test("downloadClient", setClients, r.service, r.instance, r.downloadClients, id)}
            onSaveIndexer={(ix, against, change, opts) => void toggle("indexer", PROVIDER_SAVED.indexer, setIndexers, r.service, r.instance, ix, against, change, opts)}
            onSaveClient={(dc, against, change, opts) => void toggle("downloadClient", PROVIDER_SAVED.downloadClient, setClients, r.service, r.instance, dc, against, change, opts)}
            onCancelAsk={() => setProwlarrAsk(null)}
            onDropIndexerHeld={(id) => setIndexers((m) => updateSection(m, ixKey, (s) => dropHeld(s, id)))}
            onDropClientHeld={(id) => setClients((m) => updateSection(m, dcKey, (s) => dropHeld(s, id)))}
          />
        );
      })}
    </div>
  );
}

type Save<P> = (provider: P, against: string, change: Change, opts?: ToggleOpts) => void;

/** One instance's indexers and download clients, each kind with its Test All. */
function ProviderCard({
  result: r, title, indexers, clients, indexerBusy, clientBusy, prowlarrAsk, onTestIndexers, onTestClients,
  onSaveIndexer, onSaveClient, onCancelAsk, onDropIndexerHeld, onDropClientHeld,
}: {
  result: { service: ArrServiceName; instance: string } & ProvidersResult;
  title: string;
  indexers: SectionState<ArrIndexer>;
  clients: SectionState<ArrDownloadClient>;
  /** Each kind's action in flight, if any: every control of that kind waits. */
  indexerBusy: string | undefined;
  clientBusy: string | undefined;
  /** A Prowlarr-managed indexer's switch on this card, waiting to be confirmed. */
  prowlarrAsk: { id: number; change: Change } | null;
  /** Test one (an id) or every one (null) of the kind. */
  onTestIndexers: (id: number | null) => void;
  onTestClients: (id: number | null) => void;
  onSaveIndexer: Save<ArrIndexer>;
  onSaveClient: Save<ArrDownloadClient>;
  onCancelAsk: () => void;
  onDropIndexerHeld: (id: number) => void;
  onDropClientHeld: (id: number) => void;
}) {
  const t = useT();
  const ixList = listSignature(r.indexers);
  const dcList = listSignature(r.downloadClients);
  const tagList = (ids: number[]) => tagLabels(r.tags, ids);
  return (
    <Card title={title}>
      <div className="grid gap-2">
        <SectionHeader
          heading={t("adminArr.system.indexers")}
          service={r.service}
          summary={visibleSummary(indexers.summary, ixList)}
          all={visibleVerdict(indexers.all, ixList)}
          busy={indexerBusy}
          empty={r.indexers.length === 0}
          onTestAll={() => onTestIndexers(null)}
        />
        {r.indexers.length === 0 ? (
          <p className="m-0 text-xs text-zinc-500">{t("adminArr.system.noIndexers")}</p>
        ) : (
          <ul className="m-0 grid list-none gap-0 rounded-lg p-0" style={{ border: "1px solid var(--ds-border)" }}>
            {r.indexers.map((orig, i) => {
              const row = indexers.rows[orig.id];
              const ix = row?.override ?? orig;
              const against = providerSignature(orig);
              return (
                <IndexerRow
                  key={ix.id}
                  ix={ix}
                  first={i === 0}
                  service={r.service}
                  busy={indexerBusy}
                  tags={tagList(ix.tags)}
                  view={visibleVerdict(row?.result, against)}
                  onTest={() => onTestIndexers(ix.id)}
                  onToggle={(change) => onSaveIndexer(ix, against, change)}
                  prompts={
                    <ProviderPrompts
                      name={ix.name}
                      ask={prowlarrAsk?.id === ix.id ? prowlarrAsk.change : null}
                      held={row?.held}
                      busy={indexerBusy}
                      toggling={indexerBusy === `toggle:${ix.id}`}
                      onCancelAsk={onCancelAsk}
                      onConfirmAsk={(change) => onSaveIndexer(ix, against, change, { confirmed: true })}
                      onDropHeld={() => onDropIndexerHeld(ix.id)}
                      onAccept={(change) => onSaveIndexer(ix, against, change, { acceptWarnings: true, confirmed: true })}
                    />
                  }
                />
              );
            })}
          </ul>
        )}
      </div>

      <div className="grid gap-2">
        <SectionHeader
          heading={t("adminArr.system.downloadClients")}
          service={r.service}
          summary={visibleSummary(clients.summary, dcList)}
          all={visibleVerdict(clients.all, dcList)}
          busy={clientBusy}
          empty={r.downloadClients.length === 0}
          onTestAll={() => onTestClients(null)}
        />
        {r.downloadClients.length === 0 ? (
          <p className="m-0 text-xs text-zinc-500">{t("adminArr.system.noClients")}</p>
        ) : (
          <ul className="m-0 grid list-none gap-0 rounded-lg p-0" style={{ border: "1px solid var(--ds-border)" }}>
            {r.downloadClients.map((orig, i) => {
              const row = clients.rows[orig.id];
              const dc = row?.override ?? orig;
              const against = providerSignature(orig);
              return (
                <ClientRow
                  key={dc.id}
                  dc={dc}
                  first={i === 0}
                  service={r.service}
                  busy={clientBusy}
                  tags={tagList(dc.tags)}
                  view={visibleVerdict(row?.result, against)}
                  onTest={() => onTestClients(dc.id)}
                  onToggle={(change) => onSaveClient(dc, against, change)}
                  prompts={
                    <ProviderPrompts
                      name={dc.name}
                      ask={null}
                      held={row?.held}
                      busy={clientBusy}
                      toggling={clientBusy === `toggle:${dc.id}`}
                      onCancelAsk={onCancelAsk}
                      onConfirmAsk={(change) => onSaveClient(dc, against, change, { confirmed: true })}
                      onDropHeld={() => onDropClientHeld(dc.id)}
                      onAccept={(change) => onSaveClient(dc, against, change, { acceptWarnings: true, confirmed: true })}
                    />
                  }
                />
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}

/** A provider's tags by the instance's own labels; an id the instance didn't list shows as #id. */
function tagLabels(tags: ArrTag[] | undefined, ids: number[]): string {
  return ids.map((id) => tags?.find((tag) => tag.id === id)?.label ?? `#${id}`).join(", ");
}

/** A test's or a save's outcome under its row (or, for Test All, beside the section's heading). */
function TestResultLine({ view, service }: { view: TestView | undefined; service: ArrServiceName }) {
  const t = useT();
  if (!view) return null;
  if (view.pending) {
    return (
      <span role="status" className="flex items-start gap-1 text-xs text-amber-400">
        <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> <span className="min-w-0" style={{ overflowWrap: "anywhere" }}>{view.messages.join(" ")}</span>
      </span>
    );
  }
  if (view.ok && !view.warning) {
    return <span className="flex items-center gap-1 text-xs text-green-400"><Check className="h-3.5 w-3.5" /> {t("adminArr.system.testOk")}</span>;
  }
  if (view.ok) {
    return (
      <span className="flex items-start gap-1 text-xs text-amber-400">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> <span className="min-w-0" style={{ overflowWrap: "anywhere" }}>{t("adminArr.system.testWarnings")}{view.messages.length > 0 && `: ${view.messages.join(" ")}`}</span>
      </span>
    );
  }
  // Not a failure we can name: Test All didn't say whether these were only
  // warnings, and the row's own Test will.
  if (view.uncertain === true) {
    return (
      <span className="flex items-start gap-1 text-xs" style={{ color: "var(--ds-fg-muted)" }}>
        <CircleDashed className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />{" "}
        <span className="min-w-0" style={{ overflowWrap: "anywhere" }}>
          {t("adminArr.system.testUncertain", { service: SERVICE_LABEL[service] })}{view.messages.length > 0 && `: ${view.messages.join(" ")}`}
        </span>
      </span>
    );
  }
  return (
    <span className="flex items-start gap-1 text-xs" style={{ color: "var(--ds-danger)" }}>
      <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> <span className="min-w-0" style={{ overflowWrap: "anywhere" }}>{view.messages.join(" ") || t("adminArr.system.testFailed")}</span>
    </span>
  );
}

/** The last Test All of a kind: how many answered, how many work, how many the arr's answer left unclear. */
function SummaryLine({ summary: s }: { summary: Summary | undefined }) {
  const t = useT();
  if (!s) return null;
  if (s.count === 0) return <span className="text-xs text-zinc-400">{t("adminArr.system.testNothing")}</span>;
  // Nothing known to have failed (the rest are unclear) is neutral, not a warning.
  const tone = s.working === s.count ? "text-green-400" : s.working + s.uncertain === s.count ? "text-zinc-400" : "text-amber-400";
  return (
    <span className={`text-xs ${tone}`}>
      {t("adminArr.system.testSummary", { working: s.working, count: s.count })}
      {s.uncertain > 0 && ` · ${t("adminArr.system.testSummaryUncertain", { count: s.uncertain })}`}
    </span>
  );
}

// The head of a card's indexer or download-client section: its last Test All
// (summary, or the refusal for the whole kind) and the Test All button.
function SectionHeader({ heading, service, summary, all, busy, empty, onTestAll }: {
  heading: string;
  service: ArrServiceName;
  summary: Summary | undefined;
  all: TestView | undefined;
  /** The section's action in flight, if any. */
  busy: string | undefined;
  empty: boolean;
  onTestAll: () => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="m-0 text-xs font-semibold uppercase tracking-wide text-zinc-500">{heading}</h3>
      <span className="flex-1" />
      <SummaryLine summary={summary} />
      <TestResultLine view={all} service={service} />
      <Button variant="outline" size="xs" disabled={busy !== undefined || empty} onClick={onTestAll}>
        {busy === "test:all" && <Loader2 className="animate-spin" />} {t("adminArr.system.testAll")}
      </Button>
    </div>
  );
}

// What stands between a switch and the arr: a Prowlarr confirm, or warnings to accept.
function ProviderPrompts({ name, ask, held, busy, toggling, onCancelAsk, onConfirmAsk, onDropHeld, onAccept }: {
  name: string;
  /** The switch a Prowlarr-managed indexer is waiting to confirm. */
  ask: Change | null;
  held: Held | undefined;
  busy: string | undefined;
  /** This provider's save is the one in flight. */
  toggling: boolean;
  onCancelAsk: () => void;
  onConfirmAsk: (change: Change) => void;
  onDropHeld: () => void;
  onAccept: (change: Change) => void;
}) {
  const t = useT();
  return (
    <>
      {ask && (
        <span className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-300">
          {t("adminArr.system.prowlarrConfirm", { name })}
          <Button variant="ghost" size="xs" onClick={onCancelAsk}>{t("adminArr.common.cancel")}</Button>
          <Button size="xs" disabled={busy !== undefined} onClick={() => onConfirmAsk(ask)}>
            {t("adminArr.system.changeAnyway")}
          </Button>
        </span>
      )}
      {held && (
        <div role="alert" className="grid gap-1 text-xs text-amber-400">
          <span className="flex items-center gap-1"><AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {t("adminArr.system.warningsHeld")}</span>
          {held.messages.length > 0 && (
            <ul className="m-0 grid list-disc gap-0.5 pl-5">{held.messages.map((m) => <li key={m} style={{ overflowWrap: "anywhere" }}>{m}</li>)}</ul>
          )}
          <span className="flex flex-wrap items-center gap-1.5">
            <Button variant="ghost" size="xs" disabled={busy !== undefined} onClick={onDropHeld}>{t("adminArr.common.cancel")}</Button>
            <Button size="xs" disabled={busy !== undefined} onClick={() => onAccept(held.change)}>
              {toggling && <Loader2 className="animate-spin" />} {t("adminArr.system.switchAnyway")}
            </Button>
          </span>
        </div>
      )}
    </>
  );
}

const INDEXER_USES = [
  ["enableRss", "adminArr.system.rss", "supportsRss"],
  ["enableAutomaticSearch", "adminArr.system.automatic", "supportsSearch"],
  ["enableInteractiveSearch", "adminArr.system.interactive", "supportsSearch"],
] as const;

function IndexerRow({ ix, first, service, busy, tags, view, onTest, onToggle, prompts }: {
  ix: ArrIndexer;
  first: boolean;
  service: ArrServiceName;
  /** The section's action in flight, if any: every control in it waits. */
  busy: string | undefined;
  tags: string;
  view: TestView | undefined;
  onTest: () => void;
  onToggle: (change: Change) => void;
  prompts: React.ReactNode;
}) {
  const t = useT();
  return (
    <li className="grid gap-1.5 px-3 py-2" style={!first ? { borderTop: "1px solid var(--ds-border)" } : undefined}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-zinc-100">{ix.name}</span>
        <span className="text-xs text-zinc-500">
          {[ix.implementation, t(`adminManage.queue.protocol.${ix.protocol}`), ix.priority !== null ? t("adminArr.system.priority", { value: ix.priority }) : null].filter(Boolean).join(" · ")}
        </span>
        {ix.managedByProwlarr && <Chip title={t("adminArr.system.prowlarrHint")}>{t("adminArr.system.prowlarrChip")}</Chip>}
        {ix.tags.length > 0 && <span className="text-xs text-zinc-500">{t("adminArr.system.tags", { list: tags })}</span>}
        <span className="flex-1" />
        <Button variant="ghost" size="xs" disabled={busy !== undefined} onClick={onTest}>
          {busy === `test:${ix.id}` && <Loader2 className="animate-spin" />} {t("adminArr.system.test")}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-4 text-xs text-zinc-400">
        {INDEXER_USES.map(([field, label, supports]) => {
          const on = ix[field];
          // A use the indexer can't do (a Torrent RSS Feed can't search) is
          // not offered — as the arr's own dialog — but one that is somehow
          // on can still be switched off. Null (an arr that doesn't say) keeps it.
          const unsupported = ix[supports] === false && !on;
          return (
            <label key={field} className="flex items-center gap-1.5" title={unsupported ? t("adminArr.system.useUnsupportedHint", { service: SERVICE_LABEL[service] }) : undefined}>
              <Switch
                size="sm"
                checked={on}
                loading={busy === `toggle:${ix.id}`}
                disabled={busy !== undefined || unsupported}
                onCheckedChange={(v) => onToggle({ [field]: v })}
                aria-label={t("adminArr.system.toggleAria", { what: t(label), name: ix.name })}
              />
              {t(label)}
              {unsupported && <span className="text-zinc-500">({t("adminArr.system.useUnsupported")})</span>}
            </label>
          );
        })}
      </div>
      {prompts}
      <TestResultLine view={view} service={service} />
    </li>
  );
}

function ClientRow({ dc, first, service, busy, tags, view, onTest, onToggle, prompts }: {
  dc: ArrDownloadClient;
  first: boolean;
  service: ArrServiceName;
  busy: string | undefined;
  tags: string;
  view: TestView | undefined;
  onTest: () => void;
  onToggle: (change: Change) => void;
  prompts: React.ReactNode;
}) {
  const t = useT();
  return (
    <li className="grid gap-1.5 px-3 py-2" style={!first ? { borderTop: "1px solid var(--ds-border)" } : undefined}>
      <div className="flex flex-wrap items-center gap-2">
        <Switch
          size="sm"
          checked={dc.enable}
          loading={busy === `toggle:${dc.id}`}
          disabled={busy !== undefined}
          onCheckedChange={(v) => onToggle({ enable: v })}
          aria-label={t("adminArr.system.toggleAria", { what: t("adminArr.system.enabled"), name: dc.name })}
        />
        <span className="text-sm font-medium text-zinc-100">{dc.name}</span>
        <span className="text-xs text-zinc-500">
          {[dc.implementation, t(`adminManage.queue.protocol.${dc.protocol}`), dc.priority !== null ? t("adminArr.system.priority", { value: dc.priority }) : null].filter(Boolean).join(" · ")}
        </span>
        {!dc.enable && <Chip>{t("adminArr.system.off")}</Chip>}
        {dc.removeCompletedDownloads === false && (
          <Chip tone="pending" title={t("adminArr.system.removesCompletedOffHint", { service: SERVICE_LABEL[service] })}>
            {t("adminArr.system.removesCompletedOff")}
          </Chip>
        )}
        {dc.removeFailedDownloads === false && <Chip>{t("adminArr.system.removesFailedOff")}</Chip>}
        {dc.tags.length > 0 && <span className="text-xs text-zinc-500">{t("adminArr.system.tags", { list: tags })}</span>}
        <span className="flex-1" />
        <Button variant="ghost" size="xs" disabled={busy !== undefined} onClick={onTest}>
          {busy === `test:${dc.id}` && <Loader2 className="animate-spin" />} {t("adminArr.system.test")}
        </Button>
      </div>
      {prompts}
      <TestResultLine view={view} service={service} />
    </li>
  );
}
