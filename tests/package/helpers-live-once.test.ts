/**
 * The package's small helpers live in one place each.
 *
 * `isRecord` says whether a parsed value has fields to read by name,
 * `until` waits for a condition in a test instead of sleeping for a
 * guess, and `fakePi` stands in for pi's extension API in a test. Each is
 * short, so each was written again wherever it was wanted, and the
 * quality audit found the copies had drifted: some let an array through
 * as a record, some waits gave up without saying what they had waited
 * for, and some fakes kept what was appended to the session while others
 * dropped it. A fix made to one copy reached none of the others. So each
 * has one home, named in HOME below, and every other file imports it
 * from there.
 *
 * Only a definition counts: a function of the name, or a constant of the
 * name holding a function. A constant holding a deadline, as a polling
 * loop's `const until = Date.now() + ms` does, is a moment and not a
 * second helper, so it is left alone.
 *
 * A copy that has to stay is listed below, with why, and the list fails
 * once that file no longer holds one, so it only shrinks.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");

/** The folders that hold the package's TypeScript. */
const SEARCHED = ["lib", "extensions", "packs", "tests", "scripts"];

/** Folders that are not the package's own: tools' output and checkouts. */
const SKIPPED = new Set(["node_modules", "dist", "coverage"]);

/** Each helper's one home. */
const HOME: Record<string, string> = {
	isRecord: "lib/internal/record.ts",
	until: "tests/support/until.ts",
	fakePi: "tests/support/fake-pi.ts",
};

/** Copies that stay outside their home, each with why. */
const EXEMPT: Record<string, string> = {
	"lib/subagent/brief-breakpoint.ts":
		"A reviewer loads this file into its own process on every request, so it deliberately imports nothing and keeps its own isRecord rather than reaching into the library for one.",
	"tests/lib/internal/reload/load-check.test.ts":
		"Its fakePi is not the extension API but a pi executable, a script written to disk for the load check to start, so it only shares the name.",
};

/** A line that defines a helper by name, as a function or a function constant. */
const DEFINES = new RegExp(
	[
		String.raw`^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*(isRecord|until|fakePi)\b`,
		String.raw`^\s*(?:export\s+)?(?:const|let|var)\s+(isRecord|until|fakePi)\b\s*(?::[^=]*)?=\s*(?:async\b|function\b|\(|[A-Za-z_$][\w$]*\s*=>)`,
	].join("|"),
);

/** A definition of a helper: the file, its line and the helper's name. */
interface Definition {
	readonly file: string;
	readonly line: number;
	readonly name: string;
}

function sourcesUnder(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (entry.startsWith(".") || SKIPPED.has(entry)) continue;
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) found.push(...sourcesUnder(path));
		else if (entry.endsWith(".ts")) found.push(relative(ROOT, path));
	}
	return found;
}

/** Every definition of either helper in the package, wherever it is. */
function definitions(): Definition[] {
	return SEARCHED.flatMap((folder) => sourcesUnder(join(ROOT, folder))).flatMap(
		(file) =>
			readFileSync(join(ROOT, file), "utf8")
				.split("\n")
				.flatMap((text, index): Definition[] => {
					const match = DEFINES.exec(text);
					const name = match?.[1] ?? match?.[2];
					return name === undefined ? [] : [{ file, line: index + 1, name }];
				}),
	);
}

describe("the package's small helpers", () => {
	const found = definitions();

	it("are each defined in their home", () => {
		// A matcher that finds nothing passes everything. This is the check
		// that it finds the copies it is meant to.
		for (const [name, home] of Object.entries(HOME)) {
			expect(found).toContainEqual(
				expect.objectContaining({ file: home, name }),
			);
		}
	});

	it("are defined nowhere else", () => {
		const copies = found
			.filter(({ file, name }) => file !== HOME[name] && !(file in EXEMPT))
			.map(({ file, line, name }) => `${file}:${line}: ${name}`);
		expect(
			copies,
			`these files define their own copy: import it from its home (${Object.entries(
				HOME,
			)
				.map(([name, home]) => `${name} from ${home}`)
				.join(", ")}) instead:\n${copies.join("\n")}`,
		).toEqual([]);
	});

	it("keep no file exempt that no longer holds a copy", () => {
		const stale = Object.keys(EXEMPT).filter(
			(file) => !found.some((definition) => definition.file === file),
		);
		expect(
			stale,
			`exempt but holding no copy now; take them out of EXEMPT:\n${stale.join("\n")}`,
		).toEqual([]);
	});
});
