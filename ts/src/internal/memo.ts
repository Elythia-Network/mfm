// The memo tables of one parse, ported from the Go parser (memo.go). See the
// comments there and the repository README for why each part exists; the
// comments here note what differs in JavaScript.
//
// 位置はUTF-16のコードユニットで数える(Go版はUTF-8のバイト)。メモの確保量は
// Go版(64bitの環境)の構造体の大きさとsliceの容量で数えるので、ASCIIだけの入力では
// Go版と同じ位置で上限に届く。この量は名目の値で、JavaScriptのヒープで実際に
// 使う量はもっと大きく、解析中の頂点は最大で約5倍だった(ts/README.mdに実測を書いた)。

import type { MfmNode } from '../node.js';

/** A work and memory budget shared by every table of one parse. */
export interface WorkBudget {
	used: number;
	limit: number;
	memUsed: number;
	memLimit: number;
}

// 仕事量とメモの上限。値と数え方はGo版(memo.go)と同じ。
export const WORK_BUDGET_BASE = 1 << 21;
export const WORK_BUDGET_PER_UNIT = 32;
export const MEMO_BYTES_BASE = 16 << 20;
export const MEMO_BYTES_PER_UNIT = 64;

/** Returns a fresh budget for a source of srcLen code units. */
export function newBudget(srcLen: number): WorkBudget {
	return {
		used: 0,
		limit: WORK_BUDGET_BASE + WORK_BUDGET_PER_UNIT * srcLen,
		memUsed: 0,
		memLimit: Math.max(MEMO_BYTES_BASE, MEMO_BYTES_PER_UNIT * srcLen),
	};
}

/** Reports whether the work budget is used up. */
export function exhausted(b: WorkBudget): boolean {
	return b.used > b.limit;
}

// 子のループの止まる条件(閉じの区切り)。
export const SCAN_CENTER = 0;
export const SCAN_SMALL = 1;
export const SCAN_BOLD = 2;
export const SCAN_ITALIC = 3;
export const SCAN_STRIKE = 4;
export const SCAN_BIG = 5;
export const SCAN_BOLD_ASTA = 6;
export const SCAN_STRIKE_WAVE = 7;
export const SCAN_FN = 8;
export const SCAN_LINK_LABEL = 9;
export const NUM_SCAN_KINDS = 10;

// 区切りまで生の文字を読む構文。
export const STOP_PLAIN_CLOSE = 0; // </plain>
export const STOP_MATH_BLOCK_CLOSE = 1; // \]
export const STOP_MATH_INLINE = 2; // \) or a newline (CR or LF)
export const STOP_URL_ALT_END = 3; // '>', ' ', '\u3000' or '\t'
export const STOP_CENTER_CLOSE = 4; // </center>
export const STOP_CODE_BLOCK_CLOSE = 5; // a newline, ``` and a line end
export const NUM_STOP_KINDS = 6;

export const MEMO_PAGE_BITS = 8;
export const MEMO_PAGE_SIZE = 1 << MEMO_PAGE_BITS;
const PAGE_MASK = MEMO_PAGE_SIZE - 1;

/** The number of cells a page holds as a list before it becomes an array. */
export const SPARSE_MAX = 16;

// Go版の各部分の大きさ(linux/amd64で測った値)。数え方を揃えるために使う。
export const SLOT_PTR_SIZE = 8;
export const SLOT_SIZE = 48;
export const PAGE_PTR_SIZE = 8;
export const ONE_PAGE_SIZE = 56;
export const SCAN_PAGE_SIZE = 56;
export const SCAN_PAGES_SIZE = 64;
export const MEMO_ENTRY_SIZE = 16;
export const SPARSE_ENTRY_SIZE = MEMO_ENTRY_SIZE + 1;
export const SCAN_ENTRY_SIZE = 4;
export const MEMO_TABLE_SIZE = 320;
export const QUOTE_RUN_SIZE = 32;
export const QUOTE_LINE_COST = 12;
export const LINK_TARGET_ENTRY_COST = 48;

