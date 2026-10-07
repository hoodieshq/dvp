import {
  getAddressEncoder,
  isSome,
  type Address,
  type EncodedAccount,
} from "@solana/kit";
import {
  getTokenDecoder,
  getMintDecoder,
  TOKEN_2022_PROGRAM_ADDRESS,
  type Extension,
  type Token,
} from "@solana-program/token-2022";
import { AeCiphertext } from "@solana/zk-sdk";
import { findSwapDvpEscrowAta, type ConfidentialSwapDvp } from "../verify";
import { EscrowKeys, type ConfidentialAccountKeys } from "./keys";
import { AMOUNT_LO_BITS, MAX_TRANSFER_AMOUNT } from "./constants";
import { assertU64, bytesEqual, ciphertextMatches, decryptLimb } from "./math";

export type ConfidentialTransferAccount = Extract<
  Extension,
  { __kind: "ConfidentialTransferAccount" }
>;
export type EscrowBalance = Readonly<{
  available: bigint;
  pending: bigint;
  pendingCreditCounter: bigint;
  public: bigint;
}>;
export type BalanceEvent =
  | { kind: "credit" | "debit"; lo: Uint8Array; hi: Uint8Array }
  | { kind: "deposit"; amount: bigint }
  | { kind: "withdraw"; amount: bigint }
  | { kind: "apply" | "empty" };

export function confidentialState(token: Token): ConfidentialTransferAccount {
  const state = isSome(token.extensions)
    ? token.extensions.value.find(
        (e) => e.__kind === "ConfidentialTransferAccount",
      )
    : undefined;
  if (!state) throw new Error("Missing confidential transfer extension");
  return state;
}

export async function readEscrowAccount(
  account: EncodedAccount,
  swap: Address,
  mint: Address,
) {
  const [expected] = await findSwapDvpEscrowAta({
    swapDvp: swap,
    mint,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  });
  if (
    account.programAddress !== TOKEN_2022_PROGRAM_ADDRESS ||
    account.address !== expected
  )
    throw new Error("Wrong escrow owner or address");
  const token = getTokenDecoder().decode(account.data);
  if (token.owner !== swap || token.mint !== mint)
    throw new Error("Wrong escrow authority or mint");
  return { state: confidentialState(token), public: token.amount };
}

export function mintAuditor(account: EncodedAccount): Uint8Array | undefined {
  if (account.programAddress !== TOKEN_2022_PROGRAM_ADDRESS)
    throw new Error("Wrong mint program");
  const mint = getMintDecoder().decode(account.data);
  const ct = isSome(mint.extensions)
    ? mint.extensions.value.find((e) => e.__kind === "ConfidentialTransferMint")
    : undefined;
  if (!ct) throw new Error("Missing confidential mint extension");
  return isSome(ct.auditorElgamalPubkey)
    ? new Uint8Array(getAddressEncoder().encode(ct.auditorElgamalPubkey.value))
    : undefined;
}

export class EscrowKeyMismatchError extends Error {
  constructor() {
    super("Wrong escrow ElGamal key");
    this.name = "EscrowKeyMismatchError";
  }
}

export function checkEscrowKeys(
  state: ConfidentialTransferAccount,
  keys: ConfidentialAccountKeys,
): void {
  const pubkey = keys.elgamal.pubkey();
  try {
    if (
      !bytesEqual(
        getAddressEncoder().encode(state.elgamalPubkey),
        pubkey.toBytes(),
      )
    )
      throw new EscrowKeyMismatchError();
  } finally {
    pubkey.free();
  }
}

export function checkedAvailableBalance(
  state: ConfidentialTransferAccount,
  keys: ConfidentialAccountKeys,
): bigint {
  checkEscrowKeys(state, keys);
  const ae = AeCiphertext.fromBytes(
    new Uint8Array(state.decryptableAvailableBalance),
  );
  if (!ae) throw new Error("Invalid decryptable balance");
  try {
    const amount = ae.decrypt(keys.ae);
    if (
      amount === undefined ||
      !ciphertextMatches(state.availableBalance, keys, amount)
    )
      throw new Error("AE and ElGamal balances disagree");
    return amount;
  } finally {
    ae.free();
  }
}

