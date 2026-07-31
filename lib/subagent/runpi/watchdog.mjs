/**
 * The watchdog decisions a supervisor can make from the clock alone.
 *
 * This is a module of its own for one reason: it must be provably
 * synchronous. A supervisor's deadline used to be evaluated after two
 * `stat` calls that answer an unrelated question, and under I/O
 * pressure that put the check which must fire behind the resource that
 * had run out. A run observed at load 168 renewed its lease every
 * second for 145 seconds and never once enforced its own 120-second
 * timeout; its event loop was healthy throughout, and only the order
 * was wrong.
 *
 * Keeping it here, with no imports and no `async`, is what makes that
 * invariant something a test can hold rather than something a reader
 * has to notice.
 */

/**
 * Why a run should stop, judged only by elapsed and idle time.
 *
 * Returns null when it should carry on. The deadline is asked before
 * idleness because a run past its wall clock is over whatever it was
 * doing, and reporting the more specific reason would understate it.
 */
export function clockVerdict({
	now,
	startedAtMs,
	timeoutMs,
	lastActivityAtMs,
	idleTimeoutMs,
}) {
	if (now - startedAtMs > timeoutMs) return "timeout";
	if (now - lastActivityAtMs > idleTimeoutMs) return "idle-timeout";
	return null;
}
