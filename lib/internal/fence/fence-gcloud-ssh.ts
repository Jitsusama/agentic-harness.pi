/**
 * What `gcloud compute ssh` needs of `~/.ssh` inside the agent fence,
 * which empties the folder and keeps it read-only (`fence.ts`'s
 * `sshArgs`). gcloud writes two files there, and failed on each:
 *
 * - `google_compute_known_hosts`, which it rewrites on every login to an
 *   instance whose guest attributes give its host keys, known or not
 *   (`WriteHostKeysToKnownHosts` in gcloud's `ssh_utils.py`). A session
 *   gets a copy of its own, bound writable over it, copied afresh from
 *   the person's file the first time this process asks and whenever
 *   what theirs says changes after. It is writable only through that
 *   bind: pi's own file tools still refuse all of `~/.ssh`
 *   (`fenceRefusesWrite`), where this name is the person's real file.
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
 * copy says but can't put a link where it lies. bubblewrap follows a
 * link when it binds, later than the checks here; that gap is reached
 * by nothing a fenced or strict command, or pi's file tools, can write,
 * only by the account's unfenced programs, which reach the files anyway. Each is written beside
 * its place and renamed over it, so a command still running keeps the
 * file it bound whole, and a link found where one lies is replaced, never
 * followed. The person's file is read only as a plain file, never
 * through a link.
 *
 * Neither widens what a fenced login reaches. The agent proxy, core.nix's
 * `modules/pi/agent-proxy`, is a user service outside the fence that
 * reads `%h/.ssh/google_compute_known_hosts`, the person's own file, by
 * its path (`--os-login-hosts`, pinned by its
 * `pi-agent-proxy-reaches-os-login-machines-wired` check). It signs only
 * a login to a session bound by `session-bind@openssh.com` and signed by
 * a host key in that file (`src/bind.rs`); a sign asked with no session
 * bound is refused (its `refuses_to_sign_with_no_session_bound` test).
 * So a host key a fenced command writes into its copy changes what its
 * own ssh trusts and nothing the proxy signs for. An instance the person
 * never reached is refused until gcloud outside learns its host key, and
 * the proxy's journal says so ("a session with a host it isn't told
 * of"), where the fenced ssh says only that its key was denied.
 */

import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	lstatSync,
	lutimesSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmdirSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { makeFolder } from "./fence-dev.ts";

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

/**
 * What stands in for gcloud's private key inside, one line gcloud reads.
 * Never reword it: the census takes only this exact text for the stand-in
 * (`holdsStandIn`), and a command still running keeps the text it was
 * bound with, so a census by a newer pi would call those commands
 * unfenced.
 */
export const KEY_STAND_IN =
	"# gcloud's key stays outside the agent fence; ssh signs through pi's agent proxy\n";

/** A session's copies, which the fence binds over gcloud's files in `~/.ssh`. */
export interface GcloudSsh {
	/** The session's known-hosts file, bound writable. */
	readonly knownHosts: string;
	/** The stand-in for gcloud's private key, bound read-only. */
	readonly key: string;
}

/** A file opened for reading as it stands: never through a link, never waiting on a fifo. */
const AS_IT_STANDS =
	constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/**
 * Each session's known-hosts copy, by its path, with what the person's
 * file said when last copied in, so a copy is renewed when theirs changes
 * and kept while it doesn't, whatever gcloud inside wrote to it. A copy
 * this process hasn't made yet is made afresh, so neither a session
 * resumed nor one whose folder name comes round again keeps hosts it
 * didn't copy.
 */
const copiedFrom = new Map<string, string>();

/**
 * How long a session's copies stand unrenewed before a later pi takes
 * them for an ended session's and removes them. A live session idle that
 * long only has them made afresh at its next command; one still running
 * keeps the files it bound.
 */
const UNUSED_FOR_MS = 24 * 60 * 60 * 1000;

/** Whether this process has swept ended sessions' copies yet. */
let swept = false;

/**
 * The person's known-hosts file, read as a plain file, with a digest of
 * what it says, which tells one version from another where its dates,
 * size and inode may all repeat; or nothing where it isn't there or
 * isn't a plain file, which counts as no hosts.
 */
function personsHosts(
	path: string,
): { readonly text: Buffer; readonly version: string } | undefined {
	let fd: number;
	try {
		fd = openSync(path, AS_IT_STANDS);
	} catch {
		// Not there, a link or unreadable: no hosts to copy.
		return undefined;
	}
	try {
		if (!fstatSync(fd).isFile()) return undefined;
		const text = readFileSync(fd);
		return { text, version: createHash("sha256").update(text).digest("hex") };
	} finally {
		closeSync(fd);
	}
}

/**
 * Whether the file at `path`, read as it stands, is the stand-in for
 * gcloud's key, reading no more of it than tells, as the census does of
 * what a fenced command sees.
 */
export function holdsStandIn(path: string): boolean {
	return says(path, KEY_STAND_IN);
}

/** Whether `path` holds a plain file, not following a link. */
function isPlainFile(path: string): boolean {
	try {
		return lstatSync(path).isFile();
	} catch {
		// Not there.
		return false;
	}
}