export function verifyConfidentialSwap(
  swap: ConfidentialSwapDvp,
  state: ConfidentialTransferAccount,
  keys: EscrowKeys,
  amount: bigint,
): void {
  if (swap.base.tokenProgramB !== TOKEN_2022_PROGRAM_ADDRESS)
    throw new Error("Wrong leg B token program");
  checkEscrowKeys(state, keys);
  const expected = keys.encryptAmount(amount);
  if (
    !bytesEqual(expected.lo, swap.amountB.lo) ||
    !bytesEqual(expected.hi, swap.amountB.hi)
  )
    throw new Error("Confidential amount mismatch");
  if (!state.approved || !state.allowConfidentialCredits)
    throw new Error("Escrow does not accept confidential credits");
  checkedAvailableBalance(state, keys);
}

/** Replay through the snapshot's slot and transaction position, then verify every balance and counter. */
export function recoverEscrowBalance(
  state: ConfidentialTransferAccount,
  publicAmount: bigint,
  keys: ConfidentialAccountKeys,
  history: readonly BalanceEvent[],
): EscrowBalance {
  checkEscrowKeys(state, keys);
  let available = 0n,
    lo = 0n,
    hi = 0n,
    counter = 0n;
  for (const event of history) {
    switch (event.kind) {
      case "credit":
      case "debit":
      case "deposit": {
        const low =
          event.kind === "deposit"
            ? event.amount & ((1n << AMOUNT_LO_BITS) - 1n)
            : decryptLimb(event.lo, keys);
        const high =
          event.kind === "deposit"
            ? event.amount >> AMOUNT_LO_BITS
            : decryptLimb(event.hi, keys);
        const amount = low + (high << AMOUNT_LO_BITS);
        if (
          low >= 1n << AMOUNT_LO_BITS ||
          amount < 0n ||
          amount > MAX_TRANSFER_AMOUNT
        )
          throw new Error("Invalid history transfer amount");
        if (event.kind === "debit") {
          available -= amount;
          assertU64(available);
        } else {
          lo += low;
          hi += high;
          counter += 1n;
          assertU64(lo);
          assertU64(hi);
          assertU64(counter);
        }
        break;
      }
      case "withdraw":
        assertU64(event.amount);
        available -= event.amount;
        assertU64(available);
        break;
      case "apply":
        available += lo + (hi << AMOUNT_LO_BITS);
        assertU64(available);
        lo = hi = counter = 0n;
        break;
      case "empty":
        if (available || lo || hi)
          throw new Error("Nonzero balance before Empty");
        break;
    }
  }
  if (
    !ciphertextMatches(state.availableBalance, keys, available) ||
    !ciphertextMatches(state.pendingBalanceLow, keys, lo) ||
    !ciphertextMatches(state.pendingBalanceHigh, keys, hi) ||
    counter !== state.pendingBalanceCreditCounter
  )
    throw new Error("Incomplete balance history");
  const pending = lo + (hi << AMOUNT_LO_BITS);
  assertU64(pending);
  assertU64(publicAmount);
  return {
    available,
    pending,
    pendingCreditCounter: counter,
    public: publicAmount,
  };
}

export function readAvailableBalance(
  state: ConfidentialTransferAccount,
  keys: ConfidentialAccountKeys,
  history: readonly BalanceEvent[] = [],
): bigint {
  try {
    return checkedAvailableBalance(state, keys);
  } catch {
    return recoverEscrowBalance(state, 0n, keys, history).available;
  }
}

export function readEscrowBalance(
  state: ConfidentialTransferAccount,
  publicAmount: bigint,
  keys: ConfidentialAccountKeys,
  history: readonly BalanceEvent[] = [],
): EscrowBalance {
  try {
    const available = checkedAvailableBalance(state, keys);
    const lo = decryptLimb(state.pendingBalanceLow, keys),
      hi = decryptLimb(state.pendingBalanceHigh, keys);
    const pending = lo + (hi << AMOUNT_LO_BITS);
    assertU64(pending);
    assertU64(publicAmount);
    return {
      available,
      pending,
      pendingCreditCounter: state.pendingBalanceCreditCounter,
      public: publicAmount,
    };
  } catch {
    return recoverEscrowBalance(state, publicAmount, keys, history);
  }
}
