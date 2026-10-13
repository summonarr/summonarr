// Admin → Arr System: the data half. Live reads across every configured,
// enabled Radarr and Sonarr instance (guardrail 32 — a failed instance is
// named, never read as "nothing there"), and the page's writes on one
// instance: run a scheduled task, run a library-wide search, cancel a queued
// command, test or switch an indexer / download client. Every call goes
// through arrFetch (guardrail 5). Nothing is cached; nothing in Summonarr is
// written except the audit rows the routes add.
import { ArrResponseError, arrErrorKind, arrErrorMessage, arrFetch, arrFetchNoContent } from "./arr";
import type { ArrErrorKind } from "./arr-error-kind";
import { configuredArrCfg, enabledArrInstances, postArrCommand, type ArrInstanceRef, type ArrService } from "./arr-admin";
import {
  bulkActionCommand,
  PROVIDER_PATH,
  projectCommands,
  projectDisks,
  projectDownloadClients,
  projectIndexers,
  projectRootFolders,
  projectTags,
  projectTasks,
  projectTestAll,
  providerChangeApplied,
  testResultOf,
  validationFailuresFromBody,
  withProviderEnabled,
  type ArrBulkAction,
  type ArrCommandRow,
  type ArrDisk,
  type ArrDownloadClient,
  type ArrIndexer,
  type ArrRootFolder,
  type ArrTag,
  type ArrTask,
  type ProviderEnableChange,
  type ProviderKind,
  type ProviderTestResult,
  unsupportedIndexerUse,
} from "./arr-system";
import { settleLimit } from "./concurrency";
import { forgetWarnOnChange, warnOnChange } from "./log-dedup";
import { processSingleton } from "./process-singleton";

const CONCURRENCY = 4;

// The Tasks tab re-reads every 15 s. Its two reads are small and a healthy arr
// answers at once, so a dark instance is given up on well inside a poll
// interval instead of holding the report for the 30 s default.
const POLLED_READ_TIMEOUT_MS = 10_000;

// Testing a provider waits on it: Test All runs every enabled one in turn, and
// a dead indexer can hang for ~100 s before the arr gives up on it. The same
// wait applies to a save that switches one ON (the arr tests it first). Cut off
// at the 30 s default, the admin saw a failure while the arr kept testing —
// and then, for a save, quietly saved. That is longer than a reverse proxy
// holds a request (nginx ~60 s, Cloudflare ~100 s), so Arr System runs tests
// and saves as background jobs (the providers routes' `async`).
const PROVIDER_TEST_TIMEOUT_MS = 120_000;

// Test All as a BACKGROUND job (the page always runs it as one): the arr tests
// the providers in turn, so two dead indexers already outlast 120 s and every
// attempt answered "timed out" with no per-provider result. Nothing holds this
// request open but our own job, so it may wait longer — inside the page's
// ~300 s of polls and the job's 10-minute result TTL. A synchronous Test All
// (an API caller, a proxy counting) and a single test keep 120 s.
const PROVIDER_TEST_ALL_JOB_TIMEOUT_MS = 270_000;

// A testing save that outlived that wait is read back. A request held open by
// the browser reads once (the proxy is already counting); a background save
// (`settle: "wait"`) re-reads a few more times while the arr finishes its
// test, so a save landing a little after the wait is still answered — and
// audited — as saved. One that lands after the last read is not (the arr's own
// log has it).
export const PROVIDER_SETTLE_READS = 6;
export const PROVIDER_SETTLE_INTERVAL_MS = 10_000;
let settlePause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Test seam: the pause between settle read-backs. */
export function _setProviderSettlePauseForTests(fn: ((ms: number) => Promise<void>) | null): void {
  settlePause = fn ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
}

export interface InstanceReport<T> {
  instances: ArrInstanceRef[];
  errors: Array<{ service: ArrService; instance: string; error: string; kind: ArrErrorKind }>;
  /** One entry per instance that was read, in `instances` order. */
  results: Array<{ service: ArrService; instance: string } & T>;
}

