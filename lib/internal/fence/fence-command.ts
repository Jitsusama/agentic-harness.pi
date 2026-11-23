/**
 * The shell text that runs a command in the agent fence (fence.ts):
 * bubblewrap around landrun, with every variable the shell exports but
 * those naming the desktop, and the doors each fenced command is handed
 * to Nix, SSH's agent and GitHub, and the fence's own `wl-copy` and
 * `wl-paste` ahead on its path.
 */

import { quoted, SANDBOXED_COMMAND } from "../sandbox/sandbox-shell.ts";
import { type ArgsFile, BWRAP_MOST_ARGS } from "./fence-args-file.ts";
import {
	type GitHubDoor,
	openedOutside,
	pointedInside,
} from "./fence-github.ts";

/**
 * Variables that name the desktop, left out so a command fails at once
 * rather than looking for a socket it can't reach. And node's compile
 * cache, which names a folder the fence hides or holds read-only (the
 * runtime folder's or pi's state's), so a node inside uses its temporary folder's, which the fence lets it
 * write to a tmpfs of its own (`fence-temp-caches.ts`).
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
	"NODE_COMPILE_CACHE",
] as const;

/**
 * The descriptor bubblewrap reads its arguments file on. bubblewrap
 * closes it once read, and the command inside closes it again before it
 * runs, so it never holds the file whatever bubblewrap does.
 */
const ARGS_FD = 3;

/**
 * The shell text that runs `command` in the agent fence: bubblewrap
 * with `args`, around landrun with `rules`. Every variable the shell
 * exports goes in but those naming the desktop, Nix is reached
 * through `door`, its daemon's door for sandboxes, SSH's agent is
 * `agent`, the proxy, GitHub is reached through `github`, its door,
 * `shims`, the fence's `wl-copy` and `wl-paste`, go first on
 * `PATH`, and `display`, the sandboxed display, is the one
 * `WAYLAND_DISPLAY` names, each when there is one. When `args` is the
 * file holding them (`fence-args-file.ts`), bubblewrap reads them from
 * it, so the text stays short however many there are.
 */
export function fencedCommand(
	command: string,
	fence: {
		readonly bwrap: string;
		readonly landrun: string;
		readonly args: readonly string[] | ArgsFile;
		readonly rules: readonly string[];
		readonly door?: string;
		readonly agent?: string;
		/** Where each of `OWN_HOMES` lives inside, and direnv's own settings (`fence-direnv.ts`), by its variable. */
		readonly homes?: readonly (readonly [string, string])[];
		readonly github?: GitHubDoor;
		readonly shims?: string;
		readonly display?: string;
	},
): string {
	const homes = fence.homes ?? [];
	const unset = [
		...UNSET,
		...homes.map(([name]) => name),
		...(fence.shims ? ["PATH"] : []),
		SANDBOXED_COMMAND,
	].join("|");
	const file = "path" in fence.args ? fence.args.path : undefined;
	const inline = "path" in fence.args ? [] : fence.args;
	// Closed first, before the GitHub door's relay or anything else starts
	// inside, so nothing there inherits the descriptor whatever bubblewrap
	// did with it: one reopened through /proc would reach the file.
	const closed = file ? `exec ${ARGS_FD}<&-; ` : "";
	const run = `eval "unset ${SANDBOXED_COMMAND}; $${SANDBOXED_COMMAND}"`;
	const stub = `${closed}${pointedInside(fence.github, run)}`;
	const known = bwrapWords(fence);
	return [
		...openedOutside(fence.github),
		`__pi_env=(); for __pi_name in $(compgen -e); do case $__pi_name in ${unset}) ;; *) __pi_env+=(--env "$__pi_name");; esac; done`,
		// The variables passed are known only here, and bubblewrap counts
		// them too, so here is where a line it would refuse is said.
		`if [ $((${known} + \${#__pi_env[@]})) -gt ${BWRAP_MOST_ARGS} ]; then printf '%s\\n' "The fence would hand bubblewrap $((${known} + \${#__pi_env[@]})) arguments, past the ${BWRAP_MOST_ARGS} it takes; they grow with the trees this session holds and the variables it exports, so release the trees it is done with." >&2; exit 126; fi`,
		[
			`${SANDBOXED_COMMAND}=${quoted(command)}`,
			quoted(fence.bwrap),
			...(file
				? [`--args ${ARGS_FD} ${ARGS_FD}<${quoted(file)}`]
				: inline.map(quoted)),
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
			// Never the person's own display: only the sandboxed one.
			...(fence.display
				? [`--env ${quoted(`WAYLAND_DISPLAY=${fence.display}`)}`]
				: []),
			...homes.map(([name, path]) => `--env ${quoted(`${name}=${path}`)}`),
			`-- bash -c ${quoted(stub)}`,
		].join(" "),
	].join("\n");
}

/** Each `--env NAME=value` the line passes landrun beside the variables. */
const ENV_WORDS = 2;

/**
 * How many arguments bubblewrap counts on `fence`'s line, beside the
 * `--env` pair for each variable the shell passes: those it reads from
 * the file, and every word of its own command line after its name,
 * landrun's half after `--` included.
 */
export function bwrapWords(
	fence: Pick<
		Parameters<typeof fencedCommand>[1],
		"args" | "rules" | "door" | "agent" | "homes" | "shims" | "display"
	>,
): number {
	const own =
		"path" in fence.args
			? fence.args.args.length + ["--args", `${ARGS_FD}`, "--"].length
			: fence.args.length + ["--"].length;
	const passed = [
		SANDBOXED_COMMAND,
		fence.door,
		"GIT_OPTIONAL_LOCKS",
		fence.agent,
		fence.shims,
		fence.display,
		...(fence.homes ?? []),
	].filter(Boolean).length;
	const landrun = ["landrun", ...fence.rules].length;
	return (
		own + landrun + passed * ENV_WORDS + ["--", "bash", "-c", "stub"].length
	);
}