/**
 * The parseOne results of one page of one context: a list of (offset, node,
 * end) while it has at most SPARSE_MAX cells, then arrays indexed by offset.
 */
export class OnePage {
	dense = false;
	count = 0;
	offs: Uint8Array | null = new Uint8Array(SPARSE_MAX);
	nodes: (MfmNode | null)[] = [];
	ends: Int32Array = new Int32Array(SPARSE_MAX);
}

/** OnePage for the ends of child loops (end + 1; 0 marks an empty dense cell). */
export class ScanPage {
	dense = false;
	count = 0;
	offs: Uint8Array | null = new Uint8Array(SPARSE_MAX);
	ends: Int32Array = new Int32Array(SPARSE_MAX);
}

/** The pages of one (depth, inLink, atFull) context. */
export class SlotMemo {
	one: (OnePage | undefined)[];
	// 使った種類だけを並べて持つ(Go版と同じ)。
	scanKinds: number[] = [];
	scanPages: (ScanPage | undefined)[][] = [];

	constructor(pageCount: number) {
		this.one = new Array<OnePage | undefined>(pageCount);
	}

	scanPagesOf(kind: number): (ScanPage | undefined)[] | undefined {
		const i = this.scanKinds.indexOf(kind);
		return i < 0 ? undefined : this.scanPages[i];
	}
}

/** A maximal run of quote lines, joined, and the table used to parse it. */
export interface QuoteRun {
	inner: string;
	end: number;
	table: MemoTable | null;
}

/** A link target parsed at one position and depth. */
export interface LinkTarget {
	end: number;
	url: string;
	ok: boolean;
}

/** Returns the key of a parseOne context, never 0. */
export function oneKey(depth: number, inLink: boolean, atFull: boolean): number {
	let k = depth * 4 + 1;
	if (inLink) k += 2;
	if (atFull) k++;
	return k;
}

/** Returns the key of a child loop of kind in a context, never 0. */
export function scanKey(depth: number, inLink: boolean, atFull: boolean, kind: number): number {
	return (oneKey(depth, inLink, atFull) - 1) * NUM_SCAN_KINDS + kind + 1;
}

/** The memo tables for one source string. */
export class MemoTable {
	readonly srcLen: number;
	readonly nestLimit: number;
	readonly budget: WorkBudget;
	slots: (SlotMemo | undefined)[] | null = null;
	slotBase = 0;
	quoteStarts: number[] = [];
	quoteOffsets: number[] = [];
	quoteRunOf: number[] = [];
	quoteRuns: QuoteRun[] = [];
	quotesState = 0;
	stops: (Int32Array | null)[] = [null, null, null, null, null, null];
	stopsState: number[] = [0, 0, 0, 0, 0, 0];
	linkTargets: Map<number, LinkTarget> | null = null;
	/** The end position of the last lookupOne hit. */
	hitEnd = 0;

	constructor(srcLen: number, nestLimit: number, budget: WorkBudget) {
		this.srcLen = srcLen;
		this.nestLimit = nestLimit;
		this.budget = budget;
	}

	/**
	 * Charges n bytes of memo storage and reports whether the allocation may
	 * proceed. When it may not, the work budget counts as used up.
	 */
	charge(n: number): boolean {
		const b = this.budget;
		if (b.memUsed + n > b.memLimit) {
			b.used = b.limit + 1;
			return false;
		}
		b.memUsed += n;
		return true;
	}

	/** Returns the number of cells of the page that holds pos. */
	pageLen(pos: number): number {
		return Math.min(MEMO_PAGE_SIZE, this.srcLen + 1 - (pos & ~PAGE_MASK));
	}

	/** Returns the number of pages of a slot. */
	pageCount(): number {
		return (this.srcLen >>> MEMO_PAGE_BITS) + 1;
	}

