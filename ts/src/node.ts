// The node types and constructors have the same names, shapes and key order as
// mfm-js 0.26.0's, so that code written against mfm-js type-checks and behaves
// the same with this package.

/** Any node of a tree returned by {@link parse}. */
export type MfmNode = MfmBlock | MfmInline;

/** Any node of a tree returned by {@link parseSimple}. */
export type MfmSimpleNode = MfmUnicodeEmoji | MfmEmojiCode | MfmText | MfmPlain;

/** The block nodes, which only {@link parse} produces, at the top level or in a quote. */
export type MfmBlock = MfmQuote | MfmSearch | MfmCodeBlock | MfmMathBlock | MfmCenter;

const blockTypes: readonly string[] = ['quote', 'search', 'blockCode', 'mathBlock', 'center'];

/** Reports whether node is a block node. */
export function isMfmBlock(node: MfmNode): node is MfmBlock {
	return blockTypes.includes(node.type);
}

/** A quote: lines starting with `>`. */
export type MfmQuote = {
	type: 'quote';
	props?: Record<string, unknown>;
	children: MfmNode[];
};
/** Returns a quote node. */
export const QUOTE = (children: MfmNode[]): NodeType<'quote'> => {
	return { type: 'quote', children };
};

/** A search box: a query followed by `検索` or `search`. */
export type MfmSearch = {
	type: 'search';
	props: {
		query: string;
		content: string;
	};
	children?: [];
};
/** Returns a search node. */
export const SEARCH = (query: string, content: string): NodeType<'search'> => {
	return { type: 'search', props: { query, content } };
};

/** A code block between lines of three backquotes. */
export type MfmCodeBlock = {
	type: 'blockCode';
	props: {
		code: string;
		lang: string | null;
	};
	children?: [];
};
/** Returns a code block node. */
export const CODE_BLOCK = (code: string, lang: string | null): NodeType<'blockCode'> => {
	return { type: 'blockCode', props: { code, lang } };
};

/** A math block `\[...\]`. */
export type MfmMathBlock = {
	type: 'mathBlock';
	props: {
		formula: string;
	};
	children?: [];
};
/** Returns a math block node. */
export const MATH_BLOCK = (formula: string): NodeType<'mathBlock'> => {
	return { type: 'mathBlock', props: { formula } };
};

/** Centered content `<center>...</center>`. */
export type MfmCenter = {
	type: 'center';
	props?: Record<string, unknown>;
	children: MfmInline[];
};
/** Returns a center node. */
export const CENTER = (children: MfmInline[]): NodeType<'center'> => {
	return { type: 'center', children };
};

/** The inline nodes. */
export type MfmInline = MfmUnicodeEmoji | MfmEmojiCode | MfmBold | MfmSmall | MfmItalic | MfmStrike |
	MfmInlineCode | MfmMathInline | MfmMention | MfmHashtag | MfmUrl | MfmLink | MfmFn | MfmPlain | MfmText;

/** A Unicode emoji. */
export type MfmUnicodeEmoji = {
	type: 'unicodeEmoji';
	props: {
		emoji: string;
	};
	children?: [];
};
/** Returns a Unicode emoji node. */
export const UNI_EMOJI = (value: string): NodeType<'unicodeEmoji'> => {
	return { type: 'unicodeEmoji', props: { emoji: value } };
};

/** A custom emoji code `:name:`. */
export type MfmEmojiCode = {
	type: 'emojiCode';
	props: {
		name: string;
	};
	children?: [];
};
/** Returns a custom emoji code node. */
export const EMOJI_CODE = (name: string): NodeType<'emojiCode'> => {
	return { type: 'emojiCode', props: { name } };
};

/** Bold text: `**...**`, `__...__` or `<b>...</b>`. */
export type MfmBold = {
	type: 'bold';
	props?: Record<string, unknown>;
	children: MfmInline[];
};
/** Returns a bold node. */
export const BOLD = (children: MfmInline[]): NodeType<'bold'> => {
	return { type: 'bold', children };
};

/** Small text `<small>...</small>`. */
export type MfmSmall = {
	type: 'small';
	props?: Record<string, unknown>;
	children: MfmInline[];
};
/** Returns a small node. */
export const SMALL = (children: MfmInline[]): NodeType<'small'> => {
	return { type: 'small', children };
};

/** Italic text: `*...*`, `_..._` or `<i>...</i>`. */
export type MfmItalic = {
	type: 'italic';
	props?: Record<string, unknown>;
	children: MfmInline[];
};
/** Returns an italic node. */
export const ITALIC = (children: MfmInline[]): NodeType<'italic'> => {
	return { type: 'italic', children };
};

