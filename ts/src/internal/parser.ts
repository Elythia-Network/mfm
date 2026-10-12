// The parser, ported from the Go parser (parser.go, block.go, inline.go,
// emoji.go). The structure, the memo and the work counting follow the Go code
// method by method; see the comments there for the reasons. The comments here
// note what differs in JavaScript.
//
// 位置はUTF-16のコードユニットで数える。mfm-jsもコードユニット単位で読むので、
// 対になっていないサロゲートもmfm-jsと同じく1文字として残る(Go版は入口で
// U+FFFDに置き換える)。

import {
	BOLD, CENTER, CODE_BLOCK, EMOJI_CODE, FN, HASHTAG, INLINE_CODE, ITALIC, LINK, MATH_BLOCK, MATH_INLINE,
	MENTION, N_URL, PLAIN, QUOTE, SEARCH, SMALL, STRIKE, TEXT, UNI_EMOJI,
} from '../node.js';
import type { MfmInline, MfmNode, MfmSimpleNode, MfmText } from '../node.js';
import { emojiFirstUnits, emojiRegex } from '../emoji-regex.gen.js';
import {
	exhausted, lineEndIn, LINK_TARGET_ENTRY_COST, lowerBound, MemoTable, newBudget, newlineLenIn, oneKey,
	SCAN_BIG, SCAN_BOLD, SCAN_BOLD_ASTA, SCAN_CENTER, SCAN_FN, SCAN_ITALIC, SCAN_LINK_LABEL, SCAN_SMALL,
	SCAN_STRIKE, SCAN_STRIKE_WAVE, scanKey, STOP_CENTER_CLOSE, STOP_CODE_BLOCK_CLOSE, STOP_MATH_BLOCK_CLOSE,
	STOP_MATH_INLINE, STOP_PLAIN_CLOSE, STOP_URL_ALT_END,
} from './memo.js';
import type { WorkBudget } from './memo.js';

/** mfm-js's default nestLimit. */
export const DEFAULT_NEST_LIMIT = 20;

/**
 * The largest nest limit; larger values are lowered to it. Nesting is read by
 * recursion, so the limit bounds the stack depth.
 *
 * Go版は1000。JavaScriptでは1000段の入れ子が最適化の前に約800KBのスタックを使い、
 * V8の既定(984KB)に近いので、半分にして余裕を残す。test/fuzz.test.tsが上限の深さで
 * 溢れないことを確かめる。
 */
export const MAX_NEST_LIMIT = 500;

/**
 * Returns the nest limit the parser uses for mfm-js's nestLimit option:
 * undefined and null give the default, and the value is limited to
 * [0, MAX_NEST_LIMIT].
 *
 * mfm-jsは深さと上限を`depth < nestLimit`で比べるだけなので、小数の上限は切り上げた
 * 整数と同じに、NaNは0と同じに働く(どの深さでも比較が偽になる)。数値でない値は
 * 比較と同じく数値に直す。
 */
export function normalizeNestLimit(n: unknown): number {
	if (n == null) return DEFAULT_NEST_LIMIT;
	const v = Math.ceil(Number(n));
	if (Number.isNaN(v)) return 0;
	return Math.min(Math.max(v, 0), MAX_NEST_LIMIT);
}

/** Parses input with the full parser (mfm-js's parse). */
export function parseFull(input: string, nestLimit?: number): MfmNode[] {
	return newState(input, false, normalizeNestLimit(nestLimit)).parseNodes(true);
}

/** Parses input with the simple parser (mfm-js's parseSimple). */
export function parseSimpleTree(input: string): MfmSimpleNode[] {
	return newState(input, true, DEFAULT_NEST_LIMIT).parseNodes(true) as MfmSimpleNode[];
}

/** Returns the state for parsing src from the start, with a fresh memo and budget. */
export function newState(src: string, simple: boolean, nestLimit: number): State {
	const budget = newBudget(src.length);
	return new State(src, 0, 0, 0, nestLimit, simple, new MemoTable(src.length, nestLimit, budget), budget);
}

// 先頭のコードユニットで絵文字になり得るかを引く表。
const emojiFirst = new Uint8Array(0x10000);
for (let i = 0; i + 1 < emojiFirstUnits.length; i += 2) {
	emojiFirst.fill(1, emojiFirstUnits[i], emojiFirstUnits[i + 1] + 1);
}

// 失敗した試行の中で読んだ1文字ずつのノードは大半が捨てられるので、ASCIIは共有する。
// 出力に出るテキストノードはmergeTextが必ず作り直す。
const asciiText: MfmText[] = [];
for (let c = 0; c < 0x80; c++) {
	asciiText.push(TEXT(String.fromCharCode(c)));
}

const LF = 0x0a;
const CR = 0x0d;
const TAB = 0x09;
const SPACE = 0x20;
const IDEOGRAPHIC_SPACE = 0x3000;

function isNewline(c: number): boolean {
	return c === LF || c === CR;
}

/** Reports whether c is an ASCII letter or digit (mfm-js's /[a-z0-9]/i). */
function isAlnum(c: number): boolean {
	return (c >= 0x30 && c <= 0x39) || ((c | 0x20) >= 0x61 && (c | 0x20) <= 0x7a);
}

/** mfm-js's /[a-z0-9_]/i: fn names and argument keys. */
function isFnNameChar(c: number): boolean {
	return isAlnum(c) || c === 0x5f;
}

/** mfm-js's /[a-z0-9_.-]/i: fn argument values. */
function isFnArgValueChar(c: number): boolean {
	return isFnNameChar(c) || c === 0x2e || c === 0x2d;
}

/** mfm-js's /[a-z0-9_+-]/i: custom emoji names. */
function isEmojiName(c: number): boolean {
	return isAlnum(c) || c === 0x5f || c === 0x2b || c === 0x2d;
}

