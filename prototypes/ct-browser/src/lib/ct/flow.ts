/**
 * Browser-only CT DvP cycle. Imported dynamically by the page so the zk-sdk WASM
 * never loads during SSR. Every user transaction goes through /api/relay with
 * the treasury as fee payer (a no-op signer here; the relay adds its signature).
 */
import {
	assertIsSingleInstructionPlan,
	createKeyPairSignerFromPrivateKeyBytes,
	createNoopSigner,
	createSolanaRpc,
	createTransactionMessage,
	createTransactionPlanner,
	fetchEncodedAccount,
	fetchEncodedAccounts,
	flattenInstructionPlan,
	flattenTransactionPlan,
	getBase64EncodedWireTransaction,
	getTransactionEncoder,
	partiallySignTransactionMessageWithSigners,
	pipe,
	setTransactionMessageComputeUnitLimit,
	setTransactionMessageFeePayerSigner,
	setTransactionMessageLifetimeUsingBlockhash,
	setTransactionMessageLoadedAccountsDataSizeLimit,
	address,
	type Address,
	type Instruction,
	type InstructionPlan,
	type KeyPairSigner
} from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS, getTransferCheckedInstruction } from '@solana-program/token';
import {
	ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
	TOKEN_2022_PROGRAM_ADDRESS,
	fetchToken,
	findAssociatedTokenPda,
	getConfidentialDepositInstruction,
	getTokenDecoder
} from '@solana-program/token-2022';
import {
	decryptConfidentialTransferBalance,
	deriveConfidentialKeys,
	getApplyConfidentialPendingBalanceInstructionFromToken,
	getConfidentialTransferInstructionPlan,
	getCreateConfidentialTransferAccountInstructionPlan
} from '@solana-program/token-2022/confidential';
import { ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS } from '@solana-program/zk-elgamal-proof';
import { AeKey, ElGamalKeypair, ElGamalSecretKey } from '@solana/zk-sdk';
import { findNonceTombstonePda, findSwapDvpEscrowAta, findSwapDvpPda } from '$dvp';
import {
	EscrowKeys,
	PlannedTransaction,
	applySession,
	confidentialState,
	createSession,
	mintAuditor,
	readEscrowAccount,
	settleSession,
	verifyConfidentialFunding,
	type SessionConfig,
	type TransactionSession
} from '$dvp/confidential';
import { AMOUNT_A, AMOUNT_B, DECIMALS, PROGRAM_ID, START_B } from '$lib/config';
import { fromHex, save, type StepLog, type Stored } from './state';

const MEMO = address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const INSTRUCTIONS_SYSVAR = address('Sysvar1nstructions1111111111111111111111111');
// Token-2022 plans: v1 stores the CU limit in the message, not as an instruction.
const T22_PLAN_CU_LIMIT = 1_400_000;

type WalletKeys = { elgamal: ElGamalKeypair; ae: AeKey };

export type Ctx = Awaited<ReturnType<typeof context>>;

/** Build signers, keys and derived addresses from stored state. */
export async function context(stored: Stored) {
	const rpc = createSolanaRpc(`${location.origin}/api/rpc`);
	const { treasury: treasuryAddress } = (await (await fetch('/api/config')).json()) as {
		treasury: Address;
	};
	// One no-op signer instance everywhere: kit refuses two signer objects for one address.
	const treasury = createNoopSigner(treasuryAddress);
	const signer = (hex: string) => createKeyPairSignerFromPrivateKeyBytes(fromHex(hex));
	const authority = await signer(stored.roles.authority);
	const partyA = await signer(stored.roles.partyA);
	const partyB = await signer(stored.roles.partyB);
	const config: SessionConfig = {
		payer: treasury,
		format: 1,
		programAddress: PROGRAM_ID,
		minimumBalanceForRentExemption: (space) =>
			rpc.getMinimumBalanceForRentExemption(BigInt(space)).send()
	};
	return { rpc, stored, treasury, authority, partyA, partyB, config };
}

/** Standard wallet-level CT keys, derived from the role's Ed25519 signature. */
async function walletKeys(signer: KeyPairSigner): Promise<WalletKeys> {
	const derived = await deriveConfidentialKeys({ signer });
	const secret = ElGamalSecretKey.fromBytes(derived.elgamalKeypair.secretKey);
	try {
		return { elgamal: ElGamalKeypair.fromSecretKey(secret), ae: AeKey.fromBytes(derived.aeKey) };
	} finally {
		secret.free();
	}
}

