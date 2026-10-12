/**
 * Relay policy for the fee-sponsoring relay.
 *
 * The treasury co-signs every transaction that passes `assertRelayable`, and it
 * is also the mint authority of both prototype mints. So the policy is an
 * allowlist of exactly what the app builds; anything else is refused.
 *
 * Pure module: no RPC, no network. Rent for proof-context accounts is supplied
 * by the caller as a synchronous function (the server precomputes it per
 * allowed size with `getMinimumBalanceForRentExemption` and caches it).
 *
 * Rules (v1 messages only):
 * - Message version must be 1. Legacy and v0 are refused (v0 could load
 *   accounts from lookup tables, which this policy does not resolve).
 * - Fee payer (first static account) must be the treasury.
 * - Signer count and the v1 priority fee are capped (the treasury pays both).
 * - Allowed top-level programs: DvP, SPL Token, Token-2022, ZK ElGamal Proof,
 *   System (restricted). Everything else is refused, including:
 *   - ComputeBudget: v1 carries the compute unit limit, priority fee, heap size
 *     and loaded-accounts limit in the message config, and the DvP client sets
 *     them there (`setTransactionMessageComputeUnitLimit` etc.), so no flow
 *     emits ComputeBudget instructions.
 *   - Associated Token Account: ATAs are created server-side by /api/setup and
 *     the app strips the ATA CreateIdempotent from Token-2022's
 *     `getCreateConfidentialTransferAccountInstructionPlan`. Role wallets hold
 *     no SOL, so an ATA create without the treasury as payer cannot succeed
 *     either; refusing the program outright is the smallest surface.
 * - System: only `CreateAccount` funded by the treasury, owned by the ZK
 *   ElGamal Proof program, with a space from `contextSizes` and lamports equal
 *   to the rent-exempt minimum for that space. Without the exact-lamports check
 *   an attacker creates an over-funded context with themselves as authority
 *   and closes it to their own address.
 * - SPL Token: the treasury must not appear in any instruction.
 * - Token-2022: the treasury must not appear in any instruction, except as the
 *   payer (account index 1) of `Reallocate` (discriminator 29) that only adds
 *   the `ConfidentialTransferAccount` extension.
 * - ZK ElGamal Proof:
 *   - Verify* instructions: the treasury may appear only at the
 *     context-state-authority position. Token-2022's CT helper plans
 *     (`buildContextStateProofPlan`) default the context authority to the
 *     payer, which is the treasury.
 *   - CloseContextState (discriminator 0): the treasury may be the destination,
 *     and may be the authority only if the destination is also the treasury
 *     (the helper closes `{ authority: payer, destination: payer }`). Otherwise
 *     an attacker closes a treasury-owned context to their own address.
 * - DvP: the treasury may appear only as the payer (account index 0) of
 *   `CreateConfidentialDvp` (discriminator 6), which funds the swap PDA, the
 *   nonce tombstone and the escrow ATAs.
 *
 * Residual risk (accepted for the prototype, rate limiting is out of scope):
 * every allowed treasury-funded account (proof contexts with a role-wallet
 * authority, Reallocate top-ups, DvP PDAs/escrows) returns its rent to a
 * party other than the treasury when closed. The policy bounds each amount to
 * the exact rent of what the app builds, but not the number of transactions.
 */
import {
  address,
  getAddressDecoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Address,
  type CompiledTransactionMessage,
  type ReadonlyUint8Array,
  type SignaturesMap,
  type Transaction,
  type V1CompiledTransactionMessage,
} from "@solana/kit";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  ExtensionType,
  REALLOCATE_DISCRIMINATOR,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";
