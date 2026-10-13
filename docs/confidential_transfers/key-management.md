# DvP Confidential Transfer: Key Management

This document describes which secrets a confidential DvP swap uses, how the
shared seed should be derived and why, and how each participant stores it. The
derivation itself is part of the protocol and is pinned in the
[specification](spec.md#4-shared-seed-and-keys) (section 4) and the shared test
vectors. The Rust and TypeScript clients implement it; see the
[Rust client guide](rust-client.md#keys-and-funding-checks) and the
[TypeScript client guide](typescript-client.md#keys-and-verification).

## 1. Keys at a glance

| Secret | Held by | Scope | Used for | If leaked |
| --- | --- | --- | --- | --- |
| `seed_master_key` | the seed operator, inside a KMS/HSM | all swaps of that operator | deriving each swap's `shared_seed` | amounts of every swap derived from it are exposed; funds are not at risk |
| `shared_seed` | `user_a`, `user_b`, settlement authority's operator | one swap | escrow B ElGamal and AE keys, amount openings | amounts and escrow B balances of that swap are exposed; funds are not at risk |
| Escrow ElGamal / AE keys, openings | derived on demand from `shared_seed` | one swap | decrypting escrow B, building proofs, encrypting `amount_b` | same as `shared_seed` |
| `settlement_authority`, `user_a`, `user_b` signing keys | each party | the party's wallet | authorizing DvP instructions and token transfers | funds that key can move; amounts are not revealed |
| Party wallet CT keys (ElGamal / AE of their own token accounts) | each party | the party's own token accounts | the party's own confidential balance | that party's own balance |

The seed operator is the settlement authority's operator or another party the
integrator appoints. Escrow keys are never stored on their own: they are
recomputed from `shared_seed` with `EscrowKeys::from_seed` (Rust) or
`EscrowKeys.fromSeed` (TypeScript).

Party wallet CT keys are unrelated to the DvP seed. Each party keeps using its
existing wallet keys for its own token accounts; balance readers accept them as
`ConfidentialAccountKeys` in TypeScript.

## 2. Recommended derivation

```text
shared_seed = HMAC-SHA256(seed_master_key, "dvp/confidential-amount-b/seed/v1" || swap_dvp)
(escrow_elgamal, escrow_ae) = derive_confidential_keys_from_ikm(shared_seed)
opening_lo, opening_hi = HKDF-SHA512(salt = "dvp/confidential-amount-b/v1", ikm = shared_seed,
                                     info = "opening-lo" / "opening-hi")
```

- `seed_master_key` is a dedicated symmetric key of at least 32 bytes, created
  in a KMS/HSM as a non-exportable HMAC-SHA256 key and used for nothing else.
- `swap_dvp` is the swap's PDA. It is known before Create and is unique per
  swap, because the nonce tombstone forbids reusing the PDA seeds.
- The clients take the HMAC as a callback, so the master key never enters the
  client process: Rust `derive_shared_seed(swap, mac)`, TypeScript
  `deriveSharedSeed(swapDvp, mac)`. The callback is one KMS `GenerateMac` (or
  equivalent) call over the message the client passes it.
  `clients/rust/examples/confidential/create_apply.rs` shows the flow.

The exact byte layout and the Rust/TypeScript snippets are in
[spec section 4.1-4.3](spec.md#41-shared-seed). Any implementation must
reproduce `clients/test-vectors/confidential-amount-b.json`.

## 3. Why this derivation

The escrow B keys have properties that a party's own wallet keys do not have:
three parties must hold the same secret, the secret must survive for the whole
life of escrow B (including recovery after close), and losing it locks the
escrow's confidential funds permanently. The derivation is chosen for those
properties.

### 3.1 Why not derive from a wallet signature

Token-2022 wallets usually derive the CT keys of the owner's own token account
by signing a fixed message with the owner's wallet key (`new_from_signer` in
the ZK SDK). That works for a single-owner account. It does not fit the shared
escrow:

- **The key is shared, the wallet is not.** A signature-derived key belongs to
  one signer. The other two parties would still have to receive the secret
  from that signer, so nothing is saved, and the escrow's recoverability
  becomes tied to one party's wallet.
- **Determinism is not guaranteed.** Re-deriving requires the signer to produce
  exactly the same signature bytes later. Many custody setups (MPC, some HSM
  and KMS signers, hardware wallets) either do not guarantee deterministic
  Ed25519 signatures or refuse to sign arbitrary raw messages. A different
  signature yields a different key, and escrow B funds become unrecoverable.
- **Key rotation breaks re-derivation.** If the signing key is rotated,
  replaced or moved to another custodian, the seeds of all swaps still open
  under it can no longer be re-derived.
- **It mixes authorization with confidentiality.** A key that moves funds would
  also define what reveals amounts. Anything that can obtain a signature over
  the derivation message (a signing service, a phishing prompt, a custody
  policy that allows message signing) would learn the escrow secrets. With a
  separate master key, a leaked signing key does not reveal amounts and a
  leaked master key cannot move funds.
- **Signing a raw message with a funds-moving key is a bad habit.** Users and
  operators should not be trained to approve opaque message signatures with
  their trading keys.

### 3.2 Why not a random seed per swap

A random seed is a valid seed, but each one must be backed up individually for
as long as escrow B may hold funds, and losing a single backup locks that swap's
confidential funds. HMAC under one long-lived master key re-derives the seed of
any swap from public data (`swap_dvp`), so the only thing to back up is the
master key.

### 3.3 Why HMAC over the swap address

- One KMS call per swap, with no per-swap state.
- The domain tag `dvp/confidential-amount-b/seed/v1` separates this use from
  any other HMAC output and versions the scheme.
- Binding to `swap_dvp` gives every swap an independent seed: a leaked seed of
  one swap reveals nothing about other swaps.
- The derivation is a plain MAC, so every mainstream KMS can perform it without
  exporting the key.

## 4. Storage and handling

### 4.1 Seed operator

- Keep `seed_master_key` non-exportable in a KMS/HSM. Restrict `GenerateMac`
  (or equivalent) to the service that creates swaps, and keep audit logs of
  its use.
- Back up the master key according to the KMS's own replication or backup
  mechanism. If the master key is lost and every party has lost a swap's seed,
  that swap's confidential escrow B funds are unrecoverable
  ([spec 4.6](spec.md#46-seed-loss)).
- Rotation: use a new master key for new swaps and keep the old key available
  until every swap derived from it has a closed escrow B. The derivation does
  not encode a key version, so record which master key was used for each
  `swap_dvp`.
- Deliver `shared_seed` to `user_a`, `user_b` and, if different, the settlement
  authority's operator over an authenticated, encrypted off-chain channel. The
  channel is the integrator's choice and out of scope for the program.
- Do not reuse `seed_master_key` as a signing key or for any other purpose, and
  do not store it next to the `settlement_authority` signing key.

### 4.2 Parties receiving the seed

- **Verify before funding.** A received seed is only trusted after
  `verify_confidential_funding` (Rust) or `verifyConfidentialFunding`
  (TypeScript) passes against the on-chain swap and escrow with the agreed
  amount ([spec 4.4](spec.md#44-verification-before-funding)). A wrong seed
  fails with `EscrowKeyMismatch` before any funds move.
- **Store it encrypted at rest**, indexed by `swap_dvp`, in a secret store or
  KMS-wrapped storage, separate from signing keys. Do not log it, put it in
  analytics or error reports, or send it through the same channel as
  transaction approvals. The Rust key types are intentionally not `Debug` or
  serializable; in TypeScript call `keys.free()` when done to release WASM
  memory.
- **Keep it until escrow B is closed**, not just until settlement. Every leg B
  refund (Reclaim, Cancel, Reject, Recover) and every Apply builds proofs or
  balances from it, including Recover and Apply after the swap is closed when
  late credits arrive. Leg A is public and does not need the seed.
- **Delete it once escrow B is closed.** Deleting does not undo past exposure:
  anyone who already has the seed can still decrypt the swap's historical
  ciphertexts.

### 4.3 Settlement authority

The settlement authority needs the seed to prepare Settle and Cancel proofs;
those preparatory transactions do not need its signing key
([spec 7.5](spec.md#75-settleconfidentialdvp)). A proof service can therefore
hold the seed while a separate signer holds the `settlement_authority` key.
Keep these two in separate trust domains.

## 5. Compromise and loss

| Event | Effect | Response |
| --- | --- | --- |
| `shared_seed` of one swap leaked | amount and escrow B balance of that swap readable by the holder; no one can move funds without a party's or the authority's signature | none required for funds; treat the trade's confidentiality as lost |
| `seed_master_key` leaked | amounts of all swaps derived from it, past and future, readable | rotate to a new master key for new swaps; past swaps stay exposed |
| A party lost its copy of the seed | that party cannot decrypt escrow B or build its proofs | request the seed again from the operator, who re-derives it |
| Operator lost the master key | no re-derivation | parties that still hold seeds keep working; back up remaining seeds |
| All copies of a swap's seed and the master key lost | confidential funds in escrow B locked permanently | none; a CT property, not a DvP one |
| A signing key leaked | funds that key controls at risk; amounts stay confidential | standard key compromise response for that wallet |