/** mfm-js's /[a-z0-9_.-]/i: mention user names and hosts. */
function isIdentChar(c: number): boolean {
	return isAlnum(c) || c === 0x5f || c === 0x2e || c === 0x2d;
}

/** mfm-js's url characters [.,a-z0-9_/:%#@$&?!~=+-] (case-insensitive). */
const urlChar = new Uint8Array(0x80);
for (const ch of '.,_/:%#@$&?!~=+-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ') {
	urlChar[ch.charCodeAt(0)] = 1;
}

/**
 * Reports whether c is one of mfm-js's hashTagChar: anything but
 * ` \u3000\t.,!?'"#:/[]【】()「」（）<>` and line breaks.
 */
function isHashtagChar(c: number): boolean {
	switch (c) {
		case SPACE: case IDEOGRAPHIC_SPACE: case TAB: case CR: case LF:
		case 0x2e: case 0x2c: case 0x21: case 0x3f: case 0x27: case 0x22: case 0x23: case 0x3a: case 0x2f:
		case 0x5b: case 0x5d: case 0x3010: case 0x3011: case 0x28: case 0x29:
		case 0x300c: case 0x300d: case 0xff08: case 0xff09: case 0x3c: case 0x3e:
			return false;
	}
	return true;
}

/** Returns the closing bracket of a bracket the hashtag rule reads as a group, or 0. */
function hashtagClose(c: number): number {
	switch (c) {
		case 0x28: return 0x29; // ( )
		case 0x5b: return 0x5d; // [ ]
		case 0x300c: return 0x300d; // 「 」
		case 0xff08: return 0xff09; // （ ）
	}
	return 0;
}

/** Returns the closing bracket of a bracket the url rule reads as a group, or 0. */
function urlClose(c: number): number {
	if (c === 0x28) return 0x29;
	if (c === 0x5b) return 0x5d;
	return 0;
}

/** Reports whether s is non-empty and made only of ASCII digits. */
function isDigitsOnly(s: string): boolean {
	if (s.length === 0) return false;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 0x30 || c > 0x39) return false;
	}
	return true;
}

/** Trims trailing characters of set from s. */
function trimRight(s: string, set: string): string {
	let e = s.length;
	while (e > 0 && set.includes(s[e - 1])) e--;
	return s.slice(0, e);
}

/**
 * Joins runs of adjacent text nodes into one new text node, like mfm-js's
 * mergeText. Every text node of the result is newly allocated and the input
 * nodes are not modified.
 */
export function mergeText<T extends MfmNode>(nodes: T[]): T[] {
	const out: T[] = [];
	for (let i = 0; i < nodes.length;) {
		const n = nodes[i];
		if (n.type !== 'text') {
			out.push(n);
			i++;
			continue;
		}
		let text = n.props.text;
		let j = i + 1;
		for (; j < nodes.length; j++) {
			const m = nodes[j];
			if (m.type !== 'text') break;
			text += m.props.text;
		}
		out.push(TEXT(text) as T);
		i = j;
	}
	return out;
}

type Try = (this: State) => MfmNode | null;

/** The cursor of one parse over one source string. */
export class State {
	readonly src: string;
	readonly len: number;
	pos: number;
	/** mfm-js's state.depth at pos. */
	depth: number;
	/** The depth at which this state reads with mfm-js's full parser. */
	readonly fullDepth: number;
	readonly nestLimit: number;
	readonly simple: boolean;
	/** Inside a link label (mfm-js's state.linkLabel). */
	inLink = false;
	readonly memo: MemoTable;
	readonly budget: WorkBudget;

	constructor(src: string, pos: number, depth: number, fullDepth: number, nestLimit: number, simple: boolean, memo: MemoTable, budget: WorkBudget) {
		this.src = src;
		this.len = src.length;
		this.pos = pos;
		this.depth = depth;
		this.fullDepth = fullDepth;
		this.nestLimit = nestLimit;
		this.simple = simple;
		this.memo = memo;
		this.budget = budget;
	}

	advance(n: number): void {
		this.pos += n;
		this.budget.used++;
	}

	/** Returns the code unit at pos, or -1 at the end. */
	peek(): number {
		return this.pos < this.len ? this.src.charCodeAt(this.pos) : -1;
	}

	/** Returns the code unit before pos, or -1 at the start. */
	prev(): number {
		return this.pos > 0 ? this.src.charCodeAt(this.pos - 1) : -1;
	}

	hasPrefix(p: string): boolean {
		return this.src.startsWith(p, this.pos);
	}

	prefixAt(pos: number, p: string): boolean {
		return pos <= this.len && this.src.startsWith(p, pos);
	}

	/** Reads nodes up to the end of the source, like mfm-js's `parser.many(0)`. */
	parseNodes(merge: boolean): MfmNode[] {
		const out: MfmNode[] = [];
		while (this.pos < this.len) {
			const n = this.parseOne();
			if (n === null) break;
			out.push(n);
		}
		return merge ? mergeText(out) : out;
	}

	/** Reads one node at pos with the parser mfm-js uses there, or null at the end. */
	parseOne(): MfmNode | null {
		if (this.pos >= this.len) return null;
		this.budget.used++;
		if (this.simple) {
			return this.parseSimpleOne();
		}
		const depth = this.depth;
		if (depth > 0 && depth >= this.nestLimit) {
			return this.consumeChar();
		}
		if (depth === 0 && !this.inLink) {
			return this.parseFullOne();
		}
		const key = oneKey(depth, this.inLink, depth === this.fullDepth);
		const memo = this.memo;
		const hit = memo.lookupOne(this.pos, key);
		if (hit !== null) {
			this.pos = memo.hitEnd;
			return hit;
		}
		const start = this.pos;
		const n = this.parseFullOne();
		memo.storeOne(start, key, n, this.pos);
		return n;
	}

