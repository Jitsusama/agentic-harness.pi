/**
 * The machine's sessions as its mycelium node's watch says them, a
 * presence file a session, for a folder mirror to take rather than read
 * the presence folder itself.
 *
 * Every conversation is a process of its own, and each read the presence
 * folder: on 21 November, reading only what a watch named, seventy
 * children still made 10,987 opens of its 164 files a minute, and held
 * Joel's windows in btrfs's directory locks. The node already follows
 * that folder once for the machine (PROTOCOL.md, The Store) and says
 * every session on a watch, then each one changed or forgotten, each
 * carrying its presence whole. So a change is read once however many
 * processes follow it, and reaches them over a socket, not the disk.
 *
 * The watch is mycelium's: `Node::watch` and the `Event` it sends in its
 * `src/node/mod.rs`, each session a `Session` of its `src/record.rs`,
 * whose `presence` is the body its store read from the folder's file
 * (`src/store/folders.rs`), so another machine's comes with `machine` set
 * and `owner` taken out, and an ended one stays until its file goes, just
 * as reading the folder found them.
 */

import { createConnection, type Socket } from "node:net";
import type { Feed, FeedEvents } from "../internal/files/folder-mirror.ts";
import { isRecord } from "../internal/record.ts";

/**
 * The longest line a watch's reader takes: every session's presence at
 * once, which at 164 sessions is under a mebibyte. One longer ends the
 * feed rather than growing.
 */
const LONGEST_LINE = 16 * 1024 * 1024;

/** A watch hearing only sessions: no groups, so no messages. */
const WATCH_SESSIONS = `${JSON.stringify({ Watch: { recent: 0 } })}\n`;

/** How a presence feed names and reads what the node says. */
export interface SessionFiles<T> {
	/** The presence file's name for a session, by its id. */
	nameOf(id: string): string;
	/** A presence as the node carries it whole, read; none when it isn't one. */
	parse(presence: unknown): T | undefined;
}

/**
 * Follow the sessions the node at `socket` holds, telling `events` each
 * session's presence as its file, then each change. A node that isn't
 * there, refuses, goes or lets go of a watch that fell behind ends the
 * feed, so its mirror reads the folder and asks again later.
 */
export function watchSessions<T>(
	socket: string,
	files: SessionFiles<T>,
	events: FeedEvents<T>,
): Feed {
	let ended = false;
	const end = (): void => {
		if (ended) return;
		ended = true;
		connection.destroy();
		events.ended();
	};
	const hearing = sessionsHeard(files, events, end);
	const connection: Socket = createConnection(socket);
	// A feed never keeps its process alive, as a mirror's poll doesn't.
	connection.unref();
	connection.setEncoding("utf8");
	connection.on("connect", () => connection.write(WATCH_SESSIONS));
	const lines = linesOf((line) => {
		if (!ended) hearing(line);
	}, end);
	connection.on("data", lines);
	// No socket, or a node that went: lost, so the mirror reads the folder.
	connection.on("error", end);
	connection.on("close", end);
	return {
		close() {
			ended = true;
			connection.destroy();
		},
	};
}

/**
 * What takes a socket's text a chunk at a time and hears each whole line,
 * calling `overlong` once one passes LONGEST_LINE. A chunk is searched
 * only for its own newline, and a line's pieces joined once, so the whole
 * state, which arrives in many chunks, costs its length and no more.
 */
export function linesOf(
	hear: (line: string) => void,
	overlong: () => void,
): (chunk: string) => void {
	let pieces: string[] = [];
	let length = 0;
	// Past a line too long, until its newline: its tail is no line.
	let skipping = false;
	return (chunk) => {
		let from = 0;
		let newline = chunk.indexOf("\n");
		while (newline >= 0) {
			pieces.push(chunk.slice(from, newline));
			const line = pieces.join("");
			pieces = [];
			length = 0;
			if (skipping) skipping = false;
			else hear(line);
			from = newline + 1;
			newline = chunk.indexOf("\n", from);
		}
		if (from < chunk.length) {
			pieces.push(chunk.slice(from));
			length += chunk.length - from;
		}
		if (skipping) {
			pieces = [];
			length = 0;
		} else if (length > LONGEST_LINE) {
			pieces = [];
			length = 0;
			skipping = true;
			overlong();
		}
	};
}

/**
 * What hears each line a watch says, telling `events`: its answer, the
 * whole state, then each session changed or forgotten. Messages, which a
 * watch naming no groups never says, and any event a newer node adds are
 * passed over; a line it can't read ends the feed.
 */
export function sessionsHeard<T>(
	files: SessionFiles<T>,
	events: FeedEvents<T>,
	end: () => void,
): (line: string) => void {
	let watching = false;
	let ready = false;
	// The files said so far, so a whole state said again lets go of those
	// it no longer holds.
	const held = new Set<string>();
	const put = (session: unknown): boolean => {
		if (!isRecord(session) || typeof session.id !== "string") return false;
		const name = files.nameOf(session.id);
		held.add(name);
		events.put(name, files.parse(session.presence));
		return true;
	};
	return (line) => {
		let said: unknown;
		try {
			said = JSON.parse(line);
		} catch {
			end();
			return;
		}
		if (!watching) {
			// Anything but its yes, such as a node that doesn't know the ask.
			if (isRecord(said) && said.Ok === "Watching") watching = true;
			else end();
			return;
		}
		if (!isRecord(said)) {
			end();
			return;
		}
		const whole = said.SessionsChanged;
		const changed = said.SessionChanged;
		const forgotten = said.SessionForgotten;
		if (whole !== undefined) {
			if (!isRecord(whole) || !Array.isArray(whole.sessions)) {
				end();
				return;
			}
			const before = new Set(held);
			held.clear();
			if (!whole.sessions.every(put)) {
				end();
				return;
			}
			for (const name of before) if (!held.has(name)) events.gone(name);
			if (!ready) {
				ready = true;
				events.ready();
			}
		} else if (changed !== undefined) {
			if (!isRecord(changed) || !put(changed.session)) end();
		} else if (forgotten !== undefined) {
			if (!isRecord(forgotten) || typeof forgotten.id !== "string") {
				end();
				return;
			}
			const name = files.nameOf(forgotten.id);
			held.delete(name);
			events.gone(name);
		}
		// Anything else is an event this reader doesn't follow: messages,
		// or one a newer node says, which leaves the sessions as they stand.
	};
}
