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
