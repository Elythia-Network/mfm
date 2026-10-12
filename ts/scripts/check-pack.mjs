// Checks the files `npm pack` would publish against the expected list, so that
// a change to "files" or to the build cannot drop or add files unnoticed.
// Run after `npm run build` and `node scripts/copy-notices.mjs`.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
const modules = ['index', 'api', 'node', 'emoji-regex.gen', 'internal/memo', 'internal/parser'];
const expected = [
	'LICENSE',
	'README.md',
	'THIRD_PARTY_NOTICES',
	'package.json',
	...modules.flatMap((m) => [`built/${m}.js`, `built/${m}.d.ts`]),
].sort();

// prepackの出力がJSONに混ざらないよう、スクリプトは走らせない
const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: pkg, encoding: 'utf8' });
const actual = JSON.parse(out)[0].files.map((f) => f.path).sort();
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
	console.error('unexpected package contents');
	console.error('expected:', expected);
	console.error('actual:  ', actual);
	process.exit(1);
}
console.log(`package contents ok (${actual.length} files)`);
