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
 *   theirs changes after.
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
 * copy says but can't put a link where it lies. Each is written beside
 * its place and renamed over it, so a command still running keeps the
 * file it bound whole, and a link found where one lies is replaced, never
 * followed. The person's file is read only as a plain file, never
 * through a link.
 *
 * Neither widens what a fenced login reaches. The proxy reads the
 * person's own known-hosts file, outside the fence, and signs only for an
 * instance whose host key is in it, so a host key a fenced command writes
 * into its copy changes what its own ssh trusts and nothing the proxy
 * signs for (ISXEG8, 25 November, F32).
 */

import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
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

/** A file opened for reading as it stands: never through a link, never waiting on a fifo. */
const AS_IT_STANDS =
	constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/**
 * Each session's known-hosts copy, by its path, with the person's file as
 * it stood when last copied in, so a copy is renewed when theirs changes
 * and kept while it doesn't, whatever gcloud inside wrote to it. A copy
 * this process hasn't made yet is made afresh, so neither a session
 * resumed nor one whose folder name comes round again keeps hosts it
 * didn't copy.
 */
const copiedFrom = new Map<string, string>();

/**
 * The person's known-hosts file, read as a plain file, with what tells
 * one version of it from another; or nothing where it isn't there or
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
		const stat = fstatSync(fd);
		if (!stat.isFile()) return undefined;
		return {
			text: readFileSync(fd),
			version: [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(
				":",
			),
		};
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
		if (!existsSync(folder)) mkdirSync(folder, { mode: 0o700 });
		if (!isPrivateFolder(folder)) return undefined;
	}
	return folder;
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
