package mfm

import (
	"bytes"
	"sort"
	"strings"
	"unicode/utf8"
	"unsafe"
)

// scanKind names the stop condition of a child loop, i.e. the closing
// delimiter that ends the children of a recursive construct.
type scanKind uint8

const (
	scanCenter scanKind = iota
	scanSmall
	scanBold
	scanItalic
	scanStrike
	scanBig
	scanBoldAsta
	scanStrikeWave
	scanFn
	scanLinkLabel
	numScanKinds
)

const (
	memoPageBits = 8
	memoPageSize = 1 << memoPageBits
)

// memoEntry is the node parseOne read at one position and where it ended. A
// nil node marks an empty cell of a dense page.
type memoEntry struct {
	node *Node
	end  int32
}

// sparseMax is the number of cells a page holds as a list before it becomes
// a dense array of memoPageSize cells.
const sparseMax = 16

// onePage holds the parseOne cells of one page of one slot: a list of
// (offset, entry) pairs while it has at most sparseMax cells, then a dense
// array indexed by offset.
type onePage struct {
	offs  []uint8
	cells []memoEntry
	dense bool
}

// scanPage is onePage for the ends of child loops (end+1, 0 = empty when
// dense).
type scanPage struct {
	offs  []uint8
	ends  []int32
	dense bool
}

// slotMemo holds the pages of one (depth, inLink, atFull) slot: the parseOne
// pages, and the pages of each kind of child loop used in the slot.
//
// 子のループの種類ごとの入れ物を固定の配列で持つと、1つのスロットで1種類しか
// 使わなくても全種類の分を確保する。短い引用を並べた入力は引用ごとに表を持つので、
// それが入力1バイトあたりで効く。使った種類だけを並べて持つ。
type slotMemo struct {
	one  []*onePage
	scan []scanPages
}

// scanPages is the pages of one kind of child loop in a slot.
type scanPages struct {
	kind  scanKind
	pages []*scanPage
}

// scanPagesOf returns the pages of kind in sm, or nil.
func (sm *slotMemo) scanPagesOf(kind scanKind) []*scanPage {
	for _, sp := range sm.scan {
		if sp.kind == kind {
			return sp.pages
		}
	}
	return nil
}

// memoTable caches parse results for one source string. Each run of quote
// lines is parsed as a separate string with its own table (see quoteAt).
//
// parseOneの結果(ノードと終了位置)はsrc上の位置・深さ・linkラベルの中か
// どうか・その深さがblockを読む最上位(fullDepth)かどうかだけで決まる
// (nestLimitとsimpleは1回のParseの間は変わらない)。深さはnestLimitに
// よる打ち切りで、inLinkはlinkを試すかどうかで、最上位かどうかはcenter・
// 検索を試すかどうかとブロックの構文が前後の改行を読むかどうか(tryBlock)で
// 結果を変えるので、どれも表を分ける軸(スロット)にする。病的な入力では全ての
// 深さの全ての位置を読むので、hash mapではなく位置で引くページ単位の配列にしてある
// (mapだと実測で時間の過半がhashに消えた)。
//
// ページは書き込むときに確保し、最初は(位置,結果)の短い並びで持ち、sparseMax件を
// 超えたら位置で引く配列に変える。閉じた深い入れ子を並べた投稿では、どの深さも
// 全てのページに数件ずつしか書かないので、初めから配列で持つと全ての深さで全ての
// ページを確保し、1バイトあたり約380バイトになって60KBほどで確保の上限に届いた。
// 多くの位置を読む病的な入力では、すぐに配列に変わるので、配列だけの場合と同じ量で済む。
type memoTable struct {
	srcLen    int
	nestLimit int
	budget    *workBudget
	// slots[i - slotBase]がスロットiのページ。入れ物は使ったスロットの範囲だけ持つ。
	// 引用の表は引用の深さより浅いスロットを使わないので、0から持つと深い引用で
	// 深さの2乗の入れ物になる
	slots    []*slotMemo
	slotBase int
	// quoteStartsは">"で始まる行の先頭位置(昇順)。quoteOffsets / quoteRunOfは
	// 同じ添字で、その行が塊の中身のどこから始まるかと、どの塊に属するか。
	// quotesStateはstopsStateと同じ意味。
	quoteStarts  []int32
	quoteOffsets []int32
	quoteRunOf   []int32
	quoteRuns    []quoteRun
	quotesState  int8
	// stops[k]は区切りまで読む構文kが止まる位置(昇順)。stopsState[k]は
	// 0 =未構築、1 =構築済み、-1 =使えない(srcが不正なUTF-8か確保の上限)。
	stops      [numStopKinds][]int32
	stopsState [numStopKinds]int8
	// linkTargetsはlinkの飛び先を(位置,深さ)ごとに読んだ結果(linkTargetAt)。
	linkTargets map[linkTargetKey]linkTargetEntry
}