async function addresses(ctx: Ctx) {
	const { stored } = ctx;
	if (!stored.mintA || !stored.mintB) throw new Error('Run setup first');
	const mintA = address(stored.mintA);
	const mintB = address(stored.mintB);
	const ata = async (owner: Address, mint: Address, tokenProgram: Address) =>
		(await findAssociatedTokenPda({ owner, mint, tokenProgram }))[0];
	const seedTerms = {
		settlementAuthority: ctx.authority.address,
		userA: ctx.partyA.address,
		userB: ctx.partyB.address,
		mintA,
		mintB,
		nonce: BigInt(stored.nonce)
	};
	const [swapDvp] = await findSwapDvpPda({ ...seedTerms, programAddress: PROGRAM_ID });
	const [nonceTombstone] = await findNonceTombstonePda(swapDvp, PROGRAM_ID);
	const [dvpAtaA] = await findSwapDvpEscrowAta({
		swapDvp,
		mint: mintA,
		tokenProgram: TOKEN_PROGRAM_ADDRESS
	});
	const [dvpAtaB] = await findSwapDvpEscrowAta({
		swapDvp,
		mint: mintB,
		tokenProgram: TOKEN_2022_PROGRAM_ADDRESS
	});
	return {
		mintA,
		mintB,
		seedTerms,
		swapDvp,
		nonceTombstone,
		dvpAtaA,
		dvpAtaB,
		aMintA: await ata(ctx.partyA.address, mintA, TOKEN_PROGRAM_ADDRESS),
		bMintA: await ata(ctx.partyB.address, mintA, TOKEN_PROGRAM_ADDRESS),
		aMintB: await ata(ctx.partyA.address, mintB, TOKEN_2022_PROGRAM_ADDRESS),
		bMintB: await ata(ctx.partyB.address, mintB, TOKEN_2022_PROGRAM_ADDRESS)
	};
}

function escrowKeys(ctx: Ctx): EscrowKeys {
	return EscrowKeys.fromSeed(fromHex(ctx.stored.sharedSeed));
}

// ---------------------------------------------------------------- relay sending

type RelayableMessage = Parameters<typeof partiallySignTransactionMessageWithSigners>[0];

async function relayMessage(message: RelayableMessage, log: StepLog): Promise<void> {
	const signed = await partiallySignTransactionMessageWithSigners(message);
	log.wireSizes.push(getTransactionEncoder().encode(signed).length);
	const res = await fetch('/api/relay', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ tx: getBase64EncodedWireTransaction(signed) })
	});
	const body = (await res.json()) as { signature?: string; error?: string; message?: string };
	if (!res.ok || !body.signature) throw new Error(body.error ?? body.message ?? res.statusText);
	log.signatures.push(body.signature);
}

async function latestBlockhash(ctx: Ctx) {
	return (await ctx.rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()).value;
}

/** DvP client plan: size check, message with a fresh blockhash, partial sign, relay. */
async function sendPlanned(ctx: Ctx, plan: PlannedTransaction, log: StepLog): Promise<void> {
	plan.checkSize(ctx.config);
	await relayMessage(plan.message(ctx.config, await latestBlockhash(ctx)), log);
}

async function sendSession(ctx: Ctx, session: TransactionSession, log: StepLog): Promise<void> {
	log.notes.push(`session: ${session.preparation.length} preparation tx + 1 final`);
	for (const plan of [...session.preparation, session.finalTransaction])
		await sendPlanned(ctx, plan, log);
}

/** Kit InstructionPlan (Token-2022 helpers): plan v1 transactions, then relay them in order. */
async function sendInstructionPlan(ctx: Ctx, plan: InstructionPlan, log: StepLog): Promise<void> {
	const planner = createTransactionPlanner({
		createTransactionMessage: () =>
			pipe(
				createTransactionMessage({ version: 1 }),
				(m) => setTransactionMessageFeePayerSigner(ctx.treasury, m),
				(m) => setTransactionMessageComputeUnitLimit(T22_PLAN_CU_LIMIT, m),
				// Unset, v1 fails with "exceeded max loaded accounts data size cap".
				(m) => setTransactionMessageLoadedAccountsDataSizeLimit(4_000_000, m)
			)
	});
	const singles = flattenTransactionPlan(await planner(plan));
	log.notes.push(`kit planner: ${singles.length} tx`);
	for (const single of singles)
		await relayMessage(
			setTransactionMessageLifetimeUsingBlockhash(
				await latestBlockhash(ctx),
				single.message
			) as RelayableMessage,
			log
		);
}

