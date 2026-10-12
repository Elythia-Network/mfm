package mfm

import (
	"strings"
	"unicode/utf8"
)

// trySmallTag reads mfm-js's smallTag `<small>...</small>`.
func (s *state) trySmallTag() *Node {
	return s.tryWrapped("<small>", "</small>", NodeSmall, scanSmall)
}

// tryPlainTag reads mfm-js's plainTag: `<plain>`, one optional newline, at
// least one character of raw text, one optional newline and `</plain>`. The
// text is kept as is, without parsing.
func (s *state) tryPlainTag() *Node {
	const openTag, closeTag = "<plain>", "</plain>"
	if !s.hasPrefix(openTag) {
		return nil
	}
	// mfm-js 0.26.0のplainTag:
	//
	//	seq(open, newLine.option(),
	//	    (notMatch(seq(newLine.option(), close)) char)+.text(),
	//	    newLine.option(), close)
	//
	// 開きの直後と閉じの直前の改行を1つずつ中身から外し、中身は1文字以上要る
	// (`<plain></plain>`は文字)。
	save := s.pos
	s.advance(len(openTag))
	s.advance(s.newlineLen())
	start := s.pos
	c, ok := s.nextStop(stopPlainClose)
	if !ok {
		c = len(s.src)
		if i := strings.Index(s.remaining(), closeTag); i >= 0 {
			c = s.pos + i
		}
		s.budget.used += c - s.pos
	}
	if c >= len(s.src) {
		s.pos = save
		return nil
	}
	end := c - trailingNewlineLen(s.src, start, c)
	if end == start {
		s.pos = save
		return nil
	}
	s.pos = c + len(closeTag)
	return &Node{Type: NodePlain, Children: []*Node{Text(s.src[start:end])}}
}

// tryBoldTag reads mfm-js's boldTag `<b>...</b>`.
func (s *state) tryBoldTag() *Node {
	return s.tryWrapped("<b>", "</b>", NodeBold, scanBold)
}

// tryItalicTag reads mfm-js's italicTag `<i>...</i>`.
func (s *state) tryItalicTag() *Node {
	return s.tryWrapped("<i>", "</i>", NodeItalic, scanItalic)
}

// tryStrikeTag reads mfm-js's strikeTag `<s>...</s>`.
func (s *state) tryStrikeTag() *Node {
	return s.tryWrapped("<s>", "</s>", NodeStrike, scanStrike)
}

// tryBig parses mfm-js's big `***...***`, which becomes `$[tada ...]`.
func (s *state) tryBig() *Node {
	n := s.tryWrapped("***", "***", NodeFn, scanBig)
	if n != nil && n.Type == NodeFn {
		n.Props = map[string]any{"name": "tada", "args": map[string]any{}}
	}
	return n
}

// tryBoldAsta reads mfm-js's boldAsta `**...**`, whose children may span
// lines.
func (s *state) tryBoldAsta() *Node {
	return s.tryWrapped("**", "**", NodeBold, scanBoldAsta)
}

// tryItalicAsta reads mfm-js's italicAsta `*...*` of ASCII letters, digits
// and spaces, which must not follow an ASCII letter or digit.
func (s *state) tryItalicAsta() *Node {
	if isASCIIAlphanumeric(s.prevRune()) {
		return nil
	}
	return s.tryWrappedAlphaSpace("*", "*", NodeItalic)
}

// tryBoldUnder reads mfm-js's boldUnder `__...__` of ASCII letters, digits
// and spaces.
func (s *state) tryBoldUnder() *Node {
	return s.tryWrappedAlphaSpace("__", "__", NodeBold)
}

// tryItalicUnder reads mfm-js's italicUnder `_..._` of ASCII letters, digits
// and spaces, which must not follow an ASCII letter or digit.
func (s *state) tryItalicUnder() *Node {
	if isASCIIAlphanumeric(s.prevRune()) {
		return nil
	}
	return s.tryWrappedAlphaSpace("_", "_", NodeItalic)
}

// tryStrikeWave reads mfm-js's strikeWave `~~...~~`, whose children stop at a
// newline.
func (s *state) tryStrikeWave() *Node {
	return s.tryWrapped("~~", "~~", NodeStrike, scanStrikeWave)
}

