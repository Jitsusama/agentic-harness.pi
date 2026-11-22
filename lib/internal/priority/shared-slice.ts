/**
 * Work others wait on, run in the machine's shared slice.
 *
 * A walk of World's objects holds one of two slots every session's
 * pushes and fetches wait for, yet it ran in the queue's own slice,
 * whose disk weight is the lowest on the machine, so a push of one
 * commit could take most of an hour while ten walks waited behind it.
 * core.nix keeps a slice beside the queue's at the agents' disk target
 * for such work and names it in `SHARED_SLICE`. Only the command that
 * holds the slot goes there: the wait for its turn stays with the
 * queue, or the slice would become a second queue at the sessions' rank.
 */

/** The variable naming the slice work others wait on runs in. */
export const SHARED_SLICE_VARIABLE = "SHARED_SLICE";

/**
 * Where NixOS writes the session variables a switch sets. A session
 * started before the switch that named the slice lacks it in its own
 * environment, and sessions run for days: on 6 November not one of 82
 * had it an hour after the switch, so no walk moved. It is read from
 * here when the session's own environment doesn't say.
 */
export const SYSTEM_ENVIRONMENT = "/etc/set-environment";

/**
 * The variable the command travels to the slice's shell in. A strict
 * command holds the agents' hour tokens (`sandboxedCommand`), and a
 * fenced one values kept off every command line (`fencedCommand`), and a
 * program's arguments are readable in `/proc`
 * by any process of the person's while it runs, where its environment is
 * not, so the command is never an argument of `systemd-run` or its bash.
 */
export const SLICED_COMMAND = "__pi_sliced";

/** The longest one string Linux passes a program (MAX_ARG_STRLEN). */
const LONGEST_STRING = 128 * 1024;

/**
 * Room kept for what is put around the command after the queue: the
 * variable's name pi's shell passes it under and the move into jobs.
 * The same room `sandbox.ts` keeps under its LONGEST_TEXT, kept apart
 * since neither module reaches the other; the queue's own lines are
 * measured rather than counted in it.
 */
const LATER_ROOM = 4 * 1024;

/** What a walk too long for the slice's form says, on its errors. */
export const SLICE_GIVEN_UP =
	"This walk runs in the queue's slice: its command is too long to run in the shared one, most often a fenced command whose lists couldn't go in a file.";

/**
 * Shell lines running `command` in the slice `SHARED_SLICE` names, in the
 * session's environment or else `systemEnvironment`, as a scope of the
 * person's systemd, with what it exits with. Where neither names one,
 * before the slice is switched in or on another machine, or there is no
 * `systemd-run` or runtime folder to reach the person's systemd through,
 * it runs as it was: `systemd-run` that can't reach it fails without
 * running the command at all. It runs as it was too when the form,
 * which holds the command twice and each quote in it quoted, with the
 * `around` bytes of the queue's lines, would be longer than Linux takes
 * in one string: a fenced command whose lists couldn't go in a file can
 * be most of that alone, and a walk in the queue's slice is slower,
 * where one past it fails with E2BIG. That walk says so on its errors,
 * so a slow walk can be traced to it.
 *
 * systemd-run expands each `${...}` in a command's words itself unless
 * told not to, so the command's own shell never saw them: a fenced
 * fetch of World's main lost the fence's `"${__pi_env[@]}"` that way
 * and never ran (ISXEG8, 15 November). It is told not to, which systemd
 * has understood since version 254.
 *
 * The command goes to the scope in `SLICED_COMMAND`, exported for the
 * one call, which the scope's shell unsets before it runs it, so it is
 * no argument of either (ISXEG8, 21 November).
 */
export function inSharedSlice(
	command: string,
	systemEnvironment: string = SYSTEM_ENVIRONMENT,
	around = 0,
): string {
	const quoted = `'${command.replaceAll("'", `'\\''`)}'`;
	const file = `'${systemEnvironment.replaceAll("'", `'\\''`)}'`;
	// Read in a subshell, so nothing else the file sets reaches the command.
	const named = `[ -n "\${${SHARED_SLICE_VARIABLE}:-}" ] || ${SHARED_SLICE_VARIABLE}=$( [ -r ${file} ] && . ${file} > /dev/null 2>&1; printf '%s' "\${${SHARED_SLICE_VARIABLE}:-}")`;
	const form = [
		named,
		`if [ -n "\${${SHARED_SLICE_VARIABLE}:-}" ] && [ -n "\${XDG_RUNTIME_DIR:-}" ] && command -v systemd-run > /dev/null 2>&1; then`,
		`${SLICED_COMMAND}=${quoted} systemd-run --user --scope --quiet --collect --slice="$${SHARED_SLICE_VARIABLE}" --expand-environment=no -- bash -c 'eval "unset ${SLICED_COMMAND}; $${SLICED_COMMAND}"'`,
		"else",
		command,
		"fi",
	].join("\n");
	const room = LONGEST_STRING - LATER_ROOM - around;
	if (Buffer.byteLength(form) <= room) return form;
	// Said only where a slice is named, since elsewhere it runs as it was.
	const given = `'${SLICE_GIVEN_UP.replaceAll("'", `'\\''`)}'`;
	return `${named}\n[ -z "\${${SHARED_SLICE_VARIABLE}:-}" ] || printf '%s\\n' ${given} >&2\n${command}`;
}