// stopKind names a construct that reads raw text up to a delimiter.
type stopKind uint8

const (
	stopPlainClose     stopKind = iota // </plain>
	stopMathBlockClose                 // \]
	stopMathInline                     // \) or a newline (CR or LF)
	stopURLAltEnd                      // '>', ' ', '\u3000' or '\t'
	stopCenterClose                    // </center>
	stopCodeBlockClose                 // a newline, ``` and a line end
	numStopKinds
)

// stopList returns the sorted offsets in src where the scan of kind stops,
// building it on first use. ok is false when the list cannot be used.
//
// <plain> / \[ / \(は開きの直後から区切りまで1文字ずつ読み、
// 閉じなければ末尾まで読んで失敗する。開きを並べると開始位置ごとに同じ区間を
// 読み直すので入力長の2乗になり、深さごとにも繰り返す(3000バイトの
// 「\[」の並びで仕事量9000万、3000バイトの入力でも仕事量の上限に届いた)。
// 止まる位置を1度だけ列挙しておき、二分探索で引く。
//
// 元のループはrune単位で進み、不正なバイトではutf8.RuneLen(RuneError) = 3で
// 進む。区切りはASCIIかU+3000 (先頭バイトで始まるので境界が一致する)なので、
// 正しいUTF-8ならバイト単位で探した最初の出現と一致するが、不正なUTF-8では
// 一致しないので元のループに任せる。
func (m *memoTable) stopList(src string, kind stopKind) ([]int32, bool) {
	switch m.stopsState[kind] {
	case 1:
		return m.stops[kind], true
	case -1:
		return nil, false
	}
	m.stopsState[kind] = -1
	if !utf8.ValidString(src) {
		return nil, false
	}
	var list []int32
	switch kind {
	case stopPlainClose:
		list = indexAll(src, "</plain>")
	case stopMathBlockClose:
		list = indexAll(src, "\\]")
	case stopCenterClose:
		list = indexAll(src, "</center>")
	case stopMathInline:
		for i := 0; i < len(src); i++ {
			// mfm-jsのnewLineはCRでも止まる
			if src[i] == '\n' || src[i] == '\r' || strings.HasPrefix(src[i:], "\\)") {
				list = append(list, int32(i))
			}
		}
	case stopCodeBlockClose:
		for i := 0; i < len(src); i++ {
			if l := newlineLenIn(src, i); l > 0 && strings.HasPrefix(src[i+l:], "```") && lineEndIn(src, i+l+3) {
				list = append(list, int32(i))
			}
		}
	case stopURLAltEnd:
		for i := 0; i < len(src); i++ {
			if c := src[i]; c == '>' || c == ' ' || c == '\t' || strings.HasPrefix(src[i:], "\u3000") {
				list = append(list, int32(i))
			}
		}
	}
	if !m.charge(4 * cap(list)) {
		return nil, false
	}
	m.stops[kind] = list
	m.stopsState[kind] = 1
	return list, true
}

