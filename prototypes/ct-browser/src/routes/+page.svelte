<script lang="ts">
	import { load, reset, type StepLog, type Stored } from '$lib/ct/state';

	type Flow = typeof import('$lib/ct/flow');
	type Step = { id: string; label: string; run: (f: Flow, ctx: Ctx, log: StepLog) => Promise<void> };
	type Ctx = Awaited<ReturnType<Flow['context']>>;

	const STEPS: Step[] = [
		{ id: 'setup', label: '1. Setup (server)', run: (f, c, l) => f.stepSetup(c, l) },
		{ id: 'ct-accounts', label: '2. Party CT accounts', run: (f, c, l) => f.stepCtAccounts(c, l) },
		{ id: 'create', label: '4. Create', run: (f, c, l) => f.stepCreate(c, l) },
		{ id: 'fund-a', label: '5. Fund A', run: (f, c, l) => f.stepFundA(c, l) },
		{ id: 'fund-b', label: '6. Fund B (CT)', run: (f, c, l) => f.stepFundB(c, l) },
		{ id: 'apply', label: '7. Apply escrow B', run: (f, c, l) => f.stepApplyEscrow(c, l) },
		{ id: 'settle', label: '8. Settle', run: (f, c, l) => f.stepSettle(c, l) },
		{ id: 'check', label: '9. Check', run: (f, c, l) => f.stepCheck(c, l) }
	];

	let stored: Stored = $state(load());
	let logs: StepLog[] = $state([]);
	let busy = $state(false);
	let flow: Flow | null = null;
	let ctx: Ctx | null = null;

	async function ensureFlow(): Promise<{ flow: Flow; ctx: Ctx }> {
		if (!flow) {
			const log = begin('load WASM + CT modules');
			const t0 = performance.now();
			flow = await import('$lib/ct/flow');
			const wasm = performance
				.getEntriesByType('resource')
				.filter((e) => e.name.includes('.wasm')) as PerformanceResourceTiming[];
			log.notes.push(`dynamic import ${Math.round(performance.now() - t0)} ms`);
			for (const w of wasm)
				log.notes.push(
					`${w.name.split('/').pop()}: ${w.decodedBodySize} B decoded, ${w.transferSize} B transferred, ${Math.round(w.duration)} ms`
				);
			finish(log, t0);
		}
		if (!ctx) ctx = await flow.context(stored);
		return { flow, ctx };
	}

	function begin(step: string): StepLog {
		logs.push({ step, status: 'running', signatures: [], wireSizes: [], notes: [] });
		return logs[logs.length - 1];
	}

	function finish(log: StepLog, t0: number, e?: unknown) {
		log.elapsedMs = Math.round(performance.now() - t0);
		log.status = e === undefined ? 'ok' : 'error';
		if (e !== undefined) log.error = e instanceof Error ? `${e.message}${e.cause ? `\ncause: ${String(e.cause)}` : ''}` : String(e);
	}

	async function runStep(step: Step): Promise<boolean> {
		busy = true;
		try {
			const { flow: f, ctx: c } = await ensureFlow();
			const log = begin(step.label);
			const t0 = performance.now();
			try {
				await step.run(f, c, log);
				const b = await f.balances(c);
				log.notes.push(`lamports: ${Object.entries(b).map(([k, v]) => `${k}=${v}`).join(' ')}`);
				finish(log, t0);
				return true;
			} catch (e) {
				console.error(e);
				finish(log, t0, e);
				return false;
			}
		} finally {
			busy = false;
		}
	}

	async function runAll() {
		for (const step of STEPS) if (!(await runStep(step))) return;
	}

	async function showBalances() {
		busy = true;
		const log = begin('balances');
		const t0 = performance.now();
		try {
			const { flow: f, ctx: c } = await ensureFlow();
			const b = await f.balances(c);
			log.notes.push(`lamports: ${Object.entries(b).map(([k, v]) => `${k}=${v}`).join(' ')}`);
			finish(log, t0);
		} catch (e) {
			finish(log, t0, e);
		} finally {
			busy = false;
		}
	}

	function newCycle() {
		stored = reset();
		ctx = null;
		logs = [];
	}

	const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

	function logText(): string {
		return logs
			.map((l) =>
				[
					`## ${l.step} [${l.status}] elapsed=${l.elapsedMs ?? '-'}ms proof=${l.proofMs ?? '-'}ms txs=${l.signatures.length} wire=${l.wireSizes.join(',') || '-'}`,
					...l.signatures.map((s) => `  sig ${s}`),
					...l.notes.map((n) => `  ${n}`),
					...(l.error ? [`  ERROR ${l.error}`] : [])
				].join('\n')
			)
			.join('\n');
	}
</script>

<main>
	<h1>CT DvP browser prototype</h1>
	<p class="meta">
		nonce {stored.nonce} · mint A {stored.mintA ?? '-'} · mint B {stored.mintB ?? '-'}
	</p>
	<div class="buttons">
		{#each STEPS as step (step.id)}
			<button disabled={busy} onclick={() => runStep(step)}>{step.label}</button>
		{/each}
		<button disabled={busy} onclick={runAll}>Run all</button>
		<button disabled={busy} onclick={showBalances}>Balances</button>
		<button disabled={busy} onclick={newCycle}>New cycle (reset roles)</button>
	</div>
	<p class="meta">Step 3 (shared seed) is generated with the roles and stored in localStorage.</p>

	<section class="log">
		{#each logs as l, i (i)}
			<div class="entry {l.status}">
				<strong>{l.step}</strong> [{l.status}] elapsed {l.elapsedMs ?? '-'} ms · proof {l.proofMs ?? '-'} ms
				· {l.signatures.length} tx · wire {l.wireSizes.join(', ') || '-'} B
				{#each l.signatures as s (s)}
					<div><a href={explorer(s)} target="_blank" rel="noreferrer">{s}</a></div>
				{/each}
				{#each l.notes as n, j (j)}
					<div class="note">{n}</div>
				{/each}
				{#if l.error}<pre class="err">{l.error}</pre>{/if}
			</div>
		{/each}
	</section>

	<h2>Plain-text log (copy this)</h2>
	<textarea readonly rows="16" value={logText()}></textarea>
</main>

<style>
	main {
		font-family: ui-monospace, monospace;
		font-size: 13px;
		max-width: 1100px;
		margin: 1rem auto;
	}
	.buttons {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}
	.meta {
		color: #666;
		word-break: break-all;
	}
	.entry {
		border-left: 3px solid #999;
		padding: 0.3rem 0.6rem;
		margin: 0.4rem 0;
		word-break: break-all;
	}
	.entry.ok {
		border-color: #2a2;
	}
	.entry.error {
		border-color: #c22;
	}
	.entry.running {
		border-color: #c90;
	}
	.err {
		color: #c22;
		white-space: pre-wrap;
	}
	textarea {
		width: 100%;
		font: inherit;
	}
</style>
