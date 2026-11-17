/**
 * Where a session's work is, as parking asks: its folder and the trees
 * the work tool cut for it, and the repositories those are clones of.
 *
 * Only a stop on a repository or a name asks, so a session pays for the
 * git lookups only while one stands.
 *
 * The work tool's records number in the thousands, and parking asks every
 * minute on the loop every hosted conversation shares. Reading them all
 * there, synchronously, was a quarter of the host's disk waits on 16
 * November, and a filesystem stall in calls like these held the loop past
 * the host's watchdog. So the records are read off the loop, and only the
 * ones that changed since the last pass are read again.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/** How many records are read at once, so a first pass holds few files open. */
const AT_ONCE = 32;

/**
 * How long ago a folder must have last changed for its stamp to be
 * trusted. A file's times move in the kernel's ticks, so a rename in the
 * same tick as the stamp, after the listing, leaves the stamp as it was.
 */
const SETTLED_MS = 1_000;

/** A record as last read: the file it was, and the tree it names. */
interface Kept {
	readonly stamp: string;
	readonly tree:
		| { readonly path: string; readonly sessions: readonly string[] }
		| undefined;
}

/** The work tool's records of the trees it cut, read as they change. */
export interface Whereabouts {
	/** The folders a session works in: its own, then each tree cut for it. */
	dirsOf(session: string, cwd: string): Promise<string[]>;
}

/** Whereabouts over the records in `cuts`, keeping what each last said. */
export function createWhereabouts(cuts: string): Whereabouts {
	const kept = new Map<string, Kept>();
	/** The folder as it stood before the last listing of it. */
	let listedAt: string | undefined;

	/** What a file is now, and when it last changed. */
	async function stampOf(
		path: string,
	): Promise<{ stamp: string; changed: number } | undefined> {
		try {
			const now = await stat(path);
			// A record is renamed into place, so a rewrite is a new file.
			return {
				stamp: `${now.ino}:${now.mtimeMs}:${now.size}`,
				changed: now.mtimeMs,
			};
		} catch {
			// Gone since it was listed: it is no longer a record.
			return undefined;
		}
	}

	/** One record, read again only when its file is not the one kept. */
	async function refresh(name: string): Promise<void> {
		const stamp = (await stampOf(join(cuts, name)))?.stamp;
		if (stamp === undefined) {
			kept.delete(name);
			return;
		}
		if (kept.get(name)?.stamp === stamp) return;
		let tree: Kept["tree"];
		try {
			tree = treeOf(JSON.parse(await readFile(join(cuts, name), "utf8")));
		} catch {
			// Half written or gone: that tree is left out until it is whole.
			kept.delete(name);
			return;
		}
		kept.set(name, { stamp, tree });
	}

	/** Each record looked at again; false when there is no folder of them. */
	async function relist(): Promise<boolean> {
		let listed: string[];
		try {
			listed = (await readdir(cuts)).filter((name) => name.endsWith(".json"));
		} catch {
			// No work records: the session works in its own folder alone.
			kept.clear();
			return false;
		}
		// A listing taken while a record is renamed over itself can miss it
		// on btrfs, so a record kept but not listed is looked at too, and
		// stays while its file does.
		const names = [...new Set([...listed, ...kept.keys()])];
		for (let from = 0; from < names.length; from += AT_ONCE) {
			await Promise.all(names.slice(from, from + AT_ONCE).map(refresh));
		}
		return true;
	}

	return {
		async dirsOf(session, cwd) {
			// Every record is renamed into place, which changes the folder, so a
			// folder unchanged since it was last listed holds what it held. It
			// is stamped before the listing, so a change during one is seen
			// next, and trusted only once settled.
			const stamped = Date.now();
			const now = await stampOf(cuts);
			if (now === undefined || now.stamp !== listedAt) {
				if (!(await relist())) {
					listedAt = undefined;
					return [cwd];
				}
				const settled =
					now !== undefined && stamped - now.changed >= SETTLED_MS;
				listedAt = settled ? now.stamp : undefined;
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
function treeOf(record: unknown): Kept["tree"] {
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
