# Changelog

All notable changes to the Wraith Protocol SDK will be documented in this file.

## Upcoming: 2.0.0

### Added

- **Stellar `StellarStealthSigner` Interface** (issue #121): `deriveStealthKeys()` now has a signer-based counterpart, `deriveStealthKeysFromSigner()`, that accepts any `StellarStealthSigner` (`{ signMessage(message): Promise<Uint8Array> }`) instead of assuming a synchronous Freighter-shaped ed25519 signature.
  - `FreighterStealthSigner` wraps the existing Freighter-style wallet API; the raw `deriveStealthKeys(signature)` path is unchanged.
  - `WebAuthnPasskeyStealthSigner` is a reference passkey adapter that uses the WebAuthn `prf` extension to derive stable key material across sessions, since raw WebAuthn assertion signatures are non-deterministic.
  - `useStellarStealthKeys()` in `@wraith-protocol/sdk-react` gained a `generateFromSigner()` method alongside the existing `generate()`.
- **OpenTelemetry-compatible Instrumentation Hooks** (issue #177): `src/telemetry.ts` introduces a minimal `Tracer`/`Span` interface plus `setTracer()`/`getTracer()`, exported from the package root. Zero runtime dependency on `@opentelemetry/*` or any tracing library — nothing is traced until `setTracer()` is called, and every instrumented call site defaults to a no-op tracer.
  - Instrumented: `deriveStealthKeys()`, `deriveStealthKeysFromSigner()`, `scanAnnouncementsStream()` (`stellar.scan` plus a `stellar.scan.match` span per match), `RpcClient.request()` (`stellar.rpc.request`, covering internal retries/failover), and every `ClaudeAgentTools` method (`agent.tool.*`).
  - Every instrumented function accepts a `tracer` option that overrides the global tracer for that call only.
  - `scanAnnouncementsStream` is now exported from `@wraith-protocol/sdk/chains/stellar` (it previously wasn't part of the public API surface, only reachable via a relative import).
  - Reference `@opentelemetry/api`-shaped adapter under `examples/otel/`; stable attribute names documented in `docs/observability.md`.

- **`AbortSignal` support for Stellar announcement streams** (issue #200): `fetchAnnouncementsStream` accepts `signal` in its options, and `scanAnnouncementsStream` and `RpcClient.request()` accept it in theirs.
  - Aborting cancels in-flight Soroban RPC and Horizon requests (for a parallel cold scan, every chunk's), stops pagination, releases buffered pages and closes the iterators. The pending `next()` rejects with `signal.reason`.
  - An already-aborted signal rejects before any request is sent. A cancelled `RpcClient` request never counts as an endpoint failure, so it cannot trip the circuit breaker or trigger a failover, and retry backoff is cancelled too.
  - Cancellation is documented in [`docs/chains/stellar-streaming-scan-pipeline.md`](./docs/chains/stellar-streaming-scan-pipeline.md#cancellation-and-errors).

### Performance

- **Stellar Streaming Scan Pipelining** (issue #126): `scanAnnouncementsStream` now pulls its `source` through a bounded pipeline (`src/chains/stellar/scanner/pipeline.ts`) instead of prefetching a strict window before scanning it, so RPC fetches for later pages overlap with CPU work scanning earlier ones. Peak memory stays O(window). `fetchAnnouncementsStream` and `scanAnnouncementsStream`'s public shapes are unchanged; the old windowed algorithm is retained as `scanAnnouncementsStreamSequential` for benchmark comparisons. See [`docs/chains/stellar-streaming-scan-pipeline.md`](./docs/chains/stellar-streaming-scan-pipeline.md) — measured 36% wall-clock reduction on the 10k-announcement canned benchmark.

### Changed

- **Stellar Chain Module Cryptographic Audit Fixes**: Applied all findings from independent cryptographic audit (issue #55). Breaking changes:
  - `scanAnnouncements()` now skips candidates with zero derived scalars (cryptographically required, probability ~1 in 2^255).
  - View-tag computation optimized using ephemeralPubKey ⊕ viewingPubKey prefilter (1.5–2x faster, functionally identical).
  - See [MIGRATING.md § Stellar Audit Fixes](./MIGRATING.md#stellar-cryptographic-audit-fixes-150) for details.

### Fixed

- **Stellar scan pipeline could hang on early exit** (found while working on issue #200): breaking out of `scanAnnouncementsStream` (or any `pipeline()` consumer) while its read-ahead buffer was full never returned, because the background pump stayed parked waiting for space. The pump now stops when the consumer does, and the buffer no longer overfills by one item.
- `mergeOrdered` now closes every chunk iterator when a parallel cold scan finishes, fails or is stopped early.

## [1.5.0] - 2026-05-31

### Added

- **Typed Error Taxonomy & Hierarchy**: Introduced a robust, typed error hierarchy under `src/errors.ts` (exported from the SDK root entry point) to allow consumers to programmatically handle different error categories without brittle string matching on `error.message`.
  - **Base Errors**: `WraithError` (abstract base), `WraithInputError`, `WraithCryptoError`, `WraithNetworkError`, `WraithContractError`, `WraithBuilderError`.
  - **Subclass Errors**:
    - _Inputs_: `InvalidMetaAddressError`, `InvalidNameError`, `InvalidSignatureError`, `InvalidScalarError`.
    - _Cryptography_: `KeyDerivationFailedError`, `ViewTagMismatchError`, `ECDHFailedError`.
    - _Network_: `RPCRequestError`, `RPCRetryExhaustedError`, `RetentionExceededError`.
    - _Smart Contracts_: `NameNotFoundError`, `NameAlreadyRegisteredError`, `InsufficientAuthError`, `ContractRevertError`.
    - _Builders_: `InsufficientBalanceError`, `UnsupportedAssetError`.
- **Serialization Support**: Custom error classes implement `toJSON()` and carry enumerable, public structured context fields, guaranteeing that `JSON.stringify(error)` preserves the stable code constants (e.g. `"WRAITH/CRYPTO/VIEW_TAG_MISMATCH"`), names, messages, and docs links.
- **Reference Documentation Links**: Every error instance now automatically includes a `docsLink` property pointing directly to the detailed error reference page on `https://docs.wraith.dev/sdk/errors`, which is also appended to the human-readable `message`.

### Changed

- **Codebase-wide Custom Error Migration**: Replaced generic JavaScript `Error` instances throughout the codebase (in EVM, Stellar, Solana, and CKB modules) with appropriate typed exceptions.
- **JSDoc Annotations**: Updated JSDoc `@throws` annotations across primary functions to reflect the precise custom error types thrown.

### Migration / Breaking Change Notice

- **Runtime Non-Breaking**: This release is fully backwards-compatible at a runtime level for applications that catch errors as generic JS `Error` instances, since all custom exceptions extend the native `Error` class.
- **Typing-Breaking for Brittle Matchers**: If your application catch blocks rely on exact substring matching against `error.message` (e.g. `if (e.message.includes('Expected 65-byte signature'))`), this change will break those assertions. See [MIGRATING.md § Error Handling](./MIGRATING.md#error-handling-from-message-matching-to-typed-exceptions-150) for detailed migration steps and code examples.

  Quick example:

  ```typescript
  import { InvalidSignatureError } from '@wraith-protocol/sdk';

  try {
    // ...
  } catch (e) {
    if (e instanceof InvalidSignatureError) {
      // Handle invalid signature specifically with rich structured context
      console.log(e.context.expectedLength);
    }
  }
  ```

- **React Native**: New applications targeting React Native must call `installReactNativePolyfills()` at startup. See [MIGRATING.md § React Native](./MIGRATING.md#react-native-explicit-polyfill-installation-required-150) for integration instructions.