/** Struck-through text: `~~...~~` or `<s>...</s>`. */
export type MfmStrike = {
	type: 'strike';
	props?: Record<string, unknown>;
	children: MfmInline[];
};
/** Returns a strike node. */
export const STRIKE = (children: MfmInline[]): NodeType<'strike'> => {
	return { type: 'strike', children };
};

/** Inline code between backquotes. */
export type MfmInlineCode = {
	type: 'inlineCode';
	props: {
		code: string;
	};
	children?: [];
};
/** Returns an inline code node. */
export const INLINE_CODE = (code: string): NodeType<'inlineCode'> => {
	return { type: 'inlineCode', props: { code } };
};

/** An inline formula `\(...\)`. */
export type MfmMathInline = {
	type: 'mathInline';
	props: {
		formula: string;
	};
	children?: [];
};
/** Returns an inline formula node. */
export const MATH_INLINE = (formula: string): NodeType<'mathInline'> => {
	return { type: 'mathInline', props: { formula } };
};

/** A mention `@user` or `@user@host`. */
export type MfmMention = {
	type: 'mention';
	props: {
		username: string;
		host: string | null;
		acct: string;
	};
	children?: [];
};
/** Returns a mention node. */
export const MENTION = (username: string, host: string | null, acct: string): NodeType<'mention'> => {
	return { type: 'mention', props: { username, host, acct } };
};

/** A hashtag `#tag`. */
export type MfmHashtag = {
	type: 'hashtag';
	props: {
		hashtag: string;
	};
	children?: [];
};
/** Returns a hashtag node. */
export const HASHTAG = (value: string): NodeType<'hashtag'> => {
	return { type: 'hashtag', props: { hashtag: value } };
};

/** A URL, written as is or between `<` and `>` (brackets). */
export type MfmUrl = {
	type: 'url';
	props: {
		url: string;
		brackets?: boolean;
	};
	children?: [];
};
/** Returns a URL node. The brackets prop is set only when brackets is truthy. */
export const N_URL = (value: string, brackets?: boolean): NodeType<'url'> => {
	const node: MfmUrl = { type: 'url', props: { url: value } };
	if (brackets) node.props.brackets = brackets;
	return node;
};

/** A link `[label](url)`, or a silent link `?[label](url)`. */
export type MfmLink = {
	type: 'link';
	props: {
		silent: boolean;
		url: string;
	};
	children: MfmInline[];
};
/** Returns a link node. */
export const LINK = (silent: boolean, url: string, children: MfmInline[]): NodeType<'link'> => {
	return { type: 'link', props: { silent, url }, children };
};

/** A function `$[name.args children]`; `***...***` becomes `tada`. */
export type MfmFn = {
	type: 'fn';
	props: {
		name: string;
		args: Record<string, string | true>;
	};
	children: MfmInline[];
};
/** Returns a function node. */
export const FN = (name: string, args: MfmFn['props']['args'], children: MfmFn['children']): NodeType<'fn'> => {
	return { type: 'fn', props: { name, args }, children };
};

/** Text that is not parsed: `<plain>...</plain>`. */
export type MfmPlain = {
	type: 'plain';
	props?: Record<string, unknown>;
	children: MfmText[];
};
/** Returns a plain node holding text. */
export const PLAIN = (text: string): NodeType<'plain'> => {
	return { type: 'plain', children: [TEXT(text)] };
};

/** Text. */
export type MfmText = {
	type: 'text';
	props: {
		text: string;
	};
	children?: [];
};
/** Returns a text node. */
export const TEXT = (value: string): NodeType<'text'> => {
	return { type: 'text', props: { text: value } };
};

/** Maps a node type name to its node type. */
export type NodeType<T extends MfmNode['type']> =
	T extends 'quote' ? MfmQuote :
	T extends 'search' ? MfmSearch :
	T extends 'blockCode' ? MfmCodeBlock :
	T extends 'mathBlock' ? MfmMathBlock :
	T extends 'center' ? MfmCenter :
	T extends 'unicodeEmoji' ? MfmUnicodeEmoji :
	T extends 'emojiCode' ? MfmEmojiCode :
	T extends 'bold' ? MfmBold :
	T extends 'small' ? MfmSmall :
	T extends 'italic' ? MfmItalic :
	T extends 'strike' ? MfmStrike :
	T extends 'inlineCode' ? MfmInlineCode :
	T extends 'mathInline' ? MfmMathInline :
	T extends 'mention' ? MfmMention :
	T extends 'hashtag' ? MfmHashtag :
	T extends 'url' ? MfmUrl :
	T extends 'link' ? MfmLink :
	T extends 'fn' ? MfmFn :
	T extends 'plain' ? MfmPlain :
	T extends 'text' ? MfmText :
	never;