// The same fan-out for every tab: each instance read on its own, a failure
// named once per unchanged condition (guardrail 7b — the tabs poll).
async function perInstance<T>(scope: string, read: (inst: ArrInstanceRef) => Promise<T>): Promise<InstanceReport<T>> {
  const instances = await enabledArrInstances();
  const settled = await settleLimit(instances, CONCURRENCY, read);
  const report: InstanceReport<T> = { instances, errors: [], results: [] };
  settled.forEach((s, i) => {
    const inst = instances[i];
    const logKey = `arr-system:${scope}:${inst.service}:${inst.slug}`;
    if (s.status === "fulfilled") {
      report.results.push({ service: inst.service, instance: inst.slug, ...s.value });
      forgetWarnOnChange(logKey);
      return;
    }
    const error = arrErrorMessage(s.reason);
    report.errors.push({ service: inst.service, instance: inst.slug, error, kind: arrErrorKind(s.reason) });
    warnOnChange(logKey, error, `[arr-system] ${inst.service} instance "${inst.slug}" ${scope} read failed: ${error}`);
  });
  return report;
}

// ── tasks and commands ───────────────────────────────────────────────────────

export function loadTasks(): Promise<InstanceReport<{ tasks: ArrTask[]; commands: ArrCommandRow[] }>> {
  return perInstance("tasks", async (inst) => {
    const cfg = await configuredArrCfg(inst.service, inst.slug);
    const [tasks, commands] = await Promise.all([
      arrFetch<unknown>(cfg, "/api/v3/system/task", { quietErrors: true, timeoutMs: POLLED_READ_TIMEOUT_MS }),
      arrFetch<unknown>(cfg, "/api/v3/command", { quietErrors: true, timeoutMs: POLLED_READ_TIMEOUT_MS }),
    ]);
    return { tasks: projectTasks(tasks), commands: projectCommands(commands) };
  });
}

/** The task is not one of the instance's scheduled tasks. */
export class UnknownTaskError extends Error {}

/**
 * Run one of the instance's scheduled tasks now. The name must be one the
 * instance lists as a scheduled task, read now — never an arbitrary command.
 */
export async function runTask(service: ArrService, instance: string, taskName: string): Promise<{ id: number | null }> {
  const cfg = await configuredArrCfg(service, instance);
  const tasks = projectTasks(await arrFetch<unknown>(cfg, "/api/v3/system/task"));
  if (!tasks.some((t) => t.taskName === taskName)) throw new UnknownTaskError(taskName);
  return postArrCommand(cfg, { name: taskName });
}

export async function runBulkAction(service: ArrService, instance: string, action: ArrBulkAction): Promise<{ id: number | null }> {
  const cfg = await configuredArrCfg(service, instance);
  return postArrCommand(cfg, bulkActionCommand(service, action));
}

/** The command is not queued on the instance (started, finished, or unknown). */
export class CommandNotQueuedError extends Error {}

/** Cancel a command that is still QUEUED (the arr refuses to stop a started one). */
export async function cancelCommand(service: ArrService, instance: string, commandId: number): Promise<void> {
  const cfg = await configuredArrCfg(service, instance);
  const commands = projectCommands(await arrFetch<unknown>(cfg, "/api/v3/command"), Number.MAX_SAFE_INTEGER);
  if (!commands.some((c) => c.id === commandId && c.status === "queued")) throw new CommandNotQueuedError();
  try {
    await arrFetchNoContent(cfg, `/api/v3/command/${commandId}`, { method: "DELETE" });
  } catch (err) {
    // It started between the read and the cancel: the arr answers 409 "Unable
    // to cancel task" (400 on some builds) — the same "no longer queued".
    if (err instanceof ArrResponseError && (err.status === 409 || err.status === 400)) throw new CommandNotQueuedError();
    throw err;
  }
}

// ── indexers and download clients ────────────────────────────────────────────

