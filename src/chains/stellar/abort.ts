/**
 * Internal helpers for `AbortSignal` support in the Stellar streaming and RPC paths.
 *
 * Aborted operations reject with `signal.reason`, the same value `fetch()` rejects with,
 * so callers can compare against the reason they passed to `abort()` or check
 * `err.name === 'AbortError'` for the default one.
 *
 * @internal
 */

function defaultAbortError(): Error {
  if (typeof DOMException === 'function') {
    return new DOMException('This operation was aborted', 'AbortError');
  }
  // Runtimes without DOMException (some React Native engines) still get a recognisable error.
  const err = new Error('This operation was aborted');
  err.name = 'AbortError';
  return err;
}

/** The value an aborted operation rejects with: the signal's reason, or a default `AbortError`. */
export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? defaultAbortError();
}

/** Throws the signal's abort reason if it has already been aborted. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

/** Resolves after `ms`, or rejects with the abort reason as soon as `signal` aborts. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * An `AbortController` that also aborts, with the same reason, when `parent` aborts.
 *
 * Call `dispose()` when the operation ends: it aborts the child (cancelling anything still
 * in flight) and detaches the listener from `parent`, so a long-lived parent signal shared
 * across many streams does not accumulate listeners.
 */
export function linkedAbortController(parent?: AbortSignal): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parent ? abortReason(parent) : undefined);

  if (parent?.aborted) onParentAbort();
  else parent?.addEventListener('abort', onParentAbort, { once: true });

  return {
    signal: controller.signal,
    dispose() {
      parent?.removeEventListener('abort', onParentAbort);
      if (!controller.signal.aborted) controller.abort();
    },
  };
}
