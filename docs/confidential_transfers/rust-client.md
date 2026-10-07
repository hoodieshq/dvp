# Rust confidential client

The Rust client supports v1 and v0 with caller-provided lookup tables. Hooked
Settle uses v1. Sending, retries, lookup-table provisioning and seed delivery
belong to the caller. Keep the shared seed and signing keys separate.

Enable the opt-in `confidential` feature for the handwritten API in
`dvp_swap_program_client::confidential`;
account verification is in `verify`. Builders consume the generated account and
argument types from `instructions` and `types`, and use them to encode the final
instructions. Keys, proofs and session builders work without the optional `fetch`
feature. That feature adds fetched-account wrappers, RPC account discovery and
RPC transaction decoding. Default features are empty: generated builders, CPI
builders and raw verification do not require the ZK SDK. `ciphertext` contains
the always-available wire types. `test-utils` is internal integration-test support,
not part of the normal client API.

## Keys and funding checks

`derive_shared_seed(swap, mac)` passes the protocol tag and swap address to the
caller's HMAC-SHA256 callback. `EscrowKeys::from_seed` derives ElGamal, AE and
the two deterministic openings; `encrypt_amount` accepts `1..=2^48-1`.
The shared fixtures are in `clients/test-vectors/confidential-amount-b.json`.
Regenerate them explicitly with
`cargo test -p dvp-swap-program-client --features confidential --lib regenerate_shared_vectors -- --ignored`.
Normal tests only read these fixtures.

Before funding, use `verify::verify_swap_dvp_bytes` (or the `fetch` feature's
`decode_swap_dvp_account`) to check owner, exact layout, canonical swap PDA and
the confidential amount sentinel.
The result is `SwapDvpAccount::Public` or `SwapDvpAccount::Confidential`; the
confidential base's `amount_b` is a sentinel. These decoders now return
`SwapDvpAccount` instead of `SwapDvp`; existing public-only callers should match
`Public` or use `base()` when they need only common fields. Use `read_escrow_account` to check
the Token-2022 owner, canonical ATA, token authority and mint. Then call
`verify_confidential_swap` with the agreed amount and derived keys. It checks the
escrow key first (`EscrowKeyMismatch`), then the amount ciphertexts
(`AmountMismatch`), approval, confidential credits and AE/ElGamal
balance agreement. `fetch_swap_dvp_accounts` queries both account sizes, skips
invalid accounts and still propagates RPC errors.
With `fetch`, `verify::verify_confidential_funding` combines these checks over the
two fetched accounts and returns the checked terms and CT state.

## Transaction sessions

Construct `SessionConfig` with the fee payer, format, current cluster rent and
active lookup tables for v0. The default limits are 400k CU and 4 MB of loaded
account data. Set `compute_unit_price: Some(price)` in micro-lamports per CU to
include priority fees in every size check and proof-packing decision. V0 uses
`SetComputeUnitPrice`; v1 stores `ceil(price * compute_unit_limit / 1_000_000)`
lamports. `None` omits the fee. Each signed transaction is checked against 4096 bytes for v1 or
1232 bytes for v0, including signatures and compute-budget instructions. SDK
message validation also rejects structural limits before signing; v1 permits at
most 64 unique addresses, including base and extra accounts. V1 ignores lookup
tables; v0 uses `SessionConfig::lookup_tables`. Settle checks capacity for two
incoming credits when payment and surplus use the same destination account.

| Builder | Inputs and result |
| --- | --- |
| `create_session` | Generated Create accounts/terms, keys and agreed amount; inserts ciphertexts, decryptable zero and the inline pubkey proof. |
| `apply_session` | Generated Apply accounts/seed terms and `TransferSource`; computes the actual pending counter and correct new AE balance. |
| `settle_session` | Checked confidential swap, agreed amount, escrow and both recipients; prepares payment, amount-binding, optional surplus and zero proofs. |
| `refund_session` | `RefundInstruction` wrapping generated Reclaim/Cancel/Reject/Recover accounts and optional `RefundRequest`; prepares `Partial`/`Full` proofs or `None` without proofs. |

