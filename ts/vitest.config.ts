import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		alias: {
			// 比べる相手のmfm-js 0.26.0は tools/ に固定したものを使う (tools/ で npm ci が要る)
			'mfm-js': fileURLToPath(new URL('../tools/node_modules/mfm-js/built/index.mjs', import.meta.url)),
		},
	},
	test: {
		include: ['test/**/*.test.ts'],
		testTimeout: 120_000,
	},
});
