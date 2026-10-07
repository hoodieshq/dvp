import { getApplyConfidentialDvpInstruction } from "../..";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applySession,
  BalanceHistory,
  PlannedTransaction,
  recoverEscrowBalance,
  verifyConfidentialFunding,
} from "../../confidential";
import { execute, send, TestContext } from "./context";
import { createAndFund, fixture } from "./utils";

test("recover a false AE value from funding history and repair it with Apply", async () => {
  const context = new TestContext(),
    f = await fixture(context, 1);
  try {
    const history = await createAndFund(context, f);
    // A stale caller can submit an authenticated AE value that disagrees with ElGamal.
    const falseAe = f.keys.ae.encrypt(1n);
    try {
      history.push(
        await send(
          context,
          f.config,
          new PlannedTransaction([
            getApplyConfidentialDvpInstruction({
              ...f.apply,
              expectedPendingBalanceCreditCounter: 0n,
              newDecryptableAvailableBalance: Array.from(falseAe.toBytes()),
            }),
          ]),
        ),
      );
    } finally {
      falseAe.free();
    }
    await assert.rejects(
      verifyConfidentialFunding(
        context.account(f.common.swapDvp)!,
        context.account(f.common.dvpAtaB)!,
        f.keys,
        f.amount,
      ),
      /AE and ElGamal balances disagree/,
    );

    const replay = new BalanceHistory(f.common.dvpAtaB);
    for (const tx of history) replay.push(tx);
    const state = f.state(f.common.dvpAtaB);
    assert.equal(
      recoverEscrowBalance(state, 0n, f.keys, replay.events()).available,
      f.amount,
    );
    assert.throws(
      () => recoverEscrowBalance(state, 0n, f.keys, []),
      /Incomplete balance history/,
    );
    await execute(
      context,
      f.config,
      applySession(f.config, f.apply, {
        state,
        keys: f.keys,
        history: replay.events(),
      }),
    );
    await verifyConfidentialFunding(
      context.account(f.common.swapDvp)!,
      context.account(f.common.dvpAtaB)!,
      f.keys,
      f.amount,
    );
  } finally {
    f.close();
  }
});
