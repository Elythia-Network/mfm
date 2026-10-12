package mfm

import (
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// serializeTreeDetailed extends serializeTree with the props that the
// remaining-divergence cases depend on: inline / block code (with the
// language), and inline / block math.
func serializeTreeDetailed(nodes []*Node) string {
	parts := make([]string, 0, len(nodes))
	for _, n := range nodes {
		var head string
		switch n.Type {
		case NodeInlineCode:
			head = string(n.Type) + ":" + fmt.Sprint(n.Props["code"])
		case NodeBlockCode:
			lang, _ := n.Props["lang"].(string)
			head = string(n.Type) + ":" + lang + ":" + fmt.Sprint(n.Props["code"])
		case NodeMathInline, NodeMathBlock:
			head = string(n.Type) + ":" + fmt.Sprint(n.Props["formula"])
		default:
			head = serializeTree([]*Node{{Type: n.Type, Props: n.Props}})
		}
		if len(n.Children) > 0 {
			head += "[" + serializeTreeDetailed(n.Children) + "]"
		}
		parts = append(parts, head)
	}
	return strings.Join(parts, "|")
}

// TestParse_RemainingDivergencesMatchMfmJs fixes newline, space and
// minimum-length details to mfm-js 0.26.0. Expected trees (parse and parseSimple) were produced
// by running mfm-js on each input.
//
// mfm-jsのnewLineはCRLF / CR / LFのどれかで、lineBeginはCRの直後も行頭と
// みなす(引用・行内コード・数式・コードブロックのどれでも)。斜体・`__`の
// 中身はmfm-jsのspace(半角空白・全角空白・タブ)とASCIIの英数字だけで、unicode.IsSpaceのCR・NBSP・垂直タブは含まない。コードブロック・
// `<plain>`・リンクのラベルは中身が1文字以上要る(many(1))。
func TestParse_RemainingDivergencesMatchMfmJs(t *testing.T) {
	cases := []struct{ in, want, wantSimple string }{
		// 引用: CRで行を切り、CRの直後も行頭。中身は"\n"でつなぐ
		{"> a\rb", "quote[text:a]|text:b", "text:> a\rb"},
		{"> a\r\nb", "quote[text:a]|text:b", "text:> a\r\nb"},
		{"> a\r> b", "quote[text:a\nb]", "text:> a\r> b"},
		{"> a\r\n> b", "quote[text:a\nb]", "text:> a\r\n> b"},
		{"x\r> a", "text:x|quote[text:a]", "text:x\r> a"},
		{"\r> #t 検索", "quote[hashtag:t|text: 検索]", "text:\r> #t 検索"},
		{"\r\n> #t", "quote[hashtag:t]", "text:\r\n> #t"},
		// 引用: `>`の直後の全角空白も1つだけ読む
		{">\u3000q", "quote[text:q]", "text:>\u3000q"},
		{">\u3000\u3000q", "quote[text:\u3000q]", "text:>\u3000\u3000q"},
		{"> \u3000q", "quote[text:\u3000q]", "text:> \u3000q"},
		{">\tq", "quote[text:q]", "text:>\tq"},
		// 行内コード・数式はCRでも止まる
		{"`a\rb`", "text:`a\rb`", "text:`a\rb`"},
		{"`a\r\nb`", "text:`a\r\nb`", "text:`a\r\nb`"},
		{"`a\nb`", "text:`a\nb`", "text:`a\nb`"},
		{"\\(a\rb\\)", "text:\\(a\rb\\)", "text:\\(a\rb\\)"},
		{"\\(a\nb\\)", "text:\\(a\nb\\)", "text:\\(a\nb\\)"},
		{"\\(ab\\)", "mathInline:ab", "text:\\(ab\\)"},
		// 斜体・`__`の中身はASCIIの英数字とmfm-jsのspaceだけ
		{"*a\rb*", "text:*a\rb*", "text:*a\rb*"},
		{"_a\rb_", "text:_a\rb_", "text:_a\rb_"},
		{"__a\rb__", "text:__a\rb__", "text:__a\rb__"},
		{"*a\u00a0b*", "text:*a\u00a0b*", "text:*a\u00a0b*"},
		{"*a\u000bb*", "text:*a\u000bb*", "text:*a\u000bb*"},
		{"*a\u3000b*", "italic[text:a\u3000b]", "text:*a\u3000b*"},
		{"__a\tb__", "bold[text:a\tb]", "text:__a\tb__"},
		{"*a b*", "italic[text:a b]", "text:*a b*"},
		// コードブロック:中身は1文字以上、改行はCR / CRLFも、閉じの直後は行の終わり
		{"```\n\n```", "text:```\n\n```", "text:```\n\n```"},
		{"```\r\n\r\n```", "text:```\r\n\r\n```", "text:```\r\n\r\n```"},
		{"```\na\n```", "blockCode::a", "text:```\na\n```"},
		{"```js\r\na\r\n```", "blockCode:js:a", "text:```js\r\na\r\n```"},
		{"```\ra\r```", "blockCode::a", "text:```\ra\r```"},
		{"\r```\na\n```", "blockCode::a", "text:\r```\na\n```"},
		{"```\na\n```x", "text:```\na\n```x", "text:```\na\n```x"},
		{"```\na\n```x\n```", "blockCode::a\n```x", "text:```\na\n```x\n```"},
		{"```\n```\n```", "blockCode::```", "text:```\n```\n```"},
		{"a\n```\nb\n```\nc", "text:a|blockCode::b|text:c", "text:a\n```\nb\n```\nc"},
		// <plain>:開きの直後と閉じの直前の改行を1つずつ外し、中身は1文字以上
		{"<plain></plain>", "text:<plain></plain>", "text:<plain></plain>"},
		{"<plain>\n</plain>", "text:<plain>\n</plain>", "text:<plain>\n</plain>"},
		{"<plain>\r\n</plain>", "text:<plain>\r\n</plain>", "text:<plain>\r\n</plain>"},
		{"<plain>\n\n</plain>", "text:<plain>\n\n</plain>", "text:<plain>\n\n</plain>"},
		{"<plain>\na\n</plain>", "plain[text:a]", "plain[text:a]"},
		{"<plain>\r\na\r\n</plain>", "plain[text:a]", "plain[text:a]"},
		{"<plain>\r\ra\r\r</plain>", "plain[text:\ra\r]", "plain[text:\ra\r]"},
		{"<plain>a</plain>", "plain[text:a]", "plain[text:a]"},
		{"<plain> </plain>", "plain[text: ]", "plain[text: ]"},
		// リンク:ラベルは1つ以上要る
		{"[](https://e.x)", "text:[](|url:https://e.x|text:)", "text:[](https://e.x)"},
		{"?[](https://e.x)", "text:?[](|url:https://e.x|text:)", "text:?[](https://e.x)"},
		{"[ ](https://e.x)", "link:https://e.x[text: ]", "text:[ ](https://e.x)"},
		{"[a](https://e.x)", "link:https://e.x[text:a]", "text:[a](https://e.x)"},
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			assert.Equal(t, tc.want, serializeTreeDetailed(Parse(tc.in)), "Parse")
			assert.Equal(t, tc.wantSimple, serializeTreeDetailed(ParseSimple(tc.in)), "ParseSimple")
		})
	}
}