function planInstructions(plan: InstructionPlan): Instruction[] {
	return flattenInstructionPlan(plan).map((entry) => {
		assertIsSingleInstructionPlan(entry);
		return entry.instruction;
	});
}

async function timed<T>(log: StepLog, fn: () => Promise<T> | T): Promise<T> {
	const t0 = performance.now();
	try {
		return await fn();
	} finally {
		log.proofMs = (log.proofMs ?? 0) + Math.round(performance.now() - t0);
	}
}

// ---------------------------------------------------------------------- steps

export async function stepSetup(ctx: Ctx, log: StepLog): Promise<void> {
	const res = await fetch('/api/setup', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ partyA: ctx.partyA.address, partyB: ctx.partyB.address })
	});
	const body = (await res.json()) as {
		mintA?: string;
		mintB?: string;
		signatures?: string[];
		error?: string;
	};
	if (!res.ok || !body.mintA || !body.mintB) throw new Error(body.error ?? res.statusText);
	ctx.stored.mintA = body.mintA;
	ctx.stored.mintB = body.mintB;
	save(ctx.stored);
	log.signatures.push(...(body.signatures ?? []));
	log.notes.push(`mint A ${body.mintA}`, `mint B ${body.mintB}`);
}

/** Reallocate + ConfigureAccount (+ inline VerifyPubkeyValidity) on a party's mint B ATA. */
async function configureCtAccount(ctx: Ctx, owner: KeyPairSigner, token: Address, log: StepLog) {
	const { mintB } = await addresses(ctx);
	const keys = await walletKeys(owner);
	try {
		const plan = await timed(log, () =>
			getCreateConfidentialTransferAccountInstructionPlan({
				rpc: ctx.rpc,
				payer: ctx.treasury,
				owner,
				mint: mintB,
				token,
				elgamalKeypair: keys.elgamal,
				aesKey: keys.ae
			})
		);
		// /api/setup already created the ATA; drop the helper's CreateIdempotent so the
		// relay never has to let the treasury pay inside the ATA program.
		const ixs = planInstructions(plan).filter(
			(ix) => ix.programAddress !== ASSOCIATED_TOKEN_PROGRAM_ADDRESS
		);
		await sendPlanned(ctx, new PlannedTransaction(ixs), log);
	} finally {
		keys.elgamal.free();
		keys.ae.free();
	}
}

export async function stepCtAccounts(ctx: Ctx, log: StepLog): Promise<void> {
	const a = await addresses(ctx);
	await configureCtAccount(ctx, ctx.partyA, a.aMintB, log);
	await configureCtAccount(ctx, ctx.partyB, a.bMintB, log);
	// B: public -> pending.
	await sendPlanned(
		ctx,
		new PlannedTransaction([
			getConfidentialDepositInstruction({
				token: a.bMintB,
				mint: a.mintB,
				authority: ctx.partyB,
				amount: START_B,
				decimals: DECIMALS
			})
		]),
		log
	);
	// B: pending -> available.
	await applyPending(ctx, ctx.partyB, a.bMintB, log);
}

async function applyPending(ctx: Ctx, owner: KeyPairSigner, token: Address, log: StepLog) {
	const account = await fetchToken(ctx.rpc, token, { commitment: 'confirmed' });
	const keys = await walletKeys(owner);
	const secret = keys.elgamal.secret();
	try {
		const ix = await timed(log, () =>
			getApplyConfidentialPendingBalanceInstructionFromToken({
				token,
				tokenAccount: account.data,
				authority: owner,
				elgamalSecretKey: secret,
				aesKey: keys.ae
			})
		);
		await sendPlanned(ctx, new PlannedTransaction([ix]), log);
	} finally {
		secret.free();
		keys.elgamal.free();
		keys.ae.free();
	}
}

