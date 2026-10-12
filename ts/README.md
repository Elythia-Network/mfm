# @elythia-network/mfm

A parser for MFM (Misskey Flavored Markdown) with the API of
[mfm-js](https://github.com/misskey-dev/mfm.js) 0.26.0: the same functions,
node types and trees, in time and memory linear in the length of the input.
It is the TypeScript port of the Go parser in the
[same repository](https://github.com/Elythia-Network/mfm); see the README
there for the design, the work and memory limits and the shared fixtures.

```sh
npm install @elythia-network/mfm
```

```ts
import * as mfm from '@elythia-network/mfm';

const nodes = mfm.parse('**Hello** :wave: #mfm @someone@example.com');
const simple = mfm.parseSimple('Name :custom_emoji:'); // for user names and the like
const hashtags = mfm.extract(nodes, (n) => n.type === 'hashtag');
```

The package is an ES module without dependencies. It needs Node.js 20 or
later or a browser that supports ES2022; on Node.js versions that can
`require()` ES modules (20.19 and 22.12 or later), `require` works as well.

## Replacing mfm-js

Every export of mfm-js 0.26.0 is exported under the same name with the same
type: `parse(input, { nestLimit })`, `parseSimple`, `toString`, `inspect`,
`extract`, `isMfmBlock`, the node types (`MfmNode`, `MfmBlock`, `MfmInline`,
`MfmSimpleNode`, `MfmText`, ... and `NodeType`) and the node constructors
(`TEXT`, `BOLD`, `N_URL`, ...). Replacing the import is enough:

```diff
-import * as mfm from 'mfm-js';
+import * as mfm from '@elythia-network/mfm';
```

The trees are equal to mfm-js's, including the key order of the node objects,
for every case of the shared fixtures and for random inputs compared with
mfm-js 0.26.0 in the tests. The differences:

1. **Nest limit cap.** A `nestLimit` above 500 is lowered to 500. Nesting is
   read by recursion: 1,000 levels need about 800 KB of stack before the code
   is optimized, close to V8's default of 984 KB, so the cap keeps a margin.
   The Go parser caps at 1000.
2. **Work and memory limits.** One call does at most `2^21 + 32 × length`
   units of work and keeps at most `max(16 MiB, 64 × length)` bytes of memo
   storage, where the length is in UTF-16 code units. After either runs out,
   the rest of the input is read as text, as described in the repository
   README. No input of the shared fixtures and none of the 3,000-character
   stress inputs in the tests reach the limits.

   The memo storage is a nominal count: it is charged with the sizes of the
   Go parser's structures (so that an ASCII input reaches the limit at the
   same point as in Go), not measured in the JavaScript heap. The heap a
   parse needs is larger: measured on Node.js 22 as the smallest
   `--max-old-space-size` with which the parse succeeds, the worst shape we
   tried (long runs of deeply nested quote blocks) needed about 330 MB for
   1,048,576 characters and about 1.3 GB for 4,194,304 characters, about
   five times the counted amount, while 3,000-character inputs needed at
   most about 11 MB in total (about 4 MB more than parsing plain text).
   Callers that parse untrusted input should cap its length (Misskey limits
   a note to 3,000 characters).

Strings are handled like mfm-js: positions are UTF-16 code units, and a lone
surrogate is kept as a character. `nestLimit` is read the way mfm-js
compares it: `undefined` and `null` give 20, a fraction is rounded up, `NaN`
and negative values act like 0.

## License

MIT. The emoji pattern derives from @misskey-dev/emoji-data, and the API and
the trees follow mfm-js; see THIRD_PARTY_NOTICES in the package.
