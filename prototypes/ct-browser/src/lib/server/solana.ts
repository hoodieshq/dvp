/**
 * Server-only Solana helpers: the treasury key, the keyed RPC, setup and the
 * fee-sponsoring relay. The treasury is mint authority for both mints and fee
 * payer for every user transaction, so role wallets never hold SOL.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
	appendTransactionMessageInstructions,
	assertIsSingleInstructionPlan,
	createKeyPairFromBytes,
	createKeyPairSignerFromBytes,
	createSolanaRpc,
	createTransactionMessage,
	flattenInstructionPlan,
	generateKeyPairSigner,
	getBase64EncodedWireTransaction,
	getSignatureFromTransaction,
	lamports,
	pipe,
	setTransactionMessageComputeUnitLimit,
	setTransactionMessageFeePayerSigner,
	setTransactionMessageLifetimeUsingBlockhash,
	setTransactionMessageLoadedAccountsDataSizeLimit,
	signTransaction,
	signTransactionMessageWithSigners,
	type Address,
	type Instruction,
	type InstructionPlan,
	type KeyPairSigner,
	type Rpc,
	type Signature,
	type SolanaRpcApi
} from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import {
	TOKEN_2022_PROGRAM_ADDRESS,
	findAssociatedTokenPda,
	getCreateAssociatedTokenIdempotentInstruction,
	getCreateMintInstructionPlan,
	getMintToInstruction
} from '@solana-program/token-2022';
import { env } from '$env/dynamic/private';
import { DECIMALS, PROGRAM_ID, START_A, START_B } from '$lib/config';
import {
	DEFAULT_CONTEXT_SIZES,
	assertRelayable,
	decodeRelayTransaction,
	type RelayPolicyConfig
} from './relayPolicy';

let _secret: Uint8Array | null = null;
let _treasury: Promise<KeyPairSigner> | null = null;
let _treasuryKp: Promise<CryptoKeyPair> | null = null;
let _rpc: Rpc<SolanaRpcApi> | null = null;

function secretBytes(): Uint8Array {
	if (!_secret) {
		const path = resolve(env.TREASURY_KEYPAIR ?? '.secrets/treasury.json');
		_secret = Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')));
	}
	return _secret;
}

export function treasury(): Promise<KeyPairSigner> {
	if (!_treasury) _treasury = createKeyPairSignerFromBytes(secretBytes());
	return _treasury;
}

function treasuryKeyPair(): Promise<CryptoKeyPair> {
	if (!_treasuryKp) _treasuryKp = createKeyPairFromBytes(secretBytes());
	return _treasuryKp;
}

export function serverRpc(): Rpc<SolanaRpcApi> {
	if (!env.RPC_URL) throw new Error('RPC_URL is not set');
	if (!_rpc) _rpc = createSolanaRpc(env.RPC_URL);
	return _rpc;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function confirm(rpc: Rpc<SolanaRpcApi>, sig: Signature): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < 60_000) {
		const { value } = await rpc.getSignatureStatuses([sig]).send();
		const st = value[0];
		if (st) {
			if (st.err) throw new Error(`Transaction ${sig} failed: ${JSON.stringify(st.err, bigintJson)}`);
			if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return;
		}
		await sleep(700);
	}
	throw new Error(`Timed out confirming ${sig}`);
}

const bigintJson = (_: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

/** Send base64 with preflight, surfacing simulation logs on failure. */
async function sendWire(rpc: Rpc<SolanaRpcApi>, wire: string, sig: Signature): Promise<void> {
	try {
		await rpc
			.sendTransaction(wire as Parameters<SolanaRpcApi['sendTransaction']>[0], {
				encoding: 'base64',
				preflightCommitment: 'confirmed'
			})
			.send();
	} catch (e) {
		// Kit's preflight error carries the simulation result (logs, err) in context
		// and the decoded transaction error in cause.
		const { context, cause } = e as { context?: { logs?: string[] }; cause?: unknown };
		const logs = context?.logs?.length ? `\nlogs:\n${context.logs.join('\n')}` : '';
		const why = cause ? `\ncause: ${cause instanceof Error ? cause.message : String(cause)} ${JSON.stringify((cause as { context?: unknown }).context ?? '', bigintJson)}` : '';
		throw new Error(`${e instanceof Error ? e.message : String(e)}${why}${logs}`);
	}
	await confirm(rpc, sig);
}

