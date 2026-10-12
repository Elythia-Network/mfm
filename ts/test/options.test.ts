import { describe, expect, test } from 'vitest';
import { parse } from '../src/index.js';
import { DEFAULT_NEST_LIMIT, MAX_NEST_LIMIT, normalizeNestLimit } from '../src/internal/parser.js';

describe('nestLimit', () => {
	test('is read like mfm-js compares it', () => {
		expect(normalizeNestLimit(undefined)).toBe(DEFAULT_NEST_LIMIT);
		expect(normalizeNestLimit(null)).toBe(DEFAULT_NEST_LIMIT);
		expect(normalizeNestLimit(3)).toBe(3);
		// depth < 2.5 は depth < 3 と同じ
		expect(normalizeNestLimit(2.5)).toBe(3);
		expect(normalizeNestLimit(-1)).toBe(0);
		expect(normalizeNestLimit(-Infinity)).toBe(0);
		// depth < NaN はいつも偽
		expect(normalizeNestLimit(NaN)).toBe(0);
		expect(normalizeNestLimit('4')).toBe(4);
		expect(normalizeNestLimit(Infinity)).toBe(MAX_NEST_LIMIT);
		expect(normalizeNestLimit(MAX_NEST_LIMIT + 1)).toBe(MAX_NEST_LIMIT);
	});

	test('above the maximum is lowered to the maximum', () => {
		const d = MAX_NEST_LIMIT + 1;
		const input = '<b>'.repeat(d) + 'a' + '</b>'.repeat(d);
		const capped = JSON.stringify(parse(input, { nestLimit: MAX_NEST_LIMIT }));
		expect(JSON.stringify(parse(input, { nestLimit: 1e9 }))).toBe(capped);
		expect(JSON.stringify(parse(input, { nestLimit: MAX_NEST_LIMIT - 1 }))).not.toBe(capped);
	});
});
