import { describe, expect, test } from 'vitest';
import { parse } from '../src/index.js';
import { exhausted } from '../src/internal/memo.js';
import { fill, parseWithState, stressUnits } from './helpers.js';

/** Parses input and returns the work and memo bytes it charged. */
function workAndMemo(input: string, simple: boolean): { work: number; memo: number } {
	const { state } = parseWithState(input, simple);
	// 上限に届くと以降は1文字ずつ読むだけになり、どんな入力でも線形に見えてしまう。
	// 上限に届かない大きさで比べる
	expect(exhausted(state.budget), `the work budget must not cut the parse short (${state.budget.used} of ${state.budget.limit})`).toBe(false);
	return { work: state.budget.used, memo: state.budget.memUsed };
}

describe('linear work and memory', () => {
	// 仕事量とメモの量は実行のたびに同じ値になるので、時間と違って負荷で揺れない
	test.each(Object.entries(stressUnits))('%s grows linearly', (_name, unit) => {
		const n = 4 << 10;
		for (const simple of [false, true]) {
			const small = fill('', unit, n);
			const large = fill('', unit, 4 * n);
			const a = workAndMemo(small, simple);
			const b = workAndMemo(large, simple);
			const ratio = large.length / small.length;
			// 線形なら比は入力長の比(約4)に、2乗なら約16になる
			expect(b.work, `work (simple=${simple})`).toBeLessThanOrEqual(1.25 * ratio * a.work);
			expect(b.memo, `memo (simple=${simple})`).toBeLessThanOrEqual(1.5 * ratio * a.memo + 4096);
		}
	});

	test.each(Object.entries(stressUnits))('%s stays under a fixed work per code unit', (_name, unit) => {
		const input = fill('', unit, 16 << 10);
		const { work, memo } = workAndMemo(input, false);
		expect(work).toBeLessThan(64 * input.length);
		expect(memo).toBeLessThan(512 * input.length);
	});

	test('fill repeats whole units up to about the requested length', () => {
		expect(fill('<b>', 'ab', 9)).toBe('<b>ababab');
		expect(fill('<b>', 'ab', 10)).toBe('<b>ababab');
		expect(fill('', '<center>a\n', 4 << 10).startsWith('<center>a\n<center>')).toBe(true);
		expect(Math.abs(fill('', '<center>a\n', 4 << 10).length - (4 << 10))).toBeLessThanOrEqual(10);
	});
});

/** Returns the shortest of several measured durations of parse(input), in milliseconds. */
function parseTime(input: string): number {
	let best = Infinity;
	for (let i = 0; i < 5; i++) {
		const start = performance.now();
		parse(input);
		best = Math.min(best, performance.now() - start);
	}
	return best;
}

// 時間は負荷で揺れるので、仕事量のテストより緩い比で見る。MFM_SKIP_TIMINGで飛ばせる
describe.skipIf(process.env.MFM_SKIP_TIMING)('linear time', () => {
	test.each(['unclosed bold tag', 'unclosed link label', 'unclosed center', 'unclosed plain', 'nested quotes', 'mixed'])('%s takes linear time', (name) => {
		const unit = stressUnits[name];
		const n = 8 << 10;
		const small = fill('', unit, n);
		const large = fill('', unit, 4 * n);
		// JITと絵文字の正規表現の初回の費用を外す
		parse(small);
		parse(large);
		const t1 = parseTime(small);
		const t4 = parseTime(large);
		expect(t4, `${t1}ms -> ${t4}ms`).toBeLessThan(8 * t1 + 1);
	});
});
