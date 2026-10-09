import type { Address, EncodedAccount } from "@solana/kit";
import {
  decodeSwapDvpChecked,
  findSwapDvpPda,
  SwapDvpVerificationError,
} from "../verify";
import type { EscrowKeys } from "./keys";
import { readEscrowAccount, verifyConfidentialSwap } from "./balance";

/** Verify caller-fetched snapshots before funding, without imposing an RPC transport. */
export async function verifyConfidentialFunding(
  rawSwap: EncodedAccount,
  rawEscrow: EncodedAccount,
  keys: EscrowKeys,
  expectedAmount: bigint,
  programAddress?: Address,
) {
  const account = decodeSwapDvpChecked(rawSwap, programAddress);
  if (account.data.mode !== "confidential")
    throw new SwapDvpVerificationError("Expected a confidential swap");
  const [expected] = await findSwapDvpPda({ ...account.data, programAddress });
  if (account.address !== expected)
    throw new SwapDvpVerificationError("Wrong swap PDA");
  const escrow = await readEscrowAccount(
    rawEscrow,
    expected,
    account.data.mintB,
  );
  verifyConfidentialSwap(
    account.data.confidential,
    escrow.state,
    keys,
    expectedAmount,
  );
  return { swap: account.data.confidential, ...escrow };
}
