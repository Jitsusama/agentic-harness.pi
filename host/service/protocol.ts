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
	z.strictObject({ ...session, op: z.literal("release") }),
	z.strictObject({ ...session, op: z.literal("close") }),
	z.strictObject({ ...session, op: z.literal("abort") }),
	z.strictObject({
		...session,
		...geometry,
		op: z.literal("attach"),
		window: text.max(256).optional(),
	}),
]);
const viewer = z.discriminatedUnion("type", [
	z.strictObject({ type: z.literal("input"), data: z.string() }),
	z.strictObject({ type: z.literal("resize"), ...geometry }),
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
