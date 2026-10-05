# Changelog

## 0.5.0

### Fixed

- **The request timeout now covers the response body.** A server that sent
  headers and then stalled used to hang `request()` for good; it now rejects
  with `TIMEOUT`. A body cut off mid-read is a `NETWORK_ERROR`.
- **A throwing `onPaid` no longer turns a verified payment into an error.**
  `createPayFlow` stays `"paid"` and puts what `onPaid` threw on
  `state.onPaidError`. A throwing subscriber no longer makes `pay()` throw or
  hides the outcome from other subscribers. `recover()` behaves the same.
- **Only a stale blockhash is retried.** A wallet or node simulation failure
  for any other reason (not enough SOL for the fee, a program error) is
  reported as `SEND_FAILED` at once, instead of asking the buyer to approve it
  up to three times and then reporting `BLOCKHASH_EXPIRED`.
- **A payment attempt that can't be registered says so.** Failures of the
  register call, or of your `onSignature` callback, are thrown as
  `ATTEMPT_NOT_REGISTERED`. Nothing has been broadcast at that point, so the
  buyer can try again; the error has no `signature`.
- **A 2xx response that isn't JSON is an error** (`INVALID_RESPONSE`) instead
  of resolving to `null`. An empty body is still `null`.
- Argument and option errors now carry a code, `INVALID_INPUT` or
  `INVALID_CONFIG`.
- `createPayFlow`'s `listWallets` option is in the type declarations.
- Tests run on Node 20 and 22 as well as 24: `npm test` lists the files
  itself instead of relying on a glob the older runners don't expand.

### Changed

- **Requires Node 20.19 or newer** (was 18). Older versions can't load the
  `@solana/web3.js` dependency tree as ES modules.
- `main`, `types` and `typesVersions` are set, so tools using the old
  `node10` module resolution find the types for the root, `/server` and
  `/react`.
- CI runs on Node 20, 22 and 24, with an audit, `npm pack`, `publint` and
  `@arethetypeswrong/cli` check.

## 0.4.1

- Solana Pay polling backs off, so a QR left open costs about 140 RPC
  requests instead of 600.
