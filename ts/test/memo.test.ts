import { describe, expect, test } from 'vitest';
import * as mfmjs from 'mfm-js';
import { parse, TEXT } from '../src/index.js';
import type { MfmNode } from '../src/index.js';
import {
	exhausted, goAppendCap, MEMO_BYTES_BASE, MEMO_ENTRY_SIZE, MemoTable, NUM_SCAN_KINDS, oneKey, SCAN_BOLD, SCAN_FN, SCAN_ITALIC,
	scanKey, SPARSE_ENTRY_SIZE, SPARSE_MAX,
} from '../src/internal/memo.js';
import type { WorkBudget } from '../src/internal/memo.js';
import { MAX_NEST_LIMIT } from '../src/internal/parser.js';
import { fill, parseWithState, textOf } from './helpers.js';

function nestedUnit(open: string, close: string, depth: number, s: string): string {
	return open.repeat(depth) + s + close.repeat(depth);
}

// Ordinary posts with nesting up to the default limit, every construct closed.
const wellFormedUnits: Record<string, string> = {
	'nested fn': nestedUnit('$[x2 ', ']', 19, 'a') + ' ',
	'nested bold': nestedUnit('<b>', '</b>', 19, 'a') + '\n',
	'bold in quote': '> ' + nestedUnit('<b>', '</b>', 15, 'a') + '\n\n',
	'italic in link': '[' + nestedUnit('<i>', '</i>', 18, 'a') + '](https://e.x) ',
	'mixed decorations': '**<i>~~$[x2 [<small>a</small>](https://e.x)]~~</i>** #t @u :e: https://e.x/(a)\n',
};

const nonText = (nodes: MfmNode[]): number => nodes.filter((n) => n.type !== 'text').length;

function budget(): WorkBudget {
	return { used: 0, limit: 1 << 20, memUsed: 0, memLimit: 1 << 20 };
}

