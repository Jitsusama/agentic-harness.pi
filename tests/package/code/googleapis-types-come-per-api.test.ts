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
 * The typecheck is the first guard: tsconfig.json's `paths` maps the
 * root and those entries to `lib/google/apis/googleapis-root.d.ts`, which
 * exports nothing, so a type taken from one fails `pnpm typecheck` on
 * every check. That catches it where this file would not run, since
 * `pnpm check` runs only the tests a changed file reaches. This file
 * checks that the mapping is still there, and catches what `paths`
 * cannot: `/// <reference types>`, `declare module`, and a path into
 * `node_modules` itself.
 *
 * It runs the other way round from a list of bad spellings, since tsc
 * honours more of those than a list keeps up with. Every quoted
 * specifier naming googleapis is an offence unless it is one of two
 * things:
 *
 * - A type-only import from one API's folder, or one of its versions,
 *   under `googleapis/build/src/apis`: `import type`, `export type`, a
 *   JSDoc `@import`, or an `import()` as a `.mjs` names a type. A static
 *   value import from there would load googleapis' common code at pi's
 *   startup.
 * - The `require` in `lib/google/apis/client.ts`, which loads the
 *   package on first use and is typed by hand.
 *
 * The files walked are the ones tsconfig.json's `include` names, read
 * from it, with the declaration files beside them that tsc prefers to
 * a `.mjs`. A `paths` alias or a package.json `imports` entry spelled
 * otherwise would get past it; the typecheck still reads those, and
 * writing one is a choice, not a slip.
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

/**
 * A specifier naming the package, its root, a path under it, or a path
 * into `node_modules` that reaches it: quoted anywhere, or a template in
 * an `import()`. The specifier is group 2.
 */
const NAMED = [
	new RegExp(
		`(["'])((?:[^"'\\s]*node_modules/)?${PACKAGE}(?:/[^"'\\s]*)?)\\1`,
		"g",
	),
	new RegExp(
		`\\bimport\\s*\\(\\s*(\`)((?:[^\`\\s]*node_modules/)?${PACKAGE}[^\`]*)\``,
		"g",
	),
];

/**
 * The forms that only ever name types: a type-only static import or
 * re-export, a JSDoc `@import`, and an `import()` call or type query,
 * which at worst loads one API on first use. The specifier is group 2.
 */
const TYPE_ONLY = [
	/^[\t ]*(?:import|export)\s+type\b[^;]*?\bfrom\s*(["'])([^"']+)\1/gm,
	/@import\b[^*]*?\bfrom\s*(["'])([^"']+)\1/g,
	/\bimport\s*\(\s*(["'])([^"']+)\1/g,
];

/**
 * One API's folder, or one version's module in it (`v3`, `v3.5`,
 * `v1alpha1`) or its index; never `apis/index`, which is every API.
 */
const ONE_API = new RegExp(
	`^${PACKAGE}/build/src/apis/(?!index$)\\w+(?:/(?:v[\\w.]*\\w|index))?$`,
);

/** What tsconfig.json maps to the stub, so a type from one fails tsc. */
const STUBBED = [
	PACKAGE,
	`${PACKAGE}/build/src`,
	`${PACKAGE}/build/src/index`,
	`${PACKAGE}/build/src/googleapis`,
	`${PACKAGE}/build/src/apis`,
	`${PACKAGE}/build/src/apis/index`,
];

/** The stub those entries map to. */
const STUB = "./lib/google/apis/googleapis-root.d.ts";

/** The declaration files tsc reads beside a source file it includes. */
const DECLARATION = /\.d\.[cm]?ts$/;

/** What the failure says, so whoever meets it knows the way out. */
const WHY =
	"googleapis' root, and any entry above one API's folder, reaches all 328 " +
	"APIs' types; take a type from googleapis/build/src/apis/<api> instead, " +
	"with import type, or a JSDoc @import in a .mjs";

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
			else if (entry.endsWith(extension) || DECLARATION.test(entry)) {
				files.push(path);
			}
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
	for (const pattern of TYPE_ONLY) {
		for (const match of source.matchAll(pattern)) {
			const specifier = match[2] ?? "";
			if (ONE_API.test(specifier)) {
				allowed.add(match.index + match[0].length - specifier.length - 2);
			}
		}
	}
	if (name === LOADER.file) {
		const at = source.indexOf(LOADER.call);
		if (at !== -1) allowed.add(at + "require(".length);
	}
	const found = new Map<number, string>();
	for (const pattern of NAMED) {
		for (const match of source.matchAll(pattern)) {
			const specifier = match[2] ?? "";
			const at = match.index + match[0].length - specifier.length - 2;
			if (allowed.has(at)) continue;
			const line = source.slice(0, at).split("\n").length;
			found.set(at, `${name}:${line} ${specifier}`);
		}
	}
	return [...found.values()];
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
		expect(files).toContain(join("lib", "subagent", "runpi", "journal.d.mts"));
	});

	it("has the typecheck read nothing for the root", () => {
		const { compilerOptions } = JSON.parse(
			readFileSync(join(ROOT, "tsconfig.json"), "utf8"),
		) as { compilerOptions: { paths: Record<string, string[]> } };
		for (const entry of STUBBED) {
			expect(compilerOptions.paths[entry], entry).toEqual([STUB]);
		}
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
		["a template import", `type G = typeof import(\`${PACKAGE}\`);`],
		[
			"a path into node_modules",
			`import type { G } from "../../node_modules/${PACKAGE}";`,
		],
		[
			"one API by way of node_modules",
			`import type { D } from "../node_modules/${deep}/drive";`,
		],
		["a climb out of one API", `import type { A } from "${deep}/drive/..";`],
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
		["a dotted version", `import type { d } from "${deep}/dfareporting/v3.5";`],
		["a JSDoc import", `/** @import { drive_v3 } from "${deep}/drive" */`],
		["a type query", `type D = typeof import("${deep}/drive").drive;`],
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
