import {
  assertAccountsExist,
  fetchEncodedAccounts,
  type GetMultipleAccountsApi,
  type Rpc,
} from "@solana/kit";
import { getTokenDecoder } from "@solana-program/token-2022";
import {
  confidentialState,
  mintAuditor,
  settleSession,
  verifyConfidentialFunding,
  type EscrowKeys,
  type SessionConfig,
  type SettleSessionInput,
} from "../../src/confidential";

/**
 * Happy path after funding both legs and applying leg B's pending credits.
 * Supply accounts derived from agreed public terms, and the agreed private amount.
 * This example assumes no transfer hooks and a current, consistent AE balance.
 */
export async function prepareSettlement(
  rpc: Rpc<GetMultipleAccountsApi>,
  config: SessionConfig,
  accounts: SettleSessionInput,
  keys: EscrowKeys,
  expectedAmount: bigint,
) {
  // Read the swap, escrow, receiving accounts and auditor from one RPC snapshot.
  const snapshots = await fetchEncodedAccounts(
    rpc,
    [
      accounts.swapDvp,
      accounts.dvpAtaB,
      accounts.userADestinationAtaB,
      accounts.userBAtaB,
      accounts.mintB,
    ] as const,
    { commitment: "confirmed" },
  );
  assertAccountsExist(snapshots);
  const [swap, escrow, recipient, refund, mint] = snapshots;
  if (!swap || !escrow || !recipient || !refund || !mint)
    throw new Error("RPC returned an incomplete settlement snapshot");
  const checked = await verifyConfidentialFunding(
    swap,
    escrow,
    keys,
    expectedAmount,
  );

  // The client creates payment, optional surplus, amount-binding and zero proofs.
  // Retain the returned session for cleanup if preparation is interrupted.
  return settleSession(config, accounts, {
    source: { state: checked.state, keys },
    swap: checked.swap,
    expectedAmountB: expectedAmount,
    recipient: confidentialState(getTokenDecoder().decode(recipient.data)),
    surplusRecipient: confidentialState(getTokenDecoder().decode(refund.data)),
    auditor: mintAuditor(mint),
  });
}
