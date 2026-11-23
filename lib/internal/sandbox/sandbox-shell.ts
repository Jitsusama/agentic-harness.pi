/**
 * The shell text both sandboxes build each command from: a word quoted
 * for the shell, and the variable a command travels in through landrun,
 * as it does through the shell, so `pkill -f` matches only what it names.
 */

/** `text` as one word to the shell, whatever it holds. */
export function quoted(text: string): string {
	return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** The variable the command travels in through landrun, as through the shell. */
export const SANDBOXED_COMMAND = "PI_SANDBOXED_COMMAND";

/**
 * The variable a fence's whole text travels in to the bash that runs
 * it, since the text can hold a token: a process's arguments show in
 * `/proc` to every user on the machine, its variables only to its own.
 */
export const FENCE_TEXT = "PI_FENCE_TEXT";

/** Shell text that unsets `FENCE_TEXT` and runs what it held. */
export const RUN_FENCE_TEXT = `eval "unset ${FENCE_TEXT}; $${FENCE_TEXT}"`;
