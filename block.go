package mfm

import (
	"strings"
	"unicode/utf8"
)

// fullContext reports whether the current position is read by mfm-js's full
// parser (the top level or the contents of a quote) rather than by the inline
// parser of a construct's children. Only the full parser has the block
// constructs and search.
//
// block構文はfullでだけ試すので、引用の中身の深さは最上位と同じに
// なり、同じ深さの位置がfullのこともそうでないこともある経路は今は無い。
// メモの表は守りとしてdepth == fullDepthかどうかでも分けてある(oneKey)。
// linkのラベルは1段深く読むので深さの比較だけでも外れるが、
// ラベルの中をfullに数えないことをinLinkでも明示しておく。
func (s *state) fullContext() bool {
	return !s.simple && !s.inLink && s.depth == s.fullDepth
}

// skipNewlines returns the position after up to n newlines (CRLF, CR or LF,
// like mfm-js's newLine) starting at pos.
func (s *state) skipNewlines(pos, n int) int {
	for ; n > 0; n-- {
		l := s.newlineLenAt(pos)
		if l == 0 {
			break
		}
		pos += l
	}
	return pos
}

// tryBlock tries a block construct the way mfm-js's full parser does: the
// construct first reads up to lead newlines (newLine.option()) and, once it
// matched, up to trail more newlines after it. When whole is set, the
// construct must also start at a line begin and end at a line end (mfm-js's
// lineBegin and lineEnd), which try does not check itself. Outside a full
// context it fails without trying, as mfm-js's inline has no block constructs.
//
// mfm-jsの検索・引用・コードブロック・数式ブロックは改行の位置から試され、
// 前の改行を自分のノードに含める。改行の位置では次の行のハッシュタグ・
// メンション・絵文字などはまだ試されないので、行頭がそれらでも検索になる。
// 前の改行を読んで失敗したときは、改行を読まずにやり直さない
// (mfm-jsのoptionは後戻りしない)。後ろの改行は、引用が2つ、他は1つまで
// 読む。引用の塊とコードブロックは、その1つ目をtryが既に読んでいる。
// centerは前後の改行と行頭・行末をtryCenterTagが自分で確かめるので、
// ここを通さない。
//
// 改行の位置から試すと、行の先頭と末尾を確かめない数式ブロックは前の行の
// 改行を読んで行の途中のものまで拾い、検索より先に成功してしまうので、
// fullではwholeで確かめる。
func (s *state) tryBlock(lead, trail int, whole bool, try func(*state) *Node) *Node {
	if !s.fullContext() {
		return nil
	}
	save := s.pos
	s.pos = s.skipNewlines(save, lead)
	if whole && !s.atLineBegin() {
		s.pos = save
		return nil
	}
	n := try(s)
	if n == nil || whole && !s.lineEndAt(s.pos) {
		s.pos = save
		return nil
	}
	s.pos = s.skipNewlines(s.pos, trail)
	return n
}

// tryQuote reads mfm-js's quote at a line begin: the run of consecutive lines
// starting with ">" (each with one optional space after it), whose bodies,
// joined with "\n", are parsed one level deeper with the full parser. The
// newline that ends the run is part of the quote; tryBlock reads the
// newlines around it.
func (s *state) tryQuote() *Node {
	// mfm-jsのblock構文(quote / codeBlock / mathBlock / search)はfullでだけ
	// 読み、inline (装飾やcenterの子)には無い。子で読むと、閉じのある装飾も
	// 閉じをblockに飲まれて丸ごと文字になり、後ろのメンションやタグが落ちる。
	if s.depth != s.fullDepth {
		return nil
	}
	// リンクのラベルの中では引用にしない。mfm-jsのinlineにはquoteが
	// 無いので、ラベルの中の`> `は文字のまま。部分のstateにはinLinkが
	// 渡らないので、引用にするとラベルの中でメンション・ハッシュタグ・URL・
	// 入れ子のリンクの判定を抜けてしまう。
	if s.inLink {
		return nil
	}
	// 行頭もしくはテキスト先頭のみ。mfm-jsのlineBeginはCRの直後も行頭とみなす
	if !s.atLineBegin() || s.peek() != '>' {
		return nil
	}
	run, offset, ok := s.memo.quoteAt(s.src, s.pos)
	if !ok {
		return nil
	}
	body := run.inner[offset:]
	// 中身が空の1行だけ(`>`のみ)は、mfm-jsでは引用にならない。2行以上なら
	// 中身は"\n"を含むので空にならない
	if body == "" {
		return nil
	}
	s.budget.used++
	children := s.nest(body, func() []*Node {
		// 中身は引用の深さ(nestの1段下)を最上位とするfullで読む
		sub := &state{src: run.inner, pos: offset, depth: s.depth, fullDepth: s.depth, nestLimit: s.nestLimit, memo: run.table, budget: s.budget}
		return sub.parseNodes(true)
	})
	s.pos = run.end
	return withChildren(NodeQuote, children)
}

