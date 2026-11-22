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
 * fields it doesn't know, nested ones too and in a roster entry, a state
 * it doesn't know, read as busy, so nothing takes it for one at rest, a
 * state line it can't read and a line of a type it doesn't know, each
 * reported. Only a became it
 * can't read ends the watch, since its route would then name a
 * conversation the child no longer runs; an ending it can't read is
 * taken as a park, which keeps the conversation held and lets the child
 * exit by itself.
 */
import { createConnection } from "node:net";
import { type Static, type TSchema, Type } from "typebox";
import {
	isRosterEntry,
	type RosterEntry,
} from "../../lib/core/session/roster.ts";
import { isRecord } from "../../lib/internal/record.ts";
import type { HostIdentity } from "./dispatch.ts";
import { jsonLines } from "./framing.ts";
import {
	checkerOf,
	ENDINGS,
	identities,
	type SessionIdentity,
	whyRefused,
} from "./protocol.ts";

/**
 * The longest line a watch reads: each carries one conversation and its
 * roster entry, a few hundred bytes, and every running child has a
 * watch whose buffer lasts its whole life.
 */
const WATCH_FRAME_BYTES = 64 * 1024;
/** How much of why a line couldn't be read goes in the host's journal. */
const MISREAD_SAID_CHARS = 300;

// What a newer child says beyond these, at any depth, is passed over:
// each object takes keys it doesn't name, and what it is read as keeps
// only those this host knows.
const { sessionId, state: knownState } = identities.conversation.properties;
const conversation = Type.Object({
	...identities.conversation.properties,
	state: Type.Optional(Type.Unknown()),
});
const host = Type.Object({
	key: identities.host.properties.key,
	owner: Type.Object(identities.host.properties.owner.properties),
});
const entry = Type.Unsafe<RosterEntry>(
	Type.Refine(Type.Unknown(), isRosterEntry, () => "not a roster entry"),
);

/** The conversation as this host knows it: a state it doesn't know is busy. */
function conversationOf(said: Static<typeof conversation>): SessionIdentity {
	const { sessionId, file, cwd, state, since } = said;
	return {
		sessionId,
		file,
		cwd,
		state: checkerOf(knownState).Check(state) ? state : "busy",
		since,
	};
}

/** The child's identity as this host knows it. */
function hostOf(said: Static<typeof host>): HostIdentity {
	const { pid, startedAt, bootId, startTicks } = said.owner;
	return {
		key: said.key,
		owner: {
			pid,
			startedAt,
			...(bootId === undefined ? {} : { bootId }),
			...(startTicks === undefined ? {} : { startTicks }),
		},
	};
}

/** The fields of `entry` this host knows, as the shared roster keeps them. */
function known(entry: RosterEntry): RosterEntry {
	const { sessionId, file, cwd, attended, quest, since, launch } = entry;
	return {
		sessionId,
		file,
		cwd,
		attended,
		since,
		...(quest === undefined ? {} : { quest }),
		...(launch === undefined ? {} : { launch }),
	};
}
const refused = Type.Object({
	ok: Type.Literal(false),
	error: Type.Object({ message: Type.String() }),
});
const answered = Type.Object({
	ok: Type.Literal(true),
	result: Type.Object({
		version: Type.String({ minLength: 1 }),
		host,
		conversation,
		entry,
	}),
});
// A state line's own state and heap are this host's to pass over: it
// reads the conversation alone.
const stateLine = Type.Object({ type: Type.Literal("state"), conversation });
const becameLine = Type.Object({
	type: Type.Literal("became"),
	previousId: sessionId,
	conversation,
	entry,
});
const endingLine = Type.Object({
	type: Type.Literal("ending"),
	why: Type.Enum(ENDINGS),
});

/** Why a child's conversation ended, as it said just before it exited. */
export type ChildEnding = (typeof ENDINGS)[number];

/** A line read as this host knows it. */
type Said =
	| { readonly type: "state"; readonly conversation: SessionIdentity }
	| {
			readonly type: "became";
			readonly previousId: string;
			readonly conversation: SessionIdentity;
			readonly entry: RosterEntry;
	  }
	| { readonly type: "ending"; readonly why: ChildEnding };

/** What was read, or why it couldn't be. */
type Read<T> =
	| { readonly ok: true; readonly data: T }
	| { readonly ok: false; readonly error: Error };

/** `value` read through `schema`, then as this host knows it. */
function read<Schema extends TSchema, T>(
	schema: Schema,
	value: unknown,
	know: (said: Static<Schema>) => T,
): Read<T> {
	if (checkerOf(schema).Check(value)) return { ok: true, data: know(value) };
	return { ok: false, error: new Error(whyRefused(schema, value)) };
}

/** One line the child sent after its answer. */
function readLine(value: unknown): Read<Said> {
	const type = isRecord(value) ? value.type : undefined;
	if (type === "state")
		return read(stateLine, value, (said) => ({
			type: "state",
			conversation: conversationOf(said.conversation),
		}));
	if (type === "became")
		return read(becameLine, value, (said) => ({
			type: "became",
			previousId: said.previousId,
			conversation: conversationOf(said.conversation),
			entry: known(said.entry),
		}));
	if (type === "ending")
		return read(endingLine, value, (said) => ({
			type: "ending",
			why: said.why,
		}));
	return {
		ok: false,
		error: new Error(`no line of type ${JSON.stringify(type) ?? "undefined"}`),
	};
}

/**
 * The child's answer to its watch, or an error saying it refused or
 * answered with something else.
 */
function answerOf(value: unknown): Watched {
	if (checkerOf(refused).Check(value)) {
		const said = JSON.stringify(
			value.error.message.slice(0, MISREAD_SAID_CHARS),
		);
		throw new Error(`The child refused its watch: ${said}`);
	}
	const first = read(answered, value, ({ result }) => ({
		version: result.version,
		host: hostOf(result.host),
		conversation: conversationOf(result.conversation),
		entry: known(result.entry),
	}));
	if (!first.ok) {
		const why = first.error.message.slice(0, MISREAD_SAID_CHARS);
		throw new Error(`The child answered its watch with no watch: ${why}`);
	}
	return first.data;
}

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

/** A child that took its watch but gave it no answer in time, as a busy one may. */
export class Unanswered extends Error {}

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
 * the watch as failed, and an ending, taken as a park. An abort of
 * `signal` before the child answers rejects with its reason and lets
 * the connection go, so nothing the child says after is heard.
 */
export function watchChild(
	socket: string,
	answersWithinMs: number,
	watcher: ChildWatcher,
	signal?: AbortSignal,
): Promise<ChildWatch> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
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
			signal?.removeEventListener("abort", abandoned);
			if (answered) watcher.ended(why);
		}
		// Answered, a watch is ended by its close instead.
		function abandoned() {
			if (answered) return;
			reject(signal?.reason);
			end("failed");
		}
		signal?.addEventListener("abort", abandoned, { once: true });
		connection.on("connect", () => {
			connection.write(
				`${JSON.stringify({ v: 1, id: "watch", op: "watch" })}\n`,
			);
			unanswered = setTimeout(() => {
				reject(
					new Unanswered(
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
						const first = answerOf(value);
						clearTimeout(unanswered);
						answered = true;
						signal?.removeEventListener("abort", abandoned);
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
					const read = readLine(value);
					if (!read.ok) {
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