// linkTargetKey identifies a cached link target. URLの括弧を何段まで読めるかが
// 深さで変わるので、位置だけで引くと深いところで読んだ失敗を浅い試行に
// 使い回してしまう。
type linkTargetKey struct {
	pos, depth int32
}

// linkTargetEntry caches the link target parsed at one offset.
type linkTargetEntry struct {
	end int32
	url string
	ok  bool
}

// linkTargetEntryCost is the memory charged per cached link target, on top of
// the URL itself.
const linkTargetEntryCost = 48

// linkTargetAt parses the link target starting at pos (just after "](") and
// returns the URL and the offset right after it, like mfm-js's
// alt([urlAlt, url]) in the link rule. ok is false when there is no URL.
//
// 結果は位置ごとに覚える。多数の`[`が同じ「](」に届き、リンクが成立しない
// 形(`[[[[a](https://xxx...`で`)`が無いなど)では、同じ飛び先を`[`の数だけ
// 読み直して入力長の2乗になる。3000バイトでも仕事量の上限に届き、以降が
// テキストになる。
func (s *state) linkTargetAt(pos int) (url string, end int, ok bool) {
	m := s.memo
	key := linkTargetKey{pos: int32(pos), depth: int32(s.depth)}
	if e, hit := m.linkTargets[key]; hit {
		return e.url, int(e.end), e.ok
	}
	save := s.pos
	s.pos = pos
	url, ok = s.readLinkTarget()
	end = s.pos
	s.pos = save
	if m.charge(linkTargetEntryCost + len(url)) {
		if m.linkTargets == nil {
			m.linkTargets = map[linkTargetKey]linkTargetEntry{}
		}
		m.linkTargets[key] = linkTargetEntry{end: int32(end), url: url, ok: ok}
	}
	return url, end, ok
}

// urlAltStop returns the offset of the first '>' or space at or after pos
// (len(src) when none), or -1 when the work budget runs out.
func (s *state) urlAltStop(pos int) int {
	save := s.pos
	s.pos = pos
	stop, ok := s.nextStop(stopURLAltEnd)
	s.pos = save
	if ok {
		return stop
	}
	// 索引を作れないとき(メモの確保の上限に届いたとき。Parseは入口でUTF-8を
	// 正すので、不正なUTF-8は内部の呼び出しからしか来ない)は1文字ずつ読むが、
	// 読んだ分を仕事量に数えて上限で打ち切る。
	for i := pos; i < len(s.src); {
		if s.budget.used++; s.budget.exhausted() {
			return -1
		}
		r, size := utf8.DecodeRuneInString(s.src[i:])
		if r == '>' || r == ' ' || r == '\u3000' || r == '\t' {
			return i
		}
		i += size
	}
	return len(s.src)
}

// readLinkTarget reads `<https://...>` (mfm-js urlAlt, via readURLAlt) or a
// plain URL (mfm-js url, via tryURL).
func (s *state) readLinkTarget() (string, bool) {
	if s.peek() == '<' {
		return s.readURLAlt()
	}
	n := s.tryURL()
	if n == nil {
		return "", false
	}
	url, _ := n.Props["url"].(string)
	return url, url != ""
}

// readURLAlt reads mfm-js's urlAlt `<https://...>` at the current position:
// up to the closing '>' without a space, returning the URL without the
// brackets. The position moves past '>' only on success.
func (s *state) readURLAlt() (string, bool) {
	if s.peek() != '<' {
		return "", false
	}
	start := s.pos + 1
	bodyStart := start
	switch {
	case s.prefixAt(start, "https://"):
		bodyStart += len("https://")
	case s.prefixAt(start, "http://"):
		bodyStart += len("http://")
	default:
		return "", false
	}
	// 閉じの`>`か空白(mfm-jsのspaceは半角空白・全角空白・タブで、改行は
	// 含まない)まで読む。**1文字ずつ読まない** — `[a](<https://x`の後に改行を
	// 挟んで並べると、どの`](`からも末尾まで読むことになり入力長の2乗になる。
	// 区切りの位置の索引から引く。
	stop := s.urlAltStop(bodyStart)
	if stop < 0 || stop >= len(s.src) || s.src[stop] != '>' || stop == bodyStart {
		return "", false
	}
	s.pos = stop + 1
	return s.src[start:stop], true
}

