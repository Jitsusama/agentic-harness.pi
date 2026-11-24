/** Versioned control requests and viewer frames for a realm's host socket. */
import { isAbsolute } from "node:path";
import { z } from "zod";
import {
	isRosterEntry,
	type RosterEntry,
} from "../../lib/core/session/roster.ts";
import { asCarriedEnvironment } from "../../lib/internal/session/carried-environment.ts";

/**
 * The attach feature saying a client joins a child itself: attaching to a
 * conversation a child runs, it is answered with the child's `socket`
 * and attaches there, so what it types and is drawn never cross the
 * host's thread. A client without it has its bytes passed through.
 */
export const DIRECT_ATTACH = "direct";

const text = z.string().min(1);
const path = text.refine(isAbsolute);
const sessionId = z.uuid();
const geometry = {
	rows: z.int().min(1).max(1000),
	columns: z.int().min(1).max(1000),
};
const expectedHost = z.strictObject({
	key: text,
	owner: z.strictObject({
		pid: z.int().positive(),
		startedAt: z.number().positive().finite(),
		bootId: text.optional(),
		startTicks: z.int().nonnegative().optional(),
	}),
});
const envelope = {
	v: z.literal(1),
	id: text.max(128),
	expectedHost: expectedHost.optional(),
};
const session = { ...envelope, sessionId };
const caller = text.max(128).optional();
// How the conversation runs its commands, as the session it continues was
// started (the fence, the spawner): those variables alone, each a word.
const carried = z
	.record(text, text)
	.refine((env) => asCarriedEnvironment(env) !== undefined, {
		message: "only the carried variables, each set to a plain word",
	})
	.optional();
const request = z.discriminatedUnion("op", [
	z.strictObject({
		...envelope,
		op: z.literal("open"),
		cwd: path,
		attended: z.boolean(),
		quest: text.optional(),
		model: z.strictObject({ provider: text, id: text }).optional(),
		thinkingLevel: z
			.enum(["off", "minimal", "low", "medium", "high", "xhigh"])
			.optional(),
		first: text.optional(),
		// Whether it orchestrates its quest, as the launcher's Orchestrate asks.
		orchestrate: z.boolean().optional(),
		env: carried,
	}),
	z.strictObject({
		...envelope,
		op: z.literal("adopt"),
		sessionFile: path,
		attended: z.boolean(),
		quest: text.optional(),
		env: carried,
	}),
	z.strictObject({ ...envelope, op: z.literal("list") }),
	// What memory the host and each conversation's child take: an op of its
	// own, since a client reading list strictly would refuse its new fields.
	z.strictObject({ ...envelope, op: z.literal("memory") }),
	// A child host's one conversation, followed for as long as the
	// connection lasts (child.ts): what the supervisor that started it
	// hears it by.
	z.strictObject({ ...envelope, op: z.literal("watch") }),
	// Who asks, as the caller names itself (the launcher, a command), for
	// the line the host's journal writes as it lets the conversation go.
	z.strictObject({ ...session, op: z.literal("release"), by: caller }),
	z.strictObject({ ...session, op: z.literal("close"), by: caller }),
	z.strictObject({ ...session, op: z.literal("abort") }),
	// Start or lift a drain for a restart: each conversation parks as soon
	// as its park rule holds, and a wake by file or steer waits for the lift.
	z.strictObject({
		...envelope,
		op: z.literal("drain"),
		on: z.boolean(),
		by: caller,
	}),
	z.strictObject({
		...session,
		...geometry,
		op: z.literal("attach"),
		window: text.max(256).optional(),
		// What the client can do, such as edit, suspend and DIRECT_ATTACH; a
		// host passes over what it doesn't know, so a newer client still attaches.
		features: z.array(text.max(64)).max(16).optional(),
	}),
]);
const viewer = z.discriminatedUnion("type", [
	z.strictObject({ type: z.literal("input"), data: z.string() }),
	z.strictObject({ type: z.literal("resize"), ...geometry }),
	// An edit's answer: the draft as it became, or no text to keep it.
	z.strictObject({
		type: z.literal("edited"),
		id: text.max(128),
		text: z.string().optional(),
	}),
]);

const reply = z.discriminatedUnion("ok", [
	z.strictObject({
		v: z.literal(1),
		id: text,
		ok: z.literal(true),
		result: z.unknown(),
	}),
	z.strictObject({
		v: z.literal(1),
		id: text.nullable(),
		ok: z.literal(false),
		error: z.strictObject({ code: text, message: text }),
	}),
]);

const identity = z.strictObject({
	sessionId,
	file: path,
	cwd: path,
	state: z.enum(["busy", "idle", "parked"]),
	since: z.iso.datetime({ offset: true }),
});
const listed = z.strictObject({
	sessions: z.array(identity),
	host: expectedHost,
});
const ended = z.strictObject({ sessionId });
const count = z.int().nonnegative();
const drained = z.strictObject({
	draining: z.boolean(),
	busy: count,
	idle: count,
	parked: count,
	// The heavy runs going now, a line each, which hold a draining host's restart.
	heavy: z.array(text),
});

