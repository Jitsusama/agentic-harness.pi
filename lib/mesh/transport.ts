/**
 * Transport: where messages travel and rest.
 *
 * The mesh asks a transport for very little, so another one (a socket,
 * a network) can take the folder's place without the rest changing. The
 * folder transport keeps one JSON file per message, written to a
 * dot-file and renamed into place, so a reader never sees half a
 * message and a watcher is told about each message once it is whole.
 * Ids begin with the time they were stamped, so sorted ids are the order
 * messages were sent in, and a peer remembers how far it has read by the
 * last id it was handed.
 *
 * Every peer looks through the folder once a minute for anything its
 * watch missed, and a week of messages ran to 48,299 files on 11
 * November 2026, growing by nine thousand a day. So messages past their
 * first hours move into a folder for their day (`2026-11-11/`), which
 * the minute's look passes by and reads of an id still reach. Holds stay
 * where every peer lists them until they expire, since a peer on older
 * code looks only at the top.
 */

import { randomBytes } from "node:crypto";
import {
	type Dir,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	watch,
} from "node:fs";
import { opendir } from "node:fs/promises";
import { join } from "node:path";
import { processGlobal } from "../internal/process-global.ts";
import { clearWriting, writeWhole } from "../internal/write-whole.ts";
import { type Draft, ENVELOPE, type Message, messageFrom } from "./message.ts";

/** What the mesh needs of wherever messages travel. */
export interface Transport {
	/** Stamp a draft and send it; answers the message as sent. */
	send(draft: Draft): Message;
	/** Every message id kept, oldest first, however long ago it was sent. */
	ids(): string[];
	/**
	 * The ids of messages not yet moved to their day's folder, oldest
	 * first: the last hours' messages, and holds. Far fewer than
	 * {@link ids}, for a reader after what came lately.
	 */
	recentIds(): string[];
	/**
	 * The recent ids, as {@link recentIds} answers, read a little at a
	 * time, for a reader that looks again on a clock and can wait.
	 */
	listIds(): Promise<string[]>;
	/** One message, or nothing when it will not read. */
	read(id: string): Message | undefined;
	/** The last id handed to a peer under any of these addresses. */
	lastRead(addresses: readonly string[]): string | undefined;
	/** Note that a peer under this address has been handed this id. */
	markRead(address: string, id: string): void;
	/**
	 * Call back with each message id as it arrives, until the answer is
	 * called. Throws when arrivals cannot be watched at all.
	 */
	watch(arrived: (id: string) => void): () => void;
	/**
	 * Move messages stamped before this time into their day's folder,
	 * out of what every peer looks through each minute. Holds stay.
	 */
	settle(before: number): void;
	/**
	 * Let go of what was stamped before this time: messages, and the read
	 * markers of peers that have read nothing since.
	 */
	expire(before: number): void;
}

/** A fresh id, sorting after every one stamped before it. */
export function stampId(draft: Pick<Draft, "from" | "pid">): string {
	// One process's ids always rise, even within a millisecond, since a
	// later id is how a reply or a replacement is known to come after
	// what it names. A random tail keeps two processes' ids apart.
	stamps.last = Math.max(Date.now(), stamps.last + 1);
	return `${stamps.last}-${draft.from}-${draft.pid}-${randomBytes(4).toString("hex")}`;
}

/** The address a stamped id was sent from, or nothing for another id. */
export function senderOf(id: string): string | undefined {
	const [stamp, from] = id.split("-");
	return stamp && /^\d+$/.test(stamp) && from ? from : undefined;
}

/**
 * The time the last id this process stamped carries, kept once for the
 * process: a host loads a fresh copy of this module for each of its
 * conversations, and a count per copy would let one copy's burst within
 * a millisecond leave the next copy's id sorting before it, so a reader
 * who had read that far would pass the later message by.
 */
const stamps = processGlobal("agentic-harness.mesh.stamps.v1", () => ({
	last: 0,
}));

