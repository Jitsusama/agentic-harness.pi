/**
 * Every lazy import of this package's own code loads once.
 *
 * pi loads extensions through jiti, which hands a second import of a
 * module still being evaluated the half-made module, so a call made
 * then finds that module's own imports undefined. On 13 November two of
 * three review_offer calls made at once failed reading `refuseFailure`,
 * from a bare `await import("./offer.ts")` in the tool's execute.
 * `loadOnce` (`lib/internal/single-flight.ts`) shares the one load.
 */

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { sourceFiles } from "../../scripts/ts-import-specifiers.ts";

const ROOT = join(import.meta.dirname, "..", "..");

/** A dynamic import of a relative path, not a `typeof import(...)` type. */
const LAZY_IMPORT = /(?<!typeof\s*)\bimport\(\s*["']\.\.?\//g;

/** What stands right before an import that `loadOnce` wraps. */
const WRAPPED = /loadOnce\(\s*\(\)\s*=>\s*$/;

/** Each lazy import in `source` that no `loadOnce` wraps, by line. */
function bareImports(source: string): number[] {
	const lines: number[] = [];
	for (const found of source.matchAll(LAZY_IMPORT)) {
		const before = source.slice(0, found.index);
		const line = before.slice(before.lastIndexOf("\n") + 1).trimStart();
		if (line.startsWith("*") || line.startsWith("//")) continue;
		if (!WRAPPED.test(before)) lines.push(before.split("\n").length);
	}
	return lines;
}

describe("lazy imports of the package's own code", () => {
	it("go through loadOnce", () => {
		const bare = sourceFiles(ROOT, ["extensions", "packs", "lib"]).flatMap(
			(file) =>
				bareImports(readFileSync(file, "utf8")).map(
					(line) => `${relative(ROOT, file)}:${line}`,
				),
		);
		expect(bare, "lazy imports no loadOnce wraps").toEqual([]);
	});

	it("are found however the call is laid out, and types are not", () => {
		const source = [
			'const a = loadOnce(() => import("./a.ts"));',
			'const b = loadOnce(\n\t() =>\n\t\timport("./b.ts"),\n);',
			'type C = typeof import("./c.ts");',
			' * as `await import("./d.ts")` once did',
			'const { e } = await import("./e.ts");',
			'const f = import("../f.ts").then((m) => m.f);',
		].join("\n");
		expect(bareImports(source), "the two bare imports' lines").toEqual([8, 9]);
	});
});
