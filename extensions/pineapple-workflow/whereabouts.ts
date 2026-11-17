/**
 * Where a session's work is, as parking asks: its folder and the trees
 * the work tool cut for it, and the repositories those are clones of.
 *
 * Only a stop on a repository or a name asks, so a session pays for the
 * git lookups only while one stands.
 *
 * The work tool's records number in the thousands, and parking asks every
 * minute on the loop every hosted conversation shares. Reading them all
 * there, synchronously, was the background host's second biggest disk
 * wait on 16 November, and a filesystem stall in calls like these held the
 * loop past the host's watchdog. So the records are read off the loop, one
 * pass at a time, and only the ones that changed are read again. This is a
 * second reader of those records beside `lib/internal/work-records.ts`,
 * whose reading is synchronous, on purpose: its callers need an answer at
 * once, and this one needs never to hold the loop.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * How many records are read at once. Node's file work runs on four
 * threads every conversation on the host shares, so a stalled disk holds
 * only two of them here.
 */
const AT_ONCE = 2;

/**
 * How long ago a folder must have last changed for its stamp to be
 * trusted. A file's times move in the kernel's ticks, so a rename in the
 * same tick as the stamp, after the listing, leaves the stamp as it was.
 */
const SETTLED_MS = 1_000;

/**
 * How long a session waits on a pass before answering from what it last
 * read, so a stalled disk holds no turn; the pass carries on behind.
 */
const PATIENCE_MS = 10_000;

/** A file as a stamp tells it apart: what it is, and when it last changed. */
interface Stamped {
	readonly stamp: string;
	readonly changed: number;
}

/** What whereabouts read the disk with, so a case can stand in for it. */
export interface Disk {
	list(dir: string): Promise<string[]>;
	stamp(path: string): Promise<Stamped>;
	read(path: string): Promise<string>;
}

/** The disk as Node reads it, off the loop. */
const NODE_DISK: Disk = {
	list: (dir) => readdir(dir),
	async stamp(path) {
		const now = await stat(path);
		// A record is renamed into place, so a rewrite is a new file; the
		// change time is there because nothing can set it back.
		return {
			stamp: `${now.ino}:${now.mtimeMs}:${now.ctimeMs}:${now.size}`,
			changed: now.mtimeMs,
		};
	},
	read: (path) => readFile(path, "utf8"),
};

/** A tree a record names, and who holds it. */
interface Tree {
	readonly path: string;
	readonly sessions: readonly string[];
}

/** A record as last read: the file it was, and the tree it names. */
interface Kept {
	readonly stamp: string;
	readonly tree: Tree | undefined;
}

/** The work tool's records of the trees it cut, read as they change. */
export interface Whereabouts {
	/** The folders a session works in: its own, then each tree cut for it. */
	dirsOf(session: string, cwd: string): Promise<string[]>;
}

/** What whereabouts may be given in place of the disk and the clock. */
export interface WhereaboutsOptions {
	readonly disk?: Partial<Disk>;
	readonly now?: () => number;
	readonly patienceMs?: number;
}

