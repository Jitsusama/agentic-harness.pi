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
 * A link made again from one Nix store folder onto another the same,
 * file for file and byte for byte, with the first still there, is told
 * apart from a move: the entry and its helpers read the same code from
 * either. The Mac's switch makes every link again onto the whole pi
 * config's new store path, though most switches change no extension's
 * code, and the follower can't start a session again while a command is
 * out; on 26 November 25 of the Mac's 125 live sessions had kept older
 * code that way for up to two days. So the first call in a process notes
 * each link's real target, and each move is compared once: store trees
 * never change, so a verdict read whole holds for good, while one that
 * failed to read is read again at the next check. A tree outside the
 * store can change after it is compared, so a move onto or from one
 * always counts, and so does a link to a single file, whose helpers lie
 * beside it rather than within it.
 *
 * What the comparison doesn't cover. A link inside the tree that
 * resolves out of it counts as moved, but an import that reaches out of
 * the tree (a relative path up past its root, or a package in a
 * node_modules above it) isn't read: a reload resolves it against the
 * first target, where a new process would read the new one. That is why
 * the follower still starts a session again over a link made again the
 * same wherever its holder can, and reloads only where it can't, which
 * gives such a session the new harness and keeps what its extensions
 * first loaded, older but never mixed. pi's own packages are aliased by
 * its loader rather than looked for above the tree, and neither Shopify
 * extension imports anything else from outside its own folder. The first
 * target is looked for at each check, not held: a collection in the
 * seconds between the check and the reload, or one later that a dynamic
 * import then meets, fails as on 11 November, and the next check counts
 * the link as moved again.
 */

import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	statSync,
} from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

/**
 * Where a process keeps what it knows of each extensions folder, on
 * `globalThis`, since a reload evaluates this module afresh and the
 * resolver's memory lives as long as the process. Versioned, since a
 * reload may bring code that keeps it in another shape. Code that moves
 * to another key must carry this one's first targets over: without
 * them, every link a switch made again since the process started reads
 * as moved, and each session that reloaded over one asks to start again.
 */
const KNOWN = Symbol.for("agentic-harness.reload.extension-links.v1");

/** The most entries a tree is read to, past which it counts as moved. */
export const MOST_ENTRIES = 2_000;

/** The most bytes a tree's files are read to, past which it counts as moved. */
export const MOST_BYTES = 8 * 1024 * 1024;

/**
 * What became of a link made since the process started: `same` where it
 * was made again onto a store folder the same as its first target,
 * which is still there; otherwise why it counts as moved.
 */
export type LinkVerdict =
	| "same"
	| "differs"
	| "first unknown"
	| "first gone"
	| "leads nowhere"
	| "outside the store"
	| "not a folder"
	| "too big"
	| "inner link leads out"
	| "unreadable";

/** One link made since the process started, and what became of it. */
export interface LinkChange {
	readonly name: string;
	readonly verdict: LinkVerdict;
}

/** A tree's digest, or why it can't be shown the same as another. */
type Digest = { readonly digest: string } | { readonly verdict: LinkVerdict };

/** What a process knows of one extensions folder's links. */
interface Known {
	/** Each link's real target as the process first found it, by name. */
	readonly first: Map<string, string>;
	/** Each first target's digest, once read whole. */
	readonly firstDigest: Map<string, Digest>;
	/** What a link's move came to, by name and new target, once read whole. */
	readonly verdicts: Map<string, LinkVerdict>;
}

/**
 * The names of the links in `folder` made after `startedAt` (epoch ms)
 * onto other code: each one but those made again from one store folder
 * onto another the same, with the first still there.
 */
export function linksMovedSince(folder: string, startedAt: number): string[] {
	return linkChanges(folder, startedAt)
		.filter((change) => change.verdict !== "same")
		.map((change) => change.name);
}

/**
 * Each link in `folder` made after `startedAt` (epoch ms), in name
 * order, and what became of it. A folder that can't be read has none,
 * since nothing in it was loaded.
 */
export function linkChanges(folder: string, startedAt: number): LinkChange[] {
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
				return stat.isSymbolicLink() && stat.mtimeMs > startedAt;
			} catch {
				// Gone between the listing and the look: nothing to load stale.
				return false;
			}
		})
		.sort()
		.map((name) => ({ name, verdict: verdictOf(known, folder, name) }));
}

/**
 * What this process knows of `folder`, noting each link's real target
 * the first time it is asked. Only a link made before the process
 * started still points where its resolver first found it; one made since
 * has no first target known, and so counts as moved. Kept by folder and
 * start, so a caller giving another start is answered for that one.
 */