	/** Returns the slot with index i, allocating it when alloc is set, or undefined. */
	slot(i: number, alloc: boolean): SlotMemo | undefined {
		if (i < 0 || i >= (this.nestLimit + 1) * 4) {
			return undefined;
		}
		if (this.slots === null) {
			if (!alloc) return undefined;
			this.slots = [];
			this.slotBase = i;
		}
		if (i < this.slotBase) {
			if (!alloc) return undefined;
			// より浅いスロットを使うときは、入れ物の先頭を伸ばす
			const grow = this.slotBase - i;
			if (!this.charge(grow * SLOT_PTR_SIZE)) {
				return undefined;
			}
			const next = new Array<SlotMemo | undefined>(grow + this.slots.length);
			for (let k = 0; k < this.slots.length; k++) next[grow + k] = this.slots[k];
			this.slots = next;
			this.slotBase = i;
		}
		const j = i - this.slotBase;
		if (j >= this.slots.length) {
			if (!alloc) return undefined;
			// 伸ばすたびに倍にし、新しい大きさの分を数える(Go版と同じ)
			const n = Math.min(Math.max(j + 1, 2 * this.slots.length), (this.nestLimit + 1) * 4 - this.slotBase);
			if (!this.charge(n * SLOT_PTR_SIZE)) {
				return undefined;
			}
			this.slots.length = n;
		}
		let sm = this.slots[j];
		if (sm === undefined) {
			if (!alloc || !this.charge(SLOT_SIZE + this.pageCount() * PAGE_PTR_SIZE)) {
				return undefined;
			}
			sm = new SlotMemo(this.pageCount());
			this.slots[j] = sm;
		}
		return sm;
	}

	/** Returns the slot with index i if it is allocated (the fast path of slot). */
	slotAt(i: number): SlotMemo | undefined {
		const slots = this.slots;
		if (slots === null) return undefined;
		const j = i - this.slotBase;
		return j >= 0 && j < slots.length ? slots[j] : undefined;
	}

	/**
	 * Returns the node parseOne read at pos in the context key, or null. On a
	 * hit, hitEnd holds the position after the node.
	 */
	lookupOne(pos: number, key: number): MfmNode | null {
		if (pos < 0 || pos > this.srcLen) return null;
		const sm = this.slotAt(key - 1);
		if (sm === undefined) return null;
		const pg = sm.one[pos >>> MEMO_PAGE_BITS];
		if (pg === undefined) return null;
		const off = pos & PAGE_MASK;
		if (pg.dense) {
			const n = pg.nodes[off];
			if (n == null) return null;
			this.hitEnd = pg.ends[off];
			return n;
		}
		const offs = pg.offs!;
		for (let i = 0; i < pg.count; i++) {
			if (offs[i] === off) {
				this.hitEnd = pg.ends[i];
				return pg.nodes[i];
			}
		}
		return null;
	}

	/** Stores the node read at pos in the context key, ending at end. */
	storeOne(pos: number, key: number, n: MfmNode, end: number): void {
		if (pos < 0 || pos > this.srcLen) return;
		let sm = this.slotAt(key - 1);
		if (sm === undefined) {
			sm = this.slot(key - 1, true);
			if (sm === undefined) return;
		}
		const pi = pos >>> MEMO_PAGE_BITS;
		let pg = sm.one[pi];
		if (pg === undefined) {
			if (!this.charge(ONE_PAGE_SIZE)) return;
			pg = new OnePage();
			sm.one[pi] = pg;
		}
		const off = pos & PAGE_MASK;
		if (pg.dense) {
			pg.nodes[off] = n;
			pg.ends[off] = end;
			return;
		}
		const offs = pg.offs!;
		for (let i = 0; i < pg.count; i++) {
			if (offs[i] === off) {
				pg.nodes[i] = n;
				pg.ends[i] = end;
				return;
			}
		}
		if (pg.count < SPARSE_MAX) {
			if (!this.charge(SPARSE_ENTRY_SIZE)) return;
			offs[pg.count] = off;
			pg.nodes[pg.count] = n;
			pg.ends[pg.count] = end;
			pg.count++;
			return;
		}
		// 並びを配列に変える。並びの分は手放すので数え直す
		const len = this.pageLen(pos);
		if (!this.charge(len * MEMO_ENTRY_SIZE - pg.count * SPARSE_ENTRY_SIZE)) return;
		const nodes = new Array<MfmNode | null>(len).fill(null);
		const ends = new Int32Array(len);
		for (let i = 0; i < pg.count; i++) {
			nodes[offs[i]] = pg.nodes[i];
			ends[offs[i]] = pg.ends[i];
		}
		nodes[off] = n;
		ends[off] = end;
		pg.nodes = nodes;
		pg.ends = ends;
		pg.offs = null;
		pg.dense = true;
	}

