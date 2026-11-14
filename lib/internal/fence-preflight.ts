/**
 * The fence's pre-flight: the checks that must all pass, on the machine
 * it installs to, before the agent fence is turned on for anyone
 * (ISXEG8's reshaped reland, 14 November). Each runs a real path, as an
 * agent or the person would, fenced exactly as a session fences its
 * commands (`wrapFor`), or outside where the path is the person's own.
 *
 * A check passes, fails, or names what only a session can do with its
 * own tools (the work tool, review_offer, an install and its revert),
 * which the script can't. Any failure stops the install, and so does a
 * step a session hasn't done: the script answers 0 only when every
 * check passed here.
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { FENCE } from "./fence.ts";
import { SANDBOX_VARIABLE, sandboxFor, wrapFor } from "./sandbox.ts";

/** Who a check stands for: the person's paths, agents', or what stays refused. */
export type CheckGroup = "person" | "agents" | "refused";

/** How a check came out. */
export type Outcome = "passed" | "failed" | "in-session";

/** A check's verdict, with what it saw, in a line or a few. */
export interface Verdict {
	readonly outcome: Outcome;
	readonly said: string;
}

/** What every check is given. */
export interface PreflightContext {
	/** The pi session the pre-flight runs for, whose fence the commands get. */
	readonly session: string;
	/** The harness tree whose change is to install. */
	readonly repo: string;
	/** A folder the checks may write in, outside every checkout. */
	readonly scratch: string;
	/** A held core.nix tree, for the checks that need one. */
	readonly coreTree?: string;
	/** Whether to run the checks that send builds to the builders. */
	readonly heavy: boolean;
}

/** One check of the pre-flight. */
export interface Check {
	/** Its number in ISXEG8's list, with a letter for each part, e.g. `5a`. */
	readonly id: string;
	readonly group: CheckGroup;
	/** What it proves, in a line. */
	readonly what: string;
	run(context: PreflightContext): Promise<Verdict>;
}

/** How a command ran. */
export interface Ran {
	/** Its exit status; null when it was stopped, as by its time limit. */
	readonly code: number | null;
	readonly out: string;
	readonly err: string;
	readonly ms: number;
}

/** The most a command may print before it's cut off: 16 MiB. */
const MOST_OUTPUT = 16 * 1024 * 1024;

/** How long a command may take unless a check says otherwise. */
const USUAL_LIMIT_MS = 120_000;

/**
 * Run `script` in bash, in `cwd`, with `env`, within `limitMs`, in a
 * process group of its own that a time limit ends whole. It's done when
 * bash exits, not when every holder of its output lets go: wl-copy, for
 * one, stays behind to serve what it copied and keeps the output open.
 */
function bash(
	script: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
	limitMs: number,
): Promise<Ran> {
	const started = Date.now();
	return new Promise((resolve) => {
		const child = spawn("bash", ["-c", script], {
			cwd,
			env,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		const take = (into: "out" | "err") => (chunk: Buffer) => {
			if (out.length + err.length > MOST_OUTPUT) return;
			if (into === "out") out += chunk.toString();
			else err += chunk.toString();
		};
		child.stdout.on("data", take("out"));
		child.stderr.on("data", take("err"));
		const limit = setTimeout(() => {
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				// The group already ended between the limit and the kill.
			}
		}, limitMs);
		const done = (code: number | null) => {
			clearTimeout(limit);
			child.stdout.destroy();
			child.stderr.destroy();
			resolve({ code, out, err, ms: Date.now() - started });
		};
		child.on("error", (error) => {
			err += error.message;
			done(null);
		});
		child.on("exit", (code) => {
			// What bash printed last may still be in the pipe a moment.
			setImmediate(() => done(code));
		});
	});
}

/** Run `script` outside the fence, as the person's own shell would. */
export function outside(
	script: string,
	cwd: string,
	limitMs: number = USUAL_LIMIT_MS,
): Promise<Ran> {
	const env = { ...process.env };
	delete env[SANDBOX_VARIABLE];
	return bash(script, cwd, env, limitMs);
}

/**
 * Run `script` in the agent fence as `session`'s commands run, in `cwd`.
 * Throws when this machine can't fence a command, since then no fenced
 * check can mean anything.
 */
export function fenced(
	script: string,
	cwd: string,
	session: string,
	limitMs: number = USUAL_LIMIT_MS,
): Promise<Ran> {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		[SANDBOX_VARIABLE]: FENCE,
		PI_SESSION_ID: session,
	};
	const sandbox = sandboxFor(env);
	if (sandbox.kind !== "fence") {
		throw new Error(
			sandbox.kind === "refused"
				? `this machine can't fence a command: ${sandbox.reason}`
				: "this machine can't fence a command",
		);
	}
	const wrap = wrapFor(sandbox, { cwd, env }, homedir());
	if (!wrap) throw new Error("the fence gave no way to wrap a command");
	return bash(wrap(script), cwd, env, limitMs);
}

