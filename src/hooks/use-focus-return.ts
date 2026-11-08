"use client";

import { useCallback, useRef } from "react";

// An inline confirm that takes the place of the button which opened it unmounts
// the focused element, and keyboard focus falls to <body>: a keyboard or
// screen-reader user loses their place. The confirm row takes focus itself
// (autoFocus on its safe button); when it goes away, `returnTo(key)` names where
// focus goes next and the element given `ref={refFor(key)}` takes it as soon as
// it is (re)mounted.
//
//   const focus = useFocusReturn();
//   <button ref={focus.refFor("trigger")} onClick={() => setConfirming(true)}>…
//   <button onClick={() => { focus.returnTo("trigger"); setConfirming(false); }}>Cancel
//
// `returnToIfLost` is for the end of a confirmed action whose trigger was
// disabled while it ran: focus goes back only if it is still on <body>, never
// taken from wherever the admin moved it meanwhile.
//
// Every call is followed by a state change, and refFor hands React a new
// callback each render, so the target's ref runs on that render even when it
// was mounted all along.
export function useFocusReturn() {
  const pending = useRef<string | null>(null);
  const returnTo = useCallback((key: string) => {
    pending.current = key;
  }, []);
  const returnToIfLost = useCallback((key: string) => {
    if (typeof document === "undefined") return;
    const active = document.activeElement;
    if (active === null || active === document.body) pending.current = key;
  }, []);
  const refFor = useCallback(
    (key: string) => (el: HTMLElement | null) => {
      if (el && pending.current === key) {
        pending.current = null;
        el.focus();
      }
    },
    [],
  );
  return { returnTo, returnToIfLost, refFor };
}
