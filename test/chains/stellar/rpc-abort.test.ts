import { describe, expect, it, vi } from 'vitest';
import { createRpcClient } from '../../../src/chains/stellar/rpc';

const primaryUrl = 'https://rpc-primary.test';
const fallbackUrl = 'https://rpc-fallback.test';

/** Fails the test instead of hanging the suite when a promise never settles. */
function within<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** fetch double: `hang` requests wait until their signal aborts, like the platform fetch. */
function fetchDouble(respond: (url: string) => Response | 'hang') {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal ?? undefined;
    return new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const result = respond(String(input));
      if (result === 'hang') {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      } else {
        resolve(result);
      }
    });
  });
}

const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

describe('RpcClient.request with an AbortSignal', () => {
  it('rejects without calling fetch when the signal is already aborted', async () => {
    const fetchImpl = fetchDouble(ok);
    const client = createRpcClient({ endpoints: [{ url: primaryUrl }], fetchImpl });
    const controller = new AbortController();
    controller.abort();

    await expect(
      client.request('GET', '/', undefined, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('cancels the in-flight fetch and neither fails over nor marks the endpoint unhealthy', async () => {
    let hang = true;
    const fetchImpl = fetchDouble((url) => (hang && url.startsWith(primaryUrl) ? 'hang' : ok()));
    const client = createRpcClient({
      endpoints: [{ url: primaryUrl }, { url: fallbackUrl }],
      circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 },
      fetchImpl,
    });
    const failovers: unknown[] = [];
    client.on('endpointFailover', (detail) => failovers.push(detail));

    const controller = new AbortController();
    const pending = client.request('GET', '/', undefined, { signal: controller.signal });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const reason = new Error('navigated away');
    controller.abort(reason);

    await expect(within(pending)).rejects.toBe(reason);
    expect(fetchImpl.mock.calls[0][1]?.signal).toBe(controller.signal);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(failovers).toEqual([]);
    expect(client.getHealthyEndpoint()).toBe(primaryUrl);

    // Even with failureThreshold 1, the next request still goes to the primary.
    hang = false;
    await expect(client.request('GET', '/')).resolves.toEqual({ ok: true });
    expect(fetchImpl.mock.calls[1][0]).toBe(`${primaryUrl}/`);
  });

  it('cancels a retry backoff instead of waiting it out', async () => {
    const fetchImpl = fetchDouble(() => new Response('{}', { status: 503 }));
    const client = createRpcClient({
      endpoints: [{ url: primaryUrl }],
      retry: { maxRetries: 5, baseDelayMs: 60_000, maxDelayMs: 60_000 },
      circuitBreaker: { failureThreshold: 10, cooldownMs: 60_000 },
      fetchImpl,
    });

    const controller = new AbortController();
    const pending = client.request('GET', '/', undefined, { signal: controller.signal });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10)); // now sleeping in the 30-60s backoff
    controller.abort();

    await expect(within(pending)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('cancels the backoff after a network error too', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const client = createRpcClient({
      endpoints: [{ url: primaryUrl }],
      retry: { maxRetries: 5, baseDelayMs: 60_000, maxDelayMs: 60_000 },
      circuitBreaker: { failureThreshold: 10, cooldownMs: 60_000 },
      fetchImpl,
    });

    const controller = new AbortController();
    const pending = client.request('GET', '/', undefined, { signal: controller.signal });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));
    const reason = new Error('cancelled');
    controller.abort(reason);

    await expect(within(pending)).rejects.toBe(reason);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('behaves as before without a signal', async () => {
    const fetchImpl = fetchDouble(ok);
    const client = createRpcClient({ endpoints: [{ url: primaryUrl }], fetchImpl });
    await expect(client.request('GET', '/')).resolves.toEqual({ ok: true });
  });
});
