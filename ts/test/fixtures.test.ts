import { describe, expect, test } from 'vitest';
import { extract, parse, parseSimple } from '../src/index.js';
import type { MfmNode } from '../src/index.js';
import { emojiDataVersion, emojiMfmJsVersion } from '../src/emoji-regex.gen.js';
import { fixtureNames, loadFixture, minCases } from './fixtures.js';
import type { FixtureCase } from './fixtures.js';

// The fixture cases where this package intentionally differs from mfm-js
// 0.26.0, with the reason. Each entry must exist and must still differ; the
// README lists the same differences.
const knownDifferences: Record<string, string> = {
	// 入れ子は再帰で読むので、nestLimitを500で頭打ちにする(Go版は1000)
	'differences/1ff08601427b': 'nestLimit above 500 is lowered to 500',
};

function run(c: FixtureCase): MfmNode[] {
	if (c.options.parser === 'simple') return parseSimple(c.input);
	if (c.options.nestLimit !== undefined) return parse(c.input, { nestLimit: c.options.nestLimit });
	return parse(c.input);
}

describe('testdata', () => {
	const names = fixtureNames();

	test('every fixture file is known and none is missing', () => {
		// 一覧が空振りして何も比べずに緑にならないよう、全部があることを確かめる
		expect(names).toEqual(Object.keys(minCases).sort());
	});

	for (const name of names.filter((n) => n !== 'extract.json')) {
		test(`${name} matches mfm-js 0.26.0`, () => {
			const f = loadFixture(name);
			// 正規表現と期待値は同じ版のmfm-js / emoji-dataから作る
			expect(f.mfmjs).toBe(emojiMfmJsVersion);
			expect(f.emojiData).toBe(emojiDataVersion);
			expect(f.cases.length).toBeGreaterThanOrEqual(minCases[name]);
			let mismatches = 0;
			for (const c of f.cases) {
				expect(['full', 'simple']).toContain(c.options.parser);
				const got = run(c);
				// キーの順序もmfm-jsと揃える(JSONの文字列で比べる)
				const equal = JSON.stringify(got) === JSON.stringify(c.output);
				if (c.name in knownDifferences) {
					expect(equal, `${c.name} matches mfm-js now; remove it from knownDifferences`).toBe(false);
					continue;
				}
				if (!equal) {
					mismatches++;
					expect.soft(got, `${c.name}: ${JSON.stringify(c.input)} ${JSON.stringify(c.options)}`).toStrictEqual(c.output);
					if (mismatches >= 30) throw new Error(`too many mismatches in ${name}`);
				}
			}
		});
	}

	test('every known difference is in testdata', () => {
		const all = new Set(names.flatMap((n) => loadFixture(n).cases.map((c) => c.name)));
		for (const name of Object.keys(knownDifferences)) {
			expect(all.has(name), name).toBe(true);
		}
	});

	test('extract.json matches mfm-js 0.26.0', () => {
		const f = loadFixture('extract.json');
		expect(f.cases.length).toBeGreaterThanOrEqual(minCases['extract.json']);
		const unique = (xs: string[]): string[] => [...new Set(xs)];
		const names = (nodes: MfmNode[], type: 'hashtag' | 'emojiCode'): string[] =>
			unique(extract(nodes, (n) => n.type === type).map((n) => {
				if (n.type === 'hashtag') return n.props.hashtag;
				if (n.type === 'emojiCode') return n.props.name;
				throw new Error('unexpected node');
			}));
		// MisskeyのextractCustomEmojisFromMfmと同じく、名前の長さ100以下だけを数える
		const custom = (nodes: MfmNode[]): string[] => names(nodes, 'emojiCode').filter((n) => n.length <= 100);
		let nonEmpty = 0;
		for (const c of f.cases) {
			const full = parse(c.input);
			expect(names(full, 'hashtag'), c.input).toEqual(c.hashtags);
			expect(names(full, 'emojiCode'), c.input).toEqual(c.emojiCodes);
			expect(custom(full), c.input).toEqual(c.customEmojis);
			expect(custom(parseSimple(c.input)), c.input).toEqual(c.customEmojisSimple);
			if (c.hashtags!.length > 0 && c.emojiCodes!.length > 0) nonEmpty++;
		}
		// 何も拾わない入力ばかりで緑にならないよう、両方を含む入力の数に下限を置く
		expect(nonEmpty).toBeGreaterThan(5);
	});
});
