/**
 * Versioned control requests and viewer frames for a realm's host socket.
 *
 * Each shape is a TypeBox schema, checked with the TypeBox pi's bundle
 * already loads in every hosted conversation, so a host's child carries no
 * validation library of its own. Every object refuses keys it doesn't name.
 * A string's length counts UTF-16 units, as JavaScript's own length does,
 * rather than JSON Schema's code points; integers are held to the safe
 * range, and an id and a time to the patterns below.
 */
import { isAbsolute } from "node:path";
import { type Static, type TSchema, Type } from "typebox";
import { Compile, type Validator } from "typebox/compile";
import {
	isRosterEntry,
	type RosterEntry,
} from "../../lib/core/session/roster.ts";
import { asCarriedEnvironment } from "../../lib/internal/session/carried-environment.ts";

/** An RFC 9562 UUID of any version, or the nil or the max one. */
const UUID =
	/^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
/** A calendar date, leap days included. */
const DATE =
	"(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))";
/** An ISO 8601 date and time, in UTC or at an offset. */
const DATETIME = new RegExp(
	`^${DATE}T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$`,
);

/** A string of at least one UTF-16 unit, and at most `most` when given. */
function text(most?: number) {
	return Type.Refine(
		Type.String(),
		(value) =>
			value.length >= 1 && (most === undefined || value.length <= most),
	);
}
/** An integer from `least` to `most`, kept within the safe range. */
function int(least: number, most = Number.MAX_SAFE_INTEGER) {
	return Type.Integer({ minimum: least, maximum: most });
}
/** An object of exactly these keys, the optional ones aside. */
function exactly<Properties extends Record<string, TSchema>>(
	properties: Properties,
) {
	return Type.Object(properties, { additionalProperties: false });
}

const path = Type.Refine(
	Type.String(),
	(value) => value.length >= 1 && isAbsolute(value),
);
const sessionId = Type.String({ pattern: UUID.source });
const geometry = { rows: int(1, 1000), columns: int(1, 1000) };
const expectedHost = exactly({
	key: text(),
	owner: exactly({
		pid: int(1),
		startedAt: Type.Number({ exclusiveMinimum: 0 }),
		bootId: Type.Optional(text()),
		startTicks: Type.Optional(int(0)),
	}),
});
const envelope = {
	v: Type.Literal(1),
	id: text(128),
	expectedHost: Type.Optional(expectedHost),
};
const session = { ...envelope, sessionId };
const caller = Type.Optional(text(128));
// How the conversation runs its commands, as the session it continues was
// started (the fence, the spawner): those variables alone, each a word.
const carried = Type.Optional(
	Type.Refine(
		Type.Record(Type.String(), Type.String()),
		(env) =>
			Object.entries(env).every(
				([name, value]) => name.length >= 1 && value.length >= 1,
			) && asCarriedEnvironment(env) !== undefined,
		() => "only the carried variables, each set to a plain word",
	),
);
const request = Type.Union([
	exactly({
		...envelope,
		op: Type.Literal("open"),
		cwd: path,
		attended: Type.Boolean(),
		quest: Type.Optional(text()),
		model: Type.Optional(exactly({ provider: text(), id: text() })),
		thinkingLevel: Type.Optional(
			Type.Enum(["off", "minimal", "low", "medium", "high", "xhigh"]),
		),
		first: Type.Optional(text()),
		// Whether it orchestrates its quest, as the launcher's Orchestrate asks.
		orchestrate: Type.Optional(Type.Boolean()),
		env: carried,
	}),
	exactly({
		...envelope,
		op: Type.Literal("adopt"),
		sessionFile: path,
		attended: Type.Boolean(),
		quest: Type.Optional(text()),
		env: carried,
	}),
	exactly({ ...envelope, op: Type.Literal("list") }),
	// A child host's one conversation, followed for as long as the
	// connection lasts (child.ts): what the supervisor that started it
	// hears it by.
	exactly({ ...envelope, op: Type.Literal("watch") }),
	// Who asks, as the caller names itself (the launcher, a command), for
	// the line the host's journal writes as it lets the conversation go.
	exactly({ ...session, op: Type.Literal("release"), by: caller }),
	exactly({ ...session, op: Type.Literal("close"), by: caller }),
	exactly({ ...session, op: Type.Literal("abort") }),
	// Start or lift a drain for a restart: each conversation parks as soon
	// as its park rule holds, and a wake by file or steer waits for the lift.
	exactly({
		...envelope,
		op: Type.Literal("drain"),
		on: Type.Boolean(),
		by: caller,
	}),
	exactly({
		...session,
		...geometry,
		op: Type.Literal("attach"),
		window: Type.Optional(text(256)),
		// What the client can do, such as edit and suspend; a host passes over
		// what it doesn't know, so a newer client still attaches.
		features: Type.Optional(Type.Array(text(64), { maxItems: 16 })),
	}),
]);
const viewer = Type.Union([
	exactly({ type: Type.Literal("input"), data: Type.String() }),
	exactly({ type: Type.Literal("resize"), ...geometry }),
	// An edit's answer: the draft as it became, or no text to keep it.
	exactly({
		type: Type.Literal("edited"),
		id: text(128),
		text: Type.Optional(Type.String()),
	}),
]);

const reply = Type.Union([
	exactly({
		v: Type.Literal(1),
		id: text(),
		ok: Type.Literal(true),
		result: Type.Unknown(),
	}),
	exactly({
		v: Type.Literal(1),
		id: Type.Union([text(), Type.Null()]),
		ok: Type.Literal(false),
		error: exactly({ code: text(), message: text() }),
	}),
]);

