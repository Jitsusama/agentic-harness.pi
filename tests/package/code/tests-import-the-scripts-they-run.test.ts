/**
 * A test imports each shell script it runs or reads, and only tests
 * import one.
 *
 * `pnpm check` runs the tests whose imports reach a changed file, and a
 * script a test starts by its path is no import, so an edit to that
 * script alone ran none of its tests. The loader in
 * `tests/setup/scripts-as-text.ts` lets a test import the script, and
 * follows each script there is that the script names. This holds every
 * test that names a script to importing it itself: one reached only
 * through another script it imports doesn't count, so a test says what
 * it runs. It finds a script named on its own in a string, as
 * `join(SCRIPTS, "x.sh")`, `"./x.sh"` or a fixture's bare name does,
 * rather than in a sentence or a command line, which a test can hold
 * without running the script. A name built from parts, as the host
 * runtime's stand-ins are, held in a library's constant, as the ssh
 * guard's folder is, or read by a library from its own folder, as the
 * commit hook's script is, is past it, so the tests running those
 * import them by hand: such a script reaches only the tests that do. So
 * a script the package ships beside its code, which that code reads,
 * and one under tests/, which only a test runs, is held to being
 * reached by some test's imports.
 *
 * It runs under a full `pnpm test` and `pnpm check:there`, which run
 * tests/package whole; `pnpm check` runs it only when a change reaches
 * it, so a test naming a new script without importing it fails there.
 *
 * Only vitest has the loader: pi or node reads a script import as
 * JavaScript, so a typecheck that passes one in a file they load would
 * break only under them.
 */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	followedBy,
	isShellScript,
	unfollowedNames,
} from "../../setup/scripts-as-text.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** This file, whose exemptions name a script it never runs. */
const SELF = relative(ROOT, import.meta.filename);

/** What the code is written in: the files a scan reads. */
const CODE = /\.(?:ts|mts|mjs)$/;

/** Folders holding no code of this package's own. */
const NOT_CODE = new Set(["docs", "data", "skills"]);

/**
 * Where a script lives that only the package's code or its tests run:
 * beside the code, the ssh guard's wrappers that code puts on an
 * agent's PATH, and the stand-ins and fixtures under tests/.
 */
const HELD_SCRIPTS = [
	"lib/",
	"extensions/",
	"host/",
	"packs/",
	"scripts/ssh-guard/",
	"tests/",
];

/**
 * Files under tests/ that node or pi loads with no loader, as knip.jsonc's
 * entries name them: programs a test runs in a node of its own, the soak
 * runs, and the engines and providers a host loads by path.
 */
const RUN_OUTSIDE_VITEST = [
	/^tests\/.*\/fixtures\/[^/]+\.mts$/,
	/^tests\/host\/soak\/(?:soak|day)\.mts$/,
	/^tests\/host\/end-to-end\/support\/(?:fake-engine|pi-engine|scripted-provider|keyed-provider)\.ts$/,
];

/** Whether `file` is one node or pi loads with no loader. */
function runOutsideVitest(file: string): boolean {
	return RUN_OUTSIDE_VITEST.some((pattern) => pattern.test(file));
}

/** Whether the file at `file`, from the root, is a shell script. */
function isScriptFile(file: string): boolean {
	return isShellScript(join(ROOT, file));
}

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

/**
 * The scripts `text`, at `file`, imports, as paths from the root: any
 * relative import naming a script by its ending, or a file on disk the
 * loader would read as one, as the ssh guard's wrappers. An import
 * written inside a string reads as one too, and names no script there
 * is, so it only ever adds a path no rule asks after.
 */
