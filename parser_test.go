package mfm

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// testdataDir holds the fixtures generated from mfm-js by tools/gen-testdata.
const testdataDir = "testdata"

// fixtureFile is one JSON file of testdata/.
type fixtureFile struct {
	Generator string        `json:"generator"`
	MfmJs     string        `json:"mfmjs"`
	EmojiData string        `json:"emojiData"`
	Cases     []fixtureCase `json:"cases"`
}

// fixtureCase is one parse case: mfm-js's output for input and options.
type fixtureCase struct {
	Name    string `json:"name"`
	Input   string `json:"input"`
	Options struct {
		Parser    string `json:"parser"`
		NestLimit *int   `json:"nestLimit"`
	} `json:"options"`
	Output json.RawMessage `json:"output"`

	// extract.jsonの項目
	Hashtags           []string `json:"hashtags"`
	EmojiCodes         []string `json:"emojiCodes"`
	CustomEmojis       []string `json:"customEmojis"`
	CustomEmojisSimple []string `json:"customEmojisSimple"`
}

// minCases is the least number of cases each fixture file must hold, so that
// a fixture that fails to load or comes out empty cannot pass as green.
var minCases = map[string]int{
	"syntax.json":        300,
	"regression.json":    1000,
	"nest-limit.json":    50,
	"random.json":        3500,
	"unicode-emoji.json": 5000,
	"differences.json":   1,
	"extract.json":       700,
}

// knownDifferences lists the fixture cases where this package intentionally
// differs from mfm-js 0.26.0, with the reason. Each entry must exist and must
// still differ; the README lists the same differences.
var knownDifferences = map[string]string{
	// 入れ子はGoの再帰で読むので、nestLimitをMaxNestLimit (1000)で頭打ちにする。
	// mfm-jsは1001段の<b>を全て太字にする(既定のスタックでは溢れて投げる)
	"differences/1ff08601427b": "nestLimit above MaxNestLimit is lowered to MaxNestLimit",
}

func loadFixture(t *testing.T, name string) fixtureFile {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(testdataDir, name))
	require.NoError(t, err)
	var f fixtureFile
	require.NoError(t, json.Unmarshal(b, &f), name)
	// 正規表現と期待値は同じ版のmfm-js / emoji-dataから作る。どちらかを上げたら
	// 両方を作り直す
	require.Equal(t, emojiMfmJsVersion, f.MfmJs, "%s: regenerate testdata with tools/gen-testdata", name)
	require.Equal(t, emojiDataVersion, f.EmojiData, "%s: regenerate testdata with tools/gen-testdata", name)
	require.GreaterOrEqual(t, len(f.Cases), minCases[name], "%s has too few cases", name)
	return f
}

// fixtureNames lists the parse fixtures (every file of testdata/ but
// extract.json), failing when a file is not covered by minCases.
func fixtureNames(t *testing.T) []string {
	t.Helper()
	paths, err := filepath.Glob(filepath.Join(testdataDir, "*.json"))
	require.NoError(t, err)
	var names []string
	for _, p := range paths {
		name := filepath.Base(p)
		require.Contains(t, minCases, name, "new fixture file: add it to minCases")
		if name != "extract.json" {
			names = append(names, name)
		}
	}
	// 一覧が空振りして何も比べずに緑にならないよう、全部があることを確かめる
	require.Len(t, names, len(minCases)-1)
	return names
}

// runFixture parses c.Input the way the case asks.
func runFixture(c fixtureCase) []*Node {
	if c.Options.Parser == "simple" {
		return ParseSimple(c.Input)
	}
	if c.Options.NestLimit != nil {
		return ParseWithNestLimit(c.Input, *c.Options.NestLimit)
	}
	return Parse(c.Input)
}

// normalizeJSON decodes JSON into plain values, so that trees compare
// independently of key order and of nil versus empty slices.
func normalizeJSON(t *testing.T, b []byte) any {
	t.Helper()
	var v any
	require.NoError(t, json.Unmarshal(b, &v))
	return v
}

// TestParse_MatchesMfmJsFixtures runs every case of testdata/ and requires
// the tree, encoded as JSON, to equal mfm-js 0.26.0's output, except for the
// cases listed in knownDifferences.
func TestParse_MatchesMfmJsFixtures(t *testing.T) {
	seenDiff := map[string]bool{}
	total, mismatches := 0, 0
	for _, file := range fixtureNames(t) {
		f := loadFixture(t, file)
		for _, c := range f.Cases {
			total++
			require.Contains(t, []string{"full", "simple"}, c.Options.Parser, c.Name)
			got, err := json.Marshal(runFixture(c))
			require.NoError(t, err)
			want := normalizeJSON(t, c.Output)
			equal := assert.ObjectsAreEqual(want, normalizeJSON(t, got))
			if reason, known := knownDifferences[c.Name]; known {
				seenDiff[c.Name] = true
				assert.False(t, equal, "%s (%q) matches mfm-js now; remove it from knownDifferences (%s)", c.Name, c.Input, reason)
				continue
			}
			if !equal {
				mismatches++
				assert.Equal(t, want, normalizeJSON(t, got), "%s: input %q options %+v", c.Name, c.Input, c.Options)
				if mismatches >= 30 {
					t.Fatalf("too many mismatches (%d of %d so far)", mismatches, total)
				}
			}
		}
	}
	for name := range knownDifferences {
		assert.True(t, seenDiff[name], "knownDifferences entry %s is not in testdata", name)
	}
	t.Logf("%d cases, %d known differences", total, len(knownDifferences))
}

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

// TestKnownDifferences_AreDocumented requires every reason of
// knownDifferences to be non-empty and the names to be sorted into the
// "differences/" fixture, the only file meant for them.
func TestKnownDifferences_AreDocumented(t *testing.T) {
	names := make([]string, 0, len(knownDifferences))
	for name, reason := range knownDifferences {
		assert.NotEmpty(t, reason, name)
		names = append(names, name)
	}
	slices.Sort(names)
	for _, name := range names {
		assert.Regexp(t, `^differences/[0-9a-f]{12}$`, name)
	}
}
