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
 * picks it, and walks the static imports from pi-host's entry and the
 * two modules it imports once the hook is in place. Each file is read
 * as node runs it, with its types stripped by node's own
 * stripTypeScriptTypes, so a type-only import is let through exactly
 * when node erases it: `import type` is, but `import { type A }` is
 * left as `import {}`, which still loads its module. What a module
 * imports with `import()` loads later, after the check, and is not
 * followed.
 */

import { existsSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT_MISCONFIGURED } from "../../../host/service/program.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** The scope pi-host's hook resolves from the host's own install. */
const PI_SCOPE = "@earendil-works/";

/** pi-host's entry, and what it imports once its hook is registered. */
const ENTRIES = [
	"scripts/pi-host.ts",
	"host/service/program.ts",
	"host/service/run.ts",
];

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

/** What TypeScript code imports statically once node strips its types. */
function importsIn(source: string): string[] {
	const code = stripTypeScriptTypes(source);
	return STATIC.flatMap((pattern) =>
		[...code.matchAll(pattern)].map((match) => match[2] ?? ""),
	);
}

/**
 * Every value from pi's scope the entries' static graph imports, each
 * with the chain of files that reaches it from an entry.
 */
function piBoundAtLoad(): string[] {
	const found: string[] = [];
	const seen = new Set<string>();
	const walk = (file: string, chain: string[]): void => {
		if (seen.has(file)) return;
		seen.add(file);
		for (const specifier of importsIn(readFileSync(join(ROOT, file), "utf8"))) {
			if (specifier.startsWith(PI_SCOPE))
				found.push(`${[...chain, file].join(" → ")} → ${specifier}`);
			else if (specifier.startsWith(".")) {
				const next = relative(ROOT, join(ROOT, dirname(file), specifier));
				if (existsSync(join(ROOT, next))) walk(next, [...chain, file]);
			}
		}
	};
	for (const entry of ENTRIES) walk(entry, []);
	return found;
}

describe("loading the host program", () => {
	it("binds nothing from pi, so a missing install is refused with exit 78", () => {
		expect(EXIT_MISCONFIGURED).toBe(78);
		expect(
			piBoundAtLoad(),
			"import these after loadHostPi, with import(), as the engine does kept history",
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
			'const n = await import("later");',
			'/** import { o } from "commented" */',
		].join("\n");
		expect(importsIn(source).sort()).toEqual(
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
			].sort(),
		);
	});
});
