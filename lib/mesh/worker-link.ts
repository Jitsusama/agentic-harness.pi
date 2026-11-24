/**
 * The worker link: the mesh, for a session on a machine that keeps no
 * mesh of its own, such as a cloud VM, through the node's worker socket.
 *
 * Such a machine's folder of messages is the session's alone, so what it
 * sends would reach nobody and nothing would reach it. Where the machine
 * names a worker socket in `MYCELIUM_WORKER_SOCKET`, the session keeps
 * two connections to the node at that socket (Jitsusama/mycelium). One
 * holds its presence, which the node counts while the connection stays
 * open, and carries each message it sends. The other watches the messages
 * the node lets it hear, its own addresses' and its quest's, and writes
 * each into the local folder, where the session reads them as it reads
 * any. A send is stamped and kept here first, since a tool answers with
 * its id at once, and the node keeps that id; when the node refuses one,
 * the session is told, naming it. A connection that drops is opened
 * again, a little later each time, and the watch takes up from the last
 * message it kept.
 *
 * The node judges everything a worker says (who it may write to, as
 * whom, which intents), so nothing here decides what reaches it.
 */

import { connect, type Socket } from "node:net";
import { isAbsolute } from "node:path";
import { type Message, messageFrom } from "./message.ts";
import type { Presence, Presences } from "./presence.ts";
import {
	folderTransport,
	type Transport,
	writeAtomically,
} from "./transport.ts";

/** The variable a worker machine names its node's worker socket in. */
export const WORKER_SOCKET_VARIABLE = "MYCELIUM_WORKER_SOCKET";

/** How long a dropped connection waits before it is first opened again. */
export const FIRST_RETRY_MS = 1000;

/** The longest a dropped connection waits, as each wait doubles. */
export const LONGEST_RETRY_MS = 30_000;

/** How many of the latest messages a first watch, with none kept, asks for. */
export const FIRST_RECENT = 50;

/**
 * The worker socket this machine names, or none: none where the variable
 * is unset, empty or not an absolute path, and the folder stands alone.
 */
export function workerSocket(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const named = env[WORKER_SOCKET_VARIABLE];
	return named && isAbsolute(named) ? named : undefined;
}

/** What the node refused, and why it said. */
export interface Refused {
	/** The presence, a message sent, or the watch. */
	readonly what: "presence" | "send" | "watch";
	/** The message refused, for a send. */
	readonly id?: string;
	readonly why: string;
}

/** What a link needs of the session it serves. */
export interface WorkerLinkOptions {
	readonly socket: string;
	/** Keep a message the watch heard where the session reads messages. */
	readonly keep: (message: Message) => void;
	/** The newest message the session holds, which a watch takes up from. */
	readonly newest: () => string | undefined;
	/** Tell the session the node refused something. */
	readonly refused: (refusal: Refused) => void;
	/** How long a dropped connection first waits; tests shorten it. */
	readonly retryMs?: number;
}

/** A session's two connections to its node's worker socket. */
export interface WorkerLink {
	/** Say this session's presence, now and on each connection after. */
	present(presence: Presence): void;
	/** Carry a message this session sent, once it is stamped and kept. */
	relay(message: Message): void;
	/** Hang up both connections, for good. */
	close(): void;
}

/** A reply the presence connection waits on, in the order asked. */
type Awaited =
	| { readonly kind: "presence" }
	| { readonly kind: "send"; readonly message: Message };

