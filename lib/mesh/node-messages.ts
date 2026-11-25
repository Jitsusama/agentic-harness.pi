/**
 * The mesh's messages as the machine's mycelium node's watch says them,
 * each whole, for a transport to hand out rather than read each from
 * the folder.
 *
 * Every conversation is a process of its own, and each heard a message
 * by its folder's watch and then read its file: seventy of them read
 * every message seventy times, on a disk whose directory locks held
 * Joel's windows on 21 November. The node already follows the mesh's
 * folder once for the machine (PROTOCOL.md, The Store) and says each
 * message on a watch, whole, so a message is read once however many
 * processes hear it, and reaches them over a socket, not the disk.
 *
 * A message as the node holds it is mycelium's `Message` (its
 * `src/record.rs`), read from the file by `mesh::message` (its
 * `src/mesh.rs`): the same fields as the file, but its targets as the
 * node's groups (`peer.osphtp`, `quest.wcjqsg`), which `target_for`
 * writes back as the file had them (`@OSPHTP`, `#quest/wcjqsg`). A target
 * the node can't make a group of is dropped, and a message left with
 * none never reaches a watch, as one no peer could hear.
 */

import { createConnection, type Socket } from "node:net";
import { isRecord } from "../internal/record.ts";
import { meshGroupOf } from "./flow.ts";
import { ENVELOPE, type Message, messageFrom } from "./message.ts";
import { linesOf } from "./node-watch.ts";

/**
 * How many of the latest messages a watch says first: what landed
 * between the folder's watch letting go and the node's taking over,
 * which the peer has seen and passes over once more.
 */
const RECENT = 32;

/** A watch hearing every group's messages. */
const WATCH_MESSAGES = `${JSON.stringify({ Watch: { groups: ">", recent: RECENT } })}\n`;

/** What a watch of the node's messages tells whoever follows it. */
export interface MessageEvents {
	/** The node took the watch: from here on it says every message. */
	ready(): void;
	/** One message, whole, as the mesh's file has it. */
	heard(message: Message): void;
	/** The watch ended: no node, a refusal, or a node that went. */
	ended(): void;
}

/** A watch of the node's messages, closed by whoever asked for it. */
export interface MessageWatch {
	close(): void;
}

/**
 * Follow every message the node at `socket` hears, telling `events`
 * each one. A node that isn't there, refuses, goes or lets go of a watch
 * that fell behind ends it, once; a close asked for ends nothing.
 */
export function watchMessages(
	socket: string,
	events: MessageEvents,
): MessageWatch {
	let ended = false;
	const end = (): void => {
		if (ended) return;
		ended = true;
		connection.destroy();
		events.ended();
	};
	const hearing = messagesHeard(events, end);
	const connection: Socket = createConnection(socket);
	// A watch never keeps its process alive, as a folder's watch doesn't.
	connection.unref();
	connection.setEncoding("utf8");
	connection.on("connect", () => connection.write(WATCH_MESSAGES));
	connection.on(
		"data",
		linesOf((line) => {
			if (!ended) hearing(line);
		}, end),
	);
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
 * What hears each line a watch says, telling `events`: its answer, then
 * the latest messages and each one after. Sessions, which every watch
 * says, and any event a newer node adds are passed over; a line it
 * can't read ends the watch.
 */
export function messagesHeard(
	events: MessageEvents,
	end: () => void,
): (line: string) => void {
	let watching = false;
	const hear = (said: unknown): void => {
		const message = messageOfNode(said);
		if (message !== undefined) events.heard(message);
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
			if (isRecord(said) && said.Ok === "Watching") {
				watching = true;
				events.ready();
			} else end();
			return;
		}
		if (!isRecord(said)) {
			end();
			return;
		}
		const latest = said.MessagesChanged;
		const one = said.Message;
		if (latest !== undefined) {
			if (!isRecord(latest) || !Array.isArray(latest.messages)) end();
			else for (const message of latest.messages) hear(message);
		} else if (one !== undefined) {
			if (!isRecord(one)) end();
			else hear(one.message);
		}
		// Anything else is an event this watch doesn't follow: sessions, or
		// one a newer node says.
	};
}

/**
 * A message as the node says it, as the mesh's file has it, or nothing
 * when it can't be one: no process named, or one bound for another
 * realm, which a folder's reader passes over too.
 */
export function messageOfNode(said: unknown): Message | undefined {
	if (!isRecord(said) || !Array.isArray(said.groups)) return undefined;
	const { groups, ...rest } = said;
	const to = groups
		.filter((group): group is string => typeof group === "string")
		.map(meshGroupOf);
	return messageFrom({ ...rest, v: ENVELOPE, to });
}
