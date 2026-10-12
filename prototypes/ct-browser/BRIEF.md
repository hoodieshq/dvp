# Browser prototype: confidential leg B through a fee-sponsoring relay

Handoff brief for a fresh session. Goal: prove, before migrating the demo webapp,
that the confidential (CT) DvP flow runs in a browser on the demo's stack, with a
server treasury paying every fee through a relay. This is a throwaway spike, not
the demo migration.

## What to build

A minimal app in `prototypes/ct-browser/` on branch `ct/browser-prototype`
(based on `ct/audit-fixes-and-docs`, which has the CT TypeScript client).

- Stack mirrors the demo: SvelteKit 2 + Svelte 5 + Vite 6 + Bun +
  `@sveltejs/adapter-node`. Use `@solana/kit` 8.x (the demo is still on 3.x; do not
  touch the demo itself).
- Import the DvP client straight from `clients/typescript/src` (Vite alias or
  relative path). Load all CT/WASM code in the browser only (dynamic import /
  `ssr = false`), never during SSR.
- Server endpoints:
  - `/api/setup`: treasury creates both mints (see below) and funds the parties.
  - `/api/relay`: decode a partially signed tx, run the relay policy (below),
    add the treasury signature, send base64, confirm by polling, return signature.
  - `/api/rpc`: same-origin JSON-RPC proxy with a method allowlist (as in the demo),
    plus `getMinimumBalanceForRentExemption`.
- One page with a button per step and a log panel showing, per step: signatures,
  tx count, wire sizes, proof generation time, elapsed time, errors.

## Full cycle to run (all user transactions through `/api/relay`)

Role keypairs (maker/authority, party A, party B) are generated in the browser
and kept in localStorage; they hold no SOL.

1. Setup (server, treasury signs): create mint A (classic SPL Token, public) and
   mint B (Token-2022 with `ConfidentialTransferMint`, auto-approve on, no
   auditor), treasury = mint authority. Mint public A tokens to party A. Create
   party B's Token-2022 ATA for mint B and mint public B tokens to it.
2. Party CT accounts (browser, relayed): A and B each run Reallocate +
   ConfigureAccount (+ inline `VerifyPubkeyValidity`) on their mint B ATA with
   treasury as payer. B then Deposits public → pending and Applies pending →
   available. Wallet ElGamal/AE keys: `deriveConfidentialKeys({ signer })` from
   `@solana-program/token-2022` or random, stored with the role.
3. Shared seed: generated in the browser (random, or `deriveSharedSeed` with a
   WebCrypto HMAC over a local master key); `EscrowKeys.fromSeed`.
4. Create: `createSession` (CreateConfidentialDvp + inline pubkey proof).
   `amount_b` must be `< 2^48`.
5. Fund A: plain `TransferChecked` to escrow A.
6. Fund B: `verifyConfidentialFunding` first, then a CT transfer into escrow B
   via `getConfidentialTransferInstructionPlan` (preparation tx + transfer).
7. Apply escrow B: `applySession` (funding lands in pending; Settle needs available).
8. Settle: `settleSession` signed by the authority (preparation + final).
9. Check: A's mint B ATA received the payment (apply A's pending and decrypt),
   escrows and swap closed.

Use v1 transactions (devnet supports them). v0/LUT/Record is out of scope.

## Facts already established (do not re-verify)

- Program: devnet `bVntZ9Us9Wv8v2hMytmzLs4omXcZf3UwJ5xXbB3TnA6`, deployed
  2026-10-06 from branch `devnet/ct-golden-path`. ABI matches HEAD; since then only
  Apply got a stricter tombstone-address check, which the client already satisfies.
  The generated client defaults to `dvp34…`: pass `config.programAddress` and the
  same address to `findSwapDvpPda`, `findNonceTombstonePda`,
  `verifyConfidentialFunding` etc. (see `docs/confidential_transfers/typescript-client.md`).
- Devnet runs Agave 4.4.0-beta.0; v1 transactions and the ZK ElGamal Proof program
  work. Its Token-2022 binary differs from the mainnet test fixture, but the Rust and
  TS client runs on devnet passed against it.
- Generated client code is gitignored (`**/generated/`): run `pnpm install
  --frozen-lockfile` and `pnpm generate-clients` at the repo root first. The local
  `node_modules` may hold a stale `@solana/zk-sdk` `0.5.3-dvp.453d813` build from
  `deps/`; the lockfile pins 0.5.4, which is what the prototype must use.
- Dependencies (match the repo root): `@solana/kit` ^8.4, `@solana-program/token`
  ^0.17, `token-2022` ^0.19, `system` ^0.15, `zk-elgamal-proof` ^0.4,
  `@solana/zk-sdk` ^0.5.4. `zk-elgamal-proof` pins zk-sdk 0.4.1, so add a Bun
  `overrides` entry forcing one zk-sdk instance; two WASM instances fail only at
  runtime. Token-2022 imports `@solana/zk-sdk/bundler`: Vite needs WASM ESM support
  (for example `vite-plugin-wasm`). The WASM binary is about 2.7 MB.
- `PlannedTransaction.sign` calls `signTransactionMessageWithSigners`, which throws
  with a no-op treasury signer. For relayed sends: `plan.checkSize(config)`, then
  `plan.message(config, lifetime)`, then `partiallySignTransactionMessageWithSigners`
  (this also signs the temporary proof-context keypairs carried by the
  instructions), then POST base64 to `/api/relay`. Fresh blockhash per tx; send
  preparation txs in order, then the final one.
