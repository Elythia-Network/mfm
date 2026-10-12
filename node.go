package mfm

// NodeType is the "type" of an MFM node. The values are the type names of
// mfm-js 0.26.0's MfmNode.
type NodeType string

// Node types. Block nodes (quote, search, blockCode, mathBlock, center) are
// produced only by Parse, never by ParseSimple.
const (
	NodeQuote        NodeType = "quote"
	NodeSearch       NodeType = "search"
	NodeBlockCode    NodeType = "blockCode"
	NodeMathBlock    NodeType = "mathBlock"
	NodeCenter       NodeType = "center"
	NodeUnicodeEmoji NodeType = "unicodeEmoji"
	NodeEmojiCode    NodeType = "emojiCode"
	NodeBold         NodeType = "bold"
	NodeSmall        NodeType = "small"
	NodeItalic       NodeType = "italic"
	NodeStrike       NodeType = "strike"
	NodeInlineCode   NodeType = "inlineCode"
	NodeMathInline   NodeType = "mathInline"
	NodeMention      NodeType = "mention"
	NodeHashtag      NodeType = "hashtag"
	NodeURL          NodeType = "url"
	NodeLink         NodeType = "link"
	NodeFn           NodeType = "fn"
	NodePlain        NodeType = "plain"
	NodeText         NodeType = "text"
)

// Node is one node of the MFM tree.
//
// Props and Children have the same keys and shape as in mfm-js, so
// encoding/json renders a tree as the JSON of mfm-js's output: a node without
// props (bold, quote, ...) has no "props" key, a leaf has no "children" key,
// absent optional values (mention host, code block lang) are null, and fn
// arguments without a value are true.
type Node struct {
	Type     NodeType       `json:"type"`
	Props    map[string]any `json:"props,omitempty"`
	Children []*Node        `json:"children,omitempty"`
}

// Text returns a new text node holding s.
func Text(s string) *Node {
	return &Node{Type: NodeText, Props: map[string]any{"text": s}}
}

// textValue returns the "text" prop, or "" when n has none.
func (n *Node) textValue() string {
	s, _ := n.Props["text"].(string)
	return s
}

// withChildren returns a node of type t with the given children and no props.
func withChildren(t NodeType, children []*Node) *Node {
	return &Node{Type: t, Children: children}
}

// withProp returns a leaf node of type t with a single prop.
func withProp(t NodeType, key string, value any) *Node {
	return &Node{Type: t, Props: map[string]any{key: value}}
}