// tryWrapped parses open, children up to close, and close, like mfm-js's
// seqOrText(open, seq(notMatch(close), nest(inline)).select(1).many(1), close).
// When open matches but the rest does not, it returns what it read as a single
// text node. kind gives where the children stop.
//
// mfm-jsのseqOrTextは、開きが合って後ろが失敗すると、失敗した部品の手前まで
// 読んだ範囲(開き+中身)をまるごと文字として返し、その位置では他の構文を
// 試さない。中身は閉じか末尾(~~は改行)まで読むので、閉じが無ければ中の
// カスタム絵文字やハッシュタグも文字に飲み込まれる。
func (s *state) tryWrapped(open, close string, nodeType NodeType, kind scanKind) *Node {
	if !s.hasPrefix(open) {
		return nil
	}
	start := s.pos
	s.advance(len(open))
	children, ok := s.wrappedBody(close, kind)
	if !ok {
		return Text(s.src[start:s.pos])
	}
	return withChildren(nodeType, children)
}

// wrappedBody reads mfm-js's `seq(notMatch(close), nest(inline)).many(1)` and
// then close from the current position. On success it moves past close. On
// failure it reports false with the position at the end of what seqOrText
// keeps as text: unchanged when there are no children, or right after them
// when close is missing.
func (s *state) wrappedBody(close string, kind scanKind) ([]*Node, bool) {
	if s.eof() || s.stopsAt(kind) {
		return nil, false
	}
	s.depth++
	end := s.scanEnd(kind)
	closed := s.prefixAt(end, close)
	var children []*Node
	if closed {
		children = s.collectTo(end)
	}
	s.depth--
	s.pos = end
	if !closed {
		return nil, false
	}
	s.advance(len(close))
	return mergeText(children), true
}

// tryWrappedAlphaSpace parses mfm-js's `seq(mark, alt([alphaAndNum,
// space]).many(1), mark)`: one or more ASCII letters, digits or spaces
// (U+0020, U+3000 or a tab) between open and close.
//
// unicode.IsSpaceと違い、mfm-jsのspaceにCR・NBSP・垂直タブなどは無い
// (`*a\rb*`は斜体にならない)。
func (s *state) tryWrappedAlphaSpace(open, close string, nodeType NodeType) *Node {
	if !s.hasPrefix(open) {
		return nil
	}
	start := s.pos + len(open)
	i := start
	for i < len(s.src) {
		if c := s.src[i]; isAlphanumeric(rune(c)) || c == ' ' || c == '\t' {
			i++
		} else if strings.HasPrefix(s.src[i:], "　") {
			i += len("　")
		} else {
			break
		}
	}
	s.budget.used += i - start
	if i == start || !s.prefixAt(i, close) {
		return nil
	}
	s.pos = i + len(close)
	return withChildren(nodeType, []*Node{Text(s.src[start:i])})
}

// tryInlineCode reads mfm-js's inlineCode: "`", at least one character other
// than "`", "´" and newlines, and "`".
func (s *state) tryInlineCode() *Node {
	if s.peek() != '`' {
		return nil
	}
	start := s.pos + 1
	i := start
	defer func() { s.budget.used += i - start }()
	for i < len(s.src) {
		r, size := utf8.DecodeRuneInString(s.src[i:])
		switch r {
		case '`':
			if i == start {
				return nil
			}
			s.pos = i + 1
			return withProp(NodeInlineCode, "code", s.src[start:i])
		case '\n', '\r', '´': // mfm-jsのnewLineはCRでも止まる
			return nil
		}
		i += size
	}
	return nil
}

// tryMathInline reads mfm-js's mathInline: `\(`, at least one character
// without a newline, and `\)`.
func (s *state) tryMathInline() *Node {
	if !s.hasPrefix(`\(`) {
		return nil
	}
	save := s.pos
	start := s.pos + len(`\(`)
	s.pos = start
	// 止まる位置(`\)`かCRかLF)を索引から引く。開きを並べて閉じない入力で
	// 開きごとに末尾まで読むと入力長の2乗になる
	stop, ok := s.nextStop(stopMathInline)
	if !ok {
		stop = len(s.src)
		for i := start; i < len(s.src); i++ {
			if s.src[i] == '\n' || s.src[i] == '\r' || s.prefixAt(i, `\)`) {
				stop = i
				break
			}
		}
		s.budget.used += stop - start
	}
	if stop == start || !s.prefixAt(stop, `\)`) {
		s.pos = save
		return nil
	}
	s.pos = stop + len(`\)`)
	return withProp(NodeMathInline, "formula", s.src[start:stop])
}

