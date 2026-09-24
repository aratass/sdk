import { getEventListeners } from 'node:events';
import { describe, expect, test } from 'vitest';
import { pipeline } from '../../../../src/chains/stellar/scanner/pipeline';
import { scanAnnouncementsStream } from '../../../../src/chains/stellar/scan';
import { deriveStealthKeys } from '../../../../src/chains/stellar/keys';
import { generateStealthAddress } from '../../../../src/chains/stellar/stealth';
import { SCHEME_ID } from '../../../../src/chains/stellar/constants';
import { bytesToHex } from '../../../../src/chains/stellar/utils';
import type { Announcement } from '../../../../src/chains/stellar/types';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fails the test instead of hanging the suite when a promise never settles. */
function within<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** A fast source that records how far it was pulled and whether it was closed. */
function counting(limit = Infinity) {
  const state = { pulled: 0, closed: false };
  const source = (async function* () {
    try {
      for (let i = 0; i < limit; i++) {
        state.pulled++;
        yield i;
      }
    } finally {
      state.closed = true;
    }
  })();
  return { source, state };
}

/** A source that waits `ms` before each item and stops waiting when `signal` aborts. */
function slow(ms: number, signal: AbortSignal) {
  const state = { closed: false };
  const source = (async function* () {
    try {
      for (let i = 0; ; i++) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, ms);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(signal.reason);
            },
            { once: true },
          );
        });
        yield i;
      }
    } finally {
      state.closed = true;
    }
  })();
  return { source, state };
}

describe('pipeline cancellation', () => {
  test('breaking out while the read-ahead buffer is full returns promptly', async () => {
    // Regression: the pump parked on a full buffer and the consumer's `.return()`
    // then waited for it forever.
    for (const capacity of [1, 2, 4, 64]) {
      const { source, state } = counting();
      const seen: number[] = [];

      const run = (async () => {
        for await (const value of pipeline(source, capacity)) {
          await sleep(5); // slow consumer: lets the pump fill the buffer
          seen.push(value);
          if (seen.length === 3) break;
        }
      })();

      await within(run);
      expect(seen).toEqual([0, 1, 2]);
      expect(state.closed).toBe(true);
    }
  });

  test('never buffers more than `capacity` items ahead of the consumer', async () => {
    const capacity = 3;
    const { source, state } = counting(40);
    let consumed = 0;
    let maxAhead = 0;

    for await (const _value of pipeline(source, capacity)) {
      consumed++;
      await sleep(2);
      maxAhead = Math.max(maxAhead, state.pulled - consumed);
    }

    expect(consumed).toBe(40);
    expect(maxAhead).toBeLessThanOrEqual(capacity);
  });

  test('rejects without pulling the source when the signal is already aborted', async () => {
    const { source, state } = counting();
    const controller = new AbortController();
    controller.abort();

    const piped = pipeline(source, 4, controller.signal);
    await expect(piped.next()).rejects.toMatchObject({ name: 'AbortError' });
    expect(state.pulled).toBe(0);
  });

  test('abort with an abort-aware source rejects promptly with the reason', async () => {
    const controller = new AbortController();
    const { source, state } = slow(1_000, controller.signal);
    const piped = pipeline(source, 4, controller.signal);

    const pending = piped.next();
    await sleep(10);
    const reason = new Error('stop');
    controller.abort(reason);

    await expect(within(pending, 500)).rejects.toBe(reason);
    expect(state.closed).toBe(true);
    await expect(piped.next()).resolves.toEqual({ done: true, value: undefined });
  });

  test('abort while the consumer holds an item stops before the next one', async () => {
    const { source, state } = counting();
    const controller = new AbortController();
    const piped = pipeline(source, 8, controller.signal);

    await expect(piped.next()).resolves.toEqual({ done: false, value: 0 });
    await sleep(5); // buffer fills behind the consumer
    controller.abort();

    await expect(within(piped.next())).rejects.toMatchObject({ name: 'AbortError' });
    expect(state.closed).toBe(true);
  });

  test('stops pulling from a source that ignores the signal', async () => {
    const state = { pulled: 0 };
    const source = (async function* () {
      for (let i = 0; ; i++) {
        await sleep(1);
        state.pulled++;
        yield i;
      }
    })();
    const controller = new AbortController();
    const piped = pipeline(source, 1_000, controller.signal);

    await piped.next();
    controller.abort();
    const pulledAtAbort = state.pulled;
    await sleep(30);

    // At most the one request already in flight completes; nothing new is started.
    expect(state.pulled - pulledAtAbort).toBeLessThanOrEqual(1);
    await expect(within(piped.next())).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('never calls next() on the source after closing it', async () => {
    let returned = false;
    let nextAfterReturn = 0;
    let i = 0;
    const source: AsyncIterable<number> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          if (returned) nextAfterReturn++;
          return { done: false, value: i++ };
        },
        return: async () => {
          returned = true;
          return { done: true, value: undefined };
        },
      }),
    };

    for await (const _value of pipeline(source, 2)) {
      await sleep(5); // the pump fills the buffer and parks
      break;
    }
    await sleep(10);

    expect(returned).toBe(true);
    expect(nextAfterReturn).toBe(0);
  });

  test('reports the abort even when closing the source fails', async () => {
    const source: AsyncIterable<number> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false, value: 1 }),
        return: async () => {
          throw new Error('close failed');
        },
      }),
    };
    const controller = new AbortController();
    const piped = pipeline(source, 4, controller.signal);

    await piped.next();
    const reason = new Error('aborted by caller');
    controller.abort(reason);

    await expect(within(piped.next())).rejects.toBe(reason);
  });

  test('an already-aborted signal still closes a source that was started', async () => {
    const { source, state } = counting();
    await source.next(); // started elsewhere
    const controller = new AbortController();
    controller.abort();

    await expect(pipeline(source, 4, controller.signal).next()).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(state.closed).toBe(true);
    expect(state.pulled).toBe(1);
  });

  test('detaches its abort listener when it finishes', async () => {
    const controller = new AbortController();

    const { source } = counting(10);
    const out: number[] = [];
    for await (const value of pipeline(source, 4, controller.signal)) out.push(value);
    expect(out).toHaveLength(10);

    const { source: another } = counting();
    for await (const _value of pipeline(another, 4, controller.signal)) break;

    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});