// tryCodeBlock reads mfm-js's codeBlock at a line begin: "```", an optional
// language up to the line end, a newline, at least one character of code, and
// a newline, "```" and a line end, followed by one optional newline.
func (s *state) tryCodeBlock() *Node {
	// mfm-jsのblock構文(quote / codeBlock / mathBlock / search)はfullでだけ
	// 読み、inline (装飾やcenterの子)には無い。子で読むと、閉じのある装飾も
	// 閉じをblockに飲まれて丸ごと文字になり、後ろのメンションやタグが落ちる。
	if s.depth != s.fullDepth {
		return nil
	}
	// mfm-js 0.26.0のcodeBlock:
	//
	//	seq(newLine.option(), lineBegin, mark, (notMatch(newLine) char)*, newLine,
	//	    (notMatch(seq(newLine, mark, lineEnd)) char)+, newLine, mark, lineEnd,
	//	    newLine.option())
	//
	// 前の改行はtryBlockが読む。改行はCRLF / CR / LFのどれでもよく、中身は
	// 1文字以上要る(` ```⏎⏎``` `は文字)。閉じの```の直後は行の終わりでなければ
	// ならない。
	if !s.atLineBegin() || !s.hasPrefix("```") {
		return nil
	}
	save := s.pos
	langStart := s.pos + 3
	langEnd := len(s.src)
	if i := strings.IndexAny(s.src[langStart:], "\r\n"); i >= 0 {
		langEnd = langStart + i
	}
	s.budget.used += langEnd - langStart
	if langEnd == len(s.src) {
		// 言語の行の後ろに改行が無い
		return nil
	}
	// mfm-jsは言語名をString.prototype.trimで削る。GoのTrimSpaceとは空白の
	// 集合が違う(U+0085を削らずU+FEFFを削る)ので、JSと同じ集合で削る
	lang := jsTrim(s.src[langStart:langEnd])
	codeStart := langEnd + s.newlineLenAt(langEnd)
	s.pos = codeStart
	closeAt, ok := s.codeBlockClose()
	if !ok || closeAt == codeStart {
		s.pos = save
		return nil
	}
	code := s.src[codeStart:closeAt]
	s.pos = closeAt + s.newlineLenAt(closeAt) + len("```")
	s.advance(s.newlineLen())
	// 言語が空ならmfm-jsはnullを入れる
	var langProp any
	if lang != "" {
		langProp = lang
	}
	return &Node{Type: NodeBlockCode, Props: map[string]any{"code": code, "lang": langProp}}
}

// codeBlockClose returns the first position at or after the current one where
// a newline, ``` and a line end follow. ok is false when there is none or the
// work budget runs out.
//
// 開きを並べて閉じを置かない入力(```a⏎ の繰り返し)では、開きごとに末尾まで
// 探すと入力長の2乗になるので、閉じの位置の索引から引く。
func (s *state) codeBlockClose() (int, bool) {
	if c, ok := s.nextStop(stopCodeBlockClose); ok {
		return c, c < len(s.src)
	}
	for i := s.pos; i < len(s.src); i++ {
		if s.budget.used++; s.budget.exhausted() {
			return 0, false
		}
		if l := s.newlineLenAt(i); l > 0 && s.prefixAt(i+l, "```") && s.lineEndAt(i+l+3) {
			return i, true
		}
	}
	return 0, false
}