Funding is an ordinary SPL Token-2022 wallet transfer to the verified escrow.
Use the SPL SDK for it; the DvP client does not expose a generic transfer builder.

`TransferSource` contains the CT snapshot, its keys and recovered history events.
Read the mint's optional auditor with `mint_auditor`. For confidential transfers,
resolve leg B hook extras with `resolve_confidential_hook_accounts`, which uses
`u64::MAX` and strips signer flags. A public withdrawal through `None` in Reclaim
or Recover uses the actual public amount: resolve its ordinary TransferChecked
extras with that amount. Pass leg A's ordinary hook extras separately. Settle
with hook extras on either leg returns `HookedSettleRequiresV1` in v0. Hooked
funding and refunds support both formats, subject to transaction limits. Each
leg accepts at most 32 extra account entries. Settle reuses the same leg B extras
for payment and surplus, so destination-dependent hook accounts must work for
both transfers. For wallet funding, pass the wallet's authority to the resolver;
for transfers out of escrow, pass the swap PDA.

`RefundAmount::Full` transfers all available funds, including zero when the
ciphertext has not been reset. `Partial(0)` is rejected by the client with
`ZeroPartialRefund`, even though the program can accept valid zero-transfer
proofs. `RefundAmount::None` requires available to be all-zero bytes, not merely
an encryption of zero. It withdraws public tokens only for Reclaim and Recover;
Cancel and Reject leave them in escrow for later recovery. A missing
`RefundRequest` selects `None` without client balance checks, as needed for a
public leg A reclaim; the program still validates the selected operation.

Confirm each `session.preparation` transaction in order, then send
`session.final_transaction`. `PlannedTransaction::sign` combines caller signers
with the temporary account keys; supply a fresh blockhash at send time. Request
base64 encoding for v1 RPC submission. Refresh snapshots and rebuild proofs after
a conflicting available-balance change. Apply also needs a fresh snapshot:
Token-2022 records `expected_pending_balance_credit_counter` but does not reject
a mismatch. A credit arriving before execution can make the supplied AE value
stale, so check the resulting balance and repair it if necessary.

In v0, large proofs are written to SPL Record in size-checked chunks and verified
at `RecordData::WRITABLE_START_INDEX`. Preparation closes records after use;
the successful final transaction closes proof contexts. `session.cleanup`
contains close instructions for abandonment: Record accounts require the payer's
signature and return rent to the payer; proof contexts require the operation
authority's signature and return rent to that authority. Submit only instructions
whose accounts exist. Reclaim leaves escrows open; Full refunds may leave pending
or public tokens, followed by Apply and/or a None public withdrawal as needed.
Transfers above `2^48-1` require Partial refunds before the final operation.

## Balance recovery

Read the escrow snapshot and successful transaction history at the same
commitment. History starts at ConfigureAccount and includes Token-2022 CPIs in
execution order. Failed transactions contribute no operations. Resolve address
lookup tables before decoding instruction accounts, and retain proof-verification
transactions (including SPL Record writes) when the proof context was created in
a separate transaction. Fetch transactions with maxSupportedTransactionVersion=1.
With `fetch`, `ExecutedTransaction::from_rpc` decodes binary getTransaction
responses, resolves historical `loadedAddresses` and includes compiled inner
instructions. Successful responses must include an empty inner-instruction list
when there were no CPIs; parsed instructions or missing required metadata return
`IncompleteHistory`. Feed these transactions to `BalanceHistory::push`
chronologically, then pass `events()` to the balance reader.
Transactions sharing a slot must follow their actual block order. Include only
history through the snapshot being checked. After a decoding error, discard the
`BalanceHistory` instance; `push` may already have applied part of that transaction.

