package mfm

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"
)

// fuzzSeeds are the starting inputs of FuzzParse: one of every construct, and
// the unclosed and nested shapes the memo and the work budget exist for.
var fuzzSeeds = []string{
	"", "a", "<b>a</b>", "**a**", "***a***", "*a*", "__a__", "_a_", "~~a~~", "<i>a</i>", "<s>a</s>",
	"<small>a</small>", "<center>a</center>", "<plain>a</plain>", "`a`", "\\(a\\)", "\\[a\\]",
	"```js\na\n```", "> a\n> b", "a 検索", "$[x.a=1,b a]", "@a@b.c", "#a(b)", ":a:", "😀👍🏽1️⃣",
	"https://a.b/(c)", "<https://a.b/日本>", "[a](https://b.c)", "?[a](<https://b.c>)",
	"<b><b><b>", "[[[[a](", "$[x $[x $[x ", "> <b>\n>> **\n", "<center>a\n<center>a\n",
	"\xff\xfe", "a\r\nb\rc\n",
}

// FuzzParse checks properties that hold for every input: Parse and
// ParseSimple do not panic, encode to JSON, stay within the linear work
// bound, and ParseSimple loses no character of an input without <plain>.
func FuzzParse(f *testing.F) {
	for _, s := range fuzzSeeds {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, in string) {
		for _, simple := range []bool{false, true} {
			s := newState(strings.ToValidUTF8(in, "\uFFFD"), simple)
			nodes := mergeText(s.parseNodes(false))
			// 上限に届いた後も、深さごとに高々1つの子のループが残りを読むだけ
			if bound := s.budget.limit + 2*(s.nestLimit+2)*(len(s.src)+1); s.budget.used > bound {
				t.Fatalf("simple=%v: work %d exceeds the linear bound %d for %q", simple, s.budget.used, bound, in)
			}
			if _, err := json.Marshal(nodes); err != nil {
				t.Fatalf("simple=%v: %v", simple, err)
			}
		}
		full := Parse(in)
		if _, err := json.Marshal(full); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(in, "<plain>") {
			valid := strings.ToValidUTF8(in, "\uFFFD")
			if got := simpleSource(ParseSimple(in)); got != valid {
				t.Fatalf("ParseSimple lost characters: %q -> %q", valid, got)
			}
		}
		if !utf8.ValidString(textOf(full)) {
			t.Fatalf("invalid UTF-8 in the tree of %q", in)
		}
	})
}

// simpleSource rebuilds the source of a ParseSimple tree without <plain>:
// text, Unicode emoji and `:name:`.
func simpleSource(nodes []*Node) string {
	var b strings.Builder
	for _, n := range nodes {
		switch n.Type {
		case NodeText:
			b.WriteString(n.textValue())
		case NodeUnicodeEmoji:
			b.WriteString(n.Props["emoji"].(string))
		case NodeEmojiCode:
			b.WriteString(":" + n.Props["name"].(string) + ":")
		default:
			b.WriteString("<" + string(n.Type) + ">")
		}
	}
	return b.String()
}

// textOf concatenates every string prop of the tree.
func textOf(nodes []*Node) string {
	var b strings.Builder
	walkNodes(nodes, func(n *Node) {
		for _, v := range n.Props {
			if s, ok := v.(string); ok {
				b.WriteString(s)
			}
		}
	})
	return b.String()
}
