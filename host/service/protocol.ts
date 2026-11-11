/** Versioned control requests and viewer frames for a realm's host socket. */
import { isAbsolute } from "node:path";
import { z } from "zod";

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
	}),
	z.strictObject({
		...envelope,
		op: z.literal("adopt"),
		sessionFile: path,
		attended: z.boolean(),
		quest: text.optional(),
	}),
	z.strictObject({ ...envelope, op: z.literal("list") }),
	// Who asks, as the caller names itself (the launcher, a command), for
	// the line the host's journal writes as it lets the conversation go.
	z.strictObject({ ...session, op: z.literal("release"), by: caller }),
	z.strictObject({ ...session, op: z.literal("close"), by: caller }),
	z.strictObject({ ...session, op: z.literal("abort") }),
	z.strictObject({
		...session,
		...geometry,
		op: z.literal("attach"),
		window: text.max(256).optional(),
		// What the client can do, such as edit and suspend; a host passes over
		// what it doesn't know, so a newer client still attaches.
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

/** A hosted conversation as open, adopt and list report it. */
export type SessionIdentity = z.infer<typeof identity>;

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

/** Release, close, abort and attach answer with the session they acted on. */
export function parseSessionResult(value: unknown): z.infer<typeof ended> {
	return result(ended, value);
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
