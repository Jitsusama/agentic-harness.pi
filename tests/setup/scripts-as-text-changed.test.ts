// What the loader is for, end to end: a change to a script a test's own
// script sources, and to nothing else, has vitest's `--changed` run that
// test, which without the loader it never does. It runs vitest itself,
// in a repo of its own, so it sits in the process lane.
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { isRecord } from "../../lib/internal/record.ts";
import { disposeRepo, freshRepo, git } from "../support/git-fixture.ts";

const run = promisify(execFile);
const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const VITEST = join(ROOT, "node_modules", ".bin", "vitest");
const LOADER = join(ROOT, "tests", "setup", "scripts-as-text.ts");
/**
 * How long one vitest start may take to list, a few seconds alone, before
 * it is killed, so a starved run says so and leaves nothing running.
 */
const LIST_MS = 30_000;
/** A case's two starts, and its repo's making. */
const LISTS_IN_MS = 2 * LIST_MS + 10_000;
/** How much of what vitest printed a failure shows. */
const OUTPUT_SHOWN = 500;

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

/**
 * A repo whose one test imports a shell program with no ending, as the
 * ssh guard's wrappers are, under the loader, and only that program
 * changed since its last commit: vite must resolve the import to the
 * file's own path, which is what `--changed` compares.
 */
async function wrapperChanged(): Promise<string> {
	const repo = await freshRepo("changed-wrapper");
	repos.push(repo);
	writeFileSync(
		join(repo, "vitest.config.ts"),
		`import { scriptsAsText } from ${JSON.stringify(LOADER)};\nexport default { plugins: [scriptsAsText()], test: { globals: true, include: ["*.test.ts"] } };\n`,
	);
	writeFileSync(
		join(repo, "a.test.ts"),
		'import "./bin/tool";\n\nit("runs the tool", () => undefined);\n',
	);
	writeFileSync(
		join(repo, "other.test.ts"),
		'it("runs nothing of the tool", () => undefined);\n',
	);
	mkdirSync(join(repo, "bin"));
	writeFileSync(join(repo, "bin", "tool"), "#!/usr/bin/env bash\necho tool\n");
	await git(repo, "add", ".");
	await git(repo, "commit", "-qm", "a tool");
	writeFileSync(
		join(repo, "bin", "tool"),
		"#!/usr/bin/env bash\necho tool, changed\n",
	);
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
	// An empty list passes, so any failure is vitest's own, and the list
	// comes as JSON, so output that isn't one can't read as no files.
	const words = [
		"list",
		...(changed ? ["--changed", "HEAD"] : []),
		"--filesOnly",
		"--passWithNoTests",
		"--json",
		"--root",
		repo,
	];
	const { stdout } = await run(VITEST, words, {
		cwd: repo,
		env,
		timeout: LIST_MS,
		killSignal: "SIGKILL",
	}).catch((error: unknown) => {
		const killed = isRecord(error) && error.killed === true;
		throw new Error(
			killed
				? `vitest ${words.join(" ")} listed nothing in ${LIST_MS / 1000} s, so it was killed`
				: `vitest ${words.join(" ")} failed`,
			{ cause: error },
		);
	});
	let list: unknown;
	try {
		list = JSON.parse(stdout);
	} catch (error) {
		throw new Error(
			`vitest ${words.join(" ")} printed no JSON: ${stdout.slice(0, OUTPUT_SHOWN)}`,
			{ cause: error },
		);
	}
	return filesIn(list, stdout);
}

/** The test files' names a JSON list from `vitest list` holds. */
function filesIn(list: unknown, printed: string): string[] {
	if (!Array.isArray(list))
		throw new Error(
			`vitest listed no array: ${printed.slice(0, OUTPUT_SHOWN)}`,
		);
	return list
		.map((entry: unknown) => {
			if (!(isRecord(entry) && typeof entry.file === "string"))
				throw new Error(`vitest listed ${JSON.stringify(entry)}, no file`);
			return basename(entry.file);
		})
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

	it(
		"has vitest's --changed run the test importing a program with no ending",
		async () => {
			const repo = await wrapperChanged();
			expect(await listed(repo), "the test importing it").toEqual([
				"a.test.ts",
			]);
		},
		LISTS_IN_MS,
	);
});