/** Opens a session's link to its node's worker socket. */
export function createWorkerLink(options: WorkerLinkOptions): WorkerLink {
	const firstRetry = options.retryMs ?? FIRST_RETRY_MS;
	let closed = false;
	let presence: Presence | undefined;
	// What waits for the presence connection: messages not yet written to
	// it, and those written whose replies haven't come.
	const unsent: Message[] = [];
	const awaited: Awaited[] = [];
	let held: Socket | undefined;
	let holding = false;
	let watching: Socket | undefined;
	let newestKept: string | undefined;
	let retry = firstRetry;
	let again: ReturnType<typeof setTimeout> | undefined;
	let watchAgain: ReturnType<typeof setTimeout> | undefined;

	const write = (socket: Socket, request: unknown) =>
		socket.write(`${JSON.stringify(request)}\n`);

	const sendOn = (socket: Socket, message: Message) => {
		awaited.push({ kind: "send", message });
		write(socket, { Send: { message } });
	};

	const presentOn = (socket: Socket, said: Presence) => {
		awaited.push({ kind: "presence" });
		write(socket, { Presence: { presence: said } });
	};

	const later = (open: () => void): ReturnType<typeof setTimeout> => {
		const wait = retry;
		retry = Math.min(retry * 2, LONGEST_RETRY_MS);
		return setTimeout(open, wait);
	};

	const replied = (line: string) => {
		const asked = awaited.shift();
		const reply = replyFrom(line);
		if (asked === undefined) return;
		if (asked.kind === "presence") {
			if (reply.ok) {
				retry = firstRetry;
				if (!holding) {
					holding = true;
					openWatch();
				}
			} else options.refused({ what: "presence", why: reply.why });
			return;
		}
		if (!reply.ok) {
			options.refused({ what: "send", id: asked.message.id, why: reply.why });
		}
	};

	const openHold = () => {
		again = undefined;
		if (closed || held !== undefined || presence === undefined) return;
		const socket = connect(options.socket);
		held = socket;
		socket.setEncoding("utf8");
		socket.on("connect", () => {
			if (presence !== undefined) presentOn(socket, presence);
			for (const message of unsent.splice(0)) sendOn(socket, message);
		});
		socket.on("data", lines(replied));
		// A drop takes the watch with it, since the node watches only for a
		// session whose presence is held; what wasn't answered goes again.
		socket.on("error", () => socket.destroy());
		socket.on("close", () => {
			if (held !== socket) return;
			held = undefined;
			holding = false;
			watching?.destroy();
			const unanswered = awaited
				.splice(0)
				.flatMap((one) => (one.kind === "send" ? [one.message] : []));
			unsent.unshift(...unanswered);
			if (!closed) again = later(openHold);
		});
	};

	const heard = (line: string) => {
		const said = eventFrom(line);
		if (said.kind === "refused") {
			options.refused({ what: "watch", why: said.why });
			return;
		}
		for (const message of said.messages) {
			options.keep(message);
			if (newestKept === undefined || message.id > newestKept) {
				newestKept = message.id;
			}
		}
	};

	const openWatch = () => {
		watchAgain = undefined;
		if (closed || !holding || watching !== undefined) return;
		if (presence === undefined) return;
		const socket = connect(options.socket);
		watching = socket;
		socket.setEncoding("utf8");
		const since = newestKept ?? options.newest();
		socket.on("connect", () =>
			write(socket, {
				Watch: {
					session: presence?.session,
					groups: null,
					...(since !== undefined ? { since } : { recent: FIRST_RECENT }),
				},
			}),
		);
		socket.on("data", lines(heard));
		socket.on("error", () => socket.destroy());
		socket.on("close", () => {
			if (watching !== socket) return;
			watching = undefined;
			// While the presence holds, the watch alone dropped: open it again.
			if (!closed && holding) watchAgain = later(openWatch);
		});
	};

	return {
		present(said) {
			presence = said;
			if (closed) return;
			if (held !== undefined && !held.connecting) presentOn(held, said);
			else if (held === undefined && again === undefined) openHold();
		},
		relay(message) {
			if (closed) return;
			if (held !== undefined && !held.connecting) sendOn(held, message);
			else {
				unsent.push(message);
				if (held === undefined && again === undefined) openHold();
			}
		},
		close() {
			closed = true;
			clearTimeout(again);
			clearTimeout(watchAgain);
			held?.destroy();
			watching?.destroy();
		},
	};
}

/**
 * The transport a worker's session sends through: the local folder's,
 * with each message it sends carried to the node once it is kept here.
 */
