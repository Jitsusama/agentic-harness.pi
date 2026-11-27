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
 * A folder made there is a `mkdtemp` or `mkdir` whose path opens with
 * `/tmp` or `/var/tmp` written out, alone or as the first part of a
 * `join`.
 */

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { packageFiles } from "../code/package-files.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** A folder made in the machine's own temporary folder, by its written path. */
const SHARED_FOLDER =
	/\b(?:mkdtemp|mkdir)(?:Sync)?\(\s*(?:join\(\s*)?["'`]\/(?:var\/)?tmp\b/;

/** How long a read of every test file may take on a busy machine. */
const WALK = { timeout: 60_000 };

/** Whether a line is a comment, or ends with one. */
function says(line: string): boolean {
	const trimmed = line.trim();
	return (
		trimmed.startsWith("//") ||
		trimmed.startsWith("*") ||
		trimmed.startsWith("/*") ||
		/\s\/\/\s/.test(line)
	);
}

/** The lines, counted from 1, that make a folder in /tmp saying nothing of why. */
function unexplainedSharedFolders(text: string): number[] {
	const lines = text.split("\n");
	const found: number[] = [];
	lines.forEach((line, at) => {
		if (!SHARED_FOLDER.test(line) || says(line)) return;
		if (at > 0 && says(lines[at - 1] ?? "")) return;
		found.push(at + 1);
	});
	return found;
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
	});

	it("make a folder in /tmp only saying why", WALK, () => {
		const unexplained = packageFiles(ROOT)
			.filter((file) => file.startsWith("tests/") && file.endsWith(".ts"))
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
