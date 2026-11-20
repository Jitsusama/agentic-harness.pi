/**
 * What a child says of its one conversation, read as it says it.
 *
 * The supervisor asks each child to watch once, on a connection it keeps
 * open: the child answers with its version and its conversation, then
 * sends a line each time the conversation changes state, becomes another
 * under a new id, or ends, just before the child exits. The supervisor
 * keeps its routes, its list and its hosts file from these lines alone,
 * so it never reads a child's journal or asks it again.
 */
import { createConnection } from "node:net";
import { z } from "zod";
import type { HostIdentity } from "./dispatch.ts";
import { jsonLines } from "./framing.ts";
import { identities, parseReply, type SessionIdentity } from "./protocol.ts";

const sessionId = z.uuid();
const { conversation } = identities;
const watched = z.object({
	version: z.string().min(1),
	host: identities.host,
	conversation,
});
// A line may carry more than this reads, as a newer child's would.
const line = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("state"),
		conversation,
		state: z.enum(["busy", "idle"]).optional(),
		heap: z
			.object({ used: z.number().nonnegative(), limit: z.number() })
			.optional(),
	}),
	z.object({
		type: z.literal("became"),
		previousId: sessionId,
		conversation,
	}),
	z.object({
		type: z.literal("ending"),
		why: z.enum(["parked", "closed", "released", "failed"]),
	}),
]);

/** Why a child's conversation ended, as it said just before it exited. */
export type ChildEnding = "parked" | "closed" | "released" | "failed";

/** What a child first says when it is watched. */
export interface Watched {
	/** The version the child runs. */
	readonly version: string;
	/** Who the child is, as a request passed on to it names. */
	readonly host: HostIdentity;
	/** The conversation, as the child names it now. */
	readonly conversation: SessionIdentity;
}

/** What the supervisor does with each thing a child says. */
export interface ChildWatcher {
	/**
	 * The child answered the watch: called before anything it says after,
	 * even in the same read, so a route is held before it can change.
	 */
	watched(first: Watched): void;
	/** The conversation stands as this now. */
	state(conversation: SessionIdentity): void;
	/** The conversation became another, under a new id. */
	became(previousId: string, conversation: SessionIdentity): void;
	/**
	 * The watch ended: with what the child said before it exited, or
	 * `failed` when it went without saying.
	 */
	ended(why: ChildEnding): void;
}

/** A watch on one child, once it answered. */
export interface ChildWatch extends Watched {
	/** Stop watching, without telling the child anything. */
	close(): void;
	/** Settles once the watch has ended, by the child's ending or by close. */
	readonly closed: Promise<void>;
}

/**
 * Watch the child at `socket`. Settles once the child has answered, or
 * rejects when it can't be reached or answers with anything but a watch.
 * A line the supervisor can't read ends the watch as failed, since the
 * child and the supervisor no longer agree on what is said.
 */
export function watchChild(
	socket: string,
	watcher: ChildWatcher,
	id = "watch",
): Promise<ChildWatch> {
	return new Promise((resolve, reject) => {
		const connection = createConnection(socket);
		const frames = jsonLines();
		let answered = false;
		let ending: ChildEnding | undefined;
		let over = false;
		let finished: () => void = () => undefined;
		const closed = new Promise<void>((done) => {
			finished = done;
		});
		function end(why: ChildEnding) {
			if (over) return;
			over = true;
			connection.destroy();
			finished();
			if (answered) watcher.ended(why);
		}
		connection.on("connect", () => {
			connection.write(`${JSON.stringify({ v: 1, id, op: "watch" })}\n`);
		});
		connection.on("data", (chunk: Buffer) => {
			try {
				for (const value of frames.push(chunk)) {
					if (!answered) {
						const reply = parseReply(value);
						if (!reply.ok) throw new Error(reply.error.message);
						const first = watched.parse(reply.result);
						answered = true;
						watcher.watched(first);
						resolve({
							...first,
							closed,
							close: () => {
								over = true;
								connection.destroy();
								finished();
							},
						});
						continue;
					}
					const said = line.parse(value);
					if (said.type === "state") watcher.state(said.conversation);
					else if (said.type === "became")
						watcher.became(said.previousId, said.conversation);
					else ending = said.why;
				}
			} catch (error) {
				if (!answered) reject(error);
				end("failed");
			}
		});
		connection.on("error", (error) => {
			if (!answered) reject(error);
			end(ending ?? "failed");
		});
		connection.on("close", () => {
			if (!answered && !over)
				reject(new Error("The child closed before it answered its watch"));
			end(ending ?? "failed");
		});
	});
}