// TestParse_RemainingDivergencesExtraction checks the hashtags extracted from
// one of the trees above.
func TestParse_RemainingDivergencesExtraction(t *testing.T) {
	// CRの直後の引用は、中の行の検索より先に引用になり、ハッシュタグが取れる
	assert.Equal(t, []string{"t"}, CollectHashtags("\r> #t 検索"))
}

// TestCodeBlock_FallbackMatchesIndex checks that the code block reads the
// same closing position when the index of closes cannot be built.
//
// 索引を作れないのはメモ表の上限に届いたときだけで、通常のParseからは入らない
// ので、stateを直接作って索引を使えない状態にする。
func TestCodeBlock_FallbackMatchesIndex(t *testing.T) {
	inputs := []string{
		"```\na\n```", "```js\r\na\r\n```", "```\ra\r```", "```\n\n```", "```\na\n```x",
		"```\na\n```x\n```", "```\n```\n```", "```\na", "```", "```a\n```b\n```",
	}
	for _, in := range inputs {
		indexed := newState(in, false)
		fallback := newState(in, false)
		fallback.memo.stopsState[stopCodeBlockClose] = -1
		want := indexed.tryCodeBlock()
		got := fallback.tryCodeBlock()
		assert.Equal(t, serializeTreeDetailed(nodesOf(want)), serializeTreeDetailed(nodesOf(got)), "%q", in)
		assert.Equal(t, indexed.pos, fallback.pos, "%q: position", in)
		if strings.ContainsAny(in, "\r\n") {
			// 開きの行が閉じていれば、閉じの位置は索引から引く
			assert.Equal(t, int8(1), indexed.memo.stopsState[stopCodeBlockClose], "%q: index not used", in)
		}
	}
}

