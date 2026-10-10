// Admin → Arr System: the data half. Live reads across every configured,
// enabled Radarr and Sonarr instance (guardrail 32 — a failed instance is
// named, never read as "nothing there"), and the page's writes on one
// instance: run a scheduled task, run a library-wide search, cancel a queued
// command, test or switch an indexer / download client. Every call goes
// through arrFetch (guardrail 5). Nothing is cached; nothing in Summonarr is
// written except the audit rows the routes add.
import { ArrResponseError, arrErrorMessage, arrFetch, arrFetchNoContent } from "./arr";
import { configuredArrCfg, enabledArrInstances, postArrCommand, type ArrInstanceRef, type ArrService } from "./arr-admin";
import {
  bulkActionCommand,
  PROVIDER_PATH,
  projectCommands,
  projectDisks,
  projectDownloadClients,
  projectIndexers,
  projectRootFolders,
  projectTasks,
  projectTestAll,
  validationMessagesFromBody,
  withProviderEnabled,
  type ArrBulkAction,
  type ArrCommandRow,
  type ArrDisk,
  type ArrDownloadClient,
  type ArrIndexer,
  type ArrRootFolder,
  type ArrTask,
  type ProviderEnableChange,
  type ProviderKind,
  type ProviderTestResult,
} from "./arr-system";
import { settleLimit } from "./concurrency";
import { forgetWarnOnChange, warnOnChange } from "./log-dedup";

const CONCURRENCY = 4;

export interface InstanceReport<T> {
  instances: ArrInstanceRef[];
  errors: Array<{ service: ArrService; instance: string; error: string }>;
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
    report.errors.push({ service: inst.service, instance: inst.slug, error });
    warnOnChange(logKey, error, `[arr-system] ${inst.service} instance "${inst.slug}" ${scope} read failed: ${error}`);
  });
  return report;
}

// ── tasks and commands ───────────────────────────────────────────────────────

export function loadTasks(): Promise<InstanceReport<{ tasks: ArrTask[]; commands: ArrCommandRow[] }>> {
  return perInstance("tasks", async (inst) => {
    const cfg = await configuredArrCfg(inst.service, inst.slug);
    const [tasks, commands] = await Promise.all([
      arrFetch<unknown>(cfg, "/api/v3/system/task", { quietErrors: true }),
      arrFetch<unknown>(cfg, "/api/v3/command", { quietErrors: true }),
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
  await arrFetchNoContent(cfg, `/api/v3/command/${commandId}`, { method: "DELETE" });
}

// ── indexers and download clients ────────────────────────────────────────────

export function loadProviders(): Promise<InstanceReport<{ indexers: ArrIndexer[]; downloadClients: ArrDownloadClient[] }>> {
  return perInstance("providers", async (inst) => {
    const cfg = await configuredArrCfg(inst.service, inst.slug);
    const [indexers, status, clients] = await Promise.all([
      arrFetch<unknown>(cfg, "/api/v3/indexer", { quietErrors: true }),
      // The status list only says which are failing; without it they read as healthy.
      arrFetch<unknown>(cfg, "/api/v3/indexerstatus", { quietErrors: true }).catch(() => []),
      arrFetch<unknown>(cfg, "/api/v3/downloadclient", { quietErrors: true }),
    ]);
    return { indexers: projectIndexers(indexers, status), downloadClients: projectDownloadClients(clients) };
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
  if (err instanceof ArrResponseError && err.status === 400) throw new ProviderRejectedError(validationMessagesFromBody(err.body));
  throw err;
}

/**
 * Test every indexer or download client on the instance (the arr's Test All),
 * or one by id — the one is read from the arr and sent back to its test
 * endpoint server-side, so its stored credentials never leave the server.
 */
export async function testProviders(service: ArrService, instance: string, kind: ProviderKind, id: number | null): Promise<ProviderTestResult[]> {
  if (id === null) {
    const cfg = await configuredArrCfg(service, instance);
    try {
      return projectTestAll(await arrFetch<unknown>(cfg, `${PROVIDER_PATH[kind]}/testall`, { method: "POST" }));
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
    await arrFetchNoContent(cfg, `${PROVIDER_PATH[kind]}/test`, { method: "POST", body: JSON.stringify(raw) });
    return [{ id, ok: true, messages: [] }];
  } catch (err) {
    if (err instanceof ArrResponseError && err.status === 400) return [{ id, ok: false, messages: validationMessagesFromBody(err.body) }];
    throw err;
  }
}

/**
 * Switch an indexer's uses or a download client on/off: the arr's own resource
 * is read, only the flags change, and it is saved back. A change that only
 * turns things OFF is saved with `forceSave` — the arr otherwise re-tests an
 * indexer that still has another use on, so a failing indexer could never be
 * partly switched off. Turning one ON lets the arr test it; a failing test is
 * ProviderRejectedError with its reason.
 */
export async function setProviderEnabled(
  service: ArrService,
  instance: string,
  kind: ProviderKind,
  id: number,
  change: ProviderEnableChange,
): Promise<ArrIndexer | ArrDownloadClient> {
  const { cfg, raw } = await readProvider(service, instance, kind, id);
  let saved: unknown;
  try {
    const onlyOff = Object.values(change).every((v) => v === false);
    saved = await arrFetch<unknown>(cfg, `${PROVIDER_PATH[kind]}/${id}${onlyOff ? "?forceSave=true" : ""}`, {
      method: "PUT",
      body: JSON.stringify(withProviderEnabled(raw, change)),
    });
  } catch (err) {
    return rejectedOr(err);
  }
  const projected = kind === "indexer" ? projectIndexers([saved])[0] : projectDownloadClients([saved])[0];
  if (!projected) throw new ProviderNotFoundError();
  return projected;
}

// ── storage ──────────────────────────────────────────────────────────────────

export function loadStorage(): Promise<InstanceReport<{ rootFolders: ArrRootFolder[]; disks: ArrDisk[] }>> {
  return perInstance("storage", async (inst) => {
    const cfg = await configuredArrCfg(inst.service, inst.slug);
    const [roots, disks] = await Promise.all([
      arrFetch<unknown>(cfg, "/api/v3/rootfolder", { quietErrors: true }),
      arrFetch<unknown>(cfg, "/api/v3/diskspace", { quietErrors: true }),
    ]);
    return { rootFolders: projectRootFolders(roots), disks: projectDisks(disks) };
  });
}