// tryFn reads mfm-js's fn `$[name.args children]`. Like tryWrapped, once "$["
// matched, a failure later returns what was read as text.
func (s *state) tryFn() *Node {
	if !s.hasPrefix("$[") {
		return nil
	}
	// mfm-jsのfnはseqOrText("$[",関数名,引数.option(), " ",中身, "]")で、
	// 途中の部品が失敗すると、そこまで読んだ範囲を文字にする(tryWrappedと同じ)。
	// 文字にする範囲を合わせるため、関数名と引数はmfm-jsの正規表現が読む
	// 範囲だけを読む。
	start := s.pos
	asText := func() *Node { return Text(s.src[start:s.pos]) }
	s.advance(len("$["))
	name := s.readFnWord(isFnNameChar)
	if name == "" {
		return asText()
	}
	args := s.readFnArgs()
	if s.peek() != ' ' {
		return asText()
	}
	s.advance(1)
	children, ok := s.wrappedBody("]", scanFn)
	if !ok {
		return asText()
	}
	if args == nil {
		args = map[string]any{}
	}
	return &Node{Type: NodeFn, Props: map[string]any{"name": name, "args": args}, Children: children}
}

// isFnNameChar reports whether r is in mfm-js's /[a-z0-9_]/i, used for fn
// names and argument keys.
func isFnNameChar(r rune) bool {
	return isASCIIAlphanumeric(r) || r == '_'
}

// isFnArgValueChar reports whether r is in mfm-js's /[a-z0-9_.-]/i, used for
// fn argument values.
func isFnArgValueChar(r rune) bool {
	return isFnNameChar(r) || r == '.' || r == '-'
}

// readFnWord reads the longest run of runes satisfying ok and returns it.
func (s *state) readFnWord(ok func(rune) bool) string {
	start := s.pos
	for !s.eof() && ok(s.peek()) {
		s.advance(1) // ok は ASCII だけを受け付ける
	}
	return s.src[start:s.pos]
}

// readFnArgs reads mfm-js's fn arguments `.k=v,k2` at the current position.
// It returns nil, leaving the position unchanged, when there is no "." or no
// valid first key. Otherwise it stops after the last complete argument, so a
// trailing "," or "=" without a valid key or value is left unread, as in
// mfm-js's arg.sep(",", 1) and seq("=", value).option(). An argument without
// a value is true; a repeated key keeps the last value.
func (s *state) readFnArgs() map[string]any {
	if s.peek() != '.' {
		return nil
	}
	save := s.pos
	s.advance(1)
	if !isFnNameChar(s.peek()) {
		s.pos = save
		return nil
	}
	args := map[string]any{}
	for {
		key := s.readFnWord(isFnNameChar)
		var value any = true
		if s.peek() == '=' {
			eq := s.pos
			s.advance(1)
			if v := s.readFnWord(isFnArgValueChar); v != "" {
				value = v
			} else {
				s.pos = eq
			}
		}
		args[key] = value
		// ","の後ろに項目が無ければ、","を読まずに終わる
		if s.peek() != ',' {
			return args
		}
		comma := s.pos
		s.advance(1)
		if !isFnNameChar(s.peek()) {
			s.pos = comma
			return args
		}
	}
}

