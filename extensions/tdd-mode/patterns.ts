/**
 * Test file and test runner detection patterns.
 */

/** File paths that indicate a test file. */
const TEST_FILE_PATTERNS = [
	/[._-](test|spec)\./i, // foo.test.ts, bar_spec.rb
	/\/__tests__\//, // __tests__/foo.ts
	/\/tests?\//, // test/foo.ts, tests/foo.ts
	/\/spec\//, // spec/foo.rb
];

export function isTestFile(filePath: string): boolean {
	return TEST_FILE_PATTERNS.some((p) => p.test(filePath));
}

/** Commands that look like running a test suite. */
const TEST_RUNNER_PATTERNS = [
	/\bjest\b/i,
	/\bvitest\b/i,
	/\bpytest\b/i,
	/\brspec\b/i,
	/\bmocha\b/i,
	/\bava\b/i,
	/\btap\b/i,
	/\bphpunit\b/i,
	/\bcargo\s+test\b/i,
	/\bgo\s+test\b/i,
	/\bdotnet\s+test\b/i,
	/\bgradle\s+test\b/i,
	/\bmvn\s+test\b/i,
	/\bmix\s+test\b/i,
	/\bnpm\s+t(est)?\b/i,
	/\byarn\s+test\b/i,
	/\bpnpm\s+test\b/i,
	/\bnpx\s+(jest|vitest|mocha)\b/i,
];

export function looksLikeTestRun(command: string): boolean {
	return TEST_RUNNER_PATTERNS.some((p) => p.test(command));
}
