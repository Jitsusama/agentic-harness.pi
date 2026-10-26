/**
 * How hard pi may be asked to think.
 *
 * Its own module for the reason `exec` and `remote` are: both the
 * review side and the subagent side need this vocabulary and neither
 * owns it. It is pi's, and everything here does is write it down once.
 *
 * It had been written down four times, in two domains that share no
 * module: the roster parser that validates one, the two tool schemas
 * that offer one, and the runner type that receives one. Four copies
 * of a list nothing compares is a list that will disagree with itself,
 * and the failure is quiet: a level one copy accepts and pi does not
 * reaches the CLI, and the reviewer runs at whatever pi makes of it.
 */

/** The levels pi's `--thinking` flag accepts, in order of effort. */
export const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const;

/** One of the levels pi's `--thinking` flag accepts. */
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Whether some string is a level pi would accept. */
export function isThinkingLevel(value: string): value is ThinkingLevel {
	return THINKING_LEVELS.some((level) => level === value);
}
