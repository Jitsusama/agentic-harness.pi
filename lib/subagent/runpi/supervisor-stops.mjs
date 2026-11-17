/**
 * What the supervisor says of a stop: the state a closed child ends in,
 * the exit code a run gets when its child gave none, and the warning
 * that names why it was stopped.
 *
 * Plain `.mjs`, as the supervisor is, because node runs that script
 * directly and won't strip types under `node_modules`.
 */

/**
 * Why the supervisor stopped its child.
 *
 * @typedef {"timeout" | "idle-timeout" | "soft-deadline" | "cancelled" | "parent-exit"} StopReason
 */

/**
 * The state a run ends in once its child has closed: the stop's reason
 * when the supervisor stopped it, else complete on a clean exit.
 *
 * @param {StopReason | null} stoppedBy
 * @param {number | null} code
 * @returns {StopReason | "complete" | "failed"}
 */
export function stateForClose(stoppedBy, code) {
	if (stoppedBy) return stoppedBy;
	return code === 0 ? "complete" : "failed";
}

/**
 * The exit code of a run whose child gave none: 124 for a deadline, as
 * `timeout` uses, 130 for a cancel or a parent gone, else 1.
 *
 * @param {StopReason | null} reason
 */
export function fallbackExitCode(reason) {
	if (
		reason === "timeout" ||
		reason === "idle-timeout" ||
		reason === "soft-deadline"
	)
		return 124;
	if (reason === "cancelled" || reason === "parent-exit") return 130;
	return 1;
}

/**
 * The warning a stop leaves on the run, naming the limit it reached.
 *
 * @param {StopReason} reason
 * @param {{ timeoutMs: number, idleTimeoutMs: number, softDeadlineMs?: number }} limits
 */
export function stopWarning(reason, limits) {
	if (reason === "timeout")
		return `Pi subprocess timed out after ${limits.timeoutMs}ms; sent SIGTERM.`;
	if (reason === "idle-timeout")
		return `Pi subprocess idle for ${limits.idleTimeoutMs}ms; sent SIGTERM.`;
	if (reason === "soft-deadline")
		return (
			`Pi subprocess reached its soft deadline of ${limits.softDeadlineMs}ms ` +
			`with ${limits.timeoutMs}ms allowed in total; sent SIGTERM so the ` +
			"rest of the budget can be spent asking for its answer."
		);
	if (reason === "parent-exit")
		return "Pi parent process exited; sent SIGTERM.";
	return "Pi subprocess cancelled; sent SIGTERM.";
}
