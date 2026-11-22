/**
 * Loading the host program binds nothing from pi, so a host whose pi
 * install is missing is refused with exit 78 rather than failing on an
 * import.
 *
 * pi-host resolves pi's modules from PI_PACKAGE_DIR, through a hook it
 * registers before it imports the program. With that install gone, any
 * value imported from pi's scope anywhere in the program's static
 * graph fails the import itself, with exit 1 and a stack, before the
 * program's configuration check can refuse the install with
 * EXIT_MISCONFIGURED. A unit names that status in
 * RestartPreventExitStatus, so the difference is a host that waits for
 * a fix against one systemd restarts every few seconds. Kept history's
 * static import did exactly that on 22 November, and the test that
 * runs pi-host (tests/scripts/pi-host.test.ts) didn't catch it: it
 * imports nothing from host/, so `pnpm check`'s `vitest --changed`
 * never picks it for a change there.
 *
 * This file imports the program, so a change anywhere in its graph
 * picks it, and walks what loads from pi-host's entry: its static
 * imports and re-exports, and an `await import()` at a module's top
 * level, which runs as the module loads (pi-host loads the program so,
 * once its hook is in place). Each file is read as node runs it, with
 * its types stripped by node's own stripTypeScriptTypes, so a
 * type-only import is let through exactly when node erases it: `import
 * type` is, but `import { type A }` is left as `import {}`, which still
 * loads its module. An `import()` inside a function runs later, when
 * the function does, after the check, and is not followed. The walk
 * fails closed: a statement that loads a module in a way it can't read,
 * or a relative import of a file that isn't there, fails the test
 * rather than being passed over.
 */

import { existsSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT_MISCONFIGURED } from "../../../host/service/program.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** The scope pi-host's hook resolves from the host's own install. */
const PI_SCOPE = "@earendil-works/";

/** pi-host's entry. */
const ENTRY = "scripts/pi-host.ts";

/** What pi-host loads once its hook is registered, which the walk must reach. */
const LOADED_BY_ENTRY = ["host/service/program.ts", "host/service/run.ts"];

/**
 * A static import or re-export in type-stripped code, the specifier
 * group 2: `import "x"`, `import a, { b } from "x"`, `import * as a
 * from "x"`, `export { a } from "x"` and `export * from "x"`. Only
 * names, braces, commas and `*` may sit between the keyword and the
 * specifier, so a match never runs on into another statement, and an
 * `import(` call is left out.
 */
