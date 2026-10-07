import {
  downgradeRoleToNonSigner,
  type AccountMeta,
  type Address,
  type Instruction,
} from "@solana/kit";
import { getVerifyProofInstruction } from "@solana-program/zk-elgamal-proof";
import {
  CiphertextCiphertextEqualityProofData,
  PubkeyValidityProofData,
  ZeroCiphertextProofData,
} from "@solana/zk-sdk";
import {
  getCreateConfidentialDvpInstruction,
  getApplyConfidentialDvpInstruction,
  getSettleConfidentialDvpInstruction,
  getReclaimConfidentialDvpInstruction,
  getCancelConfidentialDvpInstruction,
  getRejectConfidentialDvpInstruction,
  getRecoverConfidentialDvpInstruction,
  type CreateConfidentialDvpInput,
  type ApplyConfidentialDvpInput,
  type SettleConfidentialDvpInput,
  type ReclaimConfidentialDvpInput,
  type CancelConfidentialDvpInput,
  type RejectConfidentialDvpInput,
  type RecoverConfidentialDvpInput,
} from "../generated/instructions";
import type { LegBRefundArgs } from "../generated/types";
import type { ConfidentialSwapDvp } from "../verify";
import { EscrowKeys, type ConfidentialAccountKeys } from "./keys";
import { AMOUNT_LO_BITS, MAX_TRANSFER_AMOUNT } from "./constants";
import {
  readAvailableBalance,
  readEscrowBalance,
  checkEscrowKeys,
  type BalanceEvent,
  type ConfidentialTransferAccount,
} from "./balance";
import { assertU64, bytesEqual, parseCiphertext } from "./math";
import { prepareTransfer, checkRecipient } from "./proofs";
import { SessionBuilder, ProofKind, type SessionConfig } from "./transaction";

export type TransferSource<
  TKeys extends ConfidentialAccountKeys = ConfidentialAccountKeys,
> = Readonly<{
  state: ConfidentialTransferAccount;
  keys: TKeys;
  history?: readonly BalanceEvent[];
}>;
export type HookExtras = Readonly<{
  legA?: readonly AccountMeta[];
  legB?: readonly AccountMeta[];
}>;

export function hookExtras(extras: HookExtras): AccountMeta[] {
  const a = extras.legA ?? [],
    b = extras.legB ?? [];
  if (a.length > 32 || b.length > 32)
    throw new Error("At most 32 hook extras per leg");
  return [...a, ...b].map((meta) => ({
    address: meta.address,
    role: downgradeRoleToNonSigner(meta.role),
  }));
}

function appendExtras(ix: Instruction, extras: HookExtras): Instruction {
  return { ...ix, accounts: [...(ix.accounts ?? []), ...hookExtras(extras)] };
}

export type CreateSessionInput = Omit<
  CreateConfidentialDvpInput,
  | "amountBCiphertextLo"
  | "amountBCiphertextHi"
  | "decryptableZeroBalance"
  | "pubkeyValidityProofOffset"
>;
export function createSession(
  config: SessionConfig,
  input: CreateSessionInput,
  keys: EscrowKeys,
  amount: bigint,
) {
  const ciphertext = keys.encryptAmount(amount),
    proof = new PubkeyValidityProofData(keys.elgamal),
    zero = keys.ae.encrypt(0n);
  try {
    return new SessionBuilder(config, config.payer).finish([
      getVerifyProofInstruction({
        discriminator: ProofKind.Pubkey,
        proofData: proof.toBytes(),
      }),
      getCreateConfidentialDvpInstruction(
        {
          ...input,
          amountBCiphertextLo: Array.from(ciphertext.lo),
          amountBCiphertextHi: Array.from(ciphertext.hi),
          decryptableZeroBalance: Array.from(zero.toBytes()),
          pubkeyValidityProofOffset: -1,
        },
        { programAddress: config.programAddress },
      ),
    ]);
  } finally {
    proof.free();
    zero.free();
  }
}

export type ApplySessionInput = Omit<
  ApplyConfidentialDvpInput,
  "expectedPendingBalanceCreditCounter" | "newDecryptableAvailableBalance"
>;
export function applySession(
  config: SessionConfig,
  input: ApplySessionInput,
  source: TransferSource,
) {
  const balance = readEscrowBalance(
    source.state,
    0n,
    source.keys,
    source.history,
  );
  const appliedBalance = balance.available + balance.pending;
  assertU64(appliedBalance);
  const ae = source.keys.ae.encrypt(appliedBalance);
  try {
    return new SessionBuilder(config, input.signer).finish([
      getApplyConfidentialDvpInstruction(
        {
          ...input,
          expectedPendingBalanceCreditCounter: balance.pendingCreditCounter,
          newDecryptableAvailableBalance: Array.from(ae.toBytes()),
        },
        { programAddress: config.programAddress },
      ),
    ]);
  } finally {
    ae.free();
  }
}