	/** mfm-js's simple rule: alt([unicodeEmoji, emojiCode, plainTag, text]). */
	parseSimpleOne(): MfmNode {
		if (exhausted(this.budget)) {
			return this.consumeChar();
		}
		const c = this.src.charCodeAt(this.pos);
		if (emojiFirst[c] === 1) {
			const n = this.tryUnicodeEmoji();
			if (n !== null) return n;
		}
		if (c === 0x3a) {
			const n = this.tryEmojiCode();
			if (n !== null) return n;
		}
		if (c === 0x3c) {
			const n = this.tryPlainTag();
			if (n !== null) return n;
		}
		return this.consumeChar();
	}

	/**
	 * Reads one node like mfm-js's full rule at the top level or in a quote
	 * body, and like its inline rule elsewhere.
	 *
	 * Go版は候補を順に全て試す。ここでは先頭の文字で成功し得ない候補を飛ばすが、
	 * 試す順序はmfm-jsと同じ。飛ばす候補は失敗するときに位置も仕事量も変えないので、
	 * 結果と仕事量はGo版と同じになる。
	 */
	parseFullOne(): MfmNode {
		if (exhausted(this.budget)) {
			return this.consumeChar();
		}
		const c = this.src.charCodeAt(this.pos);
		let n: MfmNode | null = null;
		if (emojiFirst[c] === 1) {
			n = this.tryUnicodeEmoji();
			if (n !== null) return n;
		}
		switch (c) {
			case LF:
			case CR:
				// `<`で始まる候補のうち、改行から始まり得るのはcenterだけ
				n = this.tryCenterTag()
					?? this.tryBlock(1, 0, false, this.tryCodeBlock)
					?? this.tryBlock(2, 1, false, this.tryQuote)
					?? this.tryBlock(1, 1, true, this.tryMathBlock);
				break;
			case 0x3c: // <
				// mfm-jsの順(centerTag, smallTag, plainTag, boldTag, italicTag, strikeTag, urlAlt)。
				// 入れ子は再帰で読むので、1段あたりの呼び出しの数を減らすためにtryWrappedを
				// 直接呼ぶ(上限の深さの入れ子でスタックが溢れないように)
				n = this.tryCenterTag()
					?? this.tryWrapped('<small>', '</small>', SCAN_SMALL, SMALL)
					?? this.tryPlainTag()
					?? this.tryWrapped('<b>', '</b>', SCAN_BOLD, BOLD)
					?? this.tryWrapped('<i>', '</i>', SCAN_ITALIC, ITALIC)
					?? this.tryWrapped('<s>', '</s>', SCAN_STRIKE, STRIKE)
					?? this.tryURLAlt();
				break;
			case 0x2a: // *
				// big `***...***`は`$[tada ...]`になる
				n = this.tryWrapped('***', '***', SCAN_BIG, bigFn)
					?? this.tryWrapped('**', '**', SCAN_BOLD_ASTA, BOLD)
					?? this.tryItalicAsta();
				break;
			case 0x5f: // _
				n = this.tryWrappedAlphaSpace('__', BOLD) ?? this.tryItalicUnder();
				break;
			case 0x60: // `
				n = this.tryBlock(1, 0, false, this.tryCodeBlock) ?? this.tryInlineCode();
				break;
			case 0x3e: // >
				n = this.tryBlock(2, 1, false, this.tryQuote);
				break;
			case 0x5c: // \
				n = this.tryBlock(1, 1, true, this.tryMathBlock) ?? this.tryMathInline();
				break;
			case 0x7e: // ~
				n = this.tryWrapped('~~', '~~', SCAN_STRIKE_WAVE, STRIKE);
				break;
			case 0x24: // $
				n = this.tryFn();
				break;
			case 0x40: // @
				n = this.tryMention();
				break;
			case 0x23: // #
				n = this.tryHashtag();
				break;
			case 0x3a: // :
				n = this.tryEmojiCode();
				break;
			case 0x5b: // [
			case 0x3f: // ?
				n = this.tryLink();
				break;
			case 0x68: // h
				n = this.tryURL();
				break;
		}
		if (n !== null) return n;
		// 検索は行頭(前の改行を読むなら改行の位置)ならどの文字からでも始まり得る
		if ((isNewline(c) || this.atLineBegin()) && this.fullContext()) {
			n = this.tryBlock(1, 1, false, this.trySearch);
			if (n !== null) return n;
		}
		return this.consumeChar();
	}

	/**
	 * Reads one character as a text node, like mfm-js's text rule. The caller
	 * ensures the source is not exhausted.
	 *
	 * mfm-jsは1コードユニットずつ読むが、下位サロゲートから始まる構文は無いので、
	 * 対になったサロゲートはまとめて読む(結果のテキストは同じになる)。
	 */
	consumeChar(): MfmNode {
		const start = this.pos;
		const c = this.src.charCodeAt(start);
		if (c < 0x80) {
			this.advance(1);
			return asciiText[c];
		}
		let size = 1;
		if (c >= 0xd800 && c <= 0xdbff && start + 1 < this.len) {
			const d = this.src.charCodeAt(start + 1);
			if (d >= 0xdc00 && d <= 0xdfff) size = 2;
		}
		this.advance(size);
		return TEXT(this.src.slice(start, start + size));
	}

	/** Parses nodes from pos up to end, a position scanEnd returned. */
	collectTo(end: number): MfmNode[] {
		const nodes: MfmNode[] = [];
		while (this.pos < end) {
			const n = this.parseOne();
			if (n === null) break;
			nodes.push(n);
		}
		return nodes;
	}

