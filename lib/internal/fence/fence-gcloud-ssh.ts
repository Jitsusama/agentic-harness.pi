/**
 * What `gcloud compute ssh` needs of `~/.ssh` inside the agent fence,
 * which empties the folder and keeps it read-only (`fence.ts`'s
 * `sshArgs`). gcloud writes two files there, and failed on each:
 *
 * - `google_compute_known_hosts`, which it rewrites on every login to an
 *   instance whose guest attributes give its host keys, known or not
 *   (`WriteHostKeysToKnownHosts` in gcloud's `ssh_utils.py`). A session
 *   gets a copy of its own, bound writable over it, copied afresh from
 *   the person's file whenever theirs is newer.
 * - `google_compute_engine`, its own private key, which the fence
 *   empties. With the public half kept and no private one, gcloud calls
 *   the pair broken and runs ssh-keygen into the read-only folder. A
 *   one-line stand-in is bound over it: gcloud reads only a key file's
 *   first line, and ssh skips a file it can't load as a key. A fenced
 *   ssh signs only through pi's agent proxy, which the machine's ssh
 *   settings name for OS Login instances.
 *
 * Both lie in pi's folder in the runtime folder, which the fence empties
 * (`fence-copy.ts`), so a fenced command can change what the known-hosts
 * copy says but can't put a link where it lies, for the next copy to
 * write through or the next bind to follow.
 *
 * Neither widens what a fenced login reaches. The proxy reads the
 * person's own known-hosts file, outside the fence, and signs only for an
 * instance whose host key is in it, so a host key a fenced command writes
 * into its copy changes what its own ssh trusts and nothing the proxy
 * signs for (ISXEG8, 25 November, F32).
 */

import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** gcloud's known-hosts file, in `~/.ssh`. */
export const GCLOUD_KNOWN_HOSTS = "google_compute_known_hosts";

/** gcloud's private key, in `~/.ssh`, whose public half ends `.pub`. */
export const GCLOUD_KEY = "google_compute_engine";

/** pi's folder in the runtime folder, as `fence-copy.ts` names it. */
const FOLDER = "pi-fence";

/** The folder in it holding each session's copies. */
const SESSIONS = "gcloud-ssh";

/** A session's name as a folder may take it, as the sandbox makes them. */
const SESSION_NAME = /^[A-Za-z0-9-]{1,64}$/;

/** What stands in for gcloud's private key inside, one line gcloud reads. */
export const KEY_STAND_IN =
	"# gcloud's key stays outside the agent fence; ssh signs through pi's agent proxy\n";

/** A session's copies, which the fence binds over gcloud's files in `~/.ssh`. */
export interface GcloudSsh {
	/** The session's known-hosts file, bound writable. */
	readonly knownHosts: string;
	/** The stand-in for gcloud's private key, bound read-only. */
	readonly key: string;
}

/**
 * What a path is, without following a link: a file's last change in
 * milliseconds, "other" for anything but a plain file, or nothing where
 * it isn't there.
 */
function fileAt(path: string): number | "other" | undefined {
	try {
		const stat = lstatSync(path);
		return stat.isFile() ? stat.mtimeMs : "other";
	} catch {
		// Not there, so nothing to compare.
		return undefined;
	}
}

/** When the person's file last changed, through any link, or nothing where it isn't there. */
function changedAt(path: string): number | undefined {
	try {
		const stat = statSync(path);
		return stat.isFile() ? stat.mtimeMs : undefined;
	} catch {
		// Not there, or a link to nothing: no hosts to copy.
		return undefined;
	}
}

/**
 * Makes each folder from pi's own down, one at a time, never the runtime
 * folder itself: node's recursive mkdir spins for good where a parent
 * exists but refuses a child with ENOENT (`fence-copy.ts`).
 */
function makeFolders(runtimeDir: string, names: readonly string[]): string {
	let folder = runtimeDir;
	for (const name of names) {
		folder = join(folder, name);
		if (!existsSync(folder)) mkdirSync(folder, { mode: 0o700 });
	}
	return folder;
}

/**
 * The session `session`'s copies of gcloud's files in `~/.ssh`, made in
 * pi's folder in `runtimeDir` and brought up to date: the known-hosts
 * file copied afresh when the person's is newer than the session's or
 * the session's is gone, empty where the person has none, and the
 * stand-in written where it's missing. Asked before each command, so
 * each finds the person's latest hosts. Nothing where there is no
 * runtime folder, where either path holds anything but a plain file, or
 * where either can't be written; the fence then binds neither.
 */
export function fenceGcloudSsh(
	runtimeDir: string | undefined,
	home: string,
	session: string,
): GcloudSsh | undefined {
	if (!runtimeDir || !SESSION_NAME.test(session)) return undefined;
	try {
		const folder = makeFolders(runtimeDir, [FOLDER, SESSIONS, session]);
		if (!lstatSync(folder).isDirectory()) return undefined;
		const knownHosts = join(folder, GCLOUD_KNOWN_HOSTS);
		const key = join(folder, GCLOUD_KEY);
		const ours = fileAt(knownHosts);
		const stood = fileAt(key);
		if (ours === "other" || stood === "other") return undefined;
		const person = join(home, ".ssh", GCLOUD_KNOWN_HOSTS);
		const theirs = changedAt(person);
		if (theirs === undefined) {
			if (ours === undefined) writeFileSync(knownHosts, "", { mode: 0o600 });
		} else if (ours === undefined || theirs > ours) {
			copyFileSync(person, knownHosts);
		}
		if (stood === undefined) {
			writeFileSync(key, KEY_STAND_IN, { mode: 0o600 });
		}
		return { knownHosts, key };
	} catch {
		// No copies, so the fence binds none, and gcloud's ssh fails inside
		// as it did before they existed.
		return undefined;
	}
}
