import { mergeText, newState } from '../src/internal/parser.js';
import type { State } from '../src/internal/parser.js';
import { DEFAULT_NEST_LIMIT } from '../src/internal/parser.js';
import fc from 'fast-check';
import type { MfmNode } from '../src/index.js';

/** Repeats unit after prefix up to about n code units. */
export function fill(prefix: string, unit: string, n: number): string {
	return prefix + unit.repeat(Math.floor((n - prefix.length) / unit.length));
}

/** Parses input with a fresh state and returns the state and the tree. */
export function parseWithState(input: string, simple = false, nestLimit = DEFAULT_NEST_LIMIT, setup?: (s: State) => void): { state: State; nodes: MfmNode[] } {
	const state = newState(input, simple, nestLimit);
	setup?.(state);
	const nodes = mergeText(state.parseNodes(false));
	return { state, nodes };
}

/** Returns the text of a text node, failing on any other node. */
export function textOf(node: MfmNode | undefined): string {
	if (node?.type !== 'text') throw new Error(`not a text node: ${JSON.stringify(node)}`);
	return node.props.text;
}

// Linear-time stress inputs: units that are repeated to make long inputs for
// the work, memory and time tests. The same list as the Go tests
// (linear_test.go).
export const stressUnits: Record<string, string> = {
	'unclosed bold tag': '<b>',
	'unclosed small tag': '<small>',
	'unclosed bold asta': '**',
	'unclosed big': '***',
	'unclosed strike wave': '~~a',
	'unclosed fn': '$[x ',
	'unclosed fn args': '$[x.a=b,c ',
	'unclosed link label': '[',
	'unclosed silent link': '?[<b>',
	'unclosed link url': '[a](',
	'unclosed url alt': '[a](<https://x\n',
	'unclosed center': '<center>a\n',
	'unclosed code block': '```a\n',
	'unclosed inline code': '`a',
	'unclosed math inline': '\\(a',
	'unclosed math block': '\\[a',
	'unclosed plain': '<plain>a',
	'unclosed url parens': 'https://a(',
	'unclosed hashtag': '#a(「[',
	'quote lines': '> <b>\n',
	'nested quotes': '>>>>>>>>>> ~~a\n',
	'search lines': 'a 検索 x\n',
	'emoji codes': ':a:b',
	'mentions': '@a.@',
	'mixed': '<b>**~~$[x [<small><i>\\[`<plain>\\(',
};

// Fragments random inputs are made of: every opening and closing mark, the
// characters the rules look at around them, plain text, and lone surrogates
// (mfm-js keeps them as characters). The list of tools/gen-testdata plus the
// surrogates.
export const fragments: readonly string[] = [
	'<b>', '</b>', '<i>', '</i>', '<s>', '</s>', '<small>', '</small>', '<center>', '</center>',
	'<plain>', '</plain>', '**', '***', '*', '__', '_', '~~', '`', '´', '\\(', '\\)', '\\[', '\\]',
	'$[', '$[x ', '$[x.a=1 ', '$[fg.color=f00,b ', ']', '[', '?[', '](', ')', '(', '「', '」',
	'https://e.x/a', 'http://e.x', '<https://e.x/日本>', '<', '>', '> ', '@a', '@a@h.x', '@', '#t', '#', '#1',
	':e:', ':', '😀', '👍🏽', '1\ufe0f\u20e3', '#\ufe0f\u20e3', '\u200d', '\ufe0f', '\u3000', ' ', '\t', '\n', '\r\n', '\r',
	'```', '```js\n', '検索', ' search', ' 検索', 'a', 'x', '1', 'あ', '-', '.', ',', '!', "'",
	'\ud83d', '\ude00', '\ufe0e', 'SEARCH', '[検索]', '%', '/', '=', '©',
];

/** mulberry32: a small seeded PRNG, so that random inputs are reproducible. */
export function prng(seed: number): () => number {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Returns count random inputs of 1 to maxFragments fragments. */
export function randomInputs(count: number, seed: number, maxFragments: number): string[] {
	const rand = prng(seed);
	const out: string[] = [];
	for (let i = 0; i < count; i++) {
		const n = 1 + Math.floor(rand() * maxFragments);
		let s = '';
		for (let j = 0; j < n; j++) s += fragments[Math.floor(rand() * fragments.length)];
		out.push(s);
	}
	return out;
}

/**
 * Strings of arbitrary UTF-16 code units, biased towards ASCII and surrogates,
 * so that they hold lone surrogates (fc.string never produces them).
 */
export const codeUnits: fc.Arbitrary<string> = fc.array(
	fc.oneof(
		fc.integer({ min: 0, max: 0x7f }),
		fc.integer({ min: 0xd800, max: 0xdfff }),
		fc.constantFrom(0x0a, 0x0d, 0x20, 0x3000, 0xfe0f, 0xfe0e, 0x200d, 0x20e3),
		fc.integer({ min: 0, max: 0xffff }),
	),
	{ maxLength: 60 },
).map((units) => String.fromCharCode(...units));
