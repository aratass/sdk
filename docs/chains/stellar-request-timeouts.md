# Stellar Horizon and RPC request timeouts

`createHorizonClient()` and `createRpcClient()` give every HTTP attempt two timeouts, so an
endpoint that stops answering cannot hold a scan or any other request forever.

| Option      | Default | Covers                                                                                                                                                                     |
| :---------- | :------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connectMs` | `10000` | Everything up to the response headers: DNS, connecting, TLS, sending the request and waiting for the endpoint to answer. `fetch()` has no separate hook for the handshake. |
| `requestMs` | `30000` | The whole attempt, including reading the response body.                                                                                                                    |

Set either one to `0` to turn it off. Each retry and each failover attempt gets a fresh budget.

## Configuring

```ts
import { createHorizonClient, createRpcClient } from '@wraith-protocol/sdk/chains/stellar';

const rpc = createRpcClient({
  endpoints: [{ url: 'https://soroban-testnet.stellar.org' }, { url: 'https://rpc.example.org' }],
  timeouts: { connectMs: 5_000, requestMs: 20_000 },
});

// Override for a single call.
await rpc.request('POST', '/', body, { timeouts: { requestMs: 60_000 } });

const horizon = createHorizonClient({ horizonUrl: 'https://horizon-testnet.stellar.org' });

// Horizon holds a `POST /transactions` response until the transaction is in a ledger, which can
// take tens of seconds. Give submissions a longer budget than the defaults.
await horizon.post('/transactions', new URLSearchParams({ tx }), {
  timeouts: { connectMs: 60_000, requestMs: 60_000 },
});
```

## What happens when a timeout fires

1. The attempt's `AbortController` is aborted, so the request is cancelled before the client
   retries or fails over. The fetch and the body read are also raced against the deadline, so a
   `fetch` implementation that ignores the abort signal cannot hang the attempt either.
2. The timeout counts as a failed attempt, like a network error:
   - `createHorizonClient()` retries it under its retry policy.
   - `createRpcClient()` retries it and counts it toward the circuit breaker. After
     `failureThreshold` consecutive failures it fails over to the next endpoint and emits
     `endpointFailover` with a reason such as `Timeout on https://rpc.example.org: connect timeout of 5000ms`.
     An endpoint only counts as healthy once a response body has been read in full, so one that
     sends headers and then stalls still trips the breaker.
3. When every attempt fails, the client throws `RPCRetryExhaustedError`. Its `cause` is the
   error from the last attempt: an `RPCTimeoutError` if that attempt timed out.

## `RPCTimeoutError`

`RPCTimeoutError` (`WRAITH/NETWORK/RPC_TIMEOUT`) extends `WraithNetworkError` and records where
the attempt was when it timed out. The same fields are on `error.context`.

| Field       | Meaning                                                |
| :---------- | :----------------------------------------------------- |
| `url`       | Full URL of the request.                               |
| `endpoint`  | Base URL of the endpoint the attempt was sent to.      |
| `attempt`   | 1-based attempt number, counting retries and failover. |
| `phase`     | `'connect'` or `'request'`: which timeout fired.       |
| `timeoutMs` | The timeout that elapsed, in milliseconds.             |

```ts
import { RPCRetryExhaustedError, RPCTimeoutError } from '@wraith-protocol/sdk';

try {
  await rpc.request('POST', '/', body);
} catch (error) {
  if (error instanceof RPCRetryExhaustedError && error.cause instanceof RPCTimeoutError) {
    const { endpoint, attempt, phase, timeoutMs } = error.cause;
    console.warn(`${endpoint} hit its ${phase} timeout (${timeoutMs}ms) on attempt ${attempt}`);
  }
}
```

`cause` is not enumerable and is left out of `toJSON()`, the same as on the wallet errors.

## One-shot Horizon helpers

`findStrictReceivePath()`, `buildMultisigStealthWithdraw()` (when it loads the account from
`horizonUrl`) and `submitOfflineStellarTransaction()` each make one Horizon request, with no
retries. They take the same `timeouts` shape plus an `AbortSignal`.

| Helper                                                   | Options                              | Default `timeouts`                       |
| :------------------------------------------------------- | :----------------------------------- | :--------------------------------------- |
| `findStrictReceivePath(options)`                         | `options.signal`, `options.timeouts` | `{ connectMs: 10000, requestMs: 30000 }` |
| `buildMultisigStealthWithdraw(options)`                  | `options.signal`, `options.timeouts` | `{ connectMs: 10000, requestMs: 30000 }` |
| `submitOfflineStellarTransaction(xdr, network, options)` | `options.signal`, `options.timeouts` | `{ connectMs: 0, requestMs: 60000 }`     |

Horizon answers a submission only once the transaction is in a ledger or its own wait runs out,
so a submission has no separate headers timeout by default.

```ts
import {
  findStrictReceivePath,
  submitOfflineStellarTransaction,
} from '@wraith-protocol/sdk/chains/stellar';

const controller = new AbortController();

const { sourceAmount, path } = await findStrictReceivePath({
  sendAsset,
  receiveAsset,
  destAmount: '100',
  signal: controller.signal,
  timeouts: { requestMs: 5_000 },
});

const result = await submitOfflineStellarTransaction(signedXdr, 'stellar', {
  signal: controller.signal,
});
```

Every failure maps onto the error taxonomy:

| Failure                                                          | Error                                                                                        |
| :--------------------------------------------------------------- | :------------------------------------------------------------------------------------------- |
| The signal is aborted, before or during the request              | `RPCAbortedError` (`WRAITH/NETWORK/RPC_ABORTED`), with the signal's `reason` on `cause`      |
| A timeout fires                                                  | `RPCTimeoutError` (`WRAITH/NETWORK/RPC_TIMEOUT`), with `attempt: 1`                          |
| Horizon answers with a non-2xx status                            | `RPCRequestError` (`WRAITH/NETWORK/RPC_REQUEST`), with the body on `context.responseText`    |
| A success response is not JSON, is oversized or fails validation | `HorizonResponseError` (`WRAITH/NETWORK/HORIZON_RESPONSE`), with the failing part on `field` |

A submission that times out or is aborted may still be applied. Look the transaction up by its
hash before submitting it again.