export function loadProviders(): Promise<InstanceReport<{ indexers: ArrIndexer[]; downloadClients: ArrDownloadClient[]; tags: ArrTag[] }>> {
  return perInstance("providers", async (inst) => {
    const cfg = await configuredArrCfg(inst.service, inst.slug);
    const [indexers, clients, tags] = await Promise.all([
      arrFetch<unknown>(cfg, "/api/v3/indexer", { quietErrors: true }),
      arrFetch<unknown>(cfg, "/api/v3/downloadclient", { quietErrors: true }),
      // Only names the tags; without it the page shows their ids, never fails.
      arrFetch<unknown>(cfg, "/api/v3/tag", { quietErrors: true }).catch(() => []),
    ]);
    return { indexers: projectIndexers(indexers), downloadClients: projectDownloadClients(clients), tags: projectTags(tags) };
  });
}

/** The provider is not on the instance. */
export class ProviderNotFoundError extends Error {}
/** The arr refused the change or the test; `messages` is its own (masked) reason. */
export class ProviderRejectedError extends Error {
  readonly messages: string[];
  constructor(messages: string[]) {
    super("provider rejected");
    this.messages = messages;
  }
}
/**
 * Switching it ON was refused for WARNINGS alone: the arr tests a provider
 * before saving it on, and refuses on a warning too. The admin may accept
 * them (setProviderEnabled's `acceptWarnings`).
 */
export class ProviderWarningsError extends ProviderRejectedError {}

async function readProvider(service: ArrService, instance: string, kind: ProviderKind, id: number) {
  const cfg = await configuredArrCfg(service, instance);
  try {
    const raw = await arrFetch<unknown>(cfg, `${PROVIDER_PATH[kind]}/${id}`);
    if (!raw || typeof raw !== "object" || (raw as { id?: unknown }).id !== id) throw new ProviderNotFoundError();
    return { cfg, raw };
  } catch (err) {
    if (err instanceof ArrResponseError && err.status === 404) throw new ProviderNotFoundError();
    throw err;
  }
}

function rejectedOr(err: unknown): never {
  if (err instanceof ArrResponseError && err.status === 400) throw new ProviderRejectedError(validationFailuresFromBody(err.body).messages);
  throw err;
}

function projectProvider(kind: ProviderKind, raw: unknown): ArrIndexer | ArrDownloadClient {
  const projected = kind === "indexer" ? projectIndexers([raw])[0] : projectDownloadClients([raw])[0];
  if (!projected) throw new ProviderNotFoundError();
  return projected;
}

/**
 * Test every indexer or download client on the instance (the arr's Test All),
 * or one by id — the one is read from the arr and sent back to its test
 * endpoint server-side, so its stored credentials never leave the server. A
 * provider with only warnings is working, with warnings (testResultOf).
 */
export async function testProviders(
  service: ArrService,
  instance: string,
  kind: ProviderKind,
  id: number | null,
  opts: { background?: boolean } = {},
): Promise<ProviderTestResult[]> {
  if (id === null) {
    const cfg = await configuredArrCfg(service, instance);
    const timeoutMs = opts.background === true ? PROVIDER_TEST_ALL_JOB_TIMEOUT_MS : PROVIDER_TEST_TIMEOUT_MS;
    try {
      return projectTestAll(await arrFetch<unknown>(cfg, `${PROVIDER_PATH[kind]}/testall`, { method: "POST", timeoutMs }));
    } catch (err) {
      // The arrs answer Test All with 400 when ANY provider failed — the body
      // is still the per-provider list.
      if (err instanceof ArrResponseError && err.status === 400) {
        try {
          const results = projectTestAll(JSON.parse(err.body));
          if (results.length > 0) return results;
        } catch {
          // not the list — the arr's own refusal
        }
      }
      return rejectedOr(err);
    }
  }
  const { cfg, raw } = await readProvider(service, instance, kind, id);
  try {
    await arrFetchNoContent(cfg, `${PROVIDER_PATH[kind]}/test`, { method: "POST", body: JSON.stringify(raw), timeoutMs: PROVIDER_TEST_TIMEOUT_MS });
    return [testResultOf(id, true, { messages: [], warningsOnly: false })];
  } catch (err) {
    if (err instanceof ArrResponseError && err.status === 400) return [testResultOf(id, false, validationFailuresFromBody(err.body))];
    throw err;
  }
}

