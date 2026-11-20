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

/** The answer to `id` when the child can't give one. */
export function childUnreachable(id: string, message?: string): ControlReply {
	return {
		v: 1,
		id,
		ok: false,
		error: {
			code: "child_unreachable",
			message:
				message ?? "The process running this conversation does not answer",
		},
	};
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
