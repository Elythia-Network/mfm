// Package mfm parses MFM (Misskey Flavored Markdown) into the same tree as
// mfm-js 0.26.0, in time and memory linear in the input length.
//
// Positions are kept as 32-bit integers, so inputs of 2 GiB or more are not
// supported.
//
// Parse corresponds to mfm-js's parse and ParseSimple to parseSimple. The
// trees, encoded with encoding/json, have the shape of mfm-js's output. See
// the repository README for the known differences from mfm-js.
package mfm

import (
	"strings"
	"unicode/utf8"
)

// defaultNestLimit is mfm-js's default nestLimit.
const defaultNestLimit = 20

// 入れ子はGoの再帰で読むので、上限が無いと深い入力でスタックとメモの表が
// 入力長と上限の積で育つ。mfm-jsの既定は20なので、実用の値には届かない。

// MaxNestLimit is the largest nest limit ParseWithNestLimit accepts; larger
// values are lowered to it. Nesting is read by recursion, and deeper limits
// would let the stack and the memo grow with the input length times the limit.
const MaxNestLimit = 1000

// Parse parses input with mfm-js's full parser (`mfm.parse(input)`), which
// reads every MFM construct, with the default nest limit of 20.
//
// Invalid UTF-8 is replaced with U+FFFD first. The result is never nil: an
// empty input gives an empty slice, which encodes as [] like mfm-js's result.
func Parse(input string) []*Node {
	return ParseWithNestLimit(input, defaultNestLimit)
}

// ParseWithNestLimit is Parse with mfm-js's nestLimit option
// (`mfm.parse(input, { nestLimit })`): constructs nested deeper than
// nestLimit are read as plain text. A negative limit behaves like 0, and a
// limit above MaxNestLimit is lowered to MaxNestLimit.
func ParseWithNestLimit(input string, nestLimit int) []*Node {
	nestLimit = clampNestLimit(nestLimit)
	// 不正なUTF-8はパーサの中でruneとbyteの長さが食い違い、sliceの範囲外で
	// panicする(`"> \xff"`など)。JSON由来の入力は置き換え済みだが、DBや
	// プラグインから来る文字列まで保証できないので入口で揃える
	input = strings.ToValidUTF8(input, "\uFFFD")
	return nonNil(newStateWithLimit(input, false, nestLimit).parseNodes(true))
}

// nonNil returns nodes, or an empty slice instead of nil.
//
// mfm-jsは空の入力に[]を返す。nilのままだとencoding/jsonがnullにする
func nonNil(nodes []*Node) []*Node {
	if nodes == nil {
		return []*Node{}
	}
	return nodes
}

// clampNestLimit returns n limited to [0, MaxNestLimit].
//
// 負の上限はmfm-jsでも0と同じ結果になる(深さ1以上は全て上限を超える)が、
// メモの表の大きさを上限から決めるので、負の値を持ち込まない。
func clampNestLimit(n int) int { return min(max(n, 0), MaxNestLimit) }

// ParseSimple parses input with mfm-js's simple parser
// (`mfm.parseSimple(input)`), which reads only Unicode emoji, custom emoji
// codes and <plain>. It is meant for short texts such as user names.
//
// Invalid UTF-8 is replaced with U+FFFD first. Like Parse, the result is never
// nil.
func ParseSimple(input string) []*Node {
	input = strings.ToValidUTF8(input, "\uFFFD")
	return nonNil(newState(input, true).parseNodes(true))
}

// state is the cursor of one parse over one source string. A quote body is
// parsed by a separate state over the joined quote lines that shares the
// work budget.
type state struct {
	src       string
	pos       int // byte offset in src
	depth     int // mfm-js's state.depth at pos
	nestLimit int
	simple    bool // reading with the simple parser
	inLink    bool // inside a link label (mfm-js's state.linkLabel)
	// fullDepth is the depth at which this state reads with mfm-js's full
	// parser (the top level, or the body of a quote). Children of nested
	// constructs are deeper and read with the inline parser.
	fullDepth int
	memo      *memoTable
	budget    *workBudget
}