export interface ProviderChangeResult {
  /** The provider as the arr now holds it. */
  provider: ArrIndexer | ArrDownloadClient;
  /** The change is saved. False only when the save timed out and the arr's copy, read back, does not carry it. */
  applied: boolean;
  /** The arr was still testing when we stopped waiting; `provider` is what it held when (last) read back. */
  timedOut: boolean;
}

/**
 * After a testing save timed out: what the arr holds now — read once, or with
 * `settle: "wait"` up to PROVIDER_SETTLE_READS more times, PROVIDER_SETTLE_INTERVAL_MS
 * apart, until it carries the change. A later read that fails keeps the last
 * answer (the first read's failure is the caller's).
 */
async function readBackAfterTimeout(
  service: ArrService,
  instance: string,
  kind: ProviderKind,
  id: number,
  change: ProviderEnableChange,
  settle: "once" | "wait",
): Promise<ProviderChangeResult> {
  let { raw: now } = await readProvider(service, instance, kind, id);
  for (let i = 0; settle === "wait" && i < PROVIDER_SETTLE_READS && !providerChangeApplied(now, change); i++) {
    await settlePause(PROVIDER_SETTLE_INTERVAL_MS);
    try {
      now = (await readProvider(service, instance, kind, id)).raw;
    } catch {
      break;
    }
  }
  return { provider: projectProvider(kind, now), applied: providerChangeApplied(now, change), timedOut: true };
}

/** The change switches ON a use the indexer reports it can't do (supportsRss / supportsSearch false). */
export class ProviderUseUnsupportedError extends Error {
  readonly use: "rss" | "search";
  constructor(use: "rss" | "search") {
    super("indexer use not supported");
    this.use = use;
  }
}

// Saves to ONE provider, one at a time (per process — the single long-lived
// server). Each save is a read-modify-write of the arr's WHOLE resource, and a
// testing save holds its body at the arr for up to two minutes before the arr
// writes it, so two overlapping saves to one provider (another tab, another
// admin, an API caller) let the later write put back the flag the other one
// changed — both answered, both audited. A change is a flag DELTA, so a save
// that waits for the one before it and then reads the fresh resource applies
// its own delta on top. Still open, and accepted: a save that timed out on OUR
// side and that the arr only lands after the read-backs can still be
// overwritten by the next one.
const providerSaveLocks = processSingleton("arr-system-data:provider-save-locks", () => new Map<string, Promise<unknown>>());

async function withProviderLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = providerSaveLocks.get(key) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  providerSaveLocks.set(key, tail);
  try {
    return await run;
  } finally {
    if (providerSaveLocks.get(key) === tail) providerSaveLocks.delete(key);
  }
}

/**
 * Switch an indexer's uses or a download client on/off: the arr's own resource
 * is read, only the flags change, and it is saved back. Saves to one provider
 * are taken one at a time (withProviderLock), each reading the resource only
 * once the one before it has finished.
 *
 *   • A use the fresh read says the indexer can't do (supportsRss /
 *     supportsSearch false) is never switched ON — ProviderUseUnsupportedError,
 *     nothing sent. The arr would save it, and nothing would ever use it.
 *   • A change that only turns things OFF is saved with `forceSave` — the arr
 *     otherwise re-tests an indexer that still has another use on, so a failing
 *     indexer could never be partly switched off.
 *   • Turning one ON lets the arr test it. A failing test is
 *     ProviderRejectedError with its reason; a test that only WARNED is
 *     ProviderWarningsError — the arr refuses a save on warnings too.
 *   • `acceptWarnings` (the admin saw those warnings and said "switch on
 *     anyway"): the arr's own /test is re-run here, server-side, on the changed
 *     resource, and only when it reports no errors — warnings, or nothing — is
 *     it saved with `forceSave`. An error is still ProviderRejectedError, and
 *     the browser can never turn a failing test into a save.
 *   • A save that waits on the arr's test and times out is read back: the arr
 *     saves once its test passes, so the answer is what it holds now — read
 *     once, or (`settle: "wait"`, a background save) re-read until it holds
 *     the change or PROVIDER_SETTLE_READS more reads have passed.
 */
