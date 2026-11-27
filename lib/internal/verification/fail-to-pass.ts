/**
 * Whether a change's own tests fail with its source undone, the rule
 * SWE-bench grades a fix by (FAIL_TO_PASS): some case the change's tests
 * hold must pass at the head and fail once the change's source is put
 * back as it was. A test that passes either way proves nothing about the
 * change it came with.
 *
 * Pure: the merge gate's `scripts/fail-to-pass.ts` runs git and vitest
 * and hands their words here, so every judgment is tested without either.
 */

import { isRecord } from "../record.ts";

/** How git names what a change did to a path. */
export type ChangeStatus = "A" | "M" | "D" | "R";

/** One path a change touched, with where a rename came from. */
export interface ChangedPath {
	readonly path: string;
	readonly status: ChangeStatus;
	/** The path before a rename; absent otherwise. */
	readonly from?: string;
}

/** A change's paths, as the fail-to-pass step reads them. */
export interface SplitChange {
	/** The test files the head holds that the change added or changed. */
	readonly tests: readonly string[];
	/** The source the change touched, which undoing puts back. */
	readonly sources: readonly ChangedPath[];
}

/** How one case ended in a run. */
export type CaseOutcome = "passed" | "failed" | "skipped";

/** What one vitest run said, case by case. */
export interface CaseResults {
	/** Each case by {@link caseKey}, and how it ended. */
	readonly cases: ReadonlyMap<string, CaseOutcome>;
	/** The test files that failed before any case in them ran. */
	readonly unloaded: ReadonlySet<string>;
}

/** What the fail-to-pass step found. */
export type FailToPass =
	| { readonly held: true; readonly cases: readonly string[] }
	| { readonly held: false; readonly why: string }
	| { readonly held: "unjudged"; readonly why: string };

/** The folders whose code counts as a change's source. */
const SOURCE_FOLDERS = ["lib/", "extensions/", "host/", "packs/", "scripts/"];

/** The endings of a source file. */
const SOURCE_ENDINGS = [".ts", ".mjs"];

/** Where the tests live, and how a test file's name ends. */
const TEST_FOLDER = "tests/";
const TEST_ENDING = ".test.ts";

/** What joins a case's file, its describe blocks and its title. */
const CASE_JOIN = " > ";

/** The trailer a head commit names a change with nothing to test by. */
export const EXEMPT_TRAILER = "Fail-To-Pass";

/** What the trailer's value opens with, before its reason. */
const EXEMPT_OPENING = "none,";

/** The statuses git writes with a second path after the first. */
const TWO_PATHS = new Set(["R", "C"]);

/** vitest's words for a case that never ran its body. */
const NOT_RUN = new Set(["skipped", "pending", "todo", "disabled"]);

/** Whether `path` is a test file. */
function isTest(path: string): boolean {
	return path.startsWith(TEST_FOLDER) && path.endsWith(TEST_ENDING);
}

/** Whether `path` is source the step undoes. */
function isSource(path: string): boolean {
	return (
		!path.startsWith(TEST_FOLDER) &&
		SOURCE_FOLDERS.some((folder) => path.startsWith(folder)) &&
		SOURCE_ENDINGS.some((ending) => path.endsWith(ending))
	);
}

/**
 * The changed test files and the changed source among a change's
 * paths. A test file counts when the head holds it (added, modified
 * or renamed in), a deleted one never; source counts however it
 * changed, since undoing a deletion or a rename is putting it back.
 * Anything else (docs, configs, skills) is neither.
 */
export function splitChange(paths: readonly ChangedPath[]): SplitChange {
	const tests: string[] = [];
	const sources: ChangedPath[] = [];
	for (const changed of paths) {
		if (isTest(changed.path)) {
			if (changed.status !== "D") tests.push(changed.path);
		} else if (
			isSource(changed.path) ||
			(changed.from !== undefined && isSource(changed.from))
		) {
			sources.push(changed);
		}
	}
	return { tests, sources };
}

/**
 * The paths `git diff --name-status -z` wrote: a status and a path, or
 * for a rename or a copy a scored status and both paths, each ended by
 * a NUL. A copy reads as an addition and a type change as a
 * modification, which is what undoing each takes; a status past those
 * (an unmerged path) is left out, since no diff between two commits
 * writes one.
 */