	/** Reports whether the child loop of kind ends at pos. */
	stopsAt(kind: number): boolean {
		switch (kind) {
			case SCAN_CENTER:
				return this.centerCloseAt(this.pos);
			case SCAN_SMALL:
				return this.hasPrefix('</small>');
			case SCAN_BOLD:
				return this.hasPrefix('</b>');
			case SCAN_ITALIC:
				return this.hasPrefix('</i>');
			case SCAN_STRIKE:
				return this.hasPrefix('</s>');
			case SCAN_BIG:
				return this.hasPrefix('***');
			case SCAN_BOLD_ASTA:
				return this.hasPrefix('**');
			case SCAN_STRIKE_WAVE: {
				const c = this.peek();
				return isNewline(c) || this.hasPrefix('~~');
			}
			case SCAN_FN:
				return this.peek() === 0x5d;
			case SCAN_LINK_LABEL: {
				const c = this.peek();
				return c === 0x5d || isNewline(c);
			}
		}
		return true;
	}

	/**
	 * Returns the position where the child loop of kind, started at pos with
	 * the current depth and inLink, stops. pos is left unchanged.
	 */
	scanEnd(kind: number): number {
		const memo = this.memo;
		const key = scanKey(this.depth, this.inLink, this.depth === this.fullDepth, kind);
		const start = this.pos;
		const path: number[] = [];
		let end = start;
		for (;;) {
			if (this.pos >= this.len || this.stopsAt(kind)) {
				end = this.pos;
				break;
			}
			const e = memo.lookupScan(this.pos, key);
			if (e >= 0) {
				end = e;
				break;
			}
			path.push(this.pos);
			if (this.parseOne() === null) {
				end = this.pos;
				break;
			}
		}
		for (const p of path) {
			memo.storeScan(p, key, end);
		}
		this.pos = start;
		return end;
	}

	// ---- 区切りの索引 (memo.go) ----

	/**
	 * Returns the first position at or after pos where the scan of kind stops
	 * (len when it runs to the end), or -1 when the caller must fall back to
	 * reading character by character.
	 */
	nextStop(kind: number): number {
		const list = this.memo.stopList(this.src, kind);
		if (list === null) return -1;
		this.budget.used++;
		const i = lowerBound(list, this.pos);
		return i === list.length ? this.len : list[i];
	}

	/** Returns the position of the first '>' or space at or after pos (len when none), or -1 when the work budget runs out. */
	urlAltStop(pos: number): number {
		const save = this.pos;
		this.pos = pos;
		const stop = this.nextStop(STOP_URL_ALT_END);
		this.pos = save;
		if (stop >= 0) return stop;
		for (let i = pos; i < this.len; i++) {
			if (++this.budget.used > this.budget.limit) return -1;
			const c = this.src.charCodeAt(i);
			if (c === 0x3e || c === SPACE || c === IDEOGRAPHIC_SPACE || c === TAB) return i;
		}
		return this.len;
	}

	/**
	 * Parses the link target starting at pos (just after "](") and returns the
	 * URL and the position after it; the url is null when there is none.
	 */
	linkTargetAt(pos: number): { url: string | null; end: number } {
		const memo = this.memo;
		// 深さは高々MAX_NEST_LIMITなので、位置と深さを1つの数にまとめて鍵にする
		const key = pos * 1024 + this.depth;
		const hit = memo.linkTargets?.get(key);
		if (hit !== undefined) {
			return { url: hit.ok ? hit.url : null, end: hit.end };
		}
		const save = this.pos;
		this.pos = pos;
		const url = this.readLinkTarget();
		const end = this.pos;
		this.pos = save;
		if (memo.charge(LINK_TARGET_ENTRY_COST + (url?.length ?? 0))) {
			memo.linkTargets ??= new Map();
			memo.linkTargets.set(key, { end, url: url ?? '', ok: url !== null });
		}
		return { url, end };
	}

	/** Reads `<https://...>` or a plain URL; null when there is none. */
	readLinkTarget(): string | null {
		if (this.peek() === 0x3c) {
			return this.readURLAlt();
		}
		const n = this.tryURL();
		if (n === null || n.type !== 'url') return null;
		const url = n.props.url;
		return url !== '' ? url : null;
	}

	/** Reads mfm-js's urlAlt `<https://...>` and returns the URL, moving past '>' only on success. */
	readURLAlt(): string | null {
		if (this.peek() !== 0x3c) return null;
		const start = this.pos + 1;
		let bodyStart = start;
		if (this.prefixAt(start, 'https://')) {
			bodyStart += 8;
		} else if (this.prefixAt(start, 'http://')) {
			bodyStart += 7;
		} else {
			return null;
		}
		const stop = this.urlAltStop(bodyStart);
		if (stop < 0 || stop >= this.len || this.src.charCodeAt(stop) !== 0x3e || stop === bodyStart) {
			return null;
		}
		this.pos = stop + 1;
		return this.src.slice(start, stop);
	}

	/** mfm-js's urlAlt in text: a URL node with the brackets prop. */
	tryURLAlt(): MfmNode | null {
		if (this.inLink) return null;
		const url = this.readURLAlt();
		if (url === null) return null;
		return N_URL(url, true);
	}

	// ---- ブロック (block.go) ----

	/** Reports whether pos is read by mfm-js's full parser rather than its inline parser. */
	fullContext(): boolean {
		return !this.simple && !this.inLink && this.depth === this.fullDepth;
	}

	/** Returns the position after up to n newlines starting at pos. */
	skipNewlines(pos: number, n: number): number {
		for (; n > 0; n--) {
			const l = newlineLenIn(this.src, pos);
			if (l === 0) break;
			pos += l;
		}
		return pos;
	}

	/** Tries a block construct the way mfm-js's full parser does. */
	tryBlock(lead: number, trail: number, whole: boolean, tryFn: Try): MfmNode | null {
		if (!this.fullContext()) return null;
		const save = this.pos;
		this.pos = this.skipNewlines(save, lead);
		if (whole && !this.atLineBegin()) {
			this.pos = save;
			return null;
		}
		const n = tryFn.call(this);
		if (n === null || (whole && !lineEndIn(this.src, this.pos))) {
			this.pos = save;
			return null;
		}
		this.pos = this.skipNewlines(this.pos, trail);
		return n;
	}