/** A conversation's states, as a host reports them. */
const STATES = ["busy", "idle", "parked"] as const;

const since = Type.String({ pattern: DATETIME.source });
const identity = exactly({
	sessionId,
	file: path,
	cwd: path,
	state: Type.Enum(STATES),
	since,
});
const listed = exactly({
	sessions: Type.Array(identity),
	host: expectedHost,
});
const ended = exactly({ sessionId });
const count = int(0);
const drained = exactly({
	draining: Type.Boolean(),
	busy: count,
	idle: count,
	parked: count,
	// The heavy runs going now, a line each, which hold a draining host's restart.
	heavy: Type.Array(text()),
});

/** A hosted conversation as open, adopt and list report it. */
export type SessionIdentity = Static<typeof identity>;

/** What a host's identity and a conversation's look like, for what a child says. */
export const identities = { host: expectedHost, conversation: identity };

// The child's roster entry for its conversation, launch and all, which
// the supervisor holds in the shared roster so a later resume replays it.
const entry = Type.Unsafe<RosterEntry>(
	Type.Refine(Type.Unknown(), isRosterEntry, () => "Invalid roster entry"),
);

const watched = exactly({
	version: text(),
	host: expectedHost,
	conversation: identity,
	entry,
});

/** Why a child host ends, as the last line its watch sends says. */
export const ENDINGS = ["parked", "closed", "released", "failed"] as const;

const watchLine = Type.Union([
	exactly({
		type: Type.Literal("state"),
		conversation: identity,
		state: Type.Union([Type.Literal("busy"), Type.Literal("idle")]),
		heap: exactly({ used: count, limit: count }),
		viewers: count,
	}),
	exactly({
		type: Type.Literal("became"),
		previousId: sessionId,
		conversation: identity,
		entry,
	}),
	exactly({
		type: Type.Literal("ending"),
		why: Type.Enum(ENDINGS),
	}),
]);

/** Watch's answer: the child's harness version, its own identity and its conversation. */
export type WatchAnswer = Static<typeof watched>;

/** A line a child's watch sends after its answer. */
export type WatchLine = Static<typeof watchLine>;

/** Each schema's checker, compiled the first time a value is checked against it. */
const checkers = new WeakMap<TSchema, Validator>();

/** A schema checked on its own, with no definitions beside it. */
type Alone = Record<never, never>;

/**
 * The checker for `schema`: compiled once, as a function of its own,
 * since interpreting the schema again for every message is far slower.
 */
export function checkerOf<Schema extends TSchema>(
	schema: Schema,
): Validator<Alone, Schema> {
	const known = checkers.get(schema);
	if (known !== undefined) return known as Validator<Alone, Schema>;
	const checker = Compile(schema);
	checkers.set(schema, checker);
	return checker;
}

/** Why `schema` refuses `value`: each place it fails, and what it found there. */
export function whyRefused(schema: TSchema, value: unknown): string {
	return checkerOf(schema)
		.Errors(value)
		.map((error) => `${error.instancePath || "/"}: ${error.message}`)
		.join("; ");
}

/** `value` as `schema` holds it, or an error saying `refused`. */
function checked<Schema extends TSchema>(
	schema: Schema,
	value: unknown,
	refused: string,
): Static<Schema> {
	if (!checkerOf(schema).Check(value)) throw new Error(refused);
	return value;
}

/** Watch's result, sent once the child holds its conversation. */
export function parseWatchResult(value: unknown): WatchAnswer {
	return checked(watched, value, "Invalid host control result");
}

/** One line a child's watch sent, refused when it isn't one. */
export function parseWatchLine(value: unknown): WatchLine {
	return checked(watchLine, value, "Invalid child watch line");
}

/** Open's result, sent once ownership and the first durable submit committed. */
export function parseOpenResult(value: unknown): SessionIdentity {
	return checked(identity, value, "Invalid host control result");
}

/** Adopt's result: the original pi file, now held by the host. */
export function parseAdoptResult(value: unknown): SessionIdentity {
	return checked(identity, value, "Invalid host control result");
}

/** List's result, with the full identity to guard a later request with. */
export function parseListResult(value: unknown): Static<typeof listed> {
	return checked(listed, value, "Invalid host control result");
}

/** Release, close, abort and attach answer with the session they acted on. */
export function parseSessionResult(value: unknown): Static<typeof ended> {
	return checked(ended, value, "Invalid host control result");
}

/** Drain's result: whether the host drains now, and how its conversations stand. */
export function parseDrainResult(value: unknown): Static<typeof drained> {
	return checked(drained, value, "Invalid host control result");
}

/** Validate the engine's reply without trusting the connected socket's identity. */
export function parseReply(value: unknown) {
	return checked(reply, value, "Invalid host control reply");
}

/** A validated request; sessionId always names pi's stable UUID. */
export type ControlRequest = Static<typeof request>;
/** A validated event from one attached viewer. */
export type ViewerInput = Static<typeof viewer>;

/** Refuse unknown fields, ambiguous identities and unsupported operations. */
export function parseControl(value: unknown): ControlRequest {
	return checked(request, value, "Invalid host control request");
}

/** Validate viewer input separately from the control protocol. */
export function parseViewer(value: unknown): ViewerInput {
	return checked(viewer, value, "Invalid host viewer frame");
}
