import fc from 'fast-check';
import * as mfmjs from 'mfm-js';
import { describe, expect, test } from 'vitest';
import * as mfm from '../src/index.js';
import { codeUnits, fragments, randomInputs } from './helpers.js';

// tools/ の mfm-js 0.26.0 と、ランダムな入力で木を突き合わせる。入力は断片を高々
// 16個つなげた短いものにする

/** Asserts that both parsers give the same tree, keys in the same order. */
function same(input: string, opts?: { nestLimit: number }): void {
	expect(JSON.stringify(mfm.parse(input, opts)), JSON.stringify({ input, opts })).toBe(JSON.stringify(mfmjs.parse(input, opts)));
	expect(JSON.stringify(mfm.parseSimple(input)), JSON.stringify({ input, simple: true })).toBe(JSON.stringify(mfmjs.parseSimple(input)));
}

describe('differential against mfm-js 0.26.0', () => {
	test('the comparison target is mfm-js 0.26.0', async () => {
		const { readFileSync } = await import('node:fs');
		const pkg = JSON.parse(readFileSync(new URL('../../tools/node_modules/mfm-js/package.json', import.meta.url), 'utf8')) as { version: string };
		expect(pkg.version).toBe('0.26.0');
	});

	test('seeded random inputs', () => {
		for (const input of randomInputs(4000, 3513, 16)) {
			same(input);
		}
	});

	test('random inputs with random nest limits', () => {
		fc.assert(fc.property(
			fc.array(fc.constantFrom(...fragments), { minLength: 1, maxLength: 16 }).map((xs) => xs.join('')),
			fc.integer({ min: 0, max: 6 }),
			(input, nestLimit) => same(input, { nestLimit }),
		), { numRuns: 3000 });
	});

	test('random code units', () => {
		// fc.stringは対になっていないサロゲートを作らないので、コードユニットから組み立てる
		fc.assert(fc.property(codeUnits, (input) => same(input)), { numRuns: 3000 });
	});

	test('toString, inspect and extract on mfm-js trees', () => {
		for (const input of randomInputs(2000, 1033, 12)) {
			const tree = mfmjs.parse(input);
			expect(mfm.toString(tree), JSON.stringify(input)).toBe(mfmjs.toString(tree));
			for (const node of tree) {
				expect(mfm.toString(node)).toBe(mfmjs.toString(node));
			}
			const seen: mfm.MfmNode[] = [];
			const seenJs: mfmjs.MfmNode[] = [];
			mfm.inspect(tree, (n) => seen.push(n));
			mfmjs.inspect(tree, (n) => seenJs.push(n));
			expect(seen).toEqual(seenJs);
			if (tree.length > 0) {
				const one: mfm.MfmNode[] = [];
				const oneJs: mfmjs.MfmNode[] = [];
				mfm.inspect(tree[0], (n) => one.push(n));
				mfmjs.inspect(tree[0], (n) => oneJs.push(n));
				expect(one).toEqual(oneJs);
			}
			const pred = (n: mfm.MfmNode): boolean => n.type === 'text' || n.type === 'hashtag';
			expect(mfm.extract(tree, pred)).toEqual(mfmjs.extract(tree, pred));
		}
	});

	test('nestLimit options read like mfm-js', () => {
		const inputs = ['<b><b><b>a</b></b></b>', '$[x $[y $[z a]]]', '>>> a', '#a((b))', 'https://e.x/((a))', '[<i><b>a</b></i>](https://e.x)'];
		const limits: unknown[] = [undefined, null, 0, 1, 2, 2.5, 1.0001, -1, -Infinity, Infinity, NaN, '2', '', 1e9];
		for (const input of inputs) {
			for (const nestLimit of limits) {
				const opts = { nestLimit } as { nestLimit: number };
				expect(JSON.stringify(mfm.parse(input, opts)), `${input} ${String(nestLimit)}`).toBe(JSON.stringify(mfmjs.parse(input, opts)));
			}
			expect(JSON.stringify(mfm.parse(input, {}))).toBe(JSON.stringify(mfmjs.parse(input, {})));
		}
	});
});