	/** mfm-js's quote: a run of lines starting with ">". */
	tryQuote(): MfmNode | null {
		if (this.depth !== this.fullDepth || this.inLink) return null;
		if (!this.atLineBegin() || this.peek() !== 0x3e) return null;
		const run = this.memo.quoteAt(this.src, this.pos);
		if (run === null) return null;
		const offset = this.memo.quoteOffset;
		const body = run.inner.slice(offset);
		if (body === '') return null;
		this.budget.used++;
		// mfm-jsのnest(Go版のnest)。入れ子の1段ごとの呼び出しを減らすため、ここに展開してある
		this.depth++;
		let children: MfmNode[];
		if (this.depth >= this.nestLimit) {
			children = [TEXT(body)];
		} else {
			// 中身は引用の深さ(nestの1段下)を最上位とするfullで読む
			const sub = new State(run.inner, offset, this.depth, this.depth, this.nestLimit, false, run.table!, this.budget);
			children = sub.parseNodes(true);
		}
		this.depth--;
		this.pos = run.end;
		return QUOTE(children);
	}

	/** mfm-js's codeBlock at a line begin. */
	tryCodeBlock(): MfmNode | null {
		if (this.depth !== this.fullDepth) return null;
		if (!this.atLineBegin() || !this.hasPrefix('```')) return null;
		const save = this.pos;
		const src = this.src;
		const langStart = this.pos + 3;
		let langEnd = langStart;
		while (langEnd < this.len && !isNewline(src.charCodeAt(langEnd))) langEnd++;
		this.budget.used += langEnd - langStart;
		if (langEnd === this.len) {
			return null;
		}
		// mfm-jsと同じくString.prototype.trimで削る
		const lang = src.slice(langStart, langEnd).trim();
		const codeStart = langEnd + newlineLenIn(src, langEnd);
		this.pos = codeStart;
		const closeAt = this.codeBlockClose();
		if (closeAt < 0 || closeAt === codeStart) {
			this.pos = save;
			return null;
		}
		const code = src.slice(codeStart, closeAt);
		this.pos = closeAt + newlineLenIn(src, closeAt) + 3;
		this.advance(newlineLenIn(src, this.pos));
		return CODE_BLOCK(code, lang !== '' ? lang : null);
	}

	/** Returns the first position at or after pos where a newline, ``` and a line end follow, or -1. */
	codeBlockClose(): number {
		const c = this.nextStop(STOP_CODE_BLOCK_CLOSE);
		if (c >= 0) {
			return c < this.len ? c : -1;
		}
		for (let i = this.pos; i < this.len; i++) {
			if (++this.budget.used > this.budget.limit) return -1;
			const l = newlineLenIn(this.src, i);
			if (l > 0 && this.prefixAt(i + l, '```') && lineEndIn(this.src, i + l + 3)) {
				return i;
			}
		}
		return -1;
	}

	/** mfm-js's mathBlock body; tryBlock checks the line begin and end. */
	tryMathBlock(): MfmNode | null {
		if (this.depth !== this.fullDepth) return null;
		if (!this.hasPrefix('\\[')) return null;
		const save = this.pos;
		this.advance(2);
		this.advance(newlineLenIn(this.src, this.pos));
		const start = this.pos;
		let closeAt = this.nextStop(STOP_MATH_BLOCK_CLOSE);
		if (closeAt < 0) {
			const i = this.src.indexOf('\\]', start);
			closeAt = i >= 0 ? i : this.len;
			this.budget.used += closeAt - start;
		}
		if (closeAt >= this.len) {
			this.pos = save;
			return null;
		}
		const end = closeAt - trailingNewlineLen(this.src, start, closeAt);
		if (end === start) {
			this.pos = save;
			return null;
		}
		this.pos = closeAt + 2;
		return MATH_BLOCK(this.src.slice(start, end));
	}

	/** mfm-js's centerTag. */
	tryCenterTag(): MfmNode | null {
		if (this.depth !== this.fullDepth) return null;
		const save = this.pos;
		this.advance(newlineLenIn(this.src, this.pos));
		if (!this.atLineBegin() || !this.hasPrefix('<center>')) {
			this.pos = save;
			return null;
		}
		this.advance(8);
		this.advance(newlineLenIn(this.src, this.pos));
		const start = this.pos;
		const childDepthOK = this.depth + 1 < this.nestLimit;
		let end: number;
		if (childDepthOK) {
			this.depth++;
			end = this.scanEnd(SCAN_CENTER);
			this.depth--;
		} else {
			end = this.centerTextEnd();
		}
		const afterClose = end + newlineLenIn(this.src, end) + 9;
		if (end === start || !this.centerCloseAt(end) || !lineEndIn(this.src, afterClose)) {
			this.pos = save;
			return null;
		}
		let children: MfmNode[];
		if (childDepthOK) {
			this.depth++;
			children = mergeText(this.collectTo(end));
			this.depth--;
		} else {
			children = [TEXT(this.src.slice(start, end))];
		}
		this.pos = afterClose;
		this.advance(newlineLenIn(this.src, this.pos));
		return CENTER(children as MfmInline[]);
	}

	/** Reports whether an optional newline and </center> follow pos. */
	centerCloseAt(pos: number): boolean {
		return this.prefixAt(pos + newlineLenIn(this.src, pos), '</center>');
	}

	/** Returns where the children of a center read as plain text stop. */
	centerTextEnd(): number {
		let c = this.nextStop(STOP_CENTER_CLOSE);
		if (c < 0) {
			const i = this.src.indexOf('</center>', this.pos);
			c = i >= 0 ? i : this.len;
		}
		const src = this.src;
		if (c - 2 >= this.pos && src.charCodeAt(c - 2) === CR && src.charCodeAt(c - 1) === LF) return c - 2;
		if (c - 1 >= this.pos && isNewline(src.charCodeAt(c - 1))) return c - 1;
		return c;
	}