// remaining returns the unread part of the source.
func (s *state) remaining() string { return s.src[s.pos:] }

// eof reports whether the whole source has been read.
func (s *state) eof() bool { return s.pos >= len(s.src) }

// peek returns the code point at the current position without consuming it,
// or -1 at the end of the source.
func (s *state) peek() rune {
	if s.eof() {
		return -1
	}
	if c := s.src[s.pos]; c < utf8.RuneSelf {
		return rune(c)
	}
	r, _ := utf8.DecodeRuneInString(s.src[s.pos:])
	return r
}

func (s *state) advance(n int) {
	s.pos += n
	s.budget.used++
}

// hasPrefix reports whether the unread part starts with p.
func (s *state) hasPrefix(p string) bool { return strings.HasPrefix(s.src[s.pos:], p) }

// parseNodes reads nodes up to the end of the source, like mfm-js's
// `parser.many(0)`. With merge set, adjacent text nodes are joined as mfm-js
// does for the final result (mergeText).
func (s *state) parseNodes(merge bool) []*Node {
	var out []*Node
	for !s.eof() {
		n := s.parseOne()
		if n == nil {
			break
		}
		out = append(out, n)
	}
	if !merge {
		return out
	}
	return mergeText(out)
}

// parseOne reads one node at the current position with the parser mfm-js
// uses there (simple, full or inline), or returns nil at the end of the
// source.
func (s *state) parseOne() *Node {
	if s.eof() {
		return nil
	}
	s.budget.used++
	if s.simple {
		// simpleには入れ子が無いので、位置ごとの結果を覚える必要も無い
		return s.parseSimpleOne()
	}
	// mfm-jsのnestは、深さが上限に届いた子を構文として読まず1文字ずつ読む
	// (alt([seq(nestable, parser), char]))。装飾は中身を閉じまで読むので、上限の
	// 下でも閉じが無ければ読んだ範囲がまるごと文字になる。最上位(深さ0)は
	// nestを通らないので、上限が0でも構文として読む
	if s.depth > 0 && s.depth >= s.nestLimit {
		return s.consumeChar()
	}
	// 深さ0かつlinkラベルの外で読む位置は最上位のループが1度ずつ読むだけで、
	// 読み直されることが無い(子のループは深さ1以上かlinkラベルの中)。
	// 素のテキストで表を膨らませないよう記録しない
	if s.depth == 0 && !s.inLink {
		return s.parseFullOne()
	}
	// 閉じない<b>などは失敗するたびに1文字進めて、同じ位置を別の親から
	// 読み直す。メモ化しないと入力長に対して指数時間になる
	key := oneKey(s.depth, s.inLink, s.depth == s.fullDepth)
	if n, end, ok := s.memo.lookupOne(s.pos, key); ok {
		s.pos = end
		return n
	}
	start := s.pos
	n := s.parseFullOne()
	// 確保の上限に届いて覚えられなくても、そのときは仕事量も使い切った扱いなので、
	// 以降は1文字ずつのテキストになるだけで済む
	s.memo.storeOne(start, key, n, s.pos)
	return n
}

// parseSimpleOne reads one node like mfm-js's simple rule:
// alt([unicodeEmoji, emojiCode, plainTag, text]).
func (s *state) parseSimpleOne() *Node {
	if s.budget.exhausted() {
		return s.consumeChar()
	}
	if n := s.tryUnicodeEmoji(); n != nil {
		return n
	}
	if n := s.tryEmojiCode(); n != nil {
		return n
	}
	if n := s.tryPlainTag(); n != nil {
		return n
	}
	return s.consumeChar()
}