	/** Returns where the child loop with key started at pos stops, or -1. */
	lookupScan(pos: number, key: number): number {
		if (pos < 0 || pos > this.srcLen) return -1;
		const sm = this.slotAt(((key - 1) / NUM_SCAN_KINDS) | 0);
		if (sm === undefined) return -1;
		const pages = sm.scanPagesOf((key - 1) % NUM_SCAN_KINDS);
		if (pages === undefined) return -1;
		const pg = pages[pos >>> MEMO_PAGE_BITS];
		if (pg === undefined) return -1;
		const off = pos & PAGE_MASK;
		if (pg.dense) {
			return pg.ends[off] - 1;
		}
		const offs = pg.offs!;
		for (let i = 0; i < pg.count; i++) {
			if (offs[i] === off) return pg.ends[i] - 1;
		}
		return -1;
	}

	/** Stores that the child loop with key started at pos stops at end. */
	storeScan(pos: number, key: number, end: number): void {
		if (pos < 0 || pos > this.srcLen) return;
		const si = ((key - 1) / NUM_SCAN_KINDS) | 0;
		let sm = this.slotAt(si);
		if (sm === undefined) {
			sm = this.slot(si, true);
			if (sm === undefined) return;
		}
		const kind = (key - 1) % NUM_SCAN_KINDS;
		let pages = sm.scanPagesOf(kind);
		if (pages === undefined) {
			if (!this.charge(SCAN_PAGES_SIZE + this.pageCount() * PAGE_PTR_SIZE)) return;
			pages = new Array<ScanPage | undefined>(this.pageCount());
			sm.scanKinds.push(kind);
			sm.scanPages.push(pages);
		}
		const pi = pos >>> MEMO_PAGE_BITS;
		let pg = pages[pi];
		if (pg === undefined) {
			if (!this.charge(SCAN_PAGE_SIZE)) return;
			pg = new ScanPage();
			pages[pi] = pg;
		}
		const off = pos & PAGE_MASK;
		const v = end + 1;
		if (pg.dense) {
			pg.ends[off] = v;
			return;
		}
		const offs = pg.offs!;
		for (let i = 0; i < pg.count; i++) {
			if (offs[i] === off) {
				pg.ends[i] = v;
				return;
			}
		}
		if (pg.count < SPARSE_MAX) {
			if (!this.charge(SCAN_ENTRY_SIZE + 1)) return;
			offs[pg.count] = off;
			pg.ends[pg.count] = v;
			pg.count++;
			return;
		}
		const len = this.pageLen(pos);
		if (!this.charge(len * SCAN_ENTRY_SIZE - pg.count * (SCAN_ENTRY_SIZE + 1))) return;
		const ends = new Int32Array(len);
		for (let i = 0; i < pg.count; i++) {
			ends[offs[i]] = pg.ends[i];
		}
		ends[off] = v;
		pg.ends = ends;
		pg.offs = null;
		pg.dense = true;
	}

