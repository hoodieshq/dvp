import {
  ExtensionType,
  getEnableMemoTransfersInstruction,
  getReallocateInstruction,
} from "@solana-program/token-2022";
import { address } from "@solana/kit";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PlannedTransaction,
  readEscrowBalance,
  resolveConfidentialHookAccounts,
  settleSession,
} from "../../confidential";
import { TestContext, execute, send } from "./context";
import { createAndFund, fixture } from "./utils";

test("resolve confidential hooks and settle with a required recipient memo", async () => {
  const context = new TestContext(),
    f = await fixture(context, 1, { hook: true });
  try {
    const hook = {
      rpc: context.rpc,
      transferHookProgramAddress: address(f.hookProgram),
      mint: f.common.mintB,
    };
    const fundingExtras = await resolveConfidentialHookAccounts({
      ...hook,
      source: f.common.userBAtaB,
      destination: f.common.dvpAtaB,
      owner: f.userB.address,
    });
    await createAndFund(context, f, f.amount, fundingExtras);
    await send(
      context,
      f.config,
      new PlannedTransaction([
        getReallocateInstruction({
          token: address(f.recipient),
          owner: f.userA,
          payer: f.payer,
          newExtensionTypes: [ExtensionType.MemoTransfer],
        }),
        getEnableMemoTransfersInstruction({
          token: address(f.recipient),
          owner: f.userA,
        }),
      ]),
    );

    const extras = await resolveConfidentialHookAccounts({
      ...hook,
      source: f.common.dvpAtaB,
      destination: address(f.recipient),
      owner: f.common.swapDvp,
    });
    const request = {
      source: f.source(),
      swap: f.swap(),
      expectedAmountB: f.amount,
      recipient: f.state(address(f.recipient)),
      surplusRecipient: f.state(f.common.userBAtaB),
    };
    await assert.rejects(
      settleSession({ ...f.config, format: 0 }, f.settle, request, {
        legB: extras,
      }),
      /Hooked Settle requires v1/,
    );
    const history = await execute(
      context,
      f.config,
      await settleSession(f.config, f.settle, request, { legB: extras }),
    );
    const inner = history.flatMap((tx) =>
      [...tx.innerInstructions.values()].flat(),
    );
    assert(inner.some((ix) => ix.programAddress === f.hookProgram));
    assert(inner.some((ix) => ix.programAddress === f.common.memoProgram));
    assert.equal(
      readEscrowBalance(f.state(address(f.recipient)), 0n, f.recipientKeys)
        .pending,
      f.amount,
    );
  } finally {
    f.close();
  }
});
