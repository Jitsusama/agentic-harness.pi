/**
 * A folder's files and their parses, kept for synchronous readers and
 * refreshed off the thread.
 *
 * A host runs every conversation on one thread, so a synchronous read of
 * a folder on a stalled disk holds them all: on 16 November six reads of
 * the mesh's folders held the background host's loop for 8 to 17 s each.
 * A mirror answers those readers from what it last read, and reads again
 * through the promise API, once for every caller in the process.
 *
 * It spends only while asked. The first ask in a process reads the folder
 * at once, since an empty answer before the mirror fills would read as
 * nobody there, and so does the first after a spell in which nothing
 * listed it, whose last listing could be an hour old. Between, it keeps
 * up while a synchronous reader has asked within the last minute, and
 * stops once none has. A folder that can't be read keeps the last
 * listing rather than answering that it holds nothing. A refresh
 * already reading is joined, never run beside itself. What the process
 * writes itself is put in at once.
 *
 * While its folder is watched, a change the watch names is read alone,
 * and the whole folder is listed again only every half minute, in case
 * the watch missed one, and at once whenever a new watch replaces one
 * lost or moved away with its folder. Unwatched, it lists the folder
 * each second. Every conversation became a process of its own on 20
 * November, each with its own mirror of the mesh's presence: on 21
 * November seventy idle children listed its 163 files each second, and
 * held the disk in btrfs's directory locks. One such mirror, benched,
 * made 281 stats a second; reading only what changed made 16. The
 * folders mirrored are local state, where a watch hears every writer.
 */

