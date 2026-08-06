/**
 * Which change a call is about, when the caller did not say.
 *
 * Every review tool used to demand a change on every call, so
 * reading a diff and then its threads meant naming the same
 * pull request twice, and the second naming was where typos
 * lived. A session attaches to what it is working on instead,
 * and a call without a change acts on that.
 *
 * The rule is the browser integration's, because it was learned
 * the same way and there is no reason for two answers to the
 * same question. What differs is only the vocabulary: sessions
 * are opened and changes are attached.
 */

import type { Dirent } from "node:fs";
import {
	mkdir,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { ChangeRef } from "./change.js";
import { changeKey } from "./keys.js";

/** A change this session is working on. */
export interface Attachment {
	readonly change: ChangeRef;
	/** When it was attached, for the reader rather than for sorting. */
	readonly attachedAt: string;
	/**
	 * Position in the order things were attached, climbing.
	 *
	 * A timestamp cannot do this job. Attaching two changes in
	 * quick succession, which is exactly what happens when a
	 * stack is attached, lands them in the same millisecond and
	 * leaves the order down to whatever the filesystem hands
	 * back. A counter is monotonic by construction and survives a
	 * restart, since it is derived from what is already on disk.
	 */
	readonly seq: number;
}

/** Durable home for what a session is attached to. */
export interface AttachmentStore {
	/** Attach a change, or freshen one already attached. */
	attach(change: ChangeRef): Promise<void>;
	/** Detach by label, reporting whether there was one to detach. */
	detach(label: string): Promise<boolean>;
	/** Newest first. */
	list(): Promise<Attachment[]>;
}

/**
 * Carry one session's attachments into another.
 *
 * For a fork, which is the same work continued under a new session
 * id. Scoping attachments by session is what stopped one session
 * retargeting another's round, and it made a fork start with nothing
 * attached, so the first call after one either refused for want of a
 * change or acted on whatever was named by hand. Neither is what
 * forking means.
 *
 * A copy rather than a move: the session forked from is still there
 * and still working on what it was working on.
 *
 * Never overwrites. Inheriting happens at session start, and a fork
 * that has already said what it is working on has said something the
 * parent cannot know better. The order is preserved among what is
 * carried, and every carried attachment sits below what the fork
 * already held, since an inherited number outranking this session's
 * own would let the parent's oldest work decide what a call acts on.
 *
 * Advisory, like every other reclamation here: what it cannot read it
 * does not carry, and nothing about a fork fails over it.
 *
 * Returns how many were carried.
 */
export async function inheritAttachments(
	root: string,
	from: string,
	to: string,
): Promise<number> {
	// Reading and writing one directory, where every name collides with
	// itself, is a way to lose an attachment rather than keep one.
	if (safeName(from) === safeName(to)) return 0;
	const parent = createAttachmentStore(root, from);
	const fork = createAttachmentStore(root, to);
	let held: Attachment[];
	let mine: Attachment[];
	try {
		held = await parent.list();
		mine = await fork.list();
	} catch {
		// An unreadable directory carries nothing. An attachment is a
		// convenience and never the record of anything.
		return 0;
	}
	if (held.length === 0) return 0;
	const already = new Set(mine.map((one) => changeKey(one.change)));
	// Oldest first, so the parent's own order survives the renumbering:
	// each carried attachment is written above the one before it and
	// below everything this session attached itself.
	const carrying = held
		.filter((one) => !already.has(changeKey(one.change)))
		.reverse();
	if (carrying.length === 0) return 0;
	const floor = mine.reduce((max, one) => Math.max(max, one.seq), 0);
	const mineDir = join(root, safeName(to));
	let carried = 0;
	for (const [index, one] of carrying.entries()) {
		try {
			await mkdir(mineDir, { recursive: true });
			const record: Attachment = { ...one, seq: floor + index + 1 };
			await writeFile(
				join(mineDir, fileFor(one.change)),
				JSON.stringify(record, null, 2),
				"utf8",
			);
			carried += 1;
		} catch {
			// One that cannot be written is one the fork attaches again
			// by hand, which is a smaller loss than a fork that fails to
			// start over a convenience.
		}
	}
	return carried;
}

/**
 * Give back the directories of sessions that have stopped using them.
 *
 * Scoping attachments per session means one directory per session for
 * as long as the state directory lives, so something has to take them
 * back. Age is judged on the newest attachment inside, not on the
 * directory itself: a directory's timestamp moves when an entry is
 * added or removed and stands still when one is rewritten in place, so
 * a session that keeps freshening the same change would age as though
 * nobody had touched it. The one asking is never swept regardless,
 * because a long-lived session attaches its work once and then only
 * reads it, which is exactly the shape an age rule mistakes for
 * abandonment.
 *
 * Attachments made before scoping existed sit flat in the root, and go
 * on the same clock. They belong to no session and no scoped caller
 * can see them, which used to be the argument for leaving them: no
 * session's rule should decide another's fate. That argument is about
 * somebody's attachment, and an attachment nothing can read is not
 * somebody's. A month is long enough that an upgrade last week is
 * still reversible by hand, and short enough that they stop being
 * kept for as long as the state directory lives. Judged on the file's
 * own age, since nothing rewrites one.
 *
 * Only ones shaped like an attachment. A person who goes looking may
 * leave a note behind, and a sweep that takes whatever it finds is one
 * nobody can safely point at a directory.
 *
 * An empty directory is swept, since it holds nothing anybody can
 * lose.
 *
 * Returns how many were taken back.
 */
export async function pruneAttachments(
	root: string,
	options: { olderThanMs: number; keep?: string },
): Promise<number> {
	let entries: Dirent[];
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		// Nothing has ever been attached, so there is nothing to reclaim.
		return 0;
	}
	const cutoff = Date.now() - options.olderThanMs;
	// Through the same rewriting the store used to build the directory
	// name, or a session whose id holds a character a path cannot carry
	// would fail to match its own and be swept by the sweep that
	// promises never to touch it.
	const mine = options.keep === undefined ? undefined : safeName(options.keep);
	let taken = 0;
	for (const entry of entries) {
		if (entry.name === mine) continue;
		const loose = entry.isFile() && entry.name.endsWith(".json");
		if (!entry.isDirectory() && !loose) continue;
		const path = join(root, entry.name);
		try {
			const newest = loose
				? (await stat(path)).mtimeMs
				: await newestWithin(path);
			if (newest > cutoff) continue;
			await rm(path, { recursive: true, force: true });
			taken += 1;
		} catch {
			// Another session may be writing here, or may have removed it
			// already. Reclaiming disk is advisory: what it cannot take
			// back this time it will find again next time.
		}
	}
	return taken;
}

