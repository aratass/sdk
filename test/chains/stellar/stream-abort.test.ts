import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { fetchAnnouncementsStream, mergeOrdered } from '../../../src/chains/stellar/announcements';
import type { Announcement } from '../../../src/chains/stellar/types';

// Every event decodes to a valid announcement, so these tests exercise paging and
// cancellation rather than XDR parsing (same mock as announcements.test.ts).
vi.mock('@stellar/stellar-sdk', () => {
  const mockAddress = {
    toString: () => 'GMOCKADDRESS000000000000000000000000000000000000000000000',
  };
  const scVal = {
    u32: () => 1,
    address: () => ({}),
    vec: () => [
      { address: () => ({}) },
      { bytes: () => new Uint8Array(32).fill(1) },
      { bytes: () => new Uint8Array(1).fill(0x42) },
    ],
  };
  return {
    xdr: {
      ScVal: {
        fromXDR: vi.fn(() => scVal),
        scvSymbol: vi.fn((sym: string) => ({ toXDR: vi.fn(() => `sym:${sym}`) })),
        scvU32: vi.fn((n: number) => ({ toXDR: vi.fn(() => `u32:${n}`) })),
        scvBytes: vi.fn((bytes: Buffer) => ({ toXDR: vi.fn(() => bytes.toString('hex')) })),
        scvVec: vi.fn((vec: unknown[]) => ({ toXDR: vi.fn(() => JSON.stringify(vec)) })),
      },
    },
    Address: {
      fromScAddress: vi.fn(() => mockAddress),
    },
  };
});

// ---------------------------------------------------------------------------
// A fetch double that honours AbortSignal the way the platform fetch does.
// ---------------------------------------------------------------------------

const HANG = Symbol('hang');

interface RecordedRequest {
  url: string;
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  signal?: AbortSignal;
}