// tryMention reads mfm-js's mention `@user` or `@user@host` that does not
// follow an ASCII letter or digit. A malformed one (see below) is returned as
// text covering everything read.
func (s *state) tryMention() *Node {
	if s.peek() != '@' {
		return nil
	}
	// リンクのラベルの中ではメンションにしない(mfm-jsのnotLinkLabel)。
	if s.inLink {
		return nil
	}
	if isASCIIAlphanumeric(s.prevRune()) {
		return nil
	}
	save := s.pos
	s.advance(1)
	username := s.consumeIdent()
	if username == "" {
		s.pos = save
		return nil
	}
	host, hasHost := "", false
	if s.peek() == '@' {
		hostStart := s.pos
		s.advance(1)
		if h := s.consumeIdent(); h != "" {
			host, hasHost = h, true
		} else {
			// `@a@`の2つ目の`@`はmentionに含めない
			s.pos = hostStart
		}
	}
	end := s.pos

	// 以下はmfm-js 0.26.0のmentionと同じ判定。
	//   - hostの末尾の`.` / `-`は削る。削って空になったら不正
	//   - usernameの末尾の`.` / `-`は、hostが無いときだけ削る。hostがあれば不正
	//   - username / hostが`.` / `-`で始まれば不正
	// 不正なら読んだ範囲をまるごと文字にする(mfm-jsはinvalidMentionで
	// input.slice(index, resultIndex)を返す)。正しければ`@name@host`の長さだけ
	// 進め、削った`.` / `-`は後ろの文字として残す。
	invalid := false
	if hasHost {
		if trimmed := strings.TrimRight(host, ".-"); len(trimmed) != len(host) {
			host = trimmed
			if host == "" {
				invalid = true
				hasHost = false
			}
		}
	}
	if trimmed := strings.TrimRight(username, ".-"); len(trimmed) != len(username) {
		if !hasHost {
			username = trimmed
		} else {
			invalid = true
		}
	}
	if username == "" || strings.HasPrefix(username, ".") || strings.HasPrefix(username, "-") {
		invalid = true
	}
	if hasHost && (strings.HasPrefix(host, ".") || strings.HasPrefix(host, "-")) {
		invalid = true
	}
	if invalid {
		return Text(s.src[save:end])
	}

	acct := "@" + username
	var hostProp any
	if hasHost {
		acct += "@" + host
		hostProp = host
	}
	s.pos = save + len(acct)
	return &Node{Type: NodeMention, Props: map[string]any{"username": username, "host": hostProp, "acct": acct}}
}

// consumeIdent reads mfm-js's /[a-z0-9_.-]+/i (ASCII only) and returns it.
func (s *state) consumeIdent() string {
	start := s.pos
	for !s.eof() {
		c := s.src[s.pos]
		if !isASCIIAlphanumeric(rune(c)) && c != '_' && c != '.' && c != '-' {
			break
		}
		s.advance(1)
	}
	return s.src[start:s.pos]
}

// tryHashtag reads mfm-js's hashtag `#tag` that does not follow an ASCII
// letter or digit and is not made only of ASCII digits.
func (s *state) tryHashtag() *Node {
	if s.peek() != '#' {
		return nil
	}
	// リンクのラベルの中ではハッシュタグにしない(mfm-jsのnotLinkLabel)。
	if s.inLink {
		return nil
	}
	if isASCIIAlphanumeric(s.prevRune()) {
		return nil
	}
	start := s.pos + 1 // skip #

	// mfm-jsのhashtagと同じく、使える文字の並びと、閉じた括弧(`()` / `[]` /
	// `「」` / `（）`)だけを読む。
	end := s.hashtagItems(start, s.depth, true)
	s.budget.used += end - start
	tag := s.src[start:end]
	if tag == "" || isDigitsOnly(tag) {
		return nil
	}
	s.pos = end
	return withProp(NodeHashtag, "hashtag", tag)
}

// isHashtagChar reports whether r is one of mfm-js's hashTagChar: anything but
// the stop characters ` \u3000\t.,!?'"#:/[]【】()「」（）<>` and line breaks.
func isHashtagChar(r rune) bool {
	switch r {
	case ' ', '\u3000', '\t', '\r', '\n', '.', ',', '!', '?', '\'', '"', '#', ':', '/',
		'[', ']', '【', '】', '(', ')', '「', '」', '（', '）', '<', '>':
		return false
	}
	return true
}

// hashtagOpenClose maps the brackets mfm-js's hashtag reads as a group to
// their closing bracket.
var hashtagOpenClose = map[rune]rune{'(': ')', '[': ']', '「': '」', '（': '）'}

// hashtagItems reads mfm-js's `innerItem.many(0)` of the hashtag rule from i
// and returns where it stopped. depth is the nest depth the items are read at;
// top marks the hashtag's own items, which are not wrapped in nest.
func (s *state) hashtagItems(i, depth int, top bool) int {
	for {
		next, ok := s.hashtagItem(i, depth, top)
		if !ok {
			return i
		}
		i = next
	}
}

