package mfm

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestParse_EmptyInput checks that an empty input gives an empty, non-nil
// slice from every entry point, which encodes as [] like mfm-js's result.
func TestParse_EmptyInput(t *testing.T) {
	for name, nodes := range map[string][]*Node{
		"Parse":              Parse(""),
		"ParseSimple":        ParseSimple(""),
		"ParseWithNestLimit": ParseWithNestLimit("", 3),
	} {
		assert.NotNil(t, nodes, name)
		assert.Empty(t, nodes, name)
		b, err := json.Marshal(nodes)
		assert.NoError(t, err)
		assert.Equal(t, "[]", string(b), name)
	}
}

// TestParseWithNestLimit_ClampsTheLimit checks that out-of-range limits are
// clamped: a negative one reads like 0, and one above MaxNestLimit like
// MaxNestLimit.
func TestParseWithNestLimit_ClampsTheLimit(t *testing.T) {
	assert.Equal(t, 0, clampNestLimit(-5))
	assert.Equal(t, 0, clampNestLimit(0))
	assert.Equal(t, 7, clampNestLimit(7))
	assert.Equal(t, MaxNestLimit, clampNestLimit(MaxNestLimit))
	assert.Equal(t, MaxNestLimit, clampNestLimit(MaxNestLimit+1))
	in := "<b><b>a</b></b>"
	assert.Equal(t, ParseWithNestLimit(in, 0), ParseWithNestLimit(in, -5))
	deep := strings.Repeat("<b>", MaxNestLimit+1) + "x" + strings.Repeat("</b>", MaxNestLimit+1)
	nodes := ParseWithNestLimit(deep, MaxNestLimit+50)
	// 最も内側の<b>は上限の深さで文字になり、余った</b>が最上位に残る
	require.Len(t, nodes, 2)
	assert.Equal(t, Text("</b>"), nodes[1])
	depth := 0
	for n := nodes[0]; n.Type == NodeBold; n = n.Children[0] {
		depth++
	}
	// 上限MaxNestLimitの深さまでが太字になり、その下は文字になる
	assert.Equal(t, MaxNestLimit, depth)
}

// TestNode_JSONMatchesMfmJsShape checks the JSON encoding of the node kinds
// whose shape has optional parts: null props, true arguments, brackets only
// when set, and no props or children keys when absent.
func TestNode_JSONMatchesMfmJsShape(t *testing.T) {
	cases := []struct{ in, want string }{
		{"@a", `[{"type":"mention","props":{"acct":"@a","host":null,"username":"a"}}]`},
		{"```\nx\n```", `[{"type":"blockCode","props":{"code":"x","lang":null}}]`},
		{"$[x.a,b=1 c]", `[{"type":"fn","props":{"args":{"a":true,"b":"1"},"name":"x"},"children":[{"type":"text","props":{"text":"c"}}]}]`},
		{"<https://e.x>", `[{"type":"url","props":{"brackets":true,"url":"https://e.x"}}]`},
		{"https://e.x", `[{"type":"url","props":{"url":"https://e.x"}}]`},
		{"**a**", `[{"type":"bold","children":[{"type":"text","props":{"text":"a"}}]}]`},
	}
	for _, tc := range cases {
		got, err := json.Marshal(Parse(tc.in))
		require.NoError(t, err)
		assert.JSONEq(t, tc.want, string(got), tc.in)
	}
}

// TestParse_EmojiCodeBoundaryMatchesMfmJs fixes the emojiCode boundary to
// mfm-js 0.26.0. Expected values were produced by running mfm-js's
// parse / parseSimple on each input.
//
// mfm-jsは閉じの`:`の直後が英数字かだけを見て、直前の文字は見ない。
func TestParse_EmojiCodeBoundaryMatchesMfmJs(t *testing.T) {
	cases := []struct {
		in           string
		full, simple []string
	}{
		{"1:a:", []string{"a"}, []string{"a"}},
		{"a:b: c", []string{"b"}, []string{"b"}},
		{"@foo:a:", []string{"a"}, []string{"a"}},
		{"#tag:a:", []string{"a"}, []string{"a"}},
		{":a:1", nil, nil},
		{":a:b", nil, nil},
		{"a:thinking:", []string{"thinking"}, []string{"thinking"}},
		{":a:", []string{"a"}, []string{"a"}},
		{":a: :b:", []string{"a", "b"}, []string{"a", "b"}},
		{":a::b:", []string{"a", "b"}, []string{"a", "b"}},
		{"a:b:c", nil, nil},
		{"x :a:", []string{"a"}, []string{"a"}},
		{"\u65e5\u672c:a:\u8a9e", []string{"a"}, []string{"a"}},
		{":a:\u65e5\u672c", []string{"a"}, []string{"a"}},
		{":a:_", []string{"a"}, []string{"a"}},
		{":a:-", []string{"a"}, []string{"a"}},
		{":A:Z", nil, nil},
		{":a:\n", []string{"a"}, []string{"a"}},
		{":a:.", []string{"a"}, []string{"a"}},
		{"**:a:**", []string{"a"}, []string{"a"}},
		{"(:a:)", []string{"a"}, []string{"a"}},
		{":a+b-c_d:", []string{"a+b-c_d"}, []string{"a+b-c_d"}},
		{"https://x.example/:a:", nil, []string{"a"}},
		{"[l](https://x.example):a:", []string{"a"}, []string{"a"}},
		{"`:a:`", nil, []string{"a"}},
		{"::a::", []string{"a"}, []string{"a"}},
		{":a:b:c:", []string{"c"}, []string{"c"}},
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			assert.Equal(t, tc.full, emojiCodeNames(Parse(tc.in)), "parse")
			assert.Equal(t, tc.simple, emojiCodeNames(ParseSimple(tc.in)), "parseSimple")
		})
	}
}

// emojiCodeNames returns the emojiCode names in nodes in document order
// (mfm-jsの`extract(nodes, n => n.type === 'emojiCode')`と同じ並び)。
func emojiCodeNames(nodes []*Node) []string {
	var out []string
	var walk func(n *Node)
	walk = func(n *Node) {
		if n.Type == NodeEmojiCode {
			out = append(out, n.Props["name"].(string))
		}
		for _, c := range n.Children {
			walk(c)
		}
	}
	for _, n := range nodes {
		walk(n)
	}
	return out
}