/** Whereabouts over the records in `cuts`, keeping what each last said. */
export function createWhereabouts(
	cuts: string,
	options: WhereaboutsOptions = {},
): Whereabouts {
	const disk: Disk = { ...NODE_DISK, ...options.disk };
	const now = options.now ?? Date.now;
	const patience = options.patienceMs ?? PATIENCE_MS;
	const kept = new Map<string, Kept>();
	/** The folder as it stood before the last listing that can be trusted. */
	let listedAt: string | undefined;
	/** The pass under way, which a second asker waits on rather than repeats. */
	let pass: Promise<void> | undefined;

	/** Whether nothing is there, as against a disk that failed to say. */
	function gone(error: unknown): boolean {
		return (error as { code?: unknown } | null)?.code === "ENOENT";
	}

	/**
	 * One record, read again only when its file is not the one kept. True
	 * when what is kept is what the disk says, false when the disk didn't
	 * say, and what was kept before is kept rather than forgotten: a held
	 * tree forgotten is a stop that misses the session standing in it.
	 */
	async function refresh(name: string): Promise<boolean> {
		const path = join(cuts, name);
		let stamped: Stamped;
		try {
			stamped = await disk.stamp(path);
		} catch (error) {
			if (!gone(error)) return false;
			kept.delete(name);
			return true;
		}
		if (kept.get(name)?.stamp === stamped.stamp) return true;
		let text: string;
		try {
			text = await disk.read(path);
		} catch (error) {
			if (!gone(error)) return false;
			// Gone between its stamp and its read: no longer a record.
			kept.delete(name);
			return true;
		}
		let tree: Tree | undefined;
		try {
			tree = treeOf(JSON.parse(text));
		} catch {
			// Broken as written, since a record is renamed into place whole:
			// it names no tree until it is written again.
			tree = undefined;
		}
		kept.set(name, { stamp: stamped.stamp, tree });
		return true;
	}

	/** Look at every record again; true when the disk said all it was asked. */
	async function relist(): Promise<boolean> {
		let listed: string[];
		try {
			listed = (await disk.list(cuts)).filter((name) => name.endsWith(".json"));
		} catch (error) {
			if (!gone(error)) return false;
			// No work records: the session works in its own folder alone.
			kept.clear();
			return true;
		}
		// A listing taken while a record is renamed over itself can miss it
		// on btrfs, so a record kept but not listed is looked at too, and
		// stays while its file does.
		const names = [...new Set([...listed, ...kept.keys()])];
		let whole = true;
		for (let from = 0; from < names.length; from += AT_ONCE) {
			const told = await Promise.all(
				names.slice(from, from + AT_ONCE).map(refresh),
			);
			whole &&= told.every(Boolean);
		}
		return whole;
	}

	/**
	 * One pass: nothing when the folder is settled and unchanged since a
	 * whole listing, since every record is renamed into place, which
	 * changes the folder. It is stamped before the listing, so a change
	 * during one is seen by the next.
	 */
	async function look(): Promise<void> {
		const stamped = now();
		let folder: Stamped | undefined;
		try {
			folder = await disk.stamp(cuts);
		} catch {
			// No folder, or a disk that didn't say: the listing tells which.
			folder = undefined;
		}
		if (folder !== undefined && folder.stamp === listedAt) return;
		const whole = await relist();
		const settled =
			folder !== undefined && stamped - folder.changed >= SETTLED_MS;
		listedAt = whole && settled ? folder?.stamp : undefined;
	}

	return {
		async dirsOf(session, cwd) {
			pass ??= look().finally(() => {
				pass = undefined;
			});
			let waiting: ReturnType<typeof setTimeout> | undefined;
			const late = new Promise<void>((resolve) => {
				waiting = setTimeout(resolve, patience);
			});
			try {
				await Promise.race([pass, late]);
			} finally {
				clearTimeout(waiting);
			}
			const dirs = [cwd];
			for (const { tree } of kept.values()) {
				if (tree?.sessions.includes(session)) dirs.push(tree.path);
			}
			return [...new Set(dirs)];
		},
	};
}

/** The tree a record names, and who holds it, when it names one. */
function treeOf(record: unknown): Tree | undefined {
	if (typeof record !== "object" || record === null) return undefined;
	const { path, sessions } = record as { path?: unknown; sessions?: unknown };
	if (typeof path !== "string" || !Array.isArray(sessions)) return undefined;
	return {
		path,
		sessions: sessions.filter((one): one is string => typeof one === "string"),
	};
}

/** The repositories of `dirs`, as `owner/name`, asked of each one's origin. */
export async function reposOf(
	dirs: readonly string[],
	repoOf: (dir: string) => Promise<string | undefined>,
): Promise<string[]> {
	const repos = await Promise.all(dirs.map(repoOf));
	return [
		...new Set(repos.filter((repo): repo is string => repo !== undefined)),
	];
}
