/**
 * A test that makes a folder in the machine's own /tmp says why.
 *
 * The test setup points TMPDIR at a folder of the run's own and removes
 * it when the run ends, so what a test makes under `tmpdir()` goes with
 * it; the one short folder sockets need is the setup's too, and the next
 * run's sweep takes it from a run that was killed. A folder a test makes
 * in /tmp or /var/tmp itself is outside both. It is left behind whenever
 * the test's own cleanup doesn't run, and the loop team counted
 * leftovers nothing removes among the classes that recur. So such a
 * folder carries a comment, on its line or just above, saying why it
 * must be there rather than under `tmpdir()`.
 *
 * A folder made there is a `mkdtemp` or `mkdir` whose argument, read
 * whole across however many lines biome wraps it over, holds a path
 * opening with `/tmp`, `/var/tmp`, `/private/tmp` or `/dev/shm` written
 * out, or names a constant the same file sets to one, by whatever call
 * it is joined or resolved. Its reason sits on the call's first line or
 * just above. Every TypeScript and JavaScript file under tests/ is read.
 * A path that comes from elsewhere (an import, a helper, the environment)
 * can't be read from the text, so the rule doesn't reach it.
 */

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { packageFiles } from "../code/package-files.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** The endings of the TypeScript and JavaScript files read. */
const SOURCE = /\.(?:[mc]?[jt]s|tsx)$/;

/** A call that makes a folder, up to its opening bracket. */
const MAKES = /\b(?:mkdtemp|mkdir)(?:Sync)?\(/g;

/** A path written out in one of the machine's shared temporary folders. */
const SHARED_PATH = /["'`]\/(?:(?:var\/|private\/)?tmp|dev\/shm)\b/;

/** A constant set to such a path, naming it. */
const SHARED_CONSTANT =
	/\b(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*["'`]\/(?:(?:var\/|private\/)?tmp|dev\/shm)\b/g;

/** How long a read of every test file may take on a busy machine. */
const WALK = { timeout: 60_000 };

/** Whether a line is a comment, or ends with one, other than a doc comment's. */
function says(line: string): boolean {
	const trimmed = line.trim();
	if (trimmed.startsWith("/**") || trimmed.startsWith("*")) return false;
	return (
		trimmed.startsWith("//") ||
		trimmed.startsWith("/*") ||
		/\s\/\/\s/.test(line)
	);
}

/** The lines, counted from 1, that make a folder in /tmp saying nothing of why. */
function unexplainedSharedFolders(text: string): number[] {
	const lines = text.split("\n");
	const constants = [...text.matchAll(SHARED_CONSTANT)].map(
		(found) => new RegExp(`\\b${found[1]}\\b`),
	);
	return [...text.matchAll(MAKES)].flatMap((found) => {
		const made = argumentOf(text, found.index + found[0].length);
		const shared =
			SHARED_PATH.test(made) || constants.some((name) => name.test(made));
		if (!shared) return [];
		const at = text.slice(0, found.index).split("\n").length - 1;
		return says(lines[at] ?? "") || says(lines[at - 1] ?? "") ? [] : [at + 1];
	});
}

/** The text of a call's argument, from just past its opening bracket to the one closing it. */
function argumentOf(text: string, from: number): string {
	let depth = 1;
	for (let at = from; at < text.length; at++) {
		if ("([{".includes(text[at] ?? "")) depth += 1;
		if (")]}".includes(text[at] ?? "")) depth -= 1;
		if (depth === 0) return text.slice(from, at);
	}
	return text.slice(from);
}

describe("the package's tests", () => {
	it("tell a folder in /tmp that says why from one that doesn't", () => {
		// A matcher that finds nothing passes everything. This is the check
		// that it finds what it is meant to and lets the rest by.
		const made = 'const dir = mkdtempSync("/tmp/probe-");';
		expect(unexplainedSharedFolders(made), "a bare one is found").toEqual([1]);
		expect(
			unexplainedSharedFolders(
				"await mkdir(join('/var/tmp', 'kept'));\nmkdirSync(`/tmp/x`);",
			),
			"/var/tmp, a join and either quote are found",
		).toEqual([1, 2]);
		expect(
			unexplainedSharedFolders(`// A socket path must stay short.\n${made}`),
			"a comment just above says why",
		).toEqual([]);
		expect(
			unexplainedSharedFolders(`${made} // shared with the sandboxed shell`),
			"a comment on its line says why",
		).toEqual([]);
		expect(
			unexplainedSharedFolders(
				'const dir = mkdtempSync(join(tmpdir(), "probe-"));\nmkdtempSync("/tmpfiles-");',
			),
			"a folder under the run's own, or a path only opening like /tmp, is no shared one",
		).toEqual([]);
		expect(
			unexplainedSharedFolders(
				'const dir = mkdtempSync(\n\tjoin("/var/tmp", "kept-out-of-every-profile-"),\n);\nfs.mkdirSync(path.join("/tmp", x));\nmkdtempSync(resolve("/private/tmp", "x-"));\nmkdirSync(`/dev/shm/` + x);\nmkdirSync(resolve(home(), "/tmp/x"));',
			),
			"a wrapped call, any join or resolve, a path past a nested call, and /private/tmp or /dev/shm are found",
		).toEqual([1, 4, 5, 6, 7]);
		expect(
			unexplainedSharedFolders(
				'const SHORT: string = "/tmp";\nconst LONG = tmpdir();\nmkdtempSync(join(SHORT, "x-"));\nmkdtempSync(join(LONG, "x-"));\nmkdtempSync(join(SHORTER, "x-"));',
			),
			"a constant this file sets to /tmp is found, and others aren't",
		).toEqual([3]);
		expect(
			unexplainedSharedFolders(
				'/**\n * Probes it.\n */\nmkdtempSync("/tmp/probe-");\n/** Probes it. */\nmkdtempSync("/tmp/probe-");',
			),
			"a doc comment above is no reason",
		).toEqual([4, 6]);
	});

	it("are read in every TypeScript and JavaScript file", () => {
		const names = ["a.ts", "b.mts", "c.cts", "d.tsx", "e.js", "f.mjs"];
		expect(
			[...names, "g.cjs", "h.json", "i.md"].filter((file) => SOURCE.test(file)),
		).toEqual([...names, "g.cjs"]);
	});

	it("make a folder in /tmp only saying why", WALK, () => {
		const unexplained = packageFiles(ROOT)
			.filter((file) => file.startsWith("tests/") && SOURCE.test(file))
			// This file's own examples are such folders on purpose.
			.filter((file) => file !== relative(ROOT, import.meta.filename))
			.flatMap((file) =>
				unexplainedSharedFolders(readFileSync(join(ROOT, file), "utf8")).map(
					(line) => `${file}:${line}`,
				),
			);
		expect(
			unexplained,
			"these tests make a folder in the machine's own /tmp, which the setup never removes: make it under tmpdir() instead, or say on its line or just above why it must be there",
		).toEqual([]);
	});
});