// tryURLAlt parses mfm-js's urlAlt in text: `<https://...>` becomes a URL
// node with the brackets prop.
//
// mfm-jsは`<>`で囲むと、urlの文字に無い日本語や記号も含めて1つのURLに
// する。urlの文字はmfm-jsと同じくASCIIに限るので、これが無いと
// `<https://ja.wikipedia.org/wiki/日本>`が`wiki/`で切れる。
func (s *state) tryURLAlt() *Node {
	// リンクのラベルの中ではURLにしない(mfm-jsのnotLinkLabel)。
	if s.inLink {
		return nil
	}
	url, ok := s.readURLAlt()
	if !ok {
		return nil
	}
	return &Node{Type: NodeURL, Props: map[string]any{"url": url, "brackets": true}}
}

// indexAll returns the offsets of every (possibly overlapping) occurrence of
// needle in src.
func indexAll(src, needle string) []int32 {
	var out []int32
	for i := 0; ; {
		j := strings.Index(src[i:], needle)
		if j < 0 {
			return out
		}
		out = append(out, int32(i+j))
		i += j + 1
	}
}

// nextStop returns the first offset at or after the current position where
// the scan of kind stops, or len(src) when it runs to the end. ok is false
// when the caller must fall back to reading rune by rune.
func (s *state) nextStop(kind stopKind) (int, bool) {
	list, ok := s.memo.stopList(s.src, kind)
	if !ok {
		return 0, false
	}
	s.budget.used++
	i := sort.Search(len(list), func(i int) bool { return int(list[i]) >= s.pos })
	if i == len(list) {
		return len(s.src), true
	}
	return int(list[i]), true
}

// newMemoTable returns an empty table. Everything in it is allocated on first
// use and charged against the budget.
func newMemoTable(srcLen, nestLimit int, budget *workBudget) *memoTable {
	return &memoTable{srcLen: srcLen, nestLimit: nestLimit, budget: budget}
}

// oneKey returns the key of the context (depth, inLink, and whether depth is
// the block-reading top level) used to look up parseOne results, never 0. It
// is the slot index plus one; depth is at most MaxNestLimit, so it fits in 16
// bits.
func oneKey(depth int, inLink, atFull bool) uint16 {
	k := depth*4 + 1
	if inLink {
		k += 2
	}
	if atFull {
		k++
	}
	return uint16(k)
}

// scanKey returns the key of a child loop of kind in a context, never 0.
func scanKey(depth int, inLink, atFull bool, kind scanKind) uint16 {
	return (oneKey(depth, inLink, atFull)-1)*uint16(numScanKinds) + uint16(kind) + 1
}

// pageLen returns the number of cells of the page that holds pos.
func (m *memoTable) pageLen(pos int) int {
	return min(memoPageSize, m.srcLen+1-pos&^(memoPageSize-1))
}

// pageCount returns the number of pages of a slot.
func (m *memoTable) pageCount() int { return m.srcLen>>memoPageBits + 1 }

// Sizes charged for the parts of the table.
const (
	slotPtrSize     = int(unsafe.Sizeof((*slotMemo)(nil)))
	slotSize        = int(unsafe.Sizeof(slotMemo{}))
	pagePtrSize     = int(unsafe.Sizeof((*onePage)(nil)))
	onePageSize     = int(unsafe.Sizeof(onePage{}))
	scanPageSize    = int(unsafe.Sizeof(scanPage{}))
	scanPagesSize   = 2 * int(unsafe.Sizeof(scanPages{}))
	memoEntrySize   = int(unsafe.Sizeof(memoEntry{}))
	sparseEntrySize = memoEntrySize + 1
	scanEntrySize   = 4
)