/**
 * When anything in this directory was last written.
 *
 * Zero for one holding nothing, which reads as long ago and is right:
 * an empty directory has nothing to lose.
 */
async function newestWithin(path: string): Promise<number> {
	const names = await readdir(path);
	let newest = 0;
	for (const name of names) {
		try {
			newest = Math.max(newest, (await stat(join(path, name))).mtimeMs);
		} catch {
			// Removed while being read, by another session's sweep or its
			// own detach. It cannot be the newest thing here if it is
			// already gone.
		}
	}
	return newest;
}

/**
 * File name for an attachment.
 *
 * Keyed by the provider-scoped change key rather than the label,
 * because a label is for people: two systems can spell the same
 * repo differently, and a label carrying a slash or a pair of
 * dots would otherwise name a path outside the store. The key is
 * hashed to a flat name for the same reason.
 */
function fileFor(change: ChangeRef): string {
	return `${safeName(changeKey(change))}.json`;
}

/**
 * One path segment, from a name that came from somewhere else.
 *
 * A change key or a session id is whatever the provider or the host
 * chose, so one carrying a slash or a pair of dots would name a path
 * outside the store.
 */
function safeName(name: string): string {
	const safe = name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
	return safe === "" ? "_" : safe;
}

/** Read one attachment, or nothing when it is unreadable. */
async function readAttachment(path: string): Promise<Attachment | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			!("change" in parsed) ||
			!("attachedAt" in parsed) ||
			typeof (parsed as { seq?: unknown }).seq !== "number"
		) {
			return undefined;
		}
		return parsed as Attachment;
	} catch {
		// An attachment is a convenience, never the record of
		// anything. A file half-written by a kill, or left by an
		// older shape of this type, should cost the reader nothing:
		// they attach again and carry on.
		return undefined;
	}
}

/**
 * Attachments on disk, one flat directory of JSON files.
 *
 * The same idiom as the draft store, and for the same reasons:
 * legible to somebody who goes looking, cheap to list, and with
 * no index that can fall out of step with the files it claims to
 * describe.
 */