import { type FSWatcher, readdirSync, watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { readStamped, readStampedOff, type Stamped } from "./stamped-read.ts";

/**
 * How often a mirror looks at its folder while it is asked: unwatched, it
 * lists it each time; watched, it checks the watch still follows it.
 */
const POLL_MS = 1000;

/**
 * How often a watched mirror lists its whole folder again, for a change
 * its watch missed, as some filesystems miss renames.
 */
const BACKSTOP_MS = 30_000;

/** How long a mirror keeps polling after its last synchronous ask. */
const IDLE_MS = 60_000;

/**
 * How many idle spells old a listing may be and still answer a first
 * ask after one: two, so a minute's look that lands a little late still
 * counts.
 */
const STALE_SPELLS = 2;

/** The files a mirror keeps, and how it parses one. */
export interface MirroredFiles<T> {
	/** The ending of a file the mirror keeps, such as `.json`. */
	readonly suffix: string;
	/** The file at a path, parsed on the thread; none when unreadable. */
	read(path: string): T | undefined;
	/** The file at a path, parsed off the thread; none when unreadable. */
	readOff(path: string): Promise<T | undefined>;
}

/** How long a mirror waits, for a test that can't wait a minute. */
export interface MirrorTimes {
	readonly pollMs?: number;
	readonly idleMs?: number;
	readonly backstopMs?: number;
}

/** A folder's files as last read, by path, in the folder's own order. */
export type Mirrored<T> = ReadonlyMap<string, T | undefined>;

/** One folder's files, mirrored or read as asked. */
export interface FolderMirror<T> {
	/** Its files as last read, for a synchronous reader. */
	files(): Mirrored<T>;
	/** One of its files, as `files()` has it. */
	file(path: string): T | undefined;
	/** Its files read again off the thread, joining a read in flight. */
	refresh(): Promise<Mirrored<T>>;
	/** A file this process wrote, as it parses. */
	put(path: string, value: T | undefined): void;
	/** A file this process removed. */
	drop(path: string): void;
}

/**
 * One mirror a folder for files of one kind, made on first ask and kept
 * for the life of the module: a mirror nobody asks stops its poll and
 * its watch, so what it keeps is one listing of small files. Each copy
 * of a module a host loads keeps its own, so a copy a reload left
 * behind, which nobody asks, stops reading within its idle spell.
 */
export function folderMirrors<T>(
	kind: MirroredFiles<T>,
	times: MirrorTimes = {},
): (dir: string) => FolderMirror<T> {
	const mirrors = new Map<string, FolderMirror<T>>();
	return (dir) => {
		let mirror = mirrors.get(dir);
		if (mirror === undefined) {
			mirror = mirrorOf(dir, kind, times);
			mirrors.set(dir, mirror);
		}
		return mirror;
	};
}

/**
 * A folder read as it is asked, each file's parse kept while its stamp
 * holds: for a process with one conversation, whose stalled read holds
 * only itself, and which then spends nothing while nobody asks.
 */
export function folderRead<T>(
	dir: string,
	kind: MirroredFiles<T>,
): FolderMirror<T> {
	const kept = new Map<string, Stamped<T>>();
	// What the folder last listed, answered as kept while it can't be read.
	let last: string[] = [];
	const lastRead = (): Mirrored<T> =>
		new Map(
			pathsIn(dir, kind, last).map((path) => [path, kept.get(path)?.value]),
		);
	const listed = (names: string[], values: (T | undefined)[]): Mirrored<T> => {
		last = names;
		const paths = pathsIn(dir, kind, names);
		const found = new Set(paths);
		for (const path of kept.keys()) if (!found.has(path)) kept.delete(path);
		return new Map(paths.map((path, at) => [path, values[at]]));
	};
	return {
		files() {
			let names: string[];
			try {
				names = readdirSync(dir);
			} catch (error) {
				// Unreadable now: what it last read stands, never "no files".
				if (!isMissing(error)) return lastRead();
				// No folder yet: nothing written there.
				names = [];
			}
			const paths = pathsIn(dir, kind, names);
			return listed(
				names,
				paths.map((path) => readStamped(kept, path, kind.read)),
			);
		},
		file: (path) => readStamped(kept, path, kind.read),
		async refresh() {
			const names = await readdir(dir).catch((error: unknown) => {
				// No folder yet is nothing written there; else unreadable now.
				if (isMissing(error)) return [];
				return undefined;
			});
			if (names === undefined) return lastRead();
			const paths = pathsIn(dir, kind, names);
			const values = await Promise.all(
				paths.map((path) => readStampedOff(kept, path, kind.readOff)),
			);
			return listed(names, values);
		},
		// The disk is read at each ask, so a write is seen there.
		put: nothing,
		drop: (path) => {
			kept.delete(path);
		},
	};
}

/** The paths of the files of `kind` among a folder's `names`. */
function pathsIn<T>(
	dir: string,
	kind: MirroredFiles<T>,
	names: string[],
): string[] {
	return names
		.filter((name) => name.endsWith(kind.suffix))
		.map((name) => join(dir, name));
}

function mirrorOf<T>(
	dir: string,
	kind: MirroredFiles<T>,
	times: MirrorTimes,
): FolderMirror<T> {
	const pollMs = times.pollMs ?? POLL_MS;
	const idleMs = times.idleMs ?? IDLE_MS;
	const backstopMs = times.backstopMs ?? BACKSTOP_MS;
	const kept = new Map<string, Stamped<T>>();
	let order: string[] | undefined;
	let asked = 0;
	let clock: ReturnType<typeof setInterval> | undefined;
	let watcher: FSWatcher | undefined;
	// The folder the watch follows, by identity, and a look at it under
	// way: a watch keeps following a folder renamed away, hearing nothing
	// new.
	let watched: string | undefined;
	let looking = false;
	// A watch being made.
	let making = false;
	let flight: Promise<Mirrored<T>> | undefined;
	// The files a watch named since they were last read, and their read.
	const touched = new Set<string>();
	let naming: Promise<void> | undefined;
	// A write counts up, so a read that began before it keeps what it put
	// or removed, rather than landing what the file was before.
	let writes = 0;
	// The writes counted when the refresh in flight listed the folder.
	let reading: number | undefined;
	// When a listing last landed, and how many the thread has read, so a
	// refresh that listed before the thread read again leaves its newer one.
	let landed = 0;
	let fills = 0;
	const written = new Map<
		string,
		{ at: number; value: T | undefined; gone: boolean }
	>();

	const view = (): Mirrored<T> =>
		new Map((order ?? []).map((path) => [path, kept.get(path)?.value]));
	const settle = (paths: string[], since: number): void => {
		const listed = new Set(paths);
		for (const [path, { at, value, gone }] of written) {
			if (at <= since) written.delete(path);
			else if (gone) listed.delete(path);
			else {
				kept.set(path, { stamp: "", value });
				listed.add(path);
			}
		}
		for (const path of kept.keys()) if (!listed.has(path)) kept.delete(path);
		order = [...listed];
		landed = Date.now();
	};
	const fill = (): void => {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch (error) {
			// Unreadable now: the last listing stands, or none before any.
			if (!isMissing(error)) {
				order ??= [];
				return;
			}
			names = [];
		}
		const paths = pathsIn(dir, kind, names);
		for (const path of paths) readStamped(kept, path, kind.read);
		// A refresh in flight listed before some writes: they stay kept.
		settle(paths, reading ?? writes);
		fills += 1;
	};
	const readAgain = async (): Promise<Mirrored<T>> => {
		const since = writes;
		const filled = fills;
		reading = since;
		try {
			const names = await readdir(dir).catch((error: unknown) => {
				// No folder yet is nothing written there; else unreadable now.
				if (isMissing(error)) return [];
				return undefined;
			});
			// An unreadable folder leaves the last listing, never "no files".
			if (names === undefined) return view();
			const paths = pathsIn(dir, kind, names);
			// Read beside what is kept, so a read the thread overtook lands none.
			const fresh = new Map(kept);
			await Promise.all(
				paths.map((path) => readStampedOff(fresh, path, kind.readOff)),
			);
			// The thread read the folder since this listed it: what it read
			// is the newer, so it stands.
			if (fills !== filled) return view();
			for (const path of paths) {
				const one = fresh.get(path);
				if (one === undefined) kept.delete(path);
				else kept.set(path, one);
			}
			settle(paths, since);
			return view();
		} finally {
			reading = undefined;
		}
	};
	const refresh = (): Promise<Mirrored<T>> => {
		// After the named reads under way, so neither lands over the other.
		flight ??= (naming ?? Promise.resolve()).then(readAgain).finally(() => {
			flight = undefined;
		});
		return flight;
	};
	// The files the watch named, each read alone off the thread.
	const readTouched = async (): Promise<void> => {
		const paths = [...touched];
		touched.clear();
		const filled = fills;
		const fresh = new Map<string, Stamped<T>>();
		for (const path of paths) {
			const was = kept.get(path);
			if (was !== undefined) fresh.set(path, was);
		}
		await Promise.all(
			paths.map((path) => readStampedOff(fresh, path, kind.readOff)),
		);
		// A read that failed, at its stat or after, on a file still there
		// leaves what was kept until the next listing settles it, rather
		// than dropping a live peer on one torn read.
		const gone = new Set<string>();
		for (const path of paths) {
			if (fresh.get(path)?.value !== undefined) continue;
			fresh.delete(path);
			if (await missing(path)) gone.add(path);
		}
		// The thread read the folder meanwhile: what it read is the newer.
		if (fills !== filled || order === undefined) return;
		for (const path of paths) {
			// This process's own write stands until a listing settles it.
			if (written.has(path)) continue;
			const one = fresh.get(path);
			if (one === undefined && !gone.has(path)) continue;
			if (one === undefined) {
				kept.delete(path);
				order = order.filter((listed) => listed !== path);
			} else {
				kept.set(path, one);
				if (!order.includes(path)) order = [...order, path];
			}
		}
	};
	const readNamed = (path: string): void => {
		touched.add(path);
		if (naming !== undefined) return;
		// After a listing under way, so neither lands over the other.
		naming = (flight ?? Promise.resolve())
			.catch(nothing)
			.then(readTouched)
			.catch(nothing)
			.finally(() => {
				naming = undefined;
				// Named while these were read: read them next.
				const next = touched.values().next();
				if (!next.done) {
					touched.delete(next.value);
					readNamed(next.value);
				}
			});
	};
	const unwatch = (): void => {
		watcher?.close();
		watcher = undefined;
		watched = undefined;
	};
	// The folder is read before its watch is made, off the thread: one
	// moved between the two is then a folder the next look finds changed.
	const rewatch = (): void => {
		if (watcher !== undefined || making) return;
		making = true;
		void stat(dir)
			.then(
				(folder) => watchFolder(identity(folder)),
				() => {
					// No folder yet: the poll alone lists until one is made.
				},
			)
			.catch(() => {
				// No watch on this filesystem: the poll alone lists it.
			})
			.finally(() => {
				making = false;
			});
	};
	const watchFolder = (folder: string): void => {
		// Put down meanwhile, or watched already: nothing to make.
		if (clock === undefined || watcher !== undefined) return;
		const made = watch(dir, { persistent: false }, (_kind, name) => {
			// The folder itself removed or renamed away, as libuv names it: the
			// watch hears nothing more, so the next tick makes one and lists.
			if (name === basename(dir)) {
				if (watcher === made) unwatch();
				return;
			}
			// A file of its kind is read alone; a staged one is passed over
			// until it is renamed in; an event naming none lists them all.
			if (name === null) void refresh().catch(nothing);
			else if (name.endsWith(kind.suffix) && basename(name) === name)
				readNamed(join(dir, name));
		});
		watcher = made;
		// A watch that fails is made again on the next tick, and lists the
		// folder; one that overflows says nothing, so the backstop lists what
		// it dropped.
		watcher.on("error", unwatch);
		watched = folder;
		void listAfterWatching().catch(nothing);
	};
	// What changed before the watch heard it, since the last listing or
	// the watch lost: one listing begun after it was made, so not one under
	// way, which may have read the folder before.
	const listAfterWatching = async (): Promise<void> => {
		await flight?.catch(nothing);
		await refresh();
	};
	// One stat of the folder a tick, off the thread: one renamed away, or
	// made again, drops the watch, so the next tick follows the new one.
	// A folder made again with its inode back looks the same here, so the
	// watch's own word that its folder went drops it as well. Birth would
	// tell them apart, but where libuv can't use statx it reports the
	// folder's ctime, which every publish moves.
	const look = (): void => {
		if (looking || watcher === undefined || watched === undefined) return;
		looking = true;
		const following = watched;
		void stat(dir)
			.then(
				(folder) => identity(folder) !== following,
				(error: unknown) => isMissing(error),
			)
			.then((moved) => {
				if (moved && watched === following) unwatch();
			})
			.finally(() => {
				looking = false;
			});
	};
	const tick = (): void => {
		if (Date.now() - asked > idleMs) {
			clearInterval(clock);
			clock = undefined;
			unwatch();
			return;
		}
		rewatch();
		look();
		// Watched, the folder is listed again only at the backstop, for what
		// the watch missed; a new watch lists what the one lost missed.
		if (watcher !== undefined && Date.now() - landed < backstopMs) return;
		void refresh().catch(nothing);
	};
	const ask = (): void => {
		asked = Date.now();
		// The first ask reads the disk at once, and so does the first after
		// a spell in which nothing listed the folder, since a listing that
		// old would start a new peer blind. A host's conversations list it
		// off the thread each minute, so there one landed meanwhile answers
		// while it is read again. One still reading may be on a stalled
		// disk, which the thread would then wait on: the last listing
		// answers until it lands.
		if (clock === undefined) {
			const stale = Date.now() - landed > STALE_SPELLS * idleMs;
			if (order === undefined || (stale && flight === undefined)) fill();
			else void refresh().catch(nothing);
			clock = setInterval(tick, pollMs);
			clock.unref();
			rewatch();
		}
	};
	return {
		files() {
			ask();
			return view();
		},
		// Only listed files and this process's writes are kept, so one file
		// is read without listing them all.
		file(path) {
			ask();
			return kept.get(path)?.value;
		},
		refresh,
		put(path, value) {
			writes += 1;
			written.set(path, { at: writes, value, gone: false });
			kept.set(path, { stamp: "", value });
			if (order !== undefined && !order.includes(path))
				order = [...order, path];
		},
		drop(path) {
			writes += 1;
			written.set(path, { at: writes, value: undefined, gone: true });
			kept.delete(path);
			if (order !== undefined) order = order.filter((one) => one !== path);
		},
	};
}

/** Whether a file is gone, rather than unreadable for now. */
async function missing(path: string): Promise<boolean> {
	return stat(path).then(
		() => false,
		(error: unknown) => isMissing(error),
	);
}

/** Which folder a stat found: its device and inode, together. */
function identity(folder: {
	readonly dev: number;
	readonly ino: number;
}): string {
	return `${folder.dev}:${folder.ino}`;
}

/** Whether a failed read found no folder, rather than one unreadable. */
function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Nothing, for a refresh whose failure the next tick reads past. */
function nothing(): void {
	// A folder that can't be read now is read again on the next tick.
}