function scriptImports(file: string, text: string): string[] {
	return [
		...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.[^"']*)["']/g),
	]
		.map((found) =>
			relative(ROOT, resolve(ROOT, dirname(file), found[1] ?? "")),
		)
		.filter((path) => /\.(?:sh|bash)$/.test(path) || isScriptFile(path));
}

/**
 * The scripts `imported`, paths from `root`, reaches, with every one
 * the loader follows from each.
 */
function reached(imported: Iterable<string>, root: string = ROOT): Set<string> {
	const found = new Set<string>();
	const next = [...imported];
	for (let path = next.pop(); path !== undefined; path = next.pop()) {
		if (found.has(path) || !existsSync(join(root, path))) continue;
		found.add(path);
		const text = readFileSync(join(root, path), "utf8");
		for (const file of followedBy(join(root, path), text, root))
			next.push(relative(root, file));
	}
	return found;
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
	const scripts = files.filter(isScriptFile);
	const tests = codeOf(files).filter(
		(file) =>
			file.startsWith("tests/") && file !== SELF && !runOutsideVitest(file),
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

	it("that only the package's code or tests run are each reached by a test's imports", () => {
		const imported = reached([...importsOf.values()].flat());
		const held = scripts.filter((path) =>
			HELD_SCRIPTS.some((folder) => path.startsWith(folder)),
		);
		const wrappers = files.filter(
			(file) =>
				file.startsWith("scripts/ssh-guard/bin/") && !file.endsWith(".md"),
		);
		expect(wrappers.length, "the ssh guard's wrappers").toBeGreaterThan(0);
		expect(
			wrappers.filter((file) => !held.includes(file)),
			"a wrapper not read as a script by its shebang",
		).toEqual([]);
		expect(
			held.filter((path) => !imported.has(path)),
			"held, reached by no test",
		).toEqual([]);
	});

	it("are imported by nothing vitest doesn't load", () => {
		const importing = codeOf(files)
			.filter((file) => !file.startsWith("tests/") || runOutsideVitest(file))
			.filter(
				(file) =>
					scriptImports(file, readFileSync(join(ROOT, file), "utf8")).length >
					0,
			);
		expect(importing, "a file pi or node loads, importing a script").toEqual(
			[],
		);
	});

	it("leave to node or pi only files there are", () => {
		expect(
			RUN_OUTSIDE_VITEST.filter(
				(pattern) => !files.some((file) => pattern.test(file)),
			).map(String),
			"a pattern naming no file",
		).toEqual([]);
	});

	// A slip in a name only beside a script can mean would leave the one
	// meant out of every test's reach.
	it("name no script beside them that isn't there", () => {
		const unfollowed = scripts.flatMap((path) =>
			unfollowedNames(
				join(ROOT, path),
				readFileSync(join(ROOT, path), "utf8"),
			).map((line) => `${path}: ${line}`),
		);
		expect(unfollowed, "a script named beside one, not there").toEqual([]);
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
	it("reaches every script the loader follows from those imported, through each in turn", () => {
		const root = mkdtempSync(join(tmpdir(), "scripts-reached-"));
		try {
			mkdirSync(join(root, "scripts", "lib"), { recursive: true });
			const write = (path: string, text: string) =>
				writeFileSync(join(root, path), text);
			write("scripts/a.sh", 'source "$(dirname "$0")/lib/b.sh"\n');
			write("scripts/lib/b.sh", 'exec "$here/../c.sh"\n');
			write("scripts/c.sh", "bash scripts/d.sh\n");
			write("scripts/d.sh", "echo done\n");
			write("scripts/alone.sh", "echo alone\n");
			expect([...reached(["scripts/a.sh"], root)].sort()).toEqual([
				"scripts/a.sh",
				"scripts/c.sh",
				"scripts/d.sh",
				"scripts/lib/b.sh",
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

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
					'import "../../scripts/ssh-guard/bin/ssh";',
					'import { it } from "../../tests/setup/temp-root.ts";',
					'import "../../scripts/ssh-guard/README.md";',
				].join("\n"),
			),
		).toEqual([
			...["a.sh", "b.sh", "c.sh", "d.bash", "e.sh", "f.sh"].map(
				(name) => `scripts/${name}`,
			),
			"scripts/ssh-guard/bin/ssh",
		]);
	});
});
