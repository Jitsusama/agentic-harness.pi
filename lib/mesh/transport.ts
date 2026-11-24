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
 * the minute's look passes by and reads of an id still reach. A hold
 * stays where every reader lists it, with every answer to it, until its
 * end is as old, since a peer on older code and readers outside the
 * harness, such as merge-net, look only at the top.
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
import { opendir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { processGlobal } from "../internal/process/process-global.ts";
import { clearWriting, writeWhole } from "../internal/write-whole.ts";
import { type Draft, ENVELOPE, type Message, messageFrom } from "./message.ts";
import { sentBy } from "./thread.ts";

/** What the mesh needs of wherever messages travel. */
export interface Transport {
	/** Stamp a draft and send it; answers the message as sent. */
	send(draft: Draft): Message;
	/** Every message id kept, oldest first, however long ago it was sent. */
	ids(): string[];
	/**
	 * The ids kept from the day this id was stamped on, oldest first: what
	 * {@link ids} answers, less the days before it, which hold nothing
	 * sent after it. For a reader catching up from what it last read.
	 */
	idsFromDayOf(id: string): string[];
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
	/**
	 * Every id, as {@link ids} answers, read a little at a time, for a
	 * reader on a host's thread, which every conversation it holds waits on.
	 */
	listAllIds(): Promise<string[]>;
	/** One message, or nothing when it will not read. */
	read(id: string): Message | undefined;
	/** One message, as {@link read} answers, read off the thread. */
	readOff(id: string): Promise<Message | undefined>;
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
	 * out of what every peer looks through each minute. A hold not yet
	 * ended stays, and so does every answer to it; an ended one moves
	 * with its end.
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

/**
 * The folder of the day an id was stamped on, in UTC, or nothing for an
 * id with no time. Ids from a day before another's sort before its day.
 */
export function dayOf(id: string): string | undefined {
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

/**
 * The ids at the top and in the day folders from `first` on, once each,
 * oldest first; from "" that is every day's.
 */
function idsFrom(dir: string, first: string): string[] {
	// Once each: a link to another machine can write a moved message back
	// at the top, and it stays there beside its day's copy until the next
	// settle.
	return [
		...new Set([
			...idsIn(dir),
			...daysIn(dir)
				.filter((day) => day >= first)
				.flatMap((day) => idsIn(join(dir, day))),
		]),
	].sort();
}

/** What one folder holds, as listed off the thread. */
interface Listed {
	/** Its message ids, unsorted. */
	readonly ids: string[];
	/** Its day folders, unsorted. */
	readonly days: string[];
}

/**
 * The message ids and day folders in one folder, read a little at a
 * time; none when it won't list, and what was read of it when it goes
 * while listed.
 */
async function listedIn(dir: string): Promise<Listed> {
	const listed: Listed = { ids: [], days: [] };
	let folder: Dir;
	try {
		folder = await opendir(dir, { bufferSize: LISTING_BATCH });
	} catch {
		// A folder not made yet holds no messages, as ids() answers.
		return listed;
	}
	try {
		for (;;) {
			for (let read = 0; read < LISTING_BATCH; read++) {
				// Off the thread: a batch read at once waits on the disk with
				// every conversation the host holds.
				const entry = await folder.read();
				if (entry === null) return listed;
				if (isMessageFile(entry.name)) listed.ids.push(idOf(entry.name));
				else if (isDay(entry.name)) listed.days.push(entry.name);
			}
			await yieldThread();
		}
	} catch {
		// A folder taken away while listed answers what was read of it.
		return listed;
	} finally {
		await folder.close().catch(() => {
			// Closed already, or gone: nothing is left open either way.
		});
	}
}

/** Every day's ids and the top's, once each, oldest first, off the thread. */
async function allListedIn(dir: string): Promise<string[]> {
	const top = await listedIn(dir);
	const found = new Set(top.ids);
	// One day at a time, so a week of folders never opens all at once.
	for (const day of top.days) {
		for (const id of (await listedIn(join(dir, day))).ids) found.add(id);
	}
	return [...found].sort();
}

/** How many messages a reader of many reads at once off the thread. */
const READING_AT_ONCE = 32;

/**
 * The messages these ids name, in their order, read off the thread a
 * few at a time. A week's are thousands of files: opened all at once
 * they would fill the thread pool every conversation in a host shares,
 * and past the open-file limit each would read as no message.
 */
export async function readEachOff(
	transport: Pick<Transport, "readOff">,
	ids: readonly string[],
): Promise<(Message | undefined)[]> {
	const read: (Message | undefined)[] = [];
	for (let from = 0; from < ids.length; from += READING_AT_ONCE) {
		const batch = ids.slice(from, from + READING_AT_ONCE);
		read.push(...(await Promise.all(batch.map((id) => transport.readOff(id)))));
	}
	return read;
}

/** A message read from a file, or nothing when it will not read. */
function readMessage(path: string): Message | undefined {
	try {
		return messageFrom(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return undefined;
	}
}

/** A message read from a file off the thread, as {@link readMessage}. */
async function readMessageOff(path: string): Promise<Message | undefined> {
	try {
		return messageFrom(JSON.parse(await readFile(path, "utf8")));
	} catch {
		// Gone, torn or not a message: as readMessage, nothing to read.
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
			const id = stampId(draft);
			// The time its id carries, to the millisecond, as a mycelium node
			// holds a message sent through it to (mycelium#421).
			const message: Message = {
				v: ENVELOPE,
				id,
				at: new Date(stampedAt(id) ?? Date.now()).toISOString(),
				...draft,
			};
			writeAtomically(dir, `${message.id}.json`, JSON.stringify(message));
			return message;
		},
		ids: () => idsFrom(dir, ""),
		// A message settles into the day it was stamped on, so one sent
		// after this id rests at the top or in that day's folder or a
		// later one. An id with no time to read lists every day.
		idsFromDayOf: (id) => idsFrom(dir, dayOf(id) ?? ""),
		recentIds: () => idsIn(dir).sort(),
		listIds: async () => (await listedIn(dir)).ids.sort(),
		listAllIds: () => allListedIn(dir),
		read(id) {
			const day = dayOf(id);
			return (
				readMessage(join(dir, `${id}.json`)) ??
				(day === undefined
					? undefined
					: readMessage(join(dir, day, `${id}.json`)))
			);
		},
		async readOff(id) {
			const day = dayOf(id);
			return (
				(await readMessageOff(join(dir, `${id}.json`))) ??
				(day === undefined
					? undefined
					: await readMessageOff(join(dir, day, `${id}.json`)))
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
 * Move each message stamped before this time into its day's folder,
 * keeping a hold and its thread together where a reader outside the
 * harness finds them. A hold stays at the top until its end is past
 * this time too, and then moves with it; an answer to a hold that stays,
 * stays beside it. Two peers settling at once each move what the other
 * hasn't, since a file already moved won't rename again.
 *
 * On 11 November merge-net, which reads holds from the top alone, saw
 * 16V6F4's ended Monday hold as standing for half an hour and started
 * no runs, because the hold had stayed and its end had moved. So a hold
 * whose end an older settle moved away is found ended among its
 * holder's files in the day folders, and moves to join it.
 */
function settleFolder(dir: string, before: number): void {
	const old = new Map<string, Message>();
	for (const id of idsIn(dir).sort()) {
		const at = stampedAt(id);
		if (at === undefined || at >= before) continue;
		const message = readMessage(join(dir, `${id}.json`));
		if (message !== undefined) old.set(id, message);
	}
	const holds = [...old.values()].filter((one) => one.intent === "hold");
	const ended = new Set(
		[...old.values()].flatMap((one) =>
			holds.filter((hold) => ends(one, hold)).map((hold) => hold.id),
		),
	);
	const days = dayListings(dir);
	const now = Date.now();
	for (const hold of holds) {
		// A hold that said when it ends is over then, with no word after it.
		const endedAsSaid = hold.ends !== undefined && Date.parse(hold.ends) <= now;
		if (endedAsSaid || (!ended.has(hold.id) && endedAway(hold, days))) {
			ended.add(hold.id);
		}
	}
	const standing = new Set(
		holds.filter((hold) => !ended.has(hold.id)).map((hold) => hold.id),
	);
	for (const [id, message] of old) {
		if (standing.has(id) || answersOneOf(message, standing)) continue;
		moveToDay(dir, id);
	}
}

/** Whether a message ends this hold: its holder answering or replacing it, or anyone on the person's word. */
function ends(message: Message, hold: Message): boolean {
	if (message.re !== hold.id && message.supersedes !== hold.id) return false;
	return (
		message.endsHold === true ||
		sentBy(hold, {
			addresses: [message.from],
			pid: message.pid,
			...(message.hosted ? { hosted: true } : {}),
		})
	);
}

/** Whether a message answers or replaces one of these. */
function answersOneOf(message: Message, ids: ReadonlySet<string>): boolean {
	return (
		(message.re !== undefined && ids.has(message.re)) ||
		(message.supersedes !== undefined && ids.has(message.supersedes))
	);
}

/**
 * Whether the holder's end of this hold already sits in a day folder.
 * Only the holder's own files from the hold's day on are read, picked
 * out by the sender each name carries, so a week of messages is listed
 * but hardly read. An end on the person's word from another peer is
 * not looked for: the hold then moves once that end is at the top.
 */
function endedAway(hold: Message, days: DayListings): boolean {
	const since = dayOf(hold.id);
	if (since === undefined) return false;
	return days(since).some(({ day, ids }) =>
		ids.some((id) => {
			if (id <= hold.id || senderOf(id) !== hold.from) return false;
			const message = readMessage(join(day, `${id}.json`));
			return message !== undefined && ends(message, hold);
		}),
	);
}

/** Each day folder from a day on, with the ids it holds. */
type DayListings = (first: string) => { day: string; ids: string[] }[];

/** The day folders' ids, each folder listed once however many holds ask. */
function dayListings(dir: string): DayListings {
	const listed = new Map<string, string[]>();
	return (first) =>
		daysIn(dir)
			.filter((name) => name >= first)
			.sort()
			.map((name) => {
				const day = join(dir, name);
				let ids = listed.get(name);
				if (ids === undefined) {
					ids = idsIn(day);
					listed.set(name, ids);
				}
				return { day, ids };
			});
}

/** Move one message into its day's folder. */
function moveToDay(dir: string, id: string): void {
	const day = dayOf(id);
	if (day === undefined) return;
	try {
		mkdirSync(join(dir, day), { recursive: true });
		renameSync(join(dir, `${id}.json`), join(dir, day, `${id}.json`));
	} catch {
		// Moved already by another peer, or taken away: either way gone.
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
