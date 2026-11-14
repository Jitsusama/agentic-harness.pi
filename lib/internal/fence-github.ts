/**
 * The GitHub door as the fence uses it. The keyring gh's token lives in
 * is hidden, so a fenced gh reaches GitHub through the door where the
 * machine runs it (core's `modules/pi/github-door`): the session's own
 * folder of the door's is bound in, HTTPS goes through a relay of the
 * door's on localhost, and gh holds a placeholder the door swaps for the
 * token on the calls it allows. The door's control socket, which opens
 * sessions and lifts caps, never goes in (`NEVER_THROUGH` in fence.ts).
 */

import { join } from "node:path";
import { quoted } from "./sandbox-shell.ts";

/**
 * Where the door keeps each session's folder, in the runtime folder: its
 * socket and a bundle trusting the session's own authority. Only the
 * session's own folder goes in, never the control socket beside it, so
 * no command opens another session or lifts its own cap.
 */
const GITHUB_SESSIONS = "pi-github/sessions";

/**
 * What gh holds as its token inside, which the door swaps for the
 * person's on the calls it allows: the token itself never goes in.
 */
export const GITHUB_PLACEHOLDER = "pi-github-door-placeholder";

/**
 * Where TLS clients inside read the bundle they trust: gh, curl and
 * OpenSSL's own, git's, Nix's (a fenced `nix` fetches flake inputs from
 * GitHub itself, through the proxy) and node's, which adds to its own.
 * The bundle is the system's with the session's authority beside it, so
 * every other host is trusted as before.
 */
const GITHUB_TRUST = [
	"SSL_CERT_FILE",
	"GIT_SSL_CAINFO",
	"NIX_SSL_CERT_FILE",
	"NODE_EXTRA_CA_CERTS",
] as const;

/** The hosts a fenced command reaches without the relay: this machine's. */
const LOCAL_HOSTS = "localhost,127.0.0.1,::1";

/** A session id the door takes, which can name a folder and nothing more. */
const PLAIN_SESSION = /^[A-Za-z0-9_-]{1,64}$/;

/** How a fenced command reaches GitHub through the door. */
export interface GitHubDoor {
	/** The door's program, found where only root puts programs. */
	readonly program: string;
	readonly session: string;
	/** The session's own folder (`githubDoorFolder`). */
	readonly folder: string;
}

/**
 * The session's own folder of the door's, or nothing when there is no
 * runtime folder or the session's id couldn't name a folder.
 */
export function githubDoorFolder(
	runtimeDir: string | undefined,
	session: string | undefined,
): string | undefined {
	if (!runtimeDir || !session || !PLAIN_SESSION.test(session)) return undefined;
	return join(runtimeDir, GITHUB_SESSIONS, session);
}

/**
 * Bubblewrap's bind of the session's folder, tried rather than checked:
 * the door makes the folder in the line before bubblewrap starts
 * (`openedOutside`), after the fence's arguments are made. Read-only, so
 * no command takes away its own socket or bundle.
 */
export function githubDoorArgs(folder: string | undefined): string[] {
	return folder ? ["--ro-bind-try", folder, folder] : [];
}

/**
 * The shell text, run outside the fence, asking the door for the
 * session's folder: an open is idempotent, and makes the folder anew
 * after the door restarts. A door that isn't there leaves no folder,
 * and the command runs as it would have without one. Nothing, without a
 * door.
 */
export function openedOutside(door: GitHubDoor | undefined): string[] {
	if (!door) return [];
	return [
		`${quoted(door.program)} open ${quoted(door.session)} >/dev/null 2>&1`,
	];
}

/**
 * The shell text, run inside, that points gh and git at the door before
 * `run`: HTTPS goes through the session's relay on localhost, which
 * sends GitHub's hosts to the door and the rest straight out, trust in
 * the session's authority is added for TLS clients that read these
 * variables, and gh's token is the placeholder the door swaps. Only
 * when the door made the folder and its relay started; otherwise none
 * is set and gh fails as it did before the door. `run` alone, without
 * a door.
 */
export function pointedInside(
	door: GitHubDoor | undefined,
	run: string,
): string {
	if (!door) return run;
	const bundle = quoted(join(door.folder, "bundle.pem"));
	const socket = quoted(join(door.folder, "door.sock"));
	const trusted = GITHUB_TRUST.map((name) => `${name}=${bundle}`).join(" ");
	const proxy = "http://127.0.0.1:$__pi_port";
	// Servers on this machine are reached directly, never through the
	// relay, beside any hosts the person already keeps from a proxy.
	const local = ["NO_PROXY", "no_proxy"]
		.map((name) => `${name}=\${${name}:+$${name},}${LOCAL_HOSTS}`)
		.join(" ");
	return [
		`if [ -r ${bundle} ] && [ -S ${socket} ] && __pi_port=$(${quoted(door.program)} relay --socket ${socket} --while $$ 2>/dev/null); then`,
		`export HTTPS_PROXY=${proxy} https_proxy=${proxy} ${local} GH_TOKEN=${GITHUB_PLACEHOLDER} ${trusted};`,
		"fi; unset __pi_port;",
		run,
	].join(" ");
}
