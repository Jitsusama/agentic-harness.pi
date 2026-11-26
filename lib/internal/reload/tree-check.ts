/**
 * Whether a checkout of this package passes its own typecheck and the
 * tests its changes reach, asked before a reload onto it.
 *
 * The load check (load-check.ts) catches code that won't load. Code
 * that loads and is still wrong, a type that no longer fits or a
 * behaviour a test holds, reloads all the same, and the session then
 * runs it outside any test. So a tree is also put through the typecheck
 * and tests of `pnpm check` (not its lint, knip or browser lane):
 * `tsc --noEmit`, then `vitest run --changed` against the tree's own
 * origin/main, each from the tree's own node_modules. The first that
 * fails refuses the reload, naming its first type errors or its
 * failing tests.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { loadCheckEnvironment } from "./load-check.ts";

/** Which of the tree's checks a report is about. */
export type TreeStep = "typecheck" | "tests";

/** How one of the checks went. */
export interface StepReport {
	readonly step: TreeStep;
	readonly ok: boolean;
	/** What failed, a line each: type errors, or failing tests with their cause. */
	readonly failures: readonly string[];
	/** How many tests passed, for the tests' step once it ran whole. */
	readonly passed?: number;
	/** Why the step could not decide, when it could not. */
	readonly problem?: string;
}

/** How the tree's checks went, in the order they ran; a failed one ends them. */
export interface TreeReport {
	readonly ok: boolean;
	readonly steps: readonly StepReport[];
}

/** What running one command gave. */
export interface Ran {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
	/** Killed for running past its time. */
	readonly hung: boolean;
	/** Killed because whoever asked for it stopped. */
	readonly stopped?: boolean;
	/** Why it never started, when it didn't. */
	readonly unstarted?: string;
}

/**
 * Runs `command` with `args` in `cwd`, as the checks need it run,
 * ending it past `timeoutMs` or once `signal` aborts.
 */
export type Runner = (
	command: string,
	args: readonly string[],
	cwd: string,
	env: Readonly<Record<string, string>>,
	timeoutMs: number,
	signal?: AbortSignal,
) => Promise<Ran>;

/** How long each check may take before it counts as hung. */
export const TREE_STEP_TIMEOUT_MS: Readonly<Record<TreeStep, number>> = {
	typecheck: 5 * 60_000,
	tests: 15 * 60_000,
};

/** At most this many type errors or failing tests are named. */
export const MOST_NAMED = 10;

/** A named failure or problem longer than this is cut, since the tree's own text goes to the model as it is. */
export const MOST_LINE_CHARS = 400;

/** `line`, cut to MOST_LINE_CHARS with a mark that it was. */
function clipped(line: string): string {
	return line.length <= MOST_LINE_CHARS
		? line
		: `${line.slice(0, MOST_LINE_CHARS)} [cut]`;
}

/** What `--changed` measures a tree's change against. */
export const CHANGED_SINCE = "origin/main";

/** The line tsc writes for each error: where, its code and what it says. */
const TYPE_ERROR = /^(.+)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

/** The type errors tsc wrote, a line each, as `file:line: TSnnnn message`. */
export function typeErrors(stdout: string): string[] {
	const errors: string[] = [];
	for (const line of stdout.split("\n")) {
		const match = TYPE_ERROR.exec(line.trim());
		if (!match) continue;
		const [, file, row, , code, said] = match;
		errors.push(`${file}:${row}: ${code} ${said}`);
	}
	return errors;
}

/** The first line of `text` that says something. */
function firstLine(text: string): string {
	return (
		text
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line !== "") ?? ""
	);
}

/** A record's field, when the record is an object that has it. */
function field(record: unknown, key: string): unknown {
	if (typeof record !== "object" || record === null) return undefined;
	return key in record ? Reflect.get(record, key) : undefined;
}

/** A field read as a string, or empty. */
function text(record: unknown, key: string): string {
	const value = field(record, key);
	return typeof value === "string" ? value : "";
}

/** A field read as a list, or empty. */
function list(record: unknown, key: string): readonly unknown[] {
	const value = field(record, key);
	return Array.isArray(value) ? value : [];
}

/**
 * What vitest's JSON report says: each failing test as `file > name:
 * cause`, and each file that failed with no test failing (it would not
 * import, say) as `file: cause`, with files named within `tree`.
 */
