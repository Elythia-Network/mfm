// Generates the shared test fixtures in testdata/ by running mfm-js, the
// reference implementation, on every input.
//
// Usage (from tools/, after `npm ci`):
//
//	node gen-testdata/gen.mjs          # rewrite testdata/*.json
//	node gen-testdata/gen.mjs --check  # fail when testdata/ is stale
//
// Every fixture file (one case per line) has the shape
//
//	{ "generator", "mfmjs", "emojiData", "cases": [ case... ] }
//
// and every case is
//
//	{ "name", "input", "options": { "parser": "full" | "simple", "nestLimit"? }, "output" }
//
// where output is the JSON of mfm-js's parse / parseSimple result. A case of
// extract.json has "hashtags", "emojiCodes", "customEmojis" and
// "customEmojisSimple" instead of "output".
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import * as mfm from 'mfm-js';

const MFMJS_VERSION = '0.26.0';
const EMOJI_DATA_VERSION = '17.0.0';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const testdata = join(root, 'testdata');
const require = createRequire(import.meta.url);

// Pinned versions: the fixtures are the output of exactly these packages.
// package.jsonはexportsに無いので、入口の場所から辿る
const packageJSON = (name) => JSON.parse(readFileSync(join(dirname(require.resolve(name)), '..', 'package.json'), 'utf8'));
const mfmjsPkg = packageJSON('mfm-js');
const emojiDataPkg = packageJSON('@misskey-dev/emoji-data');
if (mfmjsPkg.version !== MFMJS_VERSION) {
	throw new Error(`mfm-js ${MFMJS_VERSION} is required, ${mfmjsPkg.version} is installed`);
}
if (emojiDataPkg.version !== EMOJI_DATA_VERSION) {
	throw new Error(`@misskey-dev/emoji-data ${EMOJI_DATA_VERSION} is required, ${emojiDataPkg.version} is installed`);
}
const emojiList = require('@misskey-dev/emoji-data/emojilist.json');

function caseName(prefix, input, options) {
	const h = createHash('sha256').update(JSON.stringify([input, options])).digest('hex').slice(0, 12);
	return `${prefix}/${h}`;
}

function run(input, options) {
	if (options.parser === 'simple') return mfm.parseSimple(input);
	return options.nestLimit === undefined ? mfm.parse(input) : mfm.parse(input, { nestLimit: options.nestLimit });
}

// The Go parser lowers nestLimit to this value (MaxNestLimit).
const GO_MAX_NEST_LIMIT = 1000;

// Cases where the Go parser intentionally differs from mfm-js. Each one is
// listed in knownDifferences of parser_test.go and in the README.
function differenceInputs() {
	const depth = GO_MAX_NEST_LIMIT + 1;
	return [{ input: '<b>'.repeat(depth) + 'x' + '</b>'.repeat(depth), options: { parser: 'full', nestLimit: GO_MAX_NEST_LIMIT + 50 } }];
}

// runDeep runs the cases in a worker with a large stack: mfm-js recurses a few
// frames per nesting level and overflows the default stack on 1,000 levels.
function runDeep(cases) {
	return new Promise((resolve, reject) => {
		const worker = new Worker(fileURLToPath(import.meta.url), { workerData: cases, resourceLimits: { stackSizeMb: 256 } });
		worker.once('message', resolve);
		worker.once('error', reject);
	});
}

if (!isMainThread) {
	parentPort.postMessage(workerData.map((c) => ({ ...c, output: run(c.input, c.options) })));
}

function readInputs(file) {
	return JSON.parse(readFileSync(join(here, 'inputs', file), 'utf8'));
}

function unique(list) {
	return [...new Set(list)];
}

function fixture(cases) {
	return {
		generator: 'tools/gen-testdata/gen.mjs',
		mfmjs: MFMJS_VERSION,
		emojiData: EMOJI_DATA_VERSION,
		cases,
	};
}

function parseCases(prefix, inputs, optionsList) {
	const cases = [];
	for (const input of unique(inputs)) {
		for (const options of optionsList) {
			cases.push({ name: caseName(prefix, input, options), input, options, output: run(input, options) });
		}
	}
	return cases;
}

const FULL = { parser: 'full' };
const SIMPLE = { parser: 'simple' };

// mulberry32: a small seeded PRNG, so that the random cases are reproducible.
function prng(seed) {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// Fragments the random inputs are made of: every opening and closing mark,
// the characters the rules look at around them, and plain text.
const FRAGMENTS = [
	'<b>', '</b>', '<i>', '</i>', '<s>', '</s>', '<small>', '</small>', '<center>', '</center>',
	'<plain>', '</plain>', '**', '***', '*', '__', '_', '~~', '`', '´', '\\(', '\\)', '\\[', '\\]',
	'$[', '$[x ', '$[x.a=1 ', '$[fg.color=f00,b ', ']', '[', '?[', '](', ')', '(', '「', '」',
	'https://e.x/a', 'http://e.x', '<https://e.x/日本>', '<', '>', '> ', '@a', '@a@h.x', '@', '#t', '#', '#1',
	':e:', ':', '😀', '👍🏽', '1️⃣', '#️⃣', '‍', '️', '　', ' ', '\t', '\n', '\r\n', '\r',
	'```', '```js\n', '検索', ' search', ' 検索', 'a', 'x', '1', 'あ', '-', '.', ',', '!', "'",
];

function randomInputs(count, seed, maxFragments) {
	const rand = prng(seed);
	const out = [];
	for (let i = 0; i < count; i++) {
		const n = 1 + Math.floor(rand() * maxFragments);
		let s = '';
		for (let j = 0; j < n; j++) s += FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)];
		out.push(s);
	}
	return out;
}

