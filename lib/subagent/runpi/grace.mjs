/**
 * How long a departed process gets to flush its pipes before whoever
 * is waiting finishes without them.
 *
 * One number for both halves of the supervisor, because it is one
 * hazard a level apart: the supervisor draining a reviewer that has
 * exited, and the parent draining a supervisor that has exited. Both
 * face the same thing, which is a process that is gone while
 * something it started still holds its output.
 *
 * Two seconds was measured to be too short. On a loaded machine the
 * sequence still to happen after exit is a spawn, a stdout flush
 * through inherited pipes and an atomic result write, and when that
 * overran the grace the run settled from a file that was not there
 * yet and reported an empty answer. An empty answer is the worst
 * available failure, because it reads as a reviewer that said nothing
 * rather than as a deadline that was too tight. Five seconds is still
 * nobody's idea of a hang.
 *
 * The two halves held that measurement separately, and only the
 * parent's copy was ever corrected: the supervisor kept draining the
 * reviewer, the process that actually produces the answer, on the
 * value already known to lose it.
 *
 * Plain `.mjs` because the supervisor is a script node runs directly
 * and cannot import TypeScript. That seam is precisely where the two
 * numbers drifted, so the constant crosses it rather than being
 * spelled twice on either side of it.
 */
export const STDIO_GRACE_MS = 5_000;
