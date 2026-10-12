import { env } from '$env/dynamic/private';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * Same-origin JSON-RPC proxy so the keyed RPC URL never reaches the browser.
 * Forwards only the single, cheap methods the page calls; no batches.
 * Retries throttling (429 / 5xx), connection failures and stalls with backoff.
 */
const ALLOWED_METHODS = new Set([
	'getAccountInfo',
	'getBalance',
	'getLatestBlockhash',
	'getMinimumBalanceForRentExemption',
	'getMultipleAccounts',
	'getSignatureStatuses',
	'getTokenAccountBalance',
	'getTransaction'
]);
const MAX_BODY_BYTES = 16 * 1024;
const ATTEMPT_TIMEOUT_MS = 8_000;
const TOTAL_BUDGET_MS = 20_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const rpcError = (id: unknown, code: number, message: string, status: number) =>
	json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, { status });

export const POST: RequestHandler = async ({ request }) => {
	if (!env.RPC_URL) return rpcError(null, -32603, 'RPC_URL not configured', 500);
	const body = await request.text();
	if (body.length > MAX_BODY_BYTES) return rpcError(null, -32600, 'Request body too large', 413);
	let call: { id?: unknown; method?: unknown };
	try {
		call = JSON.parse(body);
	} catch {
		return rpcError(null, -32700, 'Parse error', 400);
	}
	if (Array.isArray(call) || typeof call !== 'object' || call === null)
		return rpcError(null, -32600, 'Batch requests are not supported', 400);
	if (typeof call.method !== 'string' || !ALLOWED_METHODS.has(call.method))
		return rpcError(call.id, -32601, 'Method not allowed through this proxy', 403);

	const deadline = Date.now() + TOTAL_BUDGET_MS;
	let last: { status: number; text: string } | null = null;
	for (let attempt = 0; ; attempt++) {
		if (attempt) await sleep(Math.min(250 * 2 ** (attempt - 1), deadline - Date.now()));
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		let upstream: Response;
		try {
			upstream = await fetch(env.RPC_URL, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body,
				signal: AbortSignal.timeout(Math.min(ATTEMPT_TIMEOUT_MS, remaining))
			});
		} catch {
			continue;
		}
		const text = await upstream.text();
		if (upstream.status !== 429 && upstream.status < 500)
			return new Response(text, {
				status: upstream.status,
				headers: { 'content-type': 'application/json' }
			});
		last = { status: upstream.status, text };
	}
	if (last)
		return new Response(last.text, {
			status: last.status,
			headers: { 'content-type': 'application/json' }
		});
	return rpcError(call.id, -32603, 'Upstream RPC did not respond', 504);
};
