# mfm

Parsers for MFM (Misskey Flavored Markdown) that produce the same tree as
[mfm-js](https://github.com/misskey-dev/mfm.js) 0.26.0, in time and memory
linear in the length of the input.

The parsers here remember the intermediate results and bound the total work,
so that any input is parsed in linear time and memory, while the result stays
the same as mfm-js's for every input that stays within the work and memory
limits described below. Every input of up to 3,000 bytes we measured, and
closed nesting without quotes at any length, stays within them; the tables
below list the inputs that reach them.

| Path | Contents |
|---|---|
| repository root | The Go parser (module `github.com/elythia-network/mfm`, package `mfm`) |
| [`testdata/`](testdata/) | Fixtures shared by the Go parser and the TypeScript port: inputs and mfm-js 0.26.0's output for them |
| [`ts/`](ts/) | The TypeScript port, published to npm as `@elythia-network/mfm` (see [`ts/README.md`](ts/README.md)) |
| [`tools/`](tools/) | Generators for `testdata/` and for the Unicode emoji pattern (a separate Go module, not part of the published one) |

## Go

```sh
go get github.com/elythia-network/mfm
```

```go
import "github.com/elythia-network/mfm"

nodes := mfm.Parse("**Hello** :wave: #mfm @someone@example.com")
simple := mfm.ParseSimple("Name :custom_emoji:") // for user names and the like
```

| API | mfm-js | Notes |
|---|---|---|
| `Parse(input) []*Node` | `parse(input)` | Every construct, nest limit 20 |
| `ParseWithNestLimit(input, n) []*Node` | `parse(input, { nestLimit: n })` | A negative `n` reads like 0; above `MaxNestLimit` (1000) it is lowered to 1000 |
| `ParseSimple(input) []*Node` | `parseSimple(input)` | Unicode emoji, `:emoji:` and `<plain>` only |
| `Node`, `NodeType`, `Node*` constants, `Text(s)` | `MfmNode`, `TEXT` | `Node` has `Type`, `Props` and `Children` with mfm-js's names |
| `CollectHashtags(texts...) []string` | `extract(parse(t), n => n.type === 'hashtag')` | Tags without `#`, in order, without duplicates |
| `CollectEmojiCodes(texts...) []string` | `extract(parse(t), n => n.type === 'emojiCode')` | Names without `:`, in order, without duplicates |
| `ExtractCustomEmojis(nodes) []string` | Misskey's `extractCustomEmojisFromMfm` | Same, skipping names longer than 100 UTF-16 code units |

`encoding/json` encodes a tree as the JSON of mfm-js's result: a node without
props has no `"props"` key, a leaf has no `"children"` key, a mention without a
host and a code block without a language have `null` there, and fn arguments
without a value are `true`.

### Linear time and memory

The parser keeps, for one call:

- the result of reading one node at each (position, nesting depth, inside a link
  label or not, top level or not), so that a position is parsed at most once per
  context. Each context has its own table, split into pages of 256 positions
  that are allocated on first write: a page holds a short list of results
  until it has 16 of them, then turns into an array indexed by position. Closed
  nesting writes a few results per page and context, so it stays small at any
  depth, while inputs that make many contexts read the same positions get
  arrays, as dense as a plain array per context;
- for each construct that reads children up to a closing delimiter, where the
  children starting at each position stop, so that failing constructs do not
  re-scan the same text (stored the same way);
- sorted indexes of the delimiters that some constructs scan for (`</plain>`,
  `\]`, `</center>`, the end of a code block, ...), and the parsed link
  targets and quote blocks, each built once.

As a safety net, one call may do at most `2^21 + 32 × len(input)` units of
work and keep at most `max(16 MiB, 64 × len(input))` bytes of memo storage.
What happens when either runs out is described under the differences below.
Positions are 32-bit, so inputs of 2 GiB or more are not supported.

Measured memo storage (Go 1.27.2, linux/amd64; `memo_test.go`,
`linear_test.go` and `backtrack_test.go` check the bounds):

| Input | Size | Memo storage | Limit reached |
|---|---|---|---|
| 19 nested `$[x2 …]`, repeated | 256 KiB / 1 MiB | 3.4 MB / 13.7 MB | no |
| 19 nested `<b>`, repeated | 256 KiB / 1 MiB | 3.3 MB / 13.2 MB | no |
| 15 nested `<b>` in a quote, repeated | 256 KiB / 1 MiB | 11.9 MB / 47.8 MB | no |
| 18 nested `<i>` in a link label, repeated | 256 KiB / 1 MiB | 3.4 MB / 13.5 MB | no |
| mixed closed decorations, repeated | 256 KiB / 1 MiB | 1.4 MB / 5.7 MB | no |
| `<center>#~~[**[_:<ce(nter>(a</:<ter>>\(:_</b[>\~~[` repeated | 3,000 B / 12,000 B | 2.2 MB / 9.1 MB | from about 22 KB |

The closed inputs above produce exactly mfm-js's trees at both sizes. Closed
nesting up to the default limit outside quotes needs 13 bytes per input byte
or less, so it stays below the limit at any length.

Quotes cost more: every quote block (a run of lines starting with `>`) is
parsed as a separate string with its own table, at a fixed cost of about 500
bytes per block and nesting level. Long runs of short quote blocks therefore
reach the limit, after which the result differs from mfm-js's:

| Repeated unit | Memo storage per input byte | Limit reached from |
|---|---|---|
| `> a⏎⏎` | 101 B | about 166 KB |
| `>>a⏎⏎` | 201 B | about 83 KB |
| `>>>>>a⏎⏎` | 316 B | about 53 KB |
| `>>>>>>>>>> a⏎⏎` | 363 B | about 46 KB |
| 20 `>` and `a⏎⏎` | 440 B | about 38 KB |

At 3,000 bytes, the largest of these needs about 1.3 MB and the
pathological unit in the first table about 2.2 MB, far below the 16 MiB
limit; the 3,000-byte pathological inputs in `backtrack_test.go` also stay
below both limits.

The memo limit counts the memo tables only. The peak heap of a parse is about
three times the memo limit (measured: about 48 MB for 256 KiB and 745–774 MB
for 4 MiB of the pathological unit), so callers that parse untrusted input
should cap its length (Misskey limits a note to 3,000 characters).

### Differences from mfm-js 0.26.0

The trees are the same as mfm-js's for every case in `testdata/`, except the
ones listed in `knownDifferences` in [`parser_test.go`](parser_test.go)
(the test fails when an entry is no longer needed). The intentional differences:

1. **Nest limit cap.** `ParseWithNestLimit` lowers a limit above 1000 to 1000,
   because nesting is read by recursion. mfm-js itself overflows its stack on
   about 1,000 levels with the default Node.js stack. Covered by
   `testdata/differences.json`.
2. **Work and memory limits.** Once an input has used up the work or memo
   limit, every position that has not been parsed yet is read as a single
   plain character; results already in the memo are still used. Constructs
   that were open at that moment keep looking for their closing delimiter in
   that text, so the tree after the limit is not a prefix of mfm-js's tree:
   an open construct may close at a delimiter that mfm-js would have consumed
   inside a nested construct, giving nodes mfm-js does not produce, or fail
   and turn everything it read into text, which reaches back to the start of
   the input when the failing construct started there. Inputs reach the
   limits as listed in the tables above: the pathological unit beyond about
   22 KB, and runs of short quote blocks from about 38 to 166 KB. The
   fixtures in `testdata/` contain no input that reaches the limits; the
   behaviour after the limits is covered by `backtrack_test.go` and
   `memo_test.go`.
3. **Strings.** Invalid UTF-8 in the input is replaced with U+FFFD before
   parsing. A JavaScript string can hold an unpaired surrogate, which mfm-js
   keeps as a character; a Go string cannot, and decoding one from JSON or
   UTF-16 gives U+FFFD. The fixtures include such inputs, which compare equal
   once decoded.

Everything else follows mfm-js, including its quirks: for example `<center>`
must start and end a line, `**` children may span lines but `~~` ones may not,
an unclosed decoration turns everything it read into text, and `*a*` is italic
only when it follows neither an ASCII letter nor a digit.

## testdata

Every JSON file in `testdata/` (written with one case per line) has the shape

```json
{
  "generator": "tools/gen-testdata/gen.mjs",
  "mfmjs": "0.26.0",
  "emojiData": "17.0.0",
  "cases": [
    { "name": "syntax/…", "input": "**a**", "options": { "parser": "full" }, "output": [ … ] }
  ]
}
```

`options.parser` is `"full"` (`parse`) or `"simple"` (`parseSimple`), with an
optional `nestLimit`. `output` is mfm-js's result as JSON. `extract.json` holds
`hashtags`, `emojiCodes`, `customEmojis` and `customEmojisSimple` instead of
`output`.

| File | Cases |
|---|---|
| `syntax.json` | Every construct, its edge cases, both parsers |
| `regression.json` | Regression inputs: edge cases of every construct where a parser can easily differ from mfm-js, both parsers |
| `nest-limit.json` | Nesting under limits 0, 1, 2, 3 and 5 |
| `random.json` | Seeded random combinations of MFM fragments |
| `unicode-emoji.json` | Every entry of @misskey-dev/emoji-data 17.0.0 alone, doubled, before a search button, without U+FE0F and with U+FE0E |
| `differences.json` | Cases listed in `knownDifferences` |
| `extract.json` | The extraction helpers |

To regenerate (needs Node.js 22 or later):

```sh
cd tools
npm ci                            # installs mfm-js 0.26.0 into tools/node_modules
node gen-testdata/gen.mjs         # rewrites testdata/
node gen-testdata/gen.mjs --check # fails when testdata/ is stale (run in CI)
```

`tools/package.json` pins mfm-js 0.26.0 and @misskey-dev/emoji-data 17.0.0
as devDependencies (`package-lock.json` pins their contents); `pnpm install`
in `tools/` works as well. The script refuses any other
version of either package.

The Unicode emoji pattern of the Go parser (`emoji_regex_gen.go`) is
generated from the emoji regex of @misskey-dev/emoji-data, the one mfm-js
uses:

```sh
cd tools
go run ./emojiregex          # from tools/node_modules (npm or pnpm layout)
go run ./emojiregex -check   # fails when the generated file is stale
# or: go run ./emojiregex -node-modules /path/to/node_modules [-emoji-data /path/to/emoji-data]
#     (also MFM_NODE_MODULES / MFM_EMOJI_DATA)
```

## Development

```sh
gofmt -s -l .
go vet ./...
go test -race ./...
go test -run '^$' -fuzz=FuzzParse -fuzztime=30s -fuzzminimizetime=5s .
```

`ts/` has its own `go.mod`, which keeps it out of the Go module zip. The
TypeScript port is checked in `ts/` (the tests also read mfm-js 0.26.0 from
`tools/node_modules`, so run `npm ci` in `tools/` first):

```sh
cd ts
npm ci
npm run typecheck
npm test
npm run build
```

The test comparing running times (`TestParse_TimeGrowsLinearly`) is skipped
under `-race`, under `-short` and when `MFM_SKIP_TIMING` is set; the tests
counting work and memory always run. Fuzzing failures are saved under
`testdata/fuzz/FuzzParse/` and then run by `go test` as regression inputs.

CI (`.github/workflows/ci.yml`) runs the above with a coverage threshold of
90% and the timing test without `-race`, the tests of `tools/`, and the
freshness checks of `testdata/` and the emoji pattern.

## License

MIT, see [LICENSE](LICENSE). The generated emoji pattern and the fixtures
derive from third-party packages; see [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
