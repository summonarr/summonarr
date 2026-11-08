"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

// A client component's mutations and reloads, each under a KEY:
//
//   const action = useAsyncAction();
//   async function approve(id: string) {
//     const res = await action.run(`approve:${id}`, (signal) =>
//       fetchJson(withBasePath(`/api/requests/${id}`), { init: jsonInit("PATCH", { status: "APPROVED" }), signal }));
//     if (!res) return;                       // superseded, aborted or unmounted: apply nothing
//     if (!res.ok) { setError(res.error); return; }
//     router.refresh();
//   }
//   <Button disabled={action.busy(`approve:${id}`)} …>
//
// - Busy is per key, so one row's action never locks or unlocks another's.
// - Running a key again ABORTS the run in flight and drops its result (the
//   sequence guard), so an older answer can never land over a newer one. Pass
//   `{ ifBusy: "skip" }` to keep the run in flight instead (a submit that must
//   not go twice).
// - `run` resolves to `fn`'s result only while that run is still the key's
//   current one. Otherwise it resolves to `undefined`: the run was superseded,
//   aborted or unmounted (and its signal aborted), or never started (`skip`,
//   or after unmount). Apply the result AFTER `run` resolves, never inside
//   `fn`: that is what keeps a stale or post-unmount answer out of the state.
//   A `fn` that returns nothing can return `true` to tell "done" from "dropped".
// - Unmount aborts every run and makes later runs no-ops. A `fn` that throws
//   rethrows from `run` (it is a bug in `fn`; fetchJson never throws) unless
//   the run was already dropped.
// - `action` is the same object on every render, so it is safe in an effect's
//   deps. `busy()`/`anyBusy` read the live state and the component re-renders
//   when it changes; hand a memoized child `busy(key)`, not `action`.
//
// The state machine is `createAsyncActions`, free of React so the unit suite
// drives it directly (tests/use-async-action.test.mts); the hook only binds it
// to a component's lifetime. No clock anywhere (guardrail 16).

export interface RunOptions {
  /** What a run does when its key is already running: abort that run ("restart", the default) or leave it and do nothing ("skip"). */
  ifBusy?: "restart" | "skip";
}

export interface AsyncAction {
  run<T>(key: string, fn: (signal: AbortSignal) => Promise<T>, opts?: RunOptions): Promise<T | undefined>;
  /** Aborts `key`'s run (every run when no key is given); its result is dropped. */
  abort(key?: string): void;
  busy(key: string): boolean;
  readonly anyBusy: boolean;
}

export interface AsyncActionsCore extends AsyncAction {
  /** For useSyncExternalStore: called whenever the set of busy keys changes. */
  subscribe(listener: () => void): () => void;
  /** The busy keys; the same object until the set changes. */
  snapshot(): ReadonlySet<string>;
  /** On mount: runs are accepted. */
  activate(): void;
  /** On unmount: aborts every run and refuses new ones until `activate`. Notifies no one. */
  dispose(): void;
}

const NONE: ReadonlySet<string> = new Set();
const serverSnapshot = () => NONE;

export function createAsyncActions(): AsyncActionsCore {
  // One entry per busy key; the entry object itself is the run's identity.
  const running = new Map<string, { controller: AbortController }>();
  const listeners = new Set<() => void>();
  let busyKeys: ReadonlySet<string> = NONE;
  let alive = true;

  const publish = () => {
    busyKeys = running.size === 0 ? NONE : new Set(running.keys());
    for (const listener of [...listeners]) listener();
  };

  // Ends `key`'s run without publishing; true when there was one.
  const drop = (key: string): boolean => {
    const entry = running.get(key);
    if (!entry) return false;
    running.delete(key);
    entry.controller.abort();
    return true;
  };

  async function run<T>(key: string, fn: (signal: AbortSignal) => Promise<T>, opts?: RunOptions): Promise<T | undefined> {
    if (!alive) return undefined;
    if (opts?.ifBusy === "skip" && running.has(key)) return undefined;
    const replaced = drop(key);
    const mine = { controller: new AbortController() };
    running.set(key, mine);
    if (!replaced) publish();
    const finish = (): boolean => {
      if (running.get(key) !== mine) return false;
      running.delete(key);
      publish();
      return true;
    };
    let value: T;
    try {
      value = await fn(mine.controller.signal);
    } catch (err) {
      if (!finish()) return undefined;
      throw err;
    }
    return finish() ? value : undefined;
  }

  return {
    run,
    abort(key?: string) {
      if (key === undefined) {
        if (running.size === 0) return;
        for (const k of [...running.keys()]) drop(k);
        publish();
      } else if (drop(key)) {
        publish();
      }
    },
    busy: (key) => busyKeys.has(key),
    get anyBusy() {
      return busyKeys.size > 0;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => busyKeys,
    activate() {
      alive = true;
    },
    dispose() {
      alive = false;
      for (const k of [...running.keys()]) drop(k);
      busyKeys = NONE;
    },
  };
}

/** Keyed async actions bound to this component: see the top of this file. */
export function useAsyncAction(): AsyncAction {
  const [core] = useState(createAsyncActions);
  // Re-renders the component whenever the busy set changes; the reads go through `core`.
  useSyncExternalStore(core.subscribe, core.snapshot, serverSnapshot);
  // activate() as well as dispose(): Strict Mode unmounts and remounts once in
  // development, and the remounted component keeps this same core.
  useEffect(() => {
    core.activate();
    return core.dispose;
  }, [core]);
  const [action] = useState<AsyncAction>(() => ({
    run: core.run,
    abort: core.abort,
    busy: core.busy,
    get anyBusy() {
      return core.anyBusy;
    },
  }));
  return action;
}
