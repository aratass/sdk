import { throwIfAborted } from '../abort';

/** Resolvable/rejectable promise used to gate the producer and consumer loops. */
class Deferred<T = void> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolve = resolve;
    });
  }
}

/**
 * Pipelines an async iterable through a bounded in-memory queue so a slow
 * consumer (e.g. CPU-bound decryption) overlaps with a producer that is
 * mostly waiting on I/O (e.g. RPC pagination), instead of alternating
 * "await a full page, then process it" in lockstep.
 *
 * A background pump continuously pulls from `source` and buffers up to
 * `capacity` items ahead of what the consumer has read. Because pulling the
 * next item from `source` starts its I/O immediately, that I/O runs
 * concurrently with whatever synchronous work the consumer is doing on
 * already-buffered items — Node's event loop keeps the in-flight network
 * call progressing in the background while the main thread executes the
 * consumer's CPU-bound step.
 *
 * The pump pauses once the queue is full, so an adversarially fast producer
 * paired with a slow consumer cannot grow memory past O(capacity) items.
 *
 * Breaking out of the consumer's `for-await` loop (or calling `.return()`)
 * stops the pump, drops the buffered items and propagates to `source` via its
 * `.return()`, matching plain async-generator cancellation semantics.
 *
 * Aborting `signal` does the same from outside the loop: the pump stops
 * pulling, and the consumer's pending or next read rejects with
 * `signal.reason`. Give the source the same signal (for example
 * `fetchAnnouncementsStream(..., { signal })`) so a request it already has in
 * flight is cancelled as well; otherwise closing the source has to wait for
 * that request to settle, because an async generator cannot be closed while
 * it is awaiting.
 *
 * @param source Async iterable to pull from (e.g. {@link fetchAnnouncementsStream}).
 * @param capacity Max items buffered ahead of the consumer. Must be >= 1.
 * @param signal Optional AbortSignal that cancels the pipeline.
 */
export async function* pipeline<T>(
  source: AsyncIterable<T>,
  capacity: number,
  signal?: AbortSignal,
): AsyncGenerator<T> {
  const cap = Math.max(1, capacity);
  const buffer: T[] = [];
  let producerDone = false;
  let producerErrored = false;
  let producerError: unknown;
  // Set once the consumer side is finished (normally, by error, early return or abort).
  let stopped = false;
  const halted = () => stopped || signal?.aborted === true;

  let itemAvailable = new Deferred();
  let spaceAvailable = new Deferred();
  spaceAvailable.resolve();

  const iter = source[Symbol.asyncIterator]();

  const runPump = async () => {
    try {
      while (!halted()) {
        if (buffer.length >= cap) {
          await spaceAvailable.promise;
          spaceAvailable = new Deferred();
          // Re-check: the consumer may have stopped, or the queue may still be full.
          continue;
        }

        const next = await iter.next();
        if (next.done || halted()) break;

        buffer.push(next.value);
        itemAvailable.resolve();
      }
    } catch (err) {
      producerErrored = true;
      producerError = err;
    } finally {
      producerDone = true;
      itemAvailable.resolve();
    }
  };

  let pump: Promise<void> = Promise.resolve();

  try {
    throwIfAborted(signal);
    pump = runPump();

    while (true) {
      throwIfAborted(signal);

      if (buffer.length === 0) {
        if (producerDone) {
          if (producerErrored) throw producerError;
          break;
        }
        await itemAvailable.promise;
        itemAvailable = new Deferred();
        continue;
      }

      const value = buffer.shift() as T;
      spaceAvailable.resolve();
      yield value;
    }
  } finally {
    // Stop the pump and release the read-ahead. A pump parked on a full queue would
    // otherwise wait for space forever, and awaiting it below would never return.
    stopped = true;
    buffer.length = 0;
    spaceAvailable.resolve();
    try {
      await iter.return?.();
    } catch (err) {
      // After an abort, report the abort rather than a failure to close the source.
      if (!signal?.aborted) throw err;
    } finally {
      await pump.catch(() => {});
    }
  }
}
