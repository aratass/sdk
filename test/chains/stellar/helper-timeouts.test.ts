import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Asset, Keypair, Networks } from '@stellar/stellar-sdk';
import { findStrictReceivePath } from '../../../src/chains/stellar/path-payment';
import { buildMultisigStealthWithdraw } from '../../../src/chains/stellar/multisig';
import { submitOfflineStellarTransaction } from '../../../src/chains/stellar/offline-sign';
import type { HorizonCallOptions } from '../../../src/chains/stellar/request';
import {
  HorizonResponseError,
  RPCAbortedError,
  RPCRequestError,
  RPCTimeoutError,
} from '../../../src/errors';

const HORIZON = 'https://horizon.test';
const USDC = new Asset('USDC', Keypair.random().publicKey());
const STEALTH = Keypair.random().publicKey();
const SIGNER = Keypair.random().publicKey();

/** How one scripted fetch call behaves, given the signal the helper passed in. */
type Behaviour = (signal: AbortSignal | undefined) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const ok =
  (body: unknown): Behaviour =>
  async () =>
    jsonResponse(body);

/** Never answers, but rejects when aborted, like a real fetch to a black-holed host. */
const hang: Behaviour = (signal) =>
  new Promise((_, reject) =>
    signal?.addEventListener('abort', () =>
      reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')),
    ),
  );

/** Never settles and ignores the abort signal, like a broken fetch polyfill. */
const ignoresAbort: Behaviour = () => new Promise(() => undefined);

/** Sends 200 headers and part of the body, then stalls until aborted. */
const stallsMidBody: Behaviour = async (signal) => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"source_amount":'));
      signal?.addEventListener('abort', () => controller.error(signal.reason));
    },
  });
  return new Response(stream, { status: 200 });
};

let fetchMock: ReturnType<typeof vi.fn>;

/** Stubs the global fetch with one behaviour per call. */
function script(...behaviours: Behaviour[]) {
  fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const next = behaviours.shift();
    if (!next) throw new Error('unexpected fetch');
    return next(init?.signal ?? undefined);
  });
  vi.stubGlobal('fetch', fetchMock);
}

function signalOfCall(n = 0): AbortSignal {
  return (fetchMock.mock.calls[n][1] as RequestInit).signal as AbortSignal;
}

/** Records how a promise settled without letting a rejection go unhandled. */
function track<T>(promise: Promise<T>) {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  promise.then(
    (value) => Object.assign(state, { settled: true, value }),
    (error) => Object.assign(state, { settled: true, error }),
  );
  return state;
}

const PATH_PAGE = {
  _embedded: {
    records: [
      {
        source_amount: '50.0000000',
        source_asset_type: 'credit_alphanum4',
        source_asset_code: 'USDC',
        source_asset_issuer: USDC.issuer,
        destination_amount: '100.0000000',
        destination_asset_type: 'native',
        path: [],
      },
    ],
  },
};

const ACCOUNT = {
  sequence: '100',
  thresholds: { low_threshold: 1, med_threshold: 2, high_threshold: 2 },
  signers: [
    { key: SIGNER, weight: 2, type: 'ed25519_public_key' },
    { key: STEALTH, weight: 0, type: 'ed25519_public_key' },
  ],
};

const SUBMITTED = { hash: 'ab'.repeat(32), ledger: 7, successful: true };

interface HelperCase {
  name: string;
  run: (options: HorizonCallOptions) => Promise<unknown>;
  okBody: unknown;
  /** Default headers timeout; 0 means off. */
  connectMs: number;
  /** Default whole-request timeout. */
  requestMs: number;
}

