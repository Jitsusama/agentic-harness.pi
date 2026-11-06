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
 * Shell lines running `command` in the slice `SHARED_SLICE` names, in the
 * session's environment or else `systemEnvironment`, as a scope of the
 * person's systemd, with what it exits with. Where neither names one,
 * before the slice is switched in or on another machine, or there is no
 * `systemd-run` or runtime folder to reach the person's systemd through,
 * it runs as it was: `systemd-run` that can't reach it fails without
 * running the command at all.
 */
export function inSharedSlice(
	command: string,
	systemEnvironment: string = SYSTEM_ENVIRONMENT,
): string {
	const quoted = `'${command.replaceAll("'", `'\\''`)}'`;
	const file = `'${systemEnvironment.replaceAll("'", `'\\''`)}'`;
	return [
		// Read in a subshell, so nothing else the file sets reaches the command.
		`[ -n "\${${SHARED_SLICE_VARIABLE}:-}" ] || ${SHARED_SLICE_VARIABLE}=$( [ -r ${file} ] && . ${file} > /dev/null 2>&1; printf '%s' "\${${SHARED_SLICE_VARIABLE}:-}")`,
		`if [ -n "\${${SHARED_SLICE_VARIABLE}:-}" ] && [ -n "\${XDG_RUNTIME_DIR:-}" ] && command -v systemd-run > /dev/null 2>&1; then`,
		`systemd-run --user --scope --quiet --collect --slice="$${SHARED_SLICE_VARIABLE}" -- bash -c ${quoted}`,
		"else",
		command,
		"fi",
	].join("\n");
}
