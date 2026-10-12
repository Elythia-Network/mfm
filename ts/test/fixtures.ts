import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MfmNode } from '../src/index.js';

/** testdata/ at the repository root, shared with the Go parser. */
export const testdataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'testdata');

/** One case of a fixture file. */
export interface FixtureCase {
	name: string;
	input: string;
	options: { parser: 'full' | 'simple'; nestLimit?: number };
	output: MfmNode[];
	hashtags?: string[];
	emojiCodes?: string[];
	customEmojis?: string[];
	customEmojisSimple?: string[];
}

/** One JSON file of testdata/. */
export interface FixtureFile {
	generator: string;
	mfmjs: string;
	emojiData: string;
	cases: FixtureCase[];
}

/** The least number of cases each fixture file must hold (the same as the Go tests). */
export const minCases: Record<string, number> = {
	'syntax.json': 300,
	'regression.json': 1000,
	'nest-limit.json': 50,
	'random.json': 3500,
	'unicode-emoji.json': 5000,
	'differences.json': 1,
	'extract.json': 700,
};

/** Returns the names of the JSON files in testdata/. */
export function fixtureNames(): string[] {
	return readdirSync(testdataDir).filter((n) => n.endsWith('.json')).sort();
}

/** Reads one fixture file. */
export function loadFixture(name: string): FixtureFile {
	return JSON.parse(readFileSync(join(testdataDir, name), 'utf8')) as FixtureFile;
}
