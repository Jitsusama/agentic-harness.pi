/**
 * A command the queue's shell lines run under a time limit, on Linux
 * and macOS alike.
 *
 * GNU's `timeout` is on every Linux, but macOS ships none: there every
 * limited command failed as not found, exit 127, so each plan said
 * "failed nix build --dry-run exited 127" and a fetch's read of main
 * read nothing (87KI6A, 15 November). Homebrew's coreutils names it
 * `gtimeout`, and every Mac has perl, whose alarm ends a command the
 * same way. With none of them the command runs unlimited, which is
 * still better than not at all.
 */

/**
 * Shell text running `command`, a simple command's words, for at most
 * `seconds`, with what it exits with: through `timeout`, `gtimeout` or
 * perl's alarm, whichever the machine has first, else unlimited.
 */
export function limited(seconds: number, command: string): string {
	const has = (program: string) => `command -v ${program} > /dev/null 2>&1`;
	return [
		`if ${has("timeout")}; then timeout ${seconds} ${command}`,
		`elif ${has("gtimeout")}; then gtimeout ${seconds} ${command}`,
		`elif ${has("perl")}; then perl -e 'alarm shift; exec @ARGV' ${seconds} ${command}`,
		`else ${command}; fi`,
	].join("; ");
}
