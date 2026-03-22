/**
 * Patterns for identifying test files by their path, so the
 * enforcement logic knows which writes to block during the
 * GREEN phase.
 */

/** File paths that indicate a test file. */
const TEST_FILE_PATTERNS = [
	/[._-](test|spec)\./i, // foo.test.ts, bar_spec.rb
	/\/__tests__\//, // __tests__/foo.ts
	/\/tests?\//, // test/foo.ts, tests/foo.ts
	/\/spec\//, // spec/foo.rb
];

/** Whether the file path matches common test file conventions. */
export function isTestFile(filePath: string): boolean {
	return TEST_FILE_PATTERNS.some((p) => p.test(filePath));
}