Replay incoming transfers and ConfidentialMint into pending low/high balances,
outgoing transfers and ConfidentialBurn out of available, and Apply into available.
Deposit adds public tokens to pending; Withdraw subtracts from available. Configure
resets the replayed event list, and Empty requires the reconstructed CT balance
to be zero. Confidential TransferWithFee is unsupported and returns an error.
SPL Record bytes survive CloseAccount until the end of that transaction, matching
runtime behavior; a later initialization at the same address starts fresh.
Transfer amounts come from the escrow's source/destination handles in the
verified grouped-ciphertext context. Each
transfer has a 16-bit low limb and a 32-bit high limb, so decoding individual
credits works even when the accumulated balance exceeds 32 bits. Public MintTo
balances remain separate. Apply's supplied AE value is never used during replay.

For proofs stored outside SPL Record, use `BalanceHistory::push_with_proof_accounts`.
Its callback receives the ZK verify instruction and returns the proof account's
bytes as they existed at that verification. Ordinary transaction RPC metadata
does not contain these bytes; the caller must retain them or obtain them from a
historical account-data source. The callback must return the same data when an
inline proof offset references that verification again. Missing external data
only blocks replay if an escrow operation needs that proof context. Caller data
is not trusted: replay still checks the complete result against the snapshot.
If the historical data was not retained, transaction history alone cannot promise
recovery of an unknown 64-bit balance. A manually supplied `BalanceEvent` history
is subject to the same final checks.

Accept the result only if available, pending low/high and the pending credit
counter match the snapshot during recovery. The `public` amount is supplied from
the token account snapshot and is not reconstructed from CT history. Amounts are
checked against the decrypted ElGamal group points directly, without a 64-bit
discrete logarithm. Missing proofs,
incomplete history, arithmetic overflow and mismatches return errors. An AE
value is a fast path only after the same ElGamal check; AE authentication alone
is not evidence that the number is correct. Outgoing builders use
`read_available_balance` and do not decode unrelated pending credits when AE is
correct. Apply uses the full balance reader. Funding verification deliberately
rejects false AE; repair it with a verified Apply before funding.

Preflight errors distinguish insufficient available balance, oversized transfer
or surplus, zero Partial refunds, missing recipient approval, disabled credits
and insufficient pending-counter capacity. Snapshots can still change after
construction, so these checks do not replace final on-chain validation.

## Integrator examples

`clients/rust/examples/confidential` contains copyable recipes using only public APIs:

- `create_apply.rs`: derive the shared seed through a KMS callback, Create, verify
  fetched accounts before SPL wallet funding, then Apply from a fresh snapshot.
- `settle.rs`: verify fetched swap/escrow/recipient snapshots, read the mint auditor,
  and build an exact or surplus Settle. Integration tests execute this recipe in
  both formats, including a mint auditor and nonzero high limbs.
- `refunds.rs`: prepare Reclaim, Cancel, Reject or Recover from current snapshots.
- `send.rs`: sign with a fresh blockhash, confirm preparations in order, send the
  final transaction using base64, and clean up surviving accounts after abandonment.

These are compiled library examples, not a CLI that creates wallets or sends to
an implicit cluster. Supply generated instruction accounts and agreed terms,
fetch related accounts together at the same commitment, and pass an explicitly
configured RPC client to the send functions. Review public terms before funding.
Build without test helpers:
`cargo build -p dvp-swap-program-client --features confidential,fetch --example confidential`.

## Tests

Client integration tests live in `clients/rust/tests` and reuse the framework's
LiteSVM setup and pinned program fixtures. `tests/main.rs` is the explicit
`integration` target (`autotests = false`); shared `tests/utils.rs` is not a
separate test binary. After `make build` and
`make fetch-test-fixtures`, run them with
`cargo test -p dvp-swap-program-client --all-features --test integration`.
`make integration-test-no-build`, `make all-test` and the CI workspace test run
include them. Client unit tests can run separately with
`cargo test -p dvp-swap-program-client --all-features --lib`.

The confidential integration tests are grouped by behavior: `create_apply`,
`settle`, `refunds`, `cleanup`, `balance`, `history` and `hooks`. Balance tests
cover recovery and spending available funds while large credits remain pending;
hook tests cover account resolution, extras validation, memos, and actual funding
and refunds in both formats. The [TypeScript client](typescript-client.md) asserts the same shared vectors
and exercises integrator flows against the same program fixtures.
