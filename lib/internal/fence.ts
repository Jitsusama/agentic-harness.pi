/**
 * The agent fence: every command an agent runs kept off the person's
 * desktop, so nothing it runs can reach what they see, type or unlock.
 *
 * Within one account every check a desktop daemon could make is forged
 * by a process running as the person: the uid a socket reports, the
 * binary a pid runs, the cgroup it sits in, a pipe another process holds
 * (`/proc/<pid>/fd/N` opens it). niri hands every client a virtual
 * keyboard, the clipboard and the screen. So the fence doesn't ask the
 * daemons to tell agents apart; it keeps agents from reaching them. Set
 * `PI_SANDBOX=fence` and each command runs in bubblewrap, around
 * Landlock through landrun, with:
 *
 * - **No other process:** a pid namespace of its own and a `/proc` to
 *   match, so no other process's files, memory or open pipes.
 * - **No desktop:** the runtime folder is an empty one of its own, with
 *   only the Nix daemon's door for sandboxes bound back in. The display,
 *   niri, the shell's ipc, the session bus, sound, the keyring, the
 *   password and clipboard daemons and kitty's socket are named in
 *   `NEVER_THROUGH`, and Landlock refuses any socket it wasn't told of,
 *   abstract ones and signals outside too, so one elsewhere isn't
 *   reachable either.
 * - **No startup files:** the settings and startup files that run code
 *   as the person later (`READ_ONLY`) are read-only, from this command
 *   and from pi's own file tools (`sandbox-files.ts`).
 * - **No new privileges:** bubblewrap and Landlock both set
 *   NoNewPrivs, so a setgid wrapper such as 1Password's `op` gains
 *   nothing, and 1Password refuses it.
 *
 * Everything else is as it was: the home folder, the work, the network
 * and the environment, less what names the desktop. The strict profile
 * is for text a stranger wrote; the fence is for every session.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

/** The value of `PI_SANDBOX` that asks for the fence. */
export const FENCE = "fence";

/**
 * What in the runtime folder a fenced command may reach: the Nix
 * daemon's door for sandboxes, which takes its caller as untrusted.
 */
const LET_THROUGH = ["nix-untrusted.sock"] as const;

/** Sockets outside the runtime folder a fenced command may reach. */
const SOCKETS_ELSEWHERE = ["/run/nscd/socket"] as const;

/**
 * What must never be reachable inside, as paths from the runtime folder
 * (a trailing `*` for any name it begins) or absolute. Each is checked
 * live; the fence lets through only `LET_THROUGH`, so these are the
 * names a change to it must keep out.
 */
export const NEVER_THROUGH = [
	"wayland-*",
	"niri.*",
	"quickshell",
	"quickshell-launcher",
	"launcher.sock",
	"passwords.sock",
	"op-daemon.sock",
	"1Password-BrowserSupport.sock",
	"onepassword",
	"clipboard-history.sock",
	"clipboard-history",
	"bus",
	"/run/dbus/system_bus_socket",
	"pipewire-*",
	"pulse",
	"keyring",
	"gnupg",
	"ssh-tpm-agent.sock",
	"agent-signing.sock",
	"github-broker.sock",
	"gcloud-broker",
] as const;

/**
 * The person's files that run code as them later, or say what does,
 * read-only inside: the shell's startup files, every program's settings
 * (systemd's units and quickshell's code among them), SSH's, what is on
 * their path, the launcher's entries, direnv's allow list and pi's own
 * settings and packages.
 */
export const READ_ONLY = [
	".config",
	".zshrc",
	".zshenv",
	".zprofile",
	".zlogin",
	".profile",
	".bashrc",
	".bash_profile",
	".ssh",
	".local/bin",
	".local/share/applications",
	".local/share/direnv/allow",
	".local/share/systemd",
	".local/share/pi-packages",
	".pi/agent",
] as const;

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

/** Where a fenced command runs. */
export interface FencePlace {
	readonly home: string;
	/** `XDG_RUNTIME_DIR`, which the fence empties. */
	readonly runtimeDir: string | undefined;
}

/** The read-only paths, for the home folder `home`. */
export function readOnlyPaths(home: string): string[] {
	return READ_ONLY.map((path) => join(home, path));
}

/**
 * bubblewrap's arguments for the fence. A path that isn't on this
 * machine is left out, since bubblewrap refuses to bind one, and
 * nothing inside could make it.
 */
export function fenceArgs(
	place: FencePlace,
	exists: (path: string) => boolean = existsSync,
): string[] {
	const args = [
		"--die-with-parent",
		"--new-session",
		"--unshare-pid",
		"--dev-bind",
		"/",
		"/",
		"--proc",
		"/proc",
	];
	if (place.runtimeDir) {
		args.push("--perms", "0700", "--tmpfs", place.runtimeDir);
		for (const name of LET_THROUGH) {
			const path = join(place.runtimeDir, name);
			if (exists(path)) args.push("--bind", path, path);
		}
	}
	// The system bus and X's sockets live outside the runtime folder.
	for (const folder of ["/run/dbus", "/tmp/.X11-unix"]) {
		if (exists(folder)) args.push("--tmpfs", folder);
	}
	for (const path of readOnlyPaths(place.home)) {
		if (exists(path)) args.push("--ro-bind", path, path);
	}
	return args;
}

/** landrun's arguments for the fence: every path, and only the listed sockets. */
export function fenceRules(place: FencePlace): string[] {
	const sockets = [
		...SOCKETS_ELSEWHERE,
		...(place.runtimeDir
			? LET_THROUGH.map((name) => join(place.runtimeDir as string, name))
			: []),
	];
	return [
		"--rwx",
		"/",
		...sockets.flatMap((path) => ["--unix", path]),
		"--unrestricted-network",
		"--ignore-missing",
	];
}

/** The variables a fenced command is never handed. */
export function unsetVariables(): readonly string[] {
	return UNSET;
}

/** The fence's door to Nix, for `NIX_REMOTE` inside. */
export function nixDoor(runtimeDir: string | undefined): string | undefined {
	return runtimeDir ? `unix://${join(runtimeDir, LET_THROUGH[0])}` : undefined;
}

/**
 * Whether a path, already resolved, lies where the fence keeps pi's
 * own file tools from writing: a read-only path, or the runtime folder.
 */
export function fenceRefusesWrite(path: string, place: FencePlace): boolean {
	const kept = [
		...readOnlyPaths(place.home),
		...(place.runtimeDir ? [place.runtimeDir] : []),
	];
	return kept.some(
		(folder) => path === folder || path.startsWith(`${folder}/`),
	);
}

/**
 * Whether a path, already resolved, lies where the fence keeps pi's own
 * file tools from reading: another process's files in `/proc`, or the
 * runtime folder, which holds the clipboard's pictures and the
 * desktop's sockets.
 */
export function fenceRefusesRead(path: string, place: FencePlace): boolean {
	// pi's own /proc/self resolves to its pid, so it is refused too: its
	// open files are pipes and sockets no fenced command could reach.
	if (/^\/proc\/(\d+|thread-self)(\/|$)/.test(path)) return true;
	const runtime = place.runtimeDir;
	return (
		runtime !== undefined &&
		(path === runtime || path.startsWith(`${runtime}/`))
	);
}