	/**
	 * Returns the sorted positions in src where the scan of kind stops,
	 * building the list on first use, or null when the memory budget refuses it.
	 *
	 * Go版と違い、JavaScriptの文字列はコードユニットの並びとして常に区切りを
	 * 探せるので、不正なUTF-8で使えなくなる場合は無い。確保量はGo版と同じく、
	 * 1つずつappendしたsliceの容量で数える(goAppendCap)。
	 */
	stopList(src: string, kind: number): Int32Array | null {
		switch (this.stopsState[kind]) {
			case 1:
				return this.stops[kind];
			case -1:
				return null;
		}
		this.stopsState[kind] = -1;
		const list: number[] = [];
		const n = src.length;
		switch (kind) {
			case STOP_PLAIN_CLOSE:
				indexAll(src, '</plain>', list);
				break;
			case STOP_MATH_BLOCK_CLOSE:
				indexAll(src, '\\]', list);
				break;
			case STOP_CENTER_CLOSE:
				indexAll(src, '</center>', list);
				break;
			case STOP_MATH_INLINE:
				for (let i = 0; i < n; i++) {
					const c = src.charCodeAt(i);
					// mfm-jsのnewLineはCRでも止まる
					if (c === 0x0a || c === 0x0d || (c === 0x5c && src.charCodeAt(i + 1) === 0x29)) {
						list.push(i);
					}
				}
				break;
			case STOP_CODE_BLOCK_CLOSE:
				for (let i = 0; i < n; i++) {
					const l = newlineLenIn(src, i);
					if (l > 0 && src.startsWith('```', i + l) && lineEndIn(src, i + l + 3)) {
						list.push(i);
					}
				}
				break;
			case STOP_URL_ALT_END:
				for (let i = 0; i < n; i++) {
					const c = src.charCodeAt(i);
					if (c === 0x3e || c === 0x20 || c === 0x09 || c === 0x3000) {
						list.push(i);
					}
				}
				break;
		}
		if (!this.charge(4 * goAppendCap(list.length))) {
			return null;
		}
		const arr = Int32Array.from(list);
		this.stops[kind] = arr;
		this.stopsState[kind] = 1;
		return arr;
	}

	/**
	 * Returns the quote run that a quote starting at the line start pos reads,
	 * setting quoteOffset to where it starts in run.inner, or null when pos
	 * does not start a quote line or the runs could not be allocated.
	 */
	quoteAt(src: string, pos: number): QuoteRun | null {
		if (this.quotesState === 0 && !this.buildQuotes(src)) {
			return null;
		}
		if (this.quotesState !== 1) {
			return null;
		}
		const starts = this.quoteStarts;
		const i = lowerBound(starts, pos);
		if (i === starts.length || starts[i] !== pos) {
			return null;
		}
		const run = this.quoteRuns[this.quoteRunOf[i]];
		if (run.table === null) {
			if (!this.charge(MEMO_TABLE_SIZE)) {
				return null;
			}
			run.table = new MemoTable(run.inner.length, this.nestLimit, this.budget);
		}
		this.quoteOffset = this.quoteOffsets[i];
		return run;
	}

	/** The offset in run.inner of the last quoteAt result. */
	quoteOffset = 0;

	/**
	 * Splits src into quote runs. It reports false, leaving the runs unusable,
	 * when the memory budget refuses them.
	 */
	buildQuotes(src: string): boolean {
		this.quotesState = -1;
		const n = src.length;
		let parts: string[] = [];
		let innerLen = 0;
		let inRun = false;
		const flush = (end: number): void => {
			if (!inRun) return;
			const r = this.quoteRuns[this.quoteRuns.length - 1];
			r.inner = parts.join('');
			r.end = end;
			parts = [];
			innerLen = 0;
			inRun = false;
		};
		// 行はmfm-jsのnewLine (CRLF / CR / LF)で切り、中身は"\n"でつなぐ
		for (let p = 0; p < n;) {
			let e = p;
			while (e < n) {
				const c = src.charCodeAt(e);
				if (c === 0x0a || c === 0x0d) break;
				e++;
			}
			const next = e + newlineLenIn(src, e);
			if (src.charCodeAt(p) !== 0x3e) {
				flush(p);
				p = next;
				continue;
			}
			let c = p + 1;
			// `>`の直後の空白はmfm-jsのspace.option()で、全角空白も1つ読む
			if (c < n) {
				const d = src.charCodeAt(c);
				if (d === 0x20 || d === 0x09 || d === 0x3000) c++;
			}
			let cost = QUOTE_LINE_COST + e - c + 1;
			if (!inRun) cost += QUOTE_RUN_SIZE;
			if (!this.charge(cost)) {
				this.quoteStarts = [];
				this.quoteOffsets = [];
				this.quoteRunOf = [];
				this.quoteRuns = [];
				return false;
			}
			if (!inRun) {
				this.quoteRuns.push({ inner: '', end: 0, table: null });
				inRun = true;
			} else {
				parts.push('\n');
				innerLen++;
			}
			this.quoteStarts.push(p);
			this.quoteOffsets.push(innerLen);
			this.quoteRunOf.push(this.quoteRuns.length - 1);
			parts.push(src.slice(c, e));
			innerLen += e - c;
			p = next;
		}
		flush(n);
		this.quotesState = 1;
		return true;
	}
}