type SettleProofFields =
  | "paymentEqualityContext"
  | "paymentValidityContext"
  | "paymentRangeContext"
  | "eqLoContext"
  | "eqHiContext"
  | "zeroContext"
  | "surplusEqualityContext"
  | "surplusValidityContext"
  | "surplusRangeContext"
  | "payment"
  | "surplusB"
  | "legAExtrasCount";
export type SettleSessionInput = Omit<
  SettleConfidentialDvpInput,
  SettleProofFields
>;
export type SettleRequest = Readonly<{
  source: TransferSource<EscrowKeys>;
  swap: ConfidentialSwapDvp;
  expectedAmountB: bigint;
  recipient: ConfidentialTransferAccount;
  surplusRecipient: ConfidentialTransferAccount;
  auditor?: Uint8Array;
}>;

export async function settleSession(
  config: SessionConfig,
  input: SettleSessionInput,
  request: SettleRequest,
  extras: HookExtras = {},
) {
  hookExtras(extras);
  if (
    config.format === 0 &&
    (extras.legA?.length ?? 0) + (extras.legB?.length ?? 0) > 0
  )
    throw new Error("Hooked Settle requires v1");
  const { source } = request;
  checkEscrowKeys(source.state, source.keys);
  const expected = source.keys.encryptAmount(request.expectedAmountB);
  if (
    !bytesEqual(expected.lo, request.swap.amountB.lo) ||
    !bytesEqual(expected.hi, request.swap.amountB.hi)
  )
    throw new Error("Confidential amount mismatch");
  const balance = readAvailableBalance(
    source.state,
    source.keys,
    source.history,
  );
  if (balance < request.expectedAmountB)
    throw new Error("Insufficient available balance");
  const surplus = balance - request.expectedAmountB;
  if (surplus > MAX_TRANSFER_AMOUNT)
    throw new Error("Surplus exceeds 2^48-1; reclaim partially first");
  // Payment and surplus each add one credit when they share the same recipient.
  const paymentCredits =
    surplus > 0n && input.userADestinationAtaB === input.userBAtaB ? 2n : 1n;
  checkRecipient(request.recipient, paymentCredits);
  if (surplus > 0n) checkRecipient(request.surplusRecipient, paymentCredits);
  const session = new SessionBuilder(config, input.settlementAuthority);
  const payment = await prepareTransfer(
    session,
    source.keys,
    new Uint8Array(source.state.availableBalance),
    balance,
    request.expectedAmountB,
    request.recipient,
    request.auditor,
  );
  const [paymentEqualityContext, paymentValidityContext, paymentRangeContext] =
    payment.contexts;

  const binding: Address[] = [];
  const limbs = [
    request.expectedAmountB & ((1n << AMOUNT_LO_BITS) - 1n),
    request.expectedAmountB >> AMOUNT_LO_BITS,
  ];
  for (const [index, stored, opening] of [
    [0, expected.lo, source.keys.openingLo],
    [1, expected.hi, source.keys.openingHi],
  ] as const) {
    const limb = parseCiphertext(payment.limbs[index]),
      target = parseCiphertext(stored),
      pubkey = source.keys.elgamal.pubkey();
    const proof = new CiphertextCiphertextEqualityProofData(
      source.keys.elgamal,
      pubkey,
      limb,
      target,
      opening,
      limbs[index]!,
    );
    try {
      binding.push(await session.proof(ProofKind.CiphertextEquality, proof));
    } finally {
      proof.free();
      limb.free();
      target.free();
      pubkey.free();
    }
  }
  const refund =
    surplus > 0n
      ? await prepareTransfer(
          session,
          source.keys,
          payment.remaining,
          surplus,
          surplus,
          request.surplusRecipient,
          request.auditor,
        )
      : undefined;
  const remaining = parseCiphertext(refund?.remaining ?? payment.remaining);
  const zero = new ZeroCiphertextProofData(source.keys.elgamal, remaining);
  let zeroContext: Address;
  try {
    zeroContext = await session.proof(ProofKind.Zero, zero);
  } finally {
    zero.free();
    remaining.free();
  }
  return session.finish([
    appendExtras(
      getSettleConfidentialDvpInstruction(
        {
          ...input,
          paymentEqualityContext,
          paymentValidityContext,
          paymentRangeContext,
          eqLoContext: binding[0]!,
          eqHiContext: binding[1]!,
          zeroContext,
          surplusEqualityContext: refund?.contexts[0],
          surplusValidityContext: refund?.contexts[1],
          surplusRangeContext: refund?.contexts[2],
          payment: payment.data,
          surplusB: refund?.data ?? null,
          legAExtrasCount: extras.legA?.length ?? 0,
        },
        { programAddress: config.programAddress },
      ),
      extras,
    ),
  ]);
}

