import { address } from "@solana/kit";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { EscrowKeys, deriveSharedSeed } from "../../confidential";

test("shared keys, openings and amount ciphertexts match the Rust vectors", async () => {
  const vectors = JSON.parse(
    readFileSync("clients/test-vectors/confidential-amount-b.json", "utf8"),
  );
  const seed = await deriveSharedSeed(address(vectors.swap_pda), (message) =>
    createHmac("sha256", Buffer.from(vectors.master_key, "hex"))
      .update(message)
      .digest(),
  );
  assert.equal(Buffer.from(seed).toString("hex"), vectors.shared_seed);
  const keys = EscrowKeys.fromSeed(seed),
    pubkey = keys.elgamal.pubkey(),
    secret = keys.elgamal.secret();
  try {
    for (const [actual, expected] of [
      [pubkey.toBytes(), vectors.elgamal_public_key],
      [secret.toBytes(), vectors.elgamal_secret_key],
      [keys.ae.toBytes(), vectors.ae_key],
      [keys.openingLo.toBytes(), vectors.opening_lo],
      [keys.openingHi.toBytes(), vectors.opening_hi],
    ] as const)
      assert.equal(Buffer.from(actual).toString("hex"), expected);
    for (const vector of vectors.amounts) {
      const cipher = keys.encryptAmount(BigInt(vector.amount));
      assert.equal(
        Buffer.from(cipher.lo).toString("hex"),
        vector.ciphertext_lo,
      );
      assert.equal(
        Buffer.from(cipher.hi).toString("hex"),
        vector.ciphertext_hi,
      );
    }
  } finally {
    pubkey.free();
    secret.free();
    keys.free();
  }
});
