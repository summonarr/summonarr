// One abortable wait for client and server code alike: resolves after `ms`, or
// as soon as `signal` aborts (an already-aborted signal or a non-positive wait
// resolves at once). Never rejects — the caller checks the signal afterwards.
export function abortableSleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}
