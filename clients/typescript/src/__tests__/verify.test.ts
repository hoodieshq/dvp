/**
 * Checked decode helpers must reject accounts that are not owned
 * by the DvP program or don't match the exact on-chain layout, and the
 * derivation helpers must let funders compute canonical addresses instead
 * of trusting attacker-supplied ones.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  getAddressDecoder,
  generateKeyPairSigner,
  type GetProgramAccountsApi,
  type Rpc,
  type Address,
  type MaybeEncodedAccount,
} from "@solana/kit";
import { DVP_SWAP_PROGRAM_PROGRAM_ADDRESS } from "../generated/programs/dvpSwapProgram";
import { getSwapDvpEncoder } from "../generated/accounts/swapDvp";
import {
  CONFIDENTIAL_SWAP_DVP_ACCOUNT_SIZE,
  decodeSwapDvpChecked,
  fetchSwapDvpAccounts,
  findSwapDvpEscrowAta,
  findSwapDvpPda,
  SWAP_DVP_ACCOUNT_SIZE,
} from "../verify";
import { PlannedTransaction, createSession } from "../confidential";
import { TestContext, execute, send } from "./confidential/context";
import { fixture } from "./confidential/utils";

const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address;
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;

/** Dummy pubkey made of a single byte repeated 32 times. */
const addressOf = (fill: number) =>
  getAddressDecoder().decode(new Uint8Array(32).fill(fill));

const validData = () =>
  new Uint8Array(
    getSwapDvpEncoder().encode({
      bump: 254,
      userA: addressOf(1),
      userB: addressOf(2),
      mintA: addressOf(3),
      mintB: addressOf(4),
      settlementAuthority: addressOf(5),
      tokenProgramA: addressOf(6),
      tokenProgramB: addressOf(7),
      amountA: 1_000n,
      amountB: 2_500n,
      expiryTimestamp: 1_780_000_000n,
      nonce: 42n,
      refString: Array.from(new Uint8Array(64)),
      userASettlementDestination: addressOf(1),
      userBSettlementDestination: addressOf(2),
      mintAAuthority: addressOf(3),
      mintBAuthority: addressOf(4),
      earliestSettlementTimestamp: null,
    }),
  );

function encodedAccount(overrides: {
  programAddress?: Address;
  data?: Uint8Array;
  exists?: boolean;
}): MaybeEncodedAccount {
  return {
    address: addressOf(11),
    exists: overrides.exists ?? true,
    programAddress:
      overrides.programAddress ?? DVP_SWAP_PROGRAM_PROGRAM_ADDRESS,
    data: overrides.data ?? validData(),
    executable: false,
    lamports: 1_000_000n,
    space: BigInt((overrides.data ?? validData()).length),
  } as MaybeEncodedAccount;
}

describe("decodeSwapDvpChecked", () => {
  it("accepts a program-owned, exact-size account", () => {
    const decoded = decodeSwapDvpChecked(encodedAccount({}));
    assert.equal(decoded.data.amountA, 1_000n);
    assert.deepEqual(decoded.data.earliestSettlementTimestamp, {
      __option: "None",
    });
  });

  it("rejects a System-owned account even with perfect data", () => {
    assert.throws(
      () =>
        decodeSwapDvpChecked(
          encodedAccount({ programAddress: SYSTEM_PROGRAM }),
        ),
      /owned/i,
    );
  });

  it("rejects a wrong-size account", () => {
    assert.throws(
      () =>
        decodeSwapDvpChecked(
          encodedAccount({ data: validData().slice(0, 450) }),
        ),
      /458|size|length/i,
    );
  });

  it("rejects a missing account", () => {
    assert.throws(() =>
      decodeSwapDvpChecked(encodedAccount({ exists: false })),
    );
  });

  it("exposes the on-chain account size", () => {
    assert.equal(SWAP_DVP_ACCOUNT_SIZE, 458);
  });
});

describe("canonical derivation helpers (verify-before-fund)", () => {
  // Expected address computed independently of this library with the
  // Solana CLI, mirroring the on-chain seed order
  // [b"dvp", settlement_authority, user_a, user_b, mint_a, mint_b, nonce_le]:
  //
  //   solana find-program-derived-address dvp34bdbcEm4f4FCUjGV4mDAkDshaQR4LkK8fdcsyZq \
  //     string:dvp \
  //     hex:0505050505050505050505050505050505050505050505050505050505050505 \  (settlement_authority = addressOf(5))
  //     hex:0101010101010101010101010101010101010101010101010101010101010101 \  (user_a = addressOf(1))
  //     hex:0202020202020202020202020202020202020202020202020202020202020202 \  (user_b = addressOf(2))
  //     hex:0303030303030303030303030303030303030303030303030303030303030303 \  (mint_a = addressOf(3))
  //     hex:0404040404040404040404040404040404040404040404040404040404040404 \  (mint_b = addressOf(4))
  //     u64le:42                                                                 (nonce)
  //
  //   => 6KvFpfqQsn9n6i4TUYimENwimXvns9yq9k7L9V5VxESz
  it("derives the canonical SwapDvp PDA from agreed terms", async () => {
    const [address] = await findSwapDvpPda({
      settlementAuthority: addressOf(5),
      userA: addressOf(1),
      userB: addressOf(2),
      mintA: addressOf(3),
      mintB: addressOf(4),
      nonce: 42n,
    });
    assert.equal(address, "6KvFpfqQsn9n6i4TUYimENwimXvns9yq9k7L9V5VxESz");
  });

  // Escrow ATAs are canonical Associated Token Accounts of the SwapDvp PDA,
  // i.e. seeds [swap_dvp, token_program, mint] under the ATA program.
  // Expected address computed with the Solana CLI:
  //
  //   solana find-program-derived-address ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL \
  //     pubkey:6uMoF2mAhQD9QTz3CmyvhwKzEumEgodECwTf44GoL9Ki \
  //     pubkey:TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA \
  //     hex:0303030303030303030303030303030303030303030303030303030303030303   (mint_a = addressOf(3))
  //
  //   => GBrJyDbxFv8EQ14ww1546RimNv256wEJwVv3LpBDDbEZ
  it("derives the canonical escrow ATA for a leg", async () => {
    const [ata] = await findSwapDvpEscrowAta({
      swapDvp: "6uMoF2mAhQD9QTz3CmyvhwKzEumEgodECwTf44GoL9Ki" as Address,
      mint: addressOf(3),
      tokenProgram: TOKEN_PROGRAM,
    });
    assert.equal(ata, "GBrJyDbxFv8EQ14ww1546RimNv256wEJwVv3LpBDDbEZ");
  });
});