	/** mfm-js's lineBegin: the start of the source or right after CR or LF. */
	atLineBegin(): boolean {
		return this.pos === 0 || isNewline(this.src.charCodeAt(this.pos - 1));
	}

	/** mfm-js's search at a line begin. */
	trySearch(): MfmNode | null {
		if (!this.fullContext() || !this.atLineBegin()) return null;
		const src = this.src;
		const start = this.pos;
		let i = start;
		// mfm-jsと同じく1コードユニットずつ進めて、区切り+ボタン+行末を探す
		while (i < this.len && !isNewline(src.charCodeAt(i))) {
			i++;
			const end = this.searchButtonAt(i);
			if (end >= 0) {
				this.budget.used += i - start;
				this.pos = end;
				return SEARCH(src.slice(start, i), src.slice(start, end));
			}
		}
		this.budget.used += i - start;
		return null;
	}

	/** Returns the line end after a space, a search button and the line end at pos, or -1. */
	searchButtonAt(pos: number): number {
		const c = pos < this.len ? this.src.charCodeAt(pos) : -1;
		if (c !== SPACE && c !== TAB && c !== IDEOGRAPHIC_SPACE) return -1;
		pos++;
		let end: number;
		if (this.prefixAt(pos, '[')) {
			end = searchWordEnd(this.src, pos + 1);
			if (end < 0 || !this.prefixAt(end, ']')) return -1;
			end++;
		} else {
			end = searchWordEnd(this.src, pos);
			if (end < 0) return -1;
		}
		return lineEndIn(this.src, end) ? end : -1;
	}

	// ---- インライン (inline.go) ----


	/** mfm-js's plainTag. */
	tryPlainTag(): MfmNode | null {
		if (!this.hasPrefix('<plain>')) return null;
		const save = this.pos;
		this.advance(7);
		this.advance(newlineLenIn(this.src, this.pos));
		const start = this.pos;
		let c = this.nextStop(STOP_PLAIN_CLOSE);
		if (c < 0) {
			const i = this.src.indexOf('</plain>', this.pos);
			c = i >= 0 ? i : this.len;
			this.budget.used += c - this.pos;
		}
		if (c >= this.len) {
			this.pos = save;
			return null;
		}
		const end = c - trailingNewlineLen(this.src, start, c);
		if (end === start) {
			this.pos = save;
			return null;
		}
		this.pos = c + 8;
		return PLAIN(this.src.slice(start, end));
	}






	tryItalicAsta(): MfmNode | null {
		if (isAlnum(this.prev())) return null;
		return this.tryWrappedAlphaSpace('*', ITALIC);
	}


	tryItalicUnder(): MfmNode | null {
		if (isAlnum(this.prev())) return null;
		return this.tryWrappedAlphaSpace('_', ITALIC);
	}


	/**
	 * Parses open, children up to close, and close, like mfm-js's seqOrText.
	 * When open matches but the rest does not, it returns what it read as a
	 * single text node.
	 */
	tryWrapped(open: string, close: string, kind: number, make: (children: MfmInline[]) => MfmNode): MfmNode | null {
		if (!this.hasPrefix(open)) return null;
		const start = this.pos;
		this.advance(open.length);
		// wrappedBodyと同じ処理。入れ子の1段ごとの呼び出しを減らすため、ここに展開してある
		if (this.pos >= this.len || this.stopsAt(kind)) {
			return TEXT(this.src.slice(start, this.pos));
		}
		this.depth++;
		const end = this.scanEnd(kind);
		const closed = this.prefixAt(end, close);
		let children: MfmNode[] | null = null;
		if (closed) {
			children = this.collectTo(end);
		}
		this.depth--;
		this.pos = end;
		if (children === null) {
			return TEXT(this.src.slice(start, this.pos));
		}
		this.advance(close.length);
		return make(mergeText(children) as MfmInline[]);
	}

	/**
	 * Reads mfm-js's `seq(notMatch(close), nest(inline)).many(1)` and then
	 * close. On failure it returns null with pos at the end of what seqOrText
	 * keeps as text.
	 */
	wrappedBody(close: string, kind: number): MfmNode[] | null {
		if (this.pos >= this.len || this.stopsAt(kind)) return null;
		this.depth++;
		const end = this.scanEnd(kind);
		const closed = this.prefixAt(end, close);
		let children: MfmNode[] | null = null;
		if (closed) {
			children = this.collectTo(end);
		}
		this.depth--;
		this.pos = end;
		if (children === null) return null;
		this.advance(close.length);
		return mergeText(children);
	}

	/** mfm-js's `seq(mark, alt([alphaAndNum, space]).many(1), mark)`. */
	tryWrappedAlphaSpace(mark: string, make: (children: MfmInline[]) => MfmNode): MfmNode | null {
		if (!this.hasPrefix(mark)) return null;
		const src = this.src;
		const start = this.pos + mark.length;
		let i = start;
		while (i < this.len) {
			const c = src.charCodeAt(i);
			if (isAlnum(c) || c === SPACE || c === TAB || c === IDEOGRAPHIC_SPACE) i++;
			else break;
		}
		this.budget.used += i - start;
		if (i === start || !this.prefixAt(i, mark)) return null;
		this.pos = i + mark.length;
		return make([TEXT(src.slice(start, i))]);
	}