import {
  BATCHED_GROUPED_CIPHERTEXT_3_HANDLES_VALIDITY_CONTEXT_ACCOUNT_SIZE,
  BATCHED_RANGE_PROOF_CONTEXT_ACCOUNT_SIZE,
  CIPHERTEXT_CIPHERTEXT_EQUALITY_CONTEXT_ACCOUNT_SIZE,
  CIPHERTEXT_COMMITMENT_EQUALITY_CONTEXT_ACCOUNT_SIZE,
  ZERO_CIPHERTEXT_CONTEXT_ACCOUNT_SIZE,
  ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS,
} from "@solana-program/zk-elgamal-proof";

/** DvP program deployed on devnet from `devnet/ct-golden-path`. */
export const DEVNET_DVP_PROGRAM_ADDRESS = address(
  "bVntZ9Us9Wv8v2hMytmzLs4omXcZf3UwJ5xXbB3TnA6",
);

/**
 * Proof-context account sizes (33-byte context-state header + proof context)
 * created by the flows the relay serves. PubkeyValidity (65) is absent on
 * purpose: Configure and CreateConfidentialDvp verify it inline, no context.
 */
export const DEFAULT_CONTEXT_SIZES: readonly number[] = Object.freeze([
  // 129: VerifyZeroCiphertext. DvP Settle (remaining escrow balance is zero).
  ZERO_CIPHERTEXT_CONTEXT_ACCOUNT_SIZE,
  // 161: VerifyCiphertextCommitmentEquality. DvP Settle payment/surplus
  // transfer and Token-2022 CT transfer (equality proof).
  CIPHERTEXT_COMMITMENT_EQUALITY_CONTEXT_ACCOUNT_SIZE,
  // 225: VerifyCiphertextCiphertextEquality. DvP Settle eqLo/eqHi binding of
  // the payment limbs to the stored amount_b ciphertext.
  CIPHERTEXT_CIPHERTEXT_EQUALITY_CONTEXT_ACCOUNT_SIZE,
  // 297: VerifyBatchedRangeProofU128 (same size for U64/U256). DvP Settle and
  // Token-2022 CT transfer (range proof).
  BATCHED_RANGE_PROOF_CONTEXT_ACCOUNT_SIZE,
  // 385: VerifyBatchedGroupedCiphertext3HandlesValidity. DvP Settle and
  // Token-2022 CT transfer (ciphertext validity proof).
  BATCHED_GROUPED_CIPHERTEXT_3_HANDLES_VALIDITY_CONTEXT_ACCOUNT_SIZE,
]);

/**
 * Rent-exempt minimum with the default rent parameters:
 * (128 account-storage overhead + space) * 3480 lamports/byte-year * 2 years.
 * Matches `getMinimumBalanceForRentExemption` on devnet/mainnet today; the
 * server should still prefer values fetched from RPC.
 */
export function defaultRentExemptMinimum(space: number): bigint {
  return (128n + BigInt(space)) * 3480n * 2n;
}

export type RelayPolicyConfig = Readonly<{
  /** Fee payer and mint authority; co-signs whatever passes. */
  treasury: Address;
  /** DvP program address (devnet: `DEVNET_DVP_PROGRAM_ADDRESS`). */
  dvpProgram: Address;
  /** Allowed proof-context account sizes. Defaults to `DEFAULT_CONTEXT_SIZES`. */
  contextSizes?: readonly number[];
  /**
   * Rent-exempt minimum for a given space, synchronous. Return `undefined` for
   * an unknown size (refused). Defaults to `defaultRentExemptMinimum`.
   */
  rentExemptLamports?: (space: number) => bigint | undefined;
  /** Cap on the v1 total priority fee, in lamports. Default 0 (none allowed). */
  maxPriorityFeeLamports?: bigint;
  /** Cap on required signatures (each costs the treasury the base fee). Default 12. */
  maxSigners?: number;
}>;

export class RelayPolicyError extends Error {
  constructor(reason: string) {
    super(`Relay refused: ${reason}`);
    this.name = "RelayPolicyError";
  }
}

/** Generous bound on the base64 body: v1 transactions are at most 4096 bytes. */
export const MAX_WIRE_BASE64_LENGTH = 8192;