export function createAttachmentStore(
	root: string,
	sessionId: string,
): AttachmentStore {
	// One directory per session. What a session is working on is a fact
	// about that session, and keeping every session's answer in one
	// place made the newest of them everybody's: a round in one session
	// was silently retargeted by another session attaching its own work,
	// and the judge that followed consolidated a different repository's
	// council while reporting success. Two sessions attached to the same
	// change also need their own file, or detaching in one detaches in
	// the other.
	//
	// Required, with no unscoped branch to fall into. It used to be
	// optional, on the reasoning that a caller with no session cannot be
	// racing one, and the caller that had no session id to give was the
	// one that raced: it passed undefined every time and every session
	// shared this root. A caller with nothing better to say can pass
	// anything stable and unique to itself, which is a decision it can
	// make and this cannot.
	const mine = join(root, safeName(sessionId));
	return {
		async attach(change) {
			await mkdir(mine, { recursive: true });
			const highest = (await this.list()).reduce(
				(max, a) => Math.max(max, a.seq),
				0,
			);
			const record: Attachment = {
				change,
				attachedAt: new Date().toISOString(),
				seq: highest + 1,
			};
			await writeFile(
				join(mine, fileFor(change)),
				JSON.stringify(record, null, 2),
				"utf8",
			);
		},

		async detach(label) {
			const found = (await this.list()).find((a) => a.change.label === label);
			if (!found) return false;
			await rm(join(mine, fileFor(found.change)), { force: true });
			return true;
		},

		async list() {
			let names: string[];
			try {
				names = await readdir(mine);
			} catch {
				// Nothing has been attached yet, so there is no
				// directory. That is not a failure to report.
				return [];
			}
			const read = await Promise.all(
				names
					.filter((name) => name.endsWith(".json"))
					.map((name) => readAttachment(join(mine, name))),
			);
			return read
				.filter((a): a is Attachment => a !== undefined)
				.sort((a, b) => b.seq - a.seq);
		},
	};
}

/** The change a call settled on, and why, when it is worth saying. */
export interface ChangeInPlay {
	readonly label: string;
	/** Said out loud when the caller did not name this themselves. */
	readonly note?: string;
}

/** No single answer, so the caller has to choose. */
export interface ChangeAmbiguous {
	readonly candidates: readonly string[];
}

/**
 * Which attached change a call should act on.
 *
 * An explicit name is never second-guessed: somebody who names a
 * change means that change, and a typo is better reported than
 * quietly redirected to whatever else happens to be attached.
 *
 * With nothing named, one attached change is used and said out
 * loud, so the reader knows what was read or written. Several
 * stay a refusal rather than a guess, because acting on the
 * wrong change is worse than being asked which one, and the
 * hint only breaks that tie when it points at something actually
 * attached.
 */
export function changeInPlay(
	asked: string | undefined,
	hint: string | undefined,
	attached: readonly string[],
): ChangeInPlay | ChangeAmbiguous {
	if (asked !== undefined) return { label: asked };
	if (hint !== undefined && attached.includes(hint)) return { label: hint };

	const [newest, ...rest] = attached;
	if (newest === undefined) return { candidates: attached };
	if (rest.length === 0) {
		return {
			label: newest,
			note: `Using ${newest}, the only change attached.`,
		};
	}

	// Recency settles it, because attaching a change is how you say what you
	// are working on now. This used to refuse whenever two were attached, on
	// the grounds that choosing could report on the wrong change, and the
	// result was worse than the risk: a second attachment paralysed every
	// tool, and the way out was to detach something. Meanwhile `attach`
	// promised that later calls could leave the change out, and the listing
	// promised newest first, and the store had kept a monotonic sequence all
	// along for exactly this. Three claims that only a rule like this makes
	// true.
	//
	// Said out loud every time, and it names the others, because the whole
	// objection to choosing was silence rather than choice: a person who
	// meant the other one has to be told which was taken and that the rest
	// are still there.
	return {
		label: newest,
		note: `Using ${newest}, attached most recently. Also attached: ${rest.join(", ")}. Name a change to act on one of those instead.`,
	};
}

/** Say what to choose between, when the choice cannot be made here. */
export function chooseChange(candidates: readonly string[]): string {
	if (candidates.length === 0) {
		return (
			"No change is attached. Run review attach with a change, or a " +
			"base and head, and everything after it will act on that."
		);
	}
	return (
		`Several changes are attached: ${candidates.join(", ")}. Name the ` +
		"one to act on, since choosing for you could report on the wrong " +
		"change."
	);
}
