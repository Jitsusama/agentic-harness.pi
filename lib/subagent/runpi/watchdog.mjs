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
 *
 * The soft deadline is asked last, and that ordering is the whole of
 * its meaning. It says the run has been going long enough that we
 * would rather have its answer now than its investigation later, so
 * either real limit firing in the same tick is the truer reason and
 * both are answered first.
 *
 * Note what that does not establish. Asking last proves the idle
 * clock has not expired yet, not that the run is alive: a reviewer
 * that hangs inside the last idle window before the soft deadline is
 * stopped as though it were healthy, and nothing here can tell the
 * difference. Whoever reads the verdict should treat a soft deadline
 * as "was not visibly wedged" rather than "was working".
 *
 * Absent when no soft deadline was set, since every caller that
 * predates one must keep running to its wall clock.
 */
export function clockVerdict({
	now,
	startedAtMs,
	timeoutMs,
	softDeadlineMs,
	lastActivityAtMs,
	idleTimeoutMs,
}) {
	if (now - startedAtMs > timeoutMs) return "timeout";
	if (now - lastActivityAtMs > idleTimeoutMs) return "idle-timeout";
	if (softDeadlineMs !== undefined && now - startedAtMs > softDeadlineMs) {
		return "soft-deadline";
	}
	return null;
}
