// Awaits a set of NAMED list sources together (the home rails). A source that
// rejects degrades to an empty list, so one failed upstream omits one rail
// instead of failing the page, and its rejection is logged under its own name
// so the missing rail is diagnosable rather than silently absent. Keyed by
// name, not position: a positional name array beside a positional result list
// mislabelled the log line as soon as one of the two was reordered.
export async function settleSources<K extends string, T>(
  scope: string,
  sources: Record<K, Promise<T[]>>,
): Promise<Record<K, T[]>> {
  const names = Object.keys(sources) as K[];
  const results = await Promise.allSettled(names.map((name) => sources[name]));
  const out = {} as Record<K, T[]>;
  names.forEach((name, i) => {
    const r = results[i];
    if (r.status === "fulfilled") {
      out[name] = r.value;
      return;
    }
    console.error(`[${scope}] source ${name} failed:`, r.reason instanceof Error ? r.reason.message : r.reason);
    out[name] = [];
  });
  return out;
}