	/** mfm-js's inlineCode. */
	tryInlineCode(): MfmNode | null {
		if (this.peek() !== 0x60) return null;
		const src = this.src;
		const start = this.pos + 1;
		let i = start;
		let n: MfmNode | null = null;
		for (; i < this.len; i++) {
			const c = src.charCodeAt(i);
			if (c === 0x60) {
				if (i !== start) {
					this.pos = i + 1;
					n = INLINE_CODE(src.slice(start, i));
				}
				break;
			}
			if (c === LF || c === CR || c === 0xb4) break;
		}
		this.budget.used += i - start;
		return n;
	}

	/** mfm-js's mathInline. */
	tryMathInline(): MfmNode | null {
		if (!this.hasPrefix('\\(')) return null;
		const save = this.pos;
		const start = this.pos + 2;
		this.pos = start;
		let stop = this.nextStop(STOP_MATH_INLINE);
		if (stop < 0) {
			stop = this.len;
			for (let i = start; i < this.len; i++) {
				const c = this.src.charCodeAt(i);
				if (isNewline(c) || this.prefixAt(i, '\\)')) {
					stop = i;
					break;
				}
			}
			this.budget.used += stop - start;
		}
		if (stop === start || !this.prefixAt(stop, '\\)')) {
			this.pos = save;
			return null;
		}
		this.pos = stop + 2;
		return MATH_INLINE(this.src.slice(start, stop));
	}

	/** mfm-js's fn `$[name.args children]`. */
	tryFn(): MfmNode | null {
		if (!this.hasPrefix('$[')) return null;
		const start = this.pos;
		this.advance(2);
		const name = this.readFnWord(isFnNameChar);
		if (name === '') return TEXT(this.src.slice(start, this.pos));
		const args = this.readFnArgs();
		if (this.peek() !== SPACE) return TEXT(this.src.slice(start, this.pos));
		this.advance(1);
		const children = this.wrappedBody(']', SCAN_FN);
		if (children === null) return TEXT(this.src.slice(start, this.pos));
		return FN(name, args ?? {}, children as MfmInline[]);
	}

	/** Reads the longest run of characters satisfying ok. */
	readFnWord(ok: (c: number) => boolean): string {
		const start = this.pos;
		while (this.pos < this.len && ok(this.src.charCodeAt(this.pos))) {
			this.advance(1);
		}
		return this.src.slice(start, this.pos);
	}

	/** Reads mfm-js's fn arguments `.k=v,k2`, or returns null leaving pos unchanged. */
	readFnArgs(): Record<string, string | true> | null {
		if (this.peek() !== 0x2e) return null;
		const save = this.pos;
		this.advance(1);
		if (!isFnNameChar(this.peek())) {
			this.pos = save;
			return null;
		}
		const args: Record<string, string | true> = {};
		for (;;) {
			const key = this.readFnWord(isFnNameChar);
			let value: string | true = true;
			if (this.peek() === 0x3d) {
				const eq = this.pos;
				this.advance(1);
				const v = this.readFnWord(isFnArgValueChar);
				if (v !== '') {
					value = v;
				} else {
					this.pos = eq;
				}
			}
			args[key] = value;
			if (this.peek() !== 0x2c) return args;
			const comma = this.pos;
			this.advance(1);
			if (!isFnNameChar(this.peek())) {
				this.pos = comma;
				return args;
			}
		}
	}

	/** mfm-js's mention `@user` or `@user@host`. */
	tryMention(): MfmNode | null {
		if (this.peek() !== 0x40 || this.inLink || isAlnum(this.prev())) return null;
		const save = this.pos;
		this.advance(1);
		let username = this.consumeIdent();
		if (username === '') {
			this.pos = save;
			return null;
		}
		let host = '';
		let hasHost = false;
		if (this.peek() === 0x40) {
			const hostStart = this.pos;
			this.advance(1);
			const h = this.consumeIdent();
			if (h !== '') {
				host = h;
				hasHost = true;
			} else {
				this.pos = hostStart;
			}
		}
		const end = this.pos;
		let invalid = false;
		if (hasHost) {
			const trimmed = trimRight(host, '.-');
			if (trimmed.length !== host.length) {
				host = trimmed;
				if (host === '') {
					invalid = true;
					hasHost = false;
				}
			}
		}
		const trimmedUser = trimRight(username, '.-');
		if (trimmedUser.length !== username.length) {
			if (!hasHost) {
				username = trimmedUser;
			} else {
				invalid = true;
			}
		}
		if (username === '' || username.startsWith('.') || username.startsWith('-')) invalid = true;
		if (hasHost && (host.startsWith('.') || host.startsWith('-'))) invalid = true;
		if (invalid) {
			return TEXT(this.src.slice(save, end));
		}
		let acct = '@' + username;
		if (hasHost) acct += '@' + host;
		this.pos = save + acct.length;
		return MENTION(username, hasHost ? host : null, acct);
	}

	/** Reads mfm-js's /[a-z0-9_.-]+/i. */
	consumeIdent(): string {
		const start = this.pos;
		while (this.pos < this.len && isIdentChar(this.src.charCodeAt(this.pos))) {
			this.advance(1);
		}
		return this.src.slice(start, this.pos);
	}

	/** mfm-js's hashtag `#tag`. */
	tryHashtag(): MfmNode | null {
		if (this.peek() !== 0x23 || this.inLink || isAlnum(this.prev())) return null;
		const start = this.pos + 1;
		const end = this.hashtagItems(start, this.depth, true);
		this.budget.used += end - start;
		const tag = this.src.slice(start, end);
		if (tag === '' || isDigitsOnly(tag)) return null;
		this.pos = end;
		return HASHTAG(tag);
	}

	/** Reads mfm-js's `innerItem.many(0)` of the hashtag rule from i and returns where it stopped. */
	hashtagItems(i: number, depth: number, top: boolean): number {
		for (;;) {
			const next = this.hashtagItem(i, depth, top);
			if (next < 0) return i;
			i = next;
		}
	}