/** A verdict that passed, saying `said`. */
export function passed(said: string): Verdict {
	return { outcome: "passed", said };
}

/** A verdict that failed, saying `said`. */
export function failed(said: string): Verdict {
	return { outcome: "failed", said };
}

/** A verdict naming what a session must do with its own tools. */
export function inSession(said: string): Verdict {
	return { outcome: "in-session", said };
}

/** The last few lines a command printed, for a failure's line. */
export function tailOf(ran: Ran, lines = 4): string {
	const text = `${ran.out}\n${ran.err}`.trim().split("\n");
	return text.slice(-lines).join(" / ");
}

/** A verdict for a command that should succeed, saying what it is. */
export function succeeded(ran: Ran, what: string): Verdict {
	return ran.code === 0
		? passed(`${what} (${ran.ms} ms)`)
		: failed(
				`${what} exited ${ran.code ?? "stopped"} after ${ran.ms} ms: ${tailOf(ran)}`,
			);
}

/** A verdict for a command that must be refused, saying what it tried. */
export function refusedAs(ran: Ran, what: string): Verdict {
	return ran.code === 0
		? failed(`${what} wasn't refused: ${tailOf(ran)}`)
		: passed(`${what} refused (${tailOf(ran, 1)})`);
}

/** Every verdict, by check, in the order they ran. */
export type Verdicts = readonly (readonly [Check, Verdict])[];

/**
 * Run each of `checks` in turn, a throw counting as a failure, and
 * answer every verdict.
 */
export async function runChecks(
	checks: readonly Check[],
	context: PreflightContext,
	onEach: (check: Check, verdict: Verdict) => void = () => {},
): Promise<Verdicts> {
	const verdicts: (readonly [Check, Verdict])[] = [];
	for (const check of checks) {
		let verdict: Verdict;
		try {
			verdict = await check.run(context);
		} catch (error) {
			verdict = failed(
				`threw: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		verdicts.push([check, verdict]);
		onEach(check, verdict);
	}
	return verdicts;
}

/** The mark a report gives each outcome. */
const MARKS: Readonly<Record<Outcome, string>> = {
	passed: "pass",
	failed: "FAIL",
	"in-session": "TODO",
};

/** One line of the report, for a check and its verdict. */
export function reportLine(check: Check, verdict: Verdict): string {
	return `${MARKS[verdict.outcome]} ${check.id.padEnd(4)} ${check.what}: ${verdict.said}`;
}

/** The report's last line, counting each outcome. */
export function summary(verdicts: Verdicts): string {
	const count = (outcome: Outcome) =>
		verdicts.filter(([, verdict]) => verdict.outcome === outcome).length;
	const failures = count("failed");
	const left = count("in-session");
	const verdict =
		failures > 0
			? "the fence doesn't install"
			: left > 0
				? "the fence installs only once a session has done each TODO"
				: "every check passed";
	return `${count("passed")} passed, ${failures} failed, ${left} for a session to do: ${verdict}.`;
}

/**
 * The script's exit status: 1 when any check failed, 2 when none failed
 * but a session still has steps to do, 0 only when every check passed.
 */
export function exitStatus(verdicts: Verdicts): number {
	if (verdicts.some(([, verdict]) => verdict.outcome === "failed")) return 1;
	if (verdicts.some(([, verdict]) => verdict.outcome === "in-session")) {
		return 2;
	}
	return 0;
}
