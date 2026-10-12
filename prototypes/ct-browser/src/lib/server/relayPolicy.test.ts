/**
 * Relay policy checks over real kit-compiled v1 transactions (no network).
 * Run from the repo root:
 *   node --import tsx --test prototypes/ct-browser/src/lib/server/relayPolicy.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  address,
  appendTransactionMessageInstructions,
  blockhash,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageComputeUnitLimit,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessagePriorityFeeLamports,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type TransactionSigner,
} from "@solana/kit";
import {
  getCreateAccountInstruction,
  getTransferSolInstruction,
} from "@solana-program/system";
import {
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import {
  ExtensionType,
  getApplyConfidentialPendingBalanceInstruction,
  getConfidentialDepositInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
  getMintToInstruction,
  getReallocateInstruction,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";
import {
  CIPHERTEXT_COMMITMENT_EQUALITY_CONTEXT_ACCOUNT_SIZE,
  getCloseContextStateInstruction,
  getVerifyProofInstruction,
  PUBKEY_VALIDITY_CONTEXT_ACCOUNT_SIZE,
  ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS,
} from "@solana-program/zk-elgamal-proof";
import * as dvpClientNs from "../../../../../clients/typescript/src/generated";
import {
  assertRelayable,
  decodeRelayTransaction,
  defaultRentExemptMinimum,
  DEFAULT_CONTEXT_SIZES,
  DEVNET_DVP_PROGRAM_ADDRESS,
  RelayPolicyError,
  type RelayPolicyConfig,
} from "./relayPolicy";

// Outside a package with "type": "module" the client sources load as CommonJS
// under node + tsx, so their exports sit on `default` (Vite sees plain ESM).
const dvpClient =
  (dvpClientNs as unknown as { default?: typeof dvpClientNs }).default ??
  dvpClientNs;
const { getApplyConfidentialDvpInstruction, getCreateConfidentialDvpInstruction } =
  dvpClient;

const INSTRUCTIONS_SYSVAR = address(
  "Sysvar1nstructions1111111111111111111111111",
);
const MEMO_PROGRAM = address("MemoSq4gqABAXKb96qnH8TuHksFZXH7MszjohsePesP");
const COMMITMENT_EQUALITY = 3; // ZK Verify discriminator
const SPACE = CIPHERTEXT_COMMITMENT_EQUALITY_CONTEXT_ACCOUNT_SIZE; // 161

type Fixture = {
  treasury: TransactionSigner;
  config: RelayPolicyConfig;
  role: KeyPairSigner;
  other: KeyPairSigner;
  attacker: Address;
  mint: Address;
  token: Address;
  token2: Address;
};

async function fixture(): Promise<Fixture> {
  const treasuryKey = await generateKeyPairSigner();
  // The client never holds the treasury key: it uses a no-op signer.
  const treasury = createNoopSigner(treasuryKey.address);
  // Mimic the server: rent precomputed per allowed size.
  const rent = new Map(
    DEFAULT_CONTEXT_SIZES.map((s) => [s, defaultRentExemptMinimum(s)]),
  );
  const [role, other, attacker, mint, token, token2] = await Promise.all(
    Array.from({ length: 6 }, () => generateKeyPairSigner()),
  );
  return {
    treasury,
    config: {
      treasury: treasury.address,
      dvpProgram: DEVNET_DVP_PROGRAM_ADDRESS,
      contextSizes: DEFAULT_CONTEXT_SIZES,
      rentExemptLamports: (space) => rent.get(space),
    },
    role: role!,
    other: other!,
    attacker: attacker!.address,
    mint: mint!.address,
    token: token!.address,
    token2: token2!.address,
  };
}

const LIFETIME = {
  blockhash: blockhash("11111111111111111111111111111111"),
  lastValidBlockHeight: 0n,
};

/** Build, partially sign and encode a transaction the way the browser does. */
async function wire(
  feePayer: TransactionSigner,
  instructions: Instruction[],
  version: 1 | 0 | "legacy" = 1,
  priorityFee?: bigint,
): Promise<string> {
  if (version === 1) {
    const message = pipe(
      createTransactionMessage({ version: 1 }),
      (m) => setTransactionMessageFeePayerSigner(feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(LIFETIME, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
      // v1 budgets zero CUs unless the config sets a limit, as the DvP client does.
      (m) => setTransactionMessageComputeUnitLimit(400_000, m),
      (m) =>
        priorityFee === undefined
          ? m
          : setTransactionMessagePriorityFeeLamports(priorityFee, m),
    );
    return getBase64EncodedWireTransaction(
      await partiallySignTransactionMessageWithSigners(message),
    );
  }
  const message = pipe(
    createTransactionMessage({ version }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(LIFETIME, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  return getBase64EncodedWireTransaction(
    await partiallySignTransactionMessageWithSigners(message),
  );
}

async function check(
  f: Fixture,
  instructions: Instruction[],
  opts: { feePayer?: TransactionSigner; version?: 1 | 0 | "legacy"; priorityFee?: bigint } = {},
): Promise<void> {
  const base64 = await wire(
    opts.feePayer ?? f.treasury,
    instructions,
    opts.version ?? 1,
    opts.priorityFee,
  );
  const { transaction } = decodeRelayTransaction(base64);
  assertRelayable(transaction, f.config);
}

async function refused(
  f: Fixture,
  instructions: Instruction[],
  reason: RegExp,
  opts?: Parameters<typeof check>[2],
): Promise<void> {
  await assert.rejects(check(f, instructions, opts), (e: unknown) => {
    assert.ok(e instanceof RelayPolicyError, `unexpected error: ${String(e)}`);
    assert.match(e.message, reason);
    return true;
  });
}

async function proofPair(
  f: Fixture,
  over: { lamports?: bigint; space?: number; owner?: Address; authority?: Address } = {},
): Promise<Instruction[]> {
  const context = await generateKeyPairSigner();
  const space = over.space ?? SPACE;
  return [
    getCreateAccountInstruction({
      payer: f.treasury,
      newAccount: context,
      lamports: over.lamports ?? defaultRentExemptMinimum(space),
      space,
      programAddress: over.owner ?? ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS,
    }),
    getVerifyProofInstruction({
      discriminator: COMMITMENT_EQUALITY,
      contextState: context.address,
      contextStateAuthority: over.authority ?? f.role.address,
      proofData: new Uint8Array(192),
    }),
  ];
}

function createConfidentialDvp(
  f: Fixture,
  over: { payer?: TransactionSigner; settlementAuthority?: Address } = {},
): Instruction {
  return getCreateConfidentialDvpInstruction(
    {
      payer: over.payer ?? f.treasury,
      swapDvp: f.token,
      nonceTombstone: f.token2,
      settlementAuthority: over.settlementAuthority ?? f.role.address,
      userA: f.role.address,
      userB: f.other.address,
      mintA: f.mint,
      mintB: f.mint,
      dvpAtaA: f.attacker,
      dvpAtaB: f.attacker,
      tokenProgramA: TOKEN_PROGRAM_ADDRESS,
      tokenProgramB: TOKEN_2022_PROGRAM_ADDRESS,
      instructionsSysvar: INSTRUCTIONS_SYSVAR,
      amountA: 1n,
      expiryTimestamp: 2_000_000_000n,
      nonce: 1n,
      amountBCiphertextLo: Array(64).fill(0),
      amountBCiphertextHi: Array(64).fill(0),
      decryptableZeroBalance: Array(36).fill(0),
      pubkeyValidityProofOffset: -1,
      refString: null,
      userASettlementDestination: null,
      userBSettlementDestination: null,
      earliestSettlementTimestamp: null,
    },
    { programAddress: DEVNET_DVP_PROGRAM_ADDRESS },
  );
}

// ---------------------------------------------------------------- negative

test("refuses System transfer from the treasury", async () => {
  const f = await fixture();
  await refused(
    f,
    [getTransferSolInstruction({ source: f.treasury, destination: f.attacker, amount: 1_000_000n })],
    /only System CreateAccount/,
  );
});

test("refuses over-funded CreateAccount", async () => {
  const f = await fixture();
  await refused(
    f,
    await proofPair(f, { lamports: defaultRentExemptMinimum(SPACE) + 1n }),
    /lamports .* rent-exempt minimum/,
  );
});

test("refuses under-funded CreateAccount", async () => {
  const f = await fixture();
  await refused(
    f,
    await proofPair(f, { lamports: defaultRentExemptMinimum(SPACE) - 1n }),
    /lamports .* rent-exempt minimum/,
  );
});

test("refuses CreateAccount with a wrong owner", async () => {
  const f = await fixture();
  await refused(f, await proofPair(f, { owner: TOKEN_2022_PROGRAM_ADDRESS }), /owner .* not the ZK ElGamal/);
});

test("refuses CreateAccount with a non-allowlisted space", async () => {
  const f = await fixture();
  await refused(f, await proofPair(f, { space: 10_000 }), /space 10000 is not an allowed/);
  // PubkeyValidity is verified inline only, so its context size is not allowed either.
  await refused(f, await proofPair(f, { space: PUBKEY_VALIDITY_CONTEXT_ACCOUNT_SIZE }), /not an allowed/);
});

test("refuses CreateAccount funded by someone other than the treasury", async () => {
  const f = await fixture();
  const context = await generateKeyPairSigner();
  await refused(
    f,
    [
      getCreateAccountInstruction({
        payer: f.role,
        newAccount: context,
        lamports: defaultRentExemptMinimum(SPACE),
        space: SPACE,
        programAddress: ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS,
      }),
    ],
    /funded by the treasury/,
  );
});

test("refuses Token-2022 MintTo signed by the treasury", async () => {
  const f = await fixture();
  await refused(
    f,
    [getMintToInstruction({ mint: f.mint, token: f.token, mintAuthority: f.treasury, amount: 1n })],
    /treasury account inside a Token-2022 instruction/,
  );
});

test("refuses treasury as authority in CT Deposit and ApplyPendingBalance", async () => {
  const f = await fixture();
  await refused(
    f,
    [getConfidentialDepositInstruction({ token: f.token, mint: f.mint, authority: f.treasury, amount: 1n, decimals: 6 })],
    /treasury account inside a Token-2022 instruction/,
  );
  await refused(
    f,
    [
      getApplyConfidentialPendingBalanceInstruction({
        token: f.token,
        authority: f.treasury,
        expectedPendingBalanceCreditCounter: 1n,
        newDecryptableAvailableBalance: new Uint8Array(36),
      }),
    ],
    /treasury account inside a Token-2022 instruction/,
  );
});

test("refuses classic Token TransferChecked with the treasury as authority", async () => {
  const f = await fixture();
  await refused(
    f,
    [
      getTransferCheckedInstruction({
        source: f.token,
        mint: f.mint,
        destination: f.token2,
        authority: f.treasury,
        amount: 1n,
        decimals: 6,
      }),
    ],
    /treasury account inside a token instruction/,
  );
});

test("refuses Reallocate with the treasury outside the payer slot or a foreign extension", async () => {
  const f = await fixture();
  await refused(
    f,
    [
      getReallocateInstruction({
        token: f.token,
        payer: f.treasury,
        owner: f.treasury,
        newExtensionTypes: [ExtensionType.ConfidentialTransferAccount],
      }),
    ],
    /Reallocate other than as payer \(position 3\)/,
  );
  await refused(
    f,
    [
      getReallocateInstruction({
        token: f.token,
        payer: f.treasury,
        owner: f.role,
        newExtensionTypes: [ExtensionType.ConfidentialTransferAccount, ExtensionType.TokenMetadata],
      }),
    ],
    /Reallocate extension 19 is not allowed/,
  );
});

test("refuses an unknown program", async () => {
  const f = await fixture();
  await refused(
    f,
    [{ programAddress: MEMO_PROGRAM, data: new TextEncoder().encode("hi") }],
    /program MemoSq4.* is not allowed/,
  );
});

test("refuses the ATA program (ATAs are created server-side)", async () => {
  const f = await fixture();
  await refused(
    f,
    [
      getCreateAssociatedTokenIdempotentInstruction({
        payer: f.treasury,
        ata: f.token,
        owner: f.role.address,
        mint: f.mint,
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      }),
    ],
    /program ATokenGP.* is not allowed/,
  );
});

test("refuses a fee payer other than the treasury", async () => {
  const f = await fixture();
  await refused(
    f,
    [getTransferCheckedInstruction({ source: f.token, mint: f.mint, destination: f.token2, authority: f.role, amount: 1n, decimals: 6 })],
    /treasury is not the fee payer/,
    { feePayer: f.role },
  );
});

test("refuses legacy and v0 messages", async () => {
  const f = await fixture();
  const ix = getTransferCheckedInstruction({ source: f.token, mint: f.mint, destination: f.token2, authority: f.role, amount: 1n, decimals: 6 });
  await refused(f, [ix], /only v1 .* \(got legacy\)/, { version: "legacy" });
  await refused(f, [ix], /only v1 .* \(got v0\)/, { version: 0 });
});

test("refuses a priority fee above the cap", async () => {
  const f = await fixture();
  const ix = getTransferCheckedInstruction({ source: f.token, mint: f.mint, destination: f.token2, authority: f.role, amount: 1n, decimals: 6 });
  await refused(f, [ix], /priority fee 5000 exceeds 0/, { priorityFee: 5000n });
});

test("refuses CloseContextState with treasury authority and a foreign destination", async () => {
  const f = await fixture();
  const context = await generateKeyPairSigner();
  await refused(
    f,
    [getCloseContextStateInstruction({ contextState: context.address, destination: f.attacker, authority: f.treasury })],
    /treasury authority must pay out to the treasury/,
  );
});

test("refuses the treasury as the context account of a ZK verify", async () => {
  const f = await fixture();
  await refused(
    f,
    [
      getVerifyProofInstruction({
        discriminator: COMMITMENT_EQUALITY,
        contextState: f.treasury.address,
        contextStateAuthority: f.role.address,
        proofData: new Uint8Array(192),
      }),
    ],
    /ZK proof verify instruction other than as context-state authority \(position 0\)/,
  );
});

test("refuses the treasury in a DvP instruction other than CreateConfidentialDvp payer", async () => {
  const f = await fixture();
  await refused(
    f,
    [createConfidentialDvp(f, { settlementAuthority: f.treasury.address })],
    /DvP instruction other than as CreateConfidentialDvp payer \(position 3\)/,
  );
  await refused(
    f,
    [
      getApplyConfidentialDvpInstruction(
        {
          signer: f.treasury,
          swapDvp: f.token,
          nonceTombstone: f.attacker,
          dvpAtaB: f.token2,
          tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
          expectedPendingBalanceCreditCounter: 1n,
          newDecryptableAvailableBalance: Array(36).fill(0),
          settlementAuthority: f.role.address,
          userA: f.role.address,
          userB: f.other.address,
          mintA: f.mint,
          mintB: f.mint,
          nonce: 1n,
        },
        { programAddress: DEVNET_DVP_PROGRAM_ADDRESS },
      ),
    ],
    /DvP instruction other than as CreateConfidentialDvp payer/,
  );
});

test("refuses a DvP instruction for the default (non-devnet) program address", async () => {
  const f = await fixture();
  const ix = { ...createConfidentialDvp(f), programAddress: address("dvp34bdbcEm4f4FCUjGV4mDAkDshaQR4LkK8fdcsyZq") };
  await refused(f, [ix], /program dvp34.* is not allowed/);
});

// ---------------------------------------------------------------- positive

test("allows CreateAccount with exact rent + ZK verify (role authority)", async () => {
  const f = await fixture();
  await check(f, await proofPair(f));
});

test("allows every default context size with exact rent", async () => {
  const f = await fixture();
  for (const space of DEFAULT_CONTEXT_SIZES) await check(f, await proofPair(f, { space }));
});

test("allows treasury as context-state authority (Token-2022 CT helper plans)", async () => {
  const f = await fixture();
  await check(f, await proofPair(f, { authority: f.treasury.address }));
});

test("allows CloseContextState with treasury authority and treasury destination", async () => {
  const f = await fixture();
  const context = await generateKeyPairSigner();
  await check(f, [
    getCloseContextStateInstruction({ contextState: context.address, destination: f.treasury.address, authority: f.treasury }),
  ]);
});

test("allows CloseContextState by a role wallet to itself", async () => {
  const f = await fixture();
  const context = await generateKeyPairSigner();
  await check(f, [
    getCloseContextStateInstruction({ contextState: context.address, destination: f.role.address, authority: f.role }),
  ]);
});

test("allows Token-2022 Reallocate with the treasury as payer", async () => {
  const f = await fixture();
  await check(f, [
    getReallocateInstruction({
      token: f.token,
      payer: f.treasury,
      owner: f.role,
      newExtensionTypes: [ExtensionType.ConfidentialTransferAccount],
    }),
  ]);
});

test("allows plain TransferChecked by a role wallet", async () => {
  const f = await fixture();
  await check(f, [
    getTransferCheckedInstruction({ source: f.token, mint: f.mint, destination: f.token2, authority: f.role, amount: 25n, decimals: 6 }),
  ]);
});

test("allows CT Deposit + ApplyPendingBalance by a role wallet", async () => {
  const f = await fixture();
  await check(f, [
    getConfidentialDepositInstruction({ token: f.token, mint: f.mint, authority: f.role, amount: 1n, decimals: 6 }),
    getApplyConfidentialPendingBalanceInstruction({
      token: f.token,
      authority: f.role,
      expectedPendingBalanceCreditCounter: 1n,
      newDecryptableAvailableBalance: new Uint8Array(36),
    }),
  ]);
});

test("allows CreateConfidentialDvp (generated client) with the treasury as payer + inline pubkey proof", async () => {
  const f = await fixture();
  await check(f, [
    getVerifyProofInstruction({ discriminator: 4, proofData: new Uint8Array(64) }),
    createConfidentialDvp(f),
  ]);
});

test("decodeRelayTransaction returns the message and the signatures map", async () => {
  const f = await fixture();
  const base64 = await wire(f.treasury, [
    getTransferCheckedInstruction({ source: f.token, mint: f.mint, destination: f.token2, authority: f.role, amount: 1n, decimals: 6 }),
  ]);
  const { message, signatures } = decodeRelayTransaction(base64);
  assert.equal(message.version, 1);
  assert.deepEqual(Object.keys(signatures), [f.treasury.address, f.role.address]);
  assert.equal(signatures[f.treasury.address], null); // no-op signer
  assert.ok(signatures[f.role.address] instanceof Uint8Array);
  assert.throws(() => decodeRelayTransaction("A".repeat(9000)), RelayPolicyError);
});
