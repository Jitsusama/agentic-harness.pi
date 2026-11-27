/**
 * A pi runtime's proof: what scripts/host-prove.ts writes once `pnpm
 * test:host` has passed on that runtime with no case skipped but one only
 * another platform can run, and what a
 * host won't start without. World's bump writes it beside the runtime's
 * store path, core's host module refuses at evaluation a runtime the
 * proof doesn't name, and the host program checks it again as it starts.
 * Between them, no pi reaches a host unproven.
 *
 * It proves the pi, not the harness. The harness commit it names is only
 * a record of what ran; a harness change meets its own gate,
 * scripts/host-gate.sh, before it merges.
 */

import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { isRecord } from "../../lib/internal/record.ts";

/** The variable a host unit names its runtime's proof in. */
export const PROOF_VARIABLE = "PI_HOST_PROOF";

/** What a proof file says it is, so another JSON file isn't read as one. */
export const PROOF_KIND = "pi-host-runtime-proof";

/** The proof format this harness writes and reads. */
export const PROOF_VERSION = 1;

/** That a runtime passed every host check. */
export interface HostProof {
	readonly kind: typeof PROOF_KIND;
	readonly version: typeof PROOF_VERSION;
	/** The runtime's store path, the folder its pi-monorepo is under. */
	readonly runtime: string;
	/** The harness commit whose `pnpm test:host` passed on it. */
	readonly harness: string;
	/** How many test files ran, and how many cases, every one passing. */
	readonly files: number;
	readonly cases: number;
	/** When it passed, as an ISO time. */
	readonly provenAt: string;
}

/**
 * The key under which a host case's meta, in vitest's report, names the
 * one platform it runs on, once it skipped for running on another
 * (tests/host/end-to-end/support/only-on.mts writes it).
 */
export const ONLY_ON_KEY = "onlyOn";

/** The platforms Node names: the only ones a case may say it runs on alone. */
const PLATFORMS: ReadonlySet<string> = new Set<NodeJS.Platform>([
	"aix",
	"android",
	"cygwin",
	"darwin",
	"freebsd",
	"haiku",
	"linux",
	"netbsd",
	"openbsd",
	"sunos",
	"win32",
]);

/** Whether `name` is a platform Node names, so no made-up word lets a skip by. */
export function isPlatform(name: unknown): name is NodeJS.Platform {
	return typeof name === "string" && PLATFORMS.has(name);
}

/** The part of vitest's JSON report a proof is judged from. */
export interface RunSummary {
	readonly success: boolean;
	readonly numTotalTests: number;
	readonly numPassedTests: number;
	readonly numFailedTests: number;
	readonly numPendingTests: number;
	readonly numTodoTests: number;
	readonly testResults: readonly unknown[];
}

/** A proof as a file holds it, or why it isn't one. */
export function parseProof(text: string): HostProof {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error("The runtime's proof isn't JSON");
	}
	if (!isRecord(value) || value.kind !== PROOF_KIND)
		throw new Error(`The runtime's proof isn't a ${PROOF_KIND}`);
	if (value.version !== PROOF_VERSION)
		throw new Error(
			`The runtime's proof is version ${String(value.version)}; this host reads ${PROOF_VERSION}`,
		);
	const { runtime, harness, files, cases, provenAt } = value;
	if (
		!(
			typeof runtime === "string" &&
			isAbsolute(runtime) &&
			typeof harness === "string" &&
			typeof files === "number" &&
			typeof cases === "number" &&
			typeof provenAt === "string"
		)
	)
		throw new Error(
			"The runtime's proof lacks its runtime, harness, counts or time",
		);
	return {
		kind: PROOF_KIND,
		version: PROOF_VERSION,
		runtime,
		harness,
		files,
		cases,
		provenAt,
	};
}

/** The proof a host unit names, read and checked against its pi. */
export function hostProof(
	env: NodeJS.ProcessEnv,
	packageDir: string,
): HostProof {
	const file = env[PROOF_VARIABLE];
	if (!(file && isAbsolute(file)))
		throw new Error(
			`${PROOF_VARIABLE} must name the proof that pnpm test:host passed on this pi; prove it with node scripts/host-prove.ts ${runtimeOf(packageDir)}`,
		);
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		throw new Error(`${PROOF_VARIABLE} names ${file}, which can't be read`);
	}
	const proof = parseProof(text);
	const refused = proofRefusal(proof, packageDir);
	if (refused) throw new Error(refused);
	return proof;
}

/** Why a proof doesn't prove this pi, or nothing when it does. */
export function proofRefusal(
	proof: HostProof,
	packageDir: string,
): string | undefined {
	const pi = resolved(packageDir);
	const runtime = resolved(proof.runtime);
	if (pi.startsWith(`${runtime}/`)) return undefined;
	return `The runtime's proof is for ${proof.runtime}, not the pi at ${packageDir}; prove that pi with node scripts/host-prove.ts ${runtimeOf(packageDir)}`;
}

/**
 * Every case ran and passed, as a proof's counts, or why the run proves
 * nothing. The one skip let by is a case whose meta names another
 * platform as the only one it runs on, as the Mac's run skips those
 * reading Linux's /proc; the counts are of the cases that ran. Only
 * test:host's reporter knows the run's own platform, and it fails the run
 * for a case that skipped naming this one, so a failed run proves nothing
 * before its report is read. A run with no case run proves nothing either.
 */
