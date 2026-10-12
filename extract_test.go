package mfm

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestCollectHashtags_Empty(t *testing.T) {
	assert.Nil(t, CollectHashtags())
	assert.Nil(t, CollectHashtags(""))
	assert.Nil(t, CollectHashtags("hello world"))
}

func TestCollectHashtags_Basic(t *testing.T) {
	assert.Equal(t, []string{"golang"}, CollectHashtags("hello #golang"))
	assert.Equal(t, []string{"go", "rust"}, CollectHashtags("learn #go and #rust"))
}

func TestCollectHashtags_DedupExactAndOrder(t *testing.T) {
	// exact dedup + first-occurrence順(大文字小文字の同一視は呼び出し側で行う)
	assert.Equal(t, []string{"go", "GO"}, CollectHashtags("#go #go #GO"))
}

func TestCollectHashtags_NestedInsideMarkup(t *testing.T) {
	// fn ($[...])などinline子を持つノードの中のhashtagもAST walkで拾える
	assert.Equal(t, []string{"bar"}, CollectHashtags("$[x2 #bar]"))
	assert.ElementsMatch(t, []string{"foo", "bar"}, CollectHashtags("#foo $[spin #bar]"))
}

func TestCollectHashtags_ExcludesCodeURLMention(t *testing.T) {
	// code block / inline code / URL fragment /の中の#はhashtagにならない
	assert.Empty(t, CollectHashtags("```\n#secret\n```"))
	assert.Empty(t, CollectHashtags("inline `#var`"))
	assert.Empty(t, CollectHashtags("https://example.com/path#anchor"))
	// mentionはhashtagではない
	assert.Equal(t, []string{"real"}, CollectHashtags("@alice #real"))
}

func TestCollectHashtags_WordBoundary(t *testing.T) {
	// 直前が英数字ならhashtagにならない(foo#bar / #one#twoの#two)
	assert.Nil(t, CollectHashtags("foo#bar"))
	assert.Equal(t, []string{"one"}, CollectHashtags("#one#two"))
}

func TestCollectHashtags_AcrossMultipleTexts(t *testing.T) {
	assert.Equal(t, []string{"foo", "bar"}, CollectHashtags("body #foo", "cw #bar"))
}

func TestCollectEmojiCodes(t *testing.T) {
	assert.Nil(t, CollectEmojiCodes())
	assert.Nil(t, CollectEmojiCodes("no emoji"))
	assert.Equal(t, []string{"a", "b"}, CollectEmojiCodes(":a: **:b:**", "cw :a:"))
	assert.Nil(t, CollectEmojiCodes("`:code:`"), "no emojiCode inside code")
	long := strings.Repeat("a", 101)
	assert.Equal(t, []string{long}, CollectEmojiCodes(":"+long+":"), "no length limit")
}

// ExtractCustomEmojis mirrors upstream extractCustomEmojisFromMfm: dedup'd in
// first-appearance order, nested nodes included, names over 100 UTF-16 code
// units skipped.
func TestExtractCustomEmojis(t *testing.T) {
	assert.Nil(t, ExtractCustomEmojis(nil))
	assert.Equal(t, []string{"a", "b"}, ExtractCustomEmojis(Parse("**:a:** $[x2 :b:] :a:")))
	assert.Nil(t, ExtractCustomEmojis(Parse("`:code:`")), "no emojiCode inside code")
	assert.Equal(t, []string{"code"}, ExtractCustomEmojis(ParseSimple("`:code:`")), "parseSimple does not read code")

	long := strings.Repeat("a", 101)
	limit := strings.Repeat("b", 100)
	got := ExtractCustomEmojis([]*Node{
		withProp(NodeEmojiCode, "name", long),
		withProp(NodeEmojiCode, "name", limit),
	})
	assert.Equal(t, []string{limit}, got, "names over 100 code units are skipped")
}
