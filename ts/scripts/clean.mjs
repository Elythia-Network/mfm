// Removes the build output, so that files of deleted sources are not published.
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

rmSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'built'), { recursive: true, force: true });
