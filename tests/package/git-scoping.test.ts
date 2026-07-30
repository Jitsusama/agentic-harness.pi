/**
 * Every git command these libraries run says which repo it means.
 *
 * `Exec` is `(command, args)` with no working directory, so `-C` is the
 * only way to scope a git call and leaving it off silently runs against
 * whatever repo the process happens to sit in. That is not theoretical:
 * it shipped once, in `createGitTreeProvider.release`, and stayed
 * shipped because the unit test asserted `toContain` on the argv, which
 * cannot see a missing flag.
 *
 * A contract where the unsafe thing is the default wants a gate rather
 * than vigilance. This reads the source and fails on any git invocation
 * that does not scope itself, which is cheap and catches the whole
 * class rather than one instance of it.
 *
 * Reading source text is a blunt instrument and deliberately so. The
 * alternatives are worse: a type change would have to reach every
 * provider including ones in other packages, and a runtime assertion
 * would only fire on the paths a test happens to exercise, which is the
 * gap that let the original bug through.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Libraries whose only scoping mechanism is `-C`. */
const SCOPED_LIBS = ["lib/review", "lib/work"];

/**
 * Subcommands that are not about a repo, so a scope would be
 * meaningless.
 *
 * `clone` names its destination as an argument and has no repo to run
 * inside yet, which is the whole reason it is being run.
 */
const REPO_FREE = new Set(["clone", "init", "--version", "version"]);

/** Every TypeScript file under a directory, walked without a dependency. */
function sourcesUnder(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...sourcesUnder(path));
		else if (entry.name.endsWith(".ts")) found.push(path);
	}
	return found;
}

/** One git call found in the source, with enough context to judge it. */
interface Invocation {
	file: string;
	line: number;
	argv: string;
}

/**
 * Find every `exec(..."git"...)` and capture the argv array after it.
 *
 * Matches the call rather than the string, so a mention of git in a
 * comment or an error message is not mistaken for an invocation.
 */
function invocations(text: string, file: string): Invocation[] {
	const found: Invocation[] = [];
	const pattern = /["']git["']\s*,\s*(\[[\s\S]{0,400}?\])/g;
	for (const match of text.matchAll(pattern)) {
		const argv = match[1];
		if (argv === undefined) continue;
		found.push({
			file,
			line: text.slice(0, match.index).split("\n").length,
			argv,
		});
	}
	return found;
}

/** Whether this call says which repo it runs in. */
function scoped(argv: string): boolean {
	if (argv.includes('"-C"') || argv.includes("'-C'")) return true;
	// A subcommand that has no repo to be scoped to.
	return [...REPO_FREE].some((free) => argv.includes(`"${free}"`));
}

describe("git invocations name the repo they mean", () => {
	it("scopes every git call in the libraries that shell out", () => {
		const files = SCOPED_LIBS.flatMap((lib) =>
			sourcesUnder(join(process.cwd(), lib)),
		);
		expect(files.length, "expected to find library sources").toBeGreaterThan(0);

		const unscoped: string[] = [];
		for (const file of files) {
			const text = readFileSync(file, "utf8");
			for (const call of invocations(text, file)) {
				if (!scoped(call.argv)) {
					unscoped.push(`${call.file}:${call.line}`);
				}
			}
		}

		expect(
			unscoped,
			`These git calls do not say which repo they run in, so they will use whatever directory the process sits in:\n${unscoped.join("\n")}`,
		).toEqual([]);
	});

	it("would notice a call that dropped its scope", () => {
		// The guard's own test. A gate nobody has seen fail is a gate
		// nobody knows works, and this one reads source text, which is
		// exactly the kind of check that quietly matches nothing.
		const dropped = `["diff", \`\${base}...\${head}\`]`;

		expect(scoped(dropped)).toBe(false);
		expect(scoped(`["-C", root, "diff", "a...b"]`)).toBe(true);
	});

	it("finds the calls it claims to be checking", () => {
		// Guards against the pattern silently matching nothing, which
		// would make this whole file pass by finding no work to do.
		const text = readFileSync(
			join(process.cwd(), "lib/review/engine.ts"),
			"utf8",
		);

		expect(invocations(text, "engine.ts").length).toBeGreaterThanOrEqual(3);
	});
});