export async function setProviderEnabled(
  service: ArrService,
  instance: string,
  kind: ProviderKind,
  id: number,
  change: ProviderEnableChange,
  opts: { acceptWarnings?: boolean; settle?: "once" | "wait" } = {},
): Promise<ProviderChangeResult> {
  return withProviderLock([service, instance, kind, id].join("\u0000"), () => saveProvider(service, instance, kind, id, change, opts));
}

async function saveProvider(
  service: ArrService,
  instance: string,
  kind: ProviderKind,
  id: number,
  change: ProviderEnableChange,
  opts: { acceptWarnings?: boolean; settle?: "once" | "wait" },
): Promise<ProviderChangeResult> {
  const { cfg, raw } = await readProvider(service, instance, kind, id);
  const unsupported = kind === "indexer" ? unsupportedIndexerUse(raw, change) : null;
  if (unsupported) throw new ProviderUseUnsupportedError(unsupported);
  const body = JSON.stringify(withProviderEnabled(raw, change));
  const onlyOff = Object.values(change).every((v) => v === false);
  let forceSave = onlyOff;
  if (!onlyOff && opts.acceptWarnings) {
    try {
      await arrFetchNoContent(cfg, `${PROVIDER_PATH[kind]}/test`, { method: "POST", body, timeoutMs: PROVIDER_TEST_TIMEOUT_MS });
    } catch (err) {
      if (!(err instanceof ArrResponseError && err.status === 400)) throw err;
      const failures = validationFailuresFromBody(err.body);
      if (!failures.warningsOnly) throw new ProviderRejectedError(failures.messages);
    }
    forceSave = true;
  }
  let saved: unknown;
  try {
    saved = await arrFetch<unknown>(cfg, `${PROVIDER_PATH[kind]}/${id}${forceSave ? "?forceSave=true" : ""}`, {
      method: "PUT",
      body,
      // forceSave skips the arr's test, so only a testing save waits long.
      ...(forceSave ? {} : { timeoutMs: PROVIDER_TEST_TIMEOUT_MS }),
    });
  } catch (err) {
    if (err instanceof ArrResponseError && err.status === 400) {
      const failures = validationFailuresFromBody(err.body);
      throw !forceSave && failures.warningsOnly ? new ProviderWarningsError(failures.messages) : new ProviderRejectedError(failures.messages);
    }
    if (!forceSave && arrErrorKind(err) === "timeout") {
      return readBackAfterTimeout(service, instance, kind, id, change, opts.settle ?? "once");
    }
    throw err;
  }
  return { provider: projectProvider(kind, saved), applied: true, timedOut: false };
}

// ── storage ──────────────────────────────────────────────────────────────────

export function loadStorage(): Promise<InstanceReport<{ rootFolders: ArrRootFolder[]; disks: ArrDisk[] }>> {
  return perInstance("storage", async (inst) => {
    const cfg = await configuredArrCfg(inst.service, inst.slug);
    const [roots, diskRaw] = await Promise.all([
      arrFetch<unknown>(cfg, "/api/v3/rootfolder", { quietErrors: true }),
      arrFetch<unknown>(cfg, "/api/v3/diskspace", { quietErrors: true }),
    ]);
    const disks = projectDisks(diskRaw);
    return { rootFolders: projectRootFolders(roots, disks), disks };
  });
}