// hashtagItem reads one mfm-js hashtag innerItem at i: a balanced bracket group
// whose contents are read one nest level deeper, or a single hashtag character.
//
// 括弧の中はmfm-jsのnest(innerItem, hashTagChar)で、深さを1つ上げてから
// 上限未満ならinnerItemを、届いていればhashTagCharだけを読む(括弧は
// hashTagCharに無いので、そこで止まる)。タグ直下の項目はnestを通らないので、
// 上限に関係なく括弧を開ける。閉じが無ければ括弧ごと失敗し、タグはその手前で終わる。
func (s *state) hashtagItem(i, depth int, top bool) (int, bool) {
	if i >= len(s.src) {
		return i, false
	}
	r, size := utf8.DecodeRuneInString(s.src[i:])
	if isHashtagChar(r) {
		return i + size, true
	}
	closeCh, ok := hashtagOpenClose[r]
	if !ok {
		return i, false
	}
	if !top && depth >= s.nestLimit {
		return i, false
	}
	s.budget.used++
	j := s.hashtagItems(i+size, depth+1, false)
	if j >= len(s.src) {
		return i, false
	}
	c, csize := utf8.DecodeRuneInString(s.src[j:])
	if c != closeCh {
		return i, false
	}
	return j + csize, true
}

// tryEmojiCode reads mfm-js's emojiCode `:name:` with a name of ASCII
// letters, digits and "_+-". The closing ":" must not be followed by an ASCII
// letter or digit.
func (s *state) tryEmojiCode() *Node {
	if s.peek() != ':' {
		return nil
	}
	// 区切りはmfm-js 0.26.0のemojiCodeと同じく**閉じの`:`の直後**だけを見る。
	// mfm-jsの先頭側の`alt([lineBegin, side])`は今の位置(`:`自身)に
	// notMatchを掛けるだけで直前の文字を見ないので、`1:a:`や`@foo:a:`も絵文字に
	// なる。
	start := s.pos + 1
	end := start
	for end < len(s.src) && isEmojiName(s.src[end]) {
		end++
	}
	s.budget.used += end - start
	if end == start || end >= len(s.src) || s.src[end] != ':' {
		return nil
	}
	// 閉じの直後が英数字なら絵文字にしない(mfm-jsの`alt([lineEnd, side])`)。
	if end+1 < len(s.src) && isAlphanumeric(rune(s.src[end+1])) {
		return nil
	}
	s.pos = end + 1
	return withProp(NodeEmojiCode, "name", s.src[start:end])
}

// tryURL reads mfm-js's url: "http://" or "https://" and url characters with
// balanced brackets. Trailing "." and "," are left out of the URL; when only
// the scheme would remain, everything read becomes text.
func (s *state) tryURL() *Node {
	// リンクのラベルの中ではURLにしない(mfm-jsのnotLinkLabel)。
	if s.inLink {
		return nil
	}
	var schemeLen int
	switch {
	case s.hasPrefix("https://"):
		schemeLen = len("https://")
	case s.hasPrefix("http://"):
		schemeLen = len("http://")
	default:
		return nil
	}
	start := s.pos

	// URLの文字を読む。mfm-jsのurlと同じく、使える文字はASCIIの
	// [.,a-z0-9_/:%#@$&?!~=+-]で、`(...)` / `[...]`は閉じているときだけ含める。
	end := s.urlItems(start+schemeLen, s.depth, true)
	s.budget.used += 1 + end - start
	if end == start+schemeLen {
		// schemeの後に1文字も無い(mfm-jsのinnerItem.many(1)が失敗する)。
		return nil
	}
	url := s.src[start:end]
	// 末尾の`.` / `,`は削り、後ろの文字として残す。削ってschemeだけになったら、
	// mfm-jsは読んだ範囲をまるごと文字にする。
	trimmed := strings.TrimRight(url, ".,")
	if len(trimmed) <= schemeLen {
		s.pos = end
		return Text(url)
	}
	s.pos = start + len(trimmed)
	return withProp(NodeURL, "url", trimmed)
}

// isURLChar reports whether b is one of mfm-js's url characters
// ([.,a-z0-9_/:%#@$&?!~=+-], case-insensitive).
func isURLChar(b byte) bool {
	switch {
	case b >= 'a' && b <= 'z', b >= 'A' && b <= 'Z', b >= '0' && b <= '9':
		return true
	}
	return strings.IndexByte(".,_/:%#@$&?!~=+-", b) >= 0
}

// urlItems reads mfm-js's `innerItem.many(0)` of the url rule from i and
// returns where it stopped. depth is the nest depth the items are read at;
// top marks the url's own items, which are not wrapped in nest.
func (s *state) urlItems(i, depth int, top bool) int {
	for {
		next, ok := s.urlItem(i, depth, top)
		if !ok {
			return i
		}
		i = next
	}
}

// urlBracketClose maps the brackets mfm-js's url reads as a group to their
// closing bracket.
var urlBracketClose = [256]byte{'(': ')', '[': ']'}

