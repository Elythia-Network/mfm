import * as mfmjs from 'mfm-js';
import { describe, expect, expectTypeOf, test } from 'vitest';
import * as mfm from '../src/index.js';

describe('public API', () => {
	test('exports the same values as mfm-js 0.26.0', () => {
		expect(Object.keys(mfm).sort()).toEqual(Object.keys(mfmjs).sort());
		for (const key of Object.keys(mfmjs)) {
			expect(typeof (mfm as Record<string, unknown>)[key], key).toBe(typeof (mfmjs as Record<string, unknown>)[key]);
		}
	});

	test('node constructors build the same objects as mfm-js', () => {
		const t = mfm.TEXT('t');
		const cases: [unknown, unknown][] = [
			[mfm.QUOTE([t]), mfmjs.QUOTE([t])],
			[mfm.SEARCH('q', 'q 検索'), mfmjs.SEARCH('q', 'q 検索')],
			[mfm.CODE_BLOCK('c', null), mfmjs.CODE_BLOCK('c', null)],
			[mfm.CODE_BLOCK('c', 'js'), mfmjs.CODE_BLOCK('c', 'js')],
			[mfm.MATH_BLOCK('x'), mfmjs.MATH_BLOCK('x')],
			[mfm.CENTER([t]), mfmjs.CENTER([t])],
			[mfm.UNI_EMOJI('😀'), mfmjs.UNI_EMOJI('😀')],
			[mfm.EMOJI_CODE('e'), mfmjs.EMOJI_CODE('e')],
			[mfm.BOLD([t]), mfmjs.BOLD([t])],
			[mfm.SMALL([t]), mfmjs.SMALL([t])],
			[mfm.ITALIC([t]), mfmjs.ITALIC([t])],
			[mfm.STRIKE([t]), mfmjs.STRIKE([t])],
			[mfm.INLINE_CODE('c'), mfmjs.INLINE_CODE('c')],
			[mfm.MATH_INLINE('x'), mfmjs.MATH_INLINE('x')],
			[mfm.MENTION('a', null, '@a'), mfmjs.MENTION('a', null, '@a')],
			[mfm.MENTION('a', 'h', '@a@h'), mfmjs.MENTION('a', 'h', '@a@h')],
			[mfm.HASHTAG('h'), mfmjs.HASHTAG('h')],
			[mfm.N_URL('https://a'), mfmjs.N_URL('https://a')],
			[mfm.N_URL('https://a', false), mfmjs.N_URL('https://a', false)],
			[mfm.N_URL('https://a', true), mfmjs.N_URL('https://a', true)],
			[mfm.LINK(true, 'https://a', [t]), mfmjs.LINK(true, 'https://a', [t])],
			[mfm.FN('x', { a: '1', b: true }, [t]), mfmjs.FN('x', { a: '1', b: true }, [t])],
			[mfm.PLAIN('p'), mfmjs.PLAIN('p')],
			[mfm.TEXT('t'), mfmjs.TEXT('t')],
		];
		for (const [ours, theirs] of cases) {
			// キーの順序まで同じ
			expect(JSON.stringify(ours)).toBe(JSON.stringify(theirs));
			expect(ours).toStrictEqual(theirs);
		}
		for (const [node] of cases) {
			const n = node as mfm.MfmNode;
			expect(mfm.isMfmBlock(n), n.type).toBe(mfmjs.isMfmBlock(n));
		}
	});

	test('toString throws on an unknown node like mfm-js', () => {
		const bad = { type: 'unknown' } as unknown as mfm.MfmNode;
		expect(() => mfm.toString(bad)).toThrow('unknown mfm node');
		expect(() => mfmjs.toString(bad)).toThrow('unknown mfm node');
	});

	test('the types are the same as mfm-js 0.26.0', () => {
		// 型はtscの検査(npm run typecheck)で比べる。実行時には何もしない
		expectTypeOf<mfm.MfmNode>().toEqualTypeOf<mfmjs.MfmNode>();
		expectTypeOf<mfm.MfmSimpleNode>().toEqualTypeOf<mfmjs.MfmSimpleNode>();
		expectTypeOf<mfm.MfmBlock>().toEqualTypeOf<mfmjs.MfmBlock>();
		expectTypeOf<mfm.MfmInline>().toEqualTypeOf<mfmjs.MfmInline>();
		expectTypeOf<mfm.MfmQuote>().toEqualTypeOf<mfmjs.MfmQuote>();
		expectTypeOf<mfm.MfmSearch>().toEqualTypeOf<mfmjs.MfmSearch>();
		expectTypeOf<mfm.MfmCodeBlock>().toEqualTypeOf<mfmjs.MfmCodeBlock>();
		expectTypeOf<mfm.MfmMathBlock>().toEqualTypeOf<mfmjs.MfmMathBlock>();
		expectTypeOf<mfm.MfmCenter>().toEqualTypeOf<mfmjs.MfmCenter>();
		expectTypeOf<mfm.MfmUnicodeEmoji>().toEqualTypeOf<mfmjs.MfmUnicodeEmoji>();
		expectTypeOf<mfm.MfmEmojiCode>().toEqualTypeOf<mfmjs.MfmEmojiCode>();
		expectTypeOf<mfm.MfmBold>().toEqualTypeOf<mfmjs.MfmBold>();
		expectTypeOf<mfm.MfmSmall>().toEqualTypeOf<mfmjs.MfmSmall>();
		expectTypeOf<mfm.MfmItalic>().toEqualTypeOf<mfmjs.MfmItalic>();
		expectTypeOf<mfm.MfmStrike>().toEqualTypeOf<mfmjs.MfmStrike>();
		expectTypeOf<mfm.MfmInlineCode>().toEqualTypeOf<mfmjs.MfmInlineCode>();
		expectTypeOf<mfm.MfmMathInline>().toEqualTypeOf<mfmjs.MfmMathInline>();
		expectTypeOf<mfm.MfmMention>().toEqualTypeOf<mfmjs.MfmMention>();
		expectTypeOf<mfm.MfmHashtag>().toEqualTypeOf<mfmjs.MfmHashtag>();
		expectTypeOf<mfm.MfmUrl>().toEqualTypeOf<mfmjs.MfmUrl>();
		expectTypeOf<mfm.MfmLink>().toEqualTypeOf<mfmjs.MfmLink>();
		expectTypeOf<mfm.MfmFn>().toEqualTypeOf<mfmjs.MfmFn>();
		expectTypeOf<mfm.MfmPlain>().toEqualTypeOf<mfmjs.MfmPlain>();
		expectTypeOf<mfm.MfmText>().toEqualTypeOf<mfmjs.MfmText>();
		expectTypeOf<mfm.NodeType<'fn'>>().toEqualTypeOf<mfmjs.NodeType<'fn'>>();
		expectTypeOf<mfm.NodeType<'quote'>>().toEqualTypeOf<mfmjs.NodeType<'quote'>>();
		expectTypeOf(mfm.parse).toEqualTypeOf(mfmjs.parse);
		expectTypeOf(mfm.parseSimple).toEqualTypeOf(mfmjs.parseSimple);
		expectTypeOf(mfm.toString).toEqualTypeOf(mfmjs.toString);
		expectTypeOf(mfm.inspect).toEqualTypeOf(mfmjs.inspect);
		expectTypeOf(mfm.extract).toEqualTypeOf(mfmjs.extract);
		expectTypeOf(mfm.isMfmBlock).toEqualTypeOf(mfmjs.isMfmBlock);
		expectTypeOf(mfm.QUOTE).toEqualTypeOf(mfmjs.QUOTE);
		expectTypeOf(mfm.SEARCH).toEqualTypeOf(mfmjs.SEARCH);
		expectTypeOf(mfm.CODE_BLOCK).toEqualTypeOf(mfmjs.CODE_BLOCK);
		expectTypeOf(mfm.MATH_BLOCK).toEqualTypeOf(mfmjs.MATH_BLOCK);
		expectTypeOf(mfm.CENTER).toEqualTypeOf(mfmjs.CENTER);
		expectTypeOf(mfm.UNI_EMOJI).toEqualTypeOf(mfmjs.UNI_EMOJI);
		expectTypeOf(mfm.EMOJI_CODE).toEqualTypeOf(mfmjs.EMOJI_CODE);
		expectTypeOf(mfm.BOLD).toEqualTypeOf(mfmjs.BOLD);
		expectTypeOf(mfm.SMALL).toEqualTypeOf(mfmjs.SMALL);
		expectTypeOf(mfm.ITALIC).toEqualTypeOf(mfmjs.ITALIC);
		expectTypeOf(mfm.STRIKE).toEqualTypeOf(mfmjs.STRIKE);
		expectTypeOf(mfm.INLINE_CODE).toEqualTypeOf(mfmjs.INLINE_CODE);
		expectTypeOf(mfm.MATH_INLINE).toEqualTypeOf(mfmjs.MATH_INLINE);
		expectTypeOf(mfm.MENTION).toEqualTypeOf(mfmjs.MENTION);
		expectTypeOf(mfm.HASHTAG).toEqualTypeOf(mfmjs.HASHTAG);
		expectTypeOf(mfm.N_URL).toEqualTypeOf(mfmjs.N_URL);
		expectTypeOf(mfm.LINK).toEqualTypeOf(mfmjs.LINK);
		expectTypeOf(mfm.FN).toEqualTypeOf(mfmjs.FN);
		expectTypeOf(mfm.PLAIN).toEqualTypeOf(mfmjs.PLAIN);
		expectTypeOf(mfm.TEXT).toEqualTypeOf(mfmjs.TEXT);
	});
});
