import { isMfmBlock, TEXT } from './node.js';
import type { MfmNode, MfmSimpleNode } from './node.js';
import { parseFull, parseSimpleTree } from './internal/parser.js';

/**
 * Parses MFM with every construct, like mfm-js's `parse`.
 *
 * Constructs nested deeper than `opts.nestLimit` (default 20) are read as
 * text. The limit is lowered to 500 when it is larger, because nesting is
 * read by recursion.
 */
export function parse(input: string, opts: Partial<{ nestLimit: number }> = {}): MfmNode[] {
	return parseFull(input, opts.nestLimit);
}

/**
 * Parses only Unicode emoji, custom emoji codes and `<plain>`, like mfm-js's
 * `parseSimple`. It is meant for short texts such as user names.
 */
export function parseSimple(input: string): MfmSimpleNode[] {
	return parseSimpleTree(input);
}

/** Renders a tree, or a single node, back into MFM, like mfm-js's `toString`. */
export function toString(tree: MfmNode[]): string;
export function toString(node: MfmNode): string;
export function toString(node: MfmNode | MfmNode[]): string {
	if (Array.isArray(node)) {
		return stringifyTree(node);
	}
	return stringifyNode(node);
}

/** Calls action for every node, parents before children, like mfm-js's `inspect`. */
export function inspect(node: MfmNode, action: (node: MfmNode) => void): void;
export function inspect(nodes: MfmNode[], action: (node: MfmNode) => void): void;
export function inspect(node: MfmNode | MfmNode[], action: (node: MfmNode) => void): void {
	if (Array.isArray(node)) {
		for (const n of node) {
			inspectOne(n, action);
		}
	} else {
		inspectOne(node, action);
	}
}

/**
 * Returns the nodes of the trees for which predicate returns true, in the
 * order of {@link inspect}, like mfm-js's `extract`.
 */
export function extract(nodes: MfmNode[], predicate: (node: MfmNode) => boolean): MfmNode[] {
	const dest: MfmNode[] = [];
	inspect(nodes, (node) => {
		if (predicate(node)) {
			dest.push(node);
		}
	});
	return dest;
}

function inspectOne(node: MfmNode, action: (node: MfmNode) => void): void {
	action(node);
	if (node.children != null) {
		for (const child of node.children) {
			inspectOne(child, action);
		}
	}
}

// toStringの出力はmfm-js 0.26.0と同じ文字列にする(テストでmfm-jsと突き合わせている)。
function stringifyNode(node: MfmNode): string {
	switch (node.type) {
		case 'quote':
			return stringifyTree(node.children).split('\n').map((line) => `> ${line}`).join('\n');
		case 'search':
			return node.props.content;
		case 'blockCode':
			return `\`\`\`${node.props.lang ?? ''}\n${node.props.code}\n\`\`\``;
		case 'mathBlock':
			return `\\[\n${node.props.formula}\n\\]`;
		case 'center':
			return `<center>\n${stringifyTree(node.children)}\n</center>`;
		case 'emojiCode':
			return `:${node.props.name}:`;
		case 'unicodeEmoji':
			return node.props.emoji;
		case 'bold':
			return `**${stringifyTree(node.children)}**`;
		case 'small':
			return `<small>${stringifyTree(node.children)}</small>`;
		case 'italic':
			return `<i>${stringifyTree(node.children)}</i>`;
		case 'strike':
			return `~~${stringifyTree(node.children)}~~`;
		case 'inlineCode':
			return `\`${node.props.code}\``;
		case 'mathInline':
			return `\\(${node.props.formula}\\)`;
		case 'mention':
			return node.props.acct;
		case 'hashtag':
			return `#${node.props.hashtag}`;
		case 'url':
			return node.props.brackets ? `<${node.props.url}>` : node.props.url;
		case 'link':
			return `${node.props.silent ? '?' : ''}[${stringifyTree(node.children)}](${node.props.url})`;
		case 'fn': {
			const argFields = Object.keys(node.props.args).map((key) => {
				const value = node.props.args[key];
				return value === true ? key : `${key}=${value}`;
			});
			const args = argFields.length > 0 ? '.' + argFields.join(',') : '';
			return `$[${node.props.name}${args} ${stringifyTree(node.children)}]`;
		}
		case 'plain':
			return `<plain>\n${stringifyTree(node.children)}\n</plain>`;
		case 'text':
			return node.props.text;
	}
	throw new Error('unknown mfm node');
}

// ブロックの前後と、ブロックに続くインラインの前に改行を入れる(mfm-jsと同じ規則)。
function stringifyTree(nodes: MfmNode[]): string {
	const dest: MfmNode[] = [];
	// 0: 先頭, 1: 直前がインライン, 2: 直前がブロック
	let state = 0;
	for (const node of nodes) {
		let pushLf = true;
		if (isMfmBlock(node)) {
			if (state === 0) {
				pushLf = false;
			}
			state = 2;
		} else {
			if (state === 0 || state === 1) {
				pushLf = false;
			}
			state = 1;
		}
		if (pushLf) {
			dest.push(TEXT('\n'));
		}
		dest.push(node);
	}
	return dest.map((n) => stringifyNode(n)).join('');
}
