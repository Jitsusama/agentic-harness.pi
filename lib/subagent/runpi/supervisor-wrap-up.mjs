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
import { rm } from "node:fs/promises";
import { writeJsonAtomic } from "./supervisor-files.mjs";

/**
 * Stops worth asking about: a clock took a working reviewer away. The
 * same set as `WORTH_ASKING` in `follow-up.ts`, which this script
 * cannot import.
 */
const WORTH_ASKING = new Set(["timeout", "idle-timeout", "soft-deadline"]);

/**
 * Whether a wrap-up is owed: one was spelled out, a clock stopped the
 * run, and it had not already handed in a verified answer. One owed
 * that {@link wrapUpRequest} cannot ask for is worth a warning, since
 * the reviewer's answer is then lost without a word.
 *
 * @param {any} request what the stopped run's supervisor was told
 * @param {string} state how the run ended
 * @param {boolean} verified whether its answer passed verification
 * @returns {boolean}
 */
export function wrapUpOwed(request, state, verified) {
	return Boolean(request.wrapUp) && WORTH_ASKING.has(state) && !verified;
}

/**
 * What the wrap-up's supervisor is told, or undefined when nothing is
 * owed or it cannot be asked: no wrap-up was spelled out, the run was
 * not stopped by a clock, it had already handed in a verified answer,
 * or it left no session to resume or no `--session` to resume it with.
 * It runs as the stopped run did, on its own clocks, with no
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
	if (!wrapUpOwed(request, state, verified) || !sessionPath) return undefined;
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
 * the two. What an earlier wrap-up under the same id left (a
 * cancellation, a lease, a result) is cleared first, as
 * `ensureReviewerDir` clears a fresh run's, or the new supervisor
 * would stop on arrival or a collect would read the old answer.
 * Rejects when the supervisor could not be started, and takes its
 * request back first, so a collect is not held by a wrap-up that
 * never ran.
 *
 * @param {any} asked the wrap-up's request
 * @param {string} script this supervisor's own script
 * @returns {Promise<void>}
 */
export async function handOver(asked, script) {
	await Promise.all(
		[asked.paths.cancelPath, asked.paths.leasePath, asked.paths.resultPath].map(
			(path) => rm(path, { force: true }),
		),
	);
	await writeJsonAtomic(asked.paths.requestPath, asked);
	try {
		await started(asked, script);
	} catch (error) {
		await rm(asked.paths.requestPath, { force: true });
		throw error;
	}
}

/**
 * @param {any} asked
 * @param {string} script
 * @returns {Promise<void>}
 */
async function started(asked, script) {
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