// slot returns the slot with index i, allocating it (and growing the
// container) when alloc is set, or nil.
func (m *memoTable) slot(i int, alloc bool) *slotMemo {
	if i < 0 || i >= (m.nestLimit+1)*4 {
		return nil
	}
	if m.slots == nil {
		if !alloc {
			return nil
		}
		m.slotBase = i
	}
	if i < m.slotBase {
		if !alloc {
			return nil
		}
		// より浅いスロットを使うときは、入れ物の先頭を伸ばす
		grow := m.slotBase - i
		if !m.charge(grow * slotPtrSize) {
			return nil
		}
		m.slots = append(make([]*slotMemo, grow, grow+len(m.slots)), m.slots...)
		m.slotBase = i
	}
	j := i - m.slotBase
	if j >= len(m.slots) {
		if !alloc {
			return nil
		}
		// 伸ばすたびに倍にし、新しい大きさの分をchargeする。数える量は実際の確保の
		// 高々2倍
		n := min(max(j+1, 2*len(m.slots)), (m.nestLimit+1)*4-m.slotBase)
		if !m.charge(n * slotPtrSize) {
			return nil
		}
		m.slots = append(make([]*slotMemo, 0, n), m.slots...)[:n]
	}
	sm := m.slots[j]
	if sm == nil {
		if !alloc || !m.charge(slotSize+m.pageCount()*pagePtrSize) {
			return nil
		}
		sm = &slotMemo{one: make([]*onePage, m.pageCount())}
		m.slots[j] = sm
	}
	return sm
}

// slotAt returns the slot with index i if it is allocated, or nil. It is the
// fast path of slot for lookups.
func (m *memoTable) slotAt(i int) *slotMemo {
	if j := i - m.slotBase; uint(j) < uint(len(m.slots)) {
		return m.slots[j]
	}
	return nil
}

// lookupOne returns the node parseOne read at pos in the context key and the
// position after it, if cached.
func (m *memoTable) lookupOne(pos int, key uint16) (*Node, int, bool) {
	if pos < 0 || pos > m.srcLen {
		return nil, 0, false
	}
	sm := m.slotAt(int(key) - 1)
	if sm == nil {
		return nil, 0, false
	}
	pg := sm.one[pos>>memoPageBits]
	if pg == nil {
		return nil, 0, false
	}
	off := uint8(pos & (memoPageSize - 1))
	if pg.dense {
		e := pg.cells[off]
		return e.node, int(e.end), e.node != nil
	}
	if i := bytes.IndexByte(pg.offs, off); i >= 0 {
		return pg.cells[i].node, int(pg.cells[i].end), true
	}
	return nil, 0, false
}

// storeOne caches the node read at pos in the context key, ending at end.
// Nothing is stored when the memory budget refuses it.
func (m *memoTable) storeOne(pos int, key uint16, n *Node, end int) {
	if pos < 0 || pos > m.srcLen {
		return
	}
	sm := m.slotAt(int(key) - 1)
	if sm == nil {
		if sm = m.slot(int(key)-1, true); sm == nil {
			return
		}
	}
	pg := sm.one[pos>>memoPageBits]
	if pg == nil {
		if !m.charge(onePageSize) {
			return
		}
		pg = &onePage{}
		sm.one[pos>>memoPageBits] = pg
	}
	off := uint8(pos & (memoPageSize - 1))
	e := memoEntry{node: n, end: int32(end)}
	switch {
	case pg.dense:
		pg.cells[off] = e
	case len(pg.offs) < sparseMax:
		if i := bytes.IndexByte(pg.offs, off); i >= 0 {
			pg.cells[i] = e
			return
		}
		if !m.charge(sparseEntrySize) {
			return
		}
		pg.offs = append(pg.offs, off)
		pg.cells = append(pg.cells, e)
	default:
		// 並びを配列に変える。並びの分は手放すので数え直す
		if !m.charge(m.pageLen(pos)*memoEntrySize - len(pg.offs)*sparseEntrySize) {
			return
		}
		cells := make([]memoEntry, m.pageLen(pos))
		for i, o := range pg.offs {
			cells[o] = pg.cells[i]
		}
		cells[off] = e
		*pg = onePage{cells: cells, dense: true}
	}
}

