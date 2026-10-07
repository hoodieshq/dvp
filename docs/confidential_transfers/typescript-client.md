# TypeScript confidential client

The client supports v1 and v0 with caller-provided lookup tables. Hooked Settle
uses v1. Import confidential helpers from `clients/typescript/src/confidential`.
The root `clients/typescript/src` exports generated builders and public account
verification without loading the confidential WASM runtime. Final DvP instructions
use the generated account and argument types. Sending,
confirmation, retries, lookup-table provisioning and seed delivery belong to the
integrator. Amounts and nonces are `bigint`.

## SDK setup

The client temporarily uses `deps/solana-zk-sdk-0.5.3-dvp.453d813.tgz` because
npm version 0.5.3 lacks `PedersenOpening.fromBytes`. The archive contains the
Node, web and bundler JS/WASM outputs built with wasm-pack 0.15.0 and the upstream
Cargo lockfile from commit `453d813a8db0d7c61ad517fc3c4d6009a0a93ce4`, including
[PR #572](https://github.com/solana-program/zk-elgamal-proof/pull/572). Source and
build information (`SOURCE.txt`) and the Apache-2.0 license are included.
Installation uses the ready-built archive; no Rust or wasm-pack is needed for
the TypeScript client build. The lockfile records the archive's integrity hash.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build
```

Use Node 20.19 or newer (CI uses Node 24) and the repository's pinned pnpm
10.15.1. Make targets invoke `pnpm` directly;
enable Corepack's shim with `corepack enable pnpm` if another version is on PATH.

The pnpm override ensures Token-2022 and DvP use the same SDK instance. When
consuming this checkout in another project, include the archive and point the
dependency and override to its location. Browser applications need a bundler
that supports the SDK's WASM module; the integration suite runs in Node.

Once npm publishes the required opening byte conversion, replace the archive
dependency with that version, update or remove the override after checking the
resolved SDK versions, regenerate the lockfile and remove the archive. Rerun
the shared vectors and integration tests before switching.

## Keys and verification

`deriveSharedSeed(swapDvp, mac)` passes the domain-separated swap address to an
HMAC-SHA256 callback, allowing the master key to stay in a KMS.
`EscrowKeys.fromSeed(seed)` derives ElGamal, AE and deterministic low/high
openings. `keys.encryptAmount(amount)` accepts `1..2^48-1`. Call `keys.free()`
when finished to release its WASM allocations. Keep signing keys separate from
the shared seed.

Balance readers accept `ConfidentialAccountKeys`, a pair of
existing `{ elgamal, ae }` SDK keys. Wallet keys need not share the DvP seed or
derivation. Keep `EscrowKeys` for Create, Settle and agreed-amount verification,
which also use deterministic openings.

Use `findSwapDvpPda`, `findNonceTombstonePda` and `findSwapDvpEscrowAta` to derive
addresses. `decodeSwapDvpChecked` checks owner, exact public/confidential layout
and the confidential amount sentinel. `verifySwapDvp` additionally checks the
canonical PDA. The returned account data preserves the common generated fields
and adds `mode`; confidential data also has `confidential.base` and
`confidential.amountB`. The base's `amountB` is a sentinel, not the price.
`fetchSwapDvpAccounts` discovers both account sizes and checks their PDAs. It skips
accounts with invalid data or a noncanonical address; RPC failures still propagate.

Before funding, call `verifyConfidentialFunding(rawSwap, rawEscrow, keys,
expectedAmount)`. It checks the canonical swap and Token-2022 escrow ATA, mint,
authority, ElGamal key, approval, confidential credits, agreed amount ciphertexts
and AE/ElGamal balance agreement. A foreign ElGamal key throws
`EscrowKeyMismatchError` before the amount comparison. Compare the returned public terms with the
agreed trade as well. `readEscrowAccount` and `verifyConfidentialSwap` expose
the individual checks when accounts have already been fetched and verified.

## Sessions

Supply `SessionConfig` with a fee payer `TransactionSigner`, `format: 1` or `0`,
a rent callback and active `lookupTables` for v0. For example:

```ts
const config: SessionConfig = {
  payer,
  format: 1,
  minimumBalanceForRentExemption: (space) =>
    rpc.getMinimumBalanceForRentExemption(BigInt(space)).send(),
};
```

Defaults are 400k CU and 4 MB of loaded account data. Optional `computeUnitPrice`
is a `bigint` in micro-lamports per CU. V0 encodes `SetComputeUnitPrice`; v1 encodes
`ceil(computeUnitPrice * computeUnitLimit / 1_000_000)` as total priority-fee
lamports, following the [transaction fee rules](https://solana.com/docs/core/fees).
Omitting it leaves priority fees unset. Every preparation and final transaction
includes this fee setting in packing and size checks. Plans check the encoded
transaction size including signatures: 4096 bytes for v1, 1232 for v0. Kit also
validates message structure. V1 ignores lookup tables. Large v0 proofs use SPL
Record staging with size-checked writes.

| Helper                                                  | Purpose                                                                                 |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `createSession(config, input, keys, amount)`            | Generated Create accounts/terms, ciphertexts, decryptable zero and inline pubkey proof. |
| `applySession(config, input, source)`                   | Correct pending counter and AE balance from the full escrow balance.                    |
| `settleSession(config, input, request, extras?)`        | Payment, amount binding, optional surplus refund and zero proofs.                       |
| `refundSession(config, instruction, request?, extras?)` | Reclaim, Cancel, Reject or Recover with Partial, Full or None.                          |

`createSession` and `applySession` return a session synchronously;
`settleSession` and `refundSession` return a promise and require `await`.

Input types omit fields the helper computes, retaining the generated instruction
account names. `TransferSource` contains `{ state, keys, history? }`. Decode a
token account's extension with `confidentialState`; read its mint's optional
auditor with `mintAuditor` and pass it to settle and refund requests. For ordinary
wallet-to-escrow funding, use Token-2022's confidential transfer helpers from
`@solana-program/token-2022/confidential`; the DvP API covers escrow operations.
The test suite's funding wrapper is private to `__tests__/confidential/utils.ts`.
Settle requires the checked confidential swap, agreed amount and both recipient
snapshots. It checks combined credit capacity when payment and surplus share a
recipient.

Confirm preparations sequentially, then the final transaction. Obtain a fresh
blockhash for each send; `PlannedTransaction.sign` includes temporary account
signers carried by the instructions. The following assumes `sendAndConfirm`
submits the signed transaction as base64 and waits for confirmation:

```ts
for (const plan of [...session.preparation, session.finalTransaction]) {
  const { value: lifetime } = await rpc.getLatestBlockhash().send();
  const transaction = await plan.sign(config, lifetime);
  await sendAndConfirm(transaction);
}
```

Refresh snapshots and rebuild after conflicting available-balance changes.
Apply's expected counter does not prevent a concurrent credit from making its
supplied AE value stale; check the resulting balance and repair if needed.

`RefundAmount` is `{ kind: "partial", amount }`, `{ kind: "full" }` or
`{ kind: "none" }`. Partial must be nonzero; Full transfers all available funds,
including an encrypted zero that still needs resetting. None requires an
all-zero available ciphertext. Omitting the request selects None without client
balance checks, for example when reclaiming public leg A. Public withdrawal
through None applies to Reclaim and Recover; Cancel and Reject leave public
funds for later recovery. Full can leave pending/public funds: Apply pending
credits and refund again, or withdraw public funds with None. Amounts above
`2^48-1` require Partial refunds before the final operation. Reclaim leaves the
swap and both escrows open for funding again.

For abandonment, `session.cleanup` contains close instructions. Fetch each
target account and submit only those that still exist. Record accounts require
the payer and return rent to the payer; proof contexts require the operation
authority and return rent to that authority. Successful sessions already close
their temporary accounts. The cleanup test shows interruption followed by
cleanup and rebuilding the session.

## Hooks and recovery

`resolveConfidentialHookAccounts` resolves Token-2022 hook accounts using the
hidden-amount sentinel and removes signer privileges. Use the wallet authority
for funding and the swap PDA for outgoing escrow transfers. Pass leg A and B
extras separately; each leg permits at most 32 entries. Settle reuses leg B
extras for payment and surplus, so destination-dependent accounts must work for
both. Hooked Settle requires v1; funding and refunds can use either format if
they fit. For ordinary public transfers, use Token-2022's
`resolveExtraAccountMetasForExecute` with the actual public amount.

`readEscrowBalance` returns available, pending, pending credit count and the
public amount supplied from the token snapshot. `readAvailableBalance` avoids
decoding unrelated pending funds. AE values are accepted only after checking
the ElGamal ciphertext; otherwise both readers fall back to verified history.
Funding verification rejects false AE rather than silently repairing it.

Fetch history at the snapshot's commitment through its actual transaction
position. Include proof preparation transactions and Token-2022 inner
instructions in block order, starting from account configuration. Decode
`getTransaction` responses with `encoding: "base64"` and
`maxSupportedTransactionVersion: 1` using `executedTransactionFromRpc`, then
feed them to `BalanceHistory.push`. Failed transactions are ignored; historical
v0 loaded addresses and complete inner-instruction metadata are required.

Pass `history.events()` to the balance reader or directly to
`recoverEscrowBalance(state, publicAmount, keys, events)`. Recovery validates
available, both pending limbs and the counter against the snapshot. The public
amount comes from the snapshot, not CT replay. Incomplete history fails.
Transfer, Deposit, Withdraw, Apply, Empty, ConfidentialMint and ConfidentialBurn
are supported; confidential TransferWithFee is rejected.

SPL Record writes are replayed automatically. For other proof accounts,
`history.push(transaction, resolveProofAccount)` accepts a synchronous callback
returning full account bytes as they existed at verification. Retain those bytes
or obtain them from a historical account-data source; normal transaction RPC
does not provide them. Missing data blocks recovery when the escrow operation
uses that context. Discard the collector after a decoding error.

## Examples and tests

Start with `clients/typescript/examples/confidential/swap.ts`: a sequential
Create → verify → fund both legs → Apply → Settle workflow with exact payment,
without hooks or an auditor. Supply the generated instruction inputs for the
agreed deal, derived escrow keys and a session config. Wallets/mints/receiving
accounts must already exist; v0 needs active lookup tables.

The `wallet.fund` callback performs and confirms the parties' ordinary SPL
transfers using the checked escrow state. `wallet.send` confirms a DvP session;
connect it to `sendSession` and retain the session for cleanup if sending fails.
The example refreshes account snapshots after funding and Apply. The caller owns
and frees the keys. Tests execute this complete example in both v0 and v1;
wallet setup and LiteSVM stay in test helpers.

`clients/typescript/examples/confidential/settle.ts` shows preparing a settlement
from one RPC snapshot: verify the escrow and amount, decode recipient balances,
read the auditor and build the proof session. It assumes both legs are funded,
pending credits are applied and there are no transfer hooks. The v0/v1 settlement
tests execute this example against LiteSVM. `send-session.ts` shows signing and
sending preparations in order through the integrator's send-and-confirm callback.
Keep the session for cleanup if sending fails. All example files are typechecked
by `pnpm test` and excluded from the library build.

`clients/typescript/src/__tests__/confidential/` groups scenarios by instruction and
covers each lifecycle instruction,
v0/v1 funding and settlement, auditor and nonzero high limbs, partial/full/None
refunds, false AE repair from funding history, hooks with memo and interrupted preparation
cleanup. Wallets use independent random keys. Shared vectors check deterministic keys
and ciphertexts. `confidential/verify.test.ts` checks foreign keys and an incorrect
agreed amount before funding; common discovery and RPC-error checks live in
`clients/typescript/src/__tests__/verify.test.ts`. Broad negative coverage remains
in the Rust suite.

The TypeScript tests build, prove, sign and execute real transactions directly
through the `litesvm` npm package against the same pinned programs as Rust.
`context.ts` and `utils.ts` contain only test setup and execution helpers and are
excluded from the client build and public exports. All tests use `node:test` and
`node:assert`, run through `tsx`. From the repository root, `pnpm test` typechecks
the client, examples and tests, then recursively discovers every `*.test.ts`
under `clients/typescript/src/__tests__/`. Use Node 24 for this command, matching
CI and its recursive test discovery. Helpers such as `utils.ts` and
`context.ts` are not collected as tests. Test files run sequentially to limit
concurrent proof generation.

After `make build` and `make fetch-test-fixtures`, run `pnpm test` or
`make typescript-test`. `make integration-test-no-build`, `make all-test` and CI
include the same complete suite.