/** Build, sign (treasury fee payer), send, confirm: for treasury-only server txs. */
async function send(rpc: Rpc<SolanaRpcApi>, ixs: Instruction[]): Promise<Signature> {
	const feePayer = await treasury();
	const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
	const message = pipe(
		createTransactionMessage({ version: 1 }),
		// v1 without explicit limits fails on devnet with "exceeded max loaded
		// accounts data size cap"; use the DvP client's defaults.
		(m) => setTransactionMessageComputeUnitLimit(400_000, m),
		(m) => setTransactionMessageLoadedAccountsDataSizeLimit(4_000_000, m),
		(m) => setTransactionMessageFeePayerSigner(feePayer, m),
		(m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
		(m) => appendTransactionMessageInstructions(ixs, m)
	);
	const signed = await signTransactionMessageWithSigners(message);
	const sig = getSignatureFromTransaction(signed);
	await sendWire(rpc, getBase64EncodedWireTransaction(signed), sig);
	return sig;
}

function planInstructions(plan: InstructionPlan): Instruction[] {
	return flattenInstructionPlan(plan).map((entry) => {
		assertIsSingleInstructionPlan(entry);
		return entry.instruction;
	});
}

export type SetupResult = {
	mintA: Address;
	mintB: Address;
	signatures: Signature[];
};

/**
 * Create mint A (classic SPL Token) and mint B (Token-2022 with
 * ConfidentialTransferMint, auto-approve, no auditor), both with the treasury
 * as authority; create the four role ATAs and mint public balances to A (mint A)
 * and B (mint B). Fresh mints on every call.
 */
export async function setup(roles: { partyA: Address; partyB: Address }): Promise<SetupResult> {
	const rpc = serverRpc();
	const t = await treasury();
	const client = {
		getMinimumBalance: async (space: number) =>
			lamports(await rpc.getMinimumBalanceForRentExemption(BigInt(space)).send())
	};
	const mintA = await generateKeyPairSigner();
	const mintB = await generateKeyPairSigner();
	const createA = await getCreateMintInstructionPlan(
		client,
		{ payer: t, newMint: mintA, mintAuthority: t, decimals: DECIMALS },
		{ tokenProgram: TOKEN_PROGRAM_ADDRESS }
	);
	const createB = await getCreateMintInstructionPlan(client, {
		payer: t,
		newMint: mintB,
		mintAuthority: t,
		decimals: DECIMALS,
		extensions: [
			{
				__kind: 'ConfidentialTransferMint',
				authority: t.address,
				autoApproveNewAccounts: true,
				auditorElgamalPubkey: null
			}
		]
	});
	const signatures = [await send(rpc, [...planInstructions(createA), ...planInstructions(createB)])];

	const ata = async (owner: Address, mint: Address, tokenProgram: Address) =>
		(await findAssociatedTokenPda({ owner, mint, tokenProgram }))[0];
	const ixs: Instruction[] = [];
	const accounts = {
		aMintA: await ata(roles.partyA, mintA.address, TOKEN_PROGRAM_ADDRESS),
		bMintA: await ata(roles.partyB, mintA.address, TOKEN_PROGRAM_ADDRESS),
		aMintB: await ata(roles.partyA, mintB.address, TOKEN_2022_PROGRAM_ADDRESS),
		bMintB: await ata(roles.partyB, mintB.address, TOKEN_2022_PROGRAM_ADDRESS)
	};
	for (const [owner, mint, tokenProgram, account] of [
		[roles.partyA, mintA.address, TOKEN_PROGRAM_ADDRESS, accounts.aMintA],
		[roles.partyB, mintA.address, TOKEN_PROGRAM_ADDRESS, accounts.bMintA],
		[roles.partyA, mintB.address, TOKEN_2022_PROGRAM_ADDRESS, accounts.aMintB],
		[roles.partyB, mintB.address, TOKEN_2022_PROGRAM_ADDRESS, accounts.bMintB]
	] as const) {
		ixs.push(
			getCreateAssociatedTokenIdempotentInstruction({
				payer: t,
				owner,
				mint,
				ata: account,
				tokenProgram
			})
		);
	}
	ixs.push(
		getMintToInstruction(
			{ mint: mintA.address, token: accounts.aMintA, mintAuthority: t, amount: START_A },
			{ programAddress: TOKEN_PROGRAM_ADDRESS }
		),
		getMintToInstruction({
			mint: mintB.address,
			token: accounts.bMintB,
			mintAuthority: t,
			amount: START_B
		})
	);
	signatures.push(await send(rpc, ixs));
	return { mintA: mintA.address, mintB: mintB.address, signatures };
}

// Rent for each allowed proof context size, fetched from RPC once.
let _policy: Promise<RelayPolicyConfig> | null = null;
function policyConfig(): Promise<RelayPolicyConfig> {
	if (!_policy)
		_policy = (async () => {
			const rpc = serverRpc();
			const rent = new Map<number, bigint>();
			for (const space of DEFAULT_CONTEXT_SIZES)
				rent.set(space, await rpc.getMinimumBalanceForRentExemption(BigInt(space)).send());
			return {
				treasury: (await treasury()).address,
				dvpProgram: PROGRAM_ID,
				contextSizes: DEFAULT_CONTEXT_SIZES,
				rentExemptLamports: (space: number) => rent.get(space)
			};
		})().catch((e) => {
			_policy = null;
			throw e;
		});
	return _policy;
}

/**
 * Fee sponsorship: take a client-built, role-signed v1 transaction, run the
 * relay policy, add the treasury's fee-payer signature, submit and confirm.
 */
export async function relay(wireBase64: string): Promise<Signature> {
	const rpc = serverRpc();
	const { transaction } = decodeRelayTransaction(wireBase64);
	assertRelayable(transaction, await policyConfig());
	const signed = await signTransaction([await treasuryKeyPair()], transaction);
	const sig = getSignatureFromTransaction(signed);
	await sendWire(rpc, getBase64EncodedWireTransaction(signed), sig);
	return sig;
}