// lookupScan returns where the child loop with key started at pos stops, if
// cached.
func (m *memoTable) lookupScan(pos int, key uint16) (int, bool) {
	if pos < 0 || pos > m.srcLen {
		return 0, false
	}
	sm := m.slotAt(int(key-1) / int(numScanKinds))
	if sm == nil {
		return 0, false
	}
	pages := sm.scanPagesOf(scanKind(int(key-1) % int(numScanKinds)))
	if pages == nil {
		return 0, false
	}
	pg := pages[pos>>memoPageBits]
	if pg == nil {
		return 0, false
	}
	off := uint8(pos & (memoPageSize - 1))
	if pg.dense {
		e := pg.ends[off]
		return int(e) - 1, e != 0
	}
	if i := bytes.IndexByte(pg.offs, off); i >= 0 {
		return int(pg.ends[i]) - 1, true
	}
	return 0, false
}

// storeScan caches that the child loop with key started at pos stops at end.
func (m *memoTable) storeScan(pos int, key uint16, end int) {
	if pos < 0 || pos > m.srcLen {
		return
	}
	sm := m.slotAt(int(key-1) / int(numScanKinds))
	if sm == nil {
		if sm = m.slot(int(key-1)/int(numScanKinds), true); sm == nil {
			return
		}
	}
	kind := scanKind(int(key-1) % int(numScanKinds))
	pages := sm.scanPagesOf(kind)
	if pages == nil {
		if !m.charge(scanPagesSize + m.pageCount()*pagePtrSize) {
			return
		}
		pages = make([]*scanPage, m.pageCount())
		sm.scan = append(sm.scan, scanPages{kind: kind, pages: pages})
	}
	pg := pages[pos>>memoPageBits]
	if pg == nil {
		if !m.charge(scanPageSize) {
			return
		}
		pg = &scanPage{}
		pages[pos>>memoPageBits] = pg
	}
	off := uint8(pos & (memoPageSize - 1))
	v := int32(end) + 1
	switch {
	case pg.dense:
		pg.ends[off] = v
	case len(pg.offs) < sparseMax:
		if i := bytes.IndexByte(pg.offs, off); i >= 0 {
			pg.ends[i] = v
			return
		}
		if !m.charge(scanEntrySize + 1) {
			return
		}
		pg.offs = append(pg.offs, off)
		pg.ends = append(pg.ends, v)
	default:
		if !m.charge(m.pageLen(pos)*scanEntrySize - len(pg.offs)*(scanEntrySize+1)) {
			return
		}
		ends := make([]int32, m.pageLen(pos))
		for i, o := range pg.offs {
			ends[o] = pg.ends[i]
		}
		ends[off] = v
		*pg = scanPage{ends: ends, dense: true}
	}
}

// quoteRun is a maximal run of consecutive lines starting with ">", with the
// markers stripped and the lines joined, and the table used to parse it.
type quoteRun struct {
	inner string
	end   int // position right after the run in the parent source
	table *memoTable
}

