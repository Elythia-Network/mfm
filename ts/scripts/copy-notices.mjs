// Copies the license files of the repository into the package before
// `npm pack` / `npm publish`, which only include files under ts/.
import { copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES']) {
	copyFileSync(join(pkg, '..', name), join(pkg, name));
}
