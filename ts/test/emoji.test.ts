import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { parse } from '../src/index.js';
import { emojiFirstUnits, emojiRegex } from '../src/emoji-regex.gen.js';

describe('emoji pattern', () => {
	test('is the regex of the emoji-data mfm-js 0.26.0 depends on', async () => {
		// 生成物の鮮度はtools/emojiregex -checkが見る。ここでは中身が同じ正規表現であることを見る
		const pkg = JSON.parse(readFileSync(new URL('../../tools/node_modules/@misskey-dev/emoji-data/package.json', import.meta.url), 'utf8')) as { version: string };
		expect(pkg.version).toBe('17.0.0');
		const data = await import(new URL('../../tools/node_modules/@misskey-dev/emoji-data/built/regex.mjs', import.meta.url).href) as { emojiRegex: RegExp };
		expect(emojiRegex.source).toBe(data.emojiRegex.source);
		expect(emojiRegex.flags).toBe('y');
	});

	test('every match starts with one of the listed code units', () => {
		const first = new Set<number>();
		for (let i = 0; i + 1 < emojiFirstUnits.length; i += 2) {
			// 範囲は昇順で重ならない
			expect(emojiFirstUnits[i]).toBeLessThanOrEqual(emojiFirstUnits[i + 1]);
			if (i > 0) expect(emojiFirstUnits[i]).toBeGreaterThan(emojiFirstUnits[i - 1] + 1);
			for (let u = emojiFirstUnits[i]; u <= emojiFirstUnits[i + 1]; u++) first.add(u);
		}
		// 全てのコードポイントについて、続く文字(異体字セレクタや結合子)があっても無くても、
		// 一覧の外の文字から始まる一致が無いことを確かめる
		const re = new RegExp(emojiRegex.source, 'y');
		let matched = 0;
		for (let cp = 0; cp <= 0x10ffff; cp++) {
			const s = String.fromCodePoint(cp);
			for (const tail of ['', '\ufe0f\u20e3', '\u200d❤']) {
				re.lastIndex = 0;
				if (re.test(s + tail)) {
					matched++;
					expect(first.has(s.charCodeAt(0)), cp.toString(16)).toBe(true);
				}
			}
		}
		// 一覧が空振りして何も試さずに緑にならないよう、一致の数に下限を置く
		expect(matched).toBeGreaterThan(1000);
	});

	test('U+FE0F alone is text, as in mfm-js', () => {
		expect(parse('\ufe0f')).toStrictEqual([{ type: 'text', props: { text: '\ufe0f' } }]);
		expect(parse('a\ufe0fb')).toStrictEqual([{ type: 'text', props: { text: 'a\ufe0fb' } }]);
	});
});