// parseFullOne reads one node like mfm-js's full rule at the top level or in
// a quote body, and like its inline rule elsewhere. The candidates are tried
// in mfm-js's order; the block constructs (center, code block, quote, math
// block, search) refuse to match outside a full context, which leaves the
// order of mfm-js's inline rule.
func (s *state) parseFullOne() *Node {
	if s.budget.exhausted() {
		return s.consumeChar()
	}
	if n := s.tryUnicodeEmoji(); n != nil {
		return n
	}
	// centerからurlAltまでは`<` (centerは前の改行)で始まる。それ以外の
	// 文字では試しても必ず失敗するので飛ばす(順序は変わらない)
	if c := s.src[s.pos]; c == '<' || c == '\n' || c == '\r' {
		if n := s.tryAngleSyntax(); n != nil {
			return n
		}
	}
	for _, try := range [...]func(*state) *Node{
		(*state).tryBig,
		(*state).tryBoldAsta,
		(*state).tryItalicAsta,
		(*state).tryBoldUnder,
		(*state).tryItalicUnder,
		func(s *state) *Node { return s.tryBlock(1, 0, false, (*state).tryCodeBlock) },
		(*state).tryInlineCode,
		func(s *state) *Node { return s.tryBlock(2, 1, false, (*state).tryQuote) },
		func(s *state) *Node { return s.tryBlock(1, 1, true, (*state).tryMathBlock) },
		(*state).tryMathInline,
		(*state).tryStrikeWave,
		(*state).tryFn,
		(*state).tryMention,
		(*state).tryHashtag,
		(*state).tryEmojiCode,
		(*state).tryLink,
		(*state).tryURL,
		func(s *state) *Node { return s.tryBlock(1, 1, false, (*state).trySearch) },
	} {
		if n := try(s); n != nil {
			return n
		}
	}
	return s.consumeChar()
}

// tryAngleSyntax tries, in mfm-js's order, the candidates between
// unicodeEmoji and big: centerTag, smallTag, plainTag, boldTag, italicTag,
// strikeTag and urlAlt.
func (s *state) tryAngleSyntax() *Node {
	for _, try := range [...]func(*state) *Node{
		(*state).tryCenterTag,
		(*state).trySmallTag,
		(*state).tryPlainTag,
		(*state).tryBoldTag,
		(*state).tryItalicTag,
		(*state).tryStrikeTag,
		(*state).tryURLAlt,
	} {
		if n := try(s); n != nil {
			return n
		}
	}
	return nil
}

// asciiText holds shared single-byte text nodes returned by consumeChar.
//
// 失敗した試行の中で読んだ1文字ずつのノードは大半が捨てられるので、ASCIIは
// 共有して割り当てを省く。出力に出るテキストノードはmergeTextが必ず作り直す
// ので、共有ノードが呼び出し側へ渡って書き換えられることは無い
var asciiText [utf8.RuneSelf]*Node

func init() {
	for c := range asciiText {
		asciiText[c] = Text(string(rune(c)))
	}
}

// consumeChar reads one character as a text node, like mfm-js's text rule.
// The caller ensures the source is not exhausted.
//
// mfm-jsはUTF-16の1単位ずつ読むが、サロゲートの片割れから始まる構文は
// 無いので、1コードポイントずつ読んでも結果のテキストは同じになる。
func (s *state) consumeChar() *Node {
	start := s.pos
	if c := s.src[start]; c < utf8.RuneSelf {
		s.advance(1)
		return asciiText[c]
	}
	_, size := utf8.DecodeRuneInString(s.src[start:])
	s.advance(size)
	return Text(s.src[start:s.pos])
}

// nest runs read one nesting level deeper, like mfm-js's nest(parser): when
// the deeper level reaches the nest limit, mfm-js reads the rest one
// character at a time instead, which here is the single text node rest.
func (s *state) nest(rest string, read func() []*Node) []*Node {
	s.depth++
	defer func() { s.depth-- }()
	if s.depth >= s.nestLimit {
		return []*Node{Text(rest)}
	}
	return read()
}

