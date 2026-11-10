/**
 * Hold unchecked index access to what's left of it, file by file.
 *
 * `noUncheckedIndexedAccess` types `list[i]` and `record[key]` as
 * possibly undefined, so a read past the end or of a missing key is a
 * type error rather than an `undefined` that travels on. The
 * repo-quality-standard's rule 4 asks for it, and step 8 of Y9XISP's
 * harness survey (8 November) found the package without it. Turning it
 * on found 1,099 such reads in 212 files, too many to fix in one
 * change, so this runs the type checker with it on and holds each file
 * to the count listed in `scripts/indexed-access-waiting.txt`. The list
 * only shrinks: a file may not gain one, and a file that loses some has
 * its count lowered, until the list is empty and the option moves into
 * tsconfig.json.
 *
 * Run it from the package root (Node strips the types):
 *
 *   node scripts/indexed-access.ts
 *
 * Exits 0 when every file is within its count and every count is
 * current, 1 otherwise, saying which.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The shrink-only list of files and how many unchecked reads each still has. */
const LIST = join(import.meta.dirname, "indexed-access-waiting.txt");

/** A type error as tsc prints it without colour: `path(line,col): error TSn: ...`. */
const ERROR = /^(.+?)\(\d+,\d+\): error TS\d+:/;

/** Each file's errors in tsc's output, counted. */
export function countErrors(output: string): Map<string, number> {
	const counts = new Map<string, number>();
	for (const line of output.split("\n")) {
		const file = ERROR.exec(line)?.[1];
		if (file) counts.set(file, (counts.get(file) ?? 0) + 1);
	}
	return counts;
}

/** The list as written: each file and the count it may still have. */
export function parseList(text: string): Map<string, number> {
	const counts = new Map<string, number>();
	for (const line of text.split("\n")) {
		const [file, count] = line.trim().split(/\s+/);
		if (file && count && !file.startsWith("#")) counts.set(file, Number(count));
	}
	return counts;
}

/** What breaks the list: files past their count, and counts left above a file's. */
export interface Drift {
	/** `file: now, listed n` for each file with more than its count. */
	readonly grown: string[];
	/** `file now (listed n)` for each file with fewer than its count. */
	readonly stale: string[];
}

/** Hold the counts found against the counts listed. */
export function drift(
	now: ReadonlyMap<string, number>,
	listed: ReadonlyMap<string, number>,
): Drift {
	const grown = [...now]
		.filter(([file, count]) => count > (listed.get(file) ?? 0))
		.map(
			([file, count]) => `${file}: ${count}, listed ${listed.get(file) ?? 0}`,
		);
	const stale = [...listed]
		.filter(([file, count]) => count > (now.get(file) ?? 0))
		.map(([file, count]) => `${file} ${now.get(file) ?? 0} (listed ${count})`);
	return { grown, stale };
}

function main(): void {
	const run = spawnSync(
		"pnpm",
		[
			"exec",
			"tsc",
			"--noEmit",
			"--pretty",
			"false",
			"--noUncheckedIndexedAccess",
		],
		{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
	);
	if (run.error) throw run.error;
	const now = countErrors(run.stdout);
	const { grown, stale } = drift(now, parseList(readFileSync(LIST, "utf8")));
	if (grown.length > 0)
		console.error(
			`These files read an index without checking it's there: handle the undefined (a guard, a default, \`at()\` with a check), or leave the read as it was:\n${grown.join("\n")}`,
		);
	if (stale.length > 0)
		console.error(
			`These files have fewer unchecked reads than scripts/indexed-access-waiting.txt allows; lower each to the count given, or remove it at 0, since the list only shrinks:\n${stale.join("\n")}`,
		);
	if (grown.length > 0 || stale.length > 0) process.exit(1);
	const total = [...now.values()].reduce((sum, count) => sum + count, 0);
	console.log(
		`${total} unchecked index reads in ${now.size} files, each within the list.`,
	);
}

if (import.meta.main) main();
