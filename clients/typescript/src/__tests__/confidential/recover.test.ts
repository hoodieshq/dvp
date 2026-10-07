import assert from "node:assert/strict";
import { test } from "node:test";
import { readEscrowBalance, refundSession } from "../../confidential";
import { TestContext, execute } from "./context";
import { createAndFund, fixture } from "./utils";

test("Partial Cancel followed by full Recover", async () => {
  const context = new TestContext(),
    f = await fixture(context, 1);
  try {
    await createAndFund(context, f);
    const instruction = {
      kind: "cancel" as const,
      input: { ...f.common, settlementAuthority: f.authority },
    };
    // A partial refund closes the swap while leaving escrow funds recoverable.
    await execute(
      context,
      f.config,
      await refundSession(f.config, instruction, {
        source: f.source(),
        recipient: f.state(f.common.userBAtaB),
        amount: { kind: "partial", amount: f.amount / 2n },
      }),
    );
    assert.equal(context.account(f.common.swapDvp), undefined);
    assert.equal(
      readEscrowBalance(f.state(f.common.dvpAtaB), 0n, f.keys).available,
      f.amount / 2n,
    );
    assert.equal(
      readEscrowBalance(f.state(f.common.userBAtaB), 0n, f.buyerKeys).pending,
      f.amount / 2n,
    );

    await execute(
      context,
      f.config,
      await refundSession(
        f.config,
        { kind: "recover", input: f.recover },
        {
          source: f.source(),
          recipient: f.state(f.common.userBAtaB),
          amount: { kind: "full" },
        },
      ),
    );
    assert.equal(context.account(f.common.dvpAtaB), undefined);
    assert.equal(
      readEscrowBalance(f.state(f.common.userBAtaB), 0n, f.buyerKeys).pending,
      f.amount,
    );
  } finally {
    f.close();
  }
});
