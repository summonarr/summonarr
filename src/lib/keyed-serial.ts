// Runs the work for one key one at a time, in arrival order, in this process
// (the single long-lived server). A failed run never poisons the chain: the next
// waits for it to SETTLE, not to succeed. The tails are a processSingleton, so
// every route chunk shares them (guardrail 27a); the entry leaves the map once
// its key is idle.
import { processSingleton } from "./process-singleton";

export function keyedSerial(singletonName: string): <T>(key: string, run: () => Promise<T>) => Promise<T> {
  const tails = processSingleton(singletonName, () => new Map<string, Promise<void>>());
  return async function serialized<T>(key: string, run: () => Promise<T>): Promise<T> {
    const result = (tails.get(key) ?? Promise.resolve()).then(run);
    const settled = result.then(() => undefined, () => undefined);
    tails.set(key, settled);
    try {
      return await result;
    } finally {
      if (tails.get(key) === settled) tails.delete(key);
    }
  };
}