// Inputs whose result depends on the nest limit.
const NESTING = [
	'<b><b><b>a</b></b></b>',
	'**<i>~~a~~</i>**',
	'$[x $[y $[z a]]]',
	'> > > a',
	'>>> a\n>> b\n> c',
	'<center><b>a</b></center>',
	'[<b><i>a</i></b>](https://e.x)',
	'#a((b))',
	'#a(b)',
	'https://e.x/((a))',
	'https://e.x/(a)',
	'<b>:e: #t @u</b>',
	'<b>**a',
	'<small><small>a</small>',
];

function emojiInputs() {
	const out = [];
	for (const [emoji] of emojiList) {
		const cps = [...emoji];
		out.push(emoji, emoji + emoji, `${emoji} 検索`, emoji.replaceAll('️', ''));
		out.push(cps[0] + '︎' + cps.slice(1).join(''));
	}
	return out;
}

function extractCases(inputs) {
	const names = (nodes, pred, key) => unique(mfm.extract(nodes, pred).map((n) => n.props[key]));
	const isEmoji = (n) => n.type === 'emojiCode';
	return unique(inputs).map((input) => {
		const full = mfm.parse(input);
		const simple = mfm.parseSimple(input);
		// customEmojisはMisskeyのextractCustomEmojisFromMfmと同じく名前の長さ100以下だけを数える
		const short = (n) => isEmoji(n) && n.props.name.length <= 100;
		return {
			name: caseName('extract', input, {}),
			input,
			hashtags: names(full, (n) => n.type === 'hashtag', 'hashtag'),
			emojiCodes: names(full, isEmoji, 'name'),
			customEmojis: names(full, short, 'name'),
			customEmojisSimple: names(simple, short, 'name'),
		};
	});
}

// serialize writes a fixture compactly with one case per line, so that the
// files stay small and a regenerated file diffs case by case.
function serialize(data) {
	const { cases, ...header } = data;
	const head = JSON.stringify(header).slice(0, -1);
	return `${head},"cases":[\n${cases.map((c) => JSON.stringify(c)).join(',\n')}\n]}\n`;
}

async function build() {
	const regression = readInputs('regression.json');
	const syntax = readInputs('syntax.json');
	const differences = await runDeep(differenceInputs().map((c) => ({ name: caseName('differences', c.input, c.options), ...c })));
	const files = {
		'syntax.json': fixture(parseCases('syntax', syntax, [FULL, SIMPLE])),
		'regression.json': fixture(parseCases('regression', regression, [FULL, SIMPLE])),
		'nest-limit.json': fixture(parseCases('nest', NESTING, [0, 1, 2, 3, 5].map((nestLimit) => ({ parser: 'full', nestLimit })))),
		'random.json': fixture([
			...parseCases('random', randomInputs(3000, 3512, 8), [FULL]),
			...parseCases('random-long', randomInputs(500, 20261012, 24), [FULL]),
			...parseCases('random-simple', randomInputs(500, 7, 8), [SIMPLE]),
		]),
		'unicode-emoji.json': fixture(parseCases('emoji', emojiInputs(), [FULL])),
		'differences.json': fixture(differences),
		'extract.json': fixture(extractCases([...readInputs('extract.json'), ...syntax, ...regression])),
	};
	return Object.fromEntries(Object.entries(files).map(([name, data]) => [name, serialize(data)]));
}

if (isMainThread) await main();

async function main() {
const check = process.argv.includes('--check');
const files = await build();
let stale = [];
for (const [name, content] of Object.entries(files)) {
	const path = join(testdata, name);
	if (check) {
		let current = null;
		try {
			current = readFileSync(path, 'utf8');
		} catch {}
		if (current !== content) stale.push(name);
	} else {
		writeFileSync(path, content);
	}
}
if (check) {
	const known = new Set(Object.keys(files));
	stale = stale.concat(readdirSync(testdata).filter((f) => f.endsWith('.json') && !known.has(f)).map((f) => `${f} (not generated)`));
	if (stale.length > 0) {
		console.error(`testdata is stale: ${stale.join(', ')}; run \`npm run gen-testdata\` in tools/`);
		process.exit(1);
	}
	console.log(`testdata is up to date (mfm-js ${MFMJS_VERSION})`);
} else {
	const total = Object.values(files).reduce((n, c) => n + JSON.parse(c).cases.length, 0);
	console.log(`wrote ${Object.keys(files).length} files, ${total} cases (mfm-js ${MFMJS_VERSION})`);
}
}
