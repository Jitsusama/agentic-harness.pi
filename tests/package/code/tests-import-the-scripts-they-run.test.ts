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
 * A script naming another beside it by its own folder, as
 * `$(dirname "$0")/`, `$(cd "$(dirname "$0")" && pwd)/`, `${0%/*}/` or
 * `${BASH_SOURCE%/*}/` spell it, `--`, a real path or a CDPATH-safe
 * `cd` among them, is held to that one being there; a name through a
 * variable, as `$here/`, is past it.
 *
 * Only vitest has the loader: pi or node reads a script import as
 * JavaScript, so a typecheck that passes one in a file they load, or in
 * anything that file imports in turn, would break only under them.
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
 * Files under tests/ that node or pi loads with no loader: every `.mjs`
 * and `.mts` there, which only a node of its own runs, as the fixtures,
 * the soak runs, the parity probes and the keyring's calls are; each
 * child a test starts by its path, named `-child.ts`; the engines and
 * providers a host loads by path; and the extensions' loader a node of
 * its own imports through jiti. One loaded by vitest too is only held
 * to more. A test that hands another file of tests/ to node or jiti by
 * its path adds it here.
 */
const RUN_OUTSIDE_VITEST = [
	/^tests\/.*\.m[jt]s$/,
	/^tests\/.*-child\.ts$/,
	/^tests\/host\/end-to-end\/support\/(?:fake-engine|pi-engine|scripted-provider|keyed-provider)\.ts$/,
	/^tests\/support\/every-extension\.ts$/,
];

/** Whether `file` is one node or pi loads with no loader. */
function runOutsideVitest(file: string): boolean {
	return RUN_OUTSIDE_VITEST.some((pattern) => pattern.test(file));
}

/** Whether the file at `file`, from `root`, is a shell script. */
function isScriptFile(file: string, root: string = ROOT): boolean {
	return isShellScript(join(root, file));
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
 * What `text`, at `file`, imports by a relative name, as paths from
 * `root`. An import written inside a string reads as one too, and names
 * no file there is, so it only ever adds a path no rule asks after.
 */
function relativeImports(
	file: string,
	text: string,
	root: string = ROOT,
): string[] {
	return [
		...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.[^"']*)["']/g),
	].map((found) =>
		relative(root, resolve(root, dirname(file), found[1] ?? "")),
	);
}

/**
 * The scripts `text`, at `file`, imports, as paths from `root`: any
 * relative import naming a script by its ending, or a file on disk the
 * loader would read as one, as the ssh guard's wrappers.
 */
function scriptImports(
	file: string,
	text: string,
	root: string = ROOT,
): string[] {
	return relativeImports(file, text, root).filter(
		(path) => /\.(?:sh|bash)$/.test(path) || isScriptFile(path, root),
	);
}

/**
 * The code files of those `starts` loads, paths from `root`, that import
 * a script: `starts` themselves and each code file they reach through
 * relative imports, in turn, since node or pi loads those with them and
 * has no loader for a script either.
 */
function importingAScript(
	starts: Iterable<string>,
	root: string = ROOT,
): string[] {
	const loaded = new Set<string>();
	const next = [...starts];
	for (let file = next.pop(); file !== undefined; file = next.pop()) {
		if (loaded.has(file) || !CODE.test(file) || !existsSync(join(root, file)))
			continue;
		loaded.add(file);
		next.push(
			...relativeImports(file, readFileSync(join(root, file), "utf8"), root),
		);
	}
	return [...loaded]
		.filter(
			(file) =>
				scriptImports(file, readFileSync(join(root, file), "utf8"), root)
					.length > 0,
		)
		.sort();
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
	const scripts = files.filter((file) => isScriptFile(file));
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
		const loaded = codeOf(files).filter(
			(file) => !file.startsWith("tests/") || runOutsideVitest(file),
		);
		expect(loaded, "what pi or node loads, from each place").toEqual(
			expect.arrayContaining([
				"vitest.config.ts",
				"extensions/job-workflow/index.ts",
				"lib/core/internal/keyring/secret-service-call.mjs",
				"tests/core/internal/keyring/calls/holds.mjs",
				"tests/core/support/ts-source.mjs",
				"tests/core/work/support/custody-child.ts",
				"tests/host/parity/hosted-rpc.mts",
				"tests/host/end-to-end/support/fake-engine.ts",
				"tests/support/every-extension.ts",
			]),
		);
		expect(
			loaded.filter((file) => file.startsWith("tests/")),
			"no test vitest runs",
		).not.toContainEqual(expect.stringMatching(/\.test\.ts$/));
		const importing = importingAScript(loaded);
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

	// A program a test runs in a node of its own loads its helpers with
	// it, and node has no loader for a script those import.
	it("finds a script imported by what a file node loads imports, through each in turn", () => {
		const root = mkdtempSync(join(tmpdir(), "scripts-importing-"));
		try {
			for (const folder of ["scripts", "tests/x/fixtures", "tests/x/support"])
				mkdirSync(join(root, folder), { recursive: true });
			const write = (path: string, text: string) =>
				writeFileSync(join(root, path), text);
			write("scripts/x.sh", "echo x\n");
			write(
				"tests/x/fixtures/run.mts",
				'import { help } from "../support/help.ts";\nhelp();\n',
			);
			write(
				"tests/x/support/help.ts",
				'import { more } from "./more.ts";\nexport const help = more;\n',
			);
			write(
				"tests/x/support/more.ts",
				'import text from "../../../scripts/x.sh";\nexport const more = () => text;\n',
			);
			write("tests/x/support/alone.ts", 'import "../../../scripts/x.sh";\n');
			expect(importingAScript(["tests/x/fixtures/run.mts"], root)).toEqual([
				"tests/x/support/more.ts",
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
