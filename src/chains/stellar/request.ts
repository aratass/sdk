import { HorizonResponseError, RPCAbortedError, RPCRequestError } from '../../errors';
import { AttemptDeadline, resolveTimeouts, type RequestTimeouts } from './timeouts';

/**
 * Cancellation and timeout options for the one-shot Horizon helpers `findStrictReceivePath()`,
 * `buildMultisigStealthWithdraw()` and `submitOfflineStellarTransaction()`.
 */
export interface HorizonCallOptions {
  /**
   * Cancels the Horizon request. The helper then rejects with `RPCAbortedError`, with the
   * signal's `reason` on `cause`. An already aborted signal rejects before anything is sent.
   */
  signal?: AbortSignal;
  /**
   * Connect and request timeouts. A request that runs past either is aborted and the helper
   * rejects with `RPCTimeoutError`. Each helper documents its defaults; `0` turns a timeout off.
   */
  timeouts?: RequestTimeouts;
}

/** One request made by {@link requestHorizonJson}. */
export interface HorizonJsonRequest {
  /** Full request URL. */
  url: string;
  /** Base URL of the Horizon server, reported on a timeout error. */
  endpoint: string;
  /** Fetch options. The signal is set by the helper. */
  init?: RequestInit;
  /** Caller's cancellation signal. */
  signal?: AbortSignal;
  /** Timeout layers merged over the defaults, later layers winning. */
  timeouts?: Array<RequestTimeouts | undefined>;
}

/** Calls the current global `fetch`, so it is looked up per request and called unbound. */
const globalFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

/**
 * Sends one Horizon request, without retries, and resolves with the parsed JSON body.
 *
 * Rejects with `RPCAbortedError` when `signal` aborts, `RPCTimeoutError` when a timeout fires,
 * `RPCRequestError` for a non-2xx status (the response body on `responseText`) and
 * `HorizonResponseError` when a successful response is not JSON.
 */
export async function requestHorizonJson(request: HorizonJsonRequest): Promise<unknown> {
  const { url, endpoint, init = {}, signal } = request;
  const timeouts = resolveTimeouts(...(request.timeouts ?? []));
  const aborted = () => new RPCAbortedError(url, { cause: signal?.reason });
  if (signal?.aborted) throw aborted();

  const deadline = new AttemptDeadline(timeouts, { url, endpoint, attempt: 1 });
  const onAbort = () => deadline.abort(aborted());
  signal?.addEventListener('abort', onAbort);
  try {
    const response = await deadline.send(globalFetch, url, init);
    if (!response.ok) {
      throw new RPCRequestError(url, response.status, await readErrorBody(deadline, response));
    }
    if (typeof response.json !== 'function') {
      throw new HorizonResponseError(url, 'body', 'missing');
    }
    try {
      return await deadline.read(response.json());
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new HorizonResponseError(url, 'body', 'not valid JSON');
      }
      throw err;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    deadline.dispose();
  }
}

/**
 * Reads an error response's body for `RPCRequestError.responseText`. JSON is compacted to one
 * line. A body that cannot be read leaves the text empty, unless the caller aborted meanwhile.
 */
async function readErrorBody(deadline: AttemptDeadline, response: Response): Promise<string> {
  if (typeof response.text !== 'function') return '';
  let text: string;
  try {
    text = await deadline.read(response.text());
  } catch (err) {
    if (err instanceof RPCAbortedError) throw err;
    return '';
  }
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return text;
  }
}
