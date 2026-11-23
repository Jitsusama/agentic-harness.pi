/**
 * A test imports each shell script it runs or reads, and only tests
 * import one.
 *
 * `pnpm check` runs the tests whose imports reach a changed file, and a
 * script a test starts by its path is no import, so an edit to that
 * script alone ran none of its tests. The loader in
 * `tests/setup/scripts-as-text.ts` lets a test import the script, and
 * follows what the script sources or runs from beside it; this holds
 * every test to doing so. It finds a script named on its own in a
 * string, as `join(SCRIPTS, "x.sh")`, `"./x.sh"` or a fixture's bare
 * name does, rather than in a sentence or a command line, which a test
 * can hold without running the script. A name built from parts, as the
 * host runtime's stand-ins are, or held in a library's constant, as the
 * ssh guard's folder is, is past it, so those tests import their
 * scripts by hand. A script the package ships beside its code, which
 * that code reads, is held to being imported by some test.
 *
 * Only tests have the loader: pi reads a shipped file's script import
 * as JavaScript, so a typecheck that passes one would break only under
 * pi.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { unfollowedSources } from "../../setup/scripts-as-text.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** This file, whose exemptions name a script it never runs. */
const SELF = relative(ROOT, import.meta.filename);

/** What the code is written in: the files a scan reads. */
const CODE = /\.(?:ts|mts|mjs)$/;

/** What a shell script's name ends in. */
const SCRIPT = /\.(?:sh|bash)$/;

/** Folders holding no code of this package's own. */
const NOT_CODE = new Set(["docs", "data", "skills"]);

/** Where the package ships scripts its own code reads. */
const SHIPPED_SCRIPTS = ["lib/", "extensions/", "host/", "packs/"];

/**
 * Scripts a test names without running or reading them, by the test's
 * path from the root, each with why.
 */
const EXEMPT: Readonly<Record<string, readonly string[]>> = {
	// The words a kept run says it ran, which the gate compares as text.
	"tests/scripts/host-gate.test.ts": ["scripts/host-run.sh"],
};

/**
 * Every file git tracks, or would, so a worktree or an install inside
 * the checkout is never read as the package's own.
 */
