/**
 * googleapis is named only for one API's types, and once to load it.
 *
 * The package's root declarations reach every Google API, 328 of them
 * and 3.4 million lines, and so does every entry above one API's folder,
 * `apis/index` among them. One `import type` from the root made those
 * three in four of every line `tsc` read for this project: a cold
 * typecheck of a worktree held 3.3 GB at its peak on 22 November, while
 * eight agents' worktrees typechecked at once.
 *
 * So the rule runs the other way round from a list of bad spellings,
 * since tsc honours more of those than a list keeps up with (a type
 * query, `/// <reference types>`, a JSDoc `@import`, `declare module`).
 * Every quoted specifier naming googleapis is an offence unless it is
 * one of two things:
 *
 * - `import type` or `export type` from one API's folder, or one of its
 *   versions, under `googleapis/build/src/apis`. A value import from
 *   there would load googleapis' common code at pi's startup.
 * - The `require` in `lib/google/apis/client.ts`, which loads the
 *   package on first use and is typed by hand.
 *
 * The files walked are the ones tsconfig.json's `include` names, read
 * from it, so `.mjs` and the root's own `.ts` are covered as `checkJs`
 * covers them.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** The package's name. */
const PACKAGE = "googleapis";

/** This file, which names the package to say what the rule is. */
const SELF = relative(ROOT, import.meta.filename);

/** The one file that loads the package, and how it does. */
const LOADER = {
	file: join("lib", "google", "apis", "client.ts"),
	call: `require("${PACKAGE}")`,
};

/** A quoted specifier naming the package, its root or any path under it. */
const NAMED = new RegExp(`["'](${PACKAGE}(?:/[^"'\\s]*)?)["']`, "g");

/** A type-only static import or re-export, with its specifier last. */
const TYPE_ONLY =
	/^[\t ]*(?:import|export)\s+type\b[^;]*?\bfrom\s*(["'])([^"']+)\1/gm;

/** One API's folder, or one version's module in it; never `apis/index`. */
const ONE_API = new RegExp(
	`^${PACKAGE}/build/src/apis/(?!index$)[A-Za-z0-9_]+(?:/[A-Za-z0-9_]+)?$`,
);

/** What the failure says, so whoever meets it knows the way out. */
const WHY =
	"googleapis' root, and any entry above one API's folder, reaches all 328 " +
	"APIs' types; import type from googleapis/build/src/apis/<api> instead";

/**
 * Reading every source file, about 3,500 of them, took 9.2 s on a machine
 * at load 180 on 12 cores, past vitest's 5 s default. The walk is the
 * cost, not this rule, so the limit is widened rather than the walk cut.
 */
const WALK_TIMEOUT_MS = 30_000;

/** A folder walked whole for one extension, or the root's own files. */
const INCLUDE_GLOB = /^(?:([\w.-]+)\/\*\*\/)?\*(\.\w+)$/;

/** Every file tsconfig.json's `include` names, skipping node_modules. */
function includedFiles(): string[] {
	const { include } = JSON.parse(
		readFileSync(join(ROOT, "tsconfig.json"), "utf8"),
	) as { include: string[] };
	const files: string[] = [];
	const walk = (dir: string, extension: string): void => {
		for (const entry of readdirSync(dir)) {
			if (entry === "node_modules" || entry.startsWith(".")) continue;
			const path = join(dir, entry);
			if (statSync(path).isDirectory()) walk(path, extension);
			else if (entry.endsWith(extension)) files.push(path);
		}
	};
	for (const glob of include) {
		const shape = INCLUDE_GLOB.exec(glob);
		if (!shape) throw new Error(`tsconfig include "${glob}" isn't read here`);
		const [, dir, extension = ""] = shape;
		if (dir === undefined) {
			for (const entry of readdirSync(ROOT)) {
				if (entry.endsWith(extension)) files.push(join(ROOT, entry));
			}
		} else if (existsSync(join(ROOT, dir))) {
			walk(join(ROOT, dir), extension);
		}
	}
	return files;
}

/** Where `source` names googleapis other than in the two ways allowed. */
function offences(file: string, source: string): string[] {
	if (!source.includes(PACKAGE)) return [];
	const name = relative(ROOT, file);
	const allowed = new Set<number>();
	for (const match of source.matchAll(TYPE_ONLY)) {
		const specifier = match[2] ?? "";
		if (ONE_API.test(specifier)) {
			allowed.add(match.index + match[0].length - specifier.length - 2);
		}
	}
	if (name === LOADER.file) {
		const at = source.indexOf(LOADER.call);
		if (at !== -1) allowed.add(at + "require(".length);
	}
	const found: string[] = [];
	for (const match of source.matchAll(NAMED)) {
		if (allowed.has(match.index)) continue;
		const line = source.slice(0, match.index).split("\n").length;
		found.push(`${name}:${line} ${match[1]}`);
	}
	return found;
}

describe("googleapis", () => {
	it(
		"is named only for one API's types, and once to load it",
		() => {
			const found = includedFiles()
				.filter((file) => relative(ROOT, file) !== SELF)
				.flatMap((file) => offences(file, readFileSync(file, "utf8")));
			expect(found, WHY).toEqual([]);
		},
		WALK_TIMEOUT_MS,
	);

	it("walks the files tsconfig includes, .mjs and the root's .ts among them", () => {
		const files = includedFiles().map((file) => relative(ROOT, file));
		expect(files).toContain("vitest.config.ts");
		expect(files).toContain(LOADER.file);
		expect(files.some((file) => file.endsWith(".mjs"))).toBe(true);
	});

	const file = join(ROOT, "lib", "example.ts");
	const deep = `${PACKAGE}/build/src/apis`;

	it.each([
		["the root", `import type { G } from "${PACKAGE}";`],
		["a root re-export", `export type { G } from "${PACKAGE}";`],
		["the root's own path", `import type { G } from "${PACKAGE}/build/src";`],
		["every API at once", `import type { A } from "${deep}";`],
		["every API's index", `import type { A } from "${deep}/index";`],
		["a type query", `type G = typeof import("${PACKAGE}").google;`],
		["a value import", `import { drive } from "${deep}/drive";`],
		["a side-effect import", `import "${PACKAGE}";`],
		["a reference", `/// <reference types="${PACKAGE}" />`],
		["a JSDoc import", `/** @import { G } from "${PACKAGE}" */`],
		["an augmentation", `declare module "${PACKAGE}" {}`],
		["a require elsewhere", `const g = require("${PACKAGE}");`],
		[
			"a type import split over lines",
			`import type {\n\tG,\n} from\n\t"${PACKAGE}";`,
		],
	])("names %s", (_, line) => {
		expect(offences(file, `import x from "y";\n${line}\n`)).toHaveLength(1);
	});

	it.each([
		["one API", `import type { drive_v3 } from "${deep}/drive";`],
		["one camelCase API", `import type { s } from "${deep}/siteVerification";`],
		["one API's version", `export type { drive_v3 } from "${deep}/drive/v3";`],
	])("lets %s's types through", (_, line) => {
		expect(offences(file, `${line}\n`)).toEqual([]);
	});

	it("lets the client load the package", () => {
		const loader = join(ROOT, LOADER.file);
		expect(offences(loader, `const g = ${LOADER.call};\n`)).toEqual([]);
	});

	it("names the line the specifier is on", () => {
		const source = `import x from "y";\n\nimport type { G } from "${PACKAGE}";\n`;
		expect(offences(file, source)).toEqual([`lib/example.ts:3 ${PACKAGE}`]);
	});
});