/**
 * The time an id was stamped at, from the number it begins with, or
 * nothing for one that does not, which no expiry then touches.
 */
export function stampedAt(id: string): number | undefined {
	const at = Number(id.split("-")[0]);
	return Number.isFinite(at) && at > 0 ? at : undefined;
}

/**
 * How many names a listing reads at a time. A week of messages is tens
 * of thousands of files (46,838 on 10 November 2026), and reading them
 * in one go held pi's main thread 70 to 95 ms on a loaded machine, with
 * every key typed meanwhile waiting; in batches of this size no one
 * step took more than 3 ms.
 *
 * Each batch is read synchronously from the open folder, then the
 * thread is given back. Iterating the folder with `for await` instead
 * made a promise and more for every entry: on 11 November an idle pi
 * allocated 260 MB in 90 s that way, one listing a minute, and the
 * collections that followed paged swapped heap back in.
 */
const LISTING_BATCH = 256;

/** Gives the thread back, so what waits on it runs before the next batch. */
const yieldThread = (): Promise<void> =>
	new Promise((resolve) => setImmediate(resolve));

/** Whether a file in a transport folder holds a message. */
function isMessageFile(file: string): boolean {
	return file.endsWith(".json") && !file.startsWith(".");
}

/** The id a message file holds. */
function idOf(file: string): string {
	return file.slice(0, -".json".length);
}

/** Whether a name in a transport folder is a day's folder of messages. */
function isDay(name: string): boolean {
	return /^\d{4}-\d{2}-\d{2}$/.test(name);
}

/** The folder of the day an id was stamped on, in UTC. */
function dayOf(id: string): string | undefined {
	const at = stampedAt(id);
	return at === undefined ? undefined : new Date(at).toISOString().slice(0, 10);
}

/** The message ids in one folder, unsorted, or none when it won't list. */
function idsIn(dir: string): string[] {
	try {
		return readdirSync(dir).filter(isMessageFile).map(idOf);
	} catch {
		return [];
	}
}

/** The day folders a transport folder holds. */
function daysIn(dir: string): string[] {
	try {
		return readdirSync(dir).filter(isDay);
	} catch {
		return [];
	}
}

