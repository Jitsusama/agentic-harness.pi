/**
 * pi-fence's run path loads nothing but node's own modules and the
 * harness's files.
 *
 * Core runs scripts/pi-fence.ts straight from the harness's source with
 * the store's node and no node_modules, so a package the run path
 * imports fails every fenced run at its start (core's
 * vm-a-fenced-run-stays-fenced, 16 November, once the census's imports
 * reached `yaml`). The walk follows each static runtime import from the
 * script; a dynamic `import()` is left alone, since it loads only when
 * its form is asked for. A type-only import is erased before it runs,
 * but `import { type X }` is kept by node, so it counts.
 */

import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPT = join(ROOT, "scripts", "pi-fence.ts");
const STATIC =
	/(?:^|\n)\s*(?:import|export)(\s+type)?\b[^;"'`]*?\bfrom\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/g;

/** The specifiers one source imports at its start, type-only ones left out. */
function staticImports(source: string): string[] {
	return [...source.matchAll(STATIC)].flatMap(([, typeOnly, from, bare]) => {
		if (bare !== undefined) return [bare];
		return typeOnly === undefined && from !== undefined ? [from] : [];
	});
}

/** Each package a file's static imports reach, as `file specifier`. */
function packagesReached(start: string): string[] {
	const seen = new Set<string>();
	const found: string[] = [];
	const visit = (file: string) => {
		if (seen.has(file)) return;
		seen.add(file);
		for (const specifier of staticImports(readFileSync(file, "utf8"))) {
			if (specifier.startsWith(".")) {
				visit(resolve(dirname(file), specifier));
			} else if (!specifier.startsWith("node:")) {
				found.push(`${relative(ROOT, file)} ${specifier}`);
			}
		}
	};
	visit(start);
	return found;
}

it("reaches no package from pi-fence's run path", () => {
	expect(
		packagesReached(SCRIPT),
		"core runs pi-fence with no node_modules; load these lazily",
	).toEqual([]);
});

it("tells a start-up import from a lazy or type-only one", () => {
	const source = [
		'import type { Document } from "yaml";',
		'import { parse } from "yaml";',
		"import {",
		"\ttype Model,",
		'} from "@earendil-works/pi-ai";',
		'export { Text } from "./text.ts";',
		'import "./side-effect.ts";',
		'const later = () => import("../lib/mesh/presence.ts");',
	].join("\n");
	expect(staticImports(source)).toEqual([
		"yaml",
		"@earendil-works/pi-ai",
		"./text.ts",
		"./side-effect.ts",
	]);
});