type RefundProofFields =
  | "equalityContext"
  | "validityContext"
  | "rangeContext"
  | "zeroContext"
  | "legBRefund"
  | "legAExtrasCount";
export type RefundInstruction =
  | {
      kind: "reclaim";
      input: Omit<ReclaimConfidentialDvpInput, RefundProofFields>;
    }
  | {
      kind: "cancel";
      input: Omit<CancelConfidentialDvpInput, RefundProofFields>;
    }
  | {
      kind: "reject";
      input: Omit<RejectConfidentialDvpInput, RefundProofFields>;
    }
  | {
      kind: "recover";
      input: Omit<RecoverConfidentialDvpInput, RefundProofFields>;
    };
export type RefundAmount =
  | { kind: "none" }
  | { kind: "full" }
  | { kind: "partial"; amount: bigint };
export type RefundRequest = Readonly<{
  source: TransferSource;
  recipient: ConfidentialTransferAccount;
  amount: RefundAmount;
  auditor?: Uint8Array;
}>;

export async function refundSession(
  config: SessionConfig,
  instruction: RefundInstruction,
  request?: RefundRequest,
  extras: HookExtras = {},
) {
  hookExtras(extras);
  if (instruction.kind === "recover" && extras.legA?.length)
    throw new Error("Recover has only leg B extras");
  const authority =
    instruction.kind === "cancel"
      ? instruction.input.settlementAuthority
      : instruction.input.signer;
  const session = new SessionBuilder(config, authority);
  let equalityContext: Address | undefined,
    validityContext: Address | undefined,
    rangeContext: Address | undefined,
    zeroContext: Address | undefined;
  let legBRefund: LegBRefundArgs = { __kind: "None" };
  if (request) {
    const { source } = request;
    const balance = readAvailableBalance(
      source.state,
      source.keys,
      source.history,
    );
    if (request.amount.kind === "none") {
      if (source.state.availableBalance.some((byte) => byte !== 0))
        throw new Error(
          "None refund requires an all-zero available ciphertext",
        );
    } else {
      const amount =
        request.amount.kind === "full" ? balance : request.amount.amount;
      if (request.amount.kind === "partial" && amount === 0n)
        throw new Error("Partial refund must be nonzero");
      const transfer = await prepareTransfer(
        session,
        source.keys,
        new Uint8Array(source.state.availableBalance),
        balance,
        amount,
        request.recipient,
        request.auditor,
      );
      [equalityContext, validityContext, rangeContext] = transfer.contexts;
      legBRefund = {
        __kind: request.amount.kind === "full" ? "Full" : "Partial",
        fields: [transfer.data],
      };
      if (request.amount.kind === "full") {
        const remaining = parseCiphertext(transfer.remaining),
          zero = new ZeroCiphertextProofData(source.keys.elgamal, remaining);
        try {
          zeroContext = await session.proof(ProofKind.Zero, zero);
        } finally {
          zero.free();
          remaining.free();
        }
      }
    }
  }
  const proof = {
    equalityContext,
    validityContext,
    rangeContext,
    zeroContext,
    legBRefund,
    legAExtrasCount: extras.legA?.length ?? 0,
  };
  let ix: Instruction;
  switch (instruction.kind) {
    case "reclaim":
      ix = getReclaimConfidentialDvpInstruction(
        {
          ...instruction.input,
          ...proof,
        },
        { programAddress: config.programAddress },
      );
      break;
    case "cancel":
      ix = getCancelConfidentialDvpInstruction(
        {
          ...instruction.input,
          ...proof,
        },
        { programAddress: config.programAddress },
      );
      break;
    case "reject":
      ix = getRejectConfidentialDvpInstruction(
        {
          ...instruction.input,
          ...proof,
        },
        { programAddress: config.programAddress },
      );
      break;
    case "recover":
      ix = getRecoverConfidentialDvpInstruction(
        {
          ...instruction.input,
          ...proof,
        },
        { programAddress: config.programAddress },
      );
      break;
  }
  return session.finish([appendExtras(ix, extras)]);
}