// tryMathBlock reads mfm-js's mathBlock body: `\[`, one optional newline, at
// least one character of formula, one optional newline and `\]`. tryBlock
// checks the line begin and end and reads the newlines around it.
func (s *state) tryMathBlock() *Node {
	// mfm-jsのblock構文(quote / codeBlock / mathBlock / search)はfullでだけ
	// 読み、inline (装飾やcenterの子)には無い。子で読むと、閉じのある装飾も
	// 閉じをblockに飲まれて丸ごと文字になり、後ろのメンションやタグが落ちる。
	if s.depth != s.fullDepth {
		return nil
	}
	// mfm-js 0.26.0のmathBlock:
	//
	//	seq(newLine.option(), lineBegin, open, newLine.option(),
	//	    seq(notMatch(seq(newLine.option(), close)), char).select(1).many(1),
	//	    newLine.option(), close, lineEnd, newLine.option())
	//
	// 中身は開きの直後の改行を1つと、閉じの直前の改行を1つ外すだけで、空白は
	// 削らない(`\[\tx\]`は"\tx")。
	if !s.hasPrefix(`\[`) {
		return nil
	}
	save := s.pos
	s.advance(len(`\[`))
	s.advance(s.newlineLen())
	start := s.pos
	closeAt, ok := s.nextStop(stopMathBlockClose)
	if !ok {
		// 索引を使えないとき(確保の上限)は直接探す。Parseが入口で正しいUTF-8に
		// 揃えており、区切りはASCIIなので、見つかる位置は索引と同じになる
		closeAt = len(s.src)
		if i := strings.Index(s.src[start:], `\]`); i >= 0 {
			closeAt = start + i
		}
		s.budget.used += closeAt - start
	}
	if closeAt >= len(s.src) {
		s.pos = save
		return nil
	}
	// 中身は「(改行) +閉じ」が最初に読める位置で終わる。閉じの直前の改行
	// (CRLF / CR / LF)が中身の範囲にあれば、そこが終わり
	end := closeAt - trailingNewlineLen(s.src, start, closeAt)
	// 中身は1文字以上要る。最初の位置で止まるとmany(1)が失敗する
	if end == start {
		s.pos = save
		return nil
	}
	s.pos = closeAt + len(`\]`)
	return withProp(NodeMathBlock, "formula", s.src[start:end])
}

// trailingNewlineLen returns the length of the newline (CRLF, CR or LF) that
// ends src[from:to], or 0.
func trailingNewlineLen(src string, from, to int) int {
	switch {
	case to-2 >= from && src[to-2:to] == "\r\n":
		return 2
	case to-1 >= from && (src[to-1] == '\n' || src[to-1] == '\r'):
		return 1
	}
	return 0
}

// tryCenterTag follows mfm-js 0.26.0's centerTag:
//
//	seq(newLine.option(), lineBegin, open, newLine.option(),
//	    seq(notMatch(seq(newLine.option(), close)), nest(r.inline)).select(1).many(1),
//	    newLine.option(), close, lineEnd, newLine.option())
//
// centerはfullにだけありinlineには無いので、装飾やリンクのラベルの子では
// 読まない。行の先頭で始まり閉じの直後が行の終わりのときだけ読み、
// 開きの前・開きの直後・閉じの直前・閉じの直後の改行を1つずつ飲み込む。
func (s *state) tryCenterTag() *Node {
	const openTag, closeTag = "<center>", "</center>"
	// 装飾やリンクのラベルの子はfullDepthより深いので、ここで外れる。深さの
	// 上限の位置はparseOneが1文字ずつ文字として読むので、ここへ来ない
	if s.depth != s.fullDepth {
		return nil
	}
	save := s.pos
	s.advance(s.newlineLen())
	if !s.atLineBegin() || !s.hasPrefix(openTag) {
		s.pos = save
		return nil
	}
	s.advance(len(openTag))
	s.advance(s.newlineLen())
	start := s.pos

	// 子は1段深いinlineで読む。その深さが上限に届くと、mfm-jsのnestは子を
	// 1文字ずつ文字として読むので、子は閉じの手前までの1つのテキストになる
	childDepthOK := s.depth+1 < s.nestLimit
	var end int
	if childDepthOK {
		s.depth++
		end = s.scanEnd(scanCenter)
		s.depth--
	} else {
		end = s.centerTextEnd()
	}
	// 閉じの直後が行の終わりかを、子を集める前に確かめる。集めてから捨てると、
	// 開きを並べて最後だけ行末でない閉じを置いた入力で、開きの数だけ末尾まで
	// 読み直して入力長の2乗になる。
	afterClose := end + s.newlineLenAt(end) + len(closeTag)
	if end == start || !s.centerCloseAt(end) || !s.lineEndAt(afterClose) {
		s.pos = save
		return nil
	}
	var children []*Node
	if childDepthOK {
		s.depth++
		children = mergeText(s.collectTo(end))
		s.depth--
	} else {
		children = []*Node{Text(s.src[start:end])}
	}
	s.pos = afterClose
	s.advance(s.newlineLen())
	return withChildren(NodeCenter, children)
}

// centerCloseAt reports whether an optional newline and </center> follow pos.
func (s *state) centerCloseAt(pos int) bool {
	return s.prefixAt(pos+s.newlineLenAt(pos), "</center>")
}

// centerTextEnd returns where the children of a center whose children are
// read as plain text stop: the first </center>, or the newline right before
// it. Without a </center> it returns a position where centerCloseAt fails.
func (s *state) centerTextEnd() int {
	c, ok := s.nextStop(stopCenterClose)
	if !ok {
		c = len(s.src)
		if i := strings.Index(s.remaining(), "</center>"); i >= 0 {
			c = s.pos + i
		}
	}
	switch {
	case c-2 >= s.pos && s.src[c-2:c] == "\r\n":
		return c - 2
	case c-1 >= s.pos && (s.src[c-1] == '\n' || s.src[c-1] == '\r'):
		return c - 1
	}
	return c
}

