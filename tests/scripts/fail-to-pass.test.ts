/**
 * fail-to-pass.ts as the merge gate runs it: node running the script as
 * it stands, from a small repository whose node_modules is this
 * checkout's, with main's commit and a head's as its words. Main holds
 * a sum that subtracts; each head changes it and a test, and the script
 * runs that test with the head's sum and with main's.
 */

import { execFile } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { isRecord } from "../../lib/internal/record.ts";
import {
	disposeRepo,
	freshRepo,
	git,
	withoutGitSettings,
} from "../support/git-fixture.ts";
// Imported only to be named, so `--changed` runs this file when the
// script it runs changes; imported, it runs nothing.
import "../../scripts/fail-to-pass.ts";

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPT = join(ROOT, "scripts", "fail-to-pass.ts");

/** Main's sum, which subtracts. */
const BROKEN = "export const sum = (a: number, b: number): number => a - b;\n";
/** The head's sum, which adds. */
const FIXED = "export const sum = (a: number, b: number): number => a + b;\n";
/** A test that fails on main's sum and passes on the head's. */
const ADDS = `import { expect, it } from "vitest";
import { sum } from "../lib/sum.ts";
it("adds", () => expect(sum(1, 2)).toBe(3));
`;
/** A test that passes whichever sum it imports. */
const NAMES = `import { expect, it } from "vitest";
import { sum } from "../lib/sum.ts";
it("names a function", () => expect(typeof sum).toBe("function"));
`;

const repos: string[] = [];
afterEach(() => {
	for (const repo of repos.splice(0)) {
		// The link to this checkout's packages goes first, so nothing
		// removing the repository can reach through it.
		rmSync(join(repo, "node_modules"), { force: true });
		disposeRepo(repo);
	}
});

/** Write each file in `files` into `repo` and commit them with `message`. */
async function commit(
	repo: string,
	files: Record<string, string>,
	message: string,
): Promise<string> {
	for (const [file, text] of Object.entries(files)) {
		mkdirSync(dirname(join(repo, file)), { recursive: true });
		writeFileSync(join(repo, file), text);
		await git(repo, "add", file);
	}
	await git(repo, "commit", "-q", "-m", message);
	return git(repo, "rev-parse", "HEAD");
}

/** A repository whose main holds the broken sum, this checkout's packages linked in. */
async function repository(packages = true): Promise<string> {
	const repo = await freshRepo("fail-to-pass");
	repos.push(repo);
	await commit(
		repo,
		{
			"package.json": '{ "type": "module" }\n',
			".gitignore": "node_modules\n",
			"lib/sum.ts": BROKEN,
		},
		"sum",
	);
	if (packages)
		symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
	return repo;
}

/** A head off main committing `files` with `message`; answers its commit. */
async function head(
	repo: string,
	name: string,
	files: Record<string, string>,
	message = `feat: ${name}`,
): Promise<string> {
	await git(repo, "checkout", "-q", "-b", name, "main");
	return commit(repo, files, message);
}

/** What the script said and how it exited, run from `repo` on main and `sha`. */
async function failToPass(
	repo: string,
	sha: string,
): Promise<{ code: number; said: string }> {
	try {
		const { stdout, stderr } = await run(
			process.execPath,
			["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", SCRIPT, "main", sha],
			{ cwd: repo, env: withoutGitSettings(process.env) },
		);
		return { code: 0, said: `${stdout}${stderr}` };
	} catch (error) {
		if (!isRecord(error)) throw error;
		const { code, stdout, stderr } = error;
		return {
			code: typeof code === "number" ? code : -1,
			said: `${typeof stdout === "string" ? stdout : ""}${typeof stderr === "string" ? stderr : ""}`,
		};
	}
}

describe("the fail-to-pass step", () => {
	// Each case starts node, then vitest twice, which takes seconds on a
	// loaded machine: past vitest's five, inside git-fixture's thirty.
	it("passes a head whose test fails with main's source", async () => {
		const repo = await repository();
		const sha = await head(repo, "fixed", {
			"lib/sum.ts": FIXED,
			"tests/sum.test.ts": ADDS,
		});
		const { code, said } = await failToPass(repo, sha);
		expect(said).toContain("tests/sum.test.ts > adds");
		expect(code, said).toBe(0);
	});

	it("refuses a head whose test passes either way, saying no case flipped", async () => {
		const repo = await repository();
		const sha = await head(repo, "unproved", {
			"lib/sum.ts": FIXED,
			"tests/sum.test.ts": NAMES,
		});
		const { code, said } = await failToPass(repo, sha);
		expect(said).toContain(
			"no case that passes at the head fails with the change's source undone",
		);
		expect(code, said).toBe(1);
	});

	it("passes a head whose trailer says why nothing can be tested, saying why", async () => {
		const repo = await repository();
		const sha = await head(
			repo,
			"renamed",
			{ "lib/sum.ts": FIXED, "tests/sum.test.ts": NAMES },
			"refactor: rename a variable\n\nFail-To-Pass: none, a rename changes no behaviour\n",
		);
		const { code, said } = await failToPass(repo, sha);
		expect(said).toContain("a rename changes no behaviour");
		expect(code, said).toBe(0);
	});

	it("passes a head that changes no source, saying so", async () => {
		const repo = await repository();
		const sha = await head(repo, "docs", { "docs/sum.md": "Sums.\n" });
		const { code, said } = await failToPass(repo, sha);
		expect(said).toContain("no source changed");
		expect(code, said).toBe(0);
	});

	it("can't judge from a checkout with no vitest, and says so", async () => {
		const repo = await repository(false);
		const sha = await head(repo, "bare", {
			"lib/sum.ts": FIXED,
			"tests/sum.test.ts": ADDS,
		});
		const { code, said } = await failToPass(repo, sha);
		expect(said).toContain("no vitest installed");
		expect(code, said).toBe(2);
	});
});
