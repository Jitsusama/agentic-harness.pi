/**
 * What a child says of its one conversation, read as it says it.
 *
 * The supervisor asks each child to watch once, on a connection it keeps
 * open: the child answers with its version and its conversation, then
 * sends a line each time the conversation changes state, becomes another
 * under a new id, or ends, just before the child exits. The answer and
 * each became line carry the child's own roster entry too, since only
 * the child derives an open's launch. The supervisor keeps its routes,
 * its list and the shared roster from these lines alone, so it never
 * reads a child's journal, its roster or asks it again.
 *
 * A child outlives the host that started it, so a host may watch a
 * child newer or older than itself. What either adds is passed over:
 * fields it doesn't know, nested ones too, a state line it can't read
 * and a line of a type it doesn't know, each reported. Only a became it
 * can't read ends the watch, since its route would then name a
 * conversation the child no longer runs; an ending it can't read is
 * taken as a park, which keeps the conversation held and lets the child
 * exit by itself.
 */
import { createConnection } from "node:net";
import { z } from "zod";
import {
	isRosterEntry,
	type RosterEntry,
} from "../../lib/core/session/roster.ts";
import { isRecord } from "../../lib/internal/record.ts";
import type { HostIdentity } from "./dispatch.ts";
import { jsonLines } from "./framing.ts";
import { identities, type SessionIdentity } from "./protocol.ts";

/**
 * The longest line a watch reads: each carries one conversation and its
 * roster entry, a few hundred bytes, and every running child has a
 * watch whose buffer lasts its whole life.
 */
const WATCH_FRAME_BYTES = 64 * 1024;
/** How much of why a line couldn't be read goes in the host's journal. */
const MISREAD_SAID_CHARS = 300;

const sessionId = z.uuid();
// What a newer child says beyond these, at any depth, is passed over.
const conversation = identities.conversation.strip();
const host = identities.host
	.extend({ owner: identities.host.shape.owner.strip() })
	.strip();
const entry = z.custom<RosterEntry>(isRosterEntry, "not a roster entry");
const answer = z.discriminatedUnion("ok", [
	z.object({ ok: z.literal(true), result: z.unknown() }),
	z.object({
		ok: z.literal(false),
		error: z.object({ message: z.string() }),
	}),
]);
const watched = z.object({
	version: z.string().min(1),
	host,
	conversation,
	entry,
});
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
		entry,
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
	/** The conversation as the child's roster holds it, launch and all. */
	readonly entry: RosterEntry;
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
	became(
		previousId: string,
		conversation: SessionIdentity,
		entry: RosterEntry,
	): void;
	/**
	 * The watch ended: as the child said it ends, or `failed` when it went
	 * without saying.
	 */
	ended(why: ChildEnding): void;
	/** A line the watch passed over, since it couldn't read it. */
	misread?(error: Error): void;
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
 * rejects when it can't be reached, answers with anything but a watch,
 * or connects but gives no answer within `answersWithinMs`, since a
 * child that never answers would otherwise hold its caller for good.
 * A line it can't read is passed over, apart from a became, which ends
 * the watch as failed, and an ending, taken as a park.
 */
export function watchChild(
	socket: string,
	answersWithinMs: number,
	watcher: ChildWatcher,
): Promise<ChildWatch> {
	return new Promise((resolve, reject) => {
		const connection = createConnection(socket);
		const frames = jsonLines(WATCH_FRAME_BYTES);
		let answered = false;
		let over = false;
		let unanswered: ReturnType<typeof setTimeout> | undefined;
		let finished: () => void = () => undefined;
		const closed = new Promise<void>((done) => {
			finished = done;
		});
		function end(why: ChildEnding) {
			clearTimeout(unanswered);
			if (over) return;
			over = true;
			connection.destroy();
			finished();
			if (answered) watcher.ended(why);
		}
		connection.on("connect", () => {
			connection.write(
				`${JSON.stringify({ v: 1, id: "watch", op: "watch" })}\n`,
			);
			unanswered = setTimeout(() => {
				reject(
					new Error(
						`The child gave its watch no answer within ${answersWithinMs} ms`,
					),
				);
				end("failed");
			}, answersWithinMs);
		});
		connection.on("data", (chunk: Buffer) => {
			try {
				for (const value of frames.push(chunk)) {
					if (!answered) {
						const reply = answer.parse(value);
						if (!reply.ok) throw new Error(reply.error.message);
						const first = watched.parse(reply.result);
						clearTimeout(unanswered);
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
					const read = line.safeParse(value);
					if (!read.success) {
						const type = isRecord(value) ? value.type : undefined;
						if (type === "became") throw read.error;
						if (type === "ending") {
							end("parked");
							return;
						}
						const why = read.error.message.slice(0, MISREAD_SAID_CHARS);
						watcher.misread?.(
							new Error(`passed over a line it can't read: ${why}`),
						);
						continue;
					}
					const said = read.data;
					if (said.type === "state") watcher.state(said.conversation);
					else if (said.type === "became")
						watcher.became(said.previousId, said.conversation, said.entry);
					else {
						// Its last word, whether or not its process then exits.
						end(said.why);
						return;
					}
				}
			} catch (error) {
				if (!answered) reject(error);
				end("failed");
			}
		});
		connection.on("error", (error) => {
			if (!answered) reject(error);
			end("failed");
		});
		connection.on("close", () => {
			if (!answered && !over)
				reject(new Error("The child closed before it answered its watch"));
			end("failed");
		});
	});
}