export function testReport(
	json: string,
	tree: string,
): { readonly failures: string[]; readonly passed: number } | undefined {
	let report: unknown;
	try {
		report = JSON.parse(json);
	} catch {
		// A report cut short says nothing; the caller says why.
		return undefined;
	}
	const passedField = field(report, "numPassedTests");
	if (typeof passedField !== "number") return undefined;
	const failures: string[] = [];
	for (const file of list(report, "testResults")) {
		const name = relative(tree, text(file, "name"));
		let failedTests = 0;
		for (const test of list(file, "assertionResults")) {
			if (text(test, "status") !== "failed") continue;
			failedTests += 1;
			const [cause = ""] = list(test, "failureMessages").map(String);
			failures.push(`${name} > ${text(test, "fullName")}: ${firstLine(cause)}`);
		}
		if (failedTests === 0 && text(file, "status") === "failed") {
			failures.push(`${name}: ${firstLine(text(file, "message"))}`);
		}
	}
	return { failures, passed: passedField };
}

/**
 * How long a stopped command's group has to end on SIGTERM before it is
 * killed outright: long enough for vitest's teardown to remove the temp
 * root its globalSetup made.
 */
const STOP_GRACE_MS = 5000;

/**
 * How long a command's output may stay open once it has exited, before
 * whatever still holds its pipes is let go: a process that left the
 * group, or one of the group's own the kill at its exit missed.
 */
const CLOSE_GRACE_MS = 5000;

/**
 * How much of each stream is held, in characters. A check that says
 * more than this is stopped rather than grow the session's own memory.
 */
const MOST_HELD_CHARS = 32 * 1024 * 1024;

/** The groups the checks are running, ended with this process. */
const running = new Set<number>();

let endsWithProcess = false;

/** Kill whatever checks still run when this process exits, since they run in groups of their own that nothing else ends. */
function endWithProcess(): void {
	if (endsWithProcess) return;
	endsWithProcess = true;
	process.once("exit", () => {
		for (const leader of running) signalGroup(leader, "SIGKILL");
	});
}

/** Signal every process in the group `leader` leads. */
function signalGroup(leader: number | undefined, how: NodeJS.Signals): void {
	if (leader === undefined) return;
	try {
		process.kill(-leader, how);
	} catch {
		// The group has already gone, which is what the signal was for.
	}
}

/** What a check's timers may be set to, in place of the defaults. */
export interface RunTimings {
	readonly stopGraceMs?: number;
	readonly closeGraceMs?: number;
	readonly mostHeldChars?: number;
}

/**
 * Runs a command in a process group of its own, collecting its output
 * as UTF-8. Past `timeoutMs`, once `signal` aborts, or once a stream
 * passes `mostHeldChars`, the group is sent SIGTERM and, past
 * `stopGraceMs`, SIGKILL. When the command exits, what it left in its
 * group is killed, and once `closeGraceMs` passes with its output still
 * held open by something outside the group, the run ends with what was
 * read, so no process the check started can hold it open.
 */
export function commandRunner(timings: RunTimings = {}): Runner {
	const stopGrace = timings.stopGraceMs ?? STOP_GRACE_MS;
	const closeGrace = timings.closeGraceMs ?? CLOSE_GRACE_MS;
	const most = timings.mostHeldChars ?? MOST_HELD_CHARS;
	return (command, args, cwd, env, timeoutMs, signal) =>
		new Promise((resolve) => {
			if (signal?.aborted) {
				resolve({
					code: null,
					stdout: "",
					stderr: "",
					hung: false,
					stopped: true,
				});
				return;
			}
			const child = spawn(command, [...args], {
				cwd,
				env,
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
			const leader = child.pid;
			if (leader !== undefined) {
				endWithProcess();
				running.add(leader);
			}
			let stdout = "";
			let stderr = "";
			let hung = false;
			let stopped = false;
			let tooMuch = false;
			let exited: number | null | undefined;
			let settled = false;
			let ending = false;
			const timers: NodeJS.Timeout[] = [];
			const end = (): void => {
				if (ending) return;
				ending = true;
				signalGroup(leader, "SIGTERM");
				timers.push(
					setTimeout(() => signalGroup(leader, "SIGKILL"), stopGrace),
				);
			};
			const held = (said: string, chunk: string): string => {
				if (said.length + chunk.length <= most) return said + chunk;
				tooMuch = true;
				end();
				return said + chunk.slice(0, Math.max(0, most - said.length));
			};
			child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
				stdout = held(stdout, chunk);
			});
			child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
				stderr = held(stderr, chunk);
			});
			const budget = setTimeout(() => {
				hung = true;
				end();
			}, timeoutMs);
			timers.push(budget);
			const stop = (): void => {
				stopped = true;
				end();
			};
			signal?.addEventListener("abort", stop, { once: true });
			const settle = (ran: Ran): void => {
				if (settled) return;
				settled = true;
				for (const timer of timers) clearTimeout(timer);
				signal?.removeEventListener("abort", stop);
				// Whatever is left of the group goes with the run.
				signalGroup(leader, "SIGKILL");
				if (leader !== undefined) running.delete(leader);
				child.stdout.destroy();
				child.stderr.destroy();
				resolve(ran);
			};
			const ended = (code: number | null): Ran => ({
				code,
				stdout,
				stderr: tooMuch
					? `${stderr}\n${command} was stopped: it said more than ${most} characters`
					: stderr,
				hung,
				stopped,
			});
			child.on("error", (error) => {
				settle({
					code: null,
					stdout,
					stderr,
					hung: false,
					unstarted: error.message,
				});
			});
			child.on("exit", (code) => {
				exited = code;
				// A command that has exited ran within its time, whatever
				// still holds its output through the grace below.
				clearTimeout(budget);
				// What the command left running in its group, such as a
				// worker, would hold its output open until the budget ran out.
				signalGroup(leader, "SIGKILL");
				timers.push(
					setTimeout(() => settle(ended(exited ?? null)), closeGrace),
				);
			});
			// `close` once the output is all read; the grace above ends the run
			// when something outside the group keeps it from closing.
			child.on("close", (code) => {
				settle(ended(exited === undefined ? code : exited));
			});
		});
}