describe('scanAnnouncementsStream cancellation', () => {
  const keys = deriveStealthKeys(new Uint8Array(64).fill(0xab));
  const stealth = generateStealthAddress(keys.spendingPubKey, keys.viewingPubKey);
  const ann: Announcement = {
    schemeId: SCHEME_ID,
    stealthAddress: stealth.stealthAddress,
    caller: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    ephemeralPubKey: bytesToHex(stealth.ephemeralPubKey),
    metadata: stealth.viewTag.toString(16).padStart(2, '0'),
  };

  function endless() {
    const state = { closed: false };
    const source = (async function* () {
      try {
        while (true) yield ann;
      } finally {
        state.closed = true;
      }
    })();
    return { source, state };
  }

  test('opts.signal cancels a running scan and closes its source', async () => {
    const { source, state } = endless();
    const controller = new AbortController();
    const scan = scanAnnouncementsStream(
      source,
      keys.viewingKey,
      keys.spendingPubKey,
      keys.spendingScalar,
      { window: 8, signal: controller.signal },
    );

    expect((await scan.next()).done).toBe(false);
    await sleep(20); // let the read-ahead window fill
    const reason = new Error('scan cancelled');
    controller.abort(reason);

    await expect(within(scan.next())).rejects.toBe(reason);
    expect(state.closed).toBe(true);
  });

  test('breaking out while the read-ahead window is full returns promptly', async () => {
    const { source, state } = endless();
    let matches = 0;

    const run = (async () => {
      for await (const _match of scanAnnouncementsStream(
        source,
        keys.viewingKey,
        keys.spendingPubKey,
        keys.spendingScalar,
        { window: 4 },
      )) {
        // A consumer that awaits per match (a balance lookup, say) lets the window fill up.
        await sleep(10);
        if (++matches === 3) break;
      }
    })();

    await within(run);
    expect(matches).toBe(3);
    expect(state.closed).toBe(true);
  });
});
