# Browser CT prototype: report

Result: the full confidential DvP cycle runs in a browser on the demo's stack
(SvelteKit 2, Svelte 5, Vite 6, Bun, adapter-node) with `@solana/kit` 8.4. Every
user transaction went through `/api/relay` with the treasury as fee payer. Role
wallets never held SOL.

Runs on 2026-10-12, devnet, DvP program `bVntZ9Us9Wv8v2hMytmzLs4omXcZf3UwJ5xXbB3TnA6`:

- Browser: Firefox Developer Edition on macOS arm64, `vite dev` on localhost.
  This was the second full cycle in that browser with the same role keys; the
  first also passed but its log was not kept.
- Safari on macOS arm64, same dev server, run on 2026-10-13. The first Safari
  run failed at B's ApplyPendingBalance (deviation 9). After the fix
  (`3058bec`) the cycle passed. The pasted log was again a repeat cycle with
  the same roles.
- Bun harness (`scripts/smoke.ts`): the same `flow.ts` and the same SvelteKit
  handlers in-process, without a dev server. A full cycle passed there first.
  Its numbers match the browser runs.

Signatures below are from the Firefox run. The Safari run had the same
transaction count, wire sizes and treasury spend.

## Steps

All steps passed. Explorer links use `?cluster=devnet`.