/** The runner the checks use unless given another. */
export const runCommand: Runner = commandRunner();

/** The first line of `text` that names an error, else its first line. */
function causeIn(text: string): string {
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
	return lines.find((line) => /error/i.test(line)) ?? lines[0] ?? "";
}

/** Why a step ended without a verdict, from how its command ended. */
function endedWithout(ran: Ran, timeoutMs: number): string {
	if (ran.stopped) return "it was stopped before it finished";
	if (ran.unstarted !== undefined) {
		return `it could not start: ${ran.unstarted}`;
	}
	if (ran.hung) {
		return `it was still running after ${Math.ceil(timeoutMs / 1000)}s`;
	}
	const said = causeIn(ran.stderr) || causeIn(ran.stdout);
	return `it exited with ${ran.code ?? "a signal"}${said ? `: ${said}` : ""}`;
}

/** What the steps share: where they run, with what, and when to stop. */
interface StepContext {
	readonly tree: string;
	readonly env: Readonly<Record<string, string>>;
	readonly run: Runner;
	readonly timeoutMs: (step: TreeStep) => number;
	readonly signal?: AbortSignal;
}

/** Where a program the tree installs would be. */
function program(tree: string, name: string): string {
	return join(tree, "node_modules", ".bin", name);
}

/** The tree's typecheck, as `pnpm typecheck` runs it. */
async function typecheck({
	tree,
	env,
	run,
	timeoutMs,
	signal,
}: StepContext): Promise<StepReport> {
	const budget = timeoutMs("typecheck");
	const tsc = program(tree, "tsc");
	if (!existsSync(tsc)) {
		return {
			step: "typecheck",
			ok: false,
			failures: [],
			problem:
				"it has no node_modules/.bin/tsc, so install or link its node_modules",
		};
	}
	const ran = await run(tsc, ["--noEmit"], tree, env, budget, signal);
	const failures = typeErrors(ran.stdout);
	const cut = ran.hung || ran.stopped === true;
	if (ran.code === 0 && !cut) return { step: "typecheck", ok: true, failures };
	// A typecheck cut short says so even when it named errors first, since
	// those may be only some of them.
	return {
		step: "typecheck",
		ok: false,
		failures,
		...(failures.length > 0 && !cut
			? {}
			: { problem: endedWithout(ran, budget) }),
	};
}

/** How long git may take to say whether the tree has its base. */
const BASE_LOOK_MS = 60_000;

/**
 * Whether the tree has the ref `--changed` measures against: "has",
 * "lacks" when git says it has no such commit (`--quiet` exits 1), or
 * why git couldn't say, when it was stopped, hung, wouldn't start or
 * failed some other way.
 */
async function baseOf({
	tree,
	env,
	run,
	timeoutMs,
	signal,
}: StepContext): Promise<"has" | "lacks" | { readonly problem: string }> {
	const budget = Math.min(BASE_LOOK_MS, timeoutMs("tests"));
	const ran = await run(
		"git",
		["rev-parse", "--verify", "--quiet", `${CHANGED_SINCE}^{commit}`],
		tree,
		env,
		budget,
		signal,
	);
	const cut = ran.hung || ran.stopped === true || ran.unstarted !== undefined;
	if (!cut && ran.code === 0) return "has";
	if (!cut && ran.code === 1) return "lacks";
	return {
		problem: `git could not say whether it has ${CHANGED_SINCE}: ${endedWithout(ran, budget)}`,
	};
}

