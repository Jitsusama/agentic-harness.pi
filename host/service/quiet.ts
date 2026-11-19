/**
 * Whether the person can take a host's restart now, asked of the probes
 * its unit names: a call on, a meeting near. The harness knows no such
 * program itself, so a machine's configuration names each in
 * PI_HOST_RESTART_WAITS_ON, as JSON: a list of `{ "while": "a call is
 * on", "run": ["/path/to/a-call-is-on"] }`. A probe exits 1 when nothing
 * holds the restart, as a-call-is-on and a-meeting-is-near do; any other
 * exit holds it, and one that won't run or doesn't answer in time means
 * it can't tell, which holds it too. Probes run as their own processes,
 * never on the host's thread.
 */

import { execFile } from "node:child_process";

/** The unit's variable naming the probes a restart waits on. */
export const RESTART_WAITS_ON_VARIABLE = "PI_HOST_RESTART_WAITS_ON";

/** How long a probe has to answer; a-meeting-is-near's own asks give up within about 5 s. */
export const PROBE_ANSWER_MS = 15_000;

/** The exit by which a probe says nothing holds the restart. */
const CLEAR_EXIT = 1;

/** One probe: what it holds the restart for, in words, and the command that asks. */
interface Probe {
	readonly while: string;
	readonly run: readonly [string, ...string[]];
}

/**
 * The function that says why the person can't take a restart now, from
 * the probes `named` (the variable's JSON), or nothing when it names
 * none. Each answer runs every probe at once, naming every one that
 * holds it.
 */
export function quietFrom(
	named: string | undefined,
	options: { answerMs?: number } = {},
): (() => Promise<string | undefined>) | undefined {
	if (named === undefined || named.trim() === "") return undefined;
	const answerMs = options.answerMs ?? PROBE_ANSWER_MS;
	let probes: readonly Probe[];
	try {
		probes = probesIn(JSON.parse(named));
	} catch (error) {
		const unreadable = new Error(
			`${RESTART_WAITS_ON_VARIABLE} names no probes it can read: ${String(error)}`,
		);
		return async () => {
			throw unreadable;
		};
	}
	return async () => {
		const held = await Promise.all(
			probes.map(async (probe) =>
				(await exitOf(probe.run, answerMs)) === CLEAR_EXIT
					? undefined
					: probe.while,
			),
		);
		const holding = held.filter((why) => why !== undefined);
		return holding.length > 0 ? holding.join(", and ") : undefined;
	};
}

/** The probes a parsed value lists, or a throw saying why it lists none. */
function probesIn(value: unknown): readonly Probe[] {
	if (!Array.isArray(value)) throw new Error("not a list");
	return value.map((entry, at) => {
		if (
			typeof entry !== "object" ||
			entry === null ||
			typeof entry.while !== "string" ||
			!Array.isArray(entry.run) ||
			entry.run.length === 0 ||
			!entry.run.every((word: unknown) => typeof word === "string")
		)
			throw new Error(`probe ${at + 1} needs a "while" and a "run"`);
		const [program, ...args]: string[] = entry.run;
		if (program === undefined) throw new Error(`probe ${at + 1} runs nothing`);
		return { while: entry.while, run: [program, ...args] };
	});
}

/** The exit code `run` ends with, or a throw when it won't run or doesn't answer within `answerMs`. */
function exitOf(
	run: readonly [string, ...string[]],
	answerMs: number,
): Promise<number> {
	const [program, ...args] = run;
	return new Promise((resolve, reject) => {
		execFile(
			program,
			args,
			{ timeout: answerMs, killSignal: "SIGKILL" },
			(error) => {
				if (error === null) resolve(0);
				else if (error.killed)
					reject(new Error(`${program} didn't answer within ${answerMs} ms`));
				// An exit's code is a number; a spawn that failed, such as ENOENT, names its error.
				else if (typeof error.code === "number") resolve(error.code);
				else reject(new Error(`${program} won't run: ${String(error)}`));
			},
		);
	});
}
