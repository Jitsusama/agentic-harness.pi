/**
 * A bash call's time limit measures its run, not its wait for a turn.
 *
 * pi's bash starts a call's clock when it spawns the shell, and a call
 * the machine's queue holds spends its first stretch in that shell
 * waiting for its turn (see turn.ts). The limit then counted the wait:
 * three hour-long jobs were killed at their hour having never started,
 * and the answer read like a hung build. A caller giving a limit means
 * how long the work may run, so for a call the queue holds the clock is
 * taken over here and started when the shell marks its turn begun. A
 * call the queue does not hold keeps pi's own clock, untouched.
 *
 * Nor does the limit count a stretch its cgroup spends frozen. The jobs
 * door freezes a scope through a call Joel is on, and a check frozen for
 * 26 minutes behind a 15-minute limit was killed the moment it thawed,
 * before any test ran. So the clock is counted a poll at a time, adding
 * only the polls its shell's cgroup ran through; it runs out within a
 * poll of its limit.
 *
 * Running out reads exactly as pi's own does, `Command timed out after N
 * seconds`, and the shell has already said how long it waited when the
 * wait was long enough to notice.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";

/** How often a held call looks for its turn's mark. */
const POLL_MS = 1_000;

/**
 * The queue folder and job a command waits under, read from the lines
 * the queue puts in front of it, or nothing for a command it does not
 * hold. Only the first line counts, which is where those lines start.
 */
export function queuedJobOf(
	command: string,
): { dir: string; id: string } | undefined {
	for (const line of command.split("\n", 3)) {
		const found = /^__queue='([^']*)' __job='([^']*)' __since=\$SECONDS$/.exec(
			line,
		);
		if (found?.[1] && found[2]) return { dir: found[1], id: found[2] };
	}
	return undefined;
}

/**
 * Whether the cgroup process `pid` runs in is frozen now, read from that
 * cgroup's `cgroup.events`. A process gone, or a machine without cgroup
 * v2, reads as running, so the clock counts as it always did.
 */
function frozenNow(pid: number): boolean {
	try {
		const group = /^0::(.*)$/m.exec(
			readFileSync(`/proc/${pid}/cgroup`, "utf8"),
		)?.[1];
		if (group === undefined) return false;
		const events = readFileSync(
			join("/sys/fs/cgroup", group, "cgroup.events"),
			"utf8",
		);
		return /^frozen 1$/m.test(events);
	} catch {
		// Nothing to read is nothing frozen: the limit counts, as it did.
		return false;
	}
}

/** The pid the queued shell wrote for itself (turn.ts), or nothing yet. */
function shellPidOf(dir: string, id: string): number | undefined {
	try {
		const pid = Number.parseInt(
			readFileSync(join(dir, `${id}.pid`), "utf8"),
			10,
		);
		return Number.isInteger(pid) && pid > 0 ? pid : undefined;
	} catch {
		// Not written, or already cleared: nothing to look at.
		return undefined;
	}
}

/**
 * `ops`, starting the time limit of a call the queue holds when its turn
 * begins rather than when its shell starts, and pausing it while the
 * shell's cgroup is frozen.
 */
export function timedFromTurn(
	ops: BashOperations,
	options: {
		pollMs?: number;
		/**
		 * The command as the agent's shell will run it, for a spawn hook
		 * that carries it somewhere other than the command line.
		 */
		commandOf?: (command: string, env: NodeJS.ProcessEnv | undefined) => string;
		/** Whether a pid's cgroup is frozen now; tests stand in for /proc. */
		frozen?: (pid: number) => boolean;
	} = {},
): BashOperations {
	const pollMs = options.pollMs ?? POLL_MS;
	const frozen = options.frozen ?? frozenNow;
	const commandOf = options.commandOf ?? ((command: string) => command);
	return {
		async exec(command, cwd, call) {
			const { timeout, signal } = call;
			const job = queuedJobOf(commandOf(command, call.env));
			// pi refuses a limit that is not a positive number of seconds, and
			// the refusal is its to give.
			if (
				!job ||
				timeout === undefined ||
				!Number.isFinite(timeout) ||
				timeout <= 0
			) {
				return await ops.exec(command, cwd, call);
			}
			const stop = new AbortController();
			const stopped = () => stop.abort();
			if (signal?.aborted) stop.abort();
			else signal?.addEventListener("abort", stopped, { once: true });
			const mark = join(job.dir, `${job.id}.began`);
			let timedOut = false;
			let ranMs = 0;
			let last: number | undefined;
			const watch = setInterval(() => {
				const now = Date.now();
				if (last === undefined) {
					if (existsSync(mark)) last = now;
					return;
				}
				const pid = shellPidOf(job.dir, job.id);
				if (pid === undefined || !frozen(pid)) ranMs += now - last;
				last = now;
				if (ranMs < timeout * 1000) return;
				clearInterval(watch);
				timedOut = true;
				stop.abort();
			}, pollMs);
			try {
				const { timeout: _counted, ...rest } = call;
				return await ops.exec(command, cwd, { ...rest, signal: stop.signal });
			} catch (error) {
				// pi words a stop and a limit differently, and only the caller's
				// own stop is a stop.
				if (
					timedOut &&
					!signal?.aborted &&
					error instanceof Error &&
					error.message === "aborted"
				) {
					throw new Error(`timeout:${timeout}`);
				}
				throw error;
			} finally {
				clearInterval(watch);
				signal?.removeEventListener("abort", stopped);
			}
		},
	};
}
