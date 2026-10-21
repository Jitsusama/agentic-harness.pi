/**
 * Mail between the pi sessions on one machine, as files in a folder.
 *
 * One JSON file per message, written to a dot-file and renamed into
 * place, so a reader never sees half a message and a watcher is told
 * about each message once it is whole. Files are named by the time they
 * were sent, so a sorted listing is the order they were sent in, and a
 * session remembers how far it has read by the last name it was handed.
 *
 * The format is the one the interim mailbox wrote, kept so the two read
 * each other's mail while sessions move from one to the other.
 */

import { randomBytes } from "node:crypto";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { channelName, hears } from "./channels.ts";

/**
 * What a message asks of the sessions it reaches.
 *
 * - hold: stop or put off something until the sender says it is over.
 * - question: wants an answer.
 * - finding: something learned about what another session owns.
 * - fyi: context only.
 *
 * Only a hold and a question ask for a reply. A message from before
 * kinds is an fyi.
 */
export const MAIL_KINDS = ["hold", "question", "finding", "fyi"] as const;

export type MailKind = (typeof MAIL_KINDS)[number];

/** One message, as it sits on disk. */
export interface Mail {
	/** When it was sent, as an ISO time. */
	readonly at: string;
	/** The name the sender went by. */
	readonly from: string;
	/**
	 * Who it is for: session names upper-cased, channels as `#name`, or
	 * ALL for the global channel.
	 */
	readonly to: readonly string[];
	readonly text: string;
	/** What it asks of whoever it reaches; an fyi when missing. */
	readonly kind?: MailKind;
	/** The sending process, so a session never hands itself its own mail. */
	readonly pid: number;
}

/** What a mailbox folder can do. */
export interface Mailbox {
	/** The folder itself. */
	readonly dir: string;
	/** Post a message; answers the file it was written to. */
	send(mail: Mail): string;
	/** Every message file, oldest first. */
	list(): string[];
	/** One message, or nothing when it will not read. */
	read(file: string): Mail | undefined;
	/** The last file handed to a session under any of these names. */
	lastRead(names: readonly string[]): string | undefined;
	/** Note that a session under this name has been handed this file. */
	markRead(name: string, file: string): void;
}

/** Whether a name is one a message file goes by, as opposed to a marker. */
export function isMailFile(file: string): boolean {
	return file.endsWith(".json") && !file.startsWith(".");
}

/**
 * Whether a message is for a session going by these names.
 *
 * Never its own, by name or by process: a session whose name changed
 * when it loaded another quest still sent what it sent.
 */
export function isFor(
	mail: Mail,
	names: readonly string[],
	pid: number,
	channels: readonly string[] = [],
): boolean {
	return (
		mail.pid !== pid &&
		!names.includes(mail.from) &&
		mail.to.some(
			(to) =>
				to === "ALL" ||
				names.includes(to) ||
				(to.startsWith("#") && hears(channels, to.slice(1))),
		)
	);
}

/**
 * What a message asks of the sessions it reaches. One without a kind,
 * or with one this version does not know, asks nothing.
 */
export function kindOf(mail: Mail): MailKind {
	return (MAIL_KINDS as readonly unknown[]).includes(mail.kind)
		? (mail.kind as MailKind)
		: "fyi";
}

/**
 * Recipients as a person types them, comma-separated in any case:
 * session names upper-cased, `#channels` made canonical, and `all` or
 * `#global` as ALL. A `#` that names no channel is kept as written, so
 * the sender can be told it reaches nobody.
 */
export function recipients(to: string): string[] {
	const out: string[] = [];
	for (const one of to.split(",").map((part) => part.trim())) {
		if (one === "") continue;
		const bare = one.replace(/^#/, "").toLowerCase();
		if (bare === "all" || bare === "global") out.push("ALL");
		else if (one.startsWith("#")) out.push(`#${channelName(one) ?? bare}`);
		else out.push(one.toUpperCase());
	}
	return [...new Set(out)];
}

/** The time of day a message was sent, as HH:MM in local time. */
export function clock(at: string): string {
	return new Date(at).toTimeString().slice(0, 5);
}

/** A message on one line, for listings. */
export function oneLine(mail: Mail): string {
	return `${clock(mail.at)} ${kindOf(mail)} from ${mail.from} to ${mail.to.join(", ")}: ${mail.text}`;
}

/** The mailbox in this folder, made on first send. */
export function createMailbox(dir: string): Mailbox {
	const marker = (name: string) => join(dir, `.read-${name}`);
	const lastRead = (names: readonly string[]) => {
		let latest: string | undefined;
		for (const name of names) {
			try {
				const file = readFileSync(marker(name), "utf8").trim();
				if (file && (latest === undefined || file > latest)) latest = file;
			} catch {
				// Never handed anything under this name.
			}
		}
		return latest;
	};
	return {
		dir,
		send(mail) {
			mkdirSync(dir, { recursive: true });
			// The time first so a listing sorts in sending order, and a
			// random tail so two sent in one millisecond do not share a name,
			// where the second would replace the first.
			const file = `${Date.now()}-${mail.from}-${mail.pid}-${randomBytes(4).toString("hex")}.json`;
			const staged = join(dir, `.${file}`);
			writeFileSync(staged, JSON.stringify(mail));
			renameSync(staged, join(dir, file));
			return file;
		},
		list() {
			try {
				return readdirSync(dir).filter(isMailFile).sort();
			} catch {
				return [];
			}
		},
		read(file) {
			try {
				const parsed: unknown = JSON.parse(
					readFileSync(join(dir, file), "utf8"),
				);
				return isMail(parsed) ? parsed : undefined;
			} catch {
				return undefined;
			}
		},
		lastRead,
		markRead(name, file) {
			// Only ever forward, so a late watcher event for an older file
			// cannot wind the marker back and hand mail out twice.
			const before = lastRead([name]);
			if (before !== undefined && before >= file) return;
			mkdirSync(dir, { recursive: true });
			writeFileSync(marker(name), file);
		},
	};
}

/** Whether something read from disk is a message this can hand over. */
function isMail(value: unknown): value is Mail {
	if (typeof value !== "object" || value === null) return false;
	const mail = value as Record<string, unknown>;
	return (
		typeof mail.at === "string" &&
		typeof mail.from === "string" &&
		Array.isArray(mail.to) &&
		mail.to.every((to) => typeof to === "string") &&
		typeof mail.text === "string" &&
		typeof mail.pid === "number"
	);
}
