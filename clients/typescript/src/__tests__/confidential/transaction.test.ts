import assert from "node:assert/strict";
import { test } from "node:test";
import {
  address,
  blockhash,
  generateKeyPairSigner,
  getTransactionMessageComputeUnitPrice,
  getTransactionMessagePriorityFeeLamports,
  getTransactionMessageSizeLimit,
} from "@solana/kit";
import { PlannedTransaction, type SessionConfig } from "../../confidential";
import { U64_MAX } from "../../confidential/constants";

const lifetime = {
  blockhash: blockhash("11111111111111111111111111111111"),
  lastValidBlockHeight: 0n,
};

for (const format of [1, 0] as const) {
  test(`priority fees use the correct units and count toward the size limit (v${format})`, async () => {
    const config: SessionConfig = {
      payer: await generateKeyPairSigner(),
      format,
      minimumBalanceForRentExemption: () => 0n,
      // A non-round product checks that v1 rounds up, rather than truncating.
      computeUnitLimit: 400_001,
    };
    const plan = new PlannedTransaction([]);
    for (const [price, fee] of [
      [undefined, undefined],
      [0n, 0n],
      [3n, 2n],
    ] as const) {
      const message = plan.message(
        { ...config, computeUnitPrice: price },
        lifetime,
      );
      if (message.version === 0)
        assert.equal(getTransactionMessageComputeUnitPrice(message), price);
      else assert.equal(getTransactionMessagePriorityFeeLamports(message), fee);
    }

    // A message fitting exactly without the fee must be rejected once the fee is added.
    const memo = (size: number) =>
      new PlannedTransaction([
        {
          programAddress: address(
            "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
          ),
          data: new Uint8Array(size),
        },
      ]);
    const limit = getTransactionMessageSizeLimit(
      plan.message(config, lifetime),
    );
    // Keep the same instruction-length encoding width as the final payload.
    const sampleSize = 256;
    const overhead = memo(sampleSize).wireSize(config) - sampleSize;
    const full = memo(limit - overhead);
    assert.equal(full.wireSize(config), limit);
    full.checkSize(config);
    const withFee = { ...config, computeUnitPrice: 3n };
    assert.throws(() => full.checkSize(withFee), {
      message: `Transaction too large: ${full.wireSize(withFee)} > ${limit}`,
    });
    for (const price of [-1n, U64_MAX + 1n]) {
      assert.throws(
        () => plan.message({ ...config, computeUnitPrice: price }, lifetime),
        { message: "Compute unit price must be in 0..2^64-1" },
      );
    }
  });
}