// quoteAt returns the quote run that a quote starting at the line start pos
// reads and the offset in run.inner where it starts, building every run of
// src on first use. ok is false when pos does not start a quote line or the
// runs could not be allocated.
//
// quoteは開始行から">"で始まる行が続く限りを読むので、塊の途中の行から始めた
// quoteの中身は、塊全体の中身の後ろ半分と一致する。行ごとに切り出して別の表で
// 読むと、閉じない<b>の下で各行の先頭から末尾までを切り出し・解析し直して行数の
// 2乗になり(3000バイトで仕事量150万、64KBならその約450倍)、
// 同じquoteを別の深さから読み直すたびに表を作り直すと入れ子の段数に対して
// 指数的になる(11段125バイトで仕事量の上限に届いた)。塊を1度だけ切り出し、
// 1つの表を全ての開始行と深さで共有する。quoteは最上位か引用の中身の最上位
// からしか読まないので、1つの表を読むstateのfullDepthは1通りに決まり、
// 表は深さをキーに含むので共有してよい(最上位かどうかの軸もキーに含めているが、
// これは守り)。また、
// 塊の途中から読むときの直前の文字は改行なので、行頭の判定も直前の文字の判定も
// 行ごとに切り出した場合と変わらない。
//
// 塊の一覧は1行ごとにchargeしながら作る。作り終えてからまとめてchargeすると、
// 短いquoteを並べた1MBの入力で上限を確かめる前に100MBを確保した(実測)。
func (m *memoTable) quoteAt(src string, pos int) (*quoteRun, int, bool) {
	if m.quotesState == 0 && !m.buildQuotes(src) {
		return nil, 0, false
	}
	if m.quotesState != 1 {
		return nil, 0, false
	}
	i := sort.Search(len(m.quoteStarts), func(i int) bool { return int(m.quoteStarts[i]) >= pos })
	if i == len(m.quoteStarts) || int(m.quoteStarts[i]) != pos {
		return nil, 0, false
	}
	run := &m.quoteRuns[m.quoteRunOf[i]]
	if run.table == nil {
		if !m.charge(int(unsafe.Sizeof(memoTable{}))) {
			return nil, 0, false
		}
		run.table = newMemoTable(len(run.inner), m.nestLimit, m.budget)
	}
	return run, int(m.quoteOffsets[i]), true
}

// buildQuotes splits src into quote runs. It reports false, leaving the runs
// unusable, when the memory budget refuses them.
func (m *memoTable) buildQuotes(src string) bool {
	m.quotesState = -1
	var (
		b        strings.Builder
		inRun    bool
		lineCost = int(3 * unsafe.Sizeof(int32(0)))
	)
	flush := func(end int) {
		if !inRun {
			return
		}
		r := &m.quoteRuns[len(m.quoteRuns)-1]
		r.inner, r.end = b.String(), end
		b.Reset()
		inRun = false
	}
	// 行はmfm-jsのnewLine (CRLF / CR / LF)で切る。各行の中身は改行を含まず、
	// 中身は"\n"でつなぐ(mfm-jsはcontents.join("\n"))。LFだけで切ると、
	// `> a\rb`のCRの後ろまで引用に入り、`\r> a`のCRの直後を行頭とみなさない。
	for p := 0; p < len(src); {
		e := strings.IndexAny(src[p:], "\r\n")
		if e < 0 {
			e = len(src)
		} else {
			e += p
		}
		next := e + newlineLenIn(src, e)
		if src[p] != '>' {
			flush(p)
			p = next
			continue
		}
		c := p + 1
		// `>`の直後の空白はmfm-jsのspace.option()で、全角空白も1つ読む
		switch {
		case c < len(src) && (src[c] == ' ' || src[c] == '\t'):
			c++
		case strings.HasPrefix(src[c:], "\u3000"):
			c += len("\u3000")
		}
		cost := lineCost + e - c + 1
		if !inRun {
			cost += int(unsafe.Sizeof(quoteRun{}))
		}
		if !m.charge(cost) {
			m.quoteStarts, m.quoteOffsets, m.quoteRunOf, m.quoteRuns = nil, nil, nil, nil
			return false
		}
		if !inRun {
			m.quoteRuns = append(m.quoteRuns, quoteRun{})
			inRun = true
		} else {
			b.WriteByte('\n')
		}
		m.quoteStarts = append(m.quoteStarts, int32(p))
		m.quoteOffsets = append(m.quoteOffsets, int32(b.Len()))
		m.quoteRunOf = append(m.quoteRunOf, int32(len(m.quoteRuns)-1))
		b.WriteString(src[c:e])
		p = next
	}
	flush(len(src))
	m.quotesState = 1
	return true
}