/** The tests the tree's changes reach, as `pnpm test:changed` runs them. */
async function changedTests(
	context: StepContext,
	sandbox: string,
): Promise<StepReport> {
	const { tree, env, run, signal } = context;
	const budget = context.timeoutMs("tests");
	const vitest = program(tree, "vitest");
	if (!existsSync(vitest)) {
		return {
			step: "tests",
			ok: false,
			failures: [],
			problem:
				"it has no node_modules/.bin/vitest, so install or link its node_modules",
		};
	}
	const base = await baseOf(context);
	if (base !== "has") {
		return {
			step: "tests",
			ok: false,
			failures: [],
			problem:
				base === "lacks"
					? `it has no ${CHANGED_SINCE} to measure its change against, so fetch origin in it`
					: base.problem,
		};
	}
	const out = join(sandbox, "tests.json");
	const ran = await run(
		vitest,
		[
			"run",
			"--changed",
			CHANGED_SINCE,
			"--passWithNoTests",
			"--reporter=json",
			`--outputFile=${out}`,
		],
		tree,
		env,
		budget,
		signal,
	);
	const read = existsSync(out)
		? testReport(readFileSync(out, "utf8"), tree)
		: undefined;
	if (read === undefined || ran.hung || ran.stopped === true) {
		return {
			step: "tests",
			ok: false,
			failures: read?.failures ?? [],
			problem: endedWithout(ran, budget),
		};
	}
	const ok = ran.code === 0 && read.failures.length === 0;
	return {
		step: "tests",
		ok,
		failures: read.failures,
		passed: read.passed,
		...(ok || read.failures.length > 0
			? {}
			: { problem: endedWithout(ran, budget) }),
	};
}

/** What the tree check may be given in place of what it would use. */
export interface TreeCheckOptions {
	readonly run?: Runner;
	/** One budget for every step, in place of each step's own. */
	readonly timeoutMs?: number;
	/** Said as each step starts, with how long it may take. */
	readonly onStep?: (step: TreeStep, budgetMs: number) => void;
	/** Ends whichever step is running, and starts no other. */
	readonly signal?: AbortSignal;
}

/**
 * Put `tree` through its typecheck, then the tests its changes reach,
 * stopping at the first that fails. Both run with their own state,
 * data, cache and runtime folders, as the load check's pi does, since
 * the code under check is often unmerged.
 */
export async function checkTree(
	tree: string,
	options: TreeCheckOptions = {},
): Promise<TreeReport> {
	const { timeoutMs: every, signal } = options;
	const timeoutMs = (step: TreeStep): number =>
		every ?? TREE_STEP_TIMEOUT_MS[step];
	const sandbox = mkdtempSync(join(tmpdir(), "tree-check-sandbox-"));
	try {
		const context: StepContext = {
			tree,
			env: loadCheckEnvironment(process.env, sandbox),
			run: options.run ?? runCommand,
			timeoutMs,
			...(signal ? { signal } : {}),
		};
		options.onStep?.("typecheck", timeoutMs("typecheck"));
		const types = await typecheck(context);
		if (!types.ok) return { ok: false, steps: [types] };
		if (signal?.aborted) {
			const stopped: StepReport = {
				step: "tests",
				ok: false,
				failures: [],
				problem: "it was stopped before it started",
			};
			return { ok: false, steps: [types, stopped] };
		}
		options.onStep?.("tests", timeoutMs("tests"));
		const tests = await changedTests(context, sandbox);
		return { ok: tests.ok, steps: [types, tests] };
	} finally {
		rmSync(sandbox, { recursive: true, force: true });
	}
}

/** How a step is named where a person reads it. */
const STEP_NAMES: Record<TreeStep, string> = {
	typecheck: "Its typecheck",
	tests: `The tests its changes reach (vitest --changed ${CHANGED_SINCE})`,
};

/** The report as lines a person or a model reads. */
export function describeTree(report: TreeReport, tree: string): string {
	const failed = report.steps.find((step) => !step.ok);
	if (failed === undefined) {
		const tests = report.steps.find((step) => step.step === "tests");
		return `${tree} passes its typecheck and the ${tests?.passed ?? 0} tests its changes reach.`;
	}
	const lines = [`${tree} fails a check. ${STEP_NAMES[failed.step]} failed`];
	lines[0] += failed.problem ? `: ${clipped(failed.problem)}.` : ":";
	for (const failure of failed.failures.slice(0, MOST_NAMED)) {
		lines.push(`- ${clipped(failure)}`);
	}
	const more = failed.failures.length - MOST_NAMED;
	if (more > 0) lines.push(`- and ${more} more`);
	return lines.join("\n");
}
