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
 * or the link closes before it went, the session is told, naming it. A
 * connection that drops is opened again, a little later each time, and
 * the watch takes up from the last message it heard from someone else.
 *
 * The node judges everything a worker says (who it may write to, as
 * whom, which intents), so nothing here decides what reaches it. What
 * it hands over is judged here only as far as keeping it safely: an id
 * that isn't a bare stamped id never becomes a file's name, and nothing
 * heard can throw out of a socket's listener, where it would end pi.
 */

import { connect, type Socket } from "node:net";
import { isAbsolute } from "node:path";
import { type Message, messageFrom } from "./message.ts";
import { oneLine } from "./one-line.ts";
import type { Presence, Presences } from "./presence.ts";
import {
	folderTransport,
	senderOf,
	stampedAt,
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
 * How far ahead of this machine's clock an id may be stamped and still
 * move where a watch takes up from: one stamped further ahead, by a
 * clock gone wrong or on purpose, would have every later watch ask for
 * only what comes after it, and the session would hear nothing more.
 */
export const MOST_AHEAD_MS = 5 * 60 * 1000;

/**
 * Whether the id `a` was stamped after `b`: by their stamps' times, then
 * by the ids themselves, never as strings alone, since a stamp of fewer
 * digits sorts after every real one as a string though it is long past.
 */
function stampedAfter(a: string, b: string): boolean {
	const at = stampedAt(a) ?? 0;
	const bt = stampedAt(b) ?? 0;
	return at === bt ? a > b : at > bt;
}

/** The most of a node's why said to the session, as for an unreadable line. */
const MOST_WHY = 200;

/**
 * The longest line read from the node: a watch's batch of fifty messages
 * runs to tens of kilobytes, so 16 MiB is only ever a node gone wrong.
 */
const MOST_LINE = 16 * 1024 * 1024;

/** The latest a Date can hold, past which an id's stamp is no time at all. */
const LATEST_TIME_MS = 8.64e15;

/** An id as `stampId` mints it: millis, sender, pid and tail, no path in it. */
const BARE_ID = /^\d{1,16}-[A-Za-z0-9]+-\d+-[A-Za-z0-9]+$/;

/**
 * Whether an id heard over the socket is a bare stamped id, safe to name
 * a file by and to date: anything else, a path or a stamp past what a
 * Date holds, is dropped before it is kept.
 */
export function isBareId(id: string): boolean {
	const at = stampedAt(id);
	return BARE_ID.test(id) && at !== undefined && at <= LATEST_TIME_MS;
}

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

/** What the node refused, or what never reached it, and why. */
export interface Refused {
	/**
	 * The presence, a message sent, the watch, a message the link closed
	 * before it went (`unsent`), or one heard that couldn't be kept.
	 */
	readonly what: "presence" | "send" | "watch" | "unsent" | "unkept";
	/** The message, for a send, an unsent one or an unkept one. */
	readonly id?: string;
	readonly why: string;
}

/** What a link needs of the session it serves. */
export interface WorkerLinkOptions {
	readonly socket: string;
	/** Keep a message the watch heard where the session reads messages. */
	readonly keep: (message: Message) => void;
	/** The ids of the messages the session holds now, in any order. */
	readonly held: () => readonly string[];
	/** The last message the session read as one of `addresses`, if any. */
	readonly lastRead?: (addresses: readonly string[]) => string | undefined;
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
	/**
	 * Hang up both connections, for good, once what was written to the
	 * node has gone; each message never written is told as unsent.
	 */
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
	// Each refusal is told once until the node takes something of the same
	// kind, so a node that refuses on each reconnect or each presence fills
	// no conversation, and a presence taken doesn't bring back a watch's.
	const told = new Map<string, Refused["what"]>();
	let presence: Presence | undefined;
	// What waits for the presence connection: messages not yet written to
	// it, and those written whose replies haven't come.
	const unsent: Message[] = [];
	const awaited: Awaited[] = [];
	let held: Socket | undefined;
	let holding = false;
	let watching: Socket | undefined;
	let newestKept: string | undefined;
	// Each connection backs off on its own, so a watch that drops often
	// never slows the presence's next return, nor the other way about.
	const retries = { hold: firstRetry, watch: firstRetry };
	let again: ReturnType<typeof setTimeout> | undefined;
	let watchAgain: ReturnType<typeof setTimeout> | undefined;

	const refuse = (refusal: Refused) => {
		const why = oneLine(refusal.why).slice(0, MOST_WHY);
		const key = JSON.stringify([refusal.what, refusal.id, why]);
		if (told.has(key)) return;
		told.set(key, refusal.what);
		try {
			options.refused({ ...refusal, why });
		} catch {
			// The session can't be told now (its context gone in a shutdown);
			// a socket's listener must never throw, or pi ends.
		}
	};

	/** Forget what was told of `what`, now the node took one of it. */
	const taken = (what: Refused["what"]) => {
		for (const [key, kind] of told) if (kind === what) told.delete(key);
	};

	/**
	 * Whether `id` was stamped by someone else, at no time too far ahead,
	 * with as many digits as now's: the node orders a watch's `since` by
	 * id, so a take-up stamped with fewer would sort after every real one.
	 */
	const movesTakeUp = (id: string, own: readonly string[]) => {
		const from = senderOf(id);
		const at = stampedAt(id);
		const now = Date.now();
		return (
			from !== undefined &&
			!own.includes(from) &&
			at !== undefined &&
			at <= now + MOST_AHEAD_MS &&
			String(Math.trunc(at)).length === String(now).length &&
			id.startsWith(String(Math.trunc(at)))
		);
	};

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

	const later = (
		which: keyof typeof retries,
		open: () => void,
	): ReturnType<typeof setTimeout> => {
		const wait = retries[which];
		retries[which] = Math.min(wait * 2, LONGEST_RETRY_MS);
		return setTimeout(open, wait);
	};

	const replied = (line: string) => {
		const asked = awaited.shift();
		const reply = replyFrom(line);
		if (asked === undefined) return;
		if (asked.kind === "presence") {
			if (reply.ok) {
				retries.hold = firstRetry;
				taken("presence");
				if (!holding) {
					holding = true;
					openWatch();
				}
			} else {
				refuse({ what: "presence", why: reply.why });
				presentAgain();
			}
			return;
		}
		// A send the node already holds, as one said again after a drop that
		// came after the node took it, is refused as said: it went.
		if (reply.ok || saidAlready(reply.why)) taken("send");
		else refuse({ what: "send", id: asked.message.id, why: reply.why });
	};

	/**
	 * Say the presence again on the hold's backoff, after the node refused
	 * it: a session left idle publishes nothing new, so without this one
	 * passing refusal would leave it with no watch until its work changed.
	 */
	const presentAgain = () => {
		if (closed || again !== undefined) return;
		again = later("hold", () => {
			again = undefined;
			if (closed || holding || presence === undefined) return;
			if (held === undefined) openHold();
			else if (!held.connecting) presentOn(held, presence);
		});
	};

	const openHold = () => {
		again = undefined;
		if (closed || held !== undefined || presence === undefined) return;
		const socket = connect(options.socket);
		held = socket;
		let reached = false;
		socket.setEncoding("utf8");
		socket.on("connect", () => {
			reached = true;
			if (presence !== undefined) presentOn(socket, presence);
			for (const message of unsent.splice(0)) sendOn(socket, message);
		});
		socket.on("data", lines(replied, refuse, "presence"));
		// A drop takes the watch with it, since the node watches only for a
		// session whose presence is held; what wasn't answered goes again.
		// A node that can't be reached at all is told once, so a session
		// cut off by a node that's down or a socket misnamed knows it.
		socket.on("error", (error: NodeJS.ErrnoException) => {
			if (!reached) {
				refuse({
					what: "presence",
					why: `the node's worker socket at ${options.socket} can't be reached (${error.code ?? error.message}), so it tries again`,
				});
			}
			socket.destroy();
		});
		socket.on("close", () => {
			if (held !== socket) return;
			held = undefined;
			holding = false;
			watching?.destroy();
			const unanswered = awaited
				.splice(0)
				.flatMap((one) => (one.kind === "send" ? [one.message] : []));
			unsent.unshift(...unanswered);
			if (closed) tellUnsent();
			else again = later("hold", openHold);
		});
	};

	/** Tell the session of each message the link closed before it went. */
	const tellUnsent = () => {
		for (const message of unsent.splice(0)) {
			refuse({
				what: "unsent",
				id: message.id,
				why: "the session's link to the node closed before it went",
			});
		}
	};

	const heard = (line: string) => {
		const said = eventFrom(line);
		if (said.kind === "refused") {
			refuse({ what: "watch", why: said.why });
			return;
		}
		retries.watch = firstRetry;
		taken("watch");
		const own = presence?.addresses ?? [];
		for (const message of said.messages) {
			// Heard from elsewhere, its pid names a process on another
			// machine, so it is kept as a hosted one, read by address alone:
			// a pid alike by chance, or copied, never makes it this session's.
			try {
				options.keep({ ...message, hosted: true });
			} catch (error) {
				refuse({ what: "unkept", id: message.id, why: String(error) });
				continue;
			}
			const newer =
				newestKept === undefined || stampedAfter(message.id, newestKept);
			if (newer && movesTakeUp(message.id, own)) newestKept = message.id;
		}
	};

	/**
	 * Where a watch takes up: the newest message heard from someone else,
	 * this link's or one the session holds, since its own sends are kept
	 * here before they reach the node; else the last it read; else none.
	 */
	const takeUpFrom = (own: readonly string[]): string | undefined => {
		if (newestKept !== undefined) return newestKept;
		let newest: string | undefined;
		for (const id of options.held()) {
			if (!movesTakeUp(id, own)) continue;
			if (newest === undefined || stampedAfter(id, newest)) newest = id;
		}
		if (newest !== undefined) return newest;
		const read = options.lastRead?.(own);
		return read !== undefined && movesTakeUp(read, own) ? read : undefined;
	};

	const openWatch = () => {
		watchAgain = undefined;
		if (closed || !holding || watching !== undefined) return;
		if (presence === undefined) return;
		const socket = connect(options.socket);
		watching = socket;
		socket.setEncoding("utf8");
		const since = takeUpFrom(presence.addresses);
		socket.on("connect", () =>
			write(socket, {
				Watch: {
					session: presence?.session,
					groups: null,
					...(since !== undefined ? { since } : { recent: FIRST_RECENT }),
				},
			}),
		);
		socket.on("data", lines(heard, refuse, "watch"));
		socket.on("error", () => socket.destroy());
		socket.on("close", () => {
			if (watching !== socket) return;
			watching = undefined;
			// While the presence holds, the watch alone dropped: open it again.
			if (!closed && holding) watchAgain = later("watch", openWatch);
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
			if (closed) {
				refuse({
					what: "unsent",
					id: message.id,
					why: "the session's link to the node had closed",
				});
				return;
			}
			if (held !== undefined && !held.connecting) sendOn(held, message);
			else {
				unsent.push(message);
				if (held === undefined && again === undefined) openHold();
			}
		},
		close() {
			if (closed) return;
			closed = true;
			clearTimeout(again);
			clearTimeout(watchAgain);
			watching?.destroy();
			// What was written goes before the hang-up, the session's last
			// presence among it; what never was is told as unsent.
			if (held === undefined || held.connecting) {
				held?.destroy();
				tellUnsent();
			} else {
				held.end();
				held.unref();
			}
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
		if (!isBareId(message.id)) {
			throw new Error(`${message.id.slice(0, 40)} is no id to name a file by`);
		}
		if (folder.read(message.id) !== undefined) return;
		writeAtomically(dir, `${message.id}.json`, JSON.stringify(message));
	};
}

/** What the session is told of something the node refused. */
export function refusalText(refusal: Refused): string {
	switch (refusal.what) {
		case "send":
			return `The node refused message ${refusal.id ?? "(no id)"}, so peers past this machine may not have it: ${refusal.why}`;
		case "unsent":
			return `Message ${refusal.id ?? "(no id)"} never reached the node, so peers past this machine don't have it: ${refusal.why}`;
		case "unkept":
			return `A message from elsewhere (${refusal.id ?? "no id"}) couldn't be kept here, so this session can't read it: ${refusal.why}`;
		case "presence":
			return `The node refused this session's presence, so peers elsewhere can't find it: ${refusal.why}`;
		case "watch":
			return `The node refused this session's watch, so messages from elsewhere don't reach it: ${refusal.why}`;
		default:
			return `The node refused something: ${refusal.why}`;
	}
}

/**
 * Calls back with each whole line a socket's text holds, as it comes.
 * A line that throws is told through `refuse`, as of the connection
 * `what` names, and the next read: a throw out of a socket's listener is
 * an uncaught exception, which ends pi. A run past `MOST_LINE` with no
 * end is dropped and told, so a node gone wrong can't fill pi's memory.
 */
function lines(
	each: (line: string) => void,
	refuse: (refusal: Refused) => void,
	what: "presence" | "watch",
): (chunk: string) => void {
	let said = "";
	return (chunk) => {
		said += chunk;
		if (said.length > MOST_LINE && !said.includes("\n")) {
			said = "";
			refuse({ what, why: `it said over ${MOST_LINE} characters with no end` });
			return;
		}
		let end = said.indexOf("\n");
		while (end >= 0) {
			const line = said.slice(0, end);
			said = said.slice(end + 1);
			if (line.trim() !== "") {
				try {
					each(line);
				} catch (error) {
					refuse({
						what,
						why: `a line it heard failed: ${String(error)}`,
					});
				}
			}
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
	const why = read === undefined ? undefined : refusalIn(read);
	if (why !== undefined) return { ok: false, why };
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
	const why = refusalIn(read);
	if (why !== undefined) return { kind: "refused", why };
	const many = record(read.MessagesChanged)?.messages;
	const one = record(read.Message)?.message;
	const bodies = Array.isArray(many) ? many : one !== undefined ? [one] : [];
	return {
		kind: "messages",
		messages: bodies
			.map(messageFrom)
			.filter(
				(message): message is Message =>
					message !== undefined && isBareId(message.id),
			),
	};
}

/**
 * Whether the node refused a send because it already holds that id
 * (mycelium#421: "<id> is said already, and a worker can't write over
 * it"), which means the message reached it.
 */
function saidAlready(why: string): boolean {
	return / is said already\b/.test(why);
}

/**
 * The why of a refusal, in either shape the node says one: `{Err}` as
 * the worker socket does, or `{Refused: {code, why}}` as a crossing does
 * (lib/mesh/flow.ts); nothing for a line that refuses nothing.
 */
function refusalIn(read: Record<string, unknown>): string | undefined {
	if (typeof read.Err === "string") return read.Err;
	const refused = record(read.Refused);
	if (refused === undefined) return undefined;
	return typeof refused.why === "string" ? refused.why : "it gave no why";
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
