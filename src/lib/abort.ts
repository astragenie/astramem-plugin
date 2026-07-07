/**
 * abort.ts — shared timer/signal utilities for provider fetch layers (issue #29).
 *
 * Problem: internal deadline timers created via `setTimeout(() => ctrl.abort(), ms)`
 * in local.ts / saas.ts / selector.ts were ref'd (the Node/Bun default) and never
 * accepted an external AbortSignal. When a caller enforced its own shorter
 * wallclock cap (e.g. Promise.race with a 2s timeout) and gave up, the abandoned
 * fetch + its still-running ref'd timer kept the event loop alive for the
 * remainder of the internal window (up to 5s). One-shot CLI processes that set
 * process.exitCode (rather than calling process.exit()) hang until that timer
 * fires.
 *
 * Fix: unref() every internal deadline timer, and let callers pass their own
 * AbortSignal that gets combined with the internal one so either can abort the
 * in-flight fetch.
 */

/**
 * unref() a timer handle so it does not keep the event loop alive on its own.
 * Node/Bun's setTimeout returns a Timeout object exposing `.unref()`; browser-
 * shaped environments return a plain number that has no such method. Guard so
 * this stays safe wherever this module loads.
 */
export function unrefTimer(timer: unknown): void {
  const maybeUnref = (timer as { unref?: unknown } | null | undefined)?.unref;
  if (typeof maybeUnref === 'function') {
    (maybeUnref as () => void).call(timer);
  }
}

/** Result of linkSignals() — the combined signal plus a cleanup callback. */
export interface LinkedSignal {
  /** The combined AbortSignal — aborts as soon as any input signal aborts. */
  signal: AbortSignal;
  /**
   * Removes any listeners the manual-merge fallback attached to the input
   * signals. A no-op on the empty/single-input/native-`AbortSignal.any`
   * paths (nothing was attached there). Callers MUST call this in a
   * `finally` once they are done with `signal` — otherwise, on the fallback
   * path, a listener is permanently attached to every long-lived input
   * signal that never itself aborts (e.g. a caller's AbortController reused
   * across many fire-and-forget calls), leaking one listener per call.
   */
  dispose: () => void;
}

const NOOP_DISPOSE = (): void => {};

/**
 * Combine any number of (possibly undefined) AbortSignals into one that
 * aborts as soon as the first of them aborts.
 *
 * Prefers the native `AbortSignal.any` (Node 20.3+ / recent browsers) but
 * does not assume it exists on every Bun build this plugin targets — falls
 * back to a manual listener-based merge when it's unavailable. Callers must
 * call the returned `dispose()` once they are done with the signal (e.g. in
 * a `finally` block) to remove any listeners the fallback attached.
 */
export function linkSignals(signals: Array<AbortSignal | undefined>): LinkedSignal {
  const defined = signals.filter((s): s is AbortSignal => s !== undefined);
  if (defined.length === 0) {
    return { signal: new AbortController().signal, dispose: NOOP_DISPOSE };
  }
  if (defined.length === 1) {
    return { signal: defined[0]!, dispose: NOOP_DISPOSE };
  }

  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') {
    return { signal: anyFn(defined), dispose: NOOP_DISPOSE };
  }

  const controller = new AbortController();
  const cleanups: Array<() => void> = [];
  for (const s of defined) {
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    // Explicit named handler (no `{ once: true }` reliance) so dispose()
    // can deterministically remove it on the normal-completion path, not
    // just when the source signal itself later fires.
    const onAbort = (): void => controller.abort(s.reason);
    s.addEventListener('abort', onAbort);
    cleanups.push(() => s.removeEventListener('abort', onAbort));
  }

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const cleanup of cleanups) cleanup();
    cleanups.length = 0;
  };
  return { signal: controller.signal, dispose };
}