export function provenBy(
	summary: RunSummary,
): { files: number; cases: number } | string {
	const skipped = summary.numPendingTests + summary.numTodoTests;
	const elsewhere = onlyElsewhere(summary);
	if (summary.numFailedTests > 0)
		return `${summary.numFailedTests} of ${summary.numTotalTests} cases failed`;
	if (skipped > elsewhere)
		return `${skipped - elsewhere} of ${summary.numTotalTests} cases skipped`;
	if (!summary.success) return "the run failed outside any case";
	if (summary.numPassedTests === 0) return "no case ran";
	if (summary.numPassedTests + elsewhere !== summary.numTotalTests)
		return `${summary.numPassedTests} of ${summary.numTotalTests} cases passed`;
	return { files: summary.testResults.length, cases: summary.numPassedTests };
}

/** How many of a report's cases skipped naming another platform as their own. */
function onlyElsewhere(summary: RunSummary): number {
	let count = 0;
	for (const file of summary.testResults) {
		if (!(isRecord(file) && Array.isArray(file.assertionResults))) continue;
		for (const one of file.assertionResults)
			if (
				isRecord(one) &&
				one.status === "skipped" &&
				isRecord(one.meta) &&
				isPlatform(one.meta[ONLY_ON_KEY])
			)
				count += 1;
	}
	return count;
}

/** The line scripts/host-run.sh prints before a whole run's JSON report. */
export const REPORT_FOLLOWS = "host-run: vitest's report follows";

/** The line scripts/host-run.sh prints after it. */
export const REPORT_ENDS = "host-run: vitest's report ends";

/**
 * What scripts/host-test-there.sh says as it starts a run, and as it
 * ends, with the commit, the runtime and the exit; its echo lines must
 * read so, as tests/host/service/proof.test.ts holds.
 */
const RUN_STARTS = /^host-test-there: test:host at (\S+) on (\S+)$/;
const RUN_ENDS = /^host-test-there: test:host at (\S+) on (\S+) exited (\d+)$/;

/** What a run's JSON report proves, or why it proves nothing. */
export function judgedReport(text: string): ReturnType<typeof provenBy> {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return "the run's report isn't JSON";
	}
	return isSummary(value) ? provenBy(value) : "the run's report isn't vitest's";
}

/**
 * What a lent run's whole log proves of `runtime` at harness `commit`,
 * or why it proves nothing. The log must be one run's alone: exactly
 * one start line from scripts/host-test-there.sh naming that commit and
 * runtime, then one report between REPORT_FOLLOWS and REPORT_ENDS, as
 * scripts/host-run.sh prints it, then one end line saying the run
 * exited 0. A log missing any of them, such as the fenced call's, which
 * prints only nix-offload's own output, proves nothing.
 */
export function judgedLog(
	log: string,
	commit: string,
	runtime: string,
): ReturnType<typeof provenBy> {
	// A relay that ends its lines with a carriage return changes nothing.
	const lines = log.split("\n").map((line) => line.replace(/\r$/, ""));
	const at = (find: (line: string) => boolean) =>
		lines.flatMap((line, index) => (find(line) ? [index] : []));
	const starts = at((line) => RUN_STARTS.test(line));
	const ends = at((line) => RUN_ENDS.test(line));
	const follows = at((line) => line === REPORT_FOLLOWS);
	const over = at((line) => line === REPORT_ENDS);
	const [start] = starts;
	const [end] = ends;
	const [from] = follows;
	const [to] = over;
	if (start === undefined || end === undefined)
		return "the log holds no start and end lines from host-test-there";
	if ([starts, ends, follows, over].some((found) => found.length > 1))
		return "the log holds more than one run";
	if (
		from === undefined ||
		to === undefined ||
		!(start < from && from < to && to < end)
	)
		return "the log holds no whole report inside its run";
	const [, ranCommit, ranRuntime] = RUN_STARTS.exec(lines[start] ?? "") ?? [];
	const [, endCommit, endRuntime, exit] = RUN_ENDS.exec(lines[end] ?? "") ?? [];
	const otherCommit = [ranCommit, endCommit].find((ran) => ran !== commit);
	if (otherCommit !== undefined || ranCommit === undefined)
		return `the log ran ${otherCommit}, not ${commit}`;
	const otherRuntime = [ranRuntime, endRuntime].find((ran) => ran !== runtime);
	if (otherRuntime !== undefined || ranRuntime === undefined)
		return `the log ran on ${otherRuntime}, not ${runtime}`;
	if (exit !== "0") return `the run exited ${exit}`;
	return judgedReport(lines.slice(from + 1, to).join("\n"));
}

function isSummary(value: unknown): value is RunSummary {
	return (
		isRecord(value) &&
		typeof value.success === "boolean" &&
		Array.isArray(value.testResults) &&
		[
			value.numTotalTests,
			value.numPassedTests,
			value.numFailedTests,
			value.numPendingTests,
			value.numTodoTests,
		].every((count) => typeof count === "number")
	);
}

/** The runtime store path a pi-monorepo folder sits in, for a refusal to name. */
export function runtimeOf(packageDir: string): string {
	const store = /^(\/nix\/store\/[^/]+)/.exec(resolved(packageDir));
	return store?.[1] ?? packageDir;
}

/**
 * A path with its links followed as far as it exists, so a pi that isn't
 * there still compares with its runtime through the same links.
 */
function resolved(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		// A pi that isn't there is refused by its loader, which says so;
		// here only the folders above it are followed.
		const parent = dirname(path);
		return parent === path ? path : join(resolved(parent), basename(path));
	}
}