// collectTo parses nodes from the current position up to end, which must be
// a position scanEnd returned for the same depth and inLink. Every step is a
// memo hit because scanEnd already walked the same chain.
func (s *state) collectTo(end int) []*Node {
	var nodes []*Node
	for s.pos < end {
		n := s.parseOne()
		if n == nil {
			break
		}
		nodes = append(nodes, n)
	}
	return nodes
}

// mergeText joins runs of adjacent text nodes into one new text node, like
// mfm-js's mergeText. Every text node of the result is newly allocated.
//
// 入力のノードは書き換えない。parseOneのメモは同じノードを複数の試行へ返すので、
// 前のテキストノードへ連結する形だと別の試行が持つノードまで書き換わる。連続する
// テキストは1つのBuilderにまとめる(1文字ずつ連結すると長さの2乗になる)。
func mergeText(nodes []*Node) []*Node {
	var out []*Node
	for i := 0; i < len(nodes); {
		if nodes[i].Type != NodeText {
			out = append(out, nodes[i])
			i++
			continue
		}
		j := i
		var b strings.Builder
		for ; j < len(nodes) && nodes[j].Type == NodeText; j++ {
			b.WriteString(nodes[j].textValue())
		}
		out = append(out, Text(b.String()))
		i = j
	}
	return out
}

// prefixAt reports whether src has prefix p at byte offset pos.
func (s *state) prefixAt(pos int, p string) bool {
	return pos <= len(s.src) && strings.HasPrefix(s.src[pos:], p)
}

// stopsAt reports whether the child loop of kind ends at the current position.
func (s *state) stopsAt(kind scanKind) bool {
	switch kind {
	case scanCenter:
		// mfm-jsは`notMatch(seq(newLine.option(), close))`で止まるので、閉じの
		// 直前の改行は子に含めない
		return s.centerCloseAt(s.pos)
	case scanSmall:
		return s.hasPrefix("</small>")
	case scanBold:
		return s.hasPrefix("</b>")
	case scanItalic:
		return s.hasPrefix("</i>")
	case scanStrike:
		return s.hasPrefix("</s>")
	case scanBig:
		return s.hasPrefix("***")
	case scanBoldAsta:
		// mfm-jsのboldAstaは改行で止まらない(`**a⏎b**`は太字)。
		return s.hasPrefix("**")
	case scanStrikeWave:
		// mfm-jsのnewLineはCRLF / CR / LFのどれか。
		return s.hasPrefix("~~") || s.peek() == '\n' || s.peek() == '\r'
	case scanFn:
		return s.peek() == ']'
	case scanLinkLabel:
		// ~~と同じく、mfm-jsのnewLineはCRでも止まる
		return s.peek() == ']' || s.peek() == '\n' || s.peek() == '\r'
	}
	return true
}

// scanEnd returns the position where the child loop of kind, started at the
// current position with the current depth and inLink, stops: the first
// position reached by successive parseOne calls that is EOF or satisfies
// stopsAt. The current position is left unchanged.
//
// 同じ位置から始まる子のループは、止まる条件が同じなら必ず同じ位置で止まる。
// 開きタグが失敗して1文字進むたびに同じ区間を末尾まで辿り直すと、parseOneを
// メモ化していても入力長の2乗になるので、止まる位置を経路上の全位置に記録する。
func (s *state) scanEnd(kind scanKind) int {
	key := scanKey(s.depth, s.inLink, s.depth == s.fullDepth, kind)
	start := s.pos
	var path []int
	end := start
	for {
		if s.eof() || s.stopsAt(kind) {
			end = s.pos
			break
		}
		if e, ok := s.memo.lookupScan(s.pos, key); ok {
			end = e
			break
		}
		path = append(path, s.pos)
		if s.parseOne() == nil {
			end = s.pos
			break
		}
	}
	for _, p := range path {
		s.memo.storeScan(p, key, end)
	}
	s.pos = start
	return end
}