export type DecodedRelayTransaction = Readonly<{
  transaction: Transaction;
  message: CompiledTransactionMessage;
  signatures: SignaturesMap;
}>;

/** Decode a base64 wire transaction into kit's `Transaction`, its compiled message and signatures. */
export function decodeRelayTransaction(
  wireBase64: string,
): DecodedRelayTransaction {
  if (wireBase64.length > MAX_WIRE_BASE64_LENGTH)
    throw new RelayPolicyError("transaction is too large");
  let transaction: Transaction, message: CompiledTransactionMessage;
  try {
    transaction = getTransactionDecoder().decode(
      getBase64Encoder().encode(wireBase64),
    );
    message = getCompiledTransactionMessageDecoder().decode(
      transaction.messageBytes,
    );
  } catch (e) {
    throw new RelayPolicyError(
      `cannot decode transaction (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  return { transaction, message, signatures: transaction.signatures };
}

export type RelayableInput =
  | Transaction
  | ReadonlyUint8Array
  | CompiledTransactionMessage;

function toCompiledMessage(input: RelayableInput): CompiledTransactionMessage {
  if (input instanceof Uint8Array || "messageBytes" in input) {
    const bytes = input instanceof Uint8Array ? input : input.messageBytes;
    try {
      return getCompiledTransactionMessageDecoder().decode(bytes);
    } catch (e) {
      throw new RelayPolicyError(
        `cannot decode message (${e instanceof Error ? e.message : String(e)})`,
      );
    }
  }
  return input as CompiledTransactionMessage;
}

type DecodedInstruction = Readonly<{
  index: number;
  program: Address;
  accounts: readonly Address[];
  data: ReadonlyUint8Array;
}>;

function instructionsOf(
  message: V1CompiledTransactionMessage,
): DecodedInstruction[] {
  const { staticAccounts } = message;
  const at = (i: number, what: string): Address => {
    const account = staticAccounts[i];
    if (account === undefined)
      throw new RelayPolicyError(`${what} index ${i} is out of range`);
    return account;
  };
  if (
    message.instructionHeaders.length !== message.instructionPayloads.length
  )
    throw new RelayPolicyError("malformed instruction list");
  return message.instructionHeaders.map((header, index) => {
    const payload = message.instructionPayloads[index]!;
    return {
      index,
      program: at(header.programAccountIndex, "program"),
      accounts: payload.instructionAccountIndices.map((i) => at(i, "account")),
      data: payload.instructionData,
    };
  });
}

function positionsOf(accounts: readonly Address[], who: Address): number[] {
  return accounts.flatMap((a, i) => (a === who ? [i] : []));
}

function u32le(data: ReadonlyUint8Array, offset: number): number {
  return (
    (data[offset]! |
      (data[offset + 1]! << 8) |
      (data[offset + 2]! << 16) |
      (data[offset + 3]! << 24)) >>>
    0
  );
}

function u64le(data: ReadonlyUint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(data[offset + i]!);
  return value;
}

const SYSTEM_CREATE_ACCOUNT = 0;
// u32 discriminator + u64 lamports + u64 space + 32-byte owner.
const SYSTEM_CREATE_ACCOUNT_DATA_LEN = 52;
const ZK_CLOSE_CONTEXT_STATE = 0;
// Verify* data is [discriminator, u32 offset] when the proof sits in an account.
const ZK_VERIFY_FROM_ACCOUNT_DATA_LEN = 5;
const DVP_CREATE_CONFIDENTIAL = 6;
const REALLOCATE_ALLOWED_EXTENSIONS: ReadonlySet<number> = new Set([
  ExtensionType.ConfidentialTransferAccount,
]);

const addressDecoder = getAddressDecoder();

type Ctx = Readonly<{
  treasury: Address;
  contextSizes: ReadonlySet<number>;
  rent: (space: number) => bigint | undefined;
}>;

function checkSystem(ix: DecodedInstruction, ctx: Ctx): void {
  const { data, accounts } = ix;
  if (
    data.length !== SYSTEM_CREATE_ACCOUNT_DATA_LEN ||
    u32le(data, 0) !== SYSTEM_CREATE_ACCOUNT
  )
    throw new RelayPolicyError(
      `instruction ${ix.index}: only System CreateAccount is allowed`,
    );
  if (accounts.length !== 2)
    throw new RelayPolicyError(
      `instruction ${ix.index}: CreateAccount must have exactly 2 accounts`,
    );
  if (accounts[0] !== ctx.treasury)
    throw new RelayPolicyError(
      `instruction ${ix.index}: CreateAccount must be funded by the treasury`,
    );
  if (accounts[1] === ctx.treasury)
    throw new RelayPolicyError(
      `instruction ${ix.index}: CreateAccount cannot target the treasury`,
    );
  const lamports = u64le(data, 4);
  const space = u64le(data, 12);
  const owner = addressDecoder.decode(data.subarray(20, 52));
  if (owner !== ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS)
    throw new RelayPolicyError(
      `instruction ${ix.index}: CreateAccount owner ${owner} is not the ZK ElGamal Proof program`,
    );
  if (space > BigInt(Number.MAX_SAFE_INTEGER) || !ctx.contextSizes.has(Number(space)))
    throw new RelayPolicyError(
      `instruction ${ix.index}: CreateAccount space ${space} is not an allowed proof-context size`,
    );
  const expected = ctx.rent(Number(space));
  if (expected === undefined)
    throw new RelayPolicyError(
      `instruction ${ix.index}: no rent value for space ${space}`,
    );
  if (lamports !== expected)
    throw new RelayPolicyError(
      `instruction ${ix.index}: CreateAccount lamports ${lamports} != rent-exempt minimum ${expected} for space ${space}`,
    );
}

function assertTreasuryOnlyAt(
  ix: DecodedInstruction,
  ctx: Ctx,
  allowed: readonly number[],
  what: string,
): number[] {
  const positions = positionsOf(ix.accounts, ctx.treasury);
  const bad = positions.filter((p) => !allowed.includes(p));
  if (bad.length > 0)
    throw new RelayPolicyError(
      `instruction ${ix.index}: treasury account inside ${what} (position ${bad.join(", ")})`,
    );
  return positions;
}

function checkToken2022(ix: DecodedInstruction, ctx: Ctx): void {
  if (ix.data[0] !== REALLOCATE_DISCRIMINATOR) {
    assertTreasuryOnlyAt(ix, ctx, [], "a Token-2022 instruction");
    return;
  }
  // Reallocate accounts: [token, payer, systemProgram, owner, ...multisigners].
  assertTreasuryOnlyAt(ix, ctx, [1], "Token-2022 Reallocate other than as payer");
  const extensions = ix.data.length - 1;
  if (extensions === 0 || extensions % 2 !== 0)
    throw new RelayPolicyError(
      `instruction ${ix.index}: malformed Reallocate data`,
    );
  for (let offset = 1; offset < ix.data.length; offset += 2) {
    const ext = ix.data[offset]! | (ix.data[offset + 1]! << 8);
    if (!REALLOCATE_ALLOWED_EXTENSIONS.has(ext))
      throw new RelayPolicyError(
        `instruction ${ix.index}: Reallocate extension ${ext} is not allowed`,
      );
  }
}

function checkZkProof(ix: DecodedInstruction, ctx: Ctx): void {
  const discriminator = ix.data[0];
  if (discriminator === undefined)
    throw new RelayPolicyError(`instruction ${ix.index}: empty ZK proof instruction`);
  if (discriminator === ZK_CLOSE_CONTEXT_STATE) {
    // Accounts: [contextState, destination, authority].
    const positions = assertTreasuryOnlyAt(
      ix,
      ctx,
      [1, 2],
      "CloseContextState other than as destination or authority",
    );
    if (positions.includes(2) && ix.accounts[1] !== ctx.treasury)
      throw new RelayPolicyError(
        `instruction ${ix.index}: CloseContextState with treasury authority must pay out to the treasury`,
      );
    return;
  }
  // Verify*: [proofAccount?, contextState, contextStateAuthority]; the proof
  // account is present only when the data is [discriminator, u32 offset].
  const authorityIndex =
    ix.data.length === ZK_VERIFY_FROM_ACCOUNT_DATA_LEN ? 2 : 1;
  const positions = assertTreasuryOnlyAt(
    ix,
    ctx,
    [authorityIndex],
    "a ZK proof verify instruction other than as context-state authority",
  );
  if (positions.length > 0 && ix.accounts.length !== authorityIndex + 1)
    throw new RelayPolicyError(
      `instruction ${ix.index}: unexpected accounts after the context-state authority`,
    );
}

function checkDvp(ix: DecodedInstruction, ctx: Ctx): void {
  // CreateConfidentialDvp accounts start with `payer` (funds swap PDA,
  // tombstone and escrow ATA rent).
  const allowed = ix.data[0] === DVP_CREATE_CONFIDENTIAL ? [0] : [];
  assertTreasuryOnlyAt(
    ix,
    ctx,
    allowed,
    "a DvP instruction other than as CreateConfidentialDvp payer",
  );
}

/**
 * Throws `RelayPolicyError` unless the transaction is one the app would build.
 * Accepts kit's decoded `Transaction`, raw message bytes, or a compiled message.
 */
export function assertRelayable(
  input: RelayableInput,
  config: RelayPolicyConfig,
): void {
  const message = toCompiledMessage(input);
  if (message.version !== 1)
    throw new RelayPolicyError(
      `only v1 transactions are relayed (got ${message.version === "legacy" ? "legacy" : `v${message.version}`})`,
    );
  const { treasury } = config;
  if (message.staticAccounts[0] !== treasury)
    throw new RelayPolicyError("treasury is not the fee payer");

  const maxSigners = config.maxSigners ?? 12;
  if (message.header.numSignerAccounts > maxSigners)
    throw new RelayPolicyError(
      `too many signers (${message.header.numSignerAccounts} > ${maxSigners})`,
    );

  // In v1 the only u64 config value is the total priority fee.
  const priorityFee =
    message.configValues.find((v) => v.kind === "u64")?.value ?? 0n;
  const maxPriorityFee = config.maxPriorityFeeLamports ?? 0n;
  if (BigInt(priorityFee) > maxPriorityFee)
    throw new RelayPolicyError(
      `priority fee ${priorityFee} exceeds ${maxPriorityFee} lamports`,
    );

  const instructions = instructionsOf(message);
  if (instructions.length === 0)
    throw new RelayPolicyError("transaction has no instructions");

  const ctx: Ctx = {
    treasury,
    contextSizes: new Set(config.contextSizes ?? DEFAULT_CONTEXT_SIZES),
    rent: config.rentExemptLamports ?? defaultRentExemptMinimum,
  };
  for (const ix of instructions) {
    switch (ix.program) {
      case SYSTEM_PROGRAM_ADDRESS:
        checkSystem(ix, ctx);
        break;
      case TOKEN_PROGRAM_ADDRESS:
        assertTreasuryOnlyAt(ix, ctx, [], "a token instruction");
        break;
      case TOKEN_2022_PROGRAM_ADDRESS:
        checkToken2022(ix, ctx);
        break;
      case ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS:
        checkZkProof(ix, ctx);
        break;
      case config.dvpProgram:
        checkDvp(ix, ctx);
        break;
      default:
        throw new RelayPolicyError(
          `instruction ${ix.index}: program ${ix.program} is not allowed`,
        );
    }
  }
}