export function relayedTransport(
	local: Transport,
	link: Pick<WorkerLink, "relay">,
): Transport {
	return {
		...local,
		send(draft) {
			const message = local.send(draft);
			link.relay(message);
			return message;
		},
	};
}

/**
 * This session's presences, with each it publishes said to the node too,
 * so the node counts the session for as long as the link holds.
 */
export function presentedPresences(
	local: Presences,
	link: Pick<WorkerLink, "present">,
): Presences {
	return {
		...local,
		publish(presence: Presence) {
			local.publish(presence);
			link.present(presence);
		},
	};
}

/**
 * Keeps a message the watch heard in the folder of messages at `dir`,
 * where the session reads it as it reads any; one already there, as each
 * watch begun again hears its last message again, is left as it is.
 */
export function keptIn(dir: string): (message: Message) => void {
	const folder = folderTransport(dir);
	return (message) => {
		if (folder.read(message.id) !== undefined) return;
		writeAtomically(dir, `${message.id}.json`, JSON.stringify(message));
	};
}

/** What the session is told of something the node refused. */
export function refusalText(refusal: Refused): string {
	switch (refusal.what) {
		case "send":
			return `The node refused message ${refusal.id ?? "(no id)"}, which reached nobody past this machine: ${refusal.why}`;
		case "presence":
			return `The node refused this session's presence, so peers elsewhere can't find it: ${refusal.why}`;
		case "watch":
			return `The node refused this session's watch, so messages from elsewhere don't reach it: ${refusal.why}`;
		default:
			return `The node refused something: ${refusal.why}`;
	}
}

/** Calls back with each whole line a socket's text holds, as it comes. */
function lines(each: (line: string) => void): (chunk: string) => void {
	let said = "";
	return (chunk) => {
		said += chunk;
		let end = said.indexOf("\n");
		while (end >= 0) {
			const line = said.slice(0, end);
			said = said.slice(end + 1);
			if (line.trim() !== "") each(line);
			end = said.indexOf("\n");
		}
	};
}

/** A node's reply: done, or refused with why. */
type Reply =
	| { readonly ok: true }
	| { readonly ok: false; readonly why: string };

/** What a reply line says, an unreadable one read as refused. */
export function replyFrom(line: string): Reply {
	const read = parsed(line);
	if (read !== undefined && "Ok" in read) return { ok: true };
	if (read !== undefined && typeof read.Err === "string") {
		return { ok: false, why: read.Err };
	}
	return {
		ok: false,
		why: `the node said what this harness can't read: ${line.slice(0, 200)}`,
	};
}

/** What a line a watch heard comes to. */
type Heard =
	| { readonly kind: "messages"; readonly messages: readonly Message[] }
	| { readonly kind: "refused"; readonly why: string };

/**
 * The messages a watch's line carries, its first reply's included, which
 * carries none; a refusal says why, and any other line carries none.
 */
export function eventFrom(line: string): Heard {
	const read = parsed(line);
	if (read === undefined) return { kind: "messages", messages: [] };
	if (typeof read.Err === "string") return { kind: "refused", why: read.Err };
	const many = record(read.MessagesChanged)?.messages;
	const one = record(read.Message)?.message;
	const bodies = Array.isArray(many) ? many : one !== undefined ? [one] : [];
	return {
		kind: "messages",
		messages: bodies
			.map(messageFrom)
			.filter((message): message is Message => message !== undefined),
	};
}

/** A line's JSON object, or nothing for any other line. */
function parsed(line: string): Record<string, unknown> | undefined {
	try {
		return record(JSON.parse(line));
	} catch {
		// Not JSON: read as saying nothing this harness understands.
		return undefined;
	}
}

/** A value as an object's fields, or nothing when it is no object. */
function record(value: unknown): Record<string, unknown> | undefined {
	return isFields(value) ? value : undefined;
}

/** Whether a value is an object, not an array, read by its fields. */
function isFields(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