/** A message read from a file, or nothing when it will not read. */
function readMessage(path: string): Message | undefined {
	try {
		return messageFrom(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return undefined;
	}
}

/** Messages as files in this folder, made on first send. */
export function folderTransport(dir: string): Transport {
	const marker = (address: string) => join(dir, `.read-${address}`);
	const lastRead = (addresses: readonly string[]) =>
		addresses
			.map((address) => readMarker(marker(address)))
			.filter((id): id is string => id !== undefined)
			.sort()
			.pop();
	return {
		send(draft) {
			const message: Message = {
				v: ENVELOPE,
				id: stampId(draft),
				at: new Date().toISOString(),
				...draft,
			};
			writeAtomically(dir, `${message.id}.json`, JSON.stringify(message));
			return message;
		},
		ids() {
			return [
				...idsIn(dir),
				...daysIn(dir).flatMap((day) => idsIn(join(dir, day))),
			].sort();
		},
		recentIds: () => idsIn(dir).sort(),
		async listIds() {
			const found: string[] = [];
			let folder: Dir;
			try {
				folder = await opendir(dir, { bufferSize: LISTING_BATCH });
			} catch {
				// A folder not made yet holds no messages, as ids() answers.
				return [];
			}
			try {
				for (;;) {
					for (let read = 0; read < LISTING_BATCH; read++) {
						const entry = folder.readSync();
						if (entry === null) return found.sort();
						if (isMessageFile(entry.name)) found.push(idOf(entry.name));
					}
					await yieldThread();
				}
			} catch {
				// A folder taken away while listed answers what was read of it.
				return found.sort();
			} finally {
				await folder.close().catch(() => {
					// Closed already, or gone: nothing is left open either way.
				});
			}
		},
		read(id) {
			const day = dayOf(id);
			return (
				readMessage(join(dir, `${id}.json`)) ??
				(day === undefined
					? undefined
					: readMessage(join(dir, day, `${id}.json`)))
			);
		},
		lastRead,
		markRead(address, id) {
			// Only ever forward, so a late watcher event for an older message
			// cannot wind the marker back and hand messages out twice.
			const before = lastRead([address]);
			if (before !== undefined && before >= id) return;
			writeAtomically(dir, `.read-${address}`, id);
		},
		watch(arrived) {
			mkdirSync(dir, { recursive: true });
			const watcher = watch(dir, (_kind, file) => {
				// A message moved to its day's folder leaves this one, and is no
				// arrival.
				if (file && isMessageFile(file) && existsSync(join(dir, file))) {
					arrived(idOf(file));
				}
			});
			return () => watcher.close();
		},
		settle: (before) => settleFolder(dir, before),
		expire: (before) => {
			for (const day of daysIn(dir)) expireDay(join(dir, day), before);
			expireFolder(dir, before);
		},
	};
}

/**
 * Move each message stamped before this time, other than a hold, into
 * its day's folder. Two peers settling at once each move what the
 * other hasn't, since a file already moved won't rename again.
 */
function settleFolder(dir: string, before: number): void {
	for (const id of idsIn(dir)) {
		const at = stampedAt(id);
		const day = dayOf(id);
		if (at === undefined || day === undefined || at >= before) continue;
		const from = join(dir, `${id}.json`);
		if (readMessage(from)?.intent === "hold") continue;
		try {
			mkdirSync(join(dir, day), { recursive: true });
			renameSync(from, join(dir, day, `${id}.json`));
		} catch {
			// Moved already by another peer, or taken away: either way gone.
		}
	}
}

/** Take out of a day's folder what was stamped before this time, and the folder once empty. */
function expireDay(day: string, before: number): void {
	for (const id of idsIn(day)) {
		const at = stampedAt(id);
		if (at !== undefined && at < before) removeQuietly(join(day, `${id}.json`));
	}
	try {
		rmdirSync(day);
	} catch {
		// Still holding messages, or gone already.
	}
}

/**
 * Take out of a folder of messages what was stamped before this time:
 * message files, read markers whose last id is older, and files a
 * writer staged and never renamed into place. A file that names no
 * time is left alone.
 */
function expireFolder(dir: string, before: number): void {
	let files: string[] = [];
	try {
		files = readdirSync(dir);
	} catch {
		return;
	}
	for (const file of files) {
		const path = join(dir, file);
		const stamp = isMessageFile(file)
			? stampedAt(idOf(file))
			: file.startsWith(".read-")
				? stampedAt(readMarker(path) ?? "")
				: undefined;
		if (stamp !== undefined && stamp < before) removeQuietly(path);
	}
	removeStaged(dir, before);
}

/**
 * Take away files staged for an atomic write and last touched before
 * this time: a writer that died between writing and renaming leaves
 * one, and nothing else ever would. They are staged in the folder's
 * `.writing`; older code staged them beside it, ending `.tmp`.
 */
export function removeStaged(dir: string, before: number): void {
	clearWriting(dir, before);
	let files: string[] = [];
	try {
		files = readdirSync(dir).filter((file) => file.endsWith(".tmp"));
	} catch {
		return;
	}
	for (const file of files) {
		const path = join(dir, file);
		if (touchedAt(path) < before) removeQuietly(path);
	}
}

/** When a file last changed, or never (infinitely late) when unreadable. */
export function touchedAt(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

/** Remove a file, saying nothing if another peer already has. */
export function removeQuietly(path: string): void {
	try {
		rmSync(path, { force: true });
	} catch {
		// Left for the next sweep.
	}
}

/** Write a file whole, through the folder's `.writing`, renamed into place. */
export function writeAtomically(dir: string, file: string, text: string): void {
	mkdirSync(dir, { recursive: true });
	writeWhole(join(dir, file), text);
}

function readMarker(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}
