/**
 * Bun preload for scripts/smoke.ts: resolves SvelteKit aliases and pins every
 * Solana package to this app's node_modules (the DvP client source would
 * otherwise load the repo root copies, i.e. a second zk-sdk WASM instance).
 */
import { plugin } from 'bun';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(app, '..', '..');

plugin({
	name: 'ct-browser-harness',
	setup(build) {
		build.module('$env/dynamic/private', () => ({
			exports: { env: process.env },
			loader: 'object'
		}));
		build.onResolve({ filter: /^\$lib(\/.*)?$/ }, (args) => ({
			path: Bun.resolveSync('.' + args.path.slice(4), join(app, 'src', 'lib')),
			namespace: 'file'
		}));
		build.onResolve({ filter: /^\$dvp(\/.*)?$/ }, (args) => ({
			path: Bun.resolveSync(
				'.' + (args.path.slice(4) || '/index'),
				join(repo, 'clients', 'typescript', 'src')
			),
			namespace: 'file'
		}));
		build.onResolve({ filter: /^@solana(-program)?\// }, (args) => ({
			path: Bun.resolveSync(args.path, app),
			namespace: 'file'
		}));
	}
});
