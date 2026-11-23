// What the loader is for, end to end: a change to a script a test's own
// script sources, and to nothing else, has vitest's `--changed` run that
// test, which without the loader it never does. It runs vitest itself,
// in a repo of its own, so it sits in the process lane.
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { disposeRepo, freshRepo, git } from "../support/git-fixture.ts";

const run = promisify(execFile);
const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const VITEST = join(ROOT, "node_modules", ".bin", "vitest");
const LOADER = join(ROOT, "tests", "setup", "scripts-as-text.ts");
/** Two vitest starts on a busy machine, each a few seconds alone. */
const LISTS_IN_MS = 90_000;

const repos: string[] = [];
afterEach(() => {
	for (const repo of repos.splice(0)) disposeRepo(repo);
});

/**
 * A repo whose one test runs a script that sources another, with a test
 * beside it that runs no script, and only the sourced script changed
 * since its last commit. The test imports its script under the loader,
 * or, without it, names it by its path alone, as tests did before it.
 */
async function sourcedScriptChanged(loader: boolean): Promise<string> {
	const repo = await freshRepo("changed-follows");
	repos.push(repo);
	const plugins = loader
		? `import { scriptsAsText } from ${JSON.stringify(LOADER)};\nconst plugins = [scriptsAsText()];\n`
		: "const plugins = [];\n";
	writeFileSync(
		join(repo, "vitest.config.ts"),
		`${plugins}export default { plugins, test: { globals: true, include: ["*.test.ts"] } };\n`,
	);
	const reaches = loader
		? 'import "./a.sh";\n'
		: 'const script = new URL("./a.sh", import.meta.url);\n';
	writeFileSync(
		join(repo, "a.test.ts"),
		`${reaches}\nit("runs a", () => undefined);\n`,
	);
	writeFileSync(
		join(repo, "other.test.ts"),
		'it("runs nothing of a", () => undefined);\n',
	);
	writeFileSync(
		join(repo, "a.sh"),
		'#!/usr/bin/env bash\nsource "$(dirname "$0")/b.sh"\necho a\n',
	);
	writeFileSync(join(repo, "b.sh"), "#!/usr/bin/env bash\necho b\n");
	await git(repo, "add", ".");
	await git(repo, "commit", "-qm", "scripts");
	writeFileSync(join(repo, "b.sh"), "#!/usr/bin/env bash\necho b, changed\n");
	return repo;
}

/** The test files `vitest list` names in `repo`, those `--changed HEAD` runs or all. */
async function listed(repo: string, changed = true): Promise<string[]> {
	// The vitest running this test says so in its environment; the one
	// it starts reads its own config, not this one's.
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			([name]) => !(name.startsWith("VITEST") || name.startsWith("VITE_")),
		),
	);
	const listed = await run(
		VITEST,
		[
			"list",
			...(changed ? ["--changed", "HEAD"] : []),
			"--filesOnly",
			"--root",
			repo,
		],
		{ cwd: repo, env },
	).catch((error: unknown) => {
		// Listing no file at all is a failure to vitest; what it printed
		// still says which it found.
		if (
			error instanceof Error &&
			"stdout" in error &&
			typeof error.stdout === "string"
		)
			return { stdout: error.stdout };
		throw error;
	});
	return listed.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.endsWith(".test.ts"))
		.map((line) => basename(line))
		.sort();
}

describe("a script a test's script sources, changed alone", () => {
	it(
		"has vitest's --changed run that test once the loader follows it",
		async () => {
			const repo = await sourcedScriptChanged(true);
			expect(await listed(repo), "the test reaching it").toEqual(["a.test.ts"]);
		},
		LISTS_IN_MS,
	);

	it(
		"runs no test under --changed when the test names its script by path",
		async () => {
			const repo = await sourcedScriptChanged(false);
			expect(await listed(repo, false), "its tests, read").toEqual([
				"a.test.ts",
				"other.test.ts",
			]);
			expect(await listed(repo), "nothing reaching it").toEqual([]);
		},
		LISTS_IN_MS,
	);
});
