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
 */

import { randomBytes } from "node:crypto";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	watch,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type Draft, ENVELOPE, type Message, messageFrom } from "./message.ts";

/** What the mesh needs of wherever messages travel. */
export interface Transport {
	/** Stamp a draft and send it; answers the message as sent. */
	send(draft: Draft): Message;
	/** Every message id, oldest first. */
	ids(): string[];
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
	lastStamp = Math.max(Date.now(), lastStamp + 1);
	return `${lastStamp}-${draft.from}-${draft.pid}-${randomBytes(4).toString("hex")}`;
}

/** The address a stamped id was sent from, or nothing for another id. */
export function senderOf(id: string): string | undefined {
	const [stamp, from] = id.split("-");
	return stamp && /^\d+$/.test(stamp) && from ? from : undefined;
}

/** The time the last id this process stamped carries. */
let lastStamp = 0;

/**
 * The time an id was stamped at, from the number it begins with, or
 * nothing for one that does not, which no expiry then touches.
 */
export function stampedAt(id: string): number | undefined {
	const at = Number(id.split("-")[0]);
	return Number.isFinite(at) && at > 0 ? at : undefined;
}

/** Whether a file in a transport folder holds a message. */
function isMessageFile(file: string): boolean {
	return file.endsWith(".json") && !file.startsWith(".");
}

/** The id a message file holds. */
function idOf(file: string): string {
	return file.slice(0, -".json".length);
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
			try {
				return readdirSync(dir).filter(isMessageFile).map(idOf).sort();
			} catch {
				return [];
			}
		},
		read(id) {
			try {
				return messageFrom(
					JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")),
				);
			} catch {
				return undefined;
			}
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
				if (file && isMessageFile(file)) arrived(idOf(file));
			});
			return () => watcher.close();
		},
		expire: (before) => expireFolder(dir, before),
	};
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
 * Take away files staged for an atomic write (ending `.tmp`) and last
 * touched before this time: a writer that died between writing and
 * renaming leaves one, and nothing else ever would.
 */
export function removeStaged(dir: string, before: number): void {
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

/** Write a file whole, through a dot-file renamed into place. */
export function writeAtomically(dir: string, file: string, text: string): void {
	mkdirSync(dir, { recursive: true });
	const staged = join(dir, `.${file}.${process.pid}.tmp`);
	writeFileSync(staged, text);
	renameSync(staged, join(dir, file));
}

function readMarker(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}