// TestCodeBlock_FallbackCountsWork checks that the fallback search for the
// close counts the bytes it reads and stops at the work budget.
//
// 索引を使えないとき、開きの行を並べた入力は開きごとに末尾まで読む。読んだ分を
// 仕事量に数えないと、入力長の2乗になっても上限で打ち切られない。
func TestCodeBlock_FallbackCountsWork(t *testing.T) {
	s := newState(strings.Repeat("```a\n", 3000), false)
	s.memo.stopsState[stopCodeBlockClose] = -1
	mergeText(s.parseNodes(false))
	assert.True(t, s.budget.exhausted(), "used %d of %d", s.budget.used, s.budget.limit)
}

// TestCodeBlock_UnclosedOpensUseIndex checks that the closes are looked up in
// the index: the same input that exhausts the budget through the fallback
// stays within it.
func TestCodeBlock_UnclosedOpensUseIndex(t *testing.T) {
	s := newState(strings.Repeat("```a\n", 3000), false)
	mergeText(s.parseNodes(false))
	assert.False(t, s.budget.exhausted(), "used %d of %d", s.budget.used, s.budget.limit)
}

// TestMathInline_FallbackMatchesIndex checks that inline math stops at CR,
// CRLF and LF the same way with and without the index of stops.
//
// 索引を作れないのはメモ表の上限に届いたときだけなので、stateを直接作って
// 索引を使えない状態にする。
func TestMathInline_FallbackMatchesIndex(t *testing.T) {
	inputs := []string{
		"\\(ab\\)", "\\(a\rb\\)", "\\(a\r\nb\\)", "\\(a\nb\\)", "\\(\\)", "\\(a\r", "\\(a",
	}
	for _, in := range inputs {
		indexed := newState(in, false)
		fallback := newState(in, false)
		fallback.memo.stopsState[stopMathInline] = -1
		want := indexed.tryMathInline()
		got := fallback.tryMathInline()
		assert.Equal(t, serializeTreeDetailed(nodesOf(want)), serializeTreeDetailed(nodesOf(got)), "%q", in)
		assert.Equal(t, indexed.pos, fallback.pos, "%q: position", in)
		assert.Equal(t, int8(1), indexed.memo.stopsState[stopMathInline], "%q: index not used", in)
		assert.Equal(t, int8(-1), fallback.memo.stopsState[stopMathInline], "%q: fallback not used", in)
	}
	// CRで止まるので数式にならない
	assert.Nil(t, newState("\\(a\rb\\)", false).tryMathInline())
}

func nodesOf(n *Node) []*Node {
	if n == nil {
		return nil
	}
	return []*Node{n}
}
