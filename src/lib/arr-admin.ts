// Shared data plumbing for the admin Radarr/Sonarr surfaces added after the
// Download Queue and Missing pages: the title manager (arr-title-data.ts), the
// download history and blocklist (arr-history-data.ts), the calendar
// (arr-calendar-data.ts) and the system page (arr-system-data.ts). Every call
// goes through arrFetch (guardrail 5) on an instance the registry lists and
// has a connection for (guardrail 32).
import { arrFetch, getArrCfg, type ArrCfg } from "./arr";
import { getSyncableArrInstances } from "./arr-instance-registry";
import type { ArrService } from "./arr-instances";
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
