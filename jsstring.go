package mfm

import "strings"

// isJSWhitespace reports whether r is removed by JavaScript's
// String.prototype.trim: the WhiteSpace and LineTerminator code points of
// ECMAScript (TAB, VT, FF, SP, NBSP, ZWNBSP, the Zs category, LF, CR, LS, PS).
//
// Goのunicode.IsSpaceと違い、U+0085 (NEL)を含まず、U+FEFF (BOM)を含む。
func isJSWhitespace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0x00A0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return 0x2000 <= r && r <= 0x200A
}

// jsTrim trims s exactly like JavaScript's String.prototype.trim.
func jsTrim(s string) string { return strings.TrimFunc(s, isJSWhitespace) }