function tracked(): string[] {
	return execFileSync(
		"git",
		["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
		{ cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
	)
		.split("\0")
		.filter((file) => file !== "" && existsSync(join(ROOT, file)));
}

/** The package's code files of `files`, outside the folders that hold none. */
function codeOf(files: readonly string[]): string[] {
	return files
		.filter((file) => CODE.test(file))
		.filter((file) => !NOT_CODE.has(file.split("/")[0] ?? ""));
}

/** The scripts `text`, at `file`, imports, as paths from the root. */
function scriptImports(file: string, text: string): string[] {
	return [
		...text.matchAll(
			/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+\.(?:sh|bash))["']/g,
		),
	].map((found) =>
		relative(ROOT, resolve(ROOT, dirname(file), found[1] ?? "")),
	);
}

/**
 * The scripts `text`, at `file`, names on its own in a string, as paths
 * from the root, of `scripts`, every script there is: one beside the
 * file by `./`, one by a path from the root, the file's folder or
 * `scripts/`, and one by its bare name in `scripts/` or in the file's
 * folder or below it, as a fixture is.
 */
function scriptsNamed(
	file: string,
	text: string,
	scripts: readonly string[],
): string[] {
	const near = [`${dirname(file)}/`, "scripts/"];
	const named = [
		...text.matchAll(/["'`]((?:\.\/)?[\w./-]*?[\w.-]+\.(?:sh|bash))["'`]/g),
	]
		.map((found) => found[1] ?? "")
		.flatMap((name) => {
			if (name.startsWith("./"))
				return [relative(ROOT, resolve(ROOT, dirname(file), name))];
			if (name.includes("/"))
				return [name, join(dirname(file), name), join("scripts", name)];
			return scripts.filter(
				(path) =>
					basename(path) === name &&
					near.some((folder) => path.startsWith(folder)),
			);
		})
		.filter((path) => scripts.includes(path));
	return [...new Set(named)];
}

describe("shell scripts", () => {
	const files = tracked();
	const scripts = files.filter((file) => SCRIPT.test(file));
	const tests = codeOf(files).filter(
		(file) => file.startsWith("tests/") && file !== SELF,
	);
	const importsOf = new Map(
		tests.map((file) => [
			file,
			scriptImports(file, readFileSync(join(ROOT, file), "utf8")),
		]),
	);

	it("are imported by each test that runs or reads them", () => {
		const found = tests.flatMap((file) => {
			const text = readFileSync(join(ROOT, file), "utf8");
			return scriptsNamed(file, text, scripts).map((path) => ({ file, path }));
		});
		// A scan that found nothing would pass whatever the tests did.
		expect(found.length, "scripts the tests name").toBeGreaterThan(10);
		const unimported = found
			.filter(
				({ file, path }) =>
					!(
						importsOf.get(file)?.includes(path) || EXEMPT[file]?.includes(path)
					),
			)
			.map(({ file, path }) => `${file} names ${path}`);
		expect(unimported, "named but not imported").toEqual([]);
	});

	it("that the package ships beside its code are each imported by a test", () => {
		const imported = new Set([...importsOf.values()].flat());
		const shipped = scripts.filter((path) =>
			SHIPPED_SCRIPTS.some((folder) => path.startsWith(folder)),
		);
		expect(shipped.length, "scripts it ships").toBeGreaterThan(0);
		expect(
			shipped.filter((path) => !imported.has(path)),
			"shipped, imported by no test",
		).toEqual([]);
	});

	it("are imported by nothing but tests", () => {
		const importing = codeOf(files)
			.filter((file) => !file.startsWith("tests/"))
			.filter((file) => file !== "vitest.config.ts")
			.filter(
				(file) =>
					scriptImports(file, readFileSync(join(ROOT, file), "utf8")).length >
					0,
			);
		expect(importing, "a shipped file importing a script").toEqual([]);
	});

	// A script sourced some other way would reach no test from an edit.
	it("are sourced only in a way the loader follows", () => {
		const unfollowed = scripts.flatMap((path) =>
			unfollowedSources(
				join(ROOT, path),
				readFileSync(join(ROOT, path), "utf8"),
			).map((line) => `${path}: ${line.trim()}`),
		);
		expect(unfollowed, "a source line the loader can't follow").toEqual([]);
	});

	it("leave out only scripts that exist and that their test names but doesn't import", () => {
		const stale = Object.entries(EXEMPT).flatMap(([file, paths]) => {
			if (!existsSync(join(ROOT, file))) return [`${file} is gone`];
			const text = readFileSync(join(ROOT, file), "utf8");
			const named = scriptsNamed(file, text, scripts);
			return paths
				.filter(
					(path) =>
						!named.includes(path) || importsOf.get(file)?.includes(path),
				)
				.map((path) => `${file}: ${path}`);
		});
		expect(stale, "an exemption no longer needed").toEqual([]);
	});
});

describe("the rule's reading", () => {
	const scripts = [
		"scripts/host-gate.sh",
		"scripts/ssh-guard/guard.bash",
		"tests/host/end-to-end/fixtures/e9-mycelium.sh",
		"tests/other/fixtures/e9-mycelium.sh",
		"tests/scripts/beside.sh",
	];

	it("finds a script by its path, by ./ beside the test, and a fixture by its bare name below the test", () => {
		expect(
			scriptsNamed(
				"tests/host/end-to-end/cutover.test.ts",
				[
					'join(SCRIPTS, "host-gate.sh")',
					'"ssh-guard/guard.bash"',
					'join(import.meta.dirname, "fixtures", "e9-mycelium.sh")',
					'"run host-gate.sh now"',
				].join("\n"),
				scripts,
			),
		).toEqual([
			"scripts/host-gate.sh",
			"scripts/ssh-guard/guard.bash",
			"tests/host/end-to-end/fixtures/e9-mycelium.sh",
		]);
		expect(
			scriptsNamed(
				"tests/scripts/x.test.ts",
				'"./beside.sh"\n"scripts/host-gate.sh"',
				scripts,
			),
			"by ./ and from the root",
		).toEqual(["tests/scripts/beside.sh", "scripts/host-gate.sh"]);
	});

	it("reads each way a file imports a script", () => {
		const file = "tests/scripts/x.test.ts";
		expect(
			scriptImports(
				file,
				[
					'import "../../scripts/a.sh";',
					'import text from "../../scripts/b.sh";',
					'import * as c from "../../scripts/c.sh";',
					'import {\n\tdefault as d,\n} from "../../scripts/d.bash";',
					'export { default } from "../../scripts/e.sh";',
					'await import("../../scripts/f.sh");',
				].join("\n"),
			),
		).toEqual(
			["a.sh", "b.sh", "c.sh", "d.bash", "e.sh", "f.sh"].map(
				(name) => `scripts/${name}`,
			),
		);
	});
});