const STATIC = [
	/^[\t ]*import\s*(?!\()(?:[\w$*{},\s]+?\s*from\s*)?(["'])([^"']+)\1/gm,
	/^[\t ]*export\s*(?:\*(?:\s*as\s+[\w$]+)?|\{[\w$,\s]*\})\s*from\s*(["'])([^"']+)\1/gm,
];

/**
 * An `await import("x")` at a module's top level, the specifier group
 * 2. Biome formats a module's top level from the first column, so a
 * line that starts indented sits in a function and loads later.
 */
const AT_TOP = /^(?![\t ]).*?\bawait\s+import\(\s*(["'])([^"']+)\1\s*\)/gm;

/**
 * Where a statement that loads a module starts: `import`, but not
 * `import(` or `import.meta`, or an `export` that names a module with
 * `from`. Each must be where a STATIC match starts, or the walk can't
 * read it.
 */
const LOADS = /^[\t ]*(?:import\b(?!\s*[(.])|export\s*[*{][^;]*?\bfrom\b)/gm;

/** What a file loads as it loads, and the lines of statements it can't read. */
interface Loads {
	readonly specifiers: readonly string[];
	readonly unread: readonly number[];
}

/** What TypeScript code loads as it loads, once node strips its types. */
function loadsIn(source: string): Loads {
	// Stripping blanks types in place, so offsets and lines stay the source's.
	const code = stripTypeScriptTypes(source);
	const read = new Set<number>();
	const specifiers: string[] = [];
	for (const pattern of STATIC)
		for (const match of code.matchAll(pattern)) {
			read.add(match.index);
			specifiers.push(match[2] ?? "");
		}
	for (const match of code.matchAll(AT_TOP)) specifiers.push(match[2] ?? "");
	const unread = [...code.matchAll(LOADS)]
		.filter((match) => !read.has(match.index))
		.map((match) => code.slice(0, match.index).split("\n").length);
	return { specifiers, unread };
}

/** What the walk from pi-host's entry found. */
interface Walk {
	/** Each value from pi's scope bound at load, with the chain of files that reaches it. */
	readonly piBound: readonly string[];
	/** Each statement or relative import the walk couldn't follow, by file and line. */
	readonly unfollowed: readonly string[];
	/** Every file the walk reached. */
	readonly reached: ReadonlySet<string>;
}

/** Walk what loads from pi-host's entry as it loads. */
function walkFromEntry(): Walk {
	const piBound: string[] = [];
	const unfollowed: string[] = [];
	const reached = new Set<string>();
	const walk = (file: string, chain: string[]): void => {
		if (reached.has(file)) return;
		reached.add(file);
		const { specifiers, unread } = loadsIn(
			readFileSync(join(ROOT, file), "utf8"),
		);
		for (const line of unread) unfollowed.push(`${file}:${line}`);
		for (const specifier of specifiers) {
			if (specifier.startsWith(PI_SCOPE))
				piBound.push(`${[...chain, file].join(" → ")} → ${specifier}`);
			else if (specifier.startsWith(".")) {
				const next = relative(ROOT, join(ROOT, dirname(file), specifier));
				if (existsSync(join(ROOT, next))) walk(next, [...chain, file]);
				else unfollowed.push(`${file}: ${specifier} is not there`);
			}
		}
	};
	walk(ENTRY, []);
	return { piBound, unfollowed, reached };
}

describe("loading the host program", () => {
	it("binds nothing from pi, so a missing install is refused with exit 78", () => {
		expect(EXIT_MISCONFIGURED).toBe(78);
		const { piBound, unfollowed, reached } = walkFromEntry();
		expect(
			unfollowed,
			"write these as a plain import the walk reads, or name a file that is there",
		).toEqual([]);
		expect(LOADED_BY_ENTRY.filter((file) => !reached.has(file))).toEqual([]);
		expect(
			piBound,
			"import these after loadHostPi, with import() in a function, as the engine does kept history",
		).toEqual([]);
	});

	it("reads every spelling that loads a module, and none that doesn't", () => {
		const source = [
			'import type { A } from "type-only";',
			'import { type B } from "empty-named";',
			'import { type C, d } from "named";',
			'import e, { f } from "default";',
			'import * as g from "namespace";',
			'import "bare";',
			'import {\n\th,\n\ti,\n} from "wrapped";',
			'export { j } from "re-export";',
			'export * from "star";',
			'export * as k from "star-as";',
			'export type { L } from "type-re-export";',
			'export { type M } from "empty-re-export";',
			'const n = await import("at-top");',
			'const {\n\tp,\n} = await import("at-top-destructured");',
			'async function later() {\n\tawait import("later");\n}',
			"const here = import.meta.dirname;",
			'/** import { o } from "commented" */',
		].join("\n");
		const { specifiers, unread } = loadsIn(source);
		expect(unread).toEqual([]);
		expect([...specifiers].sort()).toEqual(
			[
				"empty-named",
				"named",
				"default",
				"namespace",
				"bare",
				"wrapped",
				"re-export",
				"star",
				"star-as",
				"empty-re-export",
				"at-top",
				"at-top-destructured",
			].sort(),
		);
	});

	it("fails on a statement that loads a module it can't read, by its line", () => {
		const source = [
			'import { a } from "read";',
			'import { /* why */ b } from "commented-braces";',
			'export { c, /* why */ d } from "commented-re-export";',
			"export { a };",
		].join("\n");
		const { specifiers, unread } = loadsIn(source);
		expect(specifiers).toEqual(["read"]);
		expect(unread).toEqual([2, 3]);
	});
});