// urlItem reads one mfm-js url innerItem at i: a balanced `(...)` or `[...]`
// whose contents are read one nest level deeper, or a single url character.
//
// mfm-jsのnest(innerItem, urlChar)は深さを1つ上げてから、上限未満なら
// innerItemを、届いていればurlCharだけを読む(括弧はurlCharに無いので、そこで
// 止まる)。url直下の項目はnestを通らないので、上限に関係なく括弧を開ける。
// 閉じが無ければ括弧ごと失敗し、URLはその手前で終わる。
func (s *state) urlItem(i, depth int, top bool) (int, bool) {
	if i >= len(s.src) {
		return i, false
	}
	c := s.src[i]
	if isURLChar(c) {
		return i + 1, true
	}
	closeCh := urlBracketClose[c]
	if closeCh == 0 || !top && depth >= s.nestLimit {
		return i, false
	}
	s.budget.used++
	j := s.urlItems(i+1, depth+1, false)
	if j < len(s.src) && s.src[j] == closeCh {
		return j + 1, true
	}
	return i, false
}

// tryLink reads mfm-js's link `[label](url)` or silent link `?[label](url)`.
// The label is read one level deeper as inline syntax without mentions,
// hashtags, URLs and links, and stops at "]" or a newline; the target is a
// URL or `<URL>` followed by ")".
func (s *state) tryLink() *Node {
	if s.inLink {
		return nil
	}
	start := s.pos
	silent := false
	switch {
	case s.hasPrefix("?["):
		silent = true
		s.advance(2)
	case s.hasPrefix("["):
		s.advance(1)
	default:
		return nil
	}

	// label (]まで。途中の改行で失敗)。mfm-jsはラベルをnest(labelInline)で
	// 読むので、ラベルの中身は1段深い。深さを変えずに読むと、ラベルの中で
	// 入れ子にできる段数がmfm-jsより1段多くなる
	s.inLink = true
	s.depth++
	labelStart := s.pos
	labelEnd := s.scanEnd(scanLinkLabel)
	// ラベルはmfm-jsのmany(1)で1つ以上要る。空のラベル(`[](https://...)`)は
	// リンクにせず、`[`を文字にして読み進める
	ok := labelEnd > labelStart && s.prefixAt(labelEnd, "](")
	var label []*Node
	if ok {
		label = s.collectTo(labelEnd)
	}
	s.depth--
	s.inLink = false
	if !ok {
		s.pos = start
		return nil
	}

	// 飛び先はmfm-jsと同じくURL (`https?://...`か`<https?://...>`)に限り、
	// 直後に`)`が要る。
	url, targetEnd, ok := s.linkTargetAt(labelEnd + len("]("))
	if !ok || !s.prefixAt(targetEnd, ")") {
		s.pos = start
		return nil
	}
	s.pos = targetEnd + len(")")
	s.budget.used++
	return &Node{
		Type:     NodeLink,
		Props:    map[string]any{"silent": silent, "url": url},
		Children: mergeText(label),
	}
}

// prevRune returns the code point right before the current position, or -1
// at the start of the source.
func (s *state) prevRune() rune {
	if s.pos == 0 {
		return -1
	}
	r, _ := utf8.DecodeLastRuneInString(s.src[:s.pos])
	return r
}

// isAlphanumeric reports whether r matches mfm-js's alphaAndNum /[a-z0-9]/i,
// which covers ASCII letters and digits only.
func isAlphanumeric(r rune) bool { return isASCIIAlphanumeric(r) }

// isASCIIAlphanumeric reports whether r is an ASCII letter or digit.
func isASCIIAlphanumeric(r rune) bool {
	return 'a' <= r|0x20 && r|0x20 <= 'z' || '0' <= r && r <= '9'
}

// isDigitsOnly reports whether s is non-empty and made only of ASCII digits
// (mfm-js's /^[0-9]+$/).
func isDigitsOnly(s string) bool {
	if s == "" {
		return false
	}
	for i := range len(s) {
		if !isASCIIDigit(s[i]) {
			return false
		}
	}
	return true
}

// isEmojiName reports whether c may appear in a custom emoji name
// (mfm-js's /[a-z0-9_+-]/i).
func isEmojiName(c byte) bool {
	return isASCIIAlphanumeric(rune(c)) || c == '_' || c == '+' || c == '-'
}
