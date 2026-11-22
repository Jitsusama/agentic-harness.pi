/**
 * googleapis is imported only for types, and only from one API's own
 * module.
 *
 * The package's root declarations reach every Google API, 328 of them
 * and 3.4 million lines, and so does any other entry above one API's
 * folder. One `import type` from the root made those three in four of
 * every line `tsc` read for this project: a cold typecheck of a worktree
 * held 3.3 GB at its peak on 22 November, while eight agents' worktrees
 * typechecked at once. `import type` from `googleapis/build/src/apis/<api>`
 * reads only the API named. A value import from there would load
 * googleapis' common code at pi's startup, which loading the package on
 * first use in `lib/google/apis/client.ts` exists to avoid; that load is
 * a `require` and is not an import.
 *
 * The walk covers what tsconfig.json's `include` names, `.mjs` and the
 * root's own `.ts` among them, since `checkJs` reads those too.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** The package's name, kept out of this file's own import-shaped text. */
const PACKAGE = "googleapis";

/** Folders tsconfig.json includes, walked whole. */
const DIRS = ["extensions", "host", "lib", "packs", "tests", "scripts"];

/** The files under them tsconfig.json includes. */
const SOURCE = /\.(ts|tsx|mts|mjs)$/;

/**
 * Each way source names a module: a static import or re-export (group 1
 * says whether it is type-only), an `import()` call or type query, and a
 * bare side-effect import. The specifier is the last group. A statement
 * is matched only where a line starts with it, so a comment mentioning an
 * import cannot run on into the statement below it.
 */
const SPECIFIERS = [
	/^[\t ]*(?:import|export)(\s+type)?\b[^;]*?\bfrom\s*["']([^"']+)["']/gm,
	/\bimport\s*\(\s*["']([^"']+)["']/g,
	/^[\t ]*import\s*["']([^"']+)["']/gm,
];

/** The one module a type may come from: a single API's folder. */
const ONE_API = new RegExp(`^${PACKAGE}/build/src/apis/[a-z0-9_]+$`);

/**
 * Reading every source file, about 3,500 of them, took 9.2 s on a machine
 * at load 180 on 12 cores, past vitest's 5 s default. The walk is the
 * cost, not this rule, so the limit is widened rather than the walk cut.
 */
const WALK_TIMEOUT_MS = 30_000;

/** Every file tsconfig.json includes, skipping node_modules. */
function includedFiles(): string[] {
	const files = readdirSync(ROOT)
		.filter((entry) => entry.endsWith(".ts"))
		.map((entry) => join(ROOT, entry));
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir)) {
			if (entry === "node_modules" || entry.startsWith(".")) continue;
			const path = join(dir, entry);
			if (statSync(path).isDirectory()) walk(path);
			else if (SOURCE.test(entry)) files.push(path);
		}
	};
	for (const dir of DIRS) {
		const path = join(ROOT, dir);
		if (existsSync(path)) walk(path);
	}
	return files;
}

/** Where `source` names googleapis other than for one API's types. */
function offences(file: string, source: string): string[] {
	if (!source.includes(PACKAGE)) return [];
	const found: string[] = [];
	for (const [index, pattern] of SPECIFIERS.entries()) {
		for (const match of source.matchAll(pattern)) {
			const specifier = match[match.length - 1] ?? "";
			if (specifier !== PACKAGE && !specifier.startsWith(`${PACKAGE}/`)) {
				continue;
			}
			const typeOnly = index === 0 && match[1] !== undefined;
			if (typeOnly && ONE_API.test(specifier)) continue;
			const start =
				match.index + (match[0].length - match[0].trimStart().length);
			const line = source.slice(0, start).split("\n").length;
			found.push(`${relative(ROOT, file)}:${line} ${specifier}`);
		}
	}
	return found;
}

describe("googleapis", () => {
	it(
		"is imported only for one API's types",
		() => {
			const found = includedFiles().flatMap((file) =>
				offences(file, readFileSync(file, "utf8")),
			);
			expect(found).toEqual([]);
		},
		WALK_TIMEOUT_MS,
	);

	const file = join(ROOT, "lib", "example.ts");

	it.each([
		["the root", `import type { G } from "${PACKAGE}";`],
		["a root re-export", `export type { G } from "${PACKAGE}";`],
		["the root's own path", `import type { G } from "${PACKAGE}/build/src";`],
		[
			"every API at once",
			`import type { A } from "${PACKAGE}/build/src/apis";`,
		],
		["a type query", `type G = typeof import("${PACKAGE}").google;`],
		[
			"a value import",
			`import { drive } from "${PACKAGE}/build/src/apis/drive";`,
		],
		["a side-effect import", `import "${PACKAGE}";`],
		[
			"a type import split over lines",
			`import type {\n\tG,\n} from\n\t"${PACKAGE}";`,
		],
	])("names %s", (_, line) => {
		expect(offences(file, `import x from "y";\n${line}\n`)).toHaveLength(1);
	});

	it("lets one API's types through", () => {
		const source = `import type { drive_v3 } from "${PACKAGE}/build/src/apis/drive";\n`;
		expect(offences(file, source)).toEqual([]);
	});

	it("names the line an import starts on", () => {
		const source = `import x from "y";\n\nimport type { G } from "${PACKAGE}";\n`;
		expect(offences(file, source)).toEqual([`lib/example.ts:3 ${PACKAGE}`]);
	});
});
