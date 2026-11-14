/**
 * The shell text that runs a command in the agent fence (fence.ts):
 * bubblewrap around landrun, handed the shell's own environment less
 * what names the desktop, and given the fence's own doors in its place.
 */

import { quoted, SANDBOXED_COMMAND } from "./sandbox-shell.ts";

/**
 * Variables that name the desktop, left out so a command fails at once
 * rather than looking for a socket it can't reach.
 */
const UNSET = [
	"WAYLAND_DISPLAY",
	"DISPLAY",
	"XAUTHORITY",
	"DBUS_SESSION_BUS_ADDRESS",
	"SSH_AUTH_SOCK",
	"NIRI_SOCKET",
	"SWAYSOCK",
	"KITTY_LISTEN_ON",
	"KITTY_WINDOW_ID",
	"NIX_REMOTE",
] as const;

/**
 * The shell text that runs `command` in the agent fence: bubblewrap
 * with `args`, around landrun with `rules`. Every variable the shell
 * exports goes in but those naming the desktop, Nix is reached
 * through `door`, its daemon's door for sandboxes, SSH's agent is
 * `agent`, the proxy, and `shims`, the fence's `wl-copy` and
 * `wl-paste`, go first on `PATH`, each when there is one.
 */
export function fencedCommand(
	command: string,
	fence: {
		readonly bwrap: string;
		readonly landrun: string;
		readonly args: readonly string[];
		readonly rules: readonly string[];
		readonly door?: string;
		readonly agent?: string;
		readonly shims?: string;
		/** Where each of `OWN_HOMES` lives inside, by its variable. */
		readonly homes?: readonly (readonly [string, string])[];
	},
): string {
	const homes = fence.homes ?? [];
	const unset = [
		...UNSET,
		...homes.map(([name]) => name),
		...(fence.shims ? ["PATH"] : []),
		SANDBOXED_COMMAND,
	].join("|");
	const stub = `eval "unset ${SANDBOXED_COMMAND}; $${SANDBOXED_COMMAND}"`;
	return [
		`__pi_env=(); for __pi_name in $(compgen -e); do case $__pi_name in ${unset}) ;; *) __pi_env+=(--env "$__pi_name");; esac; done`,
		[
			`${SANDBOXED_COMMAND}=${quoted(command)}`,
			quoted(fence.bwrap),
			...fence.args.map(quoted),
			"--",
			quoted(fence.landrun),
			...fence.rules.map(quoted),
			`"\${__pi_env[@]}" --env ${SANDBOXED_COMMAND}`,
			...(fence.door ? [`--env ${quoted(`NIX_REMOTE=${fence.door}`)}`] : []),
			// Status and diff then take no optional lock to refresh the
			// index, so one kept read-only never stops them (ISXEG8).
			"--env GIT_OPTIONAL_LOCKS=0",
			...(fence.agent
				? [`--env ${quoted(`SSH_AUTH_SOCK=${fence.agent}`)}`]
				: []),
			// The path as the shell outside has it when the command runs,
			// the fence's shims ahead of it.
			...(fence.shims
				? [`--env ${quoted(`PATH=${fence.shims}:`)}"$PATH"`]
				: []),
			...homes.map(([name, path]) => `--env ${quoted(`${name}=${path}`)}`),
			`-- bash -c ${quoted(stub)}`,
		].join(" "),
	].join("\n");
}
