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
 * A link made again from one Nix store tree onto another the same, file
 * for file and byte for byte, with the first still there, is no move:
 * the entry and its helpers read the same code from either. The Mac's
 * switch makes every link again onto the whole pi config's new store
 * path, though most switches change no extension's code, and the
 * follower can't start a session again while a command is out; on 26
 * November 25 of the Mac's 125 live sessions had kept older code that
 * way for up to two days. So the first call in a process notes each
 * link's real target, and each move is compared once: store trees never
 * change, so a verdict holds for good. A tree outside the store can
 * change after it is compared, so a move onto or from one always counts.
 *
 * What the comparison doesn't cover. A link inside the tree that leads
 * out of it counts as moved, but an import that reaches out of the tree
 * (a relative path up past its root, or a package in a node_modules
 * above it) isn't read: it resolves against the first target as before,
 * which is still there, so a reload keeps what the process first loaded
 * there, older but never mixed. Neither Shopify link's extension imports
 * anything from outside its own folder. The first target is looked for
 * at each check, not held: a collection in the seconds between the check
 * and the reload, or one later that a dynamic import then meets, fails
 * as on 11 November, and the next check counts the link as moved again.
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
import { join, posix, sep } from "node:path";

/**
 * Where a process keeps what it knows of each extensions folder, on
 * `globalThis`, since a reload evaluates this module afresh and the
 * resolver's memory lives as long as the process. Versioned, since a
 * reload may bring code that keeps it in another shape.
 */
const KNOWN = Symbol.for("agentic-harness.reload.extension-links.v1");

/** The most entries a tree is read to, past which it counts as moved. */
const MOST_ENTRIES = 2_000;

/** The most bytes a tree's files are read to, past which it counts as moved. */
const MOST_BYTES = 8 * 1024 * 1024;

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
 * onto other code: each one but those made again from one store tree
 * onto another the same, with the first still there. A folder that can't
 * be read has none, since nothing in it was loaded.
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
				if (!(stat.isSymbolicLink() && stat.mtimeMs > startedAt)) return false;
			} catch {
				// Gone between the listing and the look: nothing to load stale.
				return false;
			}
			return !sameAsFirst(known, folder, name);
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
	const held = globalThis as typeof globalThis & { [KNOWN]?: unknown };
	if (!(held[KNOWN] instanceof Map)) held[KNOWN] = new Map<string, Known>();
	const folders = held[KNOWN] as Map<string, Known>;
	const found = folders.get(folder);
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
	folders.set(folder, known);
	return known;
}

/**
 * Whether `name` now leads to a tree the same as its first target,
 * which must still be there: a collected first target fails a reload's
 * imports whatever the new one holds. Anything that goes wrong in
 * finding out counts as a move.
 */
function sameAsFirst(known: Known, folder: string, name: string): boolean {
	try {
		const first = known.first.get(name);
		if (first === undefined) return false;
		const target = realpathSync(join(folder, name));
		if (!existsSync(first)) return false;
		if (target === first) return true;
		if (!(inStore(first) && inStore(target))) return false;
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
	} catch {
		// A link that leads nowhere, or a tree that can't be read, can't
		// be shown to load the same.
		return false;
	}
}

/**
 * Whether `path` lies in the Nix store, whose trees never change once
 * made: where Nix itself is told the store is, else `/nix/store`.
 */
function inStore(path: string): boolean {
	const store = process.env.NIX_STORE_DIR ?? "/nix/store";
	return path.startsWith(store.endsWith(sep) ? store : `${store}${sep}`);
}

/**
 * A digest of the tree at `root`: each entry's path within it and kind,
 * a file's bytes and a link's own target, in name order. Undefined for a
 * tree that can't be read whole, holds a link that leads out of it, or
 * is past {@link MOST_ENTRIES} entries or {@link MOST_BYTES} bytes,
 * which then counts as moved.
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
			const text = readlinkSync(path);
			const lands = posix.normalize(posix.join(posix.dirname(within), text));
			if (posix.isAbsolute(text) || lands === ".." || lands.startsWith("../"))
				return false;
			hash.update(`link\0${within}\0${text}\0`);
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