const helpers: HelperCase[] = [
  {
    name: 'findStrictReceivePath',
    run: (options) =>
      findStrictReceivePath({
        sendAsset: USDC,
        receiveAsset: Asset.native(),
        destAmount: '100',
        horizonUrl: HORIZON,
        ...options,
      }),
    okBody: PATH_PAGE,
    connectMs: 10_000,
    requestMs: 30_000,
  },
  {
    name: 'buildMultisigStealthWithdraw',
    run: (options) =>
      buildMultisigStealthWithdraw({
        stealthAddress: STEALTH,
        destination: Keypair.random().publicKey(),
        signers: [SIGNER],
        networkPassphrase: Networks.TESTNET,
        horizonUrl: HORIZON,
        ...options,
      }),
    okBody: ACCOUNT,
    connectMs: 10_000,
    requestMs: 30_000,
  },
  {
    name: 'submitOfflineStellarTransaction',
    run: (options) => submitOfflineStellarTransaction('AAAAAgAAAAA=', 'stellar', options),
    okBody: SUBMITTED,
    connectMs: 0,
    requestMs: 60_000,
  },
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe.each(helpers)('$name', (helper) => {
  it('passes an abort signal to fetch and clears its timers once settled', async () => {
    script(ok(helper.okBody));

    await expect(helper.run({})).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(signalOfCall()).toBeInstanceOf(AbortSignal);
    expect(signalOfCall().aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects an already aborted signal without sending anything', async () => {
    script();
    const controller = new AbortController();
    const reason = new Error('user left the page');
    controller.abort(reason);

    const error = await helper.run({ signal: controller.signal }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(RPCAbortedError);
    expect((error as RPCAbortedError).code).toBe('WRAITH/NETWORK/RPC_ABORTED');
    expect((error as RPCAbortedError).cause).toBe(reason);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts the request in flight when the signal fires', async () => {
    script(hang);
    const controller = new AbortController();
    const result = track(helper.run({ signal: controller.signal }));

    await vi.advanceTimersByTimeAsync(500);
    expect(result.settled).toBe(false);

    controller.abort('cancelled');
    await vi.advanceTimersByTimeAsync(0);

    expect(result.error).toBeInstanceOf(RPCAbortedError);
    expect((result.error as RPCAbortedError).cause).toBe('cancelled');
    expect(signalOfCall().aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out with the default policy', async () => {
    script(hang);
    const result = track(helper.run({}));
    const firstTimeout = helper.connectMs || helper.requestMs;

    await vi.advanceTimersByTimeAsync(firstTimeout - 1);
    expect(result.settled).toBe(false);
    expect(signalOfCall().aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(result.error).toBeInstanceOf(RPCTimeoutError);
    expect(result.error).toMatchObject({
      attempt: 1,
      phase: helper.connectMs ? 'connect' : 'request',
      timeoutMs: firstTimeout,
    });
    expect(signalOfCall().aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honours custom timeouts', async () => {
    script(hang);
    const result = track(helper.run({ timeouts: { connectMs: 250, requestMs: 1_000 } }));

    await vi.advanceTimersByTimeAsync(249);
    expect(result.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(result.error).toBeInstanceOf(RPCTimeoutError);
    expect(result.error).toMatchObject({ phase: 'connect', timeoutMs: 250 });
  });

  it('times out a fetch that ignores the abort signal', async () => {
    script(ignoresAbort);
    const result = track(helper.run({ timeouts: { connectMs: 0, requestMs: 500 } }));

    await vi.advanceTimersByTimeAsync(500);

    expect(result.error).toBeInstanceOf(RPCTimeoutError);
    expect(result.error).toMatchObject({ phase: 'request', timeoutMs: 500 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out a body that stalls after the headers', async () => {
    script(stallsMidBody);
    const result = track(helper.run({ timeouts: { connectMs: 0, requestMs: 700 } }));

    await vi.advanceTimersByTimeAsync(699);
    expect(result.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(result.error).toBeInstanceOf(RPCTimeoutError);
    expect(result.error).toMatchObject({ phase: 'request', timeoutMs: 700 });
  });

  it('maps an HTTP error to RPCRequestError with the response body', async () => {
    script(async () => jsonResponse({ title: 'Service Unavailable', status: 503 }, 503));

    const error = await helper.run({}).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(RPCRequestError);
    expect((error as RPCRequestError).statusCode).toBe(503);
    expect(JSON.parse((error as RPCRequestError).context?.responseText)).toEqual({
      title: 'Service Unavailable',
      status: 503,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a success response that is not JSON', async () => {
    script(async () => new Response('<html>gateway</html>', { status: 200 }));

    const error = await helper.run({}).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(HorizonResponseError);
    expect((error as HorizonResponseError).code).toBe('WRAITH/NETWORK/HORIZON_RESPONSE');
    expect((error as HorizonResponseError).field).toBe('body');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('buildMultisigStealthWithdraw account lookup', () => {
  const build = () =>
    buildMultisigStealthWithdraw({
      stealthAddress: STEALTH,
      destination: Keypair.random().publicKey(),
      signers: [SIGNER],
      networkPassphrase: Networks.TESTNET,
      horizonUrl: HORIZON,
    });

  it.each([
    ['no sequence', { ...ACCOUNT, sequence: 100 }, 'sequence'],
    ['no thresholds', { ...ACCOUNT, thresholds: undefined }, 'thresholds'],
    ['no signers', { ...ACCOUNT, signers: 'none' }, 'signers'],
    ['a signer without a weight', { ...ACCOUNT, signers: [{ key: SIGNER }] }, 'signers'],
  ])('rejects an account record with %s as malformed', async (_label, body, field) => {
    script(ok(body));

    const error = await build().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(HorizonResponseError);
    expect((error as HorizonResponseError).field).toBe(field);
    expect((error as HorizonResponseError).context?.url).toBe(`${HORIZON}/accounts/${STEALTH}`);
  });

  it('makes no request when the account record is supplied', async () => {
    script();

    await expect(
      buildMultisigStealthWithdraw({
        stealthAddress: STEALTH,
        destination: Keypair.random().publicKey(),
        signers: [SIGNER],
        networkPassphrase: Networks.TESTNET,
        account: ACCOUNT,
        timeouts: { requestMs: 1 },
      }),
    ).resolves.toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('submitOfflineStellarTransaction responses', () => {
  it('keeps the Horizon result codes on the RPCRequestError', async () => {
    const problem = {
      type: 'https://stellar.org/horizon-errors/transaction_failed',
      title: 'Transaction Failed',
      status: 400,
      extras: { result_codes: { transaction: 'tx_bad_seq' } },
    };
    script(async () => jsonResponse(problem, 400));

    const error = await submitOfflineStellarTransaction('AAAAAgAAAAA=').catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(RPCRequestError);
    expect((error as RPCRequestError).context?.url).toMatch(/\/transactions$/);
    expect(JSON.parse((error as RPCRequestError).context?.responseText)).toEqual(problem);
  });

  it('sends the transaction as a form body', async () => {
    script(ok(SUBMITTED));

    await submitOfflineStellarTransaction('AAAAAgAAAAA=');

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(String(init.body)).toBe('tx=AAAAAgAAAAA%3D');
  });

  it('rejects a JSON body that is not an object', async () => {
    script(ok(['not', 'an', 'object']));

    const error = await submitOfflineStellarTransaction('AAAAAgAAAAA=').catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(HorizonResponseError);
    expect((error as HorizonResponseError).field).toBe('body');
  });
});