function knownOf(folder: string, names: string[], startedAt: number): Known {
	const folders = knownFolders();
	const key = `${folder}\0${startedAt}`;
	const found = folders.get(key);
	if (found !== undefined) return found;
	const known: Known = {
		first: new Map(),
		firstDigest: new Map(),
		verdicts: new Map(),
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
	folders.set(key, known);
	return known;
}

/** The folders this process knows, kept on `globalThis` across reloads. */
function knownFolders(): Map<string, Known> {
	const held: unknown = Reflect.get(globalThis, KNOWN);
	if (isKnownFolders(held)) return held;
	const folders = new Map<string, Known>();
	Reflect.set(globalThis, KNOWN, folders);
	return folders;
}

/** Whether what `globalThis` holds is this version's map of folders. */
function isKnownFolders(held: unknown): held is Map<string, Known> {
	return held instanceof Map;
}

/**
 * What became of `name`, made since the process started. Same only where
 * it now leads to a store folder the same as its first target, which
 * must still be there: a collected first target fails a reload's imports
 * whatever the new one holds. A verdict read whole is kept for the move;
 * a read that failed is tried again at the next check.
 */
function verdictOf(known: Known, folder: string, name: string): LinkVerdict {
	const first = known.first.get(name);
	if (first === undefined) return "first unknown";
	let target: string;
	try {
		target = realpathSync(join(folder, name));
	} catch {
		// Made again onto nothing: nothing to load the same.
		return "leads nowhere";
	}
	if (!existsSync(first)) return "first gone";
	if (target === first) return "same";
	const store = storeRoot();
	if (!(inStore(first, store) && inStore(target, store))) {
		return "outside the store";
	}
	const move = `${name}\0${target}`;
	const kept = known.verdicts.get(move);
	if (kept !== undefined) return kept;
	try {
		const was = known.firstDigest.get(name) ?? treeDigest(first);
		known.firstDigest.set(name, was);
		const now = treeDigest(target);
		const verdict =
			"verdict" in was
				? was.verdict
				: "verdict" in now
					? now.verdict
					: was.digest === now.digest
						? "same"
						: "differs";
		known.verdicts.set(move, verdict);
		return verdict;
	} catch {
		// A read that failed (a file it can't open, too many open at
		// once) can't show the trees the same, this time.
		return "unreadable";
	}
}

/**
 * The real path of the Nix store, whose trees never change once made:
 * where Nix itself is told it is, else `/nix/store`. A name that is
 * empty, relative or the root of the disk would take in paths that do
 * change, so it reads as the default.
 */
function storeRoot(): string {
	const named = process.env.NIX_STORE_DIR;
	const store =
		named !== undefined && isAbsolute(named) && resolve(named) !== sep
			? resolve(named)
			: "/nix/store";
	try {
		return realpathSync(store);
	} catch {
		// No store here: nothing is in it.
		return store;
	}
}

/** Whether `path` lies within the store at `store`. */
function inStore(path: string, store: string): boolean {
	return store !== sep && path.startsWith(`${store}${sep}`);
}

/**
 * A digest of the folder at `root`, a real path: each entry's path
 * within it and kind, a file's bytes and a link's own text, in name
 * order. A verdict in its place for a root that isn't a folder, a tree
 * past {@link MOST_ENTRIES} entries or {@link MOST_BYTES} bytes, an
 * entry neither file, folder nor link, or a link that resolves outside
 * the tree or nowhere; each counts as moved and holds for good. A read
 * that fails throws, so it is tried again.
 */
function treeDigest(root: string): Digest {
	if (!statSync(root).isDirectory()) return { verdict: "not a folder" };
	const hash = createHash("sha256");
	let entries = 0;
	let bytes = 0;
	const walk = (path: string, within: string): LinkVerdict | undefined => {
		entries += 1;
		if (entries > MOST_ENTRIES) return "too big";
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) {
			const text = readlinkSync(path);
			if (!leadsWithin(path, root)) return "inner link leads out";
			hash.update(`link\0${within}\0${text}\0`);
			return undefined;
		}
		if (stat.isDirectory()) {
			hash.update(`folder\0${within}\0`);
			for (const name of readdirSync(path).sort()) {
				const verdict = walk(
					join(path, name),
					within === "" ? name : `${within}/${name}`,
				);
				if (verdict !== undefined) return verdict;
			}
			return undefined;
		}
		if (!stat.isFile()) return "unreadable";
		bytes += stat.size;
		if (bytes > MOST_BYTES) return "too big";
		const content = readFileSync(path);
		hash.update(`file\0${within}\0${content.length}\0`);
		hash.update(content);
		return undefined;
	};
	const verdict = walk(root, "");
	return verdict === undefined ? { digest: hash.digest("hex") } : { verdict };
}

/**
 * Whether the link at `path` resolves to somewhere within `root`, as the
 * filesystem follows it, through any other link on the way. One that
 * leads nowhere can't be shown to stay.
 */
function leadsWithin(path: string, root: string): boolean {
	try {
		const lands = realpathSync(path);
		return lands === root || lands.startsWith(`${root}${sep}`);
	} catch {
		return false;
	}
}