// A heap as V8 said it, in bytes, and when: a child's as its last state
// line said it, so `at` is when the host heard that line.
const heapReading = z.strictObject({
	used: count,
	limit: count,
	at: z.iso.datetime({ offset: true }),
});
// Each is absent where it can't be read, never zero: a conversation on the
// host's own thread or parked, or a child gone before its Pss was read.
const measured = { heap: heapReading.optional(), pss: count.optional() };
const memory = z.strictObject({
	host: expectedHost,
	own: z.strictObject(measured),
	sessions: z.array(
		z.strictObject({ sessionId, state: identity.shape.state, ...measured }),
	),
});

/** A hosted conversation as open, adopt and list report it. */
export type SessionIdentity = z.infer<typeof identity>;

/** Memory's answer: the host's own, and each conversation's child's. */
export type MemoryAnswer = z.infer<typeof memory>;

/** What memory one process takes, each reading absent where it can't be read. */
export type Measured = MemoryAnswer["own"];

/** What a host's identity and a conversation's look like, for what a child says. */
export const identities = { host: expectedHost, conversation: identity };

// The child's roster entry for its conversation, launch and all, which
// the supervisor holds in the shared roster so a later resume replays it.
const entry = z.custom<RosterEntry>(isRosterEntry, "Invalid roster entry");

const watched = z.strictObject({
	version: text,
	host: expectedHost,
	conversation: identity,
	entry,
});

/** Why a child host ends, as the last line its watch sends says. */
export const ENDINGS = ["parked", "closed", "released", "failed"] as const;

const watchLine = z.discriminatedUnion("type", [
	z.strictObject({
		type: z.literal("state"),
		conversation: identity,
		state: z.enum(["busy", "idle"]),
		heap: z.strictObject({ used: count, limit: count }),
		viewers: count,
	}),
	z.strictObject({
		type: z.literal("became"),
		previousId: sessionId,
		conversation: identity,
		entry,
	}),
	z.strictObject({ type: z.literal("ending"), why: z.enum(ENDINGS) }),
]);

/** Watch's answer: the child's harness version, its own identity and its conversation. */
export type WatchAnswer = z.infer<typeof watched>;

/** A line a child's watch sends after its answer. */
export type WatchLine = z.infer<typeof watchLine>;

/** Watch's result, sent once the child holds its conversation. */
export function parseWatchResult(value: unknown): WatchAnswer {
	return result(watched, value);
}

/** One line a child's watch sent, refused when it isn't one. */
export function parseWatchLine(value: unknown): WatchLine {
	const parsed = watchLine.safeParse(value);
	if (!parsed.success) throw new Error("Invalid child watch line");
	return parsed.data;
}

function result<T>(schema: z.ZodType<T>, value: unknown): T {
	const parsed = schema.safeParse(value);
	if (!parsed.success) throw new Error("Invalid host control result");
	return parsed.data;
}

/** Open's result, sent once ownership and the first durable submit committed. */
export function parseOpenResult(value: unknown): SessionIdentity {
	return result(identity, value);
}

/** Adopt's result: the original pi file, now held by the host. */
export function parseAdoptResult(value: unknown): SessionIdentity {
	return result(identity, value);
}

/** List's result, with the full identity to guard a later request with. */
export function parseListResult(value: unknown): z.infer<typeof listed> {
	return result(listed, value);
}

/** Memory's result: the host's heap and Pss, and each child's beside its conversation. */
export function parseMemoryResult(value: unknown): MemoryAnswer {
	return result(memory, value);
}

/** Release, close, abort and attach answer with the session they acted on. */
export function parseSessionResult(value: unknown): z.infer<typeof ended> {
	return result(ended, value);
}

/** Drain's result: whether the host drains now, and how its conversations stand. */
export function parseDrainResult(value: unknown): z.infer<typeof drained> {
	return result(drained, value);
}

/** Validate the engine's reply without trusting the connected socket's identity. */
export function parseReply(value: unknown) {
	const parsed = reply.safeParse(value);
	if (!parsed.success) throw new Error("Invalid host control reply");
	return parsed.data;
}

/** A validated request; sessionId always names pi's stable UUID. */
export type ControlRequest = z.infer<typeof request>;
/** A validated event from one attached viewer. */
export type ViewerInput = z.infer<typeof viewer>;

/** Refuse unknown fields, ambiguous identities and unsupported operations. */
export function parseControl(value: unknown): ControlRequest {
	const parsed = request.safeParse(value);
	if (!parsed.success) throw new Error("Invalid host control request");
	return parsed.data;
}

/** Validate viewer input separately from the control protocol. */
export function parseViewer(value: unknown): ViewerInput {
	const parsed = viewer.safeParse(value);
	if (!parsed.success) throw new Error("Invalid host viewer frame");
	return parsed.data;
}