// The nonce is a PDA seed the on-chain program treats as a full-width
// u64. A JavaScript number above 2^53 has already rounded before it can
// be encoded, so distinct nonces would derive the same PDA. The helper
// must require a bigint and reject number outright.
describe("findSwapDvpPda nonce is a lossless u64", () => {
  const baseArgs = {
    settlementAuthority: addressOf(5),
    userA: addressOf(1),
    userB: addressOf(2),
    mintA: addressOf(3),
    mintB: addressOf(4),
  };

  it("rejects an unsafe number nonce instead of rounding it", () => {
    // 2**53 + 1 is not representable as a number; it silently becomes
    // 2**53. The guard must throw rather than derive a rounded PDA.
    assert.throws(
      () =>
        findSwapDvpPda({
          ...baseArgs,
          nonce: (2 ** 53 + 1) as unknown as bigint,
        }),
      /bigint/i,
    );
  });

  it("rejects a plain number even when small and safe", () => {
    assert.throws(
      () => findSwapDvpPda({ ...baseArgs, nonce: 42 as unknown as bigint }),
      /bigint/i,
    );
  });

  it("derives distinct PDAs for distinct large bigint nonces", async () => {
    const [a] = await findSwapDvpPda({ ...baseArgs, nonce: 2n ** 53n + 1n });
    const [b] = await findSwapDvpPda({ ...baseArgs, nonce: 2n ** 53n + 2n });
    assert.notEqual(a, b);
  });
});

describe("fetchSwapDvpAccounts", () => {
  it("discovery skips uninitialized program-owned accounts in both layouts", async () => {
    const context = new TestContext(),
      f = await fixture(context, 1);
    try {
      await execute(
        context,
        f.config,
        createSession(f.config, f.create, f.keys, f.amount),
      );
      const addresses = [f.common.swapDvp];
      // Anyone can assign the DvP owner through System CreateAccount, without invoking DvP.
      for (const space of [
        SWAP_DVP_ACCOUNT_SIZE,
        CONFIDENTIAL_SWAP_DVP_ACCOUNT_SIZE,
      ]) {
        const newAccount = await generateKeyPairSigner();
        await send(
          context,
          f.config,
          new PlannedTransaction([
            getCreateAccountInstruction({
              payer: f.payer,
              newAccount,
              space,
              lamports: context.minimumBalanceForRentExemption(BigInt(space)),
              programAddress: DVP_SWAP_PROGRAM_PROGRAM_ADDRESS,
            }),
          ]),
        );
        addresses.push(newAccount.address);
      }
      // Adapt only the RPC listing; every account above was created by a real transaction.
      const rpc = {
        getProgramAccounts: (
          owner: string,
          { filters }: { filters: { dataSize: bigint }[] },
        ) => ({
          send: async () =>
            addresses.flatMap((key) => {
              const raw = context.account(key)!;
              if (
                raw.programAddress !== owner ||
                raw.space !== filters![0]!.dataSize
              )
                return [];
              return [
                {
                  pubkey: key,
                  account: {
                    owner: raw.programAddress,
                    data: [Buffer.from(raw.data).toString("base64"), "base64"],
                    executable: raw.executable,
                    lamports: raw.lamports,
                    space: raw.space,
                  },
                },
              ];
            }),
        }),
      } as unknown as Rpc<GetProgramAccountsApi>;
      const swaps = await fetchSwapDvpAccounts(rpc);
      assert.deepEqual(
        swaps.map((swap) => swap.address),
        [f.common.swapDvp],
      );
    } finally {
      f.close();
    }
  });

  it("discovery propagates RPC failures instead of returning an empty list", async () => {
    const unavailable = new Error("RPC unavailable");
    const rpc = {
      getProgramAccounts: () => ({
        send: async () => {
          throw unavailable;
        },
      }),
    } as unknown as Rpc<GetProgramAccountsApi>;
    await assert.rejects(
      fetchSwapDvpAccounts(rpc),
      (error) => error === unavailable,
    );
  });
});
