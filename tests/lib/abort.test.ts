/**
 * Unit tests for src/lib/abort.ts — shared timer/signal utilities (issue #29).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { unrefTimer, linkSignals } from '../../src/lib/abort.ts';

describe('unrefTimer', () => {
  it('calls .unref() when the timer handle exposes it (Node/Bun Timeout)', () => {
    const unrefSpy = vi.fn();
    unrefTimer({ unref: unrefSpy });
    expect(unrefSpy).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the timer handle has no .unref (browser-shaped number)', () => {
    expect(() => unrefTimer(123)).not.toThrow();
  });

  it('is a no-op for undefined/null timer handles', () => {
    expect(() => unrefTimer(undefined)).not.toThrow();
    expect(() => unrefTimer(null)).not.toThrow();
  });

  it('does not call unref when it is not a function', () => {
    expect(() => unrefTimer({ unref: 'not-a-function' })).not.toThrow();
  });

  it('unref\'s a real setTimeout handle without throwing', () => {
    const timer = setTimeout(() => {}, 10_000);
    expect(() => unrefTimer(timer)).not.toThrow();
    clearTimeout(timer);
  });
});

describe('linkSignals — returns { signal, dispose }', () => {
  it('returns a fresh, never-aborted signal + no-op dispose when given no signals', () => {
    const { signal, dispose } = linkSignals([]);
    expect(signal.aborted).toBe(false);
    expect(typeof dispose).toBe('function');
    expect(() => dispose()).not.toThrow();
  });

  it('returns a fresh, never-aborted signal + no-op dispose when given only undefined entries', () => {
    const { signal, dispose } = linkSignals([undefined, undefined]);
    expect(signal.aborted).toBe(false);
    expect(() => dispose()).not.toThrow();
  });

  it('returns the signal itself (identity) + no-op dispose when exactly one is defined', () => {
    const ctrl = new AbortController();
    const { signal, dispose } = linkSignals([ctrl.signal, undefined]);
    expect(signal).toBe(ctrl.signal);
    expect(() => dispose()).not.toThrow();
  });

  it('aborts when the first of two signals aborts', () => {
    const a = new AbortController();
    const b = new AbortController();
    const { signal, dispose } = linkSignals([a.signal, b.signal]);
    expect(signal.aborted).toBe(false);
    a.abort();
    expect(signal.aborted).toBe(true);
    dispose();
  });

  it('aborts when the second of two signals aborts', () => {
    const a = new AbortController();
    const b = new AbortController();
    const { signal, dispose } = linkSignals([a.signal, b.signal]);
    b.abort();
    expect(signal.aborted).toBe(true);
    dispose();
  });

  it('is already aborted when one input is already aborted at call time', () => {
    const a = new AbortController();
    a.abort();
    const b = new AbortController();
    const { signal, dispose } = linkSignals([a.signal, b.signal]);
    expect(signal.aborted).toBe(true);
    dispose();
  });

  it('propagates the abort reason from whichever signal fired first', () => {
    const a = new AbortController();
    const b = new AbortController();
    const { signal, dispose } = linkSignals([a.signal, b.signal]);
    const reason = new Error('caller gave up');
    a.abort(reason);
    expect(signal.reason).toBe(reason);
    dispose();
  });
});

// ---------------------------------------------------------------------------
// Manual-merge fallback path (no native AbortSignal.any) — listener leak
// coverage (review finding #1 on issue #29). Before this fix, listeners
// attached to a long-lived, never-aborting external signal (e.g. a caller's
// signal shared across every fire-and-forget ingestTranscript hook call)
// were never removed on normal completion, only on that signal later
// aborting — a permanent-attach-per-call leak on the hot path.
// ---------------------------------------------------------------------------
describe('linkSignals — manual-merge fallback (AbortSignal.any forced unavailable)', () => {
  let originalAny: unknown;

  beforeEach(() => {
    originalAny = (AbortSignal as unknown as { any?: unknown }).any;
    (AbortSignal as unknown as { any?: unknown }).any = undefined;
  });

  afterEach(() => {
    (AbortSignal as unknown as { any?: unknown }).any = originalAny;
  });

  it('dispose() removes the abort listener it attached to each source signal', () => {
    const external = new AbortController().signal;
    const addSpy = vi.spyOn(external, 'addEventListener');
    const removeSpy = vi.spyOn(external, 'removeEventListener');

    const internal = new AbortController();
    const { dispose } = linkSignals([internal.signal, external]);
    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).not.toHaveBeenCalled();

    dispose();
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  it('5 calls sharing one never-aborted external signal leave 0 residual listeners once each is disposed (reviewer repro)', () => {
    // Simulates the hot fire-and-forget path: one long-lived caller signal
    // (e.g. an AbortController the CLI process holds for its whole lifetime)
    // reused across many ingestTranscript calls that each construct their
    // own internal deadline controller.
    const external = new AbortController().signal; // never aborts
    const addSpy = vi.spyOn(external, 'addEventListener');
    const removeSpy = vi.spyOn(external, 'removeEventListener');

    for (let i = 0; i < 5; i++) {
      const internal = new AbortController();
      const { dispose } = linkSignals([internal.signal, external]);
      dispose();
    }

    expect(addSpy).toHaveBeenCalledTimes(5);
    expect(removeSpy).toHaveBeenCalledTimes(5);
  });

  it('does not attach a listener for a signal that was already aborted before the merge (nothing to dispose for it)', () => {
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    const other = new AbortController().signal;
    const addSpy = vi.spyOn(other, 'addEventListener');
    const removeSpy = vi.spyOn(other, 'removeEventListener');

    const { signal, dispose } = linkSignals([alreadyAborted.signal, other]);
    expect(signal.aborted).toBe(true);
    // Loop breaks on the first already-aborted signal — the later signal in
    // the list never gets a listener attached.
    expect(addSpy).not.toHaveBeenCalled();

    dispose();
    expect(removeSpy).not.toHaveBeenCalled();
  });

  it('dispose() is idempotent — calling it twice does not throw or double-remove abnormally', () => {
    const external = new AbortController().signal;
    const internal = new AbortController();
    const { dispose } = linkSignals([internal.signal, external]);
    dispose();
    expect(() => dispose()).not.toThrow();
  });

  it('still aborts correctly and dispose() after abort is safe', () => {
    const a = new AbortController();
    const b = new AbortController();
    const { signal, dispose } = linkSignals([a.signal, b.signal]);
    b.abort();
    expect(signal.aborted).toBe(true);
    expect(() => dispose()).not.toThrow();
  });
});
