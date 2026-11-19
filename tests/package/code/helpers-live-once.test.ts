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
 * A copy that has to stay is listed below, with the one helper its file
 * may keep and why, and the list fails once that file no longer holds
 * that helper, so it only shrinks.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/**
 * The endings of the files that hold the package's code: every kind of
 * TypeScript, and the JavaScript node and the browser run as it is,
 * which can hold a copy as well.
 */
const SOURCES = [".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs", ".jsx"];

/** Each helper's one home. */
const HOME: Record<string, string> = {
	isRecord: "lib/internal/record.ts",
	until: "tests/support/until.ts",
	fakePi: "tests/support/fake-pi.ts",
};

/**
 * Copies that stay outside their home: the file, the one helper it may
 * keep, and why. Any other helper defined there is a copy like any other.
 */
const EXEMPT: Record<
	string,
	{ readonly helper: string; readonly why: string }
> = {
	"lib/subagent/brief-breakpoint.ts": {
		helper: "isRecord",
		why: "A reviewer loads this file into its own process on every request, so it deliberately imports nothing and keeps its own isRecord rather than reaching into the library for one.",
	},
	"lib/subagent/runpi/assistant.mjs": {
		helper: "isRecord",
		why: "The subagent supervisor loads this file under node, and AGENTS.md says it stays .mjs, since node strips no types under node_modules. It imports nothing, and keeps its own isRecord, which unlike the library's lets an array through.",
	},
	"tests/lib/internal/reload/load-check.test.ts": {
		helper: "fakePi",
		why: "Its fakePi is not the extension API but a pi executable, a script written to disk for the load check to start, so it only shares the name.",
	},
};

/** Whether a definition is the one copy its file is exempt to keep. */
function exempt({ file, name }: Definition): boolean {
	return EXEMPT[file]?.helper === name;
}

/**
 * The definitions that are copies: outside their helper's home, and not
 * the one helper their file is exempt to keep.
 */
function copiesIn(definitions: readonly Definition[]): Definition[] {
	return definitions.filter(
		(definition) =>
			definition.file !== HOME[definition.name] && !exempt(definition),
	);
}

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

/**
 * Every file of the package's code, from git's own list of what it
 * tracks or would, so no folder can be left out of the search. A file
 * deleted but not yet committed is passed over.
 */
function sources(): string[] {
	return execFileSync(
		"git",
		[
			"ls-files",
			"-z",
			"--cached",
			"--others",
			"--exclude-standard",
			...SOURCES.map((ending) => `*${ending}`),
		],
		{ cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
	)
		.split("\0")
		.filter((file) => file !== "" && existsSync(join(ROOT, file)));
}

/**
 * Every definition of one of the helpers, by its name, in the package,
 * wherever it is. A copy under another name goes unseen.
 */
function definitions(files: readonly string[]): Definition[] {
	return files.flatMap((file) =>
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
	const read = sources();
	const found = definitions(read);

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
		const copies = copiesIn(found).map(
			({ file, line, name }) => `${file}:${line}: ${name}`,
		);
		expect(
			copies,
			`these files define their own copy: import it from its home (${Object.entries(
				HOME,
			)
				.map(([name, home]) => `${name} from ${home}`)
				.join(", ")}) instead:\n${copies.join("\n")}`,
		).toEqual([]);
	});

	it("are looked for in files of each ending the package holds", () => {
		// A search that skips an ending passes every copy in it, as the
		// .mts and .mjs files once were. Each of these endings, which the
		// package holds today, must reach at least one file.
		for (const ending of [".ts", ".mts", ".js", ".mjs"]) {
			expect(
				read.some((file) => file.endsWith(ending)),
				`no ${ending} file is read`,
			).toBe(true);
		}
	});

	it("let an exempt file keep only the helper it names", () => {
		// No exempt file holds a second helper today, so made-up
		// definitions stand in for one.
		for (const [file, { helper }] of Object.entries(EXEMPT)) {
			expect(copiesIn([{ file, line: 1, name: helper }])).toEqual([]);
			for (const other of Object.keys(HOME).filter((name) => name !== helper)) {
				expect(
					copiesIn([{ file, line: 1, name: other }]),
					`${file} may keep a copy of ${other}`,
				).toHaveLength(1);
			}
		}
	});

	it("keep no file exempt that no longer holds its copy", () => {
		const stale = Object.entries(EXEMPT)
			.filter(
				([file, { helper }]) =>
					!found.some(
						(definition) =>
							definition.file === file && definition.name === helper,
					),
			)
			.map(([file, { helper }]) => `${file}: ${helper}`);
		expect(
			stale,
			`exempt but holding no copy now; take them out of EXEMPT:\n${stale.join("\n")}`,
		).toEqual([]);
	});
});
