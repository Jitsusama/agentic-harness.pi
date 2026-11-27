/**
 * How a host tells systemd what it is doing: a step's ask for more time,
 * the ready and the read-back of the unit's state that says systemd took
 * it, the watchdog's pings and the unit's status. run.ts says when; this
 * says how, each telling a systemd-notify bounded so one that hangs can't
 * hold the host, and sent from the host's own cgroup so systemd credits
 * it to the host's unit.
 */

import { type ExecFileException, execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { withPi } from "../../lib/internal/process/stays-with-pi.ts";
import { isRecord } from "../../lib/internal/record.ts";
import { firstLine } from "./status.ts";

/**
 * How long systemd is asked to wait from each step a start reaches: the
 * slowest conversation seen took 13 s of work, and this lets one take that
 * at a ninth of a CPU, while a start stuck in one step still ends.
 */
export const STEP_ALLOWANCE_MS = 120_000;

/**
 * How many times the host pings systemd's watchdog in each of its
 * timeouts. systemd advises two; four leaves room for a systemd-notify
 * that starts late on a starved machine, as on 11 November, when 13 s of
 * work took 96 s.
 */
export const PINGS_PER_TIMEOUT = 4;

/**
 * How late a watchdog beat may come before the journal says the loop
 * held: the longest a live host kept a request waiting through the night
 * of 12 November was 3.3 s, so this names only what passes a busy night.
 */
const LATE_BEAT_MS = 5000;
const HALF = 2;

const MICROSECONDS_PER_MS = 1000;

/**
 * How long systemd has to take a ready before the host reads the unit's
 * state, in ms. At 02:09:51 on 19 November a ready went unheard and the
 * unit sat activating until its start timeout killed the host; reading
 * the state a second on, and telling it again, mends that whatever lost
 * the first.
 */
export const READY_TAKEN_MS = 1000;
/** How many times the host tells systemd it's ready before it gives up. */
const READY_TELLINGS = 10;
/** How long systemctl has to say a unit's state, in ms. */
const UNIT_STATE_WITHIN_MS = 5000;
/**
 * How long one telling of systemd has, in ms, before its systemd-notify
 * is killed and the telling fails (a ready's counts as missed), so a
 * notifier that hangs can't hold the start, a step or the stop for good.
 * Twice systemd-notify's own wait for the manager's barrier, so a slow
 * manager answers before the kill.
 */
export const TOLD_WITHIN_MS = 10_000;
/** The states that say systemd took a ready: the unit is up. */
const READY_TAKEN_STATES: ReadonlySet<string> = new Set([
	"active",
	"reloading",
	"refreshing",
]);
/** The errors that say systemd-notify can't run at all, so no telling can. */
const CANNOT_RUN: ReadonlySet<unknown> = new Set(["ENOENT", "EACCES"]);
/** The state of a unit still waiting for its ready. */
const WAITING_STATE = "activating";

/** Asks systemd for STEP_ALLOWANCE_MS more of the start, from now. */
const STEP_EXTENSION = `EXTEND_TIMEOUT_USEC=${STEP_ALLOWANCE_MS * MICROSECONDS_PER_MS}`;

/**
 * How often, in ms, to tell systemd's watchdog the loop still turns, when
 * it watches this process; undefined when it doesn't.
 */
export function watchdogEvery(
	env: NodeJS.ProcessEnv,
	pid: number = process.pid,
): number | undefined {
	const timeout = Number(env.WATCHDOG_USEC);
	if (!Number.isFinite(timeout) || timeout <= 0) return undefined;
	// A child given the host's environment isn't the process systemd watches.
	if (env.WATCHDOG_PID !== undefined && Number(env.WATCHDOG_PID) !== pid)
		return undefined;
	return timeout / MICROSECONDS_PER_MS / PINGS_PER_TIMEOUT;
}

/**
 * Ask systemd for STEP_ALLOWANCE_MS more from now and show the step as the
 * unit's status, when it runs the host as a notify unit.
 */
export function notifyProgress(
	env: NodeJS.ProcessEnv,
	status: string,
	within: number,
): Promise<void> {
	return tellSystemd(env, [STEP_EXTENSION, `STATUS=${status}`], within);
}

/**
 * Run systemd-notify with `args`, when the host runs as a notify unit,
 * from the host's own cgroup. systemd credits a notify to the unit whose
 * cgroup its sender is in, and a hosted conversation's priority-workflow
 * writes every child this process spawns into jobs.service: on 11
 * November the background host's ready went to jobs.service whenever the
 * move landed first, and systemd stopped the host at its start timeout.
 * A systemd-notify still running `within` ms on is killed outright, as
 * one that ignored a gentler signal would still hold the telling, and the
 * telling fails.
 */
function tellSystemd(
	env: NodeJS.ProcessEnv,
	args: readonly string[],
	within: number,
): Promise<void> {
	if (!env.NOTIFY_SOCKET) return Promise.resolve();
	return new Promise((resolve, reject) => {
		withPi(() =>
			execFile(
				"systemd-notify",
				args,
				{ env, timeout: within, killSignal: "SIGKILL" },
				(error, _stdout, stderr) =>
					error ? reject(notifyFailure(error, stderr, within)) : resolve(),
			),
		);
	});
}

/**
 * Why a telling failed, in systemd-notify's own words where it gave any,
 * rather than execFile's "Command failed" and the command it ran, keeping
 * the error's code and whether the host killed it.
 */
function notifyFailure(
	error: ExecFileException,
	stderr: string,
	within: number,
): Error {
	const why = firstLine(stderr);
	const said =
		error.killed === true
			? `systemd-notify hung, and the host killed it ${within} ms on`
			: typeof error.code === "number"
				? `systemd-notify ended with ${error.code}${why ? `: ${why}` : ""}`
				: `systemd-notify couldn't run: ${firstLine(error)}`;
	return Object.assign(new Error(said, { cause: error }), {
		code: error.code,
		killed: error.killed === true,
	});
}

/**
 * Tell systemd the host listens, and what it serves as the unit's status,
 * when it runs the host as a notify unit. Ready alone left the status at
 * the last start step: on 12 November attended still read "building the
 * engine" hours after it started.
 */
export async function notifyReady(
	env: NodeJS.ProcessEnv,
	status: string,
	confirm: ReadyConfirm,
): Promise<void> {
	if (!env.NOTIFY_SOCKET) return;
	const { unit, taken, toldWithin, say, stopping } = confirm;
	const args = ["--ready", `STATUS=${status}`];
	// With no unit to read, a hung telling still can't hold the start.
	if (unit === undefined)
		return tellSystemd(env, args, toldWithin).catch((error: unknown) => {
			throw new Error(
				`telling systemd the host is ready: ${firstLine(error)}`,
				{ cause: error },
			);
		});
	let lastFailed: string | undefined;
	for (let telling = 1; ; telling++) {
		lastFailed = undefined;
		try {
			// A ready told again asks for the start's time again, as the
			// unit still reads activating, so ten tellings that each hang
			// can't outlast what the last step was given.
			await tellSystemd(
				env,
				telling === 1 ? args : [...args, STEP_EXTENSION],
				toldWithin,
			);
		} catch (error) {
			// A notifier that can't run at all fails every telling the same.
			if (isRecord(error) && CANNOT_RUN.has(error.code))
				throw new Error(
					`telling systemd the host is ready couldn't run systemd-notify: ${firstLine(error)}`,
				);
			// One that failed or hung is a miss like any other: the unit's
			// state still says whether systemd has the ready.
			lastFailed = firstLine(error);
			say(`telling systemd the host is ready: ${lastFailed}`);
		}
		// systemd takes a notify off its socket in its own time.
		await new Promise((resolve) => setTimeout(resolve, taken));
		let state: string;
		try {
			state = await unitState(env, unit);
		} catch (error) {
			// A telling known to have failed is never trusted.
			if (lastFailed !== undefined)
				throw new Error(
					`telling systemd the host is ready failed, and its unit can't be read: ${lastFailed}; ${firstLine(error)}`,
					{ cause: error },
				);
			say(
				`couldn't read whether systemd took the host's ready, so trusting it: ${firstLine(error)}`,
			);
			return;
		}
		if (READY_TAKEN_STATES.has(state)) {
			if (telling > 1)
				say(`systemd took the host's ready on its ${ordinal(telling)} telling`);
			return;
		}
		// A host that has begun to stop needs no ready, whatever its unit
		// reads: deactivating is its own stop.
		if (stopping()) return;
		// Failed, inactive or deactivating: the unit is going or gone, so
		// telling it again can't help, and nothing says systemd took it.
		if (state !== WAITING_STATE) {
			say(
				`systemd didn't take the host's ready: ${unit} reads ${state || "nothing"}, so the host stops telling it`,
			);
			return;
		}
		if (telling >= READY_TELLINGS)
			throw new Error(
				`systemd didn't take the host's ready in ${READY_TELLINGS} tellings: ${unit} still reads ${state}${lastFailed ? `; the last telling: ${lastFailed}` : ""}`,
			);
		say(
			`systemd didn't take the host's ready: ${unit} still reads ${state}, so telling it again (${telling + 1} of ${READY_TELLINGS})`,
		);
	}
}

/** What a ready needs to see systemd took it. */
interface ReadyConfirm {
	/** The unit whose state says it, or none when the host isn't in one. */
	readonly unit: string | undefined;
	/** How long, in ms, systemd has to take each telling. */
	readonly taken: number;
	/** How long, in ms, each telling has before it's killed as hung. */
	readonly toldWithin: number;
	/** Where each miss is journalled. */
	readonly say: (line: string) => void;
	/** Whether the host has begun to stop, when a ready no longer matters. */
	readonly stopping: () => boolean;
}

/**
 * The service unit this process runs in, from its cgroup, or none when it
 * runs in no service: a scope or a test's shell.
 */
export function ownUnit(): string | undefined {
	let text: string;
	try {
		text = readFileSync("/proc/self/cgroup", "utf8");
	} catch {
		// No /proc, as off Linux, where no systemd waits on a ready.
		return undefined;
	}
	return serviceOfCgroup(text);
}

/**
 * The service a process runs in, from its /proc/<pid>/cgroup text: the
 * leaf of its unified hierarchy's path, when that is a service; none for
 * a scope, a slice, or a process with no unified hierarchy.
 */
export function serviceOfCgroup(text: string): string | undefined {
	const path = text
		.split("\n")
		.find((line) => line.startsWith("0::"))
		?.slice(3);
	const leaf = path?.split("/").filter(Boolean).at(-1);
	return leaf?.endsWith(".service") ? leaf : undefined;
}

/** The unit's ActiveState, as the user's systemd says it. */
function unitState(env: NodeJS.ProcessEnv, unit: string): Promise<string> {
	const args = [
		"--user",
		"show",
		"--property=ActiveState",
		"--value",
		"--",
		unit,
	];
	return new Promise((resolve, reject) => {
		withPi(() =>
			execFile(
				"systemctl",
				args,
				{ env, timeout: UNIT_STATE_WITHIN_MS },
				(error, stdout, stderr) => {
					if (!error) {
						resolve(String(stdout).trim());
						return;
					}
					const told = String(stderr).trim().split("\n")[0] ?? "";
					const code = error.code ?? error.signal ?? "an error";
					reject(
						new Error(
							`systemctl ended with ${code}${told ? `: ${told}` : ""}`,
							{
								cause: error,
							},
						),
					);
				},
			),
		);
	});
}

/** 2nd, 3rd, 4th, 11th: how the journal counts a telling. */
function ordinal(n: number): string {
	const tens = n % 100;
	if (tens >= 11 && tens <= 13) return `${n}th`;
	return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/**
 * Tell systemd's watchdog the host's loop still turns, killing a
 * systemd-notify that hasn't ended `within` ms on.
 */
export function notifyAlive(
	env: NodeJS.ProcessEnv,
	within: number,
): Promise<void> {
	return tellSystemd(env, ["WATCHDOG=1"], within);
}

/**
 * Ping every `every` ms from the host's own loop, until the answer is
 * called. A conversation's work is awaited rather than run on the loop,
 * so a turn of any length leaves it free to ping, and only a loop that
 * stops turning goes quiet, for systemd to restart. Each ping is given
 * one beat. One still on its way when the next is due is let be for that
 * beat rather than joined by another, and the beat after pings anyway,
 * so a systemd-notify that never ends can't silence a healthy host.
 * A beat that comes late by more than LATE_BEAT_MS, or half the timeout
 * when that is less, is `held`, so a stall short of a kill leaves a
 * trace saying how long it was, and it pings whatever is on its way: a
 * turn of the loop runs its timers before the poll that reads a ping's
 * end, so the ping before a hold looks unanswered when it may long since
 * have reached systemd. Skipping then would leave systemd waiting the
 * hold and two beats, and a hold of about two beats would end the host
 * after its loop had turned again.
 */
export function keepAlive(options: {
	ping: (within: number) => Promise<void>;
	every: number;
	report: (error: unknown) => void;
	held: (late: number) => void;
}): () => void {
	const timeout = options.every * PINGS_PER_TIMEOUT;
	const noted = Math.min(LATE_BEAT_MS, timeout / HALF);
	// The newest ping, and whether it's still on its way and has had its beat.
	let newest = 0;
	let pinging = false;
	let waited = false;
	let last = performance.now();
	const beat = setInterval(() => {
		const now = performance.now();
		const late = now - last - options.every;
		last = now;
		const stalled = late > noted;
		if (stalled) options.held(late);
		if (pinging && !waited && !stalled) {
			waited = true;
			return;
		}
		newest += 1;
		const ping = newest;
		pinging = true;
		waited = false;
		options
			.ping(options.every)
			.catch(options.report)
			.finally(() => {
				if (ping === newest) pinging = false;
			});
	}, options.every);
	beat.unref();
	return () => clearInterval(beat);
}

/** Show what the host serves as the unit's status, once it changes. */
export function notifyStatus(
	env: NodeJS.ProcessEnv,
	status: string,
	within: number,
): Promise<void> {
	return tellSystemd(env, [`STATUS=${status}`], within);
}
