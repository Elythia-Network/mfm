import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { parse, parseSimple } from '../src/index.js';
import type { MfmNode, MfmSimpleNode } from '../src/index.js';
import { MAX_NEST_LIMIT } from '../src/internal/parser.js';
import { codeUnits, fragments, parseWithState } from './helpers.js';

/** MFM-like inputs: fragments, code points and arbitrary code units, including lone surrogates. */
const mfmInput = fc.oneof(
	fc.array(fc.constantFrom(...fragments), { maxLength: 40 }).map((xs) => xs.join('')),
	fc.array(fc.oneof(fc.constantFrom(...fragments), fc.string({ unit: 'binary', maxLength: 4 })), { maxLength: 40 }).map((xs) => xs.join('')),
	fc.string({ unit: 'binary', maxLength: 200 }),
	codeUnits,
);

/** Rebuilds the source of a parseSimple tree of an input without <plain>. */
function simpleSource(nodes: MfmSimpleNode[]): string {
	return nodes.map((n) => {
		switch (n.type) {
			case 'text': return n.props.text;
			case 'unicodeEmoji': return n.props.emoji;
			case 'emojiCode': return `:${n.props.name}:`;
			default: return `<${n.type}>`;
		}
	}).join('');
}

/** Concatenates every string prop of the tree. */
function stringsOf(nodes: MfmNode[]): string {
	let s = '';
	const walk = (ns: MfmNode[]): void => {
		for (const n of ns) {
			for (const v of Object.values(n.props ?? {})) {
				if (typeof v === 'string') s += v;
			}
			if (n.children) walk(n.children);
		}
	};
	walk(nodes);
	return s;
}

describe('fuzz', () => {
	test('parsing never throws and stays within the linear work bound', () => {
		fc.assert(fc.property(mfmInput, fc.integer({ min: -2, max: 30 }), fc.boolean(), (input, nestLimit, spent) => {
			for (const simple of [false, true]) {
				const limit = simple ? 20 : Math.max(nestLimit, 0);
				// 半分は仕事量を使い切った状態から読み、上限の後の振る舞いも試す
				const { state, nodes } = parseWithState(input, simple, limit, (s) => {
					if (spent) s.budget.limit = 0;
				});
				// 上限に届いた後も、深さごとに高々1つの子のループが残りを読むだけ
				const bound = state.budget.limit + 2 * (state.nestLimit + 2) * (input.length + 1);
				expect(state.budget.used).toBeLessThanOrEqual(bound);
				expect(state.budget.memUsed).toBeLessThanOrEqual(state.budget.memLimit);
				expect(() => JSON.stringify(nodes)).not.toThrow();
			}
			expect(Array.isArray(parse(input, { nestLimit }))).toBe(true);
		}), { numRuns: 2000 });
	});

	test('parseSimple keeps every character of an input without <plain>', () => {
		fc.assert(fc.property(mfmInput, (input) => {
			fc.pre(!input.includes('<plain>'));
			expect(simpleSource(parseSimple(input))).toBe(input);
		}), { numRuns: 2000 });
	});

	test('every string in the tree comes from the input', () => {
		// 木の文字列は入力の部分文字列を並べたもの。例外はbigの"tada"と、引用の行を
		// つなぐ"\n"(mfm-jsと同じく、行の区切りがCRでもLFでつなぐ)。入力に無い
		// コードユニットが混ざれば、サロゲートの扱いなどで文字を作っている
		fc.assert(fc.property(mfmInput, (input) => {
			for (const u of stringsOf(parse(input)).replaceAll('tada', '').replaceAll('\n', '').split('')) {
				expect(input.includes(u), JSON.stringify(u)).toBe(true);
			}
		}), { numRuns: 2000 });
	});

	test('deep nesting up to the nest limit parses without a stack overflow', () => {
		// 入れ子は再帰で読むので、上限(MAX_NEST_LIMIT)までの深さでスタックが溢れないことを
		// 確かめる。vitestの中はJITの前の大きなフレームで動くので、余裕の目安にもなる
		const d = MAX_NEST_LIMIT;
		for (const input of [
			'<b>'.repeat(d) + 'a' + '</b>'.repeat(d),
			'$[x '.repeat(d) + 'a' + ']'.repeat(d),
			'>'.repeat(d) + ' a',
			'<b>$[x ~~<i>'.repeat(d / 4) + 'a' + '</i>~~]</b>'.repeat(d / 4),
			'[' + '<i>'.repeat(d) + 'a' + '</i>'.repeat(d) + '](https://a)',
			'<b>'.repeat(d) + 'a',
			'#a' + '('.repeat(d) + ')'.repeat(d),
			'https://a' + '['.repeat(d) + ']'.repeat(d),
		]) {
			expect(() => parse(input, { nestLimit: d })).not.toThrow();
		}
	});
});
