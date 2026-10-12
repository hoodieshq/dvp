/**
 * Run the browser flow in-process under Bun against devnet, without a dev
 * server: fetch('/api/...') is routed straight to the SvelteKit handlers.
 * Usage (from the repo root):
 *   bun --env-file=prototypes/ct-browser/.env \
 *     --preload ./prototypes/ct-browser/scripts/harness-preload.ts \
 *     prototypes/ct-browser/scripts/smoke.ts [firstStep]
 * State lives in .secrets/smoke-state.json; delete it to start a new cycle.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.TREASURY_KEYPAIR ??= join(app, '.secrets', 'treasury.json');
const statePath = join(app, '.secrets', 'smoke-state.json');

// Browser globals used by the flow.
const ORIGIN = 'http://harness.local';
const store = new Map<string, string>(
	existsSync(statePath) ? Object.entries(JSON.parse(readFileSync(statePath, 'utf8'))) : []
);
Object.assign(globalThis, {
	location: { origin: ORIGIN },
	localStorage: {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => {
			store.set(k, v);
			writeFileSync(statePath, JSON.stringify(Object.fromEntries(store)), { mode: 0o600 });
		}
	}
});

const routes: Record<string, Record<string, (event: { request: Request }) => Promise<Response>>> = {
	'/api/rpc': await import('../src/routes/api/rpc/+server'),
	'/api/relay': await import('../src/routes/api/relay/+server'),
	'/api/setup': await import('../src/routes/api/setup/+server'),
	'/api/config': await import('../src/routes/api/config/+server')
} as never;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, ORIGIN);
	if (url.origin !== ORIGIN) return realFetch(input, init);
	const request = new Request(url, init);
	const handler = routes[url.pathname]?.[request.method];
	if (!handler) return new Response('not found', { status: 404 });
	try {
		return await handler({ request });
	} catch (e) {
		// SvelteKit `error()` throws { status, body }.
		const err = e as { status?: number; body?: unknown };
		if (err.status) return Response.json(err.body, { status: err.status });
		throw e;
	}
}) as typeof fetch;

const { load } = await import('../src/lib/ct/state');
const flow = await import('../src/lib/ct/flow');
type StepLog = import('../src/lib/ct/state').StepLog;

const steps: [string, (ctx: Awaited<ReturnType<typeof flow.context>>, log: StepLog) => Promise<void>][] = [
	['setup', flow.stepSetup],
	['ct-accounts', flow.stepCtAccounts],
	['create', flow.stepCreate],
	['fund-a', flow.stepFundA],
	['fund-b', flow.stepFundB],
	['apply', flow.stepApplyEscrow],
	['settle', flow.stepSettle],
	['check', flow.stepCheck]
];
const first = process.argv[2] ? steps.findIndex(([n]) => n === process.argv[2]) : 0;
if (first < 0) throw new Error(`unknown step ${process.argv[2]}`);

const ctx = await flow.context(load());
const fmt = (b: Record<string, bigint>) => Object.entries(b).map(([k, v]) => `${k}=${v}`).join(' ');
console.log(`start lamports: ${fmt(await flow.balances(ctx))}`);
for (const [name, run] of steps.slice(first)) {
	const log: StepLog = { step: name, status: 'running', signatures: [], wireSizes: [], notes: [] };
	const t0 = performance.now();
	try {
		await run(ctx, log);
		log.status = 'ok';
	} catch (e) {
		log.status = 'error';
		log.error = e instanceof Error ? (e.stack ?? e.message) : String(e);
	}
	log.elapsedMs = Math.round(performance.now() - t0);
	console.log(JSON.stringify(log, null, 1));
	console.log(`lamports: ${fmt(await flow.balances(ctx))}`);
	if (log.status === 'error') process.exit(1);
}
