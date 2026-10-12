import { mergeText, newState } from '../src/internal/parser.js';
import type { State } from '../src/internal/parser.js';
import { DEFAULT_NEST_LIMIT } from '../src/internal/parser.js';
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