describe('memo', () => {
	// 閉じた深い入れ子は上限に届かない。届くと以降がテキストになりmfm-jsと食い違う
	test.each(Object.entries(wellFormedUnits))('256K code units of %s stay under the limits', (_name, unit) => {
		const n = Math.floor((256 << 10) / unit.length);
		const input = unit.repeat(n);
		const { state, nodes } = parseWithState(input);
		expect(exhausted(state.budget)).toBe(false);
		expect(state.budget.memUsed).toBeLessThan(MEMO_BYTES_BASE);
		expect(state.budget.used).toBeLessThan(4 * input.length);
		expect(nonText(nodes)).toBe(nonText(parse(unit)) * n);
	});

	test('running out of memo storage reads the rest as text', () => {
		const input = wellFormedUnits['nested bold'].repeat(2000);
		const { state, nodes } = parseWithState(input, false, 20, (s) => {
			s.budget.memLimit = 64 << 10;
		});
		expect(state.budget.memUsed).toBeLessThanOrEqual(state.budget.memLimit);
		expect(exhausted(state.budget)).toBe(true);
		const last = textOf(nodes.at(-1));
		// 上限に届いた後は残りを1文字ずつ読むので、最後のテキストは入力の末尾で終わる
		expect(input.endsWith(last)).toBe(true);
		expect(last.length).toBeGreaterThan(input.length / 2);
	});

	test('quotes nested up to the nest limit keep their own tables small', () => {
		const depth = MAX_NEST_LIMIT - 1;
		const { state, nodes } = parseWithState('>'.repeat(depth) + ' a', false, MAX_NEST_LIMIT);
		expect(exhausted(state.budget)).toBe(false);
		expect(state.budget.memUsed).toBeLessThan(8 << 20);
		let quotes = 0;
		let cur = nodes;
		while (cur.length === 1 && cur[0].type === 'quote') {
			quotes++;
			cur = cur[0].children;
		}
		expect(quotes).toBe(depth);
		expect(cur).toStrictEqual([TEXT('a')]);
	});

	test('a sparse page becomes dense after SPARSE_MAX results', () => {
		const b = budget();
		const m = new MemoTable(1000, 20, b);
		const k1 = oneKey(1, false, false);
		const k2 = oneKey(2, true, false);
		const nodes = Array.from({ length: SPARSE_MAX + 5 }, (_, i) => TEXT(String.fromCharCode(0x61 + i)));
		let conversion = 0;
		nodes.forEach((n, i) => {
			const before = b.memUsed;
			m.storeOne(3 * i, k1, n, 3 * i + 1);
			if (i === SPARSE_MAX) conversion = b.memUsed - before;
		});
		// 配列に変えるときは配列の分を数え、手放す並びの分を差し引く
		expect(conversion).toBe(m.pageLen(0) * MEMO_ENTRY_SIZE - SPARSE_MAX * SPARSE_ENTRY_SIZE);
		m.storeOne(3, k1, nodes[1], 99);
		m.storeOne(5, k2, nodes[2], 9);
		m.storeOne(5, k2, nodes[0], 6);
		nodes.forEach((n, i) => {
			expect(m.lookupOne(3 * i, k1)).toBe(n);
			expect(m.hitEnd).toBe(i === 1 ? 99 : 3 * i + 1);
		});
		expect(m.lookupOne(1, k1), 'empty cell of a dense page').toBeNull();
		expect(m.lookupOne(3, k2), 'other context').toBeNull();
		expect(m.lookupOne(5, k2)).toBe(nodes[0]);
		expect(m.hitEnd).toBe(6);
		expect(m.lookupOne(1001, k1), 'out of range').toBeNull();
		expect(m.slotAt(k1 - 1)!.one[0]!.dense).toBe(true);
		expect(m.slotAt(k2 - 1)!.one[0]!.dense).toBe(false);
		expect(m.slotAt(k2 - 1)!.one[0]!.count).toBe(1);

		const s1 = scanKey(1, false, false, SCAN_BOLD);
		const s2 = scanKey(1, false, false, SCAN_ITALIC);
		expect(s1).not.toBe(s2);
		for (let i = 0; i < SPARSE_MAX + 5; i++) m.storeScan(2 * i, s1, 2 * i + 7);
		m.storeScan(2, s1, 50);
		m.storeScan(4, s2, 9);
		m.storeScan(4, s2, 8);
		for (let i = 0; i < SPARSE_MAX + 5; i++) {
			expect(m.lookupScan(2 * i, s1)).toBe(i === 1 ? 50 : 2 * i + 7);
		}
		expect(m.lookupScan(4, s2)).toBe(8);
		expect(m.lookupScan(1, s1)).toBe(-1);
		expect(m.lookupScan(6, s2)).toBe(-1);
		expect(m.lookupScan(0, scanKey(5, false, false, SCAN_BOLD)), 'unallocated slot').toBe(-1);
		expect(m.lookupScan(0, scanKey(1, false, false, SCAN_FN)), 'unused kind').toBe(-1);

		// 鍵は深さの上限まで重ならず、0にならない
		const seen = new Set<number>();
		for (let d = 0; d <= MAX_NEST_LIMIT; d++) {
			for (const inLink of [false, true]) {
				for (const atFull of [false, true]) {
					for (let k = 0; k < NUM_SCAN_KINDS; k++) {
						const key = scanKey(d, inLink, atFull, k);
						expect(key).not.toBe(0);
						expect(seen.has(key)).toBe(false);
						seen.add(key);
					}
				}
			}
		}
	});

	test('slots grow towards both ends', () => {
		const m = new MemoTable(10, 20, budget());
		const deep = oneKey(15, false, true);
		const shallow = oneKey(2, false, false);
		m.storeOne(1, deep, TEXT('d'), 2);
		expect(m.slotBase).toBe(deep - 1);
		expect(m.slots!.length, 'no slots below the first one used').toBe(1);
		m.storeOne(1, shallow, TEXT('s'), 3);
		expect(m.slotBase).toBe(shallow - 1);
		expect(m.lookupOne(1, deep)).toStrictEqual(TEXT('d'));
		expect(m.hitEnd).toBe(2);
		expect(m.lookupOne(1, shallow)).toStrictEqual(TEXT('s'));
		expect(m.slot(-1, true)).toBeUndefined();
		expect(m.slot(21 * 4, true), 'beyond the nest limit').toBeUndefined();
	});

	test('short quote blocks cost what the README says', () => {
		let input = '> a\n\n'.repeat(Math.floor((64 << 10) / 5));
		let { state } = parseWithState(input);
		expect(exhausted(state.budget)).toBe(false);
		expect(state.budget.memUsed).toBeLessThan(110 * input.length);

		const unit = '>'.repeat(20) + 'a\n\n';
		input = unit.repeat(Math.floor(3000 / unit.length));
		({ state } = parseWithState(input));
		expect(exhausted(state.budget)).toBe(false);
		expect(state.budget.memUsed).toBeLessThan(3 << 19);
	});

	// 表の鍵の各軸(inLinkと深さ)が結果を変える入力。軸を表の鍵から外すと出力が
	// mfm-jsと変わる(Go版のTestParse_MemoKeyGoldenと同じ入力)
	test.each([
		['inLink axis', '<center>' + nestedUnit('<b>', '</b>', 18, '[#t](https://e.x/((a)))')],
		['depth axis', '<center>' + nestedUnit('<b>', '</b>', 18, '#a((b))')],
		['top level axis', (() => {
			const q = '>'.repeat(18) + ' ';
			return '<center>\n' + q + '<center>`</center>`\n' + q + '<center>y</center>\n' + q + '</center>';
		})()],
	])('the memo key keeps the %s', (_name, input) => {
		expect(JSON.stringify(parse(input))).toBe(JSON.stringify(mfmjs.parse(input)));
	});
	// 仕事量とメモの確保量はGo版と同じ単位で数える。期待値はGo版(リポジトリ直下)で
	// newState(in, simple)からparseNodes(false)を回したときのbudget.usedとbudget.memUsedで、
	// Go 1.27.2 linux/amd64で測った。ASCIIの入力では一致し、上限に届く位置も同じになる
	test.each([
		['mixed', fill('', '<b>**~~$[x [<small><i>\\[`<plain>\\(', 3000), 11744, 46460, 6248],
		['url alt', fill('', '[a](<https://x\n', 3000), 11786, 67840, 6000],
		['quote lines', fill('', '> <b>\n', 3000), 3925, 25593, 6000],
		['labels sharing a url', '['.repeat(1000) + 'a](https://' + 'x'.repeat(1978), 512470, 23274, 5978],
		['code blocks', fill('', '```a\n', 3000), 14394, 0, 6000],
		['center lines', fill('', '<center>a\n', 3000), 19173, 61676, 6000],
		['closed nesting', (nestedUnit('<b>', '</b>', 19, 'a') + '\n').repeat(40), 8506, 70808, 10800],
		['over the limits', fill('', '</b><plain><https://a$[x.a=1 ', 70000), 4392574, 16777215, 147193],
	])('%s counts the same work and memo as the Go parser', (_name, input, work, memo, simpleWork) => {
		const full = parseWithState(input).state;
		expect(full.budget.used).toBe(work);
		expect(full.budget.memUsed).toBe(memo);
		const simple = parseWithState(input, true).state;
		expect(simple.budget.used).toBe(simpleWork);
		expect(simple.budget.memUsed).toBe(0);
	});

	test('the stop index is charged with the capacity of a Go slice', () => {
		// Goで[]int32に1つずつappendしたときの容量(heapへ逃げるslice)を測った値
		const measured: [number, number][] = [
			[0, 0], [1, 2], [2, 2], [3, 4], [5, 8], [9, 16], [17, 32], [100, 128], [257, 512], [513, 864],
			[865, 1344], [1000, 1344], [2049, 3072], [5000, 5440], [32769, 43008], [70000, 88064],
			[438272, 438272], [8071169, 10090496], [19709953, 24639488],
		];
		for (const [n, cap] of measured) {
			expect(goAppendCap(n), String(n)).toBe(cap);
		}
	});
});
