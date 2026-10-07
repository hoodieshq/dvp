import { runSwap } from "../../../examples/confidential/swap";
import { prepareSettlement } from "../../../examples/confidential/settle";
import { getTokenDecoder } from "@solana-program/token-2022";
import { address } from "@solana/kit";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readEscrowBalance } from "../../confidential";
import { AMOUNT_LO_BITS } from "../../confidential/constants";
import { TestContext, execute } from "./context";
import { createAndFund, fixture, fundAsset, fundEscrow } from "./utils";

for (const format of [1, 0] as const) {
  test(`integrator example: Create, fund, Apply and exact Settle (v${format})`, async () => {
    // Exercise the example against the alternate deployment used for devnet.
    const programAddress = address(
      "bVntZ9Us9Wv8v2hMytmzLs4omXcZf3UwJ5xXbB3TnA6",
    );
    const context = new TestContext(programAddress);
    const f = await fixture(context, format, { programAddress });
    try {
      await runSwap(
        context.rpc,
        f.config,
        { create: f.create, apply: f.apply, settle: f.settle },
        f.keys,
        f.amount,
        {
          send: async (session) => {
            await execute(context, f.config, session);
          },
          fund: async (request) => {
            // The example verifies the newly created escrow before asking wallets to fund.
            assert.equal(request.escrowA, f.common.dvpAtaA);
            assert.equal(request.escrowB, f.common.dvpAtaB);
            assert.equal(request.amountA, f.create.amountA);
            assert.equal(request.amountB, f.amount);
            assert.deepEqual(request.recipient, f.state(request.escrowB));
            await fundAsset(context, f);
            await fundEscrow(context, f, request.amountB);
          },
        },
      );

      // Both legs arrived and both escrows closed; no B surplus went back to the buyer.
      assert.equal(context.account(f.common.swapDvp), undefined);
      assert.equal(context.account(f.common.dvpAtaA), undefined);
      assert.equal(context.account(f.common.dvpAtaB), undefined);
      assert.equal(
        getTokenDecoder().decode(
          context.account(address(f.assetRecipient))!.data,
        ).amount,
        f.create.amountA,
      );
      assert.equal(
        readEscrowBalance(f.state(f.recipient), 0n, f.recipientKeys).pending,
        f.amount,
      );
      assert.equal(
        readEscrowBalance(f.state(f.common.userBAtaB), 0n, f.buyerKeys).pending,
        0n,
      );
    } finally {
      f.close();
    }
  });

  test(`Settle with surplus and an auditor (v${format})`, async () => {
    const context = new TestContext(),
      f = await fixture(context, format, {
        // Nonzero low and high limbs exercise both amount-binding proofs.
        amountB: (1n << AMOUNT_LO_BITS) + 1n,
        auditor: true,
      });
    // Exercise fee-aware proof packing, including SPL Record writes in v0.
    f.config = { ...f.config, computeUnitPrice: 3n };
    const surplus = (1n << AMOUNT_LO_BITS) + 1n;
    try {
      await createAndFund(context, f, f.amount + surplus);

      await execute(
        context,
        f.config,
        await prepareSettlement(
          context.rpc,
          f.config,
          f.settle,
          f.keys,
          f.amount,
        ),
      );
      assert.equal(context.account(f.common.swapDvp), undefined);
      assert.equal(
        readEscrowBalance(f.state(address(f.recipient)), 0n, f.recipientKeys)
          .pending,
        f.amount,
      );
      assert.equal(
        readEscrowBalance(f.state(f.common.userBAtaB), 0n, f.buyerKeys).pending,
        surplus,
      );
      assert.equal(
        getTokenDecoder().decode(
          context.account(address(f.assetRecipient))!.data,
        ).amount,
        f.create.amountA,
      );
    } finally {
      f.close();
    }
  });
}
