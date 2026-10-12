/** Print the treasury address and its devnet balance. Reads RPC_URL from the env; never prints it. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKeyPairSignerFromBytes, createSolanaRpc } from '@solana/kit';

const path = join(dirname(fileURLToPath(import.meta.url)), '..', '.secrets', 'treasury.json');
const signer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
const url = process.env.RPC_URL;
if (!url) throw new Error('RPC_URL is not set');
const { value } = await createSolanaRpc(url).getBalance(signer.address, { commitment: 'confirmed' }).send();
console.log(`${signer.address} ${value} lamports (${Number(value) / 1e9} SOL)`);
