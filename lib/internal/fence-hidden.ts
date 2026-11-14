/**
 * What the agent fence keeps from every command, read from the
 * package's `data/fence-hidden.json`, so core's secret asks can hide the
 * same paths from a released command's bubblewrap from the one list
 * (5GLTPH and ISXEG8, 14 November).
 *
 * The home paths are private keys and tokens outside `~/.ssh`, emptied
 * inside: nix-offload's login to the lent builders, which ssh takes from
 * its file through the relay on this machine's loopback, so a command
 * holding it could run anything there, past the exemption's rules; the
 * logins pi's own tools read in pi's process, outside the fence, which no
 * command needs (Google's, Slack's and Vault's, and Tuple's sign-in); the
 * person's own cloud login, which fenced gcloud never reads, since it is
 * pointed at a settings folder of its own with the broker's hour token
 * (`gcloud-broker.ts`); and the login keyring with what systemd sealed
 * for the person (its password, eero's session), which Landlock already
 * keeps from systemd's credential service, so no copy leaves for an
 * offline guess either (IDEGAT, 13 November). A path ending in `/` is a
 * folder, emptied whole. In `~/.ssh` only what names hosts and keys is
 * kept: public keys, settings and known hosts.
 */

import { readFileSync } from "node:fs";

/** The list's file, at the package's root. */
export const FENCE_HIDDEN_FILE = new URL(
	"../../data/fence-hidden.json",
	import.meta.url,
);

/** The one version of the file this code reads. */
const VERSION = 1;

/** What the file says. */
export interface FenceHidden {
	/** Paths from the home folder emptied inside; a trailing `/` is a folder. */
	readonly home: readonly string[];
	/** What in `~/.ssh` a command may read, every other file being emptied. */
	readonly sshKept: RegExp;
	/** npm's settings, from the home folder, read inside only as a copy. */
	readonly npmrc: string;
}

/**
 * The list, read and checked. A file this code can't read is a broken
 * install, so it throws rather than fencing with nothing hidden.
 */
export function readFenceHidden(text: string): FenceHidden {
	const said: unknown = JSON.parse(text);
	if (typeof said !== "object" || said === null) {
		throw new Error("fence-hidden.json holds no object");
	}
	const { version, home, sshKept, npmrc } = Object.fromEntries(
		Object.entries(said),
	);
	if (version !== VERSION) {
		throw new Error(
			`fence-hidden.json is version ${String(version)}, not ${VERSION}`,
		);
	}
	if (!isStrings(home) || !isStrings(sshKept) || typeof npmrc !== "string") {
		throw new Error("fence-hidden.json needs home, sshKept and npmrc");
	}
	return {
		home,
		sshKept: new RegExp(sshKept.map((source) => `(?:${source})`).join("|")),
		npmrc,
	};
}

function isStrings(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.every((entry) => typeof entry === "string")
	);
}

/** The list the fence keeps, from the package's file. */
export const FENCE_HIDDEN = readFenceHidden(
	readFileSync(FENCE_HIDDEN_FILE, "utf8"),
);