function installFetch(respond: (req: RecordedRequest, index: number) => unknown) {
  const requests: RecordedRequest[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const req: RecordedRequest = {
      url: String(input),
      id: body?.id,
      method: body?.method,
      params: body?.params,
      signal: init?.signal ?? undefined,
    };
    const index = requests.push(req) - 1;
    return new Promise<Response>((resolve, reject) => {
      const signal = req.signal;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = () => reject(signal?.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      const payload = respond(req, index);
      if (payload !== HANG) {
        signal?.removeEventListener('abort', onAbort);
        resolve({ json: async () => payload } as Response);
      }
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { requests, fetchMock };
}

function eventsPage(
  count: number,
  opts: { cursor?: string; start?: number; ledger?: number } = {},
) {
  const start = opts.start ?? 0;
  return {
    result: {
      cursor: opts.cursor,
      events: Array.from({ length: count }, (_, i) => ({
        id: `event-${start + i}`,
        ledger: opts.ledger ?? 150,
        topic: ['t0', `t1-${start + i}`, `t2-${start + i}`],
        value: `value-${start + i}`,
      })),
    },
  };
}

/** Probe with no retention error, then `getLatestLedger`, then whatever `pages` returns. */
function sorobanResponder(pages: (req: RecordedRequest) => unknown) {
  return (req: RecordedRequest) => {
    if (req.id === 0) return { result: { events: [] } }; // retention-window probe
    if (req.method === 'getLatestLedger') return { result: { sequence: 1_000 } };
    return pages(req);
  };
}

function pageRequests(requests: RecordedRequest[]) {
  return requests.filter((r) => r.method === 'getEvents' && r.id !== 0);
}

async function waitForRequests(requests: RecordedRequest[], count: number) {
  await vi.waitFor(() => expect(requests.length).toBeGreaterThanOrEqual(count), {
    timeout: 1_000,
    interval: 1,
  });
}

/** Fails the test instead of hanging the suite when a promise never settles. */
function within<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchAnnouncementsStream with an AbortSignal', () => {
  test('rejects before sending any request when the signal is already aborted', async () => {
    const { fetchMock } = installFetch(() => ({ result: { events: [] } }));
    const controller = new AbortController();
    controller.abort();

    const stream = fetchAnnouncementsStream('stellar', {
      includeV2: false,
      signal: controller.signal,
    });

    await expect(stream.next()).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined });
  });

  test('aborting while the first page is in flight cancels that request', async () => {
    const { requests } = installFetch(sorobanResponder(() => HANG));
    const controller = new AbortController();
    const stream = fetchAnnouncementsStream('stellar', {
      includeV2: false,
      signal: controller.signal,
    });

    const first = stream.next();
    await waitForRequests(requests, 3);
    const reason = new Error('user left the page');
    controller.abort(reason);

    await expect(within(first)).rejects.toBe(reason);
    const [page] = pageRequests(requests);
    expect(page.signal?.aborted).toBe(true);
    expect(requests).toHaveLength(3);
    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined });
  });

  test('aborting mid-page drops the rest of the page and fetches no further page', async () => {
    const { requests } = installFetch(
      sorobanResponder(() => eventsPage(1000, { cursor: 'cursor-1' })),
    );
    const controller = new AbortController();
    const stream = fetchAnnouncementsStream('stellar', {
      includeV2: false,
      signal: controller.signal,
    });

    for (let i = 0; i < 10; i++) {
      const { done } = await stream.next();
      expect(done).toBe(false);
    }
    controller.abort();

    // The rest of the first page is dropped, not drained.
    await expect(stream.next()).rejects.toMatchObject({ name: 'AbortError' });
    expect(pageRequests(requests)).toHaveLength(1);
    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined });
  });

  test('aborting while a later page is in flight cancels that request', async () => {
    const { requests } = installFetch(
      sorobanResponder((req) =>
        (req.params?.pagination as { cursor?: string }).cursor === 'cursor-1'
          ? HANG
          : eventsPage(1000, { cursor: 'cursor-1' }),
      ),
    );
    const controller = new AbortController();
    const stream = fetchAnnouncementsStream('stellar', {
      includeV2: false,
      signal: controller.signal,
    });

    for (let i = 0; i < 1000; i++) await stream.next();
    const pending = stream.next(); // needs page two, which never answers
    await waitForRequests(requests, 4);
    controller.abort();

    await expect(within(pending)).rejects.toMatchObject({ name: 'AbortError' });
    const pages = pageRequests(requests);
    expect(pages).toHaveLength(2);
    expect(pages[1].signal?.aborted).toBe(true);
  });

  test('cancels Horizon lookups for timestamp bounds', async () => {
    const { requests } = installFetch((req) => {
      if (req.url.includes('/ledgers')) return HANG;
      return sorobanResponder(() => eventsPage(1))(req);
    });
    const controller = new AbortController();
    const stream = fetchAnnouncementsStream('stellar', {
      includeV2: false,
      fromTimestamp: new Date('2026-01-01T00:00:00Z'),
      signal: controller.signal,
    });

    const first = stream.next();
    await vi.waitFor(() => expect(requests.some((r) => r.url.includes('/ledgers'))).toBe(true));
    controller.abort();

    await expect(within(first)).rejects.toMatchObject({ name: 'AbortError' });
    const horizon = requests.find((r) => r.url.includes('/ledgers'));
    expect(horizon?.signal?.aborted).toBe(true);
    expect(pageRequests(requests)).toHaveLength(0);
  });

  test('aborting a parallel cold scan cancels the in-flight chunk request', async () => {
    const { requests } = installFetch(
      sorobanResponder((req) => {
        const start = req.params?.startLedger as number;
        // Chunk one answers; chunk two never does.
        return start === 100 ? eventsPage(3, { ledger: 120 }) : HANG;
      }),
    );
    const controller = new AbortController();
    const stream = fetchAnnouncementsStream('stellar', {
      includeV2: false,
      fromLedger: 100,
      toLedger: 400,
      parallelism: 3,
      signal: controller.signal,
    });

    const first = stream.next();
    await vi.waitFor(() => expect(pageRequests(requests)).toHaveLength(2));
    const reason = new Error('cancelled by caller');
    controller.abort(reason);

    await expect(within(first)).rejects.toBe(reason);
    const pages = pageRequests(requests);
    expect(pages.map((p) => p.params?.startLedger)).toEqual([100, 200]);
    expect(pages.every((p) => p.signal?.aborted)).toBe(true);
    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined });
  });

  test('aborting a parallel scan while the consumer holds an item stops it', async () => {
    installFetch(
      sorobanResponder((req) => eventsPage(5, { ledger: req.params?.startLedger as number })),
    );
    const controller = new AbortController();
    const stream = fetchAnnouncementsStream('stellar', {
      includeV2: false,
      fromLedger: 100,
      toLedger: 400,
      parallelism: 3,
      signal: controller.signal,
    });

    expect((await stream.next()).done).toBe(false);
    const reason = new Error('stop now');
    controller.abort(reason);

    // Four more events are sitting in the first chunk's page: none may be yielded.
    await expect(stream.next()).rejects.toBe(reason);
    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined });
  });

  test('stopping a parallel scan early aborts its chunk requests and detaches from the caller signal', async () => {
    const { requests } = installFetch(
      sorobanResponder((req) => eventsPage(3, { ledger: req.params?.startLedger as number })),
    );
    const controller = new AbortController();
    const stream = fetchAnnouncementsStream('stellar', {
      includeV2: false,
      fromLedger: 100,
      toLedger: 400,
      parallelism: 3,
      signal: controller.signal,
    });

    const seen: Announcement[] = [];
    for await (const ann of stream) {
      seen.push(ann);
      break;
    }

    const sent = requests.length;
    expect(seen).toHaveLength(1);
    expect(pageRequests(requests).every((p) => p.signal?.aborted)).toBe(true);
    expect(controller.signal.aborted).toBe(false); // the caller's signal is left alone
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(requests).toHaveLength(sent);
  });

  test('does not leave its own listeners on a long-lived signal', async () => {
    installFetch(
      sorobanResponder((req) => eventsPage(2, { ledger: req.params?.startLedger as number })),
    );
    const controller = new AbortController();

    for (const parallelism of [1, 3, 1, 3]) {
      const out: Announcement[] = [];
      for await (const ann of fetchAnnouncementsStream('stellar', {
        includeV2: false,
        fromLedger: 100,
        toLedger: 400,
        parallelism,
        signal: controller.signal,
      })) {
        out.push(ann);
      }
      expect(out.length).toBeGreaterThan(0);
    }

    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  test('a stream without a signal behaves as before', async () => {
    installFetch(sorobanResponder(() => eventsPage(5)));
    const out: Announcement[] = [];
    for await (const ann of fetchAnnouncementsStream('stellar', { includeV2: false })) {
      out.push(ann);
    }
    expect(out).toHaveLength(5);
  });
});

