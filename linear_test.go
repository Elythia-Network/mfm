package mfm

import (
	"os"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// pathologicalUnits are stress inputs for the linear bounds, each repeated:
// unclosed constructs, brackets and delimiters that each start a scan to the
// end of the input, and nesting that multiplies the scans.
var pathologicalUnits = map[string]string{
	"unclosed bold tag":    "<b>",
	"unclosed small tag":   "<small>",
	"unclosed bold asta":   "**",
	"unclosed big":         "***",
	"unclosed strike wave": "~~a",
	"unclosed fn":          "$[x ",
	"unclosed fn args":     "$[x.a=b,c ",
	"unclosed link label":  "[",
	"unclosed silent link": "?[<b>",
	"unclosed link url":    "[a](",
	"unclosed url alt":     "[a](<https://x\n",
	"unclosed center":      "<center>a\n",
	"unclosed code block":  "```a\n",
	"unclosed inline code": "`a",
	"unclosed math inline": "\\(a",
	"unclosed math block":  "\\[a",
	"unclosed plain":       "<plain>a",
	"unclosed url parens":  "https://a(",
	"unclosed hashtag":     "#a(「[",
	"quote lines":          "> <b>\n",
	"nested quotes":        ">>>>>>>>>> ~~a\n",
	"search lines":         "a 検索 x\n",
	"emoji codes":          ":a:b",
	"mentions":             "@a.@",
	"mixed":                "<b>**~~$[x [<small><i>\\[`<plain>\\(",
}

// workAndMemory parses in and returns the work units and the bytes of memo
// storage the parse charged, and the bytes it allocated.
func workAndMemory(t *testing.T, in string, simple bool) (work, memo int, alloc uint64) {
	t.Helper()
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	s := newState(in, simple)
	mergeText(s.parseNodes(false))
	runtime.ReadMemStats(&after)
	// 上限に届くと以降は1文字ずつ読むだけになり、どんな入力でも線形に見えてしまう。
	// 上限に届かない大きさで比べる
	require.False(t, s.budget.exhausted(), "the work budget must not cut the parse short (%d of %d)", s.budget.used, s.budget.limit)
	return s.budget.used, s.budget.memUsed, after.TotalAlloc - before.TotalAlloc
}

// TestParse_WorkAndMemoryGrowLinearly parses each pathological input at n and
// 4n bytes and requires the work (the parser's own count of steps, which
// bounds its running time) and the memory (memo storage and all bytes
// allocated) to grow by about 4 times, not the 16 times of a quadratic parser.
//
// 仕事量とメモリ量は実行のたびに同じ値になるので、時間と違ってCIの負荷や
// -raceで揺れない。時間はTestParse_TimeGrowsLinearlyで別に見る。
func TestParse_WorkAndMemoryGrowLinearly(t *testing.T) {
	const n = 4 << 10
	for name, unit := range pathologicalUnits {
		for _, simple := range []bool{false, true} {
			small := fill("", unit, n)
			large := fill("", unit, 4*n)
			w1, m1, a1 := workAndMemory(t, small, simple)
			w4, m4, a4 := workAndMemory(t, large, simple)
			ratio := float64(len(large)) / float64(len(small))
			// 線形なら比は入力長の比(約4)に、2乗なら約16になる。固定の費用と
			// ページ単位の確保の端数の分だけ余裕を見る
			assert.LessOrEqual(t, float64(w4), 1.25*ratio*float64(w1), "%s (simple=%v): work %d -> %d", name, simple, w1, w4)
			assert.LessOrEqual(t, float64(m4), 1.5*ratio*float64(m1)+4096, "%s (simple=%v): memo %d -> %d", name, simple, m1, m4)
			assert.LessOrEqual(t, float64(a4), 1.5*ratio*float64(a1)+64<<10, "%s (simple=%v): alloc %d -> %d", name, simple, a1, a4)
		}
	}
}

// TestParse_WorkPerByteIsBounded checks the constant of the linear bound: the
// work per input byte stays under a fixed number for every pathological
// input, at the size of a long post.
func TestParse_WorkPerByteIsBounded(t *testing.T) {
	for name, unit := range pathologicalUnits {
		in := fill("", unit, 16<<10)
		w, m, _ := workAndMemory(t, in, false)
		// 実測の最大はnested quotesの1バイトあたり40程度(深さの分だけ大きい)
		assert.Less(t, w, 64*len(in), "%s: work per byte", name)
		assert.Less(t, m, 512*len(in), "%s: memo bytes per input byte", name)
	}
}

// skipTiming reports whether to skip the timing tests: under -short, under the
// race detector, and when MFM_SKIP_TIMING is set. The work and memory tests
// always run.
//
// 時間は負荷や-raceで揺れるので、比を見るテストは素のビルドでだけ回す。仕事量と
// メモリ量は実行ごとに同じ値になるので、常に回す
func skipTiming() (bool, string) {
	switch {
	case testing.Short():
		return true, "timing test skipped under -short"
	case raceEnabled:
		return true, "timing test skipped under -race"
	case os.Getenv("MFM_SKIP_TIMING") != "":
		return true, "timing test skipped by MFM_SKIP_TIMING"
	}
	return false, ""
}

// parseTime returns the shortest of several measured durations of Parse(in).
func parseTime(in string) time.Duration {
	best := time.Duration(1<<63 - 1)
	for range 5 {
		start := time.Now()
		Parse(in)
		best = min(best, time.Since(start))
	}
	return best
}

// TestParse_TimeGrowsLinearly measures the running time at n and 4n bytes.
// A quadratic parser takes about 16 times as long on the larger input; the
// bound allows twice the linear ratio for noise, and the shortest of five
// runs removes most of it.
//
// 時間は揺れるので、仕事量のテストより緩い比で見る。
func TestParse_TimeGrowsLinearly(t *testing.T) {
	if skip, why := skipTiming(); skip {
		t.Skip(why)
	}
	const n = 8 << 10
	for _, name := range []string{"unclosed bold tag", "unclosed link label", "unclosed center", "unclosed plain", "nested quotes", "mixed"} {
		unit := pathologicalUnits[name]
		small, large := fill("", unit, n), fill("", unit, 4*n)
		Parse(small) // 絵文字の照合器などの初回の費用を外す
		t1, t4 := parseTime(small), parseTime(large)
		assert.Less(t, float64(t4), 8*float64(t1), "%s: %v -> %v", name, t1, t4)
	}
}

// TestFill checks the helper the size comparisons depend on: it must produce
// inputs of about the requested length made of whole units.
func TestFill(t *testing.T) {
	got := fill("<b>", "ab", 9)
	assert.Equal(t, "<b>ababab", got)
	assert.True(t, strings.HasPrefix(fill("", "<center>a\n", 4<<10), "<center>a\n<center>"))
	assert.InDelta(t, 4<<10, len(fill("", "<center>a\n", 4<<10)), 10)
}
