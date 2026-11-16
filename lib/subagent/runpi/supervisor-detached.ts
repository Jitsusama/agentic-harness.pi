/**
 * The runner that starts a reviewer and walks away: it writes the
 * request, spawns a supervisor in its own process group with nothing
 * held open, and answers with where to find the run.
 */

import { spawn as nodeSpawn } from "node:child_process";
import type { RunPi } from "../subagent.ts";
import {
	type SupervisorRunPiConfig,
	type SupervisorSpawnFn,
	supervisorEnvironment,
	supervisorPlaces,
	told,
} from "./supervisor-request.ts";

/** A reviewer that was started and is nobody's to wait for. */
export interface StartedPi {
	readonly runId: string;
	readonly reviewerId: string;
	/** The supervisor's pid, or undefined if the OS never gave one. */
	readonly pid: number | undefined;
	/** Where the supervisor was told what to do. */
	readonly requestPath: string;
}

/** Start a reviewer without waiting for it. */
export type StartPi = (options: Parameters<RunPi>[0]) => Promise<StartedPi>;

/** Build a `StartPi` that leaves the reviewer running on its own. */
export function createSupervisorStartPi(
	config: SupervisorRunPiConfig,
): StartPi {
	const spawnFn = config.spawn ?? (nodeSpawn as SupervisorSpawnFn);
	const where = supervisorPlaces(config);
	const failures: string[] = [];

	return async function startPi(options) {
		const { paths, runId, reviewerId } = await told(config, options, true);
		const env = await supervisorEnvironment(config, options.env);

		const supervisor = spawnFn(
			where.nodeBinary,
			[where.script, paths.requestPath],
			{
				cwd: options.cwd,
				env,
				// Its own process group. A child in the session's group
				// takes the session's signals, so the interrupt that ends a
				// pi session would end the round with it, which is the
				// thing being fixed rather than a detail of how.
				detached: true,
				// Nothing is listening, so nothing may be held open. A pipe
				// nobody drains fills and blocks the writer, and one whose
				// reader has exited kills the writer outright. The
				// supervisor's real output is the files it writes; its
				// stdout was only ever a convenience for a waiting parent.
				stdio: ["ignore", "ignore", "ignore"],
			},
		);
		// A spawn that fails reports it as an event, and an 'error'
		// event nothing is listening for is thrown as an exception at
		// the top level. On the waiting path the promise catches it; here
		// there is no promise, so an unspawnable supervisor would take
		// down the session that was trying to walk away from it.
		supervisor.on("error", (error) => {
			failures.push(`${options.reviewerId ?? "reviewer"}: ${error.message}`);
		});
		// Off this process's books, so node can exit without waiting.
		supervisor.unref();

		// Spawn failures arrive on the next tick at the earliest, so a
		// synchronous return would report a pid for a process that never
		// existed. One turn of the loop is enough to hear ENOENT and
		// EACCES, which are the ones a caller can act on.
		await new Promise((resolve) => setImmediate(resolve));
		const failure = failures.shift();
		if (failure !== undefined) throw new Error(failure);

		return {
			runId,
			reviewerId,
			pid: supervisor.pid,
			requestPath: paths.requestPath,
		};
	};
}
