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

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
 * File name for an attachment.
 *
 * Keyed by the provider-scoped change key rather than the label,
 * because a label is for people: two systems can spell the same
 * repo differently, and a label carrying a slash or a pair of
 * dots would otherwise name a path outside the store. The key is
 * hashed to a flat name for the same reason.
 */
function fileFor(change: ChangeRef): string {
	const safe = changeKey(change)
		.replace(/[^A-Za-z0-9._-]/g, "_")
		.replace(/^\.+/, "_");
	return `${safe}.json`;
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
export function createAttachmentStore(root: string): AttachmentStore {
	return {
		async attach(change) {
			await mkdir(root, { recursive: true });
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
				join(root, fileFor(change)),
				JSON.stringify(record, null, 2),
				"utf8",
			);
		},

		async detach(label) {
			const found = (await this.list()).find((a) => a.change.label === label);
			if (!found) return false;
			await rm(join(root, fileFor(found.change)), { force: true });
			return true;
		},

		async list() {
			let names: string[];
			try {
				names = await readdir(root);
			} catch {
				// Nothing has been attached yet, so there is no
				// directory. That is not a failure to report.
				return [];
			}
			const read = await Promise.all(
				names
					.filter((name) => name.endsWith(".json"))
					.map((name) => readAttachment(join(root, name))),
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
