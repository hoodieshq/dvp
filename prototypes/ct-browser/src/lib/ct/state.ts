/**
 * Browser-only persistent state (localStorage). Role keypairs are 32-byte
 * Ed25519 seeds; they hold no SOL. No WASM here, so the page can import it eagerly.
 */
const KEY = 'ct-browser-prototype:v1';

export type Stored = {
	roles: { authority: string; partyA: string; partyB: string };
	/** Shared DvP seed (hex), from which EscrowKeys are derived. */
	sharedSeed: string;
	nonce: string;
	mintA?: string;
	mintB?: string;
	/** CT wallet keys per role address (hex), derived once and kept. */
	ctKeys?: Record<string, { elgamalSecret: string; ae: string }>;
};

export const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
export const fromHex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)));
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

function fresh(): Stored {
	const nonce = new DataView(random(8).buffer).getBigUint64(0, true);
	return {
		roles: { authority: hex(random(32)), partyA: hex(random(32)), partyB: hex(random(32)) },
		sharedSeed: hex(random(32)),
		nonce: nonce.toString()
	};
}

export function load(): Stored {
	const raw = localStorage.getItem(KEY);
	if (raw) return JSON.parse(raw) as Stored;
	const s = fresh();
	save(s);
	return s;
}

export function save(s: Stored): void {
	localStorage.setItem(KEY, JSON.stringify(s));
}

/** New roles, seed and nonce: starts a fresh cycle. */
export function reset(): Stored {
	const s = fresh();
	save(s);
	return s;
}

export type StepLog = {
	step: string;
	status: 'running' | 'ok' | 'error';
	signatures: string[];
	wireSizes: number[];
	proofMs?: number;
	elapsedMs?: number;
	notes: string[];
	error?: string;
};
