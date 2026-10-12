package mfm

import "unicode/utf16"

// walkNodes calls visit for every node of the trees in nodes, parents before
// children and siblings in order (the order of mfm-js's inspect / extract).
func walkNodes(nodes []*Node, visit func(*Node)) {
	for _, n := range nodes {
		visit(n)
		walkNodes(n.Children, visit)
	}
}

// uniqueStrings collects strings in first-seen order without duplicates.
type uniqueStrings struct {
	seen map[string]struct{}
	list []string
}

func (u *uniqueStrings) add(s string) {
	if _, dup := u.seen[s]; dup {
		return
	}
	if u.seen == nil {
		u.seen = map[string]struct{}{}
	}
	u.seen[s] = struct{}{}
	u.list = append(u.list, s)
}

// CollectHashtags parses each input with Parse and returns the hashtags
// (without the leading "#") found across all of them, in order of first
// appearance and without exact duplicates. It returns nil when there are none.
//
// Because the texts go through the full parser, a "#" inside code, a URL, a
// link label or a mention is not a hashtag, unlike with a flat regex scan.
// Case folding and length limits are left to the caller.
func CollectHashtags(texts ...string) []string {
	var tags uniqueStrings
	for _, text := range texts {
		walkNodes(Parse(text), func(n *Node) {
			if n.Type != NodeHashtag {
				return
			}
			if tag, ok := n.Props["hashtag"].(string); ok {
				tags.add(tag)
			}
		})
	}
	return tags.list
}

// CollectEmojiCodes parses each input with Parse and returns the custom emoji
// names (`:name:` without the colons) found across all of them, in order of
// first appearance and without duplicates. It returns nil when there are none.
//
// A server typically stores these names with a note so that the emoji can be
// resolved when the note is rendered. Unlike ExtractCustomEmojis it applies no
// length limit.
func CollectEmojiCodes(texts ...string) []string {
	var names uniqueStrings
	for _, text := range texts {
		walkNodes(Parse(text), func(n *Node) {
			if n.Type != NodeEmojiCode {
				return
			}
			if name, ok := n.Props["name"].(string); ok {
				names.add(name)
			}
		})
	}
	return names.list
}

// customEmojiNameMax is upstream extractCustomEmojisFromMfm's limit on the
// emoji name length (JavaScript string length, i.e. UTF-16 code units).
const customEmojiNameMax = 100

// ExtractCustomEmojis returns the custom emoji names (`:name:`) in already
// parsed nodes, dedup'd and ordered by first appearance. Mirrors upstream
// extractCustomEmojisFromMfm: names longer than 100 UTF-16 code units are
// skipped.
//
// Unlike CollectEmojiCodes it takes parsed nodes, so the caller chooses the
// parser: Misskey reads a user's name with parseSimple and the profile
// description with parse.
func ExtractCustomEmojis(nodes []*Node) []string {
	// Misskeyのi/updateは名前と補足情報をparseSimple、プロフィールとフォロー
	// されたときのメッセージをparseで読み分けるので、入力を自分でparseしない
	var names uniqueStrings
	walkNodes(nodes, func(n *Node) {
		if n.Type != NodeEmojiCode {
			return
		}
		if name, ok := n.Props["name"].(string); ok && len(utf16.Encode([]rune(name))) <= customEmojiNameMax {
			names.add(name)
		}
	})
	return names.list
}
