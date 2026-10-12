import { describe, expect, test } from 'vitest';
import { parse, TEXT } from '../src/index.js';
import type { MfmNode } from '../src/index.js';
import { exhausted, MEMO_BYTES_BASE, STOP_URL_ALT_END } from '../src/internal/memo.js';
import { mergeText } from '../src/internal/parser.js';
import { fill, parseWithState, textOf } from './helpers.js';

/** An unclosed unit followed by depth lines, each quoted one level deeper and ending with the same unit. */
function quoteChain(depth: number, unit: string): string {
	let s = unit + '\n';
	for (let k = 1; k <= depth; k++) {
		s += '>'.repeat(k) + ' ' + unit + '\n';
	}
	return s;
}

describe('stress inputs', () => {
	// 仕事量の上限に届かずに読み終わることを見る(届くと以降が文字になる)
	test.each(['<b>', '<small>', '<center>', '<i>', '<s>', '**', '~~', '$[x ', '$[x.a=b ', '[', '[<b>', '?[', '<b>**~~$[x [<small><i>'])(
		'200 of %s parse within the budget', (unit) => {
			const { state, nodes } = parseWithState(unit.repeat(200));
			expect(nodes.length).toBeGreaterThan(0);
			expect(exhausted(state.budget), `used ${state.budget.used} of ${state.budget.limit}`).toBe(false);
		});

	test.each(['<b>', '$[x ', '[<b>', '<b>**~~$[x [<small><i>'])('work and memory stay bounded after the limit for %s', (unit) => {
		// 上限に届いた後の振る舞いを見るので、予算を小さくして早く届かせる
		const input = unit.repeat(Math.floor((16 << 10) / unit.length));
		const { state } = parseWithState(input, false, 20, (s) => {
			s.budget.limit = Math.floor(input.length / 4);
		});
		expect(exhausted(state.budget)).toBe(true);
		expect(state.budget.memUsed).toBeLessThanOrEqual(state.budget.memLimit);
		// 上限に達した後は、その時点で走っている子のループ(深さごとに高々1つ)が
		// 残りを1文字ずつテキストとして読むだけになる
		expect(state.budget.used).toBeLessThanOrEqual(state.budget.limit + 2 * (state.nestLimit + 2) * input.length);
	});

	test('balanced nesting under the limit still parses', () => {
		const nodes = parse('<b>'.repeat(10) + 'x' + '</b>'.repeat(10));
		expect(nodes).toHaveLength(1);
		let depth = 0;
		for (let n: MfmNode | undefined = nodes[0]; n !== undefined;) {
			expect(n.type).toBe('bold');
			depth++;
			const children: MfmNode[] = n.children ?? [];
			n = children.length === 1 && children[0].type === 'bold' ? children[0] : undefined;
		}
		expect(depth).toBe(10);
	});

	test('an unclosed prefix swallows later syntax, as in mfm-js', () => {
		const input = '<b>'.repeat(50) + '**bold**';
		expect(parse(input)).toStrictEqual([TEXT(input)]);
		const nodes = parse('**bold**' + '<b>'.repeat(50));
		expect(nodes).toHaveLength(2);
		expect(nodes[0].type).toBe('bold');
		expect(textOf(nodes[1])).toBe('<b>'.repeat(50));
	});

	test('text nodes of the result are not shared', () => {
		// 1文字のASCIIのノードは共有しているが、出力のテキストノードは作り直す
		const a = parse('a');
		expect(a).toHaveLength(1);
		(a[0] as { props: { text: string } }).props.text = 'changed';
		expect(textOf(parse('a')[0])).toBe('a');
	});

	test('mergeText does not modify its input', () => {
		const x = TEXT('x');
		const y = TEXT('y');
		expect(mergeText([x, y])).toStrictEqual([TEXT('xy')]);
		expect(x).toStrictEqual(TEXT('x'));
		expect(y).toStrictEqual(TEXT('y'));
	});

	// 投稿の上限(3000文字)に収まる入力は、どの形でも上限に届かず、最後まで
	// 構文として読む。メモや区切りの索引が効いていない経路はここで落ちる
	const localSized: Record<string, string> = {
		'unclosed bold': '<b>'.repeat(1000),
		'unclosed link label': '[<b>'.repeat(750),
		'quote chain bold': quoteChain(20, '<b>'),
		'quote chain italic': quoteChain(20, '<i>'),
		'quote chain fn': quoteChain(20, '$[x '),
		'unclosed plain': fill('', '<plain>', 3000),
		'unclosed math block': fill('', '\\[', 3000),
		'unclosed fn arg value': fill('', '$[x.k=v', 3000),
		'unclosed inline math': fill('', '<b>\\(', 3000),
		'unclosed link url': fill('<b>'.repeat(20), '[a](', 3000),
		'link urls': fill('<b>'.repeat(20), '[a](https://x', 3000),
		'labels sharing a url': '['.repeat(1000) + 'a](https://' + 'x'.repeat(1978),
		'unclosed url parens': fill('', 'https://a(', 3000),
		'unclosed url brackets': fill('<b>', 'https://a[(', 3000),
		'unclosed url alt': fill('', '[a](<https://x\n', 3000),
		'unclosed hashtag parens': fill('', '#a(', 3000),
		'unclosed hashtag groups': fill('<b>'.repeat(20), '#a(「[（', 3000),
		'short quotes': fill('<b>'.repeat(7), ':```js\n\n> ', 3000),
		'quote lines under limit': fill('<b>'.repeat(20), '\n> ', 3000),
		'quote lines with bold': fill('', '<b>\n> ', 3000),
		'deep mixed': fill('<b>'.repeat(18), '~~$[x.a=b *', 3000),
		'mixed': fill('', '<b>**~~$[x [<small><i>\\[`<plain>\\(', 3000),
		'unclosed center lines': fill('', '<center>a\n', 3000),
		'unclosed center crlf': fill('', '\r\n<center>\r\n**', 3000),
		'center lines at limit': fill('', '>'.repeat(19) + ' <center>a\n', 3000),
		'unclosed code blocks': fill('', '```a\n', 3000),
		'unclosed code blocks cr': fill('', '```a\r', 3000),
		'quoted code blocks': fill('', '> ```a\r\n', 3000),
	};
	test.each(Object.entries(localSized))('%s of a post size stays within the budget', (_name, input) => {
		for (const simple of [false, true]) {
			const { state } = parseWithState(input, simple);
			expect(exhausted(state.budget), `simple=${simple}: used ${state.budget.used} of ${state.budget.limit}`).toBe(false);
			expect(state.budget.memUsed).toBeLessThan(MEMO_BYTES_BASE / 2);
		}
	});

	test('a quote chain keeps its nested quotes', () => {
		expect(parse(quoteChain(20, '<b>'))).toStrictEqual([TEXT(quoteChain(20, '<b>'))]);
		const nodes = parse(quoteChain(20, '~~a'));
		expect(nodes).toHaveLength(2);
		let quotes = 0;
		for (let n: MfmNode = nodes[1]; ; n = n.children![1]) {
			expect(n.type).toBe('quote');
			quotes++;
			const children: MfmNode[] = n.children ?? [];
			// 次の段のquoteが直前の改行を読むので、改行は残らない(mfm-jsと同じ)
			expect(textOf(children[0])).toBe('~~a');
			if (children.length < 2) break;
		}
		expect(quotes).toBe(20);
	});

	test('unclosed url alts use the stop index', () => {
		// 区切りの位置は索引から引く
		const { state } = parseWithState('[a](<https://x\n'.repeat(2000));
		expect(state.memo.stopsState[STOP_URL_ALT_END], 'the stop index was not built and used').toBe(1);
		expect(exhausted(state.budget)).toBe(false);
	});

	test('reading url alts without the stop index counts the work', () => {
		// 索引を作れないとき(メモの上限)は1文字ずつ読むが、読んだ分を仕事量に数えて打ち切る
		const { state } = parseWithState('[a](<https://x\n'.repeat(14000), false, 20, (s) => {
			s.memo.stopsState[STOP_URL_ALT_END] = -1;
		});
		expect(exhausted(state.budget), `used ${state.budget.used} of ${state.budget.limit}`).toBe(true);
	});
});