/** Appends to out the positions of every (possibly overlapping) occurrence of needle in src. */
function indexAll(src: string, needle: string, out: number[]): void {
	for (let i = 0; ;) {
		const j = src.indexOf(needle, i);
		if (j < 0) return;
		out.push(j);
		i = j + 1;
	}
}

/** Returns the first index i of the sorted list with list[i] >= x. */
export function lowerBound(list: ArrayLike<number>, x: number): number {
	let lo = 0;
	let hi = list.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (list[mid] < x) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** Returns the length of mfm-js's newLine at pos in src (CRLF, CR or LF), or 0. */
export function newlineLenIn(src: string, pos: number): number {
	if (pos < 0 || pos >= src.length) return 0;
	const c = src.charCodeAt(pos);
	if (c === 0x0d) {
		return src.charCodeAt(pos + 1) === 0x0a ? 2 : 1;
	}
	return c === 0x0a ? 1 : 0;
}

/** Reports mfm-js's lineEnd at pos in src: the end of src or CR or LF. */
export function lineEndIn(src: string, pos: number): boolean {
	if (pos >= src.length) return true;
	const c = src.charCodeAt(pos);
	return c === 0x0a || c === 0x0d;
}

// Goのmallocのsize class(runtime/sizeclasses.go)。32KiBまで。
const GO_SIZE_CLASSES = [
	8, 16, 24, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 240, 256, 288, 320, 352, 384, 416,
	448, 480, 512, 576, 640, 704, 768, 896, 1024, 1152, 1280, 1408, 1536, 1792, 2048, 2304, 2688, 3072, 3200,
	3456, 4096, 4864, 5376, 6144, 6528, 6784, 6912, 8192, 9472, 9728, 10240, 10880, 12288, 13568, 14336, 16384,
	18432, 19072, 20480, 21760, 24576, 27264, 28672, 32768,
];

/** Rounds an allocation of size bytes up like Go's runtime (roundupsize). */
function goRoundUpSize(size: number): number {
	if (size <= 32768) {
		return GO_SIZE_CLASSES[lowerBound(GO_SIZE_CLASSES, size)];
	}
	return Math.ceil(size / 8192) * 8192;
}

/**
 * Returns the capacity of a Go []int32 after appending n elements one at a
 * time to a nil slice that escapes to the heap (runtime.growslice and
 * nextslicecap of Go 1.27).
 *
 * Go版は区切りの索引をこの容量で数える。要素数で数えると上限に届く位置が
 * Go版とずれ、上限の後の木が変わる。test/memo.test.tsがGoで測った容量と比べる。
 */
export function goAppendCap(n: number): number {
	let cap = 0;
	while (cap < n) {
		const newLen = cap + 1;
		let next: number;
		if (newLen > 2 * cap) {
			next = newLen;
		} else if (cap < 256) {
			next = 2 * cap;
		} else {
			next = cap;
			do {
				next += Math.floor((next + 3 * 256) / 4);
			} while (next < newLen);
		}
		cap = goRoundUpSize(next * 4) / 4;
	}
	return cap;
}
