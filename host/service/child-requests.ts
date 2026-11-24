/**
 * Asking a child for its conversation: reaching its socket, and reading
 * the one answer a request gets, as the host passes it back.
 *
 * A child answers under its own identity, so an answer saying the host
 * changed means the route the host holds names a process that has since
 * gone; the caller's own identity was right, and asking it to refresh
 * would get it nowhere, so the host says the child doesn't answer.
 */
import { createConnection, type Socket } from "node:net";
import type { ControlReply } from "./dispatch.ts";
import { parseReply } from "./protocol.ts";
import { OPEN_UNSETTLED, unsettledMessage } from "./unsettled-open.ts";

/** The most an answer from a child may hold before its first line ends. */
export const MAX_ANSWER_BYTES = 1024 * 1024;

/** Connect to a child's socket, or fail as the kernel says it can't be reached. */
export function reach(path: string): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const child = createConnection(path);
		child.once("connect", () => {
			child.off("error", reject);
			resolve(child);
		});
		child.once("error", reject);
	});
}

// Each answer the host made for a child that gave none it could pass on.
const madeHere = new WeakSet<ControlReply>();

/**
 * Whether the host made `reply` itself, since the child gave no answer
 * it could pass on, rather than passing on one the child gave: a child
 * may send any code, this one's included.
 */
export function madeByHost(reply: ControlReply): boolean {
	return madeHere.has(reply);
}

// Each refusal the host made for a child that runs a conversation all
// the same, by that conversation: the reply crosses the wire as it is.
const leftRunningBy = new WeakMap<ControlReply, string>();

/**
 * The answer to `id` when the child gave none in time but runs
 * `sessionId`: refused, so nothing waits on it, and naming the one it
 * runs, so the caller attaches rather than opening another.
 */
export function unsettledReply(id: string, sessionId: string): ControlReply {
	const reply: ControlReply = {
		v: 1,
		id,
		ok: false,
		error: { code: OPEN_UNSETTLED, message: unsettledMessage(sessionId) },
	};
	leftRunningBy.set(reply, sessionId);
	return reply;
}

/** The conversation a refusal the host made left running, or nothing. */
export function leftRunning(reply: ControlReply): string | undefined {
	return leftRunningBy.get(reply);
}

/** The answer to `id` when the child can't give one. */
export function childUnreachable(id: string, message?: string): ControlReply {
	const reply: ControlReply = {
		v: 1,
		id,
		ok: false,
		error: {
			code: "child_unreachable",
			message:
				message ?? "The process running this conversation does not answer",
		},
	};
	madeHere.add(reply);
	return reply;
}

/** The code of a begin the host refused, since its time had gone before any child started. */
export const BEGIN_TOO_LATE = "begin_too_late";

/**
 * What the caller is told when a child said of itself that it gave no
 * answer in time, which only the host may say: the child was stopped, so
 * the words name no conversation to attach to, and none of the child's.
 */
export const CHILD_SAID_UNSETTLED =
	"The conversation's process said of itself that it gave no answer in time, which only the host may say, so the host stopped it: nothing was opened, so ask again";

/**
 * Where a begin refused as too late spent its time: weighing the
 * conversations the host runs, or waiting for a turn among the children
 * already starting.
 */
export type TooLateCause = "weighing" | "turn";

/**
 * Where a begin's time went when the host spent `spentMs` of its
 * `withinMs` before it could begin, as `cause` says. It asks for a wait,
 * since what took the time was a loaded machine, which an ask at once
 * would only meet again.
 */
function tooLateWords(
	spentMs: number,
	withinMs: number,
	cause: TooLateCause,
): string {
	const spent = Math.round(spentMs / 1000);
	const within = Math.round(withinMs / 1000);
	const where =
		cause === "turn"
			? "waiting for its turn behind the conversations already starting"
			: "weighing the conversations it runs";
	return `The host spent ${spent} s of its ${within} s ${where} before it could begin this one, too late to start another: nothing was opened, so ask again in a minute, once the machine is quieter`;
}

/**
 * The journal's line for a begin refused as too late, naming its request
 * and quest. Both are only the caller's words, so each is kept to one
 * plain line, as backend.ts keeps a caller's name, and none can read as
 * a journal line of its own.
 */
export function tooLateLine(
	request: { readonly id: string; readonly quest?: string | undefined },
	spentMs: number,
	withinMs: number,
	cause: TooLateCause = "weighing",
): string {
	const plain = (word: string) => word.replace(/\p{Cc}/gu, " ");
	const quest =
		request.quest !== undefined ? ` for quest ${plain(request.quest)}` : "";
	return `Request ${plain(request.id)}${quest}: ${tooLateWords(spentMs, withinMs, cause)}`;
}

/**
 * The answer to `id` when the host spent `spentMs` of its `withinMs`
 * before it could begin, leaving too little for a child to start and
 * answer: refused before any child starts, naming where the time went,
 * as `cause` says, since a start then would only be stopped again on a
 * loaded machine.
 */
export function beganTooLate(
	id: string,
	spentMs: number,
	withinMs: number,
	cause: TooLateCause = "weighing",
): ControlReply {
	const reply: ControlReply = {
		v: 1,
		id,
		ok: false,
		error: {
			code: BEGIN_TOO_LATE,
			message: tooLateWords(spentMs, withinMs, cause),
		},
	};
	madeHere.add(reply);
	return reply;
}

/**
 * What the caller is told of the line a child answered `id` with: the
 * line itself, unless it can't be read or says the child isn't the
 * process the route named.
 */
export function fromChild(line: Buffer, id: string): ControlReply {
	let reply: ControlReply;
	try {
		reply = parseReply(JSON.parse(line.toString("utf8")));
	} catch {
		// A line no reply reads as says nothing the caller could act on.
		return childUnreachable(
			id,
			"The process running this conversation answered something unreadable",
		);
	}
	if (reply.id !== id)
		return childUnreachable(
			id,
			"The process running this conversation answered another request",
		);
	if (!reply.ok && reply.error.code === "stale_host")
		return childUnreachable(
			id,
			"The process running this conversation has changed; ask again",
		);
	return reply;
}

/**
 * Ask a reached child one request and settle with what the caller is
 * told, then leave the child: an answer, or that it doesn't answer when
 * it ends, fails or overruns MAX_ANSWER_BYTES before its first line ends,
 * or gives none within `answersWithinMs` when that is set.
 */
export function askOnce(
	child: Socket,
	line: string,
	id: string,
	report: (error: unknown) => void,
	answersWithinMs?: number,
): Promise<ControlReply> {
	return new Promise((resolve) => {
		let held = Buffer.alloc(0);
		let settled = false;
		let unanswered: ReturnType<typeof setTimeout> | undefined;
		const settle = (reply: ControlReply) => {
			if (settled) return;
			settled = true;
			clearTimeout(unanswered);
			child.destroy();
			resolve(reply);
		};
		if (answersWithinMs !== undefined)
			unanswered = setTimeout(
				() =>
					settle(
						childUnreachable(
							id,
							`The process running this conversation gave no answer within ${answersWithinMs} ms`,
						),
					),
				answersWithinMs,
			);
		child.on("data", (chunk: Buffer) => {
			held = Buffer.concat([held, chunk]);
			const lf = held.indexOf(10);
			if (lf !== -1) settle(fromChild(held.subarray(0, lf), id));
			else if (held.length > MAX_ANSWER_BYTES) settle(childUnreachable(id));
		});
		// Its close follows, and settles the answer.
		child.on("error", report);
		child.on("close", () => settle(childUnreachable(id)));
		child.write(line);
	});
}