export async function stepCreate(ctx: Ctx, log: StepLog): Promise<void> {
	const a = await addresses(ctx);
	const keys = escrowKeys(ctx);
	try {
		const session = await timed(log, () =>
			createSession(
				ctx.config,
				{
					...a.seedTerms,
					payer: ctx.treasury,
					swapDvp: a.swapDvp,
					nonceTombstone: a.nonceTombstone,
					dvpAtaA: a.dvpAtaA,
					dvpAtaB: a.dvpAtaB,
					tokenProgramA: TOKEN_PROGRAM_ADDRESS,
					tokenProgramB: TOKEN_2022_PROGRAM_ADDRESS,
					instructionsSysvar: INSTRUCTIONS_SYSVAR,
					amountA: AMOUNT_A,
					expiryTimestamp: BigInt(Math.floor(Date.now() / 1000) + 3600),
					refString: null,
					userASettlementDestination: null,
					userBSettlementDestination: null,
					earliestSettlementTimestamp: null
				},
				keys,
				AMOUNT_B
			)
		);
		await sendSession(ctx, session, log);
		log.notes.push(`swap ${a.swapDvp}`);
	} finally {
		keys.free();
	}
}

export async function stepFundA(ctx: Ctx, log: StepLog): Promise<void> {
	const a = await addresses(ctx);
	await sendPlanned(
		ctx,
		new PlannedTransaction([
			getTransferCheckedInstruction({
				source: a.aMintA,
				mint: a.mintA,
				destination: a.dvpAtaA,
				authority: ctx.partyA,
				amount: AMOUNT_A,
				decimals: DECIMALS
			})
		]),
		log
	);
}

export async function stepFundB(ctx: Ctx, log: StepLog): Promise<void> {
	const a = await addresses(ctx);
	const keys = escrowKeys(ctx);
	const wallet = await walletKeys(ctx.partyB);
	try {
		const snapshots = await fetchEncodedAccounts(ctx.rpc, [a.swapDvp, a.dvpAtaB], {
			commitment: 'confirmed'
		});
		const [swap, escrow] = snapshots;
		if (!swap?.exists || !escrow?.exists) throw new Error('Swap or escrow B missing');
		// Verify the swap, escrow key and agreed private amount before paying in.
		await verifyConfidentialFunding(swap, escrow, keys, AMOUNT_B, PROGRAM_ID);
		log.notes.push('verifyConfidentialFunding ok');
		const source = await fetchToken(ctx.rpc, a.bMintB, { commitment: 'confirmed' });
		const mint = await fetchEncodedAccount(ctx.rpc, a.mintB, { commitment: 'confirmed' });
		if (!mint.exists) throw new Error('Mint B missing');
		const plan = await timed(log, () =>
			getConfidentialTransferInstructionPlan({
				sourceToken: a.bMintB,
				mint: a.mintB,
				destinationToken: a.dvpAtaB,
				sourceTokenAccount: source.data,
				destinationTokenAccount: getTokenDecoder().decode(escrow.data),
				authority: ctx.partyB,
				amount: AMOUNT_B,
				sourceElgamalKeypair: wallet.elgamal,
				aesKey: wallet.ae,
				payer: ctx.treasury,
				rpc: ctx.rpc
			})
		);
		await sendInstructionPlan(ctx, plan, log);
	} finally {
		keys.free();
		wallet.elgamal.free();
		wallet.ae.free();
	}
}

export async function stepApplyEscrow(ctx: Ctx, log: StepLog): Promise<void> {
	const a = await addresses(ctx);
	const keys = escrowKeys(ctx);
	try {
		const escrow = await fetchEncodedAccount(ctx.rpc, a.dvpAtaB, { commitment: 'confirmed' });
		if (!escrow.exists) throw new Error('Escrow B missing');
		const source = await readEscrowAccount(escrow, a.swapDvp, a.mintB);
		const session = await timed(log, () =>
			applySession(
				ctx.config,
				{
					...a.seedTerms,
					signer: ctx.authority,
					swapDvp: a.swapDvp,
					nonceTombstone: a.nonceTombstone,
					dvpAtaB: a.dvpAtaB,
					tokenProgram: TOKEN_2022_PROGRAM_ADDRESS
				},
				{ state: source.state, keys }
			)
		);
		await sendSession(ctx, session, log);
	} finally {
		keys.free();
	}
}

