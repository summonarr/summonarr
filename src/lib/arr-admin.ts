// Shared data plumbing for the admin Radarr/Sonarr surfaces added after the
// Download Queue and Missing pages: the title manager (arr-title-data.ts), the
// download history and blocklist (arr-history-data.ts), the calendar
// (arr-calendar-data.ts) and the system page (arr-system-data.ts). Every call
// goes through arrFetch (guardrail 5) on an instance the registry lists and
// has a connection for (guardrail 32).
import { ArrResponseError, arrFetch, getArrCfg, type ArrCfg } from "./arr";
import { projectCommandState, type ArrCommandState } from "./arr-command-status";
import { getSyncableArrInstances } from "./arr-instance-registry";
import type { ArrService } from "./arr-instances";
import { mapLimit } from "./concurrency";
import { isFeatureEnabled } from "./features";

export type { ArrService };
export const ARR_SERVICES: readonly ArrService[] = ["radarr", "sonarr"];
export const ARR_SERVICE_LABEL: Record<ArrService, string> = { radarr: "Radarr", sonarr: "Sonarr" };

export function parseArrService(v: unknown): ArrService | null {
  return v === "radarr" || v === "sonarr" ? v : null;
}

/** The instance named is not a configured one (or no longer is). */
export class ArrInstanceError extends Error {}

/**
 * The connection for one CONFIGURED instance. A slug is never turned into a
 * Setting-key read for an instance the registry doesn't list — a de-registered
 * instance's keys can outlive it.
 */
export async function configuredArrCfg(service: ArrService, instance: string): Promise<ArrCfg> {
  const configured = await getSyncableArrInstances(service);
  if (!configured.some((i) => i.slug === instance)) throw new ArrInstanceError(instance);
  const cfg = await getArrCfg(service, instance);
  if (!cfg) throw new ArrInstanceError(instance);
  return cfg;
}

export interface ArrInstanceRef { service: ArrService; slug: string; name: string }

/** Every configured instance of every service whose integration is switched on, in registry order. */
export async function enabledArrInstances(only?: ArrService): Promise<ArrInstanceRef[]> {
  const out: ArrInstanceRef[] = [];
  for (const service of ARR_SERVICES) {
    if (only && service !== only) continue;
    if (!(await isFeatureEnabled(`feature.integration.${service}`))) continue;
    for (const inst of await getSyncableArrInstances(service)) out.push({ service, slug: inst.slug, name: inst.name });
  }
  return out;
}

/**
 * Queue one command on an instance. Radarr/Sonarr run it in the background;
 * the answer is the command as queued, whose id the caller may report.
 */
export async function postArrCommand(cfg: ArrCfg, body: Record<string, unknown>): Promise<{ id: number | null }> {
  const res = await arrFetch<{ id?: unknown } | null>(cfg, "/api/v3/command", { method: "POST", body: JSON.stringify(body) });
  const id = res && typeof res === "object" && typeof res.id === "number" && Number.isSafeInteger(res.id) ? res.id : null;
  return { id };
}

/**
 * The arr's ids for the commands a route queued, for the browser to follow
 * (GET /api/admin/arr/commands): deduplicated — a duplicate push answers with
 * the command already queued — and without the ones the arr sent no id for.
 */
export function commandIdsOf(queued: ReadonlyArray<{ id: number | null }>): number[] {
  return [...new Set(queued.map((c) => c.id).filter((id): id is number => id !== null))];
}

// The status line polls every 2 s; a dark instance is given up on well before
// the next poll would stack behind it.
const COMMAND_READ_TIMEOUT_MS = 10_000;
/**
 * Reads of one status poll in flight at once (guardrail 31): a long series'
 * "search missing" follows dozens of commands, and the poll repeats every 2 s.
 */
export const COMMAND_READ_CONCURRENCY = 6;

/**
 * The commands a page is following, each read on its own (GET
 * /api/v3/command/{id}) — at most COMMAND_READ_CONCURRENCY at a time, in the
 * order asked. Projected to the fields Arr System shows, never the command
 * body (guardrail 5e). An id the arr answers 404 for is "gone": it forgets a
 * finished command after a while. Any other failure fails the read, and the
 * ids not yet started are never sent — a dark instance costs one round of
 * timeouts, not one per id. Polled, so a failure is not logged per read (the
 * route reports it).
 */
export async function readArrCommands(service: ArrService, instance: string, ids: readonly number[]): Promise<ArrCommandState[]> {
  const cfg = await configuredArrCfg(service, instance);
  let failure: { err: unknown } | null = null;
  return mapLimit(ids, COMMAND_READ_CONCURRENCY, async (id): Promise<ArrCommandState> => {
    if (failure) throw failure.err;
    try {
      return projectCommandState(await arrFetch<unknown>(cfg, `/api/v3/command/${id}`, { quietErrors: true, timeoutMs: COMMAND_READ_TIMEOUT_MS }), id);
    } catch (err) {
      if (err instanceof ArrResponseError && err.status === 404) return { id, status: "gone" };
      failure ??= { err };
      throw err;
    }
  });
}
