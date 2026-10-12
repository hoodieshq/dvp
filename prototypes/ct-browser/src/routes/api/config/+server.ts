import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { treasury } from '$lib/server/solana';

/** Public config for the browser: the treasury address (fee payer for every relayed tx). */
export const GET: RequestHandler = async () => json({ treasury: (await treasury()).address });
