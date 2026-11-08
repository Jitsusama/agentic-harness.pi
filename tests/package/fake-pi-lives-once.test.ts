/**
 * One fake pi, in `tests/support/fake-pi.ts`.
 *
 * Test files used to write their own stand-in for pi's extension API,
 * one apiece, and nearly fifty of them had. The copies drifted: some
 * kept what was appended to the session and some dropped it, some had
 * a bus and some did not, and two still said the pi package could not
 * be imported from a test after it could. When pi's API changed, each
 * copy was its own thing to find and fix, and each one a reader met
 * was a new fake to learn.
 *
 * So a test that wants one imports it, and a file that defines its own
 * fails here, naming where. A copy that has to do something the shared
 * one should not is listed with its reason instead of slipping through.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const TESTS = join(ROOT, "tests");

/** The one place a fake pi is defined. */
const HOME = join("tests", "support");

/**
 * Files that define a `fakePi` of their own, each with why.
 *
 * Named rather than matched, so that every exception is a decision
 * somebody wrote down rather than a pattern that grows on its own.
 */
const EXEMPT: Record<string, string> = {
	"tests/lib/internal/reload/load-check.test.ts":
		"Its fakePi is not the extension API at all but a pi executable, a script written to disk for the load check to spawn and talk to over stdin, so it only shares the name.",
};

/** A definition of `fakePi`, as a function or as a binding. */
const DEFINITION =
	/^\s*(?:export\s+)?(?:(?:async\s+)?function\s*\*?\s*fakePi\b|(?:const|let|var)\s+fakePi\b)/;

/** Every TypeScript file under `dir`, as paths from the repository root. */
function sourcesUnder(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry.startsWith(".")) continue;
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) found.push(...sourcesUnder(path));
		else if (/\.[cm]?ts$/.test(entry)) found.push(relative(ROOT, path));
	}
	return found;
}

/** Where each `fakePi` is defined, as `file:line`, by file. */
function definitions(): Map<string, string[]> {
	const found = new Map<string, string[]>();
	for (const file of sourcesUnder(TESTS)) {
		const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
		lines.forEach((line, index) => {
			if (!DEFINITION.test(line)) return;
			found.set(file, [...(found.get(file) ?? []), `${file}:${index + 1}`]);
		});
	}
	return found;
}

describe("the fake pi", () => {
	it("is defined where the tests' helpers live", () => {
		// A gate that finds nothing passes. This is the check that it
		// found the one it is guarding.
		const homes = [...definitions().keys()].filter((file) =>
			file.startsWith(`${HOME}/`),
		);
		expect(homes).toEqual([join(HOME, "fake-pi.ts")]);
	});

	it("is not defined again outside them", () => {
		const copies = [...definitions()]
			.filter(([file]) => !file.startsWith(`${HOME}/`))
			.filter(([file]) => EXEMPT[file] === undefined)
			.flatMap(([, where]) => where);

		expect(
			copies,
			"import fakePi from tests/support/fake-pi.ts instead, passing any member it lacks through overrides",
		).toEqual([]);
	});

	it("excuses only copies that are still there", () => {
		// An exemption that outlives its copy is a hole waiting for the
		// next one to walk through unremarked.
		const found = definitions();
		const stale = Object.keys(EXEMPT).filter((file) => !found.has(file));

		expect(stale).toEqual([]);
	});
});
