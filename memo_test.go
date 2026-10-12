package mfm

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// nestedUnit returns s wrapped in depth pairs of open and close.
func nestedUnit(open, close string, depth int, s string) string {
	return strings.Repeat(open, depth) + s + strings.Repeat(close, depth)
}

// wellFormedUnits are ordinary posts with nesting up to the default limit:
// every construct is closed.
var wellFormedUnits = map[string]string{
	"nested fn":         nestedUnit("$[x2 ", "]", 19, "a") + " ",
	"nested bold":       nestedUnit("<b>", "</b>", 19, "a") + "\n",
	"bold in quote":     "> " + nestedUnit("<b>", "</b>", 15, "a") + "\n\n",
	"italic in link":    "[" + nestedUnit("<i>", "</i>", 18, "a") + "](https://e.x) ",
	"mixed decorations": "**<i>~~$[x2 [<small>a</small>](https://e.x)]~~</i>** #t @u :e: https://e.x/(a)\n",
}

// TestParse_WellFormedNestingStaysUnderTheLimits parses 256KB of closed,
// deeply nested constructs. Such input must never reach the work or memo
// limits (which would turn the rest into text), so the result must hold one
// tree per repetition of the unit, and the memo must stay under its base
// allowance, which does not depend on the input length.
//
// 文脈ごとに位置の表を持っていた実装は、1バイトあたり約380バイトを確保して
// 60KB前後で上限に届き、以降をテキストにしてmfm-jsと食い違った。
// parseOneのメモを引かないと、閉じた入れ子は子を集めるたびに読み直して
// 深さに対して指数的になる。
func TestParse_WellFormedNestingStaysUnderTheLimits(t *testing.T) {
	for name, unit := range wellFormedUnits {
		t.Run(name, func(t *testing.T) {
			n := (256 << 10) / len(unit)
			in := strings.Repeat(unit, n)
			s := newState(in, false)
			nodes := mergeText(s.parseNodes(false))
			require.False(t, s.budget.exhausted(), "used %d of %d, memo %d of %d", s.budget.used, s.budget.limit, s.budget.memUsed, s.budget.memLimit)
			assert.Less(t, s.budget.memUsed, memoBytesBase, "memo bytes")
			assert.Less(t, s.budget.used, 4*len(in), "work per byte")
			want := 0
			for _, node := range mergeText(newState(unit, false).parseNodes(false)) {
				if node.Type != NodeText {
					want++
				}
			}
			got := 0
			for _, node := range nodes {
				if node.Type != NodeText {
					got++
				}
			}
			assert.Equal(t, want*n, got, "trees")
		})
	}
}

// TestParse_MemoLimitFallsBackToText lowers the memo allowance so that a
// parse runs out of it, and checks the fallback: the memo never grows past
// the allowance, the work budget counts as spent, and the rest of the input
// is read as text without losing any of it.
func TestParse_MemoLimitFallsBackToText(t *testing.T) {
	in := strings.Repeat(wellFormedUnits["nested bold"], 2000)
	s := newState(in, false)
	s.budget.memLimit = 64 << 10
	nodes := mergeText(s.parseNodes(false))
	assert.LessOrEqual(t, s.budget.memUsed, s.budget.memLimit)
	assert.True(t, s.budget.exhausted())
	require.NotEmpty(t, nodes)
	last := nodes[len(nodes)-1]
	require.Equal(t, NodeText, last.Type)
	// 上限に届いた後は残りを1文字ずつ読むので、最後のテキストは入力の末尾で終わる
	assert.True(t, strings.HasSuffix(in, last.textValue()))
	assert.Greater(t, len(last.textValue()), len(in)/2)
}

// TestParseWithNestLimit_DeepQuotes parses 999 nested quotes under a nest
// limit of 1000. Each quote level holds its own table over its own body, so
// the tables must not grow with the depth times the number of contexts.
//
// 文脈ごとの表の入れ物を深さの分だけ確保していた実装は、874段で確保の上限に届いた。
func TestParseWithNestLimit_DeepQuotes(t *testing.T) {
	const depth = 999
	in := strings.Repeat(">", depth) + " a"
	s := newStateWithLimit(in, false, MaxNestLimit)
	nodes := s.parseNodes(true)
	require.False(t, s.budget.exhausted())
	assert.Less(t, s.budget.memUsed, 8<<20)
	quotes := 0
	for len(nodes) == 1 && nodes[0].Type == NodeQuote {
		quotes++
		nodes = nodes[0].Children
	}
	assert.Equal(t, depth, quotes)
	assert.Equal(t, []*Node{Text("a")}, nodes)
}