// charge accounts n bytes of memo storage against the shared budget and
// reports whether the allocation may proceed.
//
// 仕事量の上限だけではメモリが縛れない。病的な入力は全ての深さ・全ての構文の
// 表を触るので、長さを切り詰めない1MBの入力で1.9GBを確保した(実測)。上限に
// 達したら以降は構文を試さずテキストとして読ませる(workBudget.exhaustedが真に
// なる)ので、確保はそこで止まる。
func (m *memoTable) charge(n int) bool {
	b := m.budget
	if b == nil {
		return true
	}
	if b.memUsed+n > b.memLimit {
		b.used = b.limit + 1
		return false
	}
	b.memUsed += n
	return true
}

// workBudget bounds the total parsing work of one Parse call. Quote bodies
// share the budget of the Parse call that contains them.
type workBudget struct {
	used     int
	limit    int
	memUsed  int
	memLimit int
}

// メモ化と区切り位置の索引で、閉じない構文を並べた入力も入力長に比例する仕事量に
// なる。ただし比例定数は深さ(最大21段)の分だけ大きく、「>>」の後ろに
// 「$[x.a=b __*https://a:」を並べると1バイトあたり約85になる(実測。閉じない
// 装飾は読んだ範囲ごと文字にするので、それだけを並べた形は1バイトあたり2回)。
// 見落とした経路があっても1回のParseが際限なく走らないよう、安全網として
// 上限を置く。超えたら以降の未解析の位置は構文を試さずテキストとして読む。
//
// 基礎分はMisskeyの投稿の上限(3000文字)の入力が届かない大きさにしてある。
// 3000バイトの病的な入力で実測した最大は約51万(「[」を1000個並べた後ろに
// 長い飛び先を置く形。上の形は約25万)で、基礎分だけでその4倍ある。それより
// 長い入力は、病的な形なら上限かメモ表の上限に届いて途中からテキストになる
// (通常の文章は1バイトあたり2未満なので仕事量の上限には届かない)。
const (
	workBudgetBase    = 1 << 21
	workBudgetPerByte = 32
	// メモ表が1回のParseで確保してよい総量は、基礎分と入力1バイトあたりの分の
	// 大きい方。256KBまでは基礎分が効き、病的な入力が確保できる量は入力長に
	// よらない。引用を含まない閉じた深い入れ子(既定の上限の20段)の実測は1バイト
	// あたり約13バイト以下で、どの長さでも上限に届かない。引用は塊ごとに表を持ち、
	// 塊1つあたり約500バイト(入れ子の引用は段ごとに)の固定の費用がかかるので、
	// 短い引用を並べると上限に届く(「> a⏎⏎」の並びは約166KB、20段の引用の並びは
	// 約38KBから)。3000バイトの入力では、短い引用の並びで最大約1.3MB、上の病的な
	// 形で約2.2MB(実測)で、上限より十分小さい
	memoBytesBase    = 16 << 20
	memoBytesPerByte = 64
)

func (b *workBudget) exhausted() bool { return b.used > b.limit }

// newState returns the state for parsing src from the start with the default
// nest limit of mfm-js (20).
func newState(src string, simple bool) *state {
	return newStateWithLimit(src, simple, defaultNestLimit)
}

// newStateWithLimit returns the state for parsing src from the start with the
// given nest limit, with a fresh memo table and work budget.
func newStateWithLimit(src string, simple bool, nestLimit int) *state {
	budget := &workBudget{
		limit:    workBudgetBase + workBudgetPerByte*len(src),
		memLimit: max(memoBytesBase, memoBytesPerByte*len(src)),
	}
	return &state{
		src:       src,
		nestLimit: nestLimit,
		simple:    simple,
		memo:      newMemoTable(len(src), nestLimit, budget),
		budget:    budget,
	}
}
