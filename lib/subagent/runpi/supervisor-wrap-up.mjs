/**
 * The wrap-up a reviewer nobody waits for is owed: when a clock stopped
 * it, its supervisor hands the wrap-up its starter spelled out to a
 * supervisor of its own, on the session the run left, under the id a
 * collect already reads and merges. A waiting parent asks for itself,
 * so only a request that carries `wrapUp` is followed up.
 *
 * Plain `.mjs`, as the supervisor is, because node runs that script
 * directly and won't strip types under `node_modules`.
 */

import { spawn } from "node:child_process";
import { writeJsonAtomic } from "./supervisor-files.mjs";

/**
 * Stops worth asking about: a clock took a working reviewer away. The
 * same set as `WORTH_ASKING` in `follow-up.ts`, which this script
 * cannot import.
 */
const WORTH_ASKING = new Set(["timeout", "idle-timeout", "soft-deadline"]);

/**
 * What the wrap-up's supervisor is told, or undefined when nothing is
 * owed: no wrap-up was spelled out, the run was not stopped by a clock,
 * it left no session to resume, or it had already handed in a verified
 * answer. It runs as the stopped run did, on its own clocks, with no
 * soft deadline and no wrap-up of its own, so it is asked at most once.
 *
 * @param {any} request what the stopped run's supervisor was told
 * @param {string} state how the run ended
 * @param {string | undefined} sessionPath the session it left
 * @param {boolean} verified whether its answer passed verification
 * @returns {any}
 */
export function wrapUpRequest(request, state, sessionPath, verified) {
	const wrapUp = request.wrapUp;
	if (!wrapUp || !WORTH_ASKING.has(state) || !sessionPath || verified) {
		return undefined;
	}
	const args = [...wrapUp.args];
	const at = args.indexOf("--session");
	if (at < 0 || at + 1 >= args.length) return undefined;
	args[at + 1] = sessionPath;
	const {
		wrapUp: _asked,
		softDeadlineMs: _soft,
		paths: _paths,
		...rest
	} = request;
	return {
		...rest,
		reviewerId: wrapUp.reviewerId,
		args,
		paths: wrapUp.paths,
		timeoutMs: wrapUp.timeoutMs,
		idleTimeoutMs: wrapUp.idleTimeoutMs,
	};
}

/**
 * Start the wrap-up's supervisor, which outlives this one.
 *
 * Its request is written first, so from that moment a collect reads the
 * wrap-up as starting and holds the round: the stopped run's result is
 * written only after this returns, so the round is never free between
 * the two. Rejects when the supervisor could not be started.
 *
 * @param {any} asked the wrap-up's request
 * @param {string} script this supervisor's own script
 * @returns {Promise<void>}
 */
export async function handOver(asked, script) {
	await writeJsonAtomic(asked.paths.requestPath, asked);
	const supervisor = spawn(
		process.execPath,
		[script, asked.paths.requestPath],
		{
			cwd: asked.cwd,
			// Its own group, holding nothing open: this process exits as
			// soon as it has written its result, and nobody reads either.
			detached: true,
			stdio: "ignore",
			env: process.env,
		},
	);
	await new Promise((resolve, reject) => {
		supervisor.once("spawn", resolve);
		supervisor.once("error", reject);
	});
	supervisor.unref();
}