// TestMemoTable_SparsePagesBecomeDense stores results in one page of one
// context past sparseMax, so that the page turns from a list into an array,
// and checks that every result is found again, that other contexts and
// positions stay empty, and that the memo charge drops the list it replaced.
func TestMemoTable_SparsePagesBecomeDense(t *testing.T) {
	budget := &workBudget{limit: 1 << 20, memLimit: 1 << 20}
	m := newMemoTable(1000, 20, budget)
	k1, k2 := oneKey(1, false, false), oneKey(2, true, false)
	nodes := make([]*Node, sparseMax+5)
	conversion := 0
	for i := range nodes {
		nodes[i] = Text(string(rune('a' + i)))
		before := budget.memUsed
		m.storeOne(3*i, k1, nodes[i], 3*i+1)
		if i == sparseMax {
			conversion = budget.memUsed - before
		}
	}
	// 配列に変えるときは配列の分を数え、手放す並びの分を差し引く
	assert.Equal(t, m.pageLen(0)*memoEntrySize-sparseMax*sparseEntrySize, conversion)
	m.storeOne(3, k1, nodes[1], 99) // 上書き
	m.storeOne(5, k2, nodes[2], 9)
	m.storeOne(5, k2, nodes[0], 6) // 並びのままの上書き
	for i := range nodes {
		n, end, ok := m.lookupOne(3*i, k1)
		require.True(t, ok, "position %d", 3*i)
		assert.Same(t, nodes[i], n)
		want := 3*i + 1
		if i == 1 {
			want = 99
		}
		assert.Equal(t, want, end)
	}
	_, _, ok := m.lookupOne(1, k1)
	assert.False(t, ok, "empty cell of a dense page")
	_, _, ok = m.lookupOne(3, k2)
	assert.False(t, ok, "other context")
	n, end, ok := m.lookupOne(5, k2)
	assert.True(t, ok)
	assert.Same(t, nodes[0], n)
	assert.Equal(t, 6, end)
	_, _, ok = m.lookupOne(1001, k1)
	assert.False(t, ok, "out of range")
	sm := m.slotAt(int(k1) - 1)
	require.NotNil(t, sm)
	assert.True(t, sm.one[0].dense)
	assert.False(t, m.slotAt(int(k2) - 1).one[0].dense)
	assert.Len(t, m.slotAt(int(k2) - 1).one[0].offs, 1)

	s1, s2 := scanKey(1, false, false, scanBold), scanKey(1, false, false, scanItalic)
	assert.NotEqual(t, s1, s2)
	for i := range sparseMax + 5 {
		m.storeScan(2*i, s1, 2*i+7)
	}
	m.storeScan(2, s1, 50)
	m.storeScan(4, s2, 9)
	m.storeScan(4, s2, 8) // 並びのままの上書き
	for i := range sparseMax + 5 {
		e, ok := m.lookupScan(2*i, s1)
		require.True(t, ok)
		want := 2*i + 7
		if i == 1 {
			want = 50
		}
		assert.Equal(t, want, e)
	}
	e, ok := m.lookupScan(4, s2)
	assert.True(t, ok)
	assert.Equal(t, 8, e)
	_, ok = m.lookupScan(1, s1)
	assert.False(t, ok)
	_, ok = m.lookupScan(6, s2)
	assert.False(t, ok)
	_, ok = m.lookupScan(0, scanKey(5, false, false, scanBold))
	assert.False(t, ok, "unallocated slot")
	_, ok = m.lookupScan(0, scanKey(1, false, false, scanFn))
	assert.False(t, ok, "unused kind")

	// 鍵は深さの上限まで重ならず、0にならない
	seen := map[uint16]bool{}
	for d := 0; d <= MaxNestLimit; d++ {
		for _, inLink := range []bool{false, true} {
			for _, atFull := range []bool{false, true} {
				for k := scanKind(0); k < numScanKinds; k++ {
					key := scanKey(d, inLink, atFull, k)
					require.NotZero(t, key)
					require.False(t, seen[key], "duplicate scan key")
					seen[key] = true
				}
			}
		}
	}
}

// TestMemoTable_SlotsGrowBothWays allocates a deep slot first and a shallow
// one later: the container starts at the first slot used and grows towards
// both ends, keeping the slots already stored.
func TestMemoTable_SlotsGrowBothWays(t *testing.T) {
	m := newMemoTable(10, 20, &workBudget{limit: 1 << 20, memLimit: 1 << 20})
	deep, shallow := oneKey(15, false, true), oneKey(2, false, false)
	m.storeOne(1, deep, Text("d"), 2)
	assert.Equal(t, int(deep)-1, m.slotBase)
	assert.Len(t, m.slots, 1, "no slots below the first one used")
	m.storeOne(1, shallow, Text("s"), 3)
	assert.Equal(t, int(shallow)-1, m.slotBase)
	n, end, ok := m.lookupOne(1, deep)
	require.True(t, ok)
	assert.Equal(t, "d", n.textValue())
	assert.Equal(t, 2, end)
	n, _, ok = m.lookupOne(1, shallow)
	require.True(t, ok)
	assert.Equal(t, "s", n.textValue())
	assert.Nil(t, m.slot(-1, true))
	assert.Nil(t, m.slot(21*4, true), "beyond the nest limit")
}

// TestParse_ShortQuoteBlocksCost pins the documented cost of quote blocks:
// each block has its own table with a fixed cost of about 500 bytes per
// nesting level, so 64KB of `> a⏎⏎` stays under the limit at about 101 bytes
// per input byte, and 3000 bytes of 20-level quote blocks need about 1.3MB.
func TestParse_ShortQuoteBlocksCost(t *testing.T) {
	in := strings.Repeat("> a\n\n", (64<<10)/5)
	s := newState(in, false)
	s.parseNodes(false)
	require.False(t, s.budget.exhausted())
	assert.Less(t, s.budget.memUsed, 110*len(in), "memo bytes per input byte")

	unit := strings.Repeat(">", 20) + "a\n\n"
	in = strings.Repeat(unit, 3000/len(unit))
	s = newState(in, false)
	s.parseNodes(false)
	require.False(t, s.budget.exhausted())
	assert.Less(t, s.budget.memUsed, 3<<19, "3000 bytes of deep quote blocks")
}
