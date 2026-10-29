/**
 * Being present on the machine's mycelium node: one connection held open
 * for as long as this process runs, so the node knows the moment it ends.
 *
 * The kernel closes a process's connections however it ends, a crash
 * included, and at once, which no look at a presence file or its process
 * can match: a Mac has no safe way to watch a process and judges each
 * every 5 s. The node takes the process from the kernel's word of who is
 * at the other end, so this says only `Present`, once; the presence file
 * stays what says who the session is.
 *
 * A reload runs the extension again in the same process, so the one
 * connection is kept on `globalThis` and kept, rather than closed and
 * opened, which the node would read as an end and a start. Neither the
 * connection nor its retry keeps pi from exiting. With no node to answer,
 * the node judges the process as it always has, so nothing here is ever
 * needed for the session to count as there.
 */

import { connect, type Socket } from "node:net";
import { nodeSocket } from "./node.ts";

/** How soon a dropped or failed connection is tried again. */
export const PRESENT_RETRY_MS = 5000;

/**
 * How soon a node that refused is asked again: one built before it knew
 * `Present` refuses each time, and a switch to a newer one takes minutes.
 */
export const PRESENT_REFUSED_RETRY_MS = 60_000;

/** Where the machine's node serves, read again at each try. */
export type NodeAt = () => string | undefined;

/** The one connection this process keeps, or the retry waiting to make it. */
interface Keeping {
	socket?: Socket;
	retry?: ReturnType<typeof setTimeout>;
	/** Whether the node has said this process is counted present. */
	present: boolean;
	stopped: boolean;
}

const SLOT = Symbol.for("agentic-harness.mesh.present.v1");

type PresentGlobal = { [SLOT]?: Keeping };

/**
 * Keeps this process present on the node `at` names, from now until it
 * exits. Kept already, by an earlier load in this process, it carries on
 * as it is.
 */
export function keepPresent(
	at: NodeAt = () => nodeSocket(),
	retryMs: number = PRESENT_RETRY_MS,
	refusedRetryMs: number = PRESENT_REFUSED_RETRY_MS,
): void {
	const held = globalThis as PresentGlobal;
	if (held[SLOT] && !held[SLOT].stopped) return;
	const keeping: Keeping = { present: false, stopped: false };
	held[SLOT] = keeping;
	const again = (after: number) => {
		if (keeping.stopped) return;
		keeping.retry = setTimeout(() => {
			keeping.retry = undefined;
			attempt();
		}, after);
		keeping.retry.unref?.();
	};
	const attempt = () => {
		if (keeping.stopped) return;
		const path = at();
		if (path === undefined) {
			again(retryMs);
			return;
		}
		const socket = connect(path);
		keeping.socket = socket;
		keeping.present = false;
		socket.unref();
		let heard = "";
		let refused = false;
		socket.setEncoding("utf8");
		socket.on("connect", () => socket.write('"Present"\n'));
		socket.on("data", (chunk: string) => {
			if (keeping.present || refused) return;
			heard += chunk;
			const end = heard.indexOf("\n");
			if (end < 0) return;
			if (isPresent(heard.slice(0, end))) {
				keeping.present = true;
				return;
			}
			refused = true;
			socket.destroy();
		});
		// A failed connect is followed by its close, which tries again.
		socket.on("error", () => undefined);
		socket.on("close", () => {
			if (keeping.socket === socket) keeping.socket = undefined;
			keeping.present = false;
			again(refused ? refusedRetryMs : retryMs);
		});
	};
	attempt();
}

/**
 * Whether this process is counted present by the node now. Only tests ask
 * it today; a status line may later.
 */
export function isKeptPresent(): boolean {
	return (globalThis as PresentGlobal)[SLOT]?.present === true;
}

/**
 * Stops keeping this process present and closes its connection, which
 * the node reads as this process's end. Only tests call it today, to
 * start each from nothing. Never call it at `session_shutdown`: a reload
 * fires that too, and the node would end a session that carries on. A
 * process that exits needs nothing, since its end closes the connection.
 */
export function stopPresent(): void {
	const held = globalThis as PresentGlobal;
	const keeping = held[SLOT];
	if (!keeping) return;
	keeping.stopped = true;
	clearTimeout(keeping.retry);
	keeping.socket?.destroy();
	held[SLOT] = undefined;
}

/** Whether the node's reply line counts this process present. */
function isPresent(line: string): boolean {
	try {
		const reply: unknown = JSON.parse(line);
		return (
			typeof reply === "object" &&
			reply !== null &&
			"Ok" in reply &&
			reply.Ok === "Present"
		);
	} catch {
		// A line that isn't JSON is no node's yes.
		return false;
	}
}
