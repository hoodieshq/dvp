import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  EscrowKeyMismatchError,
  EscrowKeys,
  createSession,
  verifyConfidentialFunding,
} from "../../confidential";
import { TestContext, execute } from "./context";
import { fixture } from "./utils";

test("funding verification reports a foreign key before checking the agreed amount", async () => {
  const context = new TestContext(),
    f = await fixture(context, 1);
  const foreign = EscrowKeys.fromSeed(randomBytes(32));
  try {
    await execute(
      context,
      f.config,
      createSession(f.config, f.create, f.keys, f.amount),
    );
    await assert.rejects(
      verifyConfidentialFunding(
        context.account(f.common.swapDvp)!,
        context.account(f.common.dvpAtaB)!,
        foreign,
        f.amount,
      ),
      EscrowKeyMismatchError,
    );
    // Correct keys with a different price must still report the amount mismatch.
    await assert.rejects(
      verifyConfidentialFunding(
        context.account(f.common.swapDvp)!,
        context.account(f.common.dvpAtaB)!,
        f.keys,
        f.amount + 1n,
      ),
      { message: "Confidential amount mismatch" },
    );
  } finally {
    foreign.free();
    f.close();
  }
});