export async function stepSettle(ctx: Ctx, log: StepLog): Promise<void> {
	const a = await addresses(ctx);
	const keys = escrowKeys(ctx);
	try {
		const snapshots = await fetchEncodedAccounts(
			ctx.rpc,
			[a.swapDvp, a.dvpAtaB, a.aMintB, a.bMintB, a.mintB],
			{ commitment: 'confirmed' }
		);
		const [swap, escrow, recipient, refund, mint] = snapshots;
		if (!swap?.exists || !escrow?.exists || !recipient?.exists || !refund?.exists || !mint?.exists)
			throw new Error('Incomplete settlement snapshot');
		const checked = await verifyConfidentialFunding(swap, escrow, keys, AMOUNT_B, PROGRAM_ID);
		const session = await timed(log, () =>
			settleSession(
				ctx.config,
				{
					swapDvp: a.swapDvp,
					mintA: a.mintA,
					mintB: a.mintB,
					dvpAtaA: a.dvpAtaA,
					dvpAtaB: a.dvpAtaB,
					userAAtaA: a.aMintA,
					userBAtaB: a.bMintB,
					tokenProgramA: TOKEN_PROGRAM_ADDRESS,
					tokenProgramB: TOKEN_2022_PROGRAM_ADDRESS,
					memoProgram: MEMO,
					zkElgamalProofProgram: ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS,
					settlementAuthority: ctx.authority,
					userADestinationAtaB: a.aMintB,
					userBDestinationAtaA: a.bMintA
				},
				{
					source: { state: checked.state, keys },
					swap: checked.swap,
					expectedAmountB: AMOUNT_B,
					recipient: confidentialState(getTokenDecoder().decode(recipient.data)),
					surplusRecipient: confidentialState(getTokenDecoder().decode(refund.data)),
					auditor: mintAuditor(mint)
				}
			)
		);
		await sendSession(ctx, session, log);
	} finally {
		keys.free();
	}
}

/** A applies its pending credit and decrypts; escrows and swap must be closed. */
export async function stepCheck(ctx: Ctx, log: StepLog): Promise<void> {
	const a = await addresses(ctx);
	await applyPending(ctx, ctx.partyA, a.aMintB, log);
	const account = await fetchToken(ctx.rpc, a.aMintB, { commitment: 'confirmed' });
	const keys = await walletKeys(ctx.partyA);
	const secret = keys.elgamal.secret();
	try {
		const balance = decryptConfidentialTransferBalance({
			tokenAccount: account.data,
			elgamalSecretKey: secret,
			aesKey: keys.ae
		});
		log.notes.push(
			`A mint B available ${balance.availableBalance} pending ${balance.pendingBalance} (expected ${AMOUNT_B})`
		);
		if (balance.availableBalance !== AMOUNT_B) throw new Error('A did not receive AMOUNT_B');
	} finally {
		secret.free();
		keys.elgamal.free();
		keys.ae.free();
	}
	const assetB = await ctx.rpc.getTokenAccountBalance(a.bMintA, { commitment: 'confirmed' }).send();
	log.notes.push(`B mint A public ${assetB.value.amount} (expected ${AMOUNT_A})`);
	const closed = await fetchEncodedAccounts(ctx.rpc, [a.swapDvp, a.dvpAtaA, a.dvpAtaB], {
		commitment: 'confirmed'
	});
	const names = ['swap', 'escrow A', 'escrow B'];
	closed.forEach((acc, i) => log.notes.push(`${names[i]}: ${acc.exists ? 'OPEN' : 'closed'}`));
	if (closed.some((acc) => acc.exists)) throw new Error('Swap or escrow still open');
	if (BigInt(assetB.value.amount) !== AMOUNT_A) throw new Error('B did not receive AMOUNT_A');
}

/** Lamports of the treasury and the role wallets (context rent returns to signers). */
export async function balances(ctx: Ctx): Promise<Record<string, bigint>> {
	const out: Record<string, bigint> = {};
	for (const [name, who] of [
		['treasury', ctx.treasury.address],
		['authority', ctx.authority.address],
		['partyA', ctx.partyA.address],
		['partyB', ctx.partyB.address]
	] as const)
		out[name] = (await ctx.rpc.getBalance(who, { commitment: 'confirmed' }).send()).value;
	return out;
}