/** Whether the file at `path`, read as it stands, says `text`, reading no more than it needs. */
function says(path: string, text: string): boolean {
	let fd: number;
	try {
		fd = openSync(path, AS_IT_STANDS);
	} catch {
		// Not there, or a link: it says nothing.
		return false;
	}
	try {
		if (!fstatSync(fd).isFile()) return false;
		const want = Buffer.from(text);
		const read = Buffer.alloc(want.length + 1);
		const got = readSync(fd, read, 0, read.length, 0);
		return got === want.length && read.subarray(0, got).equals(want);
	} finally {
		closeSync(fd);
	}
}

/**
 * Writes `text` to `path` beside it and renames it over, so what stood
 * there, a file a command still reads or a link, is replaced whole.
 */
function writeOver(path: string, text: Buffer | string): void {
	const staging = `${path}.${randomUUID()}`;
	try {
		writeFileSync(staging, text, { mode: 0o600, flag: "wx" });
		renameSync(staging, path);
	} finally {
		rmSync(staging, { force: true });
	}
}

/** Whether `path` is a folder of this process's account alone, not a link to one. */
function isPrivateFolder(path: string): boolean {
	try {
		const stat = lstatSync(path);
		const uid = process.getuid?.();
		return (
			stat.isDirectory() &&
			(uid === undefined || stat.uid === uid) &&
			(stat.mode & 0o077) === 0
		);
	} catch {
		// Not there.
		return false;
	}
}

/**
 * Makes each folder from pi's own down, one at a time, never the runtime
 * folder itself: node's recursive mkdir spins for good where a parent
 * exists but refuses a child with ENOENT (`fence-copy.ts`). Each must be
 * the account's own private folder, not a link another left; the deepest
 * is answered, or nothing where one isn't.
 */
function privateFolders(
	runtimeDir: string,
	names: readonly string[],
): string | undefined {
	if (!isPrivateFolder(runtimeDir)) return undefined;
	let folder = runtimeDir;
	for (const name of names) {
		folder = join(folder, name);
		if (!existsSync(folder)) makeFolder(folder);
		if (!isPrivateFolder(folder)) return undefined;
	}
	return folder;
}

/**
 * Removes the copies of sessions not used for `UNUSED_FOR_MS` from
 * `sessions`, pi's folder of them, as each session's folder dates its
 * last use, half-written copies a killed pi left among them; never `session`'s
 * own folder, nor anything but this account's own plain files and the
 * folders holding them. Nothing is followed: each name is unlinked, never
 * walked. A session idle that long whose command starts in the instant
 * another pi sweeps can fail that one command's bind; its next makes the
 * copies anew.
 */
function sweepEnded(sessions: string, session: string, now: number): void {
	let names: string[];
	try {
		names = readdirSync(sessions);
	} catch {
		// Nothing to sweep.
		return;
	}
	for (const name of names) {
		if (name === session || !SESSION_NAME.test(name)) continue;
		const folder = join(sessions, name);
		try {
			const stat = lstatSync(folder);
			if (!isPrivateFolder(folder) || now - stat.mtimeMs < UNUSED_FOR_MS) {
				continue;
			}
			for (const file of readdirSync(folder)) {
				if (lstatSync(join(folder, file)).isFile()) {
					unlinkSync(join(folder, file));
				}
			}
			rmdirSync(folder);
		} catch {
			// In use again, or not this account's to remove: left as it is.
		}
	}
}

/**
 * The session `session`'s copies of gcloud's files in `~/.ssh`, made in
 * pi's folder in `runtimeDir` and brought up to date: the known-hosts
 * file copied afresh the first time this process asks, whenever the
 * person's changes or the session's isn't a plain file, empty where the
 * person has none; the stand-in written wherever it reads wrong. Asked
 * before each command, so each finds the person's latest hosts. Nothing
 * where there is no runtime folder, where a folder on the way isn't the
 * account's own and private, or where a copy can't be written; the fence
 * then binds neither.
 */
export function fenceGcloudSsh(
	runtimeDir: string | undefined,
	home: string,
	session: string,
): GcloudSsh | undefined {
	if (!runtimeDir || !SESSION_NAME.test(session)) return undefined;
	try {
		const folder = privateFolders(runtimeDir, [FOLDER, SESSIONS, session]);
		if (folder === undefined) return undefined;
		// Dated as used now, so no other pi sweeps it as an ended session's.
		const now = new Date();
		lutimesSync(folder, now, now);
		if (!swept) {
			swept = true;
			sweepEnded(join(runtimeDir, FOLDER, SESSIONS), session, now.getTime());
		}
		const knownHosts = join(folder, GCLOUD_KNOWN_HOSTS);
		const key = join(folder, GCLOUD_KEY);
		const person = personsHosts(join(home, ".ssh", GCLOUD_KNOWN_HOSTS));
		const version = person?.version ?? "none";
		if (!isPlainFile(knownHosts) || copiedFrom.get(knownHosts) !== version) {
			copiedFrom.delete(knownHosts);
			writeOver(knownHosts, person?.text ?? "");
			copiedFrom.set(knownHosts, version);
		}
		if (!holdsStandIn(key)) writeOver(key, KEY_STAND_IN);
		return { knownHosts, key };
	} catch {
		// No copies, so the fence binds none, and gcloud's ssh fails inside
		// as it did before they existed.
		return undefined;
	}
}
