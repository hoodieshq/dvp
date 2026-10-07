import { address } from "@solana/kit";
import assert from "node:assert/strict";
import { test } from "node:test";
import { PlannedTransaction, settleSession } from "../../confidential";
import { TestContext, execute, send } from "./context";
import { createAndFund, fixture } from "./utils";

test("clean up interrupted v0 preparation and rebuild the session", async () => {
  const context = new TestContext(),
    f = await fixture(context, 0);
  try {
    await createAndFund(context, f);
    const request = {
      source: f.source(),
      swap: f.swap(),
      expectedAmountB: f.amount,
      recipient: f.state(address(f.recipient)),
      surplusRecipient: f.state(f.common.userBAtaB),
    };
    const session = await settleSession(f.config, f.settle, request);
    await send(context, f.config, session.preparation[0]!);
    for (const ix of session.cleanup) {
      if (context.account(ix.accounts![0]!.address))
        await send(context, f.config, new PlannedTransaction([ix]));
    }
    for (const ix of session.cleanup)
      assert.equal(context.account(ix.accounts![0]!.address), undefined);
    await execute(
      context,
      f.config,
      await settleSession(f.config, f.settle, request),
    );
  } finally {
    f.close();
  }
});