	/** Reads one hashtag innerItem at i and returns the position after it, or -1. */
	hashtagItem(i: number, depth: number, top: boolean): number {
		if (i >= this.len) return -1;
		const c = this.src.charCodeAt(i);
		if (isHashtagChar(c)) return i + 1;
		const close = hashtagClose(c);
		if (close === 0) return -1;
		if (!top && depth >= this.nestLimit) return -1;
		this.budget.used++;
		const j = this.hashtagItems(i + 1, depth + 1, false);
		if (j >= this.len || this.src.charCodeAt(j) !== close) return -1;
		return j + 1;
	}

	/** mfm-js's emojiCode `:name:`. */
	tryEmojiCode(): MfmNode | null {
		if (this.peek() !== 0x3a) return null;
		const src = this.src;
		const start = this.pos + 1;
		let end = start;
		while (end < this.len && isEmojiName(src.charCodeAt(end))) end++;
		this.budget.used += end - start;
		if (end === start || end >= this.len || src.charCodeAt(end) !== 0x3a) return null;
		if (end + 1 < this.len && isAlnum(src.charCodeAt(end + 1))) return null;
		this.pos = end + 1;
		return EMOJI_CODE(src.slice(start, end));
	}

	/** mfm-js's url. */
	tryURL(): MfmNode | null {
		if (this.inLink) return null;
		let schemeLen: number;
		if (this.hasPrefix('https://')) {
			schemeLen = 8;
		} else if (this.hasPrefix('http://')) {
			schemeLen = 7;
		} else {
			return null;
		}
		const start = this.pos;
		const end = this.urlItems(start + schemeLen, this.depth, true);
		this.budget.used += 1 + end - start;
		if (end === start + schemeLen) return null;
		const url = this.src.slice(start, end);
		const trimmed = trimRight(url, '.,');
		if (trimmed.length <= schemeLen) {
			this.pos = end;
			return TEXT(url);
		}
		this.pos = start + trimmed.length;
		return N_URL(trimmed);
	}

	/** Reads mfm-js's `innerItem.many(0)` of the url rule from i and returns where it stopped. */
	urlItems(i: number, depth: number, top: boolean): number {
		for (;;) {
			const next = this.urlItem(i, depth, top);
			if (next < 0) return i;
			i = next;
		}
	}

	/** Reads one url innerItem at i and returns the position after it, or -1. */
	urlItem(i: number, depth: number, top: boolean): number {
		if (i >= this.len) return -1;
		const c = this.src.charCodeAt(i);
		if (c < 0x80 && urlChar[c] === 1) return i + 1;
		const close = urlClose(c);
		if (close === 0 || (!top && depth >= this.nestLimit)) return -1;
		this.budget.used++;
		const j = this.urlItems(i + 1, depth + 1, false);
		if (j < this.len && this.src.charCodeAt(j) === close) return j + 1;
		return -1;
	}

	/** mfm-js's link `[label](url)` or silent link `?[label](url)`. */
	tryLink(): MfmNode | null {
		if (this.inLink) return null;
		const start = this.pos;
		let silent = false;
		if (this.hasPrefix('?[')) {
			silent = true;
			this.advance(2);
		} else if (this.hasPrefix('[')) {
			this.advance(1);
		} else {
			return null;
		}
		this.inLink = true;
		this.depth++;
		const labelStart = this.pos;
		const labelEnd = this.scanEnd(SCAN_LINK_LABEL);
		let ok = labelEnd > labelStart && this.prefixAt(labelEnd, '](');
		let label: MfmNode[] = [];
		if (ok) {
			label = this.collectTo(labelEnd);
		}
		this.depth--;
		this.inLink = false;
		if (!ok) {
			this.pos = start;
			return null;
		}
		const target = this.linkTargetAt(labelEnd + 2);
		ok = target.url !== null && this.prefixAt(target.end, ')');
		if (!ok) {
			this.pos = start;
			return null;
		}
		this.pos = target.end + 1;
		this.budget.used++;
		return LINK(silent, target.url!, mergeText(label) as MfmInline[]);
	}

	// ---- 絵文字 (emoji.go) ----

	/**
	 * mfm-js's unicodeEmoji. The regex is mfm-js's own, so it reads the same
	 * emoji with the same engine.
	 */
	tryUnicodeEmoji(): MfmNode | null {
		emojiRegex.lastIndex = this.pos;
		if (!emojiRegex.test(this.src)) return null;
		const end = emojiRegex.lastIndex;
		const s = this.src.slice(this.pos, end);
		this.budget.used += end - this.pos;
		this.advance(end - this.pos);
		// mfm-jsはU+FE0Fだけを読んだときは絵文字ではなく文字として返す
		if (s === '\ufe0f') return TEXT(s);
		return UNI_EMOJI(s);
	}
}

/** Returns the length of the newline (CRLF, CR or LF) that ends src[from:to], or 0. */
function trailingNewlineLen(src: string, from: number, to: number): number {
	if (to - 2 >= from && src.charCodeAt(to - 2) === CR && src.charCodeAt(to - 1) === LF) return 2;
	if (to - 1 >= from && isNewline(src.charCodeAt(to - 1))) return 1;
	return 0;
}

/**
 * Returns the position after `検索` or ASCII case-insensitive `search` at pos,
 * or -1.
 *
 * mfm-jsの/search/iはuフラグが無いので、大文字小文字を同一視するのはASCIIだけ。
 */
function searchWordEnd(src: string, pos: number): number {
	if (src.startsWith('検索', pos)) return pos + 2;
	if (src.length - pos < 6) return -1;
	const word = 'search';
	for (let k = 0; k < 6; k++) {
		const c = src.charCodeAt(pos + k);
		if (c >= 0x80 || (c | 0x20) !== word.charCodeAt(k)) return -1;
	}
	return pos + 6;
}

function bigFn(children: MfmInline[]): MfmNode {
	return FN('tada', {}, children);
}
