/**
 * Which of pi's extension links moved after this process started.
 *
 * Node's module resolver remembers the real path of every link it has
 * resolved, for the life of the process, and pi hands its loader an
 * extension's link rather than its real path. So once a link in
 * `~/.pi/agent/extensions` moves, a reload reads the new entry file but
 * resolves its imports against the first target. On 11 November the
 * Shopify proxy's link moved at 13:17 and its first target was then
 * collected: a reload failed with "Cannot find module
 * './optimize-images.js'", and a session whose first target survived
 * reloaded onto the new entry and the old helpers mixed (6YZSML
 * [fbc059d2]). Only a new process reads the link afresh.
 *
 * A link's own modified time says when it was made, which is when it
 * last pointed somewhere new, and a launcher that finds it already right
 * leaves it alone, so one made after the process started is one its
 * resolver may hold stale. Its change time won't do: anything that
 * touches the link's owner or mode moves that too.
 *
 * A link made again onto a tree the same, file for file and byte for
 * byte, as the one it first pointed at, with that first tree still
 * there, is no move: the entry and its helpers read the same code from
 * either. The Mac's switch makes every link again onto the whole pi
 * config's new store path, though most switches change no extension's
 * code, and the follower can't start a session again while a command is
 * out; on 26 November 25 of the Mac's 125 live sessions had kept older
 * code that way for up to two days. So the first call in a process
 * notes each link's real target, and each move is compared once.
 */

import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Where a process keeps what it knows of each extensions folder, on
 * `globalThis`, since a reload evaluates this module afresh and the
 * resolver's memory lives as long as the process.
 */
const KNOWN = Symbol.for("agentic-harness.reload.extension-links");

/** The most entries a tree is read to, past which it counts as moved. */
const MOST_ENTRIES = 10_000;

/** The most bytes a tree's files are read to, past which it counts as moved. */
const MOST_BYTES = 64 * 1024 * 1024;

/** What a process knows of one extensions folder's links. */
interface Known {
	/** Each link's real target as the process first found it, by name. */
	readonly first: Map<string, string>;
	/** Each first target's digest, once read; undefined where it can't be. */
	readonly firstDigest: Map<string, string | undefined>;
	/** Whether a link's move reads the same tree, by name and new target. */
	readonly same: Map<string, boolean>;
}

/**
 * The names of the links in `folder` made after `startedAt` (epoch ms)
 * onto other code: each one but those made again onto a tree the same as
 * their first target, which is still there. A folder that can't be read
 * has none, since nothing in it was loaded.
 */
export function linksMovedSince(folder: string, startedAt: number): string[] {
	let names: string[];
	try {
		names = readdirSync(folder);
	} catch {
		// No extensions folder: pi loaded nothing from one.
		return [];
	}
	const known = knownOf(folder, names, startedAt);
	return names
		.filter((name) => {
			try {
				const stat = lstatSync(join(folder, name));
				return (
					stat.isSymbolicLink() &&
					stat.mtimeMs > startedAt &&
					!sameAsFirst(known, folder, name)
				);
			} catch {
				// Gone between the listing and the look: nothing to load stale.
				return false;
			}
		})
		.sort();
}

/**
 * What this process knows of `folder`, noting each link's real target
 * the first time it is asked. Only a link made before the process
 * started still points where its resolver first found it; one made since
 * has no first target known, and so counts as moved.
 */
function knownOf(folder: string, names: string[], startedAt: number): Known {
	const held = globalThis as typeof globalThis & {
		[KNOWN]?: Map<string, Known>;
	};
	held[KNOWN] ??= new Map();
	const found = held[KNOWN].get(folder);
	if (found !== undefined) return found;
	const known: Known = {
		first: new Map(),
		firstDigest: new Map(),
		same: new Map(),
	};
	for (const name of names) {
		const link = join(folder, name);
		try {
			const stat = lstatSync(link);
			if (stat.isSymbolicLink() && stat.mtimeMs <= startedAt) {
				known.first.set(name, realpathSync(link));
			}
		} catch {
			// A link that leads nowhere loaded nothing to keep.
		}
	}
	held[KNOWN].set(folder, known);
	return known;
}

/**
 * Whether `name` now leads to a tree the same as its first target,
 * which must still be there: a collected first target fails a reload's
 * imports whatever the new one holds.
 */
function sameAsFirst(known: Known, folder: string, name: string): boolean {
	const first = known.first.get(name);
	if (first === undefined) return false;
	let target: string;
	try {
		target = realpathSync(join(folder, name));
	} catch {
		// A link that leads nowhere can't be loaded the same.
		return false;
	}
	if (!existsSync(first)) return false;
	if (target === first) return true;
	const move = `${name}\0${target}`;
	let same = known.same.get(move);
	if (same === undefined) {
		if (!known.firstDigest.has(name)) {
			known.firstDigest.set(name, treeDigest(first));
		}
		const was = known.firstDigest.get(name);
		same = was !== undefined && was === treeDigest(target);
		known.same.set(move, same);
	}
	return same;
}

/**
 * A digest of the tree at `root`: each entry's path within it and kind,
 * a file's bytes and a link's own target, in name order. Undefined for a
 * tree that can't be read whole or is past {@link MOST_ENTRIES} entries
 * or {@link MOST_BYTES} bytes, which then counts as moved.
 */
function treeDigest(root: string): string | undefined {
	const hash = createHash("sha256");
	let entries = 0;
	let bytes = 0;
	const walk = (path: string, within: string): boolean => {
		entries += 1;
		if (entries > MOST_ENTRIES) return false;
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) {
			hash.update(`link\0${within}\0${readlinkSync(path)}\0`);
			return true;
		}
		if (stat.isDirectory()) {
			hash.update(`folder\0${within}\0`);
			return readdirSync(path)
				.sort()
				.every((name) =>
					walk(join(path, name), within === "" ? name : `${within}/${name}`),
				);
		}
		if (!stat.isFile()) return false;
		bytes += stat.size;
		if (bytes > MOST_BYTES) return false;
		const content = readFileSync(path);
		hash.update(`file\0${within}\0${content.length}\0`);
		hash.update(content);
		return true;
	};
	try {
		return walk(root, "") ? hash.digest("hex") : undefined;
	} catch {
		// A tree that can't be read whole can't be shown the same.
		return undefined;
	}
}
