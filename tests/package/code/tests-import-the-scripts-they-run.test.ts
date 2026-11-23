/**
 * A test imports each shell script it runs or reads, and only tests
 * import one.
 *
 * `pnpm check` runs the tests whose imports reach a changed file, and a
 * script a test starts by its path is no import, so an edit to that
 * script alone ran none of its tests. The loader in
 * `tests/setup/scripts-as-text.ts` lets a test import the script, and
 * follows what the script sources; this holds every test to doing so.
 * It finds a script named on its own in a string, as `join(SCRIPTS,
 * "x.sh")` or `"./x.sh"` names one, rather than in a sentence or a
 * command line, which a test can hold without running the script. A
 * name built from parts, as the host runtime's stand-ins are, is past
 * it, so those tests import their stand-ins by hand.
 *
 * Only tests have the loader: pi reads a shipped file's `.sh` import as
 * JavaScript, so a typecheck that passes one would break only under pi.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** This file, whose exemptions name a script it never runs. */
const SELF = relative(ROOT, import.meta.filename);

/** What the code is written in: the files a scan reads. */
const CODE = /\.(?:ts|mts|mjs)$/;

/** Folders holding no code of this package's own. */
const NOT_CODE = new Set([".git", "node_modules", "docs", "data", "skills"]);

/**
 * Scripts a test names without running or reading them, by the test's
 * path from the root, each with why.
 */
const EXEMPT: Readonly<Record<string, readonly string[]>> = {
	// The words a kept run says it ran, which the gate compares as text.
	"tests/scripts/host-gate.test.ts": ["scripts/host-run.sh"],
};

/** Every code file under `folder`, as a path from the root. */
function codeUnder(folder: string): string[] {
	return readdirSync(join(ROOT, folder), { recursive: true, encoding: "utf8" })
		.filter((path) => CODE.test(path))
		.filter((path) => !path.split("/").some((part) => NOT_CODE.has(part)))
		.map((path) => join(folder, path));
}

/** The `.sh` files `text`, at `file`, imports, as paths from the root. */
function shImports(file: string, text: string): string[] {
	return [
		...text.matchAll(/^import\s+(?:\w+\s+from\s+)?["']([^"']+\.sh)["']/gm),
	].map((found) =>
		relative(ROOT, resolve(ROOT, dirname(file), found[1] ?? "")),
	);
}

/**
 * The scripts `text`, at `file`, names on its own in a string: one in
 * `scripts/` by its name or its path from the root, or one beside the
 * file by `./` and its name, as paths from the root.
 */
function scriptsNamed(file: string, text: string): string[] {
	const named = [
		...text.matchAll(/["'`]((?:\.\/|scripts\/)?[\w.-]+\.sh)["'`]/g),
	]
		.map((found) => found[1] ?? "")
		.map((name) =>
			name.startsWith("./")
				? relative(ROOT, resolve(ROOT, dirname(file), name))
				: join("scripts", name.replace(/^scripts\//, "")),
		)
		.filter((path) => existsSync(join(ROOT, path)));
	return [...new Set(named)];
}

describe("shell scripts", () => {
	it("are imported by each test that runs or reads them", () => {
		const tests = codeUnder("tests").filter((file) => file !== SELF);
		const unimported = tests.flatMap((file) => {
			const text = readFileSync(join(ROOT, file), "utf8");
			const imported = shImports(file, text);
			const exempt = EXEMPT[file] ?? [];
			return scriptsNamed(file, text)
				.filter((path) => !(imported.includes(path) || exempt.includes(path)))
				.map((path) => `${file} names ${path}`);
		});
		expect(unimported, "named but not imported").toEqual([]);
	});

	it("are imported by nothing but tests", () => {
		const roots = readdirSync(ROOT, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.filter((name) => name !== "tests" && !NOT_CODE.has(name));
		const shipped = roots
			.flatMap(codeUnder)
			.concat(readdirSync(ROOT).filter((name) => CODE.test(name)))
			.filter((file) => file !== "vitest.config.ts");
		const importing = shipped.filter(
			(file) =>
				shImports(file, readFileSync(join(ROOT, file), "utf8")).length > 0,
		);
		expect(importing, "a shipped file importing a script").toEqual([]);
	});

	it("leave out only scripts that exist", () => {
		const gone = Object.entries(EXEMPT).flatMap(([file, paths]) =>
			[file, ...paths].filter((path) => !existsSync(join(ROOT, path))),
		);
		expect(gone, "an exemption naming nothing").toEqual([]);
	});
});
