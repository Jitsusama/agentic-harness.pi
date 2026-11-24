/**
 * A thread started from source takes node's modules through
 * `process.getBuiltinModule`, never `require`.
 *
 * An eval worker takes its process's flags, so in a process started with
 * `--input-type=module`, as the host's own end-to-end runs start the
 * host, its source is a module and `require` isn't defined. The stop's
 * backstop was armed by no thread there until 23 November, and on 24
 * November the stores' checkpoint thread and the hold watch were found
 * the same way: each died at its first line in every end-to-end host,
 * while every live host, started from its file, ran them, so the tests
 * judged a host unlike the one that runs.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { packageFiles } from "./package-files.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** A worker made in the file. */
const WORKER = /\bnew Worker\(/;

/** A worker's program given as source, wherever its options say it. */
const EVAL = /\beval:\s*true\b/;

/**
 * What only a CommonJS program has: `require` by any name, builtin or
 * package, and the folder and file names node gives it. A module has
 * none of them, so a thread's source that says one dies there. The
 * whole file is read, since a program held as a string is no smaller
 * than its file, and a module's own code has no use for them either.
 */
const COMMONJS_ONLY = /\brequire\s*\(|\b__dirname\b|\b__filename\b/g;

/** The programs known to run as a thread's source, so the rule reads some. */
const KNOWN_THREADS = [
	"host/engine/checkpoints.ts",
	"host/service/hold-watch.ts",
	"lib/core/web/article.ts",
];

describe("threads started from source", () => {
	it("take node's modules through process.getBuiltinModule, never require", () => {
		const threads = packageFiles(ROOT)
			.filter((file) => file.endsWith(".ts") && !file.startsWith("tests/"))
			.map((file) => ({
				file,
				source: readFileSync(join(ROOT, file), "utf8"),
			}))
			.filter(({ source }) => WORKER.test(source) && EVAL.test(source));
		expect(
			threads.map(({ file }) => file),
			"the rule reads every program known to run as a thread's source",
		).toEqual(expect.arrayContaining(KNOWN_THREADS));
		const requiring = threads.flatMap(({ file, source }) =>
			[...source.matchAll(COMMONJS_ONLY)].map(
				(found) => `${file}: ${found[0]}`,
			),
		);
		expect(
			requiring,
			"a program a thread runs from source reaches node's modules through process.getBuiltinModule",
		).toEqual([]);
	});
});
