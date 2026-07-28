/**
 * What a page said over its websockets.
 *
 * A request is a question with an answer attached, so the request
 * record can hold both. A socket is a conversation that outlives
 * any one message, and the whole point of a feature built on one
 * is that messages arrive when nobody asked. None of that fits
 * the request shape, so until this existed a live feature was
 * invisible: the page did nothing observable and worked, or did
 * nothing observable and did not.
 */

/** One thing that happened to a websocket. */
export type SocketEvent =
	| { kind: "opened"; id: string; at: number; url: string }
	| { kind: "sent"; id: string; at: number; payload: string }
	| { kind: "received"; id: string; at: number; payload: string }
	| { kind: "closed"; id: string; at: number }
	| { kind: "failed"; id: string; at: number; error: string };

/** One frame in a conversation. */
export interface SocketFrame {
	readonly direction: "sent" | "received";
	readonly at: number;
	readonly payload: string;
}

/** One socket and everything said over it. */
export interface SocketRecord {
	readonly id: string;
	readonly url: string;
	readonly openedAt?: number;
	readonly closedAt?: number;
	readonly error?: string;
	readonly frames: readonly SocketFrame[];
}

/** A socket being assembled, before it is handed out. */
interface Building {
	id: string;
	url: string;
	openedAt?: number;
	closedAt?: number;
	error?: string;
	frames: SocketFrame[];
}

/**
 * The url of a socket nobody saw open.
 *
 * The recorder can attach part-way through a conversation, and a
 * frame with no opening is still evidence. Dropping it would
 * report a socket that was talking as no socket at all.
 */
const UNSEEN = "(socket already open when recording started)";

/** Gather loose events into one record per socket, in order. */
export function foldSockets(
	events: readonly SocketEvent[],
): readonly SocketRecord[] {
	// Insertion order is the order sockets were first heard from,
	// which is the order a reader expects to find them in.
	const building = new Map<string, Building>();

	const find = (id: string): Building => {
		const existing = building.get(id);
		if (existing !== undefined) return existing;
		const fresh: Building = { id, url: UNSEEN, frames: [] };
		building.set(id, fresh);
		return fresh;
	};

	for (const event of events) {
		const socket = find(event.id);
		if (event.kind === "opened") {
			socket.url = event.url;
			socket.openedAt = event.at;
		} else if (event.kind === "closed") {
			socket.closedAt = event.at;
		} else if (event.kind === "failed") {
			socket.error = event.error;
		} else {
			socket.frames.push({
				direction: event.kind,
				at: event.at,
				payload: event.payload,
			});
		}
	}

	return [...building.values()].map((socket) => ({
		id: socket.id,
		url: socket.url,
		...(socket.openedAt === undefined ? {} : { openedAt: socket.openedAt }),
		...(socket.closedAt === undefined ? {} : { closedAt: socket.closedAt }),
		...(socket.error === undefined ? {} : { error: socket.error }),
		frames: socket.frames,
	}));
}

/** How much of one frame to show before it stops being a summary. */
const MAX_PAYLOAD = 200;

/** One frame, arrow first so the direction reads down the column. */
function line(frame: SocketFrame, openedAt: number | undefined): string {
	const arrow = frame.direction === "sent" ? "->" : "<-";
	// Time since the socket opened, which is what a reader is
	// actually asking when they look at a timestamp here.
	const when =
		openedAt === undefined ? "" : `+${Math.round(frame.at - openedAt)}ms `;
	const payload =
		frame.payload.length > MAX_PAYLOAD
			? `${frame.payload.slice(0, MAX_PAYLOAD)}... (${frame.payload.length} chars)`
			: frame.payload;
	return `    ${arrow} ${when}${payload}`;
}

/** Say what was said over each socket. */
export function renderSockets(sockets: readonly SocketRecord[]): string {
	if (sockets.length === 0) {
		// Worth saying plainly. A socket that opened and said nothing
		// and a recorder that was not listening look identical in an
		// empty report, and they mean opposite things.
		return "No websocket traffic. The page opened no sockets while this session was recording.";
	}

	const blocks = sockets.map((socket) => {
		const standing =
			socket.error !== undefined
				? `failed: ${socket.error}`
				: socket.closedAt !== undefined
					? "closed"
					: "open";
		const head = `${socket.url} (${standing}, ${socket.frames.length} ${
			socket.frames.length === 1 ? "frame" : "frames"
		})`;
		if (socket.frames.length === 0) return `  ${head}`;
		return [
			`  ${head}`,
			...socket.frames.map((frame) => line(frame, socket.openedAt)),
		].join("\n");
	});

	return [
		`${sockets.length} ${sockets.length === 1 ? "socket" : "sockets"}:`,
		...blocks,
	].join("\n");
}