| # | Step | Result | Signatures |
|---|---|---|---|
| 1 | Setup (server, treasury signs) | pass | [kCyJBXpN](https://explorer.solana.com/tx/kCyJBXpN46883WoHayW5Gz9f3dtLnPH7tZud4N2uqCC6Cuw11j8FsmiceuXrAcyh7XZvrMRdJ7jzzxcPZbstf2U?cluster=devnet), [277o3xHz](https://explorer.solana.com/tx/277o3xHzg2j5HTteSGQyZgmPfdW6rRn5Yis3oP9fsDa8uz94keqW6C6ajz7H8ENz8Gkh7v9TiSXGCDzA6qkA4sRj?cluster=devnet) |
| 2 | Party CT accounts: A configure, B configure, B deposit, B apply | pass | [3VtzCanZ](https://explorer.solana.com/tx/3VtzCanZScz68zQKPoiqLs3R83UusFCm8Z4LFkGggzRaUx7WWwW63J9YNj23HWrzfkLumhgMYtLRTSZWGHjLq8Gx?cluster=devnet), [2V9LomjM](https://explorer.solana.com/tx/2V9LomjMfNtECS6y9grYVwbiJo8w79QymWykCY9ocULNS6RnuWK7PGtPTAjeXxQakduwEpz1zSHfcqkUWSyKsdKx?cluster=devnet), [5SpQGjWc](https://explorer.solana.com/tx/5SpQGjWcQBftRf7ySrvNG7SUc5b7NRZJSsHVfAAvSPBhJnVv8jEf5HAiUCnLyaFtdKusD56H3VyJynhQ9somEDBL?cluster=devnet), [maHg526Z](https://explorer.solana.com/tx/maHg526ZagjnjLLuMqZoT5i5he9FT9xGb9mr9kicUEjTs7zwnSq1wbPkWKidqYPcDeWAaxpVye9RkH5Fv1Pu35H?cluster=devnet) |
| 3 | Shared seed (browser, random, localStorage) | pass | no transaction |
| 4 | Create (`createSession`) | pass | [2BF5QXna](https://explorer.solana.com/tx/2BF5QXnawq3wJZ92brnt5BdmtNJHJ89dGGNnMWwVjeiK8BmfJWftbHKcu4F1v2HE2DDfadp8VBxj2wMA3myXQcRx?cluster=devnet) |
| 5 | Fund A (`TransferChecked`) | pass | [2dgkJ1Dj](https://explorer.solana.com/tx/2dgkJ1DjvCvS7z9aM32Q4fk8LJmhK1aL7o4qUQLXBxiVaFaTHyJ9F5xT2Yb3CHHLh3hY8ups1zHVQbynNHcvk8jX?cluster=devnet) |
| 6 | Fund B (`verifyConfidentialFunding`, then CT transfer) | pass | [5anou2N3](https://explorer.solana.com/tx/5anou2N3sw7gNJqDitJogZq8HVnPwYBZ1gruwWrqQoqbGVaCAkgF9TW5UGRSdqr2pVex2nZWiH1YbFSrqRExQzbd?cluster=devnet) |
| 7 | Apply escrow B (`applySession`) | pass | [284ydDkV](https://explorer.solana.com/tx/284ydDkViiZNujRr1dVJkzaNa4z2vS2swLemvEQEvNmcUycP3zdyj7ikjD3dyLXnKbKkEyCrorCB8G3Jnooj1Tqb?cluster=devnet) |
| 8 | Settle (`settleSession`, authority signs) | pass | [5W4cLBh5](https://explorer.solana.com/tx/5W4cLBh58v77gPmNS5UBWnmdBoB5kvi6g3WHGqNQHdoyzFL73bqHZncgWmZdv1huQTMPP8BhtFMKnPhfHGshtS5d?cluster=devnet) (preparation), [5VDdyTnY](https://explorer.solana.com/tx/5VDdyTnYGkJE27QWkfFyzWCQ6ej6fmgDg6nEaRDzX47RU8scnbNNVVund2ciVQmhv8PAukVTKoVFyNSLjVjQLoq9?cluster=devnet) (final) |
| 9 | Check: A applies pending and decrypts | pass | [3BHEw9in](https://explorer.solana.com/tx/3BHEw9inexBiLNFDvS51KSabAF6ekZtKyq1W48Fz1KLowX9LBVUbqwE4QDHYtYDwkVEPnQb9Qf6VAdgbQuzHbXBU?cluster=devnet) |

Check results:

- A's mint B account: 40,000,000 available, 0 pending (`AMOUNT_B` = 40,000,000).
- B's mint A account: 25,000,000 (`AMOUNT_A`).
- Swap PDA, escrow A and escrow B are all closed.

## WASM and proof generation

WASM:

- Size: `index_bg.wasm` is 2,718,224 bytes, 2.40 MB gzipped in the production
  build. The bundle contains exactly one copy and SSR loads none.
- Load: the dynamic import of the CT module graph (zk-sdk WASM, Token-2022
  confidential helpers, DvP client) took 72 ms in Firefox, with the WASM
  fetched from localhost in 3 ms. In Safari it took 145 ms with the WASM
  already in the HTTP cache.
- Over a real network, download time will dominate: about 2.4 MB gzipped.
  That is not measured here.

Proof generation, measured around each builder call in ms. The browser
numbers come from the pasted runs; the Bun numbers from the first harness run.

| Step | What is generated | Firefox | Safari | Bun |
|---|---|---|---|---|
| CT account setup (A + B configure, B apply) | 2 pubkey-validity proofs, 1 AE re-encryption with ElGamal decrypt | 214 | 217 | 220 |
| Create | Amount ciphertexts, pubkey-validity proof, AE zero | 3 | 4 | 6 |
| Funding B | CT transfer: equality, 3-handle validity, U128 range | 636 | 615 | 574 |
| Apply escrow | Balance decrypt and AE re-encryption | 175 | 201 | 206 |
| Settle | Payment equality/validity/range, eqLo, eqHi, zero proofs | 952 | 945 | 866 |
| Check (A apply) | Balance decrypt and AE re-encryption | 185 | 200 | 200 |

Elapsed time per step, including RPC round trips and confirmation:

| Step | Firefox (s) | Safari (s) |
|---|---|---|
| Setup | 4.0 | 8.2 |
| CT accounts | 6.7 | 7.3 |
| Create | 2.1 | 1.9 |
| Fund A | 2.0 | 1.9 |
| Fund B | 3.1 | 3.8 |
| Apply | 2.3 | 2.3 |
| Settle | 4.4 | 4.4 |
| Check | 3.3 | 2.9 |

## Transactions, sizes, costs

Fees and treasury balance deltas come from `getTransaction`, via
`scripts/tx-costs.ts`.

| Step | Tx | Wire bytes | Signers | CU | Fee | Treasury rent paid (net) |
|---|---|---|---|---|---|---|
| Setup: 2 mints | 1 | – | 3 | 3,929 | 15,000 | 2,910,840 |
| Setup: 4 ATAs + 2 MintTo | 1 | – | 1 | 69,237 | 5,000 | 6,004,560 |
| CT configure A / B | 2 | 601, 601 | 2 | 10,275 | 2 × 10,000 | 2 × 1,518,920 (Reallocate) |
| B deposit / apply | 2 | 356, 358 | 2 | 10,390 / 8,009 | 2 × 10,000 | 0 |
| Create | 1 | 972 | 1 | 65,788 | 5,000 | 8,798,560 |
| Fund A | 1 | 388 | 2 | 105 | 10,000 | 0 |
| Fund B (CT transfer) | 1 | 2,985 | 5 | 248,241 | 25,000 | 0 (contexts closed back to treasury in the same tx) |
| Apply escrow B | 1 | 624 | 2 | 13,851 | 10,000 | 0 |
| Settle preparation | 1 | 4,096 | 7 | 245,700 | 35,000 | 11,125,200 (6 proof contexts) |
| Settle final | 1 | 1,076 | 2 | 76,339 | 10,000 | 0 |
| Check (A apply) | 1 | 358 | 2 | 8,009 | 10,000 | 0 |

Treasury spend for the full cycle was 32,042,000 lamports (0.032 SOL). It was
identical in both runs:

| Item | Lamports | Where it ends up |
|---|---|---|
| Fees | 165,000 | Burned or paid to validators |
| Setup rent (2 mints, 4 ATAs) | 8,915,400 | Mints and role ATAs |
| Reallocate top-ups for CT extension | 3,037,840 | Role ATAs |
| Create rent | 8,798,560 | 8,148,320 to authority at Settle; 650,240 stays in the nonce tombstone, which is never closed |
| Settle proof contexts | 11,125,200 | Authority, via DvP's CPI closes |

Lamports left on role wallets after the cycle:

- Authority: 19,273,520 per cycle. That is the Settle context rent plus the
  closed swap PDA and both escrows. The browser log shows 38,547,040 after two
  cycles.
- Party A and party B: 0.

Context rent is returned to the instruction signer as the spec says. On the
Token-2022 transfer path, that signer is the treasury, which the helper makes
the context authority.

## Relay policy

Final module: `src/lib/server/relayPolicy.ts`. The server passes the treasury,
the DvP program, the allowed context sizes, and rent fetched with
`getMinimumBalanceForRentExemption` and cached per size.

General rules:

- Only v1 messages are accepted; legacy and v0 are refused.
- The fee payer must be the treasury.
- Signers are capped at 12.
- The v1 priority fee is capped at 0.
- Empty transactions are refused.
- The wire transaction (base64) is capped at 8192 characters.

Allowed programs: DvP, SPL Token, Token-2022, ZK ElGamal Proof, System
(restricted). ATA and ComputeBudget are refused: v1 carries compute and
loaded-data limits in the message.

Per-program rules:

- **System:** only `CreateAccount`. The funder must be the treasury, the owner
  the ZK ElGamal Proof program, the space one of 129, 161, 225, 297, 385, and
  the lamports exactly the rent for that space.
- **SPL Token:** the treasury must not appear in any instruction.
- **Token-2022:** the treasury may appear only as the payer of `Reallocate`,
  and only when it adds the `ConfidentialTransferAccount` extension.
- **ZK ElGamal Proof:**
  - In `Verify*`, the treasury may appear only as the context-state authority.
  - In `CloseContextState`, the treasury may be the destination. It may be the
    authority only if the destination is also the treasury.
- **DvP:** the treasury may appear only as the payer of `CreateConfidentialDvp`.

Proof context sizes allowed:

| Proof | Size (bytes) | Used by |
|---|---|---|
| ZeroCiphertext | 129 | Settle |
| CiphertextCommitmentEquality | 161 | Settle, CT transfer |
| CiphertextCiphertextEquality | 225 | Settle eqLo/eqHi |
| BatchedRangeProofU128 | 297 | Settle, CT transfer |
| BatchedGroupedCiphertext3HandlesValidity | 385 | Settle, CT transfer |

Every relayed transaction in both runs passed the policy.

Negative checks: `bun run test:policy`. All 29 tests pass; the same file also
runs under `node --import tsx --test`.

Refused, as required by the brief:

- System transfer from the treasury.
- Over-funded `CreateAccount`.
- Token-2022 `MintTo` signed by the treasury.
- Treasury as authority in CT `Deposit` and `ApplyPendingBalance`.

Also refused:

- Under-funded `CreateAccount`, wrong owner, non-allowlisted space (10000 and
  65), and `CreateAccount` funded by someone other than the treasury.
- Classic `TransferChecked` with the treasury as authority.
- `Reallocate` with the treasury outside the payer slot or with a foreign
  extension.
- Unknown program (Memo), the ATA program, and a fee payer other than the
  treasury.
- Legacy and v0 messages, and a priority fee above the cap.
- `CloseContextState` with treasury authority and a foreign destination.
- Treasury as the context account of a ZK verify.
- Treasury in a DvP instruction other than the `CreateConfidentialDvp` payer.
- DvP at the default `dvp34…` address.

Allowed:

- Exact-rent `CreateAccount` with a ZK verify, for all five sizes.
- Treasury as context authority, and closing to the treasury.
- A role wallet closing its own context.
- `Reallocate` with the treasury as payer.
- Role-wallet `TransferChecked`, `Deposit` and `ApplyPendingBalance`.
- `CreateConfidentialDvp` from the generated client with the inline pubkey
  proof.

Residual risk, accepted for the prototype because rate limiting is out of
scope: treasury-funded rent leaves the treasury for good. Per cycle,
19,273,520 lamports go to the authority wallet, which an attacker controls in a
public demo. Reallocate top-ups go to role ATAs. The policy bounds each amount
but not the number of transactions.

## Deviations from the docs and brief

1. **v1 transactions need explicit limits.** Without
   `setTransactionMessageLoadedAccountsDataSizeLimit`, devnet refuses a v1
   transaction with "Transaction exceeded max loaded accounts data size cap",
   even a two-mint setup. The DvP client's `PlannedTransaction` sets 4 MB and
   400k CU. Anything else that builds v1 messages must set them too: server
   sends and kit's transaction planner for Token-2022 plans.
2. **The Token-2022 transfer helper makes the treasury the context authority.**
   `getConfidentialTransferInstructionPlan` has no option to change this: it
   uses `contextStateAuthority = payer` and closes the contexts to the payer.
   The policy therefore has to accept the treasury as context authority and
   close authority, with destination = treasury. The DvP client's own
   `SessionBuilder` path, used by the tests, makes the role wallet the
   authority instead.
3. **`getCreateConfidentialTransferAccountInstructionPlan` always creates the
   ATA.** It prepends an ATA `CreateIdempotent` paid by `payer`. The app strips
   that instruction, since `/api/setup` created the ATAs, so the relay can
   refuse the ATA program. `ConfigureAccount`'s relative proof offset
   survives the removal.
4. **`deriveConfidentialKeys` is exported only from
   `@solana-program/token-2022/confidential`**, not the package root as the
   brief says. With zk-sdk 0.5.4, the seeded variants
   (`deriveElGamalKeypairWithSeed` and others) ignore the seed, because
   `ConfidentialKeys.signerMessage()` takes no argument. The standard
   derivation is unaffected.
5. **Devnet rent differs from the default formula.** Devnet charged 5080
   lamports per byte of (128 + space), not 6960. Rent must come from RPC; the
   policy's `defaultRentExemptMinimum` would refuse every context on devnet.
6. **The Settle preparation transaction is exactly 4096 bytes**, the v1 limit,
   with six contexts. The DvP packer filled it. A surplus refund adds three
   more contexts and a second preparation transaction.
7. **The CT transfer packed into one v1 transaction.** kit's planner put the
   three context creates and verifies, the transfer and the three closes in
   one 2,985-byte transaction using 248k CU. The helper's docs describe the
   range-proof transaction as close to the size limit; that holds for v0's
   1232 bytes, not v1's 4096.
8. **Use one fee-payer signer object.** Use a single
   `createNoopSigner(treasury)` instance everywhere. kit refuses two signer
   objects for one address.
9. **Safari signs Ed25519 non-deterministically.** Its WebCrypto Ed25519
   returns a different signature each time, so `deriveConfidentialKeys` with a
   kit `KeyPairSigner` returns new ElGamal and AE keys on every call. The first
   Safari run configured B's account with one key pair, re-derived at
   ApplyPendingBalance and failed with "Decryption failed: The secret key may
   be incorrect or the encrypted amount may be out of range". Funds credited
   under the lost keys cannot be decrypted. The fix (`3058bec`) derives the keys
   once per role and stores them with the role key. Firefox and Bun sign
   deterministically and do not show the problem.

## What the demo migration must change

- Move to kit 8 and v1 messages. Every message builder needs explicit CU and
  loaded-accounts-data limits (deviation 1).
- Load all CT code with a dynamic import behind `ssr = false`. Add
  `vite-plugin-wasm`, `optimizeDeps.exclude: ['@solana/zk-sdk']` and
  `build.target: 'esnext'`. Dedupe kit, zk-sdk and the `@solana-program/*`
  packages in Vite (`resolve.dedupe`). Add a Bun `overrides` entry for
  `@solana/zk-sdk`; otherwise the DvP client source resolves a second zk-sdk
  WASM instance. Budget about 2.4 MB gzipped for the WASM.
- Replace `PlannedTransaction.sign` with `checkSize`, `message`,
  `partiallySignTransactionMessageWithSigners`, then relay. Execute Token-2022
  plans with kit's planner but not its executor.
- Extend the RPC proxy allowlist with `getMinimumBalanceForRentExemption`,
  `getMultipleAccounts` and `getTransaction`. Settle and funding verification
  use `fetchEncodedAccounts`.
- Port `relayPolicy.ts` and its tests in place of `assertRelayable`. Fetch rent
  via RPC.
- Rate limiting becomes mandatory, not optional. Each cycle moves about 0.019
  SOL of treasury-funded rent to the settlement authority, plus about 0.003
  SOL of `Reallocate` rent into role accounts.
- Decide whether the escrow funding should use the DvP `SessionBuilder` path
  (role wallet as context authority) instead of the Token-2022 helper. That
  path would let the policy refuse the treasury as context authority
  entirely, but the helpers are internal (`confidential/proofs.ts`), not
  exported.
- Derive CT wallet keys once and persist them with the role. Never re-derive
  from a signature (deviation 9). Test every flow in Safari.
- `/api/setup` must create both parties' mint B ATAs and B's mint A ATA. Settle
  requires `userBDestinationAtaA`, `userAAtaA` and `userBAtaB` to exist.

## Running it

From `prototypes/ct-browser/`:

- `bun install`
- `bun run treasury:new`: once; prints the address to fund.
- `RPC_URL=...` goes in `.env`.
- `bun run dev`, then open the page and press "Run all".

Other commands:

- `bun run test:policy`: relay policy tests.
- `bun run check`: types.
- Harness, from the repo root:
  `bun --env-file=prototypes/ct-browser/.env --preload ./prototypes/ct-browser/scripts/harness-preload.ts prototypes/ct-browser/scripts/smoke.ts`.
  Its state is in `.secrets/smoke-state.json`; delete that file for a new
  cycle.
- `scripts/tx-costs.ts <sig>...`: per-transaction fee and treasury delta.
- `scripts/treasury-balance.ts`: treasury balance.
