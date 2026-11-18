/**
 * Outside the host tests, an `.mts` imported is a declaration beside its
 * `.mjs`.
 *
 * Biome takes a `.d.mts` for the module it describes, so the linter's
 * import-extension rule maps `mts` to `mjs` everywhere but `tests/host`,
 * telling an importer to name the `.mjs`. A real `.mts` module imported
 * there would then be told to be imported as a `.mjs`, which tsc accepts,
 * since it resolves one to the other, and only node refuses at run time.
 * A real `.mts` that node runs by its path, as a test's fixture is, has
 * no importer for the rule to misjudge. This holds the mapping's premise,
 * so an imported module of that kind fails here first.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Where the host tests keep `.mts` modules of their own, imported as written. */
const OWN_MODULES = "tests/host/";

/** A relative specifier naming an `.mts` or `.mjs`, in an import or export. */
const SPECIFIER =
	/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+\.m[jt]s)["']/g;

/** The repository's files matching `patterns`, tracked or not yet, outside the host tests. */
function filesOutsideTheHostTests(...patterns: string[]): string[] {
	return execFileSync(
		"git",
		[
			"ls-files",
			"-z",
			"--cached",
			"--others",
			"--exclude-standard",
			...patterns,
		],
		{ cwd: ROOT, encoding: "utf8" },
	)
		.split("\0")
		.filter((path) => path !== "" && !path.startsWith(OWN_MODULES));
}

/** Every module path, from the root, that a relative import in `path` names. */
function importedBy(path: string): string[] {
	const text = readFileSync(join(ROOT, path), "utf8");
	return [...text.matchAll(SPECIFIER)].map((match) =>
		resolve(ROOT, dirname(path), match[1] ?? "").slice(ROOT.length + 1),
	);
}

describe("an .mts outside the host tests", () => {
	const modules = filesOutsideTheHostTests("*.mts");

	it("is a declaration with its .mjs beside it, when it declares", () => {
		const declarations = modules.filter((path) => path.endsWith(".d.mts"));
		const unpaired = declarations.filter(
			(path) => !existsSync(join(ROOT, path.replace(/\.d\.mts$/, ".mjs"))),
		);

		expect(declarations.length).toBeGreaterThan(0);
		expect(unpaired).toEqual([]);
	});

	it("is never imported, when it is a module of its own", () => {
		const own = new Set(
			modules
				.filter((path) => !path.endsWith(".d.mts"))
				.flatMap((path) => [path, path.replace(/\.mts$/, ".mjs")]),
		);
		const importers = filesOutsideTheHostTests(
			"*.ts",
			"*.mts",
			"*.mjs",
			"*.js",
		).flatMap((path) =>
			importedBy(path)
				.filter((imported) => own.has(imported))
				.map((imported) => `${path} imports ${imported}`),
		);

		expect(importers).toEqual([]);
	});
});
