/**
 * Generate the prototype treasury keypair into .secrets/treasury.json
 * (solana-keygen format: 64-byte JSON array). Prints only the address.
 * Refuses to overwrite an existing keypair.
 */
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddressDecoder } from '@solana/kit';

const path = join(dirname(fileURLToPath(import.meta.url)), '..', '.secrets', 'treasury.json');
if (existsSync(path)) throw new Error(`${path} already exists`);

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d!, 'base64url');
const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');

mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
writeFileSync(path, JSON.stringify([...seed, ...pub]), { mode: 0o600 });
console.log(getAddressDecoder().decode(pub));
