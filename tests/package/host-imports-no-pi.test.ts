/**
 * The shared host's code loads no pi package of its own.
 *
 * The host runs pi from its own pinned install and hands what it loaded
 * to the engine. pi is only an optional peer here, so the harness's
 * production install carries none: a runtime import of pi from host/
 * would fail to resolve there, or bind the harness's dev copy rather
 * than the pi the host runs. A type-only import is erased before it
 * runs, so it may stay; `import { type X }` is not, since Node keeps
 * the statement and so loads the module.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const PI =
	/(?:^|\n)\s*(?:import|export)(\s+type)?\b[^;]*?\bfrom\s*["'](@earendil-works\/[^"']+)["']/g;
const DYNAMIC = /\bimport\(\s*["'](@earendil-works\/[^"']+)["']/g;

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return sources(path);
		return entry.name.endsWith(".ts") ? [path] : [];
	});
}

/** Each runtime import of a pi package in one source, as `name specifier`. */
function piImports(name: string, source: string): string[] {
	return [
		...[...source.matchAll(PI)]
			.filter(([, typeOnly]) => typeOnly === undefined)
			.map(([, , specifier]) => `${name} ${specifier}`),
		...[...source.matchAll(DYNAMIC)].map(
			([, specifier]) => `${name} ${specifier}`,
		),
	];
}

it("imports pi's packages for their types only", () => {
	const found = sources(join(ROOT, "host")).flatMap((file) =>
		piImports(relative(ROOT, file), readFileSync(file, "utf8")),
	);
	expect(found).toEqual([]);
});

it("tells a runtime import from a type-only one", () => {
	const source = [
		'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
		'import { VERSION } from "@earendil-works/pi-coding-agent";',
		"import {",
		"\ttype Model,",
		'} from "@earendil-works/pi-ai";',
		'export { Text } from "@earendil-works/pi-tui";',
		'const later = () => import("@earendil-works/pi-tui");',
	].join("\n");
	expect(piImports("x.ts", source)).toEqual([
		"x.ts @earendil-works/pi-coding-agent",
		"x.ts @earendil-works/pi-ai",
		"x.ts @earendil-works/pi-tui",
		"x.ts @earendil-works/pi-tui",
	]);
});