// newlineLen returns the length of the newline at the current position.
func (s *state) newlineLen() int { return s.newlineLenAt(s.pos) }

// lineEndAt reports whether pos is the end of input or a line break.
func (s *state) lineEndAt(pos int) bool { return lineEndIn(s.src, pos) }

// lineEndIn reports mfm-js's lineEnd at pos in src: the end of src or CR or LF.
func lineEndIn(src string, pos int) bool {
	return pos >= len(src) || src[pos] == '\n' || src[pos] == '\r'
}

// newlineLenAt returns the length of the newline (CRLF, CR or LF, in
// mfm-js's order) at pos, or 0.
func (s *state) newlineLenAt(pos int) int { return newlineLenIn(s.src, pos) }

// newlineLenIn returns the length of mfm-js's newLine at pos in src (CRLF,
// CR or LF, tried in that order), or 0.
func newlineLenIn(src string, pos int) int {
	if pos < 0 || pos >= len(src) {
		return 0
	}
	switch src[pos] {
	case '\r':
		if pos+1 < len(src) && src[pos+1] == '\n' {
			return 2
		}
		return 1
	case '\n':
		return 1
	}
	return 0
}

// atLineBegin reports mfm-js's lineBegin: the start of the source or right
// after CR or LF.
func (s *state) atLineBegin() bool {
	return s.pos == 0 || s.src[s.pos-1] == '\n' || s.src[s.pos-1] == '\r'
}

// trySearch reads mfm-js's search: at a line begin, at least one character
// followed by a space (U+0020, U+3000 or a tab), a button (`検索`, `search`,
// `[検索]` or `[search]`, ASCII case-insensitive) and the line end. tryBlock
// reads the newlines before and after it.
//
// queryは語の前の文字列をそのまま(前後の空白も削らずに)使い、contentは
// mfm-jsと同じくquery +区切りの1文字+ボタンの文字(`[検索]`なら括弧も)
// にする。
//
// mfm-jsのinline (装飾などの中身)にはsearchが無いので、fullで読む位置
// だけで試す。
func (s *state) trySearch() *Node {
	if !s.fullContext() || !s.atLineBegin() {
		return nil
	}
	// queryは1文字以上要る。mfm-jsは「区切り+ボタン+行末」が読める位置で
	// queryを止めるが、先頭でそれが読める行(`検索`だけの行)は1文字目を
	// 読んだ後にボタンの後ろの区切りが無いので、1文字読んでから確かめても同じ
	start := s.pos
	i := start
	for i < len(s.src) && s.src[i] != '\n' && s.src[i] != '\r' {
		_, size := utf8.DecodeRuneInString(s.src[i:])
		i += size
		if end, ok := s.searchButtonAt(i); ok {
			s.budget.used += i - start
			s.pos = end
			return &Node{Type: NodeSearch, Props: map[string]any{
				"query":   s.src[start:i],
				"content": s.src[start:end],
			}}
		}
	}
	s.budget.used += i - start
	return nil
}

// searchButtonAt reports whether a space, a search button and the line end
// follow at pos, and returns the position of the line end.
func (s *state) searchButtonAt(pos int) (int, bool) {
	switch {
	case s.prefixAt(pos, " "), s.prefixAt(pos, "\t"):
		pos++
	case s.prefixAt(pos, "\u3000"):
		pos += len("\u3000")
	default:
		return 0, false
	}
	var end int
	if s.prefixAt(pos, "[") {
		end = searchWordEnd(s.src, pos+1)
		if end < 0 || !s.prefixAt(end, "]") {
			return 0, false
		}
		end++
	} else if end = searchWordEnd(s.src, pos); end < 0 {
		return 0, false
	}
	if !s.lineEndAt(end) {
		return 0, false
	}
	return end, true
}

// searchWordEnd returns the position after `検索` or ASCII case-insensitive
// `search` at pos, or -1.
//
// mfm-jsの/search/iはuフラグが無いので、大文字小文字を同一視するのはASCII
// だけ(strings.EqualFoldはU+017Fなどをsと同一視するので使えない)。
func searchWordEnd(src string, pos int) int {
	const kanji, word = "検索", "search"
	if strings.HasPrefix(src[pos:], kanji) {
		return pos + len(kanji)
	}
	if len(src)-pos < len(word) {
		return -1
	}
	for k := range len(word) {
		if src[pos+k]|0x20 != word[k] {
			return -1
		}
	}
	return pos + len(word)
}
