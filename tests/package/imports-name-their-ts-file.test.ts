/**
 * Relative imports name the file that exists.
 *
 * pi loads this package from source through jiti, which resolves
 * `./x.js` against `x.ts` only after asking Node, failing, and probing a
 * dozen other names. That cost dominated pi's startup: loading every
 * extension took 5.9 s with `.js` specifiers and 1.2 s with `.ts` ones.
 * `.js` is still the habit most TypeScript is written in, so this keeps
 * it from creeping back.
 *
 * `node scripts/ts-import-specifiers.ts` fixes whatever this finds.
 */

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
	rewriteSpecifiers,
	sourceFiles,
	staleSpecifiers,
} from "../../scripts/ts-import-specifiers.ts";

const ROOT = join(import.meta.dirname, "..", "..");

describe("relative imports", () => {
	it("name their .ts file rather than a .js one", () => {
		const stale = sourceFiles(ROOT).flatMap((file) =>
			staleSpecifiers(file, readFileSync(file, "utf8")).map(
				({ line, specifier }) => `${relative(ROOT, file)}:${line} ${specifier}`,
			),
		);
		expect(stale).toEqual([]);
	});

	it("keep a .js specifier when a real .js file stands behind it", () => {
		const file = join(ROOT, "scripts", "ts-import-specifiers.ts");
		const source = 'import x from "./no-such-module.js";\n';
		expect(rewriteSpecifiers(file, source)).toBe(source);
	});
});