export function parseNameStatus(said: string): ChangedPath[] {
	const words = said.split("\0");
	const paths: ChangedPath[] = [];
	let at = 0;
	while (at < words.length) {
		const letter = (words[at] ?? "").charAt(0);
		if (letter === "") break;
		if (TWO_PATHS.has(letter)) {
			const from = words[at + 1] ?? "";
			const path = words[at + 2] ?? "";
			// A copy leaves where it came from as it was, so undoing it is
			// only taking the copy away.
			paths.push(
				letter === "R" ? { path, status: "R", from } : { path, status: "A" },
			);
			at += 3;
			continue;
		}
		const path = words[at + 1] ?? "";
		if (letter === "A" || letter === "M" || letter === "D") {
			paths.push({ path, status: letter });
		} else if (letter === "T") {
			paths.push({ path, status: "M" });
		}
		at += 2;
	}
	return paths;
}

/** The key a case goes by: its file, its describe blocks and its title. */
export function caseKey(file: string, names: readonly string[]): string {
	return [file, ...names].join(CASE_JOIN);
}

/** A string field of a parsed record, or empty. */
function text(record: Record<string, unknown>, field: string): string {
	const value = record[field];
	return typeof value === "string" ? value : "";
}

/** How vitest's word for a case's end reads here. */
function outcomeOf(status: string): CaseOutcome {
	if (status === "passed") return "passed";
	if (NOT_RUN.has(status)) return "skipped";
	return "failed";
}

/**
 * The cases a vitest JSON report holds, each file named by `named`
 * (vitest writes absolute paths, and the step compares runs by the
 * path in the repository). A file that failed with no case in it
 * failed to load: an import it couldn't resolve, or a throw at its top.
 * Undefined when the report isn't vitest's shape at all.
 */
export function parseVitestReport(
	report: unknown,
	named: (file: string) => string,
): CaseResults | undefined {
	if (!isRecord(report) || !Array.isArray(report.testResults)) return;
	const cases = new Map<string, CaseOutcome>();
	const unloaded = new Set<string>();
	for (const result of report.testResults) {
		if (!isRecord(result)) continue;
		const file = named(text(result, "name"));
		const assertions = Array.isArray(result.assertionResults)
			? result.assertionResults.filter(isRecord)
			: [];
		if (assertions.length === 0) {
			if (text(result, "status") === "failed") unloaded.add(file);
			continue;
		}
		for (const assertion of assertions) {
			const ancestors = Array.isArray(assertion.ancestorTitles)
				? assertion.ancestorTitles.filter(
						(title): title is string => typeof title === "string",
					)
				: [];
			cases.set(
				caseKey(file, [...ancestors, text(assertion, "title")]),
				outcomeOf(text(assertion, "status")),
			);
		}
	}
	return { cases, unloaded };
}

/**
 * Whether the change's tests fail without its source. It holds on the
 * cases that pass at the head and fail undone; a case that fails at the
 * head never counts, since the head's own tests must pass first and
 * other gates say so, and nor does one that went missing or was
 * skipped undone. Where no case flipped it is unjudged, rather than
 * refused, in two places: when no changed test ran at the head at all
 * (a file only another lane runs, as the browser's), and when every
 * changed test file failed to load undone, as tests that reach only a
 * module the change adds do, where undoing proves nothing either way.
 */
export function judgeFailToPass(
	head: CaseResults,
	undone: CaseResults,
): FailToPass {
	const flipped = [...head.cases]
		.filter(
			([name, outcome]) =>
				outcome === "passed" && undone.cases.get(name) === "failed",
		)
		.map(([name]) => name);
	if (flipped.length > 0) return { held: true, cases: flipped };
	if (head.cases.size === 0) {
		return {
			held: "unjudged",
			why: "no changed test ran a case at the head, so none could fail undone",
		};
	}
	if (undone.cases.size === 0 && undone.unloaded.size > 0) {
		return {
			held: "unjudged",
			why: "every changed test file failed to load with the source undone, so they reach only what the change adds",
		};
	}
	return {
		held: false,
		why: "no case that passes at the head fails with the change's source undone",
	};
}

/**
 * The reason a head's `Fail-To-Pass: none, <reason>` trailer gives, read
 * from what `git interpret-trailers --parse` wrote (a `Key: value` line
 * a trailer), or undefined when no such trailer gives one. The key is
 * matched as git matches trailer keys, whatever its case.
 */
export function exemptionOf(trailers: string): string | undefined {
	for (const line of trailers.split("\n")) {
		const colon = line.indexOf(":");
		if (colon < 0) continue;
		const key = line.slice(0, colon).trim();
		if (key.toLowerCase() !== EXEMPT_TRAILER.toLowerCase()) continue;
		const value = line.slice(colon + 1).trim();
		if (!value.toLowerCase().startsWith(EXEMPT_OPENING)) continue;
		const reason = value.slice(EXEMPT_OPENING.length).trim();
		if (reason !== "") return reason;
	}
	return undefined;
}
