/**
 * AstraMemory provider error classes.
 *
 * Mirrors the error-kind pattern from astramem-local/src/pipeline/errors.ts.
 *
 * DeterministicError — the request was rejected by the server (4xx).
 *   Retrying with the same payload will not help.
 *
 * TransientError — the request failed due to a network issue or 5xx response.
 *   A single automatic retry is appropriate.
 */

export type ErrorKind = 'deterministic' | 'transient';

export class DeterministicError extends Error {
  readonly kind: ErrorKind = 'deterministic';

  constructor(
    message: string,
    /** HTTP status code that triggered this error, if available. */
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'DeterministicError';
    // Maintain prototype chain in transpiled output.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class TransientError extends Error {
  readonly kind: ErrorKind = 'transient';

  constructor(
    message: string,
    /** HTTP status code that triggered this error, if available. */
    public readonly status?: number,
    /** Underlying cause (e.g. TypeError from fetch). */
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TransientError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