- Token-2022 CT helpers return kit `InstructionPlan`s with `payer: TransactionSigner`
  (use the no-op treasury signer) and need an RPC with
  `getMinimumBalanceForRentExemption` and `getAccountInfo`. Execute those plans
  through the relay, not kit's default executor.
- Proof context accounts are created by System `CreateAccount` funded by the fee
  payer (treasury), and DvP closes them with rent going to the instruction signer
  (a role wallet), not to the treasury (spec section 6).

## Reference code

- CT client and docs: `clients/typescript/src/confidential/`,
  `docs/confidential_transfers/{spec,typescript-client}.md`.
- Examples: `clients/typescript/examples/confidential/{swap,settle,send-session}.ts`.
- Wallet-side CT setup/funding used by tests (private, copy the approach):
  `clients/typescript/src/__tests__/confidential/utils.ts`.
- Demo webapp (relay pattern, kit 3): `git show origin/feat/dvp-demo-webapp:webapp/<path>`,
  mainly `src/lib/server/solana.ts` (`relay`, `assertRelayable`),
  `src/lib/solana/dvp.ts` (`sendIxs`), `src/routes/api/{relay,rpc}/+server.ts`.

## Relay policy draft (part of the deliverable)

The treasury co-signs whatever passes, so the policy must reject anything the app
would not build. Start from the demo's `assertRelayable` and extend:

- Fee payer must be the treasury. Decode v1 messages.
- Allowed programs: DvP (`bVntZ9…`), Token, Token-2022, ATA, ZK ElGamal Proof
  (`ZkE1Gama1Proof11111111111111111111111111111`), System (restricted).
- System: only `CreateAccount` with payer = treasury, owner = ZK ElGamal Proof
  program, space equal to one of the context sizes the client uses, lamports equal
  to rent-exempt minimum for that space. Without the lamports check an attacker
  creates an over-funded context with themselves as authority and closes it to
  their own address.
- Token and Token-2022: the treasury must not appear in any instruction, except as
  the payer of Token-2022 `Reallocate`. (The treasury is mint authority for both
  mints.)
- Add negative checks (a small script or unit test is enough): System transfer from
  the treasury, over-funded `CreateAccount`, Token-2022 `MintTo` signed by the
  treasury, treasury as authority in a CT instruction. All must be refused.

## Parallel work

Run in parallel only what neither touches devnet nor edits the same files.

- Main session: scaffold the app (Bun, kit 8, WASM), the server endpoints, then
  the devnet cycle. Devnet steps stay strictly sequential: each depends on chain
  state left by the previous one.
- Subagent 1 (same checkout, writes only
  `prototypes/ct-browser/src/lib/server/relayPolicy.ts` and its test): the relay
  policy and the negative checks as a pure module over decoded v1 messages. No
  network. It may use the repo-root dependencies (kit 8.4 is installed there)
  until the app's own `package.json` exists. Do not use worktree isolation: a
  fresh worktree branches from `origin/main`, which has neither the CT client nor
  this brief. The main session wires the module into `/api/relay` after its tests
  pass.
- Subagent 2 (read-only, Explore): extract from
  `clients/typescript/src/__tests__/confidential/utils.ts` and the Token-2022 CT
  helpers the exact wallet-side sequence (configure, deposit, apply, CT transfer)
  and every proof-context size and owner the relay must allow. Returns a short
  note, no code edits; its context sizes feed subagent 1.

Start both subagents right after reading this brief; the main session scaffolds
meanwhile.

## Secrets and environment

- Treasury: generate a new keypair into `prototypes/ct-browser/.secrets/`
  (gitignored), print only its address, and ask the user to fund it with devnet SOL
  (about 1 SOL). Never use `~/.config/solana/id.json`; it is the upgrade authority
  of `bVntZ9…`.
- RPC: Helius devnet with a key. The user writes `RPC_URL=...` into
  `prototypes/ct-browser/.env` themselves. Never print, log or commit the URL;
  mask it in any output.
- Bun is not installed on this machine. Ask the user to install it (for example
  `! mise use -g bun@latest`) before scaffolding.
- The sandbox may block binding a local port for the dev server. If so, tell the
  user about `sandbox.network.allowLocalBinding: true`. If no headless browser is
  available to drive the page, ask the user to open it and paste the log panel.

## Report to produce (`prototypes/ct-browser/REPORT.md`)

- Pass/fail per step with devnet signatures (Explorer links with `?cluster=devnet`).
- WASM load time and size; proof generation time per step (create, CT account
  setup, funding, settle) in the browser used.
- Tx count and wire size per step.
- Treasury SOL spent for the full cycle, and lamports left on role wallets
  (context rent returned to signers).
- Final relay policy and the negative-check results.
- Anything that did not work as the docs describe, and what the demo migration
  must change because of it.

## Out of scope

Migrating the demo webapp, UI polish, the `/ticket` page, rate limiting, v0
transactions, refunds (Reclaim/Cancel/Reject/Recover), transfer hooks, auditor.

## Conventions

English in files, conventional commits, imperative mood. Commit on
`ct/browser-prototype`; push with `git push hoodies ct/browser-prototype` (no `-u`).
Do not push to `origin` (solana-foundation).
