import { json, error } from '@sveltejs/kit';
import { isAddress } from '@solana/kit';
import type { RequestHandler } from './$types';
import { setup } from '$lib/server/solana';

/** Treasury creates fresh mints A and B, the role ATAs, and mints public balances. */
export const POST: RequestHandler = async ({ request }) => {
	const { partyA, partyB } = (await request.json()) as { partyA?: string; partyB?: string };
	if (!partyA || !partyB || !isAddress(partyA) || !isAddress(partyB))
		throw error(400, 'partyA and partyB addresses are required');
	try {
		return json(await setup({ partyA, partyB }));
	} catch (e) {
		return json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
	}
};
