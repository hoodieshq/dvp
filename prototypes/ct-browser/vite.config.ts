import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';

// Packages that must resolve to a single copy: the DvP client source lives
// outside this app and would otherwise pick up the repo root node_modules,
// loading a second kit and, worse, a second zk-sdk WASM instance.
const SINGLETONS = [
	'@solana/kit',
	'@solana/zk-sdk',
	'@solana-program/system',
	'@solana-program/token',
	'@solana-program/token-2022',
	'@solana-program/zk-elgamal-proof'
];

export default defineConfig({
	plugins: [wasm(), sveltekit()],
	resolve: { dedupe: SINGLETONS },
	// zk-sdk's bundler build imports its .wasm as an ES module; keep it out of
	// esbuild prebundling so vite-plugin-wasm handles it.
	optimizeDeps: { exclude: ['@solana/zk-sdk'] },
	build: { target: 'esnext' },
	worker: { format: 'es' },
	server: { fs: { allow: ['../..'] } }
});
