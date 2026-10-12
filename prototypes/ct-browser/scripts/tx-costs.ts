/**
 * Per-transaction cost breakdown: fee, signer count, and the treasury's
 * balance change. Usage: bun --env-file=.env scripts/tx-costs.ts <sig>...
 * Reads RPC_URL from the env; never prints it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKeyPairSignerFromBytes, createSolanaRpc, signature } from '@solana/kit';

const path = join(dirname(fileURLToPath(import.meta.url)), '..', '.secrets', 'treasury.json');
const treasury = (await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))))).address;
const url = process.env.RPC_URL;
if (!url) throw new Error('RPC_URL is not set');
const rpc = createSolanaRpc(url);

let total = 0n;
for (const sig of process.argv.slice(2)) {
	const tx = await rpc
		.getTransaction(signature(sig), {
			commitment: 'confirmed',
			encoding: 'json',
			maxSupportedTransactionVersion: 1
		} as never)
		.send();
	if (!tx?.meta) {
		console.log(`${sig.slice(0, 8)} not found`);
		continue;
	}
	const keys = tx.transaction.message.accountKeys as string[];
	const i = keys.indexOf(treasury);
	const delta = BigInt(tx.meta.postBalances[i]!) - BigInt(tx.meta.preBalances[i]!);
	total += delta;
	const cu = tx.meta.computeUnitsConsumed ?? '-';
	console.log(
		`${sig.slice(0, 8)} fee=${tx.meta.fee} signers=${tx.transaction.signatures.length} cu=${cu} treasuryDelta=${delta} rentNet=${delta + BigInt(tx.meta.fee)}`
	);
}
console.log(`total treasury delta ${total}`);
