/**
 * googleapis' types are imported from each API's own module, never the
 * package's root.
 *
 * The root's declarations reach every Google API, 328 of them and 3.4
 * million lines. One `import type` from it made those three in four of
 * every line `tsc` read for this project: a cold typecheck of a worktree
 * held 3.3 GB at its peak on 22 November, while eight agents' worktrees
 * typechecked at once. Importing from `googleapis/build/src/apis/<api>`
 * reads only the API named. Loading the package at run time is
 * `lib/google/apis/client.ts`'s business and is not an import.
 */

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
	SOURCE_DIRS,
	sourceFiles,
} from "../../../scripts/ts-import-specifiers.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** The package whose root is not to be imported. */
const PACKAGE = "googleapis";

/** An import or re-export naming the package's root as its source. */
const ROOT_IMPORT = /\bfrom\s+["']googleapis["']/;

/**
 * Reading every source file, about 3,500 of them, took 9.2 s on a machine
 * at load 180 on 12 cores, past vitest's 5 s default. The walk is the
 * cost, not this rule, so the limit is widened rather than the walk cut.
 */
const WALK_TIMEOUT_MS = 30_000;

/** Where in `source` a line imports the package's root, as `file:line`. */
function rootImports(file: string, source: string): string[] {
	if (!ROOT_IMPORT.test(source)) return [];
	return source
		.split("\n")
		.flatMap((line, index) =>
			ROOT_IMPORT.test(line) ? [`${relative(ROOT, file)}:${index + 1}`] : [],
		);
}

describe("googleapis' types", () => {
	it(
		"come from each API's own module, never the package's root",
		() => {
			const offenders = sourceFiles(ROOT, [...SOURCE_DIRS, "host"]).flatMap(
				(file) => rootImports(file, readFileSync(file, "utf8")),
			);
			expect(offenders).toEqual([]);
		},
		WALK_TIMEOUT_MS,
	);

	it("name a root import when one is there", () => {
		const file = join(ROOT, "lib", "example.ts");
		// Built from a constant, so this file's own walk doesn't count it.
		const source = `import x from "y";\nimport type { G } from "${PACKAGE}";\n`;
		expect(rootImports(file, source)).toEqual(["lib/example.ts:2"]);
	});

	it("let a per-API import through", () => {
		const file = join(ROOT, "lib", "example.ts");
		const source =
			'import type { drive_v3 } from "googleapis/build/src/apis/drive";\n';
		expect(rootImports(file, source)).toEqual([]);
	});
});