describe('mergeOrdered cleanup', () => {
  function tracked(name: string, keys: number[], closed: Set<string>, failAt?: number) {
    return (async function* () {
      try {
        for (const key of keys) {
          if (key === failAt) throw new Error(`${name} failed`);
          yield { item: `${name}${key}`, key };
        }
      } finally {
        closed.add(name);
      }
    })();
  }

  test('closes every source when the consumer stops early', async () => {
    const closed = new Set<string>();
    const merged = mergeOrdered([
      tracked('a', [1, 4], closed),
      tracked('b', [2, 5], closed),
      tracked('c', [3, 6], closed),
    ]);

    for await (const item of merged) {
      expect(item).toBe('a1');
      break;
    }

    expect([...closed].sort()).toEqual(['a', 'b', 'c']);
  });

  test('closes the other sources when one fails', async () => {
    const closed = new Set<string>();
    const c = tracked('c', [3], closed);
    const merged = mergeOrdered([tracked('a', [1, 4], closed), tracked('b', [2], closed, 2), c]);

    await expect(merged.next()).rejects.toThrow('b failed');
    expect(closed.has('a')).toBe(true);
    expect(closed.has('b')).toBe(true);
    // `c` was never started, so closing it simply finishes it.
    await expect(c.next()).resolves.toEqual({ done: true, value: undefined });
  });
});
